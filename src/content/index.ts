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
 *  - detect SPA route changes and re-apply non-destructively.
 *
 * It performs NO destructive DOM operations and makes NO external network
 * request. Sidebar hiding, copy controls, folding, and history limiting are
 * intentionally deferred.
 */

const applier = new ThemeApplier();
const adapter = createAdapter();
const routeListener = new RouteListener();

const debouncedApply = debounce((s: Settings) => applier.apply(s), 120);

/** Re-apply current settings after a route change: restore first, then apply. */
function reapplyAfterRouteChange(): void {
  adapter.refresh();
  void getSettings().then((s) => applier.apply(s));
}

async function bootstrap(): Promise<void> {
  const settings = await getSettings();
  applier.apply(settings);

  routeListener.onChange(() => {
    reapplyAfterRouteChange();
  });
  routeListener.start();

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

  logger.info("content", "Lite UI content script active", { enabled: settings.enabled });
}

// Exposed for tests only (does not run any side effects on import).
export { applier, adapter, routeListener, reapplyAfterRouteChange };

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void bootstrap(), { once: true });
  } else {
    void bootstrap();
  }
}
