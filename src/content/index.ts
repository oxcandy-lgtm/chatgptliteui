import type { Settings } from "../shared/types.js";
import { getSettings } from "../settings/storage.js";
import { ThemeApplier } from "./lifecycle.js";
import { RouteListener } from "./route-listener.js";
import { createAdapter } from "../adapters/chatgpt-adapter.js";
import { debounce } from "../shared/debounce.js";
import { hasRuntimeEffects } from "../features/sidebar/sidebar-state.js";
import { SidebarController } from "../features/sidebar/sidebar-controller.js";
import { SIDEBAR_HOST_ID } from "../features/sidebar/sidebar-detection.js";
import { logger } from "../shared/logger.js";

/**
 * Content script entry point (Phase 3 — appearance + safe sidebar controls).
 *
 * Responsibilities:
 *  - load settings;
 *  - apply appearance via extension-owned root classes, `--cgl-*` custom
 *    properties, and `data-cgl-*` surface markers;
 *  - apply sidebar visibility modes (visible/hover/button/hidden) through
 *    extension-owned classes, a single `data-cgl-sidebar-target` marker, and a
 *    Shadow DOM control host — never by deleting, detaching, rewriting,
 *    reordering, or cloning ChatGPT navigation;
 *  - react to chrome.storage.onChanged;
 *  - restore the official ChatGPT UI when disabled, on mode change to visible,
 *    on route teardown, or on lifecycle teardown;
 *  - detect SPA route changes and re-apply non-destructively;
 *  - observe structural DOM mutations to re-mark surfaces and rebound the
 *    sidebar, coalesced into one debounced refresh;
 *  - handle the fixed `Alt+Shift+L` sidebar shortcut through the content
 *    script (no chrome.commands).
 *
 * It performs NO destructive DOM operations and makes NO external network
 * request.
 */

const applier = new ThemeApplier();
const adapter = createAdapter();
const sidebarController = new SidebarController(document.documentElement, adapter);
const routeListener = new RouteListener();

let observer: MutationObserver | null = null;
let observedTarget: Node | null = null;

/**
 * Single coalesced refresh operation. The MutationObserver callback schedules
 * this (never a full storage read + rescan per mutation batch), so a burst of
 * synchronous DOM mutations produces exactly one refresh after the debounce
 * window. It updates BOTH appearance markers and sidebar detection/binding.
 */
const scheduleMarkerRefresh = debounce((): void => {
  void getSettings().then((settings) => {
    applier.refreshMarkers(settings);
    sidebarController.refresh(settings);
  });
}, 120);

/** Apply settings and connect/disconnect the observer per the active profile. */
function syncRuntime(settings: Settings): void {
  applier.apply(settings);
  sidebarController.apply(settings);
  if (settings.enabled && hasRuntimeEffects(settings)) {
    connectObserver();
  } else {
    disconnectObserver();
  }
}

/** Apply current settings; used on bootstrap, storage change, and route change. */
function applyCurrent(): void {
  void getSettings().then(syncRuntime);
}

/** Whether a node is the extension-owned sidebar control host (ignore it). */
function isExtensionHost(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    (node.id === SIDEBAR_HOST_ID ||
      node.getAttribute("data-cgl-sidebar-host") === "true" ||
      node.tagName.toLowerCase() === "style")
  );
}

/**
 * Pick the narrowest stable observer root.
 *  - When only appearance is active (no sidebar), observe the narrow
 *    conversation container (existing behavior).
 *  - When a sidebar mode is active, observe the lowest common ancestor of the
 *    safe sidebar target and the conversation container, falling back to a safe
 *    app-shell ancestor, and only to document.body when no narrower stable root
 *    exists. Never remain on document.body once a narrower root is available.
 */
function pickObserverTarget(settings: Settings): Node {
  const conv = adapter.detectConversationContainer().element;
  if (!hasSidebarEffectsLocal(settings)) {
    return conv ?? document.body;
  }
  const sidebar = adapter.detectSidebar().element;
  if (conv && sidebar) {
    const lca = lowestCommonAncestor(conv, sidebar);
    if (lca && lca !== document.documentElement) return lca;
  }
  if (sidebar) {
    const parent = sidebar.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) {
      return parent;
    }
  }
  return document.body;
}

