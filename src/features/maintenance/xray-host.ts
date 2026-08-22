/**
 * CGL X-Ray — extension-owned Shadow DOM maintenance host.
 *
 * One host element (`data-cgl-xray-host`) appended to document.body with an
 * open Shadow root containing:
 *  - the viewport-level HEARTBEAT (magenta/cyan frame + badge + tint) that is
 *    independent of any ChatGPT selector succeeding;
 *  - the compact maintenance PANEL (scan controls + status rows);
 *  - the PICKER overlay (outline box following the hovered element).
 *
 * All UI lives in Shadow DOM; no ChatGPT classes/styles/structure are
 * touched. teardown() removes everything. No chat text is ever rendered.
 */

export const XRAY_HOST_ATTR = "data-cgl-xray-host";

const HOST_STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .xray-frame {
    position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;
    border: 3px solid magenta;
    box-shadow: inset 0 0 0 2px cyan;
    background: rgba(255, 0, 255, 0.03);
  }
  .xray-badge {
    position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647; pointer-events: none;
    background: #ff00ff; color: #000; font-weight: 700; font-size: 12px;
    padding: 4px 12px; border-radius: 4px; letter-spacing: 1px;
    border: 2px solid cyan;
  }
  .xray-panel {
    position: fixed; top: 44px; right: 12px; z-index: 2147483647;
    width: 300px; max-height: calc(100vh - 70px); overflow: auto;
    background: #14181f; color: #d7dde8;
    border: 2px solid #ff00ff; border-radius: 8px; padding: 10px;
  }
  .xray-title { font-weight: 700; color: #ff5cff; margin-bottom: 6px; letter-spacing: 1px; }
  .xray-row { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; white-space: nowrap; overflow: hidden; }
  .xray-row .k { color: #8fa0b8; overflow: hidden; text-overflow: ellipsis; }
  .xray-row .v { color: #e7eaf0; font-weight: 600; }
  .xray-row .v.pass { color: #35d07f; }
  .xray-row .v.fail { color: #ff5c5c; }
  .xray-row .v.warn { color: #ffd166; }
  .xray-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .xray-btns button {
    background: #232b3a; color: #e7eaf0; border: 1px solid #3a465c;
    border-radius: 5px; padding: 5px 8px; cursor: pointer; font-weight: 600;
  }
  .xray-btns button:hover { border-color: #ff00ff; }
  .xray-btns button:focus-visible { outline: 2px solid cyan; }
  .xray-btns button.active { background: #ff00ff; color: #000; }
  .xray-blocker { margin-top: 8px; padding: 6px; border-radius: 5px; background: #2b1a2b; color: #ff9df5; font-weight: 700; word-break: break-all; white-space: normal; }
  .xray-picker-box {
    position: fixed; z-index: 2147483647; pointer-events: none;
    outline: 3px solid #00ffff; outline-offset: -1px;
    background: rgba(0, 255, 255, 0.12);
  }
  .xray-hint {
    position: fixed; bottom: 10px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647; pointer-events: none;
    background: #00ffff; color: #000; font-weight: 700; padding: 4px 12px; border-radius: 4px;
  }
`;

export interface XrayStatusInput {
  rows: { k: string; v: string; tone?: "pass" | "fail" | "warn" }[];
  blocker: string;
  pickerActive: boolean;
}

export class XrayHost {
  private host: HTMLElement | null = null;
  private rowsEl: HTMLElement | null = null;
  private blockerEl: HTMLElement | null = null;
  private pickerBox: HTMLElement | null = null;
  private hint: HTMLElement | null = null;

  private pickBtnRef: HTMLButtonElement | null = null;

  get isMounted(): boolean {
    return this.host != null && this.host.isConnected;
  }

  /** Mount the heartbeat + panel. Idempotent (never duplicates). */
  mount(handlers: {
    refresh: () => void;
    pick: () => void;
    copy: () => void;
    deep: () => void;
    close: () => void;
  }): void {
    if (this.isMounted) return;

    const host = document.createElement("div");
    host.setAttribute(XRAY_HOST_ATTR, "true");
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = HOST_STYLE;
    shadow.appendChild(style);

    const frame = document.createElement("div");
    frame.className = "xray-frame";
    shadow.appendChild(frame);

    const badge = document.createElement("div");
    badge.className = "xray-badge";
    badge.textContent = "CGL X-RAY ACTIVE";
    shadow.appendChild(badge);

    this.pickerBox = document.createElement("div");
    this.pickerBox.className = "xray-picker-box";
    this.pickerBox.style.display = "none";
    shadow.appendChild(this.pickerBox);

    this.hint = document.createElement("div");
    this.hint.className = "xray-hint";
    this.hint.textContent = "X-RAY PICK: click the target element";
    this.hint.style.display = "none";
    shadow.appendChild(this.hint);

    const panel = document.createElement("div");
    panel.className = "xray-panel";

    const title = document.createElement("div");
    title.className = "xray-title";
    title.textContent = "CGL X-RAY";
    panel.appendChild(title);

    this.rowsEl = document.createElement("div");
    panel.appendChild(this.rowsEl);

    this.blockerEl = document.createElement("div");
    this.blockerEl.className = "xray-blocker";
    panel.appendChild(this.blockerEl);

    const btns = document.createElement("div");
    btns.className = "xray-btns";
    const mk = (label: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
      btns.appendChild(b);
      return b;
    };
    mk("Refresh scan", handlers.refresh);
    this.pickBtnRef = mk("Pick element", handlers.pick);
    mk("Copy AI report", handlers.copy);
    mk("Deep scan", handlers.deep);
    mk("Close X-Ray", handlers.close);
    panel.appendChild(btns);

    shadow.appendChild(panel);
    this.host = host;
    document.body.appendChild(host);
  }

  /** Render status rows + blocker line. Structure only, never chat text. */
  setStatus(status: XrayStatusInput): void {
    if (!this.rowsEl || !this.blockerEl) return;
    this.rowsEl.textContent = "";
    for (const row of status.rows) {
      const r = document.createElement("div");
      r.className = "xray-row";
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = row.k;
      const v = document.createElement("span");
      v.className = `v${row.tone ? ` ${row.tone}` : ""}`;
      v.textContent = row.v;
      r.appendChild(k);
      r.appendChild(v);
      this.rowsEl.appendChild(r);
    }
    this.blockerEl.textContent = status.blocker;
    if (this.pickBtnRef) {
      this.pickBtnRef.classList.toggle("active", status.pickerActive);
    }
  }

  /** Picker overlay: outline the element under the pointer. */
  showPickerBox(rect: { x: number; y: number; w: number; h: number } | null): void {
    if (!this.pickerBox) return;
    if (!rect || rect.w <= 0 || rect.h <= 0) {
      this.pickerBox.style.display = "none";
      return;
    }
    this.pickerBox.style.display = "block";
    this.pickerBox.style.left = `${rect.x}px`;
    this.pickerBox.style.top = `${rect.y}px`;
    this.pickerBox.style.width = `${rect.w}px`;
    this.pickerBox.style.height = `${rect.h}px`;
  }

  setPickerMode(active: boolean): void {
    if (this.hint) this.hint.style.display = active ? "block" : "none";
    if (!active) this.showPickerBox(null);
  }

  /** Remove the host and every heartbeat/picker element. Idempotent. */
  unmount(): void {
    this.pickBtnRef = null;
    this.rowsEl = null;
    this.blockerEl = null;
    this.pickerBox = null;
    this.hint = null;
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
  }
}
