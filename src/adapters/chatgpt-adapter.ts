import type { SelectorTarget } from "./selectors.js";
import {
  STRATEGIES,
  resolveStrategy,
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
    return runTarget("writingBlock", container);
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
