import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";

/**
 * Single user-gesture copy path for writing blocks.
 *
 * Two strategies, in priority order:
 *
 *  1) Prefer an original ChatGPT copy action ONLY when it is safely associated
 *     with the active writing block: exactly one candidate, high/medium
 *     confidence, connected, a button/valid button role, contained by the
 *     active block, not the extension's own button, not disabled, not
 *     aria-disabled, not inside a dialog, and its label/testid indicates a copy
 *     action. When safely associated we invoke its existing action during the
 *     direct user gesture and report "Copy requested." (we cannot read the
 *     clipboard to confirm success).
 *
 *  2) Clipboard API fallback: recalculate + validate the target, extract its
 *     visible text into a LOCAL variable, call `navigator.clipboard.writeText`
 *     directly from the active user gesture, clear retained references, and
 *     report "Copied." only after the promise resolves. If the text is empty or
 *     the gesture is unavailable, report "Copy unavailable." and leave the DOM
 *     and selection unchanged.
 *
 * Invariants (enforced by design, not just comments):
 *  - Clipboard read and legacy exec copy are
 *    NEVER called anywhere in this module.
 *  - Copied text is never persisted, logged, transmitted, queued, included in
 *    thrown errors, or retained beyond local resolution.
 *  - The fallback `writeText` is invoked synchronously from the gesture; no
 *    `await` precedes it that could drop user activation.
 */

export type CopyOutcome = "requested" | "copied" | "unavailable";

/** Enumerated copy-stage failure codes (privacy-safe, no messages). */
export type CopyFailureCode =
  | "NO_ACTIVE_TARGET"
  | "TARGET_DISCONNECTED"
  | "EMPTY_COPY_PAYLOAD"
  | "CLIPBOARD_API_UNAVAILABLE"
  | "CLIPBOARD_WRITE_REJECTED"
  | "COPY_REQUESTED_UNVERIFIED";

/** Which copy strategy produced the outcome. */
export type CopyStrategy = "original-action" | "clipboard-write";

/** Structured execution result for diagnostics (no text, no stacks). */
export interface CopyExecutionResult {
  outcome: CopyOutcome;
  strategy: CopyStrategy | null;
  originalActionFound: boolean;
  payloadNonEmpty: boolean;
  clipboardApiAvailable: boolean;
  clipboardWriteAttempted: boolean;
  clipboardWriteResolved: boolean;
  /** ONLY error.name (e.g. NotAllowedError); never error.message/stack. */
  clipboardErrorName: string | null;
  failureCode: CopyFailureCode | null;
}

const EXTENSION_HOST_SELECTOR =
  '[data-cgl-writing-copy-host="true"], [data-cgl-sidebar-host="true"], #cgl-sidebar-control-host';

function isCopyActionLabel(el: Element): boolean {
  const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
  const testid = (el.getAttribute("data-testid") ?? "").toLowerCase();
  const text = (el.textContent ?? "").toLowerCase();
  return (
    /copy/i.test(aria) ||
    /copy/i.test(testid) ||
    /copy/i.test(text)
  );
}

function isActionableButton(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== "button" && el.getAttribute("role") !== "button") return false;
  if (el instanceof HTMLButtonElement) {
    if (el.disabled) return false;
  }
  if (el.getAttribute("aria-disabled") === "true") return false;
  return true;
}

/**
 * Find a safely associated original copy button INSIDE the active block.
 * Returns null unless exactly one exists and all safety invariants hold.
 */
export function findAssociatedCopyAction(
  block: HTMLElement,
  adapter: ChatGptAdapter,
): HTMLElement | null {
  const results = adapter.detectOriginalCopyButton(block);
  if (!results.found) return null;
  const candidates = results.elements.filter(
    (el): el is HTMLElement =>
      el != null &&
      el.isConnected &&
      el instanceof HTMLElement &&
      !el.closest(EXTENSION_HOST_SELECTOR) &&
      isActionableButton(el) &&
      isCopyActionLabel(el) &&
      !el.closest('[role="dialog"], dialog, [aria-modal="true"]'),
  );
  // Exactly one safe candidate associated with this block.
  if (candidates.length !== 1) return null;
  return candidates[0] ?? null;
}

