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
    return runTarget("conversationContainer", document);
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
    const container = runTarget("conversationContainer", document);
    if (!container.found) return container;
    return runTarget("userTurn", container.element ?? document);
  }

  detectAssistantTurns(): DetectionResult {
    const container = runTarget("conversationContainer", document);
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
