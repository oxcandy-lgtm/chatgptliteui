import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import { WRITING_FALLBACK_STRATEGY_ID } from "../../adapters/chatgpt-adapter.js";
import type { DetectionResult } from "../../adapters/detection-result.js";
import type { Confidence } from "../../shared/types.js";

/**
 * Safe writing-block detection gate and candidate normalization.
 *
 * The Adapter returns high/medium-confidence writing-block candidates.
 * Before any extension action (marking, tracking, copying) we require:
 *  - detection confidence is `high` or `medium` (never `low`/`unknown`);
 *  - the candidate is connected;
 *  - it belongs to exactly one high-confidence Assistant turn;
 *  - it is not inside a User turn, the composer, the sidebar, a dialog/modal,
 *    `pre`, `code`, a button, or an extension-owned host;
 *  - it is not contenteditable — EXCEPT the single surgically-proven case:
 *    a candidate the Adapter itself returned via the structural
 *    `writing-block-editor-anchored` strategy (`isProvenWritingBlockEditor`).
 *    Every OTHER contenteditable element (composer, generic surfaces,
 *    wrappers) remains rejected with CONTENTEDITABLE_SELF, and descendants
 *    inside any contenteditable ancestor remain rejected with
 *    CONTENTEDITABLE_ANCESTOR;
 *  - it does not contain the composer, sidebar, dialog, or another turn;
 *  - its visible text is non-empty at action time (checked separately).
 *
 * Normalization collapses nested candidates (e.g. a `[data-testid="text-block"]`
 * containing a `<p>`) to the single outermost canonical block, removes
 * duplicates, disconnected nodes, and produces deterministic DOM-order output.
 * No ChatGPT-owned attribute/class/style/structure is ever mutated here.
 *
 * The gate is implemented by the pure diagnostic evaluator
 * `evaluateWritingBlockCandidate`, which reports the EXACT reason codes for
 * every failed invariant. `isSafeWritingBlock` delegates to it, so production
 * behavior and X-Ray diagnostics can never disagree about why a candidate was
 * rejected. The evaluator collects ALL failed invariants (the boolean outcome
 * is identical to the previous short-circuit form).
 */

const DIALOG_SELECTOR = '[role="dialog"], dialog, [aria-modal="true"]';
const EXTENSION_HOST_SELECTOR =
  '[data-cgl-sidebar-host="true"], [data-cgl-writing-copy-host="true"], #cgl-sidebar-control-host';

/** Exact reason codes produced by the writing-block safety gate. */
export type WritingBlockRejectionReason =
  | "DISCONNECTED"
  | "NOT_HTML_ELEMENT"
  | "LOW_OR_UNKNOWN_CONFIDENCE"
  | "NO_SINGLE_ASSISTANT_OWNER"
  | "FORBIDDEN_TAG"
  | "BUTTON_SURFACE"
  | "CONTAINS_CODE"
  | "CONTENTEDITABLE_SELF"
  | "CONTENTEDITABLE_ANCESTOR"
  | "IN_DIALOG"
  | "IN_SIDEBAR"
  | "IN_EDITABLE_ANCESTOR"
  | "IN_EXTENSION_HOST"
  | "CONTAINS_DIALOG"
  | "CONTAINS_EXTENSION_HOST"
  | "CONTAINS_OTHER_TURN"
  | "CONTAINS_COMPOSER";

/** Pure diagnostic result of the writing-block safety gate. */
export interface WritingBlockEvaluation {
  accepted: boolean;
  confidence: Confidence;
  /** Every failed invariant, in gate-check order. Empty when accepted. */
  reasons: WritingBlockRejectionReason[];
}

function closestDialog(el: Element): Element | null {
  return el.closest(DIALOG_SELECTOR);
}

function hasDialogDescendant(el: Element): boolean {
  return el.querySelectorAll(DIALOG_SELECTOR).length > 0;
}

function containsExtensionHost(el: Element): boolean {
  return el.querySelectorAll(EXTENSION_HOST_SELECTOR).length > 0;
}

function selfContentEditable(el: Element): boolean {
  return el.getAttribute("contenteditable") === "true";
}

function ancestorContentEditable(el: Element): boolean {
  let p = el.parentElement;
  while (p) {
    if (p.getAttribute("contenteditable") === "true") return true;
    p = p.parentElement;
  }
  return false;
}