function hasSidebarEffectsLocal(settings: Settings): boolean {
  return settings.sidebar.mode !== "visible";
}

/** Lowest common ancestor of two elements, or null. */
function lowestCommonAncestor(a: Node, b: Node): Node | null {
  if (!a || !b) return null;
  const ancestors: Node[] = [];
  let n: Node | null = a;
  while (n) {
    ancestors.push(n);
    n = n.parentNode;
  }
  let m: Node | null = b;
  while (m) {
    if (ancestors.includes(m)) return m;
    m = m.parentNode;
  }
  return null;
}

/** Attach a scoped observer to the narrowest available stable root. */
function connectObserver(): void {
  void getSettings().then((settings) => {
    const target = pickObserverTarget(settings);
    if (observedTarget === target && observer) return; // already observing
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      let added = false;
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE && !isExtensionHost(node)) {
            added = true;
            break;
          }
        }
        if (added) break;
      }
      if (!added) return;
      // Cheap path: re-check route signature on structural changes.
      routeListener.check();
      // Reconnect to a narrower root if one just became available.
      void getSettings().then((s) => {
        const narrower = pickObserverTarget(s);
        if (narrower && narrower !== observedTarget) connectObserver();
      });
      // Coalesce refresh into one debounced operation.
      scheduleMarkerRefresh();
    });
    observedTarget = target;
    observer.observe(target, { childList: true, subtree: true });
  });
}

/** Disconnect the active observer (Normal / disabled). Idempotent. */
function disconnectObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  observedTarget = null;
}

/** Tear down observers and extension-owned UI without destroying page DOM. */
function teardown(): void {
  // Cancel any pending debounced refresh so it cannot re-mark the DOM after
  // teardown.
  scheduleMarkerRefresh.cancel();
  disconnectObserver();
  sidebarController.teardown();
  applier.restore();
}

/** Re-apply after a route change: restore markers, refresh, re-sync. */
function reapplyAfterRouteChange(): void {
  applier.restore();
  sidebarController.restore();
  adapter.refresh();
  applyCurrent();
}

/** Global keydown handler for the fixed `Alt+Shift+L` sidebar shortcut. */
function handleKeydown(e: KeyboardEvent): void {
  // Ignore repeats and composition events.
  if (e.repeat || e.isComposing || e.key === "Process") return;
  // Ignore events originating inside editable fields.
  const t = e.target as Element | null;
  if (t) {
    const tag = t.tagName?.toLowerCase();
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      t.getAttribute("contenteditable") === "true" ||
      t.getAttribute("role") === "textbox"
    ) {
      return;
    }
  }
  // Exact modifier match: Alt+Shift+KeyL, no Ctrl/Meta.
  const match =
    e.altKey &&
    e.shiftKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    e.code === "KeyL";
  if (!match) return;
  e.preventDefault();
  void getSettings().then((settings) => {
    if (!settings.enabled) return;
    sidebarController.onKeyboardToggle();
  });
}

async function bootstrap(): Promise<void> {
  const settings = await getSettings();
  syncRuntime(settings);

  routeListener.onChange(() => {
    reapplyAfterRouteChange();
  });
  routeListener.start();

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!("settings" in changes)) return;
      // Reload through the validated path rather than trusting a raw cast of
      // changes.settings.newValue. A mode change clears transient state.
      void getSettings().then((s) => {
        sidebarController.clearTransient();
        syncRuntime(s);
      });
    });
  }

  if (typeof document !== "undefined") {
    document.addEventListener("keydown", handleKeydown);
  }

  logger.info("content", "Lite UI content script active", {});
}

// Exposed for tests only (does not run any side effects on import).
export {
  applier,
  adapter,
  sidebarController,
  routeListener,
  connectObserver,
  disconnectObserver,
  teardown,
  reapplyAfterRouteChange,
  syncRuntime,
  scheduleMarkerRefresh,
  pickObserverTarget,
  handleKeydown,
};

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void bootstrap(), { once: true });
  } else {
    void bootstrap();
  }
}
