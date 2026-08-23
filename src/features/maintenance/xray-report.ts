/**
 * CGL X-Ray — AI report generation (`schema = cgl-xray-v1`).
 *
 * Builds the machine-readable STRUCTURE-ONLY receipt from a live scan plus
 * optional deep scan / picked target. Includes the deterministic self-
 * diagnosis summary (first causal blocker chosen from the observed pipeline)
 * and the privacy guard that verifies no captured secret strings can appear
 * in the serialized report.
 */

import type { XrayScan } from "./xray-scan.js";
import type { ConversationContainerFallbackDiagnostic } from "../../adapters/chatgpt-adapter.js";
import {
  deepStructuralTree,
  ancestorChain,
  nodeSignature,
  DEFAULT_NODE_CAP,
  type NodeSignature,
  type DeepNode,
} from "./xray-signature.js";
import {
  type RuntimeHealthSnapshot,
} from "../../shared/runtime-health.js";
import type { CopyTransactionReceipt } from "../writing-copy/writing-copy-controller.js";

/** Top-level report schema (stable). */
export interface XrayReportV1 {
  schema: "cgl-xray-v1";
  extension: {
    runtimeOk: boolean;
    enabled: boolean;
    writingCopyEnabled: boolean;
  };
  route: {
    shape: string;
    conversationIdentityAvailable: boolean;
  };
  viewport: { w: number; h: number };
  adapterStrategies: unknown[];
  turns: {
    assistantTurnCount: number;
    userTurnCount: number;
    conversationContainerFound: boolean;
  };
  /**
   * Structural container-fallback section — NOT a CSS selector strategy.
   * Present exactly what the role-turn-common-ancestor inference did.
   */
  containerFallback: ConversationContainerFallbackDiagnostic;
  /**
   * Structural writing-block-editor-anchored fallback receipt (same model as
   * containerFallback): attempted/found/anchors/editors/pairs/ambiguity.
   */
  writingBlockFallback: XrayScan["writingBlockFallback"];
  writingPipeline: XrayScan["writingPipeline"];
  editableRegions: unknown[];
  actions: unknown[];
  pickedTarget:
    | {
        sig: NodeSignature;
        ancestors: NodeSignature[];
        descendants: {
          editable: NodeSignature[];
          actions: NodeSignature[];
        };
      }
    | null;
  deepTree?: {
    root: DeepNode | null;
    truncated: boolean;
    totalObserved: number;
    included: number;
  };
  runtimeState: XrayScan["runtime"];
  /**
   * Runtime health authority (additive, schema stays cgl-xray-v1): build/boot
   * identity, extension-context validity, storage probe result, and the
   * bounded internal CGL error log. Privacy-safe fields only.
   */
  runtimeHealth: RuntimeHealthSnapshot;
  /** Copy-host pipeline receipt (null when no controller is wired). */
  writingCopyController: XrayScan["writingCopyController"];
  /** Last copy click transaction (null when no controller/attempt). */
  copyTransaction: CopyTransactionReceipt | null;
  diagnosis: {
    summary: string;
    firstBlocker: string;
    rejectionCounts: Record<string, number>;
  };
}

/**
 * Deterministic self-diagnosis from the observed pipeline. Chooses the first
 * causal blocker in pipeline order; never claims a root cause when data is
 * ambiguous (`UNKNOWN_AFTER_XRAY`).
 */
