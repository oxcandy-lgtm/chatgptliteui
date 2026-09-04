import type { Settings } from "../../shared/types.js";
import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import { FoldingHost, type ActiveFoldTarget } from "./folding-host.js";
import {
  MARKER_CODE_FOLDED,
  MARKER_RESPONSE_FOLDED,
  clearAllFoldingMarkers,
  markCodeFolded,
  markResponseFolded,
  unmarkCodeFolded,
  unmarkResponseFolded,
} from "./folding-markers.js";

/**
 * Code + long-response folding controller (Phase 5).
 *
 * Strictly non-destructive. The ONLY permitted mutations on ChatGPT content
 * are TWO extension-owned boolean markers (`data-cgl-code-folded` on a long
 * `<pre>`, `data-cgl-response-folded` on a long assistant turn); clipping is
 * presentation-only CSS. Extension-owned Shadow DOM controls toggle them.
 *
 * Responsibilities:
 *  - detect long code blocks (`pre > code` with >= CODE_FOLD_MIN_LINES
 *    lines) inside assistant turns, excluding composers, dialogs, sidebars,
 *    WritingBlock editor surfaces, and extension hosts;
 *  - detect long finished assistant responses (rendered height above
 *    RESPONSE_FOLD_MIN_HEIGHT_PX), excluding generating turns, user turns,
 *    and WritingBlock editor surfaces; fail closed when ambiguous;
 *  - auto-fold long targets when generation is finished; never auto-fold
 *    the currently streaming response (generating indicator present);
 *  - honor explicit user expand/collapse across reconciliations (in-memory
 *    only; never persisted, never content);
 *  - completely restore the official UI on disable/teardown/route change.
 *
 * No timers, no polling, no clipboard, no storage of content. The content
 * runtime drives `apply`/`refresh`/`teardown` through the existing
 * mutation lifecycle.
 */

/** Serializable folding receipt for X-Ray (counts only, never content). */
export interface FoldingReceipt {
  foldingEligibleCodeCount: number;
  foldingEligibleResponseCount: number;
  foldingMountedButtonCount: number;
  foldingRetainedTargetCount: number;
}

/** Minimum rendered code lines for a block to become foldable. */
export const CODE_FOLD_MIN_LINES = 25;
/** Minimum rendered turn height (px) for a response to become foldable. */
export const RESPONSE_FOLD_MIN_HEIGHT_PX = 1000;

const ASSISTANT_TURN_SELECTOR =
  '[data-message-author-role="assistant"], [data-testid="assistant-message"]';
const FORBIDDEN_ANCESTOR_SELECTOR =
  '[role="dialog"], dialog, [aria-modal="true"], [data-testid="sidebar"], nav[aria-label*="chat history" i], [data-cgl-sidebar-host="true"], [data-cgl-writing-copy-host="true"], [data-cgl-folding-host="true"], #cgl-sidebar-control-host, #cgl-writing-copy-host';

export class FoldingController {
  private readonly adapter: ChatGptAdapter;
  private readonly host: FoldingHost;
  private enabled = false;
  /** User-expanded targets (in-memory only): never auto-refolded. */
  private userExpanded = new WeakSet<HTMLElement>();
  /** rAF-coalesced reposition id. */
  private geometryRaf: number | null = null;
  private readonly boundGeometryUpdate = (): void => this.scheduleReposition();
  private geometryListenersAttached = false;

  constructor(_root: HTMLElement, adapter: ChatGptAdapter) {
    this.adapter = adapter;
    this.host = new FoldingHost();
  }

  /** Whether the folding host is currently mounted. */
  get isHostMounted(): boolean {
    return this.host.isMounted;
  }

  /** Currently folded code blocks (connected only). */
  foldedCodes(): HTMLElement[] {
    return queryMarked(MARKER_CODE_FOLDED);
  }

  /** Currently folded responses (connected only). */
  foldedResponses(): HTMLElement[] {
    return queryMarked(MARKER_RESPONSE_FOLDED);
  }

  // --- apply / refresh / restore ------------------------------------------

  /**
   * Apply folding. No-op (official UI untouched) when disabled. Otherwise
   * reconcile fold state, mount controls, and begin tracking geometry.
   */
  apply(settings: Settings): void {
    this.restore();
    this.enabled = settings.enabled;
    if (!this.enabled) return;
    if (!this.adapter.detectConversationContainer().element) return;
    this.host.mount({
      onToggleCode: (target) => this.toggleCode(target),
      onToggleResponse: (target) => this.toggleResponse(target),
      onExpandAll: () => this.expandAll(),
      onCollapseAll: () => this.collapseAll(),
    });
    this.attachGeometryListeners();
    this.reconcile();
  }

  /**
   * Re-detect and reconcile after SPA route change or structural mutation.
   * Generation-aware: a currently streaming response is never auto-folded;
   * when generation ends, the next reconciliation folds it if long.
   */
  refresh(_settings: Settings): void {
    if (!this.enabled) return;
    if (!this.adapter.detectConversationContainer().element) {
      this.restore();
      return;
    }
    this.reconcile();
  }

