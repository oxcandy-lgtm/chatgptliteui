/**
 * Extension-owned Shadow DOM floating copy control host.
 *
 * Exactly one host exists per page. It is appended to `document.body` (never
 * inside a ChatGPT writing block), fully self-contained (Shadow DOM, no
 * external assets/fonts/styles), and carries an extension-owned id/attribute so
 * the shared structural MutationObserver can ignore it (no mutation loop).
 *
 * The host shows:
 *  - a single circular copy BUBBLE (44px true circle, inline SVG copy icon,
 *    aria-label "Copy centered writing block", type="button", visible focus
 *    style). No visible "Copy" text: the bubble never grows with status;
 *  - one INVISIBLE drag hit-zone on the bubble's upper-right edge (16px,
 *    fully transparent, no decoration; hover affordance is the `move` cursor
 *    alone, aria-label "Move copy button"). Pointer drag on the zone MOVES
 *    the bubble; clicking the bubble COPIES. The two interactions never cross;
 *  - a contained status region (role="status", aria-live="polite") that is
 *    visually hidden (accessibility-only) and MAY only ever show the fixed
 *    strings: "Copied.", "Copy requested.", "Copy unavailable.",
 *    "Nothing safe to copy." — never copied text, titles, URLs, or excerpts.
 *
 * Position model: `positionAgainst` computes the normal smart position against
 * the active block's right edge (fixed positioning from getBoundingClientRect,
 * clamped within the viewport), then adds the session-local manual drag
 * OFFSET (`final = smart + offset`), clamped so the full circle stays onscreen.
 * The offset survives active-target changes; it resets only on teardown.
 *
 * Layering: the host sits ABOVE the normal X-Ray panel so the bubble stays
 * reachable while X-Ray is open (diagnostic overlays are pointer-transparent).
 *
 * Repeated apply never creates duplicate hosts; teardown removes the host,
 * drag state, events, and timers.
 */

const HOST_ID = "cgl-writing-copy-host";
const HOST_ATTR = "data-cgl-writing-copy-host";
import { stampBootId } from "../../shared/runtime-health.js";
const STATUS_IDLE = "Nothing safe to copy.";

/** Visible copy bubble diameter (true circle at every viewport width). */
export const COPY_BUBBLE_PX = 44;
/**
 * Fixed smart-anchor row offset: the default (smart) base position sits
 * exactly three bubble cells below the WritingBlock top, so the initial
 * bubble location is deterministic and independent of block height.
 */
export const INITIAL_ROW_OFFSET_PX = 3 * COPY_BUBBLE_PX; // 132
/** How long the success check replaces the copy icon after copied status. */
export const SUCCESS_FEEDBACK_MS = 900;
/** Drag hit-zone diameter on the bubble's upper-right edge. */
export const COPY_HANDLE_PX = 16;
/** Extension-owned layer: strictly above the normal X-Ray panel. */
export const COPY_HOST_Z_INDEX = 2147483647;

const COPY_ICON_SVG =
  `<svg class="cgl-copy-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
  `<rect x="9" y="9" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/>` +
  `<path d="M5.5 15h-1a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2H12a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` +
  `</svg>`;

const CHECK_ICON_SVG =
  `<svg class="cgl-check-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
  `<path d="M4.5 12.5l5 5 10-11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
  `</svg>`;

