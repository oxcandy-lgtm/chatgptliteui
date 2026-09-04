import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import { findSafeWritingBlocks } from "./writing-copy-detection.js";

/**
 * Viewport-centered writing-block tracker.
 *
 * Per the locked Phase 4 tracking correction:
 *  - Uses `IntersectionObserver` with `threshold: 0` (NOT 0.5). Large blocks
 *    may never reach 50% visibility, so 0.5 would wrongly hide the control.
 *  - The observer only maintains a SET of currently-intersecting safe
 *    candidates. The active target is chosen by recomputing the distance to
 *    the viewport center.
 *  - Recomputation runs through ONE `requestAnimationFrame`-throttled path on
 *    scroll, resize, candidate-set change, structural refresh, and immediately
 *    before a copy action. No permanent polling timer; no one-rAF-per-scroll
 *    storm.
 *  - Deterministic tie-breaking: (1) smallest center distance, (2) greater
 *    visible area, (3) DOM order.
 *  - Zero-size / disconnected / off-viewport candidates are ignored.
 *  - All candidate and target references are released on teardown.
 */

export interface TrackedTarget {
  element: HTMLElement;
}

export type ActiveTargetChange = (target: HTMLElement | null) => void;

/** Callback fired after every recalculation pass (target may be unchanged). */
export type RecalculateCallback = () => void;

/** Extension-owned visibility marker for pulse performance gating. */
const MARKER_WRITING_VISIBLE = "data-cgl-writing-visible";

/**
 * Set/clear the extension-owned visibility marker on a candidate.
 * The pulse animation is gated on this marker so only currently visible
 * WritingBlocks animate.
 */
function setVisibilityMarker(el: HTMLElement, visible: boolean): void {
  if (visible) el.setAttribute(MARKER_WRITING_VISIBLE, "true");
  else el.removeAttribute(MARKER_WRITING_VISIBLE);
}

function rectCenterDistance(rect: DOMRect): number {
  const blockCenterY = rect.top + rect.height / 2;
  const viewportCenterY = (window.innerHeight || 0) / 2;
  return Math.abs(blockCenterY - viewportCenterY);
}

function visibleArea(rect: DOMRect): number {
  const vh = window.innerHeight || 0;
  const top = Math.max(rect.top, 0);
  const bottom = Math.min(rect.bottom, vh);
  const visibleHeight = Math.max(0, bottom - top);
  return Math.max(0, rect.width) * visibleHeight;
}

export class WritingCopyTracker {
  private readonly adapter: ChatGptAdapter;
  private observer: IntersectionObserver | null = null;
  private candidates = new Set<HTMLElement>();
  private active: HTMLElement | null = null;
  private rafId: number | null = null;
  private onChange: ActiveTargetChange | null = null;
  private onRecalculate: RecalculateCallback | null = null;
  private readonly boundScroll: () => void;
  private readonly boundResize: () => void;

  constructor(adapter: ChatGptAdapter) {
    this.adapter = adapter;
    this.boundScroll = (): void => this.scheduleRecalculate();
    this.boundResize = (): void => this.scheduleRecalculate();
  }

  /** Provide a callback invoked whenever the active target changes. */
  setOnChange(cb: ActiveTargetChange): void {
    this.onChange = cb;
  }

  /**
   * Provide a callback invoked after every recalculation pass, even when the
   * active target did not change (used by the visual layer for cheap
   * presentation reconciliation).
   */
  setOnRecalculate(cb: RecalculateCallback): void {
    this.onRecalculate = cb;
  }

  /**
   * Re-scan the DOM for safe candidates, rebuild the candidate set, (re)attach
   * the IntersectionObserver, and immediately recalculate the active target.
   *
   * `retainedFallback` covers responsive/layout continuity: when fresh
   * detection legitimately returns zero (e.g. a responsive-hidden header
   * anchor) the controller may pass its previously proven, re-validated
   * target so tracking — and the Copy bubble — survive the reflow. The
   * fallback is used ONLY when fresh detection finds nothing.
   */
  refresh(retainedFallback?: HTMLElement[]): void {
    this.teardownObserver();
    // Clear stale visibility markers before rebuilding the candidate set.
    document.querySelectorAll(`[${MARKER_WRITING_VISIBLE}]`).forEach((el) => {
      el.removeAttribute(MARKER_WRITING_VISIBLE);
    });
    const found = findSafeWritingBlocks(this.adapter).filter(
      (el) => el.isConnected,
    );
    this.candidates = new Set(
      found.length > 0
        ? found
        : (retainedFallback ?? []).filter((el) => el.isConnected),
    );

    if (typeof IntersectionObserver !== "undefined" && this.candidates.size > 0) {
      this.observer = new IntersectionObserver(
        (entries) => {
          // Maintain extension-owned visibility markers so CSS can gate the
          // pulse animation to currently visible blocks only. The callback
          // also re-validates connectivity to be safe under jsdom (where
          // IntersectionObserver may be a no-op stub).
          for (const entry of entries) {
            const el = entry.target as HTMLElement;
            if (!el.isConnected) continue;
            setVisibilityMarker(el, entry.isIntersecting);
          }
          this.recalculate();
        },
        { threshold: 0 },
      );
      for (const el of this.candidates) this.observer.observe(el);
    }

    window.addEventListener("scroll", this.boundScroll, { passive: true });
    window.addEventListener("resize", this.boundResize);

    this.recalculate();
  }

