import type { Settings } from "../../shared/types.js";
import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import { FoldingHost } from "./folding-host.js";
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

  /** Core pass: detect long targets, auto-fold new ones, sync controls. */
  private reconcile(): void {
    const container = this.adapter.detectConversationContainer().element;
    if (!container) {
      this.host.sync(new Map(), new Map(), null);
      return;
    }
    const generating = this.adapter.detectGeneratingIndicator().found;
    const turns = assistantTurns(container);
    const streamingTurn = generating ? turns[turns.length - 1] ?? null : null;

    const codeStates = new Map<HTMLElement, boolean>();
    for (const pre of longCodeBlocks(container)) {
      // Never touch code inside the currently streaming turn: no auto-fold,
      // no marker, no control for this reconciliation. When generation ends,
      // the next refresh folds it normally through the existing lifecycle.
      const ownerTurn = pre.closest(ASSISTANT_TURN_SELECTOR);
      if (streamingTurn && ownerTurn === streamingTurn) continue;
      if (!pre.isConnected) continue;
      const folded = pre.getAttribute(MARKER_CODE_FOLDED) === "true";
      if (!folded && !this.userExpanded.has(pre)) markCodeFolded(pre);
      codeStates.set(pre, pre.getAttribute(MARKER_CODE_FOLDED) === "true");
    }
    const responseStates = new Map<HTMLElement, boolean>();
    for (const turn of turns) {
      if (!turn.isConnected) continue;
      if (!isLongResponse(turn)) {
        if (turn.getAttribute(MARKER_RESPONSE_FOLDED) === "true") {
          unmarkResponseFolded(turn);
        }
        continue;
      }
      // Never auto-fold the streaming turn; user-expanded turns stay open.
      if (turn === streamingTurn || this.userExpanded.has(turn)) {
        continue;
      }
      // Auto-fold only when the marker is absent (first finished sighting);
      // an explicit user collapse persists via the marker itself.
      if (turn.getAttribute(MARKER_RESPONSE_FOLDED) !== "true") {
        markResponseFolded(turn);
      }
      responseStates.set(turn, true);
    }
    // Include already-folded turns (e.g. user-collapsed) in control sync.
    for (const turn of queryMarked(MARKER_RESPONSE_FOLDED)) {
      if (!responseStates.has(turn)) responseStates.set(turn, true);
    }
    const anyCodeFolded =
      codeStates.size > 0
        ? [...codeStates.values()].some((folded) => folded)
        : null;
    this.host.sync(codeStates, responseStates, anyCodeFolded);
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

  /** rAF-coalesced control repositioning (no work when nothing changes). */
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
      this.host.reposition();
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
