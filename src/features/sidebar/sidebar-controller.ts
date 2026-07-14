import type { Settings, SidebarMode } from "../../shared/types.js";
import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import {
  effectiveSidebarOpen,
  freshTransientState,
  modeRequiresControlHost,
  type SidebarTransientState,
} from "./sidebar-state.js";
import {
  clearAllSidebarMarkers,
  markSidebar,
  unmarkSidebar,
} from "./sidebar-markers.js";
import { findSafeSidebarTarget, SIDEBAR_HOST_ID } from "./sidebar-detection.js";
import { SidebarControlHost } from "./sidebar-control-host.js";

/**
 * Sidebar controller (Phase 3).
 *
 * Strictly non-destructive. The only permitted mutation on the detected
 * ChatGPT sidebar is ONE extension-owned boolean marker
 * (`data-cgl-sidebar-target`). Hiding is performed by adding the
 * `cgl-sidebar-closed` root class so guarded CSS hides the marked element;
 * showing removes the class so the official stylesheet controls layout again.
 *
 * The configured mode (from storage) is the persistent truth. Pointer, focus,
 * button, Escape, and keyboard operations affect only transient state. A
 * popup/options mode change clears transient state. Restoration removes every
 * `cgl-sidebar-*` class, marker, Shadow DOM host, listener, timer, and
 * retained reference — idempotently.
 */

const CLOSED_CLASS = "cgl-sidebar-closed";
const ROOT_SIDEBAR_CLASSES = [CLOSED_CLASS] as const;

/** Debounce before closing a hover sidebar after pointer/focus leaves. */
const HOVER_CLOSE_MS = 200;

export class SidebarController {
  private readonly root: HTMLElement;
  private readonly adapter: ChatGptAdapter;
  private readonly host: SidebarControlHost;

  private configuredMode: SidebarMode = "visible";
  private transient: SidebarTransientState = freshTransientState();
  private detectedSidebar: HTMLElement | null = null;
  private enabled = true;

  private hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bound handlers retained so they can be removed on teardown. */
  private sidebarEnterHandler: (() => void) | null = null;
  private sidebarLeaveHandler: (() => void) | null = null;

  constructor(root: HTMLElement, adapter: ChatGptAdapter) {
    this.root = root;
    this.adapter = adapter;
    this.host = new SidebarControlHost();
  }

  // --- public state accessors (tests) -------------------------------------

  get mode(): SidebarMode {
    return this.configuredMode;
  }

  get transientState(): Readonly<SidebarTransientState> {
    return this.transient;
  }

  get target(): HTMLElement | null {
    return this.detectedSidebar;
  }

  get isHostMounted(): boolean {
    return this.host.isMounted;
  }

  // --- apply / restore -----------------------------------------------------

  /**
   * Apply the configured sidebar mode. Complete no-op (official UI untouched)
   * when disabled, or when `visible` with no temporary override. Otherwise it
   * detects + marks the target, mounts a control host when required, and sets
   * the closed class per effective visibility.
   */
  apply(settings: Settings): void {
    this.restore();
    this.enabled = settings.enabled;
    this.configuredMode = settings.sidebar.mode;

    if (!this.enabled) {
      this.detectedSidebar = null;
      return;
    }
    if (this.configuredMode === "visible" && this.transient.temporaryOverride === "none") {
      // Official sidebar preserved exactly; no class, marker, or host.
      this.detectedSidebar = null;
      return;
    }

    this.bindTarget();
  }

  /** Re-detect and rebind after SPA route change or structural mutation. */
  refresh(_settings: Settings): void {
    if (!this.enabled) return;
    if (this.configuredMode === "visible" && this.transient.temporaryOverride === "none") {
      return;
    }
    // Preserve transient override; only refresh detection + markers + host.
    this.bindTarget();
  }

  /** Internal: detect, mark, mount host, and update closed class. */
  private bindTarget(): void {
    const target = findSafeSidebarTarget(this.adapter);
    // Release the stale marker first if the element changed.
    if (this.detectedSidebar && this.detectedSidebar !== target) {
      unmarkSidebar(this.detectedSidebar);
      this.detachSidebarListeners();
    }
    this.detectedSidebar = target;

    if (!target) {
      // Detection failed: official UI unchanged, no control host, no classes.
      this.host.unmount();
      this.root.classList.remove(CLOSED_CLASS);
      return;
    }

    markSidebar(target);
    this.attachSidebarListeners(target);

    const edge = this.detectSidebarEdge(target);
    if (modeRequiresControlHost(this.configuredMode)) {
      const kind = this.configuredMode === "hover" ? "hover" : "button";
      this.host.mount(kind, edge, {
        onRailEnter: () => this.onRailEnter(),
        onRailLeave: () => this.onRailLeave(),
        onButtonClick: () => this.onButtonClick(),
        onEscape: () => this.onEscape(),
      });
      if (this.configuredMode === "button") {
        this.host.setButtonExpanded(this.transient.buttonOpen);
      }
    } else {
      this.host.unmount();
    }

    this.updateClosedClass();
  }

