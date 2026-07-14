import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import type { DetectionResult } from "../../adapters/detection-result.js";

/**
 * Safe sidebar detection gate and target normalization.
 *
 * Phase 3 hardens the Adapter's `detectSidebar()` result with a stricter
 * action gate. The Adapter is free to return a `nav` (high confidence) or a
 * `[data-testid="sidebar"]` / `aside` wrapper (medium confidence). Before any
 * extension action, we require:
 *  - exactly one non-null element;
 *  - confidence high or medium;
 *  - the candidate is connected;
 *  - the candidate is not html/body/main/the conversation container/the
 *    composer, and not inside a dialog or modal;
 *  - the candidate is a navigation landmark or contains a unique navigation
 *    landmark with sidebar/navigation structure.
 *
 * If the Adapter returns an inner `nav`, we may normalize upward only to a
 * uniquely associated wrapper (`aside` / `[data-testid="sidebar"]`) that
 * contains the nav, does NOT contain the conversation main region or a dialog,
 * and is unique. Otherwise we mark only the detected nav.
 */

/** Extension-owned id for the Shadow DOM control host (observer ignores it). */
export const SIDEBAR_HOST_ID = "cgl-sidebar-control-host";

function closestDialog(el: Element): Element | null {
  return el.closest('[role="dialog"], dialog, [aria-modal="true"]');
}

function containsNavigationStructure(el: Element): boolean {
  // A navigation landmark (the element itself or a unique descendant nav).
  const nav =
    el.matches("nav") || el.matches('[role="navigation"]')
      ? el
      : el.querySelector("nav, [role=\"navigation\"]");
  if (!nav) return false;
  // Sidebar/navigation structure: a chat-history aria-label, or multiple
  // navigation links/buttons (a real sidebar has several).
  const labeled =
    nav.getAttribute("aria-label")?.toLowerCase().includes("chat history") ||
    nav.getAttribute("aria-label")?.toLowerCase().includes("history") ||
    nav.getAttribute("aria-label")?.toLowerCase().includes("conversation");
  const navLinks = nav.querySelectorAll('a[href], button, [role="button"]');
  if (labeled) return true;
  return navLinks.length >= 2;
}

/**
 * Pure structural gate for a single detection result.
 *
 * `adapter` is used only to obtain the conversation container / composer so we
 * can refuse candidates nested inside them. This never mutates the page.
 */
export function isSafeSidebarDetection(
  result: DetectionResult,
  adapter: ChatGptAdapter,
): boolean {
  if (!result.found) return false;
  if (result.confidence !== "high" && result.confidence !== "medium") return false;
  // Exactly one non-null element.
  if (result.elements.length !== 1) return false;
  const el = result.element;
  if (!el) return false;
  if (!el.isConnected) return false;

  const tag = el.tagName.toLowerCase();
  if (tag === "html" || tag === "body" || tag === "main") return false;

  // Reject the conversation container / composer themselves.
  const container = adapter.detectConversationContainer().element;
  if (container && (el === container || container.contains(el))) return false;
  const composer = adapter.detectComposer().element;
  if (composer && (el === composer || composer.contains(el))) return false;

  // Reject anything inside a dialog/modal.
  if (closestDialog(el)) return false;

  // Must be a navigation landmark or contain one with sidebar structure.
  if (!containsNavigationStructure(el)) return false;

  return true;
}

/**
 * Normalize a safe detected sidebar element to its uniquely associated
 * wrapper when one exists, otherwise return the detected element.
 *
 * Returns null when the candidate is unsafe or no stable wrapper can be found.
 */
export function normalizeSidebarTarget(
  result: DetectionResult,
  adapter: ChatGptAdapter,
): HTMLElement | null {
  if (!isSafeSidebarDetection(result, adapter)) return null;
  const el = result.element as HTMLElement;
  const container = adapter.detectConversationContainer().element;

  // Already a wrapper? (aside / [data-testid="sidebar"])
  const isWrapper =
    el.matches("aside") || el.matches('[data-testid="sidebar"]');
  if (isWrapper) {
    // Reject wrappers that contain the conversation main region (unsafe).
    if (container && container.contains(el)) return null;
    return el;
  }

  // Detected an inner nav: try to find a unique containing wrapper.
  const wrappers = Array.from(
    document.querySelectorAll('aside, [data-testid="sidebar"]'),
  ) as HTMLElement[];
  const containing = wrappers.filter(
    (w) => w.contains(el) && !(container && container.contains(w)),
  );
  if (containing.length === 1) return containing[0] ?? null;
  // Ambiguous wrappers (0 or >1) or unsafe → mark only the detected element.
  return el;
}

/**
 * Convenience: run Adapter detection, apply the safe gate, and return the
 * normalized target element (wrapper preferred) or null when no safe target
 * exists. Never throws; returns null on any uncertainty.
 */
export function findSafeSidebarTarget(
  adapter: ChatGptAdapter,
): HTMLElement | null {
  const result = adapter.detectSidebar();
  return normalizeSidebarTarget(result, adapter);
}
