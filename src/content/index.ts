import type { Settings } from "../shared/types.js";
import { getSettings } from "../settings/storage.js";
import { ThemeApplier } from "./lifecycle.js";
import { RouteListener } from "./route-listener.js";
import { createAdapter } from "../adapters/chatgpt-adapter.js";
import { debounce } from "../shared/debounce.js";
import { hasAppearanceEffects } from "../features/appearance/presets.js";
import { hasSidebarEffects } from "../features/sidebar/sidebar-state.js";
import { SidebarController } from "../features/sidebar/sidebar-controller.js";
import { findSafeSidebarTarget, SIDEBAR_HOST_ID } from "../features/sidebar/sidebar-detection.js";
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

/** Runtime enabled flag (Fix 2): keyboard shortcut is gated on this. */
let runtimeEnabled = false;
/** Whether the keydown listener is currently attached (Fix 2, no dup). */
let keyboardListenerAttached = false;
/**
 * Observer epoch (Fix 4): every disconnect bumps it. A pending async reconnect
 * from a mutation callback carries the epoch it was issued under; if the epoch
 * changed (teardown / mode change / disabled), the stale reconnect is ignored.
 */
let observerEpoch = 0;

/** Previously applied settings, used to reconcile the observer after a transient toggle. */
let lastSettings: Settings | null = null;

/**
 * Effective runtime observation requirement (Fix 3): appearance effects, a
 * non-visible persisted mode, OR an active transient sidebar effect (e.g. a
 * Visible-mode temporary hide) all require the structural observer.
 */
function hasRuntimeEffects(settings: Settings): boolean {
  return (
    hasAppearanceEffects(settings) ||
    hasSidebarEffects(settings) ||
    sidebarController.hasTransientSidebarEffect()
  );
}

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

  // Fix 2: reflect enabled state and attach/detach the shortcut listener.
  runtimeEnabled = settings.enabled;
  if (settings.enabled && !keyboardListenerAttached) {
    document.addEventListener("keydown", handleKeydown);
    keyboardListenerAttached = true;
  } else if (!settings.enabled && keyboardListenerAttached) {
    document.removeEventListener("keydown", handleKeydown);
    keyboardListenerAttached = false;
  }

  // Fix 3+4: synchronous connect/disconnect from validated settings.
  if (settings.enabled && hasRuntimeEffects(settings)) {
    connectObserver(settings);
  } else {
    disconnectObserver();
  }

  lastSettings = settings;
}

/** Apply current settings; used on bootstrap, storage change, and route change. */
function applyCurrent(): void {
  void getSettings().then(syncRuntime);
}

/**
 * Reconcile the structural observer against the last applied settings plus the
 * controller's current transient state. Used after a transient keyboard toggle
 * so a freshly hidden/closed sidebar becomes observed immediately, and a
 * restored one is disconnected when no other effect remains.
 */
function reconcileObserver(): void {
  if (!lastSettings) return;
  if (runtimeEnabled && hasRuntimeEffects(lastSettings)) {
    connectObserver(lastSettings);
  } else {
    disconnectObserver();
  }
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
  if (!hasSidebarEffects(settings) && !sidebarController.hasTransientSidebarEffect()) {
    return conv ?? document.body;
  }
  // Fix 3: use ONLY a target that passed the Phase 3 safety gate and
  // normalization — never the raw adapter candidate. The controller's detected
  // target (already gated) is preferred; otherwise fall back to a fresh safe
  // detection. An unsafe raw candidate is never used to narrow the observer.
  const safeSidebar =
    sidebarController.target ?? findSafeSidebarTarget(adapter);
  if (conv && safeSidebar) {
    const lca = lowestCommonAncestor(conv, safeSidebar);
    if (lca && lca !== document.documentElement) return lca;
  }
  if (safeSidebar) {
    const parent = safeSidebar.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) {
      return parent;
    }
  }
  // No safe sidebar yet: observe document.body (or another demonstrably safe
  // app-shell root) broadly enough to detect a later valid sidebar, then
  // reconnect to the narrower safe root once it appears.
  return document.body;
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

/**
 * Synchronously attach (or reuse) the scoped observer to the narrowest stable
 * root for the given validated settings (Fix 4: no async fetch in the initial
 * path). Reconnect idempotently when the target changes.
 */
function connectObserver(settings: Settings): void {
  const target = pickObserverTarget(settings);
  if (observedTarget === target && observer) return; // already observing
  if (observer) observer.disconnect();
  const epoch = observerEpoch;
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
    // Reconnect to a narrower root if one just became available (Fix 4: guard
    // against a stale async result reconnecting after teardown/mode change).
    // Use the already-validated current settings (lastSettings) for the
    // narrowing decision rather than re-reading storage, which may resolve to
    // a stale snapshot and skip the reconnect.
    const s = lastSettings;
    if (s) {
      if (observerEpoch !== epoch) return; // superseded / torn down
      if (!s.enabled || !hasRuntimeEffects(s)) return; // effect gone
      // Re-detect with current DOM before narrowing (a safe sidebar may have
      // just appeared or moved), so the observer adopts the narrower safe root.
      sidebarController.refresh(s);
      const narrower = pickObserverTarget(s);
      if (narrower && narrower !== observedTarget) connectObserver(s);
    }
    // Coalesce refresh into one debounced operation.
    scheduleMarkerRefresh();
  });
  observedTarget = target;
  observer.observe(target, { childList: true, subtree: true });
}

/** Disconnect the active observer and bump the epoch (Fix 4). Idempotent. */
function disconnectObserver(): void {
  observerEpoch++;
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
  // Fix 2: remove the shortcut listener.
  if (keyboardListenerAttached) {
    document.removeEventListener("keydown", handleKeydown);
    keyboardListenerAttached = false;
  }
  runtimeEnabled = false;
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

/**
 * Global keydown handler for the fixed `Alt+Shift+L` sidebar shortcut.
 *
 * Order of checks (Fix 2): enabled -> not repeat -> not composing -> non-
 * editable origin -> exact modifiers + KeyL -> preventDefault -> toggle. No
 * storage read is performed merely to determine whether the extension is
 * enabled; the synchronous `runtimeEnabled` flag is used instead.
 */
function handleKeydown(e: KeyboardEvent): void {
  // 1. enabled
  if (!runtimeEnabled) return;
  // 2. ignore repeats
  if (e.repeat) return;
  // 3. ignore composition
  if (e.isComposing || e.key === "Process") return;
  // 4. ignore editable origins
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
  // 5. exact modifier match: Alt+Shift+KeyL, no Ctrl/Meta.
  const match =
    e.altKey &&
    e.shiftKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    e.code === "KeyL";
  if (!match) return;
  // 6. prevent default only after an exact valid match.
  e.preventDefault();
  // 7. toggle sidebar transient state.
  sidebarController.onKeyboardToggle();
  // Fix 3: after the transient toggle (Alt+Shift+L), re-evaluate whether the
  // structural observer is required and connect/disconnect accordingly. This
  // runs synchronously so a freshly hidden/closed sidebar is observed at once.
  reconcileObserver();
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
      void getSettings().then((s) => {
        // Fix 5: clear transient state only for relevant changes.
        const prev = lastSettings;
        const modeChanged = !!prev && s.sidebar.mode !== prev.sidebar.mode;
        const disabled = !!prev && prev.enabled && !s.enabled;
        if (modeChanged || disabled) {
          sidebarController.clearTransient();
        }
        syncRuntime(s);
      });
    });
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
  hasRuntimeEffects,
};

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void bootstrap(), { once: true });
  } else {
    void bootstrap();
  }
}
