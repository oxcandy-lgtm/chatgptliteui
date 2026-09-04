/**
 * CGL X-Ray — live structural scan engine.
 *
 * Runs EVERY current Adapter selector strategy individually (never silently
 * collapsing to the winner), evaluates every raw writing-block candidate
 * through the production gate evaluator to obtain EXACT rejection reasons,
 * and inventories editable surfaces and action controls inside Assistant
 * turns.
 *
 * Output is STRUCTURE ONLY: counts, tags, roles, testids, rects. No chat
 * text, no input values, no innerHTML, no conversation tokens, no URLs.
 */

import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import type { Confidence } from "../../shared/types.js";
import {
  STRATEGIES,
  resolveStrategy,
  isVisible,
  type SelectorTarget,
  type SelectorStrategy,
} from "../../adapters/selectors.js";
import {
  evaluateWritingBlockCandidate,
  type WritingBlockRejectionReason,
} from "../writing-copy/writing-copy-detection.js";
import { conversationTokenFromLocation } from "../writing-copy/block-identity.js";
import { isHighlightApiAvailable } from "../writing-copy/writing-copy-visual-state.js";
import {
  inferConversationContainerFromTurnAnchors,
  inferWritingBlocksFromEditorAnchors,
  FALLBACK_STRATEGY_ID,
  WRITING_FALLBACK_STRATEGY_ID,
  type ConversationContainerFallbackDiagnostic,
  type WritingBlockEditorFallbackDiagnostic,
} from "../../adapters/chatgpt-adapter.js";
import { nodeSignature, type NodeSignature } from "./xray-signature.js";
import {
  isRuntimeOk,
  snapshotRuntimeHealth,
  type RuntimeHealthSnapshot,
} from "../../shared/runtime-health.js";
import type {
  WritingCopyControllerReceipt,
  CopyTransactionReceipt,
} from "../writing-copy/writing-copy-controller.js";
import type { FoldingReceipt } from "../folding/folding-controller.js";

/** All SelectorTargets probed by the scan, in stable report order. */
const PROBED_TARGETS: SelectorTarget[] = [
  "conversationContainer",
  "conversationColumn",
  "userTurn",
  "assistantTurn",
  "composer",
  "generatingIndicator",
  "codeBlock",
  "writingBlock",
  "originalCopyButton",
  "sidebar",
];

/** Per-strategy probe result (one entry per configured strategy). */
export interface StrategyProbe {
  target: SelectorTarget;
  strategyId: string;
  selector: string;
  configuredConfidence: Confidence;
  root: "document" | "container";
  totalMatches: number;
  connectedMatches: number;
  visibleMatches: number;
}

/** One raw writing-block candidate with its exact gate verdict. */
export interface WritingCandidateDiagnostic {
  index: number;
  strategyId: string;
  confidence: Confidence;
  sig: NodeSignature;
  accepted: boolean;
  reasons: WritingBlockRejectionReason[];
  /** Nearest Assistant turn index within the conversation container, -1 if none. */
  turnIndex: number;
}

/** Editable/action surface found inside an Assistant turn. */
export interface TurnSurfaceInfo {
  kind: "editable" | "action" | "toolbar";
  sig: NodeSignature;
  turnIndex: number;
  /** Nearest raw writing candidate index, -1 when not inside a candidate. */
  candidateIndex: number;
}

/** Conversation identity / route shape (never the raw token or URL). */
export interface RouteInfo {
  /** Coarse route shape: "conversation" | "home" | "other". */
  shape: string;
  /** Whether a `/c/<token>` conversation identity is currently available. */
  conversationIdentityAvailable: boolean;
}

/** Runtime state observed by X-Ray. */
export interface RuntimeState {
  extensionRuntimeOk: boolean;
  extensionEnabled: boolean;
  writingCopyEnabled: boolean;
  highlightApiSupported: boolean;
  copiedRangeCount: number | null;
  generatingIndicatorPresent: boolean;
  extensionCopyHostCount: number;
  semanticCopiedCount: number;
  semanticUncopiedCount: number;
  editableRegionCount: number;
  actionControlCount: number;
  route: RouteInfo;
}

