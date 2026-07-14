import type { Settings, SidebarMode } from "../../shared/types.js";
import { hasAppearanceEffects } from "../appearance/presets.js";

/**
 * Sidebar feature pure state helpers (no DOM, no Chrome APIs).
 *
 * These functions keep the configured mode separate from transient runtime
 * state and compute the effective sidebar visibility. The configured setting
 * in storage is the persistent truth; pointer/focus/button/Escape/keyboard
 * operations affect only transient state.
 */

/** Whether a sidebar mode produces any active sidebar effect (non-visible). */
export function hasSidebarEffects(settings: Settings): boolean {
  return settings.sidebar.mode !== "visible";
}

/**
 * Runtime effect = appearance effects OR sidebar effects.
 *
 * The content runtime uses this to decide whether to attach its structural
 * MutationObserver. A non-visible sidebar mode must activate observation even
 * when the appearance profile is Normal (which alone requires no observer).
 */
export function hasRuntimeEffects(settings: Settings): boolean {
  return hasAppearanceEffects(settings) || hasSidebarEffects(settings);
}

/** Transient (non-persisted) runtime state for the sidebar feature. */
export interface SidebarTransientState {
  /** Visible-mode temporary hide, or Hidden-mode temporary show. */
  temporaryOverride: "none" | "open" | "closed";
  /** Hover mode: pointer/focus pinned open. */
  hoverActive: boolean;
  /** Hover mode: focus currently within the sidebar. */
  focusWithin: boolean;
  /** Button mode: toggle button currently open. */
  buttonOpen: boolean;
}

/** Fresh transient state (nothing pinned/overridden). */
export function freshTransientState(): SidebarTransientState {
  return {
    temporaryOverride: "none",
    hoverActive: false,
    focusWithin: false,
    buttonOpen: false,
  };
}

/**
 * Pure effective-visibility computation. Returns true when the sidebar should
 * be shown (open), false when it should be hidden via the `cgl-sidebar-closed`
 * root class.
 *
 *  - visible: open unless temporarily overridden closed.
 *  - hidden:  closed unless temporarily overridden open.
 *  - button:  controlled by button/shortcut transient state; default closed.
 *  - hover:   open while pointer/focus is active or temporarily pinned open;
 *            default closed.
 */
export function effectiveSidebarOpen(
  mode: SidebarMode,
  transient: SidebarTransientState,
): boolean {
  switch (mode) {
    case "visible":
      return transient.temporaryOverride !== "closed";
    case "hidden":
      return transient.temporaryOverride === "open";
    case "button":
      return transient.buttonOpen || transient.temporaryOverride === "open";
    case "hover":
      return (
        transient.hoverActive ||
        transient.focusWithin ||
        transient.temporaryOverride === "open"
      );
  }
}

/** Whether the given mode requires an extension-owned on-page control host. */
export function modeRequiresControlHost(mode: SidebarMode): boolean {
  return mode === "hover" || mode === "button";
}
