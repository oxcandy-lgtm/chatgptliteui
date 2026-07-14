import type { Settings } from "../shared/types.js";
import { getSettings } from "../settings/storage.js";
import { ThemeApplier } from "./lifecycle.js";
import { RouteListener } from "./route-listener.js";
import { createAdapter } from "../adapters/chatgpt-adapter.js";
import { debounce } from "../shared/debounce.js";
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

const debouncedApply = debounce((s: Settings) => applier.apply(s), 120);

/** Apply current settings; used on bootstrap, storage change, and route change. */
function applyCurrent(): void {
  void getSettings().then((s) => applier.apply(s));
}

/** Re-mark surfaces for new turns without clobbering root classes/variables. */
function refreshCurrentMarkers(): void {
  void getSettings().then((s) => applier.refreshMarkers(s));
}

/**
 * Attach a scoped, debounced observer to the narrowest available stable root.
 * Prefers the detected conversation container; falls back to document.body only
 * until a narrower root is discovered, and reconnects once found.
 */
function connectObserver(): void {
  const target: Node =
    adapter.detectConversationContainer().element ?? document.body;
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
    // Refresh markers for new turns (debounced above via refreshCurrentMarkers).
    refreshCurrentMarkers();
  });
  observedTarget = target;
  observer.observe(target, { childList: true, subtree: true });
}

/** Tear down observers and extension-owned UI without destroying page DOM. */
function teardown(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  observedTarget = null;
  applier.restore();
}

/** Re-apply after a route change: restore markers, refresh, re-apply, reconnect. */
function reapplyAfterRouteChange(): void {
  applier.restore();
  adapter.refresh();
  applyCurrent();
  connectObserver();
}

async function bootstrap(): Promise<void> {
  applier.apply(await getSettings());

  routeListener.onChange(() => {
    reapplyAfterRouteChange();
  });
  routeListener.start();

  connectObserver();

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!("settings" in changes)) return;
      const envelope = changes.settings.newValue;
      if (envelope && typeof envelope === "object" && "settings" in envelope) {
        const incoming = (envelope as { settings?: Settings }).settings;
        if (incoming) debouncedApply(incoming);
      }
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
  teardown,
  reapplyAfterRouteChange,
  refreshCurrentMarkers,
};

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void bootstrap(), { once: true });
  } else {
    void bootstrap();
  }
}
