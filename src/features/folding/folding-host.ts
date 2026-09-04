/**
 * Extension-owned Shadow DOM folding controls host (Phase 5).
 *
 * Exactly one host exists per page, appended to `document.body` (never
 * inside ChatGPT content), fully self-contained (Shadow DOM, no external
 * assets), and marked with an extension-owned attribute so the structural
 * observer ignores it. It owns:
 *  - one compact toggle button per long code block ("Expand"/"Collapse");
 *  - one toggle button per long assistant response;
 *  - one global "Expand all"/"Collapse all" button for long code blocks.
 *
 * Buttons are `position: fixed` from live `getBoundingClientRect` geometry,
 * clamped in-viewport, repositioned through ONE rAF-coalesced path on
 * scroll/resize. The controller owns all fold state; the host only renders
 * callbacks (`onToggleCode`, `onToggleResponse`, `onExpandAll`,
 * `onCollapseAll`). Repeated sync never duplicates buttons; teardown removes
 * the host, listeners, timers, and references.
 */

const HOST_ID = "cgl-folding-host";
const HOST_ATTR = "data-cgl-folding-host";

const HOST_STYLE = `
  :host {
    position: fixed;
    inset: 0;
    z-index: 2147483644;
    pointer-events: none;
    font: 600 12px/1.2 system-ui, sans-serif;
  }
  .cgl-fold-btn {
    position: fixed;
    box-sizing: border-box;
    border: 1px solid #2a3142;
    background: #1c2230;
    color: #e7eaf0;
    cursor: pointer;
    border-radius: 6px;
    padding: 4px 8px;
    outline: none;
    pointer-events: auto;
    white-space: nowrap;
    user-select: none;
  }
  .cgl-fold-btn:focus-visible {
    box-shadow: 0 0 0 2px #4c8dff;
    border-color: #4c8dff;
  }
  .cgl-fold-global {
    background: #232b3a;
  }
`;

export interface FoldingHostCallbacks {
  onToggleCode: (target: HTMLElement) => void;
  onToggleResponse: (target: HTMLElement) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

interface ButtonRecord {
  button: HTMLButtonElement;
  kind: "code" | "response";
  target: HTMLElement;
}

export class FoldingHost {
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private callbacks: FoldingHostCallbacks | null = null;
  private buttons = new Map<HTMLElement, ButtonRecord>();
  private globalButton: HTMLButtonElement | null = null;
  private globalMode: "expand" | "collapse" | null = null;

  get isMounted(): boolean {
    return this.host != null && this.host.isConnected;
  }

  /** Ensure exactly one host exists; (re)bind callbacks idempotently. */
  mount(callbacks: FoldingHostCallbacks): void {
    this.callbacks = callbacks;
    if (this.isMounted) return;
    this.unmount();
    // Re-bind after unmount(): unmount clears callbacks, so the fresh-mount
    // callbacks must be (re)assigned before any button is created.
    this.callbacks = callbacks;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute(HOST_ATTR, "true");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = HOST_STYLE;
    shadow.appendChild(style);
    this.host = host;
    this.shadow = shadow;
    document.body.appendChild(host);
  }

  /**
   * Reconcile buttons against live targets. `codes`/`responses` map each
   * target to its current folded state. Removes buttons for gone targets,
   * creates buttons for new ones, updates labels, and repositions all.
   * `anyCodeFolded` selects the global button mode (null hides it).
   */
  sync(
    codes: Map<HTMLElement, boolean>,
    responses: Map<HTMLElement, boolean>,
    anyCodeFolded: boolean | null,
  ): void {
    if (!this.shadow) return;
    const wanted = new Set<HTMLElement>([...codes.keys(), ...responses.keys()]);
    for (const [target, record] of [...this.buttons]) {
      if (!wanted.has(target) || !target.isConnected) {
        record.button.remove();
        this.buttons.delete(target);
      }
    }
    for (const [target, folded] of codes) {
      this.ensureButton(target, "code", folded ? "Expand" : "Collapse");
    }
    for (const [target, folded] of responses) {
      this.ensureButton(
        target,
        "response",
        folded ? "Expand response" : "Collapse response",
      );
    }
    this.syncGlobal(anyCodeFolded);
    this.reposition();
  }

  private ensureButton(
    target: HTMLElement,
    kind: "code" | "response",
    label: string,
  ): void {
    const existing = this.buttons.get(target);
    if (existing) {
      if (existing.button.textContent !== label) {
        existing.button.textContent = label;
      }
      existing.button.setAttribute(
        "aria-label",
        kind === "code" ? `${label} code block` : label,
      );
      return;
    }
    const btn = document.createElement("button");
    btn.className = "cgl-fold-btn";
    btn.type = "button";
    btn.textContent = label;
    btn.setAttribute(
      "aria-label",
      kind === "code" ? `${label} code block` : label,
    );
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (kind === "code") this.callbacks?.onToggleCode(target);
      else this.callbacks?.onToggleResponse(target);
    });
    this.shadow!.appendChild(btn);
    this.buttons.set(target, { button: btn, kind, target });
  }

  private syncGlobal(anyCodeFolded: boolean | null): void {
    if (anyCodeFolded === null) {
      if (this.globalButton) {
        this.globalButton.remove();
        this.globalButton = null;
      }
      this.globalMode = null;
      return;
    }
    const mode = anyCodeFolded ? "expand" : "collapse";
    const label = mode === "expand" ? "Expand all" : "Collapse all";
    if (!this.globalButton) {
      const btn = document.createElement("button");
      btn.className = "cgl-fold-btn cgl-fold-global";
      btn.type = "button";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.globalMode === "expand") this.callbacks?.onExpandAll();
        else this.callbacks?.onCollapseAll();
      });
      this.shadow!.appendChild(btn);
      this.globalButton = btn;
    }
    if (this.globalMode !== mode) {
      this.globalMode = mode;
      this.globalButton.textContent = label;
      this.globalButton.setAttribute("aria-label", `${label} code blocks`);
    }
  }

  /** Reposition every button against live target geometry (clamped). */
  reposition(): void {
    if (!this.host || !this.host.isConnected) return;
    const margin = 6;
    const vw = Math.round(window.innerWidth ?? 0);
    const vh = Math.round(window.innerHeight ?? 0);
    for (const { button, target } of this.buttons.values()) {
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        button.style.display = "none";
        continue;
      }
      button.style.display = "";
      // Pin to the target's top-right, clamped fully onscreen.
      const w = button.offsetWidth || 90;
      const h = button.offsetHeight || 26;
      const left = Math.max(margin, Math.min(rect.right - w - margin, vw - w - margin));
      const top = Math.max(margin, Math.min(rect.top + margin, vh - h - margin));
      button.style.left = `${Math.round(left)}px`;
      button.style.top = `${Math.round(top)}px`;
    }
    if (this.globalButton) {
      const w = this.globalButton.offsetWidth || 110;
      const h = this.globalButton.offsetHeight || 26;
      this.globalButton.style.left = `${Math.max(margin, vw - w - margin)}px`;
      this.globalButton.style.top = `${Math.max(margin, vh - h - margin)}px`;
    }
  }

  /** Remove the host, its buttons, callbacks, and references. Idempotent. */
  unmount(): void {
    this.buttons.clear();
    this.globalButton = null;
    this.globalMode = null;
    this.callbacks = null;
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
    this.shadow = null;
  }
}

export { HOST_ID, HOST_ATTR };
