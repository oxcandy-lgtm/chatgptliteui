/**
 * Extension-owned Shadow DOM folding controls host (Phase 5).
 *
 * Exactly one host exists per page, appended to `document.body` (never
 * inside ChatGPT content), fully self-contained (Shadow DOM, no external
 * assets), and marked with an extension-owned attribute so the structural
 * observer ignores it. It renders a tiny HUD — at most TWO buttons:
 *  - one active-item toggle bound to the single currently relevant visible
 *    long target ("Expand/Collapse code|response"), hidden when none;
 *  - one optional global "Expand all"/"Collapse all" for long code blocks.
 *
 * The host retains ONLY the current active target (for its click callback);
 * all candidate discovery lives in short-lived controller passes. Buttons
 * are `position: fixed` from live geometry, clamped in-viewport. Repeated
 * sync never duplicates buttons; teardown removes the host, listeners,
 * timers, and references.
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

/** The single visible fold target the HUD item button is bound to. */
export interface ActiveFoldTarget {
  kind: "code" | "response";
  target: HTMLElement;
  folded: boolean;
}

export class FoldingHost {
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private callbacks: FoldingHostCallbacks | null = null;
  private itemButton: HTMLButtonElement | null = null;
  private itemTarget: HTMLElement | null = null;
  private itemKind: "code" | "response" | null = null;
  private globalButton: HTMLButtonElement | null = null;
  private globalMode: "expand" | "collapse" | null = null;

  get isMounted(): boolean {
    return this.host != null && this.host.isConnected;
  }

  /** Mounted button elements currently in the DOM (never more than 2). */
  get buttonCount(): number {
    let count = 0;
    if (this.itemButton?.isConnected) count++;
    if (this.globalButton?.isConnected) count++;
    return count;
  }

  /** The single retained active target, or null when the item hides. */
  get retainedTarget(): HTMLElement | null {
    return this.itemTarget && this.itemTarget.isConnected
      ? this.itemTarget
      : null;
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
   * Reconcile the HUD against the single active target. Binds, relabels, or
   * removes the one item button; shows/hides the global button by mode
   * (null hides it); then repositions. Never retains offscreen targets.
   */
  sync(
    active: ActiveFoldTarget | null,
    anyCodeFolded: boolean | null,
  ): void {
    if (!this.shadow) return;
    if (!active || !active.target.isConnected) {
      if (this.itemButton) {
        this.itemButton.remove();
        this.itemButton = null;
      }
      this.itemTarget = null;
      this.itemKind = null;
    } else {
      const label =
        active.kind === "code"
          ? active.folded
            ? "Expand code"
            : "Collapse code"
          : active.folded
            ? "Expand response"
            : "Collapse response";
      if (!this.itemButton) {
        const btn = document.createElement("button");
        btn.className = "cgl-fold-btn";
        btn.type = "button";
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const target = this.itemTarget;
          if (!target) return;
          if (this.itemKind === "code") this.callbacks?.onToggleCode(target);
          else this.callbacks?.onToggleResponse(target);
        });
        this.shadow.appendChild(btn);
        this.itemButton = btn;
      }
      if (this.itemButton.textContent !== label) {
        this.itemButton.textContent = label;
      }
      this.itemButton.setAttribute("aria-label", label);
      this.itemTarget = active.target;
      this.itemKind = active.kind;
    }
    this.syncGlobal(anyCodeFolded);
    this.reposition();
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

  /** Reposition the (at most two) buttons against live geometry, clamped. */
  reposition(): void {
    if (!this.host || !this.host.isConnected) return;
    const margin = 6;
    const vw = Math.round(window.innerWidth ?? 0);
    const vh = Math.round(window.innerHeight ?? 0);
    if (this.itemButton && this.itemTarget) {
      const rect = this.itemTarget.getBoundingClientRect();
      if (
        !this.itemTarget.isConnected ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        this.itemButton.style.display = "none";
      } else {
        this.itemButton.style.display = "";
        const w = this.itemButton.offsetWidth || 110;
        const h = this.itemButton.offsetHeight || 26;
        const left = Math.max(margin, Math.min(rect.right - w - margin, vw - w - margin));
        const top = Math.max(margin, Math.min(rect.top + margin, vh - h - margin));
        this.itemButton.style.left = `${Math.round(left)}px`;
        this.itemButton.style.top = `${Math.round(top)}px`;
      }
    }
    if (this.globalButton) {
      const w = this.globalButton.offsetWidth || 110;
      const h = this.globalButton.offsetHeight || 26;
      this.globalButton.style.left = `${Math.max(margin, vw - w - margin)}px`;
      this.globalButton.style.top = `${Math.round(Math.max(margin, vh - h - margin))}px`;
    }
  }

  /** Remove the host, its buttons, callbacks, and references. Idempotent. */
  unmount(): void {
    if (this.itemButton) {
      this.itemButton.remove();
      this.itemButton = null;
    }
    this.itemTarget = null;
    this.itemKind = null;
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
