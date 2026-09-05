import type { SelectorTarget } from "./selectors.js";
import {
  STRATEGIES,
  resolveStrategy,
  isVisible,
  type SelectorStrategy,
} from "./selectors.js";
import {
  makeResult,
  notFound,
  type DetectionResult,
} from "./detection-result.js";

/**
 * Structural conversation-container fallback.
 *
 * ChatGPT's current shell no longer reliably exposes `[role="main"]`,
 * `[data-testid="thread"]`, or a conversation `aria-label`. The stable
 * contract is the message-author structure itself, so when every explicit
 * container selector fails we infer the conversation region as the DEEPEST
 * COMMON HTMLElement ancestor of the live role-turn anchors:
 *
 *   [data-message-author-role="user"]      (at least one required)
 *   [data-message-author-role="assistant"] (at least one required)
 *
 * Fail-closed rules: no anchors on one side, common ancestor disconnected /
 * not an HTMLElement / equal to html or body / an extension-owned host, or
 * any ambiguity => NOT FOUND. This is structural scoping only — it never
 * mutates the page and grants no destructive authority.
 */

/** User/Assistant turn anchors: the only semantic input to the fallback. */
const USER_TURN_ANCHOR_SELECTOR = '[data-message-author-role="user"]';
const ASSISTANT_TURN_ANCHOR_SELECTOR = '[data-message-author-role="assistant"]';

/** Extension-owned hosts must never become or contain the inferred root. */
const EXTENSION_HOST_SELECTOR =
  '[data-cgl-sidebar-host="true"], [data-cgl-writing-copy-host="true"], #cgl-sidebar-control-host';

export interface ConversationContainerFallbackDiagnostic {
  attempted: boolean;
  found: boolean;
  strategyId: "role-turn-common-ancestor" | null;
  confidence: "medium" | null;
  userAnchorCount: number;
  assistantAnchorCount: number;
  /** Tag of the accepted deepest common ancestor (structure only). */
  commonAncestorTag: string | null;
  accepted: boolean;
  rejectionReason:
    | null
    | "NOT_ATTEMPTED_EXPLICIT_STRATEGY_SUCCEEDED"
    | "NO_USER_ANCHOR"
    | "NO_ASSISTANT_ANCHOR"
    | "NO_CONNECTED_ANCHORS"
    | "COMMON_ANCESTOR_NOT_HTML_ELEMENT"
    | "COMMON_ANCESTOR_NOT_CONNECTED"
    | "COMMON_ANCESTOR_IS_BODY_OR_HTML"
    | "COMMON_ANCESTOR_IS_EXTENSION_HOST"
    | "ANCHORS_NOT_CONTAINED"
    | "AMBIGUOUS_STRUCTURE";
}

export const FALLBACK_STRATEGY_ID = "role-turn-common-ancestor" as const;

/**
 * Infer the conversation container from role-turn anchors. Returns the
 * DetectionResult AND the exact diagnostic for X-Ray. Pure observation — no
 * DOM mutation. Fail-closed in every ambiguous case.
 */