  /** Determine whether the sidebar sits on the left or right viewport edge. */
  private detectSidebarEdge(target: HTMLElement): "left" | "right" {
    const rect = target.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.left === 0) {
      return "left"; // default without modifying ChatGPT layout
    }
    const viewportMid = (window.innerWidth || 0) / 2;
    return rect.left < viewportMid ? "left" : "right";
  }

  /** Add/remove the closed root class to reflect effective visibility. */
  private updateClosedClass(): void {
    const open = effectiveSidebarOpen(this.configuredMode, this.transient);
    this.root.classList.toggle(CLOSED_CLASS, !open);
  }

  // --- pointer / focus (hover) ---------------------------------------------

  private onRailEnter(): void {
    if (this.configuredMode !== "hover") return;
    this.clearHoverCloseTimer();
    this.transient.hoverActive = true;
    this.updateClosedClass();
  }

  private onRailLeave(): void {
    if (this.configuredMode !== "hover") return;
    this.scheduleHoverClose();
  }

  private scheduleHoverClose(): void {
    this.clearHoverCloseTimer();
    this.hoverCloseTimer = setTimeout(() => {
      this.transient.hoverActive = false;
      this.updateClosedClass();
    }, HOVER_CLOSE_MS);
  }

  private clearHoverCloseTimer(): void {
    if (this.hoverCloseTimer) {
      clearTimeout(this.hoverCloseTimer);
      this.hoverCloseTimer = null;
    }
  }

  private attachSidebarListeners(target: HTMLElement): void {
    this.detachSidebarListeners();
    this.sidebarEnterHandler = () => this.onSidebarEnter();
    this.sidebarLeaveHandler = () => this.onSidebarLeave();
    target.addEventListener("pointerenter", this.sidebarEnterHandler);
    target.addEventListener("pointerleave", this.sidebarLeaveHandler);
    target.addEventListener("focusin", this.sidebarEnterHandler);
    target.addEventListener("focusout", this.sidebarLeaveHandler);
  }

  private detachSidebarListeners(): void {
    if (this.detectedSidebar && this.sidebarEnterHandler && this.sidebarLeaveHandler) {
      this.detectedSidebar.removeEventListener("pointerenter", this.sidebarEnterHandler);
      this.detectedSidebar.removeEventListener("pointerleave", this.sidebarLeaveHandler);
      this.detectedSidebar.removeEventListener("focusin", this.sidebarEnterHandler);
      this.detectedSidebar.removeEventListener("focusout", this.sidebarLeaveHandler);
    }
    this.sidebarEnterHandler = null;
    this.sidebarLeaveHandler = null;
  }

  private onSidebarEnter(): void {
    if (this.configuredMode !== "hover") return;
    this.clearHoverCloseTimer();
    this.transient.hoverActive = true;
    this.transient.focusWithin = true;
    this.updateClosedClass();
  }

  private onSidebarLeave(): void {
    if (this.configuredMode !== "hover") return;
    this.scheduleHoverClose();
  }

  // --- button --------------------------------------------------------------

  private onButtonClick(): void {
    if (this.configuredMode !== "button") return;
    this.transient.buttonOpen = !this.transient.buttonOpen;
    this.host.setButtonExpanded(this.transient.buttonOpen);
    this.updateClosedClass();
  }

  private onEscape(): void {
    if (this.configuredMode !== "button") return;
    if (this.transient.buttonOpen) {
      this.transient.buttonOpen = false;
      this.host.setButtonExpanded(false);
      this.updateClosedClass();
    }
  }

  // --- keyboard toggle -----------------------------------------------------

  /**
   * Fixed shortcut `Alt+Shift+L` toggles the transient open/closed state
   * according to the configured mode. Called by the content runtime's global
   * keydown listener (which already validated modifiers, repeat, composition,
   * and event origin).
   */
  onKeyboardToggle(): void {
    if (!this.enabled) return;
    switch (this.configuredMode) {
      case "visible":
        this.transient.temporaryOverride =
          this.transient.temporaryOverride === "closed" ? "none" : "closed";
        break;
      case "hidden":
        // Hidden default closed; temporary override shows it; toggle off.
        this.transient.temporaryOverride =
          this.transient.temporaryOverride === "open" ? "none" : "open";
        break;
      case "button":
        this.transient.buttonOpen = !this.transient.buttonOpen;
        this.host.setButtonExpanded(this.transient.buttonOpen);
        break;
      case "hover":
        this.transient.hoverActive = !this.transient.hoverActive;
        break;
    }
    this.bindTarget();
  }

  // --- mode change / teardown ----------------------------------------------

  /** Clear all transient state (called when the configured mode changes). */
  clearTransient(): void {
    this.transient = freshTransientState();
  }

  /** Completely restore the official ChatGPT sidebar UI. Idempotent. */
  restore(): void {
    this.clearHoverCloseTimer();
    for (const cls of ROOT_SIDEBAR_CLASSES) this.root.classList.remove(cls);
    if (this.detectedSidebar) {
      unmarkSidebar(this.detectedSidebar);
      this.detachSidebarListeners();
      this.detectedSidebar = null;
    }
    clearAllSidebarMarkers(document);
    this.host.unmount();
  }

  /** Tear down observers, control host, listeners, timers, and references. */
  teardown(): void {
    this.restore();
    this.transient = freshTransientState();
    this.configuredMode = "visible";
    this.enabled = false;
  }
}

export { SIDEBAR_HOST_ID };