function containsAnotherTurn(el: Element, selfTurn: Element | null): boolean {
  const turns = el.querySelectorAll(
    '[data-message-author-role], [data-testid="user-message"], [data-testid="assistant-message"]',
  );
  for (const t of Array.from(turns)) {
    if (t !== el && t !== selfTurn) return true;
  }
  return false;
}

/**
 * Count distinct high-confidence Assistant turns that contain the candidate.
 * A safe block must belong to exactly one Assistant turn.
 */
function assistantTurnCount(container: ParentNode, candidate: Element): number {
  const turns = Array.from(
    container.querySelectorAll(
      '[data-message-author-role="assistant"], [data-testid="assistant-message"]',
    ),
  ) as Element[];
  let count = 0;
  for (const turn of turns) {
    if (turn.contains(candidate)) count++;
  }
  return count;
}

/**
 * Pure gate for a single candidate element. Collects EVERY failed invariant
 * as a reason code; `accepted` is true only when `reasons` is empty.
 *
 * `adapter` is used only to obtain the conversation container / composer so we
 * can refuse candidates nested inside (or containing) them. This never mutates
 * the page.
 */
export function evaluateWritingBlockCandidate(
  candidate: Element,
  adapter: ChatGptAdapter,
): WritingBlockEvaluation {
  // Prerequisite checks: further structural checks are meaningless (and the
  // original gate short-circuited here), so stop with these reasons only.
  if (!candidate.isConnected) {
    return { accepted: false, confidence: "unknown", reasons: ["DISCONNECTED"] };
  }
  if (!(candidate instanceof HTMLElement)) {
    return { accepted: false, confidence: "unknown", reasons: ["NOT_HTML_ELEMENT"] };
  }

  const reasons: WritingBlockRejectionReason[] = [];

  const detection = detectionInfoForCandidate(candidate, adapter);
  const confidence = detection.confidence;
  if (confidence !== "high" && confidence !== "medium") {
    reasons.push("LOW_OR_UNKNOWN_CONFIDENCE");
  }

  // Must be inside exactly one Assistant turn.
  const container = adapter.detectConversationContainer().element ?? document;
  if (assistantTurnCount(container, candidate) !== 1) {
    reasons.push("NO_SINGLE_ASSISTANT_OWNER");
  }

  const tag = candidate.tagName.toLowerCase();
  if (tag === "pre" || tag === "code" || tag === "button") {
    reasons.push("FORBIDDEN_TAG");
  }
  if (candidate.matches('button, [role="button"]')) {
    reasons.push("BUTTON_SURFACE");
  }

  // Reject candidates that contain code blocks — EXCEPT the single proven
  // case: the exact structural anchored editor may contain inline <code>,
  // <pre>, or <pre><code> as CONTENT while remaining one canonical block.
  // Forbidden code elements THEMSELVES stay rejected via FORBIDDEN_TAG.
  if (!detection.provenAnchoredEditor && candidate.querySelector('pre, code')) {
    reasons.push("CONTAINS_CODE");
  }

  // Contenteditable: reject generically, EXCEPT the single proven case —
  // the exact editor the structural anchored strategy itself returned.
  if (selfContentEditable(candidate)) {
    if (!detection.provenAnchoredEditor) reasons.push("CONTENTEDITABLE_SELF");
  } else if (ancestorContentEditable(candidate)) {
    reasons.push("CONTENTEDITABLE_ANCESTOR");
  }

  // Reject inside forbidden surfaces.
  if (closestDialog(candidate)) reasons.push("IN_DIALOG");
  if (candidate.closest('[data-testid="sidebar"], nav[aria-label*="chat history" i]')) {
    reasons.push("IN_SIDEBAR");
  }
  const editableAncestor = candidate.closest('[role="textbox"], textarea, input');
  if (
    editableAncestor &&
    // Same surgical exception: a PROVEN anchored editor may itself carry the
    // editable role; any OUTER editable ancestor is still rejected.
    !(detection.provenAnchoredEditor && editableAncestor === candidate)
  ) {
    reasons.push("IN_EDITABLE_ANCESTOR");
  }
  if (candidate.closest(EXTENSION_HOST_SELECTOR)) reasons.push("IN_EXTENSION_HOST");

  // Reject if it contains forbidden surfaces or other turns.
  if (hasDialogDescendant(candidate)) reasons.push("CONTAINS_DIALOG");
  if (containsExtensionHost(candidate)) reasons.push("CONTAINS_EXTENSION_HOST");
  if (
    containsAnotherTurn(
      candidate,
      candidate.closest(
        '[data-message-author-role="assistant"], [data-testid="assistant-message"]',
      ),
    )
  ) {
    reasons.push("CONTAINS_OTHER_TURN");
  }

  const composer = adapter.detectComposer().element;
  if (composer) {
    if (
      candidate === composer ||
      candidate.contains(composer) ||
      composer.contains(candidate)
    ) {
      reasons.push("CONTAINS_COMPOSER");
    }
  }

  return { accepted: reasons.length === 0, confidence, reasons };
}