export function inferConversationContainerFromTurnAnchors(): {
  result: DetectionResult;
  diagnostic: ConversationContainerFallbackDiagnostic;
} {
  const base: ConversationContainerFallbackDiagnostic = {
    attempted: true,
    found: false,
    strategyId: FALLBACK_STRATEGY_ID,
    confidence: "medium",
    userAnchorCount: 0,
    assistantAnchorCount: 0,
    commonAncestorTag: null,
    accepted: false,
    rejectionReason: null,
  };

  const users = Array.from(
    document.querySelectorAll<HTMLElement>(USER_TURN_ANCHOR_SELECTOR),
  ).filter((el) => el.isConnected);
  const assistants = Array.from(
    document.querySelectorAll<HTMLElement>(ASSISTANT_TURN_ANCHOR_SELECTOR),
  ).filter((el) => el.isConnected);
  const diag: ConversationContainerFallbackDiagnostic = {
    ...base,
    userAnchorCount: users.length,
    assistantAnchorCount: assistants.length,
  };

  // Both sides are REQUIRED (one-sided structure is not a conversation).
  if (users.length === 0) {
    return { result: notFound(FALLBACK_STRATEGY_ID, "no connected user turn anchor"), diagnostic: { ...diag, rejectionReason: "NO_USER_ANCHOR" } };
  }
  if (assistants.length === 0) {
    return { result: notFound(FALLBACK_STRATEGY_ID, "no connected assistant turn anchor"), diagnostic: { ...diag, rejectionReason: "NO_ASSISTANT_ANCHOR" } };
  }

  const anchors = [...users, ...assistants];
  const lca = deepestCommonHTMLElementAncestor(anchors);
  if (!lca) {
    return {
      result: notFound(FALLBACK_STRATEGY_ID, "no common HTMLElement ancestor"),
      diagnostic: { ...diag, rejectionReason: "NO_CONNECTED_ANCHORS" },
    };
  }
  if (!(lca instanceof HTMLElement)) {
    return {
      result: notFound(FALLBACK_STRATEGY_ID, "common ancestor is not an HTMLElement"),
      diagnostic: { ...diag, rejectionReason: "COMMON_ANCESTOR_NOT_HTML_ELEMENT" },
    };
  }
  if (!lca.isConnected) {
    return {
      result: notFound(FALLBACK_STRATEGY_ID, "common ancestor is disconnected"),
      diagnostic: { ...diag, rejectionReason: "COMMON_ANCESTOR_NOT_CONNECTED" },
    };
  }
  const tag = lca.tagName.toLowerCase();
  if (tag === "html" || tag === "body") {
    return {
      result: notFound(
        FALLBACK_STRATEGY_ID,
        "common ancestor degenerated to body/html — fail closed",
      ),
      diagnostic: { ...diag, rejectionReason: "COMMON_ANCESTOR_IS_BODY_OR_HTML" },
    };
  }
  if (lca.closest(EXTENSION_HOST_SELECTOR)) {
    return {
      result: notFound(FALLBACK_STRATEGY_ID, "common ancestor is extension-owned"),
      diagnostic: { ...diag, rejectionReason: "COMMON_ANCESTOR_IS_EXTENSION_HOST" },
    };
  }
  // Every anchor MUST be contained by the accepted root (containment check).
  for (const anchor of anchors) {
    if (!lca.contains(anchor)) {
      return {
        result: notFound(FALLBACK_STRATEGY_ID, "anchor not contained by common ancestor"),
        diagnostic: { ...diag, rejectionReason: "ANCHORS_NOT_CONTAINED" },
      };
    }
  }
  // Ambiguity guard: the LCA of ONLY user anchors and ONLY assistant anchors
  // must both be contained by the accepted root; otherwise the structure
  // spans unrelated branches in a way we refuse to guess about.
  const usersLca = deepestCommonHTMLElementAncestor(users);
  const assistantsLca = deepestCommonHTMLElementAncestor(assistants);
  if (
    (usersLca && !lca.contains(usersLca)) ||
    (assistantsLca && !lca.contains(assistantsLca))
  ) {
    return {
      result: notFound(FALLBACK_STRATEGY_ID, "ambiguous anchor topology"),
      diagnostic: { ...diag, rejectionReason: "AMBIGUOUS_STRUCTURE" },
    };
  }

  diag.found = true;
  diag.commonAncestorTag = tag;
  diag.accepted = true;
  return {
    result: makeResult({
      element: lca,
      elements: [lca],
      confidence: "medium",
      strategy: FALLBACK_STRATEGY_ID,
      reason: `structural inference from ${users.length} user + ${assistants.length} assistant role turns`,
    }),
    diagnostic: diag,
  };
}

/**
 * Structural WritingBlock editor fallback.
 *
 * Current ChatGPT renders some Assistant writing content inside a markdown /
 * prose editor surface (`contenteditable="true"`), fronted by an explicit
 * WritingBlock-specific header action. The stable contract is therefore the
 * SEMANTIC HEADER ANCHOR plus its uniquely associated editable editor:
 *
 *   button[data-testid="writing-block-header-magic-edit-button"]
 *   + the DEEPEST structural ancestor region that contains the anchor and
 *     EXACTLY ONE eligible editor ([contenteditable="true"])
 *   + both confined to one Assistant turn.
 *
 * Fail-closed rules: anchors outside any Assistant turn, regions with more
 * than one eligible editor (ambiguous), generic contenteditable surfaces
 * WITHOUT such an anchor, and anything inside dialogs/sidebars/extension
 * hosts => NOT FOUND. The EDITOR element (the actual text payload) is the
 * canonical candidate — never the outer wrapper, whose text would include
 * header labels and toolbar controls. Pure observation; never mutates the
 * page and grants no destructive authority.
 */

