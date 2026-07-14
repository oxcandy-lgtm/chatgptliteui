import type { Confidence } from "../shared/types.js";

/**
 * Typed detection result returned by every Adapter strategy.
 *
 * The Adapter never performs destructive operations. It only observes the page
 * and reports what it found, with enough metadata for diagnostics and for
 * downstream code to decide whether an action is safe.
 */
export interface DetectionResult {
  /** Whether a candidate element/set was found. */
  found: boolean;
  /** Primary matched element, if any. */
  element: HTMLElement | null;
  /** All matched elements (strategy-dependent cardinality). */
  elements: HTMLElement[];
  /** Confidence of the result. */
  confidence: Confidence;
  /** Identifier of the strategy that produced this result. */
  strategy: string;
  /** Human-readable reason, used for diagnostics only (no page content). */
  reason: string;
  /** Timestamp (ms) when the detection ran. */
  timestamp: number;
}

export function notFound(strategy: string, reason: string): DetectionResult {
  return {
    found: false,
    element: null,
    elements: [],
    confidence: "unknown",
    strategy,
    reason,
    timestamp: Date.now(),
  };
}

export function makeResult(opts: {
  element: HTMLElement | null;
  elements: HTMLElement[];
  confidence: Confidence;
  strategy: string;
  reason: string;
}): DetectionResult {
  return {
    found: opts.elements.length > 0,
    element: opts.element,
    elements: opts.elements,
    confidence: opts.confidence,
    strategy: opts.strategy,
    reason: opts.reason,
    timestamp: Date.now(),
  };
}

/**
 * Capability levels describe what action a detection result supports.
 *  - high:    all required invariants pass; safe for any operation.
 *  - medium:  usable only for cosmetic / non-destructive behavior.
 *  - low:     diagnostic only.
 *  - unknown: no feature action.
 *
 * Future destructive history operations MUST require high-confidence detection
 * plus additional safety invariants; they are intentionally out of scope for
 * Phase 0.
 */
export type CapabilityLevel = Confidence;

export function capabilityFromResult(result: DetectionResult): CapabilityLevel {
  return result.confidence;
}