/**
 * Production gate. Delegates to the diagnostic evaluator so behavior and
 * diagnostics can never diverge.
 */
export function isSafeWritingBlock(
  candidate: Element,
  adapter: ChatGptAdapter,
): boolean {
  return evaluateWritingBlockCandidate(candidate, adapter).accepted;
}

/**
 * Surgical contenteditable exception.
 *
 * True ONLY when this exact element is `contenteditable="true"` AND the
 * Adapter itself returned it via the structural
 * `writing-block-editor-anchored` strategy (semantic WritingBlock header
 * anchor + unique associated editor). Every other contenteditable surface —
 * the composer, generic editable regions, wrappers — stays rejected.
 */
export function isProvenWritingBlockEditor(
  candidate: Element,
  adapter: ChatGptAdapter,
): boolean {
  if (candidate.getAttribute("contenteditable") !== "true") return false;
  return detectionInfoForCandidate(candidate, adapter).provenAnchoredEditor;
}

/**
 * Run Adapter writing-block detection ONCE for a candidate and derive both
 * the strategy confidence and the surgical anchored-editor proof.
 */
function detectionInfoForCandidate(
  candidate: Element,
  adapter: ChatGptAdapter,
): { confidence: Confidence; provenAnchoredEditor: boolean } {
  const container = adapter.detectConversationContainer().element ?? document;
  const result = adapter.detectWritingBlocks(container);
  const included =
    result.found && result.elements.includes(candidate as HTMLElement);
  return {
    confidence: included ? result.confidence : "unknown",
    provenAnchoredEditor:
      included && result.strategy === WRITING_FALLBACK_STRATEGY_ID,
  };
}

/**
 * Collect safe, normalized writing-block candidates from the current DOM.
 *
 *  - Runs the Adapter detection (high/medium/low strategies).
 *  - Keeps only `high`/`medium` candidates that pass `isSafeWritingBlock`.
 *  - Normalizes nested candidates to the outermost canonical block.
 *  - Removes disconnected nodes and extension-host nodes.
 *  - Returns candidates in deterministic DOM order.
 */
export function findSafeWritingBlocks(
  adapter: ChatGptAdapter,
): HTMLElement[] {
  const container = adapter.detectConversationContainer().element;
  if (!container) return [];
  const result = adapter.detectWritingBlocks(container);
  if (!result.found) return [];

  const candidates = result.elements.filter(
    (el): el is HTMLElement =>
      el != null &&
      el.isConnected &&
      el instanceof HTMLElement &&
      !el.closest(EXTENSION_HOST_SELECTOR) &&
      isSafeWritingBlock(el, adapter),
  );

  return normalizeCandidates(candidates);
}

/**
 * Collapse nested candidates to the outermost canonical block. When a safe
 * outer block contains safe descendant candidates, retain only the outer one.
 * Produces deterministic DOM-order output.
 */
export function normalizeCandidates(candidates: HTMLElement[]): HTMLElement[] {
  // Stable sort by DOM order (document position).
  const sorted = [...candidates].sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  const kept: HTMLElement[] = [];
  for (const cand of sorted) {
    // Skip if an already-kept candidate contains this one (nested dup).
    const contained = kept.some((k) => k.contains(cand));
    if (contained) continue;
    kept.push(cand);
  }
  return kept;
}

/**
 * Re-export the gate for callers that already hold a DetectionResult (used by
 * tests and any future path that wraps the raw Adapter result).
 */
export function isSafeWritingBlockDetection(
  result: DetectionResult,
  adapter: ChatGptAdapter,
): boolean {
  if (!result.found) return false;
  if (result.confidence !== "high" && result.confidence !== "medium")
    return false;
  return (
    result.elements.length > 0 &&
    result.elements.every((el) => el != null && isSafeWritingBlock(el, adapter))
  );
}