/** WritingBlock-specific semantic header anchor. */
export const WRITING_HEADER_ANCHOR_SELECTOR =
  'button[data-testid="writing-block-header-magic-edit-button"]';

/** Canonical editable editor surface of a WritingBlock. */
const WRITING_EDITOR_SELECTOR = '[contenteditable="true"]';

/** Forbidden ancestor surfaces for anchors, editors, and regions. */
const WRITING_FORBIDDEN_ANCESTOR_SELECTOR =
  '[role="dialog"], dialog, [aria-modal="true"], [data-testid="sidebar"], nav[aria-label*="chat history" i], [data-cgl-sidebar-host="true"], [data-cgl-writing-copy-host="true"], #cgl-sidebar-control-host';

const ASSISTANT_TURN_SELECTOR =
  '[data-message-author-role="assistant"], [data-testid="assistant-message"]';

export const WRITING_FALLBACK_STRATEGY_ID = "writing-block-editor-anchored" as const;

export interface WritingBlockEditorFallbackDiagnostic {
  attempted: boolean;
  found: boolean;
  strategyId: typeof WRITING_FALLBACK_STRATEGY_ID | null;
  confidence: "high" | null;
  assistantTurnsScanned: number;
  headerAnchorCount: number;
  contentEditableCount: number;
  /** Anchor→editor structural pairs resolved before gate evaluation. */
  pairCount: number;
  /** Pairs whose editor the PRODUCTION gate evaluator accepts. */
  acceptedEditorCount: number;
  /** Anchors whose upward walk hit a multi-editor region (fail closed). */
  ambiguousCount: number;
  rejectionReason:
    | null
    | "NOT_ATTEMPTED_EXPLICIT_STRATEGY_SUCCEEDED"
    | "NO_CONNECTED_ASSISTANT_TURN"
    | "NO_HEADER_ANCHOR"
    | "NO_ELIGIBLE_EDITOR"
    | "AMBIGUOUS_PAIRING"
    | "PAIRING_FAILED";
}

/**
 * Pair every WritingBlock header anchor in `container` with its unique
 * associated contenteditable editor. Returns the DetectionResult AND the
 * exact diagnostic for X-Ray. Pure observation — no DOM mutation. Fail-closed
 * in every ambiguous case; supports multiple WritingBlocks per turn.
 */
