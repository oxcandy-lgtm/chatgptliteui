import type { Confidence } from "../shared/types.js";

/**
 * Selector strategies for locating ChatGPT UI structures.
 *
 * IMPORTANT: ChatGPT's DOM is not a stable public contract. We therefore avoid
 * guessed broad selectors such as `.flex.flex-col.gap`. Each target has
 * multiple ordered strategies, and every strategy declares:
 *  - the query itself (preferring semantic attributes);
 *  - expected match cardinality;
 *  - whether visibility is required;
 *  - structural invariants to check;
 *  - ambiguity detection (multiple incompatible matches are NOT silently
 *    collapsed to the first match).
 *
 * If no strategy passes its invariants, the Adapter reports `found: false` and
 * downstream code keeps the official ChatGPT UI intact (fail-open for the
 * page, fail-closed for data).
 */

export type SelectorTarget =
  | "conversationContainer"
  | "conversationColumn"
  | "userTurn"
  | "assistantTurn"
  | "sidebar"
  | "composer"
  | "generatingIndicator"
  | "codeBlock"
  | "writingBlock"
  | "originalCopyButton";

export interface SelectorStrategy {
  /** Stable identifier for diagnostics. */
  id: string;
  /** Where to run the query. */
  root: "document" | "container";
  /** CSS selector, preferring semantic attributes. */
  selector: string;
  /** Expected number of matches. */
  cardinality: "single" | "multiple";
  /** Whether a matched element must be visible. */
  requireVisible: boolean;
  /** Minimum confidence assigned when invariants pass. */
  confidence: Exclude<Confidence, "unknown">;
}

/** Shared visibility helper.
 *
 * Note: in a real browser this also considers layout (bounding rect). In a
 * non-layout test environment (jsdom) the bounding rect is always zero, so we
 * base visibility on computed style only. That is sufficient for the Adapter's
 * ambiguity and confidence decisions.
 */
export function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0"
  );
}

/**
 * Ambiguity check: if a "single" strategy matches multiple incompatible
 * elements (e.g. more than one distinct sidebar), we refuse to guess and
 * return no match. Only structurally identical repeats (e.g. multiple turns)
 * are acceptable for `multiple` targets.
 */
export function resolveStrategy(
  _target: SelectorTarget,
  strategy: SelectorStrategy,
  root: ParentNode,
): HTMLElement[] {
  const all = Array.from(
    root.querySelectorAll(strategy.selector),
  ) as HTMLElement[];
  const matches = all.filter((n) => n != null);

  if (matches.length === 0) return [];

  if (strategy.requireVisible) {
    const visible = matches.filter(isVisible);
    if (visible.length === 0) return [];
    if (strategy.cardinality === "single" && visible.length > 1) {
      // Ambiguous: more than one visible candidate for a single-target query.
      return [];
    }
    return visible;
  }

  if (strategy.cardinality === "single" && matches.length > 1) {
    return [];
  }
  return matches;
}

export const STRATEGIES: Record<SelectorTarget, SelectorStrategy[]> = {
  conversationContainer: [
    {
      id: "role-main",
      root: "document",
      selector: '[role="main"]',
      cardinality: "single",
      requireVisible: true,
      confidence: "high",
    },
    {
      id: "data-testid-thread",
      root: "document",
      selector: '[data-testid="thread"]',
      cardinality: "single",
      requireVisible: true,
      confidence: "high",
    },
    {
      id: "aria-label-conversation",
      root: "document",
      selector: '[aria-label*="conversation" i]',
      cardinality: "single",
      requireVisible: true,
      confidence: "medium",
    },
  ],
  conversationColumn: [
    {
      id: "thread-column-semantic",
      root: "document",
      // Semantic, single, visible column that holds the conversation content.
      selector: '[data-testid="thread"] > [role="presentation"], main [class*="thread"] > div',
      cardinality: "single",
      requireVisible: true,
      confidence: "medium",
    },
    {
      id: "role-main-inner",
      root: "document",
      // The primary inner content wrapper of the conversation main region.
      selector: '[role="main"] > div',
      cardinality: "single",
      requireVisible: true,
      confidence: "low",
    },
  ],
  userTurn: [
    {
      id: "data-testid-user",
      root: "container",
      selector: '[data-testid="user-message"]',
      cardinality: "multiple",
      requireVisible: false,
      confidence: "high",
    },
    {
      id: "role-note-user",
      root: "container",
      selector: '[data-message-author-role="user"]',
      cardinality: "multiple",
      requireVisible: false,
      confidence: "high",
    },
  ],
  assistantTurn: [
    {
      id: "data-testid-assistant",
      root: "container",
      selector: '[data-testid="assistant-message"]',
      cardinality: "multiple",
      requireVisible: false,
      confidence: "high",
    },
    {
      id: "role-note-assistant",
      root: "container",
      selector: '[data-message-author-role="assistant"]',
      cardinality: "multiple",
      requireVisible: false,
      confidence: "high",
    },
  ],
  sidebar: [
    {
      id: "nav-history",
      root: "document",
      selector: 'nav[aria-label*="chat history" i]',
      cardinality: "single",
      requireVisible: false,
      confidence: "high",
    },
    {
      id: "data-testid-sidebar",
      root: "document",
      selector: '[data-testid="sidebar"]',
      cardinality: "single",
      requireVisible: false,
      confidence: "medium",
    },
  ],
  composer: [
    {
      id: "role-textbox-composer",
      root: "document",
      selector: '#prompt-textarea, form textarea, [contenteditable][role="textbox"]',
      cardinality: "single",
      requireVisible: false,
      confidence: "high",
    },
  ],
  generatingIndicator: [
    {
      id: "stop-button",
      root: "document",
      selector: 'button[aria-label*="Stop" i], button[data-testid="stop-button"]',
      cardinality: "single",
      requireVisible: true,
      confidence: "high",
    },
  ],
  codeBlock: [
    {
      id: "pre-code",
      root: "container",
      selector: "pre > code, pre code",
      cardinality: "multiple",
      requireVisible: false,
      confidence: "medium",
    },
  ],
  writingBlock: [
    {
      id: "writing-block-heuristic",
      root: "container",
      selector: '[data-message-author-role="assistant"] [data-testid="text-block"], [data-message-author-role="assistant"] p',
      cardinality: "multiple",
      requireVisible: false,
      confidence: "low",
    },
  ],
  originalCopyButton: [
    {
      id: "copy-action",
      root: "container",
      selector: 'button[aria-label*="copy" i], button[data-testid*="copy" i]',
      cardinality: "single",
      requireVisible: false,
      confidence: "medium",
    },
  ],
};