  /** Core pass: detect long targets, auto-fold new ones, sync the HUD. */
  private reconcile(): void {
    const container = this.adapter.detectConversationContainer().element;
    if (!container) {
      this.host.sync(null, null);
      return;
    }
    const generating = this.adapter.detectGeneratingIndicator().found;
    const turns = assistantTurns(container);
    const streamingTurn = generating ? turns[turns.length - 1] ?? null : null;

    // Local eligible lists only: they die with this pass. The host retains
    // at most the single active target; nothing else is kept.
    const codes: HTMLElement[] = [];
    for (const pre of longCodeBlocks(container)) {
      // Never touch code inside the currently streaming turn: no auto-fold,
      // no marker, no control for this reconciliation. When generation ends,
      // the next refresh folds it normally through the existing lifecycle.
      const ownerTurn = pre.closest(ASSISTANT_TURN_SELECTOR);
      if (streamingTurn && ownerTurn === streamingTurn) continue;
      if (!pre.isConnected) continue;
      const folded = pre.getAttribute(MARKER_CODE_FOLDED) === "true";
      if (!folded && !this.userExpanded.has(pre)) markCodeFolded(pre);
      codes.push(pre);
    }
    const responses: HTMLElement[] = [];
    for (const turn of turns) {
      if (!turn.isConnected) continue;
      if (!isLongResponse(turn)) {
        if (turn.getAttribute(MARKER_RESPONSE_FOLDED) === "true") {
          unmarkResponseFolded(turn);
        }
        continue;
      }
      // Never auto-fold the streaming turn; user-expanded turns stay open
      // (but remain eligible for their Collapse control).
      if (turn === streamingTurn || this.userExpanded.has(turn)) {
        responses.push(turn);
        continue;
      }
      // Auto-fold only when the marker is absent (first finished sighting);
      // an explicit user collapse persists via the marker itself.
      if (turn.getAttribute(MARKER_RESPONSE_FOLDED) !== "true") {
        markResponseFolded(turn);
      }
      responses.push(turn);
    }
    const active = this.selectActiveTarget(codes, responses);
    const anyCodeFolded =
      codes.length > 0
        ? codes.some(
            (pre) => pre.getAttribute(MARKER_CODE_FOLDED) === "true",
          )
        : null;
    this.host.sync(active, anyCodeFolded);
  }

  /**
   * Choose the single HUD target: the eligible target nearest the viewport
   * center. Offscreen targets never bind the button. Ties prefer code.
   */
  private selectActiveTarget(
    codes: HTMLElement[],
    responses: HTMLElement[],
  ): ActiveFoldTarget | null {
    const vh = window.innerHeight || 0;
    let best: ActiveFoldTarget | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    const consider = (el: HTMLElement, kind: "code" | "response"): void => {
      if (!el.isConnected) return;
      let rect: DOMRect;
      try {
        rect = el.getBoundingClientRect();
      } catch {
        return;
      }
      if (rect.width <= 0 || rect.height <= 0) return;
      if (rect.bottom <= 0 || rect.top >= vh) return;
      const distance = Math.abs(rect.top + rect.height / 2 - vh / 2);
      const folded = el.getAttribute(
        kind === "code" ? MARKER_CODE_FOLDED : MARKER_RESPONSE_FOLDED,
      ) === "true";
      if (
        distance < bestDistance - 0.5 ||
        (best?.kind === "response" &&
          kind === "code" &&
          Math.abs(distance - bestDistance) <= 0.5)
      ) {
        best = { kind, target: el, folded };
        bestDistance = distance;
      }
    };
    for (const pre of codes) consider(pre, "code");
    for (const turn of responses) consider(turn, "response");
    return best;
  }

  /** Counts-only receipt for X-Ray (no content, no identifiers). */
  foldingReceipt(): FoldingReceipt {
    const container = this.adapter.detectConversationContainer().element;
    let codes = 0;
    let responses = 0;
    if (container) {
      codes = longCodeBlocks(container).filter((el) => el.isConnected).length;
      responses = assistantTurns(container).filter(
        (el) => el.isConnected && isLongResponse(el),
      ).length;
    }
    return {
      foldingEligibleCodeCount: codes,
      foldingEligibleResponseCount: responses,
      foldingMountedButtonCount: this.host.buttonCount,
      foldingRetainedTargetCount: this.host.retainedTarget ? 1 : 0,
    };
  }

  // --- user actions --------------------------------------------------------

  private toggleCode(target: HTMLElement): void {
    if (!target.isConnected) return;
    if (target.getAttribute(MARKER_CODE_FOLDED) === "true") {
      unmarkCodeFolded(target);
      this.userExpanded.add(target);
    } else {
      markCodeFolded(target);
      this.userExpanded.delete(target);
    }
    this.reconcile();
  }

  private toggleResponse(target: HTMLElement): void {
    if (!target.isConnected) return;
    if (target.getAttribute(MARKER_RESPONSE_FOLDED) === "true") {
      unmarkResponseFolded(target);
      this.userExpanded.add(target);
    } else {
      markResponseFolded(target);
      this.userExpanded.delete(target);
    }
    this.reconcile();
  }

