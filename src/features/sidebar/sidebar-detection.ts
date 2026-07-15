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
 *    composer, is not inside a dialog or modal, and does NOT contain the
 *    conversation main region, composer, or a dialog/modal;
 *  - the candidate carries exactly one qualifying navigation landmark
 *    (itself a nav/[role=navigation], or contains exactly one such descendant
 *    with sidebar/navigation structure).
 *
 * If the Adapter returns an inner `nav`, we may normalize upward only to a
 * uniquely associated wrapper (`aside` / `[data-testid="sidebar"]`) that:
 *  - is connected;
 *  - uniquely contains the detected nav;
 *  - contains exactly one qualifying navigation landmark;
 *  - does not contain conversation main / composer / dialog; and
 *  - passes the same navigation-structure invariants.
 * Otherwise we fall back to marking only the safely detected nav.
 */

/** Extension-owned id for the Shadow DOM control host (observer ignores it). */
export const SIDEBAR_HOST_ID = "cgl-sidebar-control-host";

const DIALOG_SELECTOR = '[role="dialog"], dialog, [aria-modal="true"]';

function closestDialog(el: Element): Element | null {
  return el.closest(DIALOG_SELECTOR);
}

function hasDialogDescendant(el: Element): boolean {
  return el.querySelectorAll(DIALOG_SELECTOR).length > 0;
}

function navigationLandmarks(el: Element): Element[] {
  const self = el.matches("nav, [role='navigation']") ? [el] : [];
  const descendants = Array.from(
    el.querySelectorAll("nav, [role='navigation']"),
  ) as Element[];
  return [...self, ...descendants];
}

function hasSidebarStructure(nav: Element): boolean {
  // Sidebar/navigation structure: a chat-history aria-label, or multiple
  // navigation links/buttons (a real sidebar has several).
  const label = nav.getAttribute("aria-label")?.toLowerCase() ?? "";
  if (label.includes("chat history") || label.includes("history") || label.includes("conversation")) {
    return true;
  }
  const navLinks = nav.querySelectorAll('a[href], button, [role="button"]');
  return navLinks.length >= 2;
}

/** Does the candidate itself contain exactly one qualifying navigation landmark? */
function singleQualifyingLandmark(el: Element): boolean {
  const landmarks = navigationLandmarks(el);
  if (landmarks.length !== 1) return false;
  const nav = landmarks[0];
  if (!nav) return false;
  return hasSidebarStructure(nav);
}

/**
 * Pure structural gate for a single detection result.
 *
 * `adapter` is used only to obtain the conversation container / composer so we
 * can refuse candidates nested inside (or containing) them. This never mutates
 * the page.
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

  const container = adapter.detectConversationContainer().element;
  const composer = adapter.detectComposer().element;

  // Candidate containment (Fix 6): reject if it is, contains, or is contained
  // by the conversation container or composer.
  if (container) {
    if (el === container || el.contains(container) || container.contains(el)) return false;
  }
  if (composer) {
    if (el === composer || el.contains(composer) || composer.contains(el)) return false;
  }

  // Dialog containment (Fix 6): reject if inside or containing a dialog/modal.
  if (closestDialog(el)) return false;
  if (hasDialogDescendant(el)) return false;

  // Unique navigation landmark with sidebar structure (Fix 6).
  if (!singleQualifyingLandmark(el)) return false;

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
  const composer = adapter.detectComposer().element;

  // Detected an inner nav: try to find a unique containing wrapper.
  const wrappers = Array.from(
    document.querySelectorAll("aside, [data-testid='sidebar']"),
  ) as HTMLElement[];
  const containing = wrappers.filter((w) => {
    if (!w.isConnected) return false;
    if (!w.contains(el)) return false;
    if (container && (w === container || w.contains(container) || container.contains(w))) return false;
    if (composer && (w === composer || w.contains(composer) || composer.contains(w))) return false;
    // Dialog containment.
    if (closestDialog(w)) return false;
    if (hasDialogDescendant(w)) return false;
    // Exactly one qualifying navigation landmark inside the wrapper.
    if (!singleQualifyingLandmark(w)) return false;
    return true;
  });
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