export function inferWritingBlocksFromEditorAnchors(container: ParentNode): {
  result: DetectionResult;
  diagnostic: WritingBlockEditorFallbackDiagnostic;
} {
  const base: WritingBlockEditorFallbackDiagnostic = {
    attempted: true,
    found: false,
    strategyId: WRITING_FALLBACK_STRATEGY_ID,
    confidence: "high",
    assistantTurnsScanned: 0,
    headerAnchorCount: 0,
    contentEditableCount: 0,
    pairCount: 0,
    acceptedEditorCount: 0,
    ambiguousCount: 0,
    rejectionReason: null,
  };

  const finishNotFound = (
    reason: NonNullable<WritingBlockEditorFallbackDiagnostic["rejectionReason"]>,
  ): { result: DetectionResult; diagnostic: WritingBlockEditorFallbackDiagnostic } => ({
    result: notFound(WRITING_FALLBACK_STRATEGY_ID, reason),
    diagnostic: { ...base, rejectionReason: reason },
  });

  const turns = Array.from(
    container.querySelectorAll<HTMLElement>(ASSISTANT_TURN_SELECTOR),
  ).filter((el) => el.isConnected);
  if (turns.length === 0) return finishNotFound("NO_CONNECTED_ASSISTANT_TURN");

  const eligibleEditorsIn = (scope: ParentNode): HTMLElement[] =>
    Array.from(
      scope.querySelectorAll<HTMLElement>(WRITING_EDITOR_SELECTOR),
    ).filter(
      (el) =>
        el.isConnected &&
        el instanceof HTMLElement &&
        el.getAttribute("contenteditable") === "true" &&
        isVisible(el) &&
        !el.closest(WRITING_FORBIDDEN_ANCESTOR_SELECTOR) &&
        (() => {
          const ownerTurn = el.closest(ASSISTANT_TURN_SELECTOR);
          return ownerTurn != null && turns.includes(ownerTurn as HTMLElement);
        })(),
    );

  let ambiguousCount = 0;
  const pairedEditors = new Set<HTMLElement>();
  let headerAnchorCount = 0;

  for (const turn of turns) {
    const anchors = Array.from(
      turn.querySelectorAll<HTMLElement>(WRITING_HEADER_ANCHOR_SELECTOR),
    ).filter((el) => el.isConnected);
    headerAnchorCount += anchors.length;
    const turnEditors = eligibleEditorsIn(turn);

    for (const anchor of anchors) {
      // Walk upward from the anchor toward — but not beyond — its owning
      // Assistant turn, looking for the DEEPEST region holding EXACTLY ONE
      // eligible editor. Once a level holds more than one, every higher
      // level holds at least as many: fail closed instead of guessing.
      let region: HTMLElement | null = anchor.parentElement;
      while (region && region !== turn.parentElement) {
        const editorsHere = turnEditors.filter((e) => region!.contains(e));
        if (editorsHere.length > 1) {
          ambiguousCount++;
          break;
        }
        if (editorsHere.length === 1) {
          pairedEditors.add(editorsHere[0]!);
          break;
        }
        region = region.parentElement;
      }
    }
  }

  const diag: WritingBlockEditorFallbackDiagnostic = {
    ...base,
    assistantTurnsScanned: turns.length,
    headerAnchorCount,
    contentEditableCount: eligibleEditorsIn(container).length,
    pairCount: pairedEditors.size,
    ambiguousCount,
  };

  if (pairedEditors.size === 0) {
    const reason = ambiguousCount > 0
      ? "AMBIGUOUS_PAIRING"
      : headerAnchorCount === 0
        ? "NO_HEADER_ANCHOR"
        : diag.contentEditableCount === 0
          ? "NO_ELIGIBLE_EDITOR"
          : "PAIRING_FAILED";
    return {
      result: notFound(WRITING_FALLBACK_STRATEGY_ID, reason),
      diagnostic: { ...diag, rejectionReason: reason },
    };
  }

  // Deterministic DOM order for the canonical editors.
  const editors = [...pairedEditors].sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  diag.found = true;
  return {
    result: makeResult({
      element: editors[0] ?? null,
      elements: editors,
      confidence: "high",
      strategy: WRITING_FALLBACK_STRATEGY_ID,
      reason: `structural pairing of ${headerAnchorCount} writing header anchor(s) to ${editors.length} unique editable editor(s)`,
    }),
    diagnostic: diag,
  };
}

/**
 * Deepest common HTMLElement ancestor of the given elements, or null. Only
 * HTMLElement ancestors are considered (document/html excluded by callers'
 * tag checks where required).
 */
function deepestCommonHTMLElementAncestor(
  elements: HTMLElement[],
): HTMLElement | null {
  if (elements.length === 0) return null;
  let candidate: HTMLElement | null = elements[0] ?? null;
  for (let i = 1; i < elements.length; i++) {
    const next = elements[i];
    if (!next || !candidate) return null;
    while (candidate && !candidate.contains(next)) {
      candidate = candidate.parentElement;
      if (!candidate || candidate === document.documentElement) break;
      if (!(candidate instanceof HTMLElement)) return null;
    }
    if (!candidate) return null;
  }
  return candidate instanceof HTMLElement ? candidate : null;
}

/**
 * ChatGptAdapter provides non-destructive discovery of ChatGPT UI structures.
 *
 * Phase 0 scope: the Adapter only observes. It never hides, removes, wraps, or
 * mutates page elements. Destructive operations (e.g. history hiding) are
 * explicitly out of scope and, when added later, MUST require high-confidence
 * detection plus extra safety invariants.
 */