/** Complete live structural scan. */
export interface XrayScan {
  strategies: StrategyProbe[];
  conversationContainerFound: boolean;
  /** Which container strategy won (explicit selector id or the fallback id). */
  conversationContainerStrategyId: string | null;
  /**
   * Structural role-turn-common-ancestor fallback diagnostics. `attempted`
   * is false when an explicit strategy succeeded.
   */
  containerFallback: ConversationContainerFallbackDiagnostic & {
    attempted: boolean;
  };
  /**
   * Structural writing-block-editor-anchored fallback receipt. `attempted`
   * is false when an explicit high/medium writing strategy matched.
   */
  writingBlockFallback: WritingBlockEditorFallbackDiagnostic & {
    attempted: boolean;
  };
  assistantTurnCount: number;
  userTurnCount: number;
  writingPipeline: {
    rawCandidateCount: number;
    safeCount: number;
    rejectedCount: number;
    rejections: Record<string, number>;
    candidates: WritingCandidateDiagnostic[];
  };
  editableRegions: TurnSurfaceInfo[];
  actions: TurnSurfaceInfo[];
  runtime: RuntimeState;
  /** Health-authority snapshot (identity, context validity, error bus). */
  runtimeHealth: RuntimeHealthSnapshot;
  /** Copy-host pipeline receipt (null when no controller is wired). */
  writingCopyController: WritingCopyControllerReceipt | null;
  /** Last copy click transaction (null when no controller/attempt). */
  copyTransaction: CopyTransactionReceipt | null;
  /** Folding HUD receipt (null when no controller is wired). */
  folding: FoldingReceipt | null;
}

/** Count live ranges held by the extension's copied-marker Highlight. */
function copiedRangeCount(): number | null {
  const g = globalThis as unknown as {
    CSS?: { highlights?: { get(name: string): unknown } };
  };
  const highlight = g.CSS?.highlights?.get("cgl-copied");
  if (highlight == null) return null;
  try {
    const setLike = highlight as Iterable<unknown> & { size?: number };
    if (typeof setLike.size === "number") return setLike.size;
    let n = 0;
    for (const _r of setLike) {
      n++;
      if (n > 10000) break; // bound paranoia
    }
    return n;
  } catch {
    return null;
  }
}

/** Coarse route shape without leaking the conversation token. */
function routeInfo(): RouteInfo {
  const token = conversationTokenFromLocation();
  let shape = "other";
  try {
    const path = new URL(window.location.href).pathname;
    if (token) shape = "conversation";
    else if (path === "/" || path === "") shape = "home";
  } catch {
    shape = "other";
  }
  return { shape, conversationIdentityAvailable: token != null };
}

/** Assistant-turn index of an element within the container, or -1. */
function assistantTurnIndex(
  container: ParentNode,
  el: Element,
): number {
  const turns = Array.from(
    container.querySelectorAll(
      '[data-message-author-role="assistant"], [data-testid="assistant-message"]',
    ),
  );
  let cur: Element | null = el;
  while (cur) {
    const idx = turns.indexOf(cur);
    if (idx >= 0) return idx;
    cur = cur.parentElement;
  }
  return -1;
}

/** Probe one strategy and return structural counts only. */
function probeStrategy(
  target: SelectorTarget,
  strategy: SelectorStrategy,
  containerRoot: ParentNode,
): StrategyProbe {
  const root: ParentNode = strategy.root === "container" ? containerRoot : document;
  const matches = resolveStrategy(target, strategy, root);
  const connected = matches.filter((m) => m.isConnected);
  const visible = matches.filter((m) => isVisible(m));
  return {
    target,
    strategyId: strategy.id,
    selector: strategy.selector,
    configuredConfidence: strategy.confidence,
    root: strategy.root,
    totalMatches: matches.length,
    connectedMatches: connected.length,
    visibleMatches: visible.length,
  };
}

/** Editable/action selector inventory run inside each Assistant turn. */
const EDITABLE_SELECTOR = [
  "[contenteditable]",
  '[role="textbox"]',
  "textarea",
].join(", ");

const ACTION_SELECTOR = 'button, [role="button"], a[href]';