const HOST_STYLE = `
  :host {
    position: fixed;
    z-index: 2147483647;
    display: none;
    font: 600 12px/1.2 system-ui, sans-serif;
    user-select: none;
    -webkit-user-select: none;
  }
  :host([data-visible="true"]) { display: block; }
  .cgl-copy-bubble {
    box-sizing: border-box;
    width: 44px;
    height: 44px;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: 1px solid #2a3142;
    background: #1c2230;
    color: #e7eaf0;
    cursor: pointer;
    border-radius: 50%;
    display: grid;
    place-items: center;
    outline: none;
  }
  .cgl-copy-bubble:focus-visible {
    box-shadow: 0 0 0 2px #4c8dff;
    border-color: #4c8dff;
  }
  .cgl-copy-bubble {
    transition: transform 100ms ease;
    transform-origin: center;
  }
  .cgl-copy-bubble:active {
    transform: scale(0.88);
  }
  .cgl-copy-bubble.cgl-success {
    background: #1e3a2b;
    border-color: #35d07f;
  }
  @media (prefers-reduced-motion: reduce) {
    .cgl-copy-bubble {
      transition: none;
    }
  }
  .cgl-copy-bubble svg {
    width: 21px;
    height: 21px;
    display: block;
  }
  .cgl-drag-handle {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    background: transparent;
    background-image: none;
    border: 0;
    box-shadow: none;
    opacity: 0;
    cursor: move;
    touch-action: none;
    padding: 0;
  }
  .cgl-drag-handle.cgl-dragging {
    cursor: move;
  }
  .cgl-copy-status {
    margin-top: 4px;
    font-size: 11px;
    color: #aab3c5;
    min-height: 14px;
  }
  .cgl-visually-hidden {
    position: absolute;
    width: 1px; height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
`;

export type CopyAction = () => void;

/** Fixed host status enum (structural receipt — never scraped from DOM). */
export type HostStatus = "idle" | "requested" | "copied" | "unavailable" | "none";

export class WritingCopyHost {
  private host: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private handle: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private onClick: CopyAction | null = null;
  private lastStatus: HostStatus = "idle";

  /** Session-local manual viewport offset (smart position + offset = final). */
  private manualOffset: { x: number; y: number } = { x: 0, y: 0 };
  /** Last successfully applied final position (zero-size continuity). */
  private lastFinal: { top: number; left: number } | null = null;
  /** Last smart (pre-offset) position, so drags rebase cleanly. */
  private smartBase: { top: number; left: number } | null = null;

  private dragging = false;
  private dragPointerId: number | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private dragOffsetStart: { x: number; y: number } | null = null;

  private readonly boundPointerDown = (e: PointerEvent): void => this.onDragStart(e);
  private readonly boundPointerMove = (e: PointerEvent): void => this.onDragMove(e);
  private readonly boundPointerUp = (e: PointerEvent): void => this.onDragEnd(e);
  private readonly boundPointerCancel = (e: PointerEvent): void => this.onDragEnd(e);
  /** Single bounded success-feedback timer (check icon + accent). */
  private successTimer: ReturnType<typeof setTimeout> | null = null;

  /** True when the host exists in the DOM. */
  get isMounted(): boolean {
    return this.host != null && this.host.isConnected;
  }

  /** True when the host is explicitly marked visible. */
  get isVisible(): boolean {
    return this.host?.getAttribute("data-visible") === "true";
  }

