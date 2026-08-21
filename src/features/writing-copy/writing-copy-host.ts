/**
 * Extension-owned Shadow DOM floating copy control host.
 *
 * Exactly one host exists per page. It is appended to `document.body` (never
 * inside a ChatGPT writing block), fully self-contained (Shadow DOM, no
 * external assets/fonts/styles), and carries an extension-owned id/attribute so
 * the shared structural MutationObserver can ignore it (no mutation loop).
 *
 * The host shows:
 *  - a single button (aria-label "Copy centered writing block", type="button",
 *    visible focus style);
 *  - a contained status region (role="status", aria-live="polite") that MAY
 *    only ever show the fixed strings: "Copied.", "Copy requested.",
 *    "Copy unavailable.", "Nothing safe to copy." — never copied text, titles,
 *    URLs, or excerpts.
 *
 * Position modes (top-right / middle-right / bottom-right) position the host
 * relative to the active block's right edge using fixed positioning computed
 * from getBoundingClientRect, clamped within the viewport. The target element
 * itself is never modified.
 *
 * Repeated apply never creates duplicate hosts; teardown removes the host,
 * events, and timers.
 */

const HOST_ID = "cgl-writing-copy-host";
const HOST_ATTR = "data-cgl-writing-copy-host";
const STATUS_IDLE = "Nothing safe to copy.";

const HOST_STYLE = `
  :host {
    position: fixed;
    z-index: 2147483645;
    display: none;
    font: 600 12px/1.2 system-ui, sans-serif;
  }
  :host([data-visible="true"]) { display: block; }
  .cgl-copy-btn {
    box-sizing: border-box;
    border: 1px solid #2a3142;
    background: #1c2230;
    color: #e7eaf0;
    cursor: pointer;
    border-radius: 6px;
    padding: 6px 10px;
    outline: none;
  }
  .cgl-copy-btn:focus-visible {
    box-shadow: 0 0 0 2px #4c8dff;
    border-color: #4c8dff;
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

export class WritingCopyHost {
  private host: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private onClick: CopyAction | null = null;

  /** True when the host exists in the DOM. */
  get isMounted(): boolean {
    return this.host != null && this.host.isConnected;
  }

  /**
   * Ensure exactly one Shadow DOM host exists. Reuses an existing host (never
   * duplicates). `onClick` is (re)bound idempotently.
   */
  mount(onClick: CopyAction): void {
    this.onClick = onClick;
    if (this.isMounted) {
      this.bindClick();
      return;
    }
    this.unmount();

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute(HOST_ATTR, "true");
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = HOST_STYLE;
    shadow.appendChild(style);

    const btn = document.createElement("button");
    btn.className = "cgl-copy-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "Copy centered writing block");
    btn.textContent = "Copy";
    shadow.appendChild(btn);

    const status = document.createElement("div");
    status.className = "cgl-copy-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = STATUS_IDLE;
    shadow.appendChild(status);

    this.host = host;
    this.button = btn;
    this.statusEl = status;
    this.bindClick();

    document.body.appendChild(host);
  }

  private bindClick(): void {
    if (this.button && this.onClick) {
      this.button.onclick = (): void => this.onClick?.();
    }
  }

  /** Show/hide the host without recreating it. */
  setVisible(visible: boolean): void {
    if (!this.host) return;
    this.host.setAttribute("data-visible", visible ? "true" : "false");
  }

  /** Position the host against the active block's right edge. */
  positionAgainst(block: HTMLElement, mode: "top-right" | "middle-right" | "bottom-right"): void {
    if (!this.host) return;
    const rect = block.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.setVisible(false);
      return;
    }
    const hostRect = this.host.getBoundingClientRect();
    const hostW = hostRect.width || 80;
    const hostH = hostRect.height || 32;
    const margin = 6;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;

    let top: number;
    switch (mode) {
      case "top-right":
        top = rect.top;
        break;
      case "bottom-right":
        top = rect.bottom - hostH;
        break;
      case "middle-right":
      default:
        top = rect.top + rect.height / 2 - hostH / 2;
        break;
    }

    // Pin to the right edge of the block, clamped inside the viewport.
    let left = rect.right + margin;
    if (left + hostW > vw - margin) left = rect.right - hostW - margin;
    left = Math.max(margin, Math.min(left, vw - hostW - margin));
    top = Math.max(margin, Math.min(top, vh - hostH - margin));

    this.host.style.top = `${Math.round(top)}px`;
    this.host.style.left = `${Math.round(left)}px`;
    this.setVisible(true);
  }

  /**
   * Report a status. Only the fixed safe strings are permitted; any other
   * value is coerced to a neutral message so copied text can NEVER enter the
   * status region, the DOM, or logs.
   */
  setStatus(status: "copied" | "requested" | "unavailable" | "idle" | "none"): void {
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

  /** Remove the host, its listeners, and references. Idempotent. */
  unmount(): void {
    if (this.button) this.button.onclick = null;
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
    this.button = null;
    this.statusEl = null;
    this.onClick = null;
  }
}

export { HOST_ID, HOST_ATTR };