/** Collect editable regions + action controls inside every Assistant turn. */
function collectTurnSurfaces(
  container: ParentNode,
  rawCandidates: { element: Element; strategyId: string }[],
): { editable: TurnSurfaceInfo[]; actions: TurnSurfaceInfo[] } {
  const editable: TurnSurfaceInfo[] = [];
  const actions: TurnSurfaceInfo[] = [];
  const turns = Array.from(
    container.querySelectorAll(
      '[data-message-author-role="assistant"], [data-testid="assistant-message"]',
    ),
  );

  const candidateIndexOf = (el: Element): number => {
    for (let i = 0; i < rawCandidates.length; i++) {
      const c = rawCandidates[i];
      if (c && (c.element === el || c.element.contains(el))) return i;
    }
    return -1;
  };

  turns.forEach((turn, turnIndex) => {
    // Editable surfaces.
    for (const el of Array.from(turn.querySelectorAll(EDITABLE_SELECTOR))) {
      editable.push({
        kind: "editable",
        sig: nodeSignature(el),
        turnIndex,
        candidateIndex: candidateIndexOf(el),
      });
    }
    // Action controls (bounded per turn to keep scans safe).
    const seenToolbars = new Set<Element>();
    for (const el of Array.from(turn.querySelectorAll(ACTION_SELECTOR)).slice(0, 60)) {
      actions.push({
        kind: "action",
        sig: nodeSignature(el),
        turnIndex,
        candidateIndex: candidateIndexOf(el),
      });
      // The action toolbar: nearest structural ancestor that groups controls.
      const parent = el.parentElement;
      if (parent && parent.childElementCount > 1 && !seenToolbars.has(parent)) {
        seenToolbars.add(parent);
        actions.push({
          kind: "toolbar",
          sig: nodeSignature(parent),
          turnIndex,
          candidateIndex: candidateIndexOf(parent),
        });
      }
      if (actions.length > 400) return; // hard bound
    }
  });

  return { editable, actions };
}

/**
 * Run the complete X-Ray structural scan. Pure observation: never mutates
 * the page.
 *
 * `controller` is the live Writing Copy controller receipt (pass null when
 * no controller exists, e.g. unit tests).
 */