export function diagnose(
  scan: XrayScan,
): { summary: string; firstBlocker: string } {
  const rt = scan.runtime;

  // PRECEDENCE #0: a dead extension context masks everything else. Never let
  // WRITING_SAFE_COUNT_N claim success while the runtime is RED.
  if (rt.extensionRuntimeOk === false) {
    if (scan.runtimeHealth?.invalidatedLatched) {
      return {
        summary: "EXTENSION_CONTEXT_INVALIDATED",
        firstBlocker: "EXTENSION_RUNTIME_CONTEXT",
      };
    }
    return { summary: "EXTENSION_RUNTIME_FAIL", firstBlocker: "EXTENSION_RUNTIME" };
  }
  if (!rt.extensionEnabled || !rt.writingCopyEnabled) {
    return {
      summary: "EXTENSION_RUNTIME_OK_WRITING_COPY_DISABLED",
      firstBlocker: !rt.extensionEnabled ? "EXTENSION_DISABLED" : "WRITING_COPY_DISABLED",
    };
  }
  if (!scan.conversationContainerFound) {
    return {
      summary: "CONVERSATION_CONTAINER_NOT_FOUND",
      firstBlocker: "CONVERSATION_CONTAINER",
    };
  }

  const assistantStrategy = scan.strategies.find(
    (s) => s.target === "assistantTurn" && s.totalMatches > 0,
  );
  if (scan.assistantTurnCount === 0 && (assistantStrategy?.totalMatches ?? 0) === 0) {
    return { summary: "ASSISTANT_OWNER_NOT_FOUND", firstBlocker: "ASSISTANT_TURNS" };
  }

  const wp = scan.writingPipeline;
  if (wp.rawCandidateCount === 0) {
    return { summary: "NO_WRITING_STRATEGY_MATCH", firstBlocker: "WRITING_STRATEGIES" };
  }
  if (wp.safeCount === 0) {
    // Causal precedence #1: when the structural writing fallback RAN and
    // failed while raw candidates exist, its fail-closed rejection IS the
    // blocker — far more actionable than counting low-confidence noise.
    const wbf = scan.writingBlockFallback;
    if (wbf.attempted && !wbf.found && wbf.rejectionReason != null) {
      const detail =
        wbf.rejectionReason === "NOT_ATTEMPTED_EXPLICIT_STRATEGY_SUCCEEDED"
          ? ""
          : `_${wbf.rejectionReason}`;
      if (detail !== "") {
        return {
          summary: `RAW_CANDIDATES_PRESENT_SAFE_ZERO${detail}`,
          firstBlocker: `WRITING_FALLBACK:${wbf.rejectionReason}`,
        };
      }
    }
    // Causal precedence #2: name the most common rejection reason
    // deterministically (count desc, then lexicographic for ties).
    // Rejections of structurally anchored editors (the highest-confidence
    // candidates) take precedence over the diagnostic low-confidence
    // paragraph noise. Ambiguous/empty -> UNKNOWN_AFTER_XRAY.
    const fallbackId = scan.writingBlockFallback.strategyId;
    const preferred = fallbackId
      ? wp.candidates.filter((c) => !c.accepted && c.strategyId === fallbackId)
      : [];
    const source =
      preferred.length > 0 ? preferred : wp.candidates.filter((c) => !c.accepted);
    let topReason = "";
    let topCount = 0;
    const tally = new Map<string, number>();
    for (const c of source) {
      for (const reason of c.reasons) {
        tally.set(reason, (tally.get(reason) ?? 0) + 1);
      }
    }
    for (const [reason, count] of tally) {
      if (
        count > topCount ||
        (count === topCount && topReason !== "" && reason < topReason)
      ) {
        topReason = reason;
        topCount = count;
      }
    }
    const detail = topReason !== "" ? `_${topReason}` : "";
    return {
      summary: `RAW_CANDIDATES_PRESENT_SAFE_ZERO${detail}`,
      firstBlocker: `GATE_REJECTION:${topReason !== "" ? topReason : "UNKNOWN_AFTER_XRAY"}`,
    };
  }
  // Causal order position 4: after runtime/root/detection PASS, inspect the
  // ACTUAL controller receipt. WRITING_SAFE_COUNT_N alone is not success —
  // a mounted-and-visible copy host is part of the operational pipeline.
  if (wp.safeCount > 0 && scan.writingCopyController) {
    const blocker = scan.writingCopyController.mountBlocker;
    if (blocker != null) {
      return {
        summary: `WRITING_COPY_${blocker}`,
        firstBlocker: `WRITING_COPY_CONTROLLER:${blocker}`,
      };
    }
  }

  // Causal order position 5: copy TRANSACTION receipt (after host PASS).
  // No attempt yet -> ready, never a manufactured technical failure.
  if (wp.safeCount > 0 && scan.writingCopyController) {
    const tx = scan.copyTransaction;
    if (!tx || tx.attemptCount === 0) {
      return { summary: "WRITING_COPY_READY", firstBlocker: "" };
    }

    const rangeNow =
      scan.runtime.copiedRangeCount ?? tx.copiedRangeCountAfter ?? 0;
    const complete =
      tx.copyOutcome === "copied" &&
      tx.durableSaveSucceeded &&
      rt.semanticCopiedCount > 0 &&
      rangeNow >= 1;
    if (complete) {
      return { summary: "REAL_COPYMARKER_GREEN", firstBlocker: "" };
    }

    // Observation-only reversion: receipt recorded COPIED applied, but the
    // live semantic state shows the block back at UNCOPIED. No polling.
    const reverted =
      tx.semanticCopiedApplied &&
      rt.semanticCopiedCount === 0 &&
      rt.semanticUncopiedCount > 0;
    if (reverted) {
      return {
        summary: "COPY_STATE_REVERTED_AFTER_SUCCESS",
        firstBlocker: "REAL_COPY_TRANSACTION:COPY_STATE_REVERTED_AFTER_SUCCESS",
      };
    }

    if (tx.semanticCopiedApplied && rangeNow < 1) {
      return {
        summary: "COPYMARKER_RANGE_MISSING",
        firstBlocker: "REAL_COPY_TRANSACTION:COPYMARKER_RANGE_MISSING",
      };
    }

    if (tx.failureCode) {
      return {
        summary: `COPY_TRANSACTION_${tx.failureCode}`,
        firstBlocker: `REAL_COPY_TRANSACTION:${tx.failureCode}`,
      };
    }
  }

  return { summary: `WRITING_SAFE_COUNT_${wp.safeCount}`, firstBlocker: "" };
}