  /** Force an immediate recomputation of the active target (used pre-copy). */
  recalculateNow(): HTMLElement | null {
    this.recalculate();
    return this.active;
  }

  /** Current active target, or null. */
  get activeTarget(): HTMLElement | null {
    return this.active;
  }

  /** All currently tracked candidate elements. */
  get candidatesList(): HTMLElement[] {
    return [...this.candidates];
  }

  /** True when the observer is attached. */
  get isObserving(): boolean {
    return this.observer != null;
  }

  /**
   * Choose the most viewport-centered safe candidate.
   *
   * Deterministic tie-breaking:
   *  1. smallest center distance to viewport center;
   *  2. greater visible area;
   *  3. DOM order (earlier in document wins).
   */
  private recalculate(): void {
    const vh = window.innerHeight || 0;
    let best: HTMLElement | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestArea = -1;
    let bestOrder = Number.POSITIVE_INFINITY;

    const connected = [...this.candidates].filter((el) => el.isConnected);
    for (const el of connected) {
      const rect = el.getBoundingClientRect();
      // Ignore zero-size / disconnected / fully off-viewport blocks.
      if (rect.width <= 0 || rect.height <= 0) continue;
      const offscreen = rect.bottom <= 0 || rect.top >= vh;
      if (offscreen) continue;
      const distance = rectCenterDistance(rect);
      const area = visibleArea(rect);

      if (best === null) {
        best = el;
        bestDistance = distance;
        bestArea = area;
        bestOrder = domOrder(el, connected);
        continue;
      }
      if (
        distance < bestDistance - 0.5 ||
        (Math.abs(distance - bestDistance) <= 0.5 && area > bestArea) ||
        (Math.abs(distance - bestDistance) <= 0.5 &&
          area === bestArea &&
          domOrder(el, connected) < bestOrder)
      ) {
        best = el;
        bestDistance = distance;
        bestArea = area;
        bestOrder = domOrder(el, connected);
      }
    }

    if (best !== this.active) {
      this.active = best;
      this.onChange?.(best);
    }
    this.onRecalculate?.();
  }

  /** rAF-throttled recalculation entry point. */
  private scheduleRecalculate(): void {
    if (this.rafId != null) return; // coalesce to one rAF
    const raf =
      typeof requestAnimationFrame !== "undefined"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback): number =>
            setTimeout(() => cb(0), 16) as unknown as number;
    this.rafId = raf((_) => {
      this.rafId = null;
      this.recalculate();
    });
  }

  private teardownObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  /** Release all candidate/target references, listeners, and markers. */
  teardown(): void {
    this.teardownObserver();
    window.removeEventListener("scroll", this.boundScroll);
    window.removeEventListener("resize", this.boundResize);
    if (this.rafId != null) {
      const caf =
        typeof cancelAnimationFrame !== "undefined"
          ? cancelAnimationFrame
          : clearTimeout;
      caf(this.rafId as unknown as number);
      this.rafId = null;
    }
    // Release extension-owned visibility markers so no pulse gating survives
    // teardown.
    document.querySelectorAll(`[${MARKER_WRITING_VISIBLE}]`).forEach((el) => {
      el.removeAttribute(MARKER_WRITING_VISIBLE);
    });
    this.candidates.clear();
    this.active = null;
    // NOTE: onRecalculate is constructor-owned (controller's visual reconcile)
    // and must SURVIVE teardown/restore: clearing it here would permanently
    // sever scroll-driven visual reconciliation after the first route change.
    // reconcileVisuals() itself is disabled-safe, so keeping it is correct
    // across both transient restores and full teardowns.
  }
}

export { MARKER_WRITING_VISIBLE as WRITING_VISIBLE_MARKER };

function domOrder(el: HTMLElement, ordered: HTMLElement[]): number {
  const idx = ordered.indexOf(el);
  return idx < 0 ? Number.POSITIVE_INFINITY : idx;
}