export function runXrayScan(
  adapter: ChatGptAdapter,
  settings: { enabled: boolean; writingCopyEnabled: boolean },
  controller: WritingCopyControllerReceipt | null = null,
  copyTransaction: CopyTransactionReceipt | null = null,
  folding: FoldingReceipt | null = null,
): XrayScan {
  const containerResult = adapter.detectConversationContainer();
  const containerRoot: ParentNode = containerResult.element ?? document;

  // Container-fallback visibility: report exactly what happened. When an
  // explicit selector strategy won, the structural fallback was NOT
  // attempted; otherwise surface its full fail-closed diagnostic.
  let containerFallback: XrayScan["containerFallback"];
  if (containerResult.found && containerResult.strategy !== FALLBACK_STRATEGY_ID) {
    containerFallback = {
      attempted: false,
      found: false,
      strategyId: null,
      confidence: null,
      userAnchorCount: 0,
      assistantAnchorCount: 0,
      commonAncestorTag: null,
      accepted: false,
      rejectionReason: "NOT_ATTEMPTED_EXPLICIT_STRATEGY_SUCCEEDED",
    };
  } else {
    containerFallback = inferConversationContainerFromTurnAnchors().diagnostic;
  }

  // 1. Probe EVERY strategy of EVERY target individually.
  const strategies: StrategyProbe[] = [];
  for (const target of PROBED_TARGETS) {
    for (const strategy of STRATEGIES[target]) {
      strategies.push(probeStrategy(target, strategy, containerRoot));
    }
  }

  // 2. Turn counts.
  const assistantTurns = containerRoot.querySelectorAll(
    '[data-message-author-role="assistant"], [data-testid="assistant-message"]',
  );
  const userTurns = containerRoot.querySelectorAll(
    '[data-message-author-role="user"], [data-testid="user-message"]',
  );

  // 3. Raw writing candidates: UNION of all writing strategies, tagged with
  //    the first strategy that matched them, in DOM order — plus the
  //    structural anchored editors EXACTLY when production detection used
  //    the fallback (explicit high/medium strategies matched nothing).
  const writingDetection = adapter.detectWritingBlocks(containerRoot);
  const usedExplicitWritingStrategy =
    writingDetection.found &&
    writingDetection.strategy !== WRITING_FALLBACK_STRATEGY_ID;
  let writingBlockFallback: XrayScan["writingBlockFallback"];
  if (usedExplicitWritingStrategy) {
    writingBlockFallback = {
      attempted: false,
      found: false,
      strategyId: null,
      confidence: null,
      assistantTurnsScanned: 0,
      headerAnchorCount: 0,
      contentEditableCount: 0,
      pairCount: 0,
      acceptedEditorCount: 0,
      ambiguousCount: 0,
      rejectionReason: "NOT_ATTEMPTED_EXPLICIT_STRATEGY_SUCCEEDED",
    };
  } else {
    // The fallback RAN here (explicit strategies produced nothing); surface
    // its full fail-closed diagnostic either way.
    writingBlockFallback =
      inferWritingBlocksFromEditorAnchors(containerRoot).diagnostic;
  }

    const raw: { element: Element; strategyId: string }[] = [];
  const seen = new Set<Element>();
  for (const strategy of STRATEGIES.writingBlock) {
    for (const el of resolveStrategy("writingBlock", strategy, containerRoot)) {
      if (!seen.has(el)) {
        seen.add(el);
        raw.push({ element: el, strategyId: strategy.id });
      }
    }
  }
  const usedWritingFallback =
    writingDetection.found &&
    writingDetection.strategy === WRITING_FALLBACK_STRATEGY_ID;
  if (usedWritingFallback) {
    for (const el of writingDetection.elements) {
      if (!seen.has(el)) {
        seen.add(el);
        raw.push({ element: el, strategyId: WRITING_FALLBACK_STRATEGY_ID });
      }
    }
  }

  // 4. Evaluate each raw candidate through the PRODUCTION evaluator.
  const candidates: WritingCandidateDiagnostic[] = raw.map((r, i) => {
    const evaluation = evaluateWritingBlockCandidate(r.element, adapter);
    return {
      index: i,
      strategyId: r.strategyId,
      confidence: evaluation.confidence,
      sig: nodeSignature(r.element),
      accepted: evaluation.accepted,
      reasons: evaluation.reasons,
      turnIndex: assistantTurnIndex(containerRoot, r.element),
    };
  });

  // The receipt's accepted count comes from the SAME production verdicts.
  if (usedWritingFallback) {
    writingBlockFallback = {
      ...writingBlockFallback,
      acceptedEditorCount: candidates.filter(
        (c) => c.strategyId === WRITING_FALLBACK_STRATEGY_ID && c.accepted,
      ).length,
    };
  }

  const rejections: Record<string, number> = {};
  for (const c of candidates) {
    for (const reason of c.reasons) {
      rejections[reason] = (rejections[reason] ?? 0) + 1;
    }
  }

  // 5. Editable + action inventories.
  const { editable, actions } = collectTurnSurfaces(containerRoot, raw);

  // 6. Runtime state — extensionRuntimeOk is now HEALTH-AUTHORITATIVE
  //    (runtime-health module), never hardcoded true.
  const generating = adapter.detectGeneratingIndicator();
  const runtime: RuntimeState = {
    extensionRuntimeOk: isRuntimeOk(),
    extensionEnabled: settings.enabled,
    writingCopyEnabled: settings.writingCopyEnabled,
    highlightApiSupported: isHighlightApiAvailable(),
    copiedRangeCount: copiedRangeCount(),
    generatingIndicatorPresent: generating.found,
    extensionCopyHostCount: document.querySelectorAll(
      '[data-cgl-writing-copy-host="true"]',
    ).length,
    semanticCopiedCount: document.querySelectorAll(
      '[data-cgl-writing-copy-state="copied"]',
    ).length,
    semanticUncopiedCount: document.querySelectorAll(
      '[data-cgl-writing-copy-state="uncopied"]',
    ).length,
    editableRegionCount: editable.length,
    actionControlCount: actions.filter((a) => a.kind === "action").length,
    route: routeInfo(),
  };

  return {
    strategies,
    conversationContainerFound: containerResult.found,
    conversationContainerStrategyId: containerResult.found
      ? containerResult.strategy
      : null,
    containerFallback,
    writingBlockFallback,
    assistantTurnCount: assistantTurns.length,
    userTurnCount: userTurns.length,
    writingPipeline: {
      rawCandidateCount: candidates.length,
      safeCount: candidates.filter((c) => c.accepted).length,
      rejectedCount: candidates.filter((c) => !c.accepted).length,
      rejections,
      candidates,
    },
    editableRegions: editable,
    actions,
    runtime,
    runtimeHealth: snapshotRuntimeHealth(document),
    writingCopyController: controller,
    copyTransaction,
    folding,
  };
}
