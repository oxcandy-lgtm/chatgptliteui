import type { Settings } from "../shared/types.js";
import { getSettings } from "../settings/storage.js";
import { ThemeApplier } from "./lifecycle.js";
import { RouteListener } from "./route-listener.js";
import { createAdapter } from "../adapters/chatgpt-adapter.js";
import { debounce } from "../shared/debounce.js";
import { logger } from "../shared/logger.js";

/**
 * Content script entry point (Phase 0 minimal runtime).
 *
 * Responsibilities in this phase:
 *  - load settings;
 *  - add/remove the extension-owned root class on document.documentElement;
 *  - inject harmless CSS variables (via class + custom properties);
 *  - react to chrome.storage.onChanged;
 *  - restore original page appearance when disabled;
 *  - detect SPA route changes and re-apply non-destructively.
 *
 * It performs NO destructive DOM operations and makes NO external network
 * request. Sidebar hiding, copy controls, folding, and history limiting are
 * intentionally deferred.
 */

const applier = new ThemeApplier();
const adapter = createAdapter();
const routeListener = new RouteListener();

let conversationObserver: MutationObserver | null = null;
const debouncedApply = debounce((s: Settings) => applier.apply(s), 120);

function narrowContainer(): HTMLElement | null {
  const result = adapter.detectConversationContainer();
  return result.found ? result.element : null;
}

/** Build a scoped MutationObserver once the conversation container exists. */
function ensureObserver(): void {
  if (conversationObserver) return;
  const container = narrowContainer();
  const target: Node = container ?? document.body;
  conversationObserver = new MutationObserver((mutations) => {
    // Inspect only added nodes, not the entire document.
    let touched = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        touched = true;
        break;
      }
    }
    if (!touched) return;
    // Re-check route signature on structural changes (cheap path).
    routeListener.check();
  });
  conversationObserver.observe(target, { childList: true, subtree: true });
}

/** Tear down observers and extension-owned UI without destroying page DOM. */
function teardown(): void {
  if (conversationObserver) {
    conversationObserver.disconnect();
    conversationObserver = null;
  }
  applier.remove();
}

function applyAndObserve(settings: Settings): void {
  applier.apply(settings);
  if (settings.enabled) {
    ensureObserver();
  } else {
    if (conversationObserver) {
      conversationObserver.disconnect();
      conversationObserver = null;
    }
  }
}

async function bootstrap(): Promise<void> {
  const settings = await getSettings();
  applyAndObserve(settings);

  routeListener.onChange(() => {
    // On route change: tear down observers/UI refs, re-run discovery, reapply.
    if (conversationObserver) {
      conversationObserver.disconnect();
      conversationObserver = null;
    }
    adapter.refresh();
    void getSettings().then(applyAndObserve);
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void bootstrap(), { once: true });
} else {
  void bootstrap();
}

// Exposed for tests only (does not run any side effects on import).
export { applier, adapter, routeListener, teardown, ensureObserver, narrowContainer };