  private expandAll(): void {
    for (const pre of queryMarked(MARKER_CODE_FOLDED)) {
      unmarkCodeFolded(pre);
      this.userExpanded.add(pre);
    }
    this.reconcile();
  }

  private collapseAll(): void {
    this.userExpanded = new WeakSet<HTMLElement>();
    const container = this.adapter.detectConversationContainer().element;
    if (container) {
      for (const pre of longCodeBlocks(container)) {
        if (pre.isConnected) markCodeFolded(pre);
      }
    }
    this.reconcile();
  }

  // --- geometry ------------------------------------------------------------

  private attachGeometryListeners(): void {
    if (this.geometryListenersAttached) return;
    window.addEventListener("scroll", this.boundGeometryUpdate, { passive: true });
    window.addEventListener("resize", this.boundGeometryUpdate);
    this.geometryListenersAttached = true;
  }

  private detachGeometryListeners(): void {
    if (this.geometryListenersAttached) {
      window.removeEventListener("scroll", this.boundGeometryUpdate);
      window.removeEventListener("resize", this.boundGeometryUpdate);
      this.geometryListenersAttached = false;
    }
  }

  /** rAF-coalesced scroll/resize pass: re-select the active HUD target. */
  private scheduleReposition(): void {
    if (this.geometryRaf != null) return;
    const raf =
      typeof requestAnimationFrame !== "undefined"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback): number =>
            setTimeout(() => cb(0), 16) as unknown as number;
    this.geometryRaf = raf(() => {
      this.geometryRaf = null;
      if (!this.enabled) return;
      // Full reconcile re-derives eligibility, re-selects the visible
      // active target, and moves the SAME button — no per-target state.
      this.reconcile();
    });
  }

  // --- teardown / restore --------------------------------------------------

  /** Completely restore the official ChatGPT UI. Idempotent. */
  restore(): void {
    this.detachGeometryListeners();
    if (this.geometryRaf != null) {
      const caf =
        typeof cancelAnimationFrame !== "undefined"
          ? cancelAnimationFrame
          : clearTimeout;
      caf(this.geometryRaf);
      this.geometryRaf = null;
    }
    clearAllFoldingMarkers(document);
    this.userExpanded = new WeakSet<HTMLElement>();
    this.host.unmount();
  }

  /** Tear down listeners, controls, markers, and references. */
  teardown(): void {
    this.restore();
    this.enabled = false;
  }
}

/** Connected elements currently carrying a folding marker. */
function queryMarked(attr: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(`[${attr}]`)).filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement && el.isConnected,
  );
}

/** Assistant turns inside the conversation container (DOM order). */
function assistantTurns(container: ParentNode): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(ASSISTANT_TURN_SELECTOR),
  ).filter((el) => el.isConnected && el instanceof HTMLElement);
}

/**
 * Long `pre` code blocks eligible for folding: actual `pre`/`pre > code`
 * blocks inside assistant turns, excluding inline code, composers, dialogs,
 * sidebars, WritingBlock editor surfaces, and extension hosts.
 */
function longCodeBlocks(container: ParentNode): HTMLElement[] {
  const found = new Set<HTMLElement>();
  const codes = Array.from(
    container.querySelectorAll<HTMLElement>("pre > code, pre code"),
  );
  for (const code of codes) {
    if (!(code instanceof HTMLElement) || !code.isConnected) continue;
    const pre = code.closest("pre");
    const block = pre && pre instanceof HTMLElement ? pre : null;
    if (!block || !block.isConnected || found.has(block)) continue;
    if (!block.closest(ASSISTANT_TURN_SELECTOR)) continue;
    if (block.closest(FORBIDDEN_ANCESTOR_SELECTOR)) continue;
    // WritingBlock editor surfaces are managed by writing-copy, never folded.
    if (block.closest('[contenteditable="true"]')) continue;
    if (block.closest('[data-cgl-writing-block="true"]')) continue;
    if (lineCount(block) < CODE_FOLD_MIN_LINES) continue;
    found.add(block);
  }
  return [...found];
}

/** Rendered text line count (cheapest reliable length signal). */
function lineCount(block: HTMLElement): number {
  const text = block.textContent ?? "";
  if (text.trim().length === 0) return 0;
  return text.split("\n").length;
}

/**
 * Whether an assistant turn is a long finished response: clearly exceeds the
 * rendered-height threshold. Fail closed on zero/absurd geometry.
 */
function isLongResponse(turn: HTMLElement): boolean {
  if (turn.closest(FORBIDDEN_ANCESTOR_SELECTOR)) return false;
  // WritingBlock editor surfaces are managed by writing-copy, never folded.
  if (turn.querySelector('[contenteditable="true"]')) return false;
  if (turn.querySelector('[data-cgl-writing-block="true"]')) return false;
  let height = 0;
  try {
    height = turn.getBoundingClientRect().height;
  } catch {
    return false;
  }
  return height >= RESPONSE_FOLD_MIN_HEIGHT_PX;
}