/** Options for report assembly. */
export interface BuildReportOptions {
  /** Include the bounded structural tree of the conversation region. */
  includeDeepTree?: boolean;
  deepTreeNodeCap?: number;
}

/** Manually picked target captured by the one-shot element picker. */
export interface PickedTargetInfo {
  element: Element;
  /** Nearest Assistant turn (or conversation container / null boundary). */
  boundary: Element | null;
}

/** Assemble the full `cgl-xray-v1` report. Pure — never mutates the page. */
export function buildXrayReport(
  scan: XrayScan,
  adapterParameters: {
    /** Conversation container element for deep scan root (may be null). */
    containerElement: Element | null;
  },
  picked: PickedTargetInfo | null,
  options: BuildReportOptions = {},
): XrayReportV1 {
  let pickedTarget: XrayReportV1["pickedTarget"] = null;
  if (picked) {
    // Useful descendants of the picked element: editables + action controls.
    const editable = Array.from(
      picked.element.querySelectorAll('[contenteditable], [role="textbox"], textarea'),
    )
      .slice(0, 20)
      .map((el) => nodeSignature(el));
    const actions = Array.from(
      picked.element.querySelectorAll('button, [role="button"]'),
    )
      .slice(0, 20)
      .map((el) => nodeSignature(el));
    pickedTarget = {
      sig: nodeSignature(picked.element),
      ancestors: ancestorChain(picked.element, picked.boundary),
      descendants: { editable, actions },
    };
  }

  const report: XrayReportV1 = {
    schema: "cgl-xray-v1",
    extension: {
      runtimeOk: scan.runtime.extensionRuntimeOk,
      enabled: scan.runtime.extensionEnabled,
      writingCopyEnabled: scan.runtime.writingCopyEnabled,
    },
    route: scan.runtime.route,
    viewport: {
      w: typeof window !== "undefined" ? window.innerWidth ?? 0 : 0,
      h: typeof window !== "undefined" ? window.innerHeight ?? 0 : 0,
    },
    adapterStrategies: scan.strategies,
    turns: {
      assistantTurnCount: scan.assistantTurnCount,
      userTurnCount: scan.userTurnCount,
      conversationContainerFound: scan.conversationContainerFound,
    },
    containerFallback: scan.containerFallback,
    writingBlockFallback: scan.writingBlockFallback,
    writingPipeline: scan.writingPipeline,
    editableRegions: scan.editableRegions,
    actions: scan.actions,
    pickedTarget,
    runtimeState: scan.runtime,
    runtimeHealth: scan.runtimeHealth,
    writingCopyController: scan.writingCopyController,
    copyTransaction: scan.copyTransaction,
    diagnosis: {
      summary: diagnose(scan).summary,
      firstBlocker: diagnose(scan).firstBlocker,
      rejectionCounts: scan.writingPipeline.rejections,
    },
  };

  if (options.includeDeepTree && adapterParameters.containerElement) {
    const deep = deepStructuralTree(
      adapterParameters.containerElement,
      options.deepTreeNodeCap ?? DEFAULT_NODE_CAP,
    );
    report.deepTree = {
      root: deep.root,
      truncated: deep.truncated,
      totalObserved: deep.totalObserved,
      included: deep.included,
    };
  }

  return report;
}

/**
 * Privacy guard: assert that NONE of the supplied secret fixture strings
 * appear in the serialized report. Returns the list of leaked secrets
 * (empty = pass). The secrets themselves are never written anywhere.
 */
export function findLeakedSecrets(
  serialized: string,
  secrets: readonly string[],
): string[] {
  const leaks: string[] = [];
  for (const s of secrets) {
    if (s.length >= 8 && serialized.includes(s)) {
      leaks.push(s);
    }
  }
  return leaks;
}