export interface ChatGptAdapter {
  detectConversationContainer(): DetectionResult;
  detectConversationColumn(): DetectionResult;
  detectSidebar(): DetectionResult;
  detectComposer(): DetectionResult;
  detectGeneratingIndicator(): DetectionResult;
  detectUserTurns(): DetectionResult;
  detectAssistantTurns(): DetectionResult;
  detectCodeBlocks(container: ParentNode): DetectionResult;
  detectWritingBlocks(container: ParentNode): DetectionResult;
  detectOriginalCopyButton(container: ParentNode): DetectionResult;
  /** Re-run discovery from scratch. Safe to call on route changes. */
  refresh(): void;
}

function runTarget(
  target: SelectorTarget,
  root: ParentNode,
): DetectionResult {
  const strategies = STRATEGIES[target];
  for (const strategy of strategies) {
    const matches = resolveStrategy(target, strategy, root);
    if (matches.length > 0) {
      return makeResult({
        element: matches[0] ?? null,
        elements: matches,
        confidence: strategy.confidence,
        strategy: strategy.id,
        reason: `matched ${matches.length} element(s) via ${strategy.id}`,
      });
    }
  }
  return notFound(target, "no strategy produced a valid match");
}

export class DefaultChatGptAdapter implements ChatGptAdapter {
  detectConversationContainer(): DetectionResult {
    // 1) Existing explicit selector strategies keep priority, unchanged.
    const explicit = runTarget("conversationContainer", document);
    if (explicit.found) return explicit;
    // 2) Structural inference from role-turn anchors (fail-closed).
    return inferConversationContainerFromTurnAnchors().result;
  }

  detectConversationColumn(): DetectionResult {
    // Conversation column detection requires ambiguity refusal: if the
    // strategy is ambiguous we keep the official UI untouched.
    return runTarget("conversationColumn", document);
  }

  detectSidebar(): DetectionResult {
    return runTarget("sidebar", document);
  }

  detectComposer(): DetectionResult {
    return runTarget("composer", document);
  }

  detectGeneratingIndicator(): DetectionResult {
    return runTarget("generatingIndicator", document);
  }

  detectUserTurns(): DetectionResult {
    // One Adapter authority: reuse detectConversationContainer (explicit
    // strategies first, structural fallback second) for scoping.
    const container = this.detectConversationContainer();
    if (!container.found) return container;
    return runTarget("userTurn", container.element ?? document);
  }

  detectAssistantTurns(): DetectionResult {
    const container = this.detectConversationContainer();
    if (!container.found) return container;
    return runTarget("assistantTurn", container.element ?? document);
  }

  detectCodeBlocks(container: ParentNode): DetectionResult {
    return runTarget("codeBlock", container);
  }

  detectWritingBlocks(container: ParentNode): DetectionResult {
    // 1) Existing explicit HIGH/MEDIUM strategies keep priority, unchanged.
    const strategies = STRATEGIES.writingBlock;
    const highMedium = strategies.filter((s) => s.confidence !== "low");
    for (const strategy of highMedium) {
      const matches = resolveStrategy("writingBlock", strategy, container);
      if (matches.length > 0) {
        return makeResult({
          element: matches[0] ?? null,
          elements: matches,
          confidence: strategy.confidence,
          strategy: strategy.id,
          reason: `matched ${matches.length} element(s) via ${strategy.id}`,
        });
      }
    }
    // 2) Structural WritingBlock editor fallback (fail-closed).
    return inferWritingBlocksFromEditorAnchors(container).result;
    // 3) The LOW bare-paragraph strategy is deliberately NOT run here. It is
    //    diagnostic-only and must never block the structural fallback above.
  }

  detectOriginalCopyButton(container: ParentNode): DetectionResult {
    return runTarget("originalCopyButton", container);
  }

  refresh(): void {
    // Phase 0: nothing to cache. Discovery is stateless per call.
  }
}

export function createAdapter(): ChatGptAdapter {
  return new DefaultChatGptAdapter();
}

export type { SelectorStrategy };