/**
 * Bounded, deterministic text extraction. Prefers rendered visible text
 * (`innerText`); falls back to `textContent` in test environments. Hidden
 * script/style content is excluded by `innerText`. Normalizes line endings.
 * Returns only the block's own text (descendant controls/blocks are not
 * specially filtered here because the active block is already the safe
 * canonical writing block, excluding code via detection gate; callers pass the
 * normalized block).
 */
export function extractBlockText(block: HTMLElement): string {
  const raw =
    typeof block.innerText === "string" && block.innerText.length > 0
      ? block.innerText
      : block.textContent ?? "";
  // Normalize Windows/old-Mac line endings to LF.
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/**
 * Perform the copy from an active user gesture, reporting EVERY stage
 * structurally. `getBlock` is called to recalculate/validate the current
 * target immediately before copying. No text, no messages, no stacks in the
 * result — only booleans, enums, and error.name.
 */
export async function performCopyDetailed(
  getBlock: () => HTMLElement | null,
  adapter: ChatGptAdapter,
): Promise<CopyExecutionResult> {
  const result: CopyExecutionResult = {
    outcome: "unavailable",
    strategy: null,
    originalActionFound: false,
    payloadNonEmpty: false,
    clipboardApiAvailable: false,
    clipboardWriteAttempted: false,
    clipboardWriteResolved: false,
    clipboardErrorName: null,
    failureCode: null,
  };

  const block = getBlock();
  if (!block) {
    result.failureCode = "NO_ACTIVE_TARGET";
    return result;
  }
  if (!block.isConnected) {
    result.failureCode = "TARGET_DISCONNECTED";
    return result;
  }
  if (block.closest(EXTENSION_HOST_SELECTOR)) {
    result.failureCode = "NO_ACTIVE_TARGET";
    return result;
  }

  // Strategy 1: safely associated original copy action.
  const original = findAssociatedCopyAction(block, adapter);
  result.originalActionFound = original != null;
  if (original) {
    // Invoke the page's own action during the live user gesture. We cannot
    // verify clipboard success, so report "requested".
    result.strategy = "original-action";
    result.outcome = "requested";
    result.failureCode = "COPY_REQUESTED_UNVERIFIED";
    original.click();
    return result;
  }

  // Strategy 2: Clipboard API fallback from the active gesture.
  const text = extractBlockText(block);
  result.payloadNonEmpty = text.length > 0;
  if (!result.payloadNonEmpty) {
    result.strategy = "clipboard-write";
    result.failureCode = "EMPTY_COPY_PAYLOAD";
    return result;
  }

  const clipboardAvailable =
    typeof navigator !== "undefined" && !!navigator.clipboard?.writeText;
  result.clipboardApiAvailable = clipboardAvailable;
  if (!clipboardAvailable) {
    result.strategy = "clipboard-write";
    result.failureCode = "CLIPBOARD_API_UNAVAILABLE";
    return result;
  }

  try {
    // Single synchronous call from the gesture; await the same promise.
    result.clipboardWriteAttempted = true;
    await navigator.clipboard.writeText(text);
    result.clipboardWriteResolved = true;
    result.strategy = "clipboard-write";
    result.outcome = "copied";
    return result;
  } catch (err) {
    result.strategy = "clipboard-write";
    result.clipboardErrorName =
      typeof err === "object" && err != null && "name" in err
        ? String((err as { name: unknown }).name)
        : null;
    result.failureCode = "CLIPBOARD_WRITE_REJECTED";
    return result;
  }
}

/**
 * Compatibility wrapper preserving the original outcome-only contract.
 * Existing callers and tests keep working; diagnostics use the detailed path.
 */
export async function performCopy(
  getBlock: () => HTMLElement | null,
  adapter: ChatGptAdapter,
): Promise<CopyOutcome> {
  return (await performCopyDetailed(getBlock, adapter)).outcome;
}
