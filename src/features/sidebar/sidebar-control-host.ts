import { SIDEBAR_HOST_ID } from "./sidebar-detection.js";

/**
 * Extension-owned control host (Shadow DOM).
 *
 * Creates exactly one on-page host for `hover` (edge rail) or `button` modes.
 * The host is fully self-contained: an open or closed Shadow Root, no external
 * images/fonts/styles, all styles inline in the shadow. It is appended to
 * `document.body` (never inside the ChatGPT sidebar), carries an
 * extension-owned id so the MutationObserver can ignore it, and exposes
 * lifecycle callbacks wired by the controller. Repeated apply/refresh never
 * creates duplicate hosts; teardown removes the host and its listeners.
 */

export type SidebarHostKind = "hover" | "button";

export interface SidebarControlHostHandlers {
  /** Pointer/focus entered the rail (hover mode). */
  onRailEnter?: () => void;
  /** Pointer/focus left the rail (hover mode). */
  onRailLeave?: () => void;
  /** Button clicked (button mode). */
  onButtonClick?: () => void;
  /** Escape pressed while the sidebar is open (button mode). */
  onEscape?: () => void;
}

const HOST_STYLE = `
  :host {
    position: fixed;
    top: 0;
    bottom: 0;
    width: 22px;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  :host([data-edge="left"]) { left: 0; }
  :host([data-edge="right"]) { right: 0; }
  .cgl-rail, .cgl-btn {
    box-sizing: border-box;
    border: 1px solid #2a3142;
    background: #1c2230;
    color: #e7eaf0;
    cursor: pointer;
    font: 600 12px/1.2 system-ui, sans-serif;
    border-radius: 6px;
    padding: 8px 4px;
    outline: none;
  }
  .cgl-rail { writing-mode: vertical-rl; text-orientation: mixed; }
  .cgl-btn { writing-mode: horizontal-tb; padding: 6px 10px; }
  .cgl-rail:focus-visible, .cgl-btn:focus-visible {
    box-shadow: 0 0 0 2px #4c8dff;
    border-color: #4c8dff;
  }
`;

export class SidebarControlHost {
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private kind: SidebarHostKind | null = null;
  private handlers: SidebarControlHostHandlers = {};
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  /** True when a host currently exists in the DOM. */
  get isMounted(): boolean {
    return this.host != null && this.host.isConnected;
  }

  /** Current host kind, or null when unmounted. */
  get currentKind(): SidebarHostKind | null {
    return this.kind;
  }

  /**
   * Ensure a host of the given kind exists on the page. Reuses an existing host
   * (never duplicates). `edge` ("left" | "right") positions the host on the
   * same viewport edge as the sidebar. `handlers` are (re)bound idempotently.
   */
  mount(kind: SidebarHostKind, edge: "left" | "right", handlers: SidebarControlHostHandlers): void {
    this.handlers = handlers;
    if (this.isMounted && this.kind === kind) {
      this.applyEdge(edge);
      return;
    }
    this.unmount();
    // unmount() resets handlers to {}; re-bind the supplied handlers so the
    // freshly created rail/focus listeners resolve to live callbacks.
    this.handlers = handlers;

    const host = document.createElement("div");
    host.id = SIDEBAR_HOST_ID;
    host.setAttribute("data-cgl-sidebar-host", "true");
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = HOST_STYLE;
    shadow.appendChild(style);

    let control: HTMLElement;
    if (kind === "hover") {
      const rail = document.createElement("div");
      rail.className = "cgl-rail";
      rail.setAttribute("role", "button");
      rail.setAttribute("tabindex", "0");
      rail.setAttribute("aria-label", "Show ChatGPT sidebar");
      control = rail;
      rail.addEventListener("pointerenter", () => this.handlers.onRailEnter?.());
      rail.addEventListener("pointerleave", () => this.handlers.onRailLeave?.());
      rail.addEventListener("focusin", () => this.handlers.onRailEnter?.());
      rail.addEventListener("focusout", () => this.handlers.onRailLeave?.());
    } else {
      const btn = document.createElement("button");
      btn.className = "cgl-btn";
      btn.type = "button";
      btn.textContent = "☰";
      btn.setAttribute("aria-label", "Toggle ChatGPT sidebar");
      btn.setAttribute("aria-expanded", "false");
      control = btn;
      btn.addEventListener("click", () => this.handlers.onButtonClick?.());
    }
    shadow.appendChild(control);

    this.host = host;
    this.shadow = shadow;
    this.kind = kind;
    this.applyEdge(edge);

    // Escape closes the sidebar when open (button mode); handler checks state.
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.handlers.onEscape?.();
    };
    document.addEventListener("keydown", this.keyHandler);

    document.body.appendChild(host);
  }

  private applyEdge(edge: "left" | "right"): void {
    if (!this.host) return;
    this.host.setAttribute("data-edge", edge);
  }

  /** Update the button's aria-expanded state. No-op for hover rail. */
  setButtonExpanded(expanded: boolean): void {
    if (!this.shadow) return;
    const btn = this.shadow.querySelector(".cgl-btn");
    if (btn) btn.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  /** Remove the host and its listeners entirely. Idempotent. */
  unmount(): void {
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
    this.shadow = null;
    this.kind = null;
    this.handlers = {};
  }
}
