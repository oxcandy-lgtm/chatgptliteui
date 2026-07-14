import type { Settings } from "../shared/types.js";
import { getSettings } from "../settings/storage.js";
import { ThemeApplier } from "./lifecycle.js";
import { RouteListener } from "./route-listener.js";
import { createAdapter } from "../adapters/chatgpt-adapter.js";
import { debounce } from "../shared/debounce.js";
import { hasAppearanceEffects } from "../features/appearance/presets.js";
import { logger } from "../shared/logger.js";

/**
 * Content script entry point (Phase 2 appearance controls).
 *
 * Responsibilities:
 *  - load settings;
 *  - apply appearance via extension-owned root classes, `--cgl-*` custom
 *    properties, and `data-cgl-*` surface markers;
 *  - react to chrome.storage.onChanged;
 *  - restore the official ChatGPT appearance when disabled, on the Normal
 *    preset, on route teardown, or on lifecycle teardown;
 *  - detect SPA route changes and re-apply non-destructively;
 *  - observe structural DOM mutations to re-mark newly generated turns and
 *    re-apply active width/font/spacing/theme to new messages.
 *
 * It performs NO destructive DOM operations and makes NO external network
 * request. Sidebar hiding, copy controls, folding, and history limiting are
 * intentionally deferred.
 */

const applier = new ThemeApplier();
const adapter = createAdapter();
const routeListener = new RouteListener();

let observer: MutationObserver | null = null;
let observedTarget: Node | null = null;

/**
 * Single coalesced marker-refresh operation. The MutationObserver callback
 * schedules this (never a full storage read + rescan per mutation batch), so a
 * burst of synchronous DOM mutations produces exactly one refresh after the
 * debounce window.
 */
const scheduleMarkerRefresh = debounce((): void => {
  void getSettings().then((settings) => {
    applier.refreshMarkers(settings);
  });
}, 120);

/** Apply settings and connect/disconnect the observer per the active profile. */
function syncRuntime(settings: Settings): void {
  applier.apply(settings);
  if (settings.enabled && hasAppearanceEffects(settings)) {
    connectObserver();
  } else {
    disconnectObserver();
  }
}

/** Apply current settings; used on bootstrap, storage change, and route change. */
function applyCurrent(): void {
  void getSettings().then(syncRuntime);
}

/** Attach a scoped observer to the narrowest available stable root. */
function connectObserver(): void {
  const target: Node = adapter.detectConversationContainer().element ?? document.body;
  if (observedTarget === target && observer) return; // already observing
  if (observer) observer.disconnect();
  observer = new MutationObserver((mutations) => {
    let added = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        for (const node of Array.from(m.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            added = true;
            break;
          }
        }
      }
      if (added) break;
    }
    if (!added) return;
    // Cheap path: re-check route signature on structural changes.
    routeListener.check();
    // Reconnect to a narrower container if it just appeared.
    const narrower = adapter.detectConversationContainer().element;
    if (narrower && narrower !== observedTarget) {
      connectObserver();
    }
    // Coalesce marker refresh into one debounced operation.
    scheduleMarkerRefresh();
  });
  observedTarget = target;
  observer.observe(target, { childList: true, subtree: true });
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
  applier.restore();
}

/** Re-apply after a route change: restore markers, refresh, re-sync. */
function reapplyAfterRouteChange(): void {
  applier.restore();
  adapter.refresh();
  applyCurrent();
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
      // changes.settings.newValue.
      void getSettings().then(syncRuntime);
    });
  }

  logger.info("content", "Lite UI content script active", {});
}

// Exposed for tests only (does not run any side effects on import).
export {
  applier,
  adapter,
  routeListener,
  connectObserver,
  disconnectObserver,
  teardown,
  reapplyAfterRouteChange,
  syncRuntime,
  scheduleMarkerRefresh,
};

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void bootstrap(), { once: true });
  } else {
    void bootstrap();
  }
}