  /** Current rendered size of the host element, or null when unmounted. */
  get renderedSize(): { w: number; h: number } | null {
    if (!this.host || !this.host.isConnected) return null;
    const r = this.host.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  /** Last status enum set on the host (structural, never DOM text). */
  get status(): HostStatus {
    return this.lastStatus;
  }

  /** Current session-local manual drag offset (copy of internal state). */
  get dragOffset(): { x: number; y: number } {
    return { ...this.manualOffset };
  }

  /**
   * Ensure exactly one Shadow DOM host exists. Reuses an existing host (never
   * duplicates). `onClick` is (re)bound idempotently.
   */
  mount(onClick: CopyAction): void {
    if (this.isMounted) {
      this.onClick = onClick;
      this.bindClick();
      return;
    }
    this.unmount();
    // Re-bind after unmount(): unmount clears onClick, so the fresh-mount
    // callback must be (re)assigned before bindClick() runs.
    this.onClick = onClick;

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute(HOST_ATTR, "true");
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = HOST_STYLE;
    shadow.appendChild(style);

    const btn = document.createElement("button");
    btn.className = "cgl-copy-bubble";
    btn.type = "button";
    btn.setAttribute("aria-label", "Copy centered writing block");
    btn.innerHTML = COPY_ICON_SVG;
    shadow.appendChild(btn);

    const grip = document.createElement("div");
    grip.className = "cgl-drag-handle";
    grip.setAttribute("aria-label", "Move copy button");
    grip.setAttribute("role", "button");
    grip.setAttribute("tabindex", "-1");
    shadow.appendChild(grip);

    const status = document.createElement("div");
    status.className = "cgl-copy-status cgl-visually-hidden";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = STATUS_IDLE;
    shadow.appendChild(status);

    this.host = host;
    this.button = btn;
    this.handle = grip;
    this.statusEl = status;
    this.bindClick();
    this.bindDragStart();

    stampBootId(host);
    document.body.appendChild(host);
  }

  private bindClick(): void {
    if (this.button && this.onClick) {
      this.button.onclick = (): void => this.onClick?.();
    }
  }

  private bindDragStart(): void {
    if (this.handle) {
      this.handle.addEventListener("pointerdown", this.boundPointerDown);
    }
  }

  /** Show/hide the host without recreating it. */
  setVisible(visible: boolean): void {
    if (!this.host) return;
    this.host.setAttribute("data-visible", visible ? "true" : "false");
  }

  /**
   * Position the host against the active block's right edge.
   *
   * `smart` mode: prefer just OUTSIDE the block's right edge; fall back to
   * inside-right when there is insufficient horizontal room; then ADD the
   * session-local manual drag offset and clamp the complete circle within the
   * visible viewport margins (preferring `window.visualViewport` when
   * available). Y stays usefully aligned with the active block, never
   * offscreen. The target element itself is never modified.
   */
  positionAgainst(
    block: HTMLElement,
    mode: "smart" | "top-right" | "middle-right" | "bottom-right",
  ): void {
    if (!this.host) return;
    const rect = block.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      // Temporarily unmeasurable target (responsive reflow crush): keep the
      // last valid bubble position instead of vanishing; the next normal
      // recalculation resumes once geometry returns.
      if (!this.retainLastPosition()) this.setVisible(false);
      return;
    }
    const hostRect = this.host.getBoundingClientRect();
    const hostW = hostRect.width || COPY_BUBBLE_PX;
    const hostH = hostRect.height || COPY_BUBBLE_PX;
    const margin = 6;

    const { vw, vh } = viewportSize();

    let top: number;
    switch (mode) {
      case "top-right":
        top = rect.top;
        break;
      case "bottom-right":
        top = rect.bottom - hostH;
        break;
      case "smart": {
        // Deterministic upper-right anchor: a fixed row offset below the
        // VISIBLE block top, independent of block height. For extremely tall
        // blocks whose DOM top is far above the viewport, anchoring from
        // rect.top would clamp to the browser edge; visibleTop keeps the
        // bubble ~132px below the visible portion instead. The shared clamp
        // below keeps the full circle onscreen; the manual drag offset
        // (applied by the caller path) stays higher priority.
        const visibleTop = Math.max(rect.top, 0);
        top = visibleTop + INITIAL_ROW_OFFSET_PX;
        break;
      }
      case "middle-right":
      default:
        top = rect.top + rect.height / 2 - hostH / 2;
        break;
    }

    // Pin to the right edge of the block, clamped inside the viewport.
    let left = rect.right + margin;
    const fitsOutside = left + hostW <= vw - margin;
    if (!fitsOutside && mode === "smart") {
      // Insufficient horizontal room: place it INSIDE the block's right edge.
      left = rect.right - hostW - margin;
    }
    left = Math.max(margin, Math.min(left, vw - hostW - margin));
    top = Math.max(margin, Math.min(top, vh - hostH - margin));

    // Remember the smart base, then apply the manual drag offset and clamp
    // the FINAL circle fully inside the viewport.
    this.smartBase = { top, left };
    const final = this.clampFinal(top + this.manualOffset.y, left + this.manualOffset.x, hostW, hostH, margin, vw, vh);
    this.lastFinal = final;

    this.host.style.top = `${Math.round(final.top)}px`;
    this.host.style.left = `${Math.round(final.left)}px`;
    this.setVisible(true);
  }

  // --- manual drag (handle-only; never copies) ------------------------------

  private onDragStart(e: PointerEvent): void {
    if (this.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    this.dragging = true;
    this.dragPointerId = e.pointerId;
    this.dragStart = { x: e.clientX, y: e.clientY };
    this.dragOffsetStart = { ...this.manualOffset };
    this.handle?.classList.add("cgl-dragging");
    const h = this.handle;
    if (h) {
      try {
        if (typeof h.setPointerCapture === "function") h.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom / non-mouse pointers: capture is best-effort */
      }
      h.addEventListener("pointermove", this.boundPointerMove);
      h.addEventListener("pointerup", this.boundPointerUp);
      h.addEventListener("pointercancel", this.boundPointerCancel);
    }
  }

  private onDragMove(e: PointerEvent): void {
    if (!this.dragging || !this.host) return;
    if (this.dragPointerId != null && e.pointerId !== this.dragPointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const start = this.dragStart ?? { x: 0, y: 0 };
    const base = this.dragOffsetStart ?? { x: 0, y: 0 };
    this.manualOffset = {
      x: base.x + (e.clientX - start.x),
      y: base.y + (e.clientY - start.y),
    };
    this.applySmartPlusOffset();
  }

  private onDragEnd(e: PointerEvent): void {
    if (!this.dragging) return;
    if (this.dragPointerId != null && e.pointerId !== this.dragPointerId) return;
    e.stopPropagation();
    this.releaseDrag();
  }

  /** Re-apply smart base + current offset, clamped fully onscreen. */
  private applySmartPlusOffset(): void {
    if (!this.host || !this.smartBase) return;
    const hostRect = this.host.getBoundingClientRect();
    const hostW = hostRect.width || COPY_BUBBLE_PX;
    const hostH = hostRect.height || COPY_BUBBLE_PX;
    const margin = 6;
    const { vw, vh } = viewportSize();
    // Clamp the final circle, then fold the clamp back into the offset so no
    // unreachable offscreen offset can accumulate.
    const final = this.clampFinal(
      this.smartBase.top + this.manualOffset.y,
      this.smartBase.left + this.manualOffset.x,
      hostW, hostH, margin, vw, vh,
    );
    this.manualOffset = {
      x: final.left - this.smartBase.left,
      y: final.top - this.smartBase.top,
    };
    this.lastFinal = final;
    this.host.style.top = `${Math.round(final.top)}px`;
    this.host.style.left = `${Math.round(final.left)}px`;
  }

  private clampFinal(
    top: number, left: number,
    hostW: number, hostH: number,
    margin: number, vw: number, vh: number,
  ): { top: number; left: number } {
    return {
      left: Math.max(margin, Math.min(left, vw - hostW - margin)),
      top: Math.max(margin, Math.min(top, vh - hostH - margin)),
    };
  }

  /**
   * Keep the bubble visible at its last valid position, re-clamped into the
   * CURRENT viewport. Used when a still-valid target temporarily loses
   * measurable geometry (or anchoring) during responsive reflow. Returns
   * false when no valid position was ever applied (caller then hides).
   * The remembered position is preserved (not overwritten) so geometry
   * recovery resumes exactly where the bubble was.
   */
  retainLastPosition(): boolean {
    if (!this.host || !this.lastFinal) return false;
    const hostRect = this.host.getBoundingClientRect();
    const hostW = hostRect.width || COPY_BUBBLE_PX;
    const hostH = hostRect.height || COPY_BUBBLE_PX;
    const margin = 6;
    const { vw, vh } = viewportSize();
    const final = this.clampFinal(
      this.lastFinal.top, this.lastFinal.left,
      hostW, hostH, margin, vw, vh,
    );
    this.host.style.top = `${Math.round(final.top)}px`;
    this.host.style.left = `${Math.round(final.left)}px`;
    this.setVisible(true);
    return true;
  }

  /** Detach drag listeners, release capture, clear drag state (offset kept). */
  private releaseDrag(): void {
    const h = this.handle;
    if (h) {
      h.removeEventListener("pointermove", this.boundPointerMove);
      h.removeEventListener("pointerup", this.boundPointerUp);
      h.removeEventListener("pointercancel", this.boundPointerCancel);
      try {
        if (
          this.dragPointerId != null &&
          typeof h.releasePointerCapture === "function" &&
          typeof h.hasPointerCapture === "function" &&
          h.hasPointerCapture(this.dragPointerId)
        ) {
          h.releasePointerCapture(this.dragPointerId);
        }
      } catch {
        /* best-effort */
      }
      h.classList.remove("cgl-dragging");
    }
    this.dragging = false;
    this.dragPointerId = null;
    this.dragStart = null;
    this.dragOffsetStart = null;
  }

  /**
   * Report a status. Only the fixed safe strings are permitted; any other
   * value is coerced to a neutral message so copied text can NEVER enter the
   * status region, the DOM, or logs.
   *
   * Visible success feedback (check icon + accent) originates ONLY from the
   * real `"copied"` transaction outcome — never from a bare click — and
   * reverts after SUCCESS_FEEDBACK_MS without touching semantic state.
   */
  setStatus(status: HostStatus): void {
    this.lastStatus = status;
    if (status === "copied") {
      this.showSuccessFeedback();
    } else {
      this.clearSuccessFeedback();
    }
    if (!this.statusEl) return;
    switch (status) {
      case "copied":
        this.statusEl.textContent = "Copied.";
        break;
      case "requested":
        this.statusEl.textContent = "Copy requested.";
        break;
      case "unavailable":
        this.statusEl.textContent = "Copy unavailable.";
        break;
      case "none":
        this.statusEl.textContent = "Nothing safe to copy.";
        break;
      case "idle":
      default:
        this.statusEl.textContent = STATUS_IDLE;
        break;
    }
  }

  /** Whether the temporary success check is currently shown. */
  get isSuccessVisible(): boolean {
    return this.button?.classList.contains("cgl-success") ?? false;
  }

  private showSuccessFeedback(): void {
    if (this.successTimer != null) {
      clearTimeout(this.successTimer);
      this.successTimer = null;
    }
    if (this.button) {
      this.button.innerHTML = CHECK_ICON_SVG;
      this.button.classList.add("cgl-success");
    }
    // A second successful copy restarts the interval; completion only
    // restores the icon/style, never semantic copied state.
    this.successTimer = setTimeout(() => {
      this.successTimer = null;
      this.clearSuccessFeedback();
    }, SUCCESS_FEEDBACK_MS);
  }

  private clearSuccessFeedback(): void {
    if (this.successTimer != null) {
      clearTimeout(this.successTimer);
      this.successTimer = null;
    }
    if (this.button) {
      this.button.innerHTML = COPY_ICON_SVG;
      this.button.classList.remove("cgl-success");
    }
  }

  /** Remove the host, drag state, feedback timer, listeners, references. Idempotent. */
  unmount(): void {
    this.releaseDrag();
    if (this.successTimer != null) {
      clearTimeout(this.successTimer);
      this.successTimer = null;
    }
    if (this.button) this.button.onclick = null;
    if (this.handle) this.handle.removeEventListener("pointerdown", this.boundPointerDown);
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
    this.button = null;
    this.handle = null;
    this.statusEl = null;
    this.onClick = null;
    this.manualOffset = { x: 0, y: 0 };
    this.smartBase = null;
    this.lastFinal = null;
  }
}

/** Visible viewport size, preferring visualViewport when available. */
function viewportSize(): { vw: number; vh: number } {
  const vv = (globalThis as unknown as {
    visualViewport?: { width: number; height: number };
  }).visualViewport;
  return {
    vw: Math.round(vv?.width ?? window.innerWidth ?? 0),
    vh: Math.round(vv?.height ?? window.innerHeight ?? 0),
  };
}

export { HOST_ID, HOST_ATTR };
