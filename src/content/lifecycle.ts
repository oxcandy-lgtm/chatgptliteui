import type { Settings } from "../shared/types.js";
import { createAdapter } from "../adapters/chatgpt-adapter.js";
import {
  AppearanceController,
  createDebouncedApply,
} from "../features/appearance/appearance-controller.js";

/**
 * Appearance lifecycle wiring.
 *
 * The actual apply/restore logic lives in
 * `src/features/appearance/appearance-controller.ts`. This module constructs
 * the controller bound to `document.documentElement` and the Adapter, and
 * exposes a small façade used by the content-script entry point.
 *
 * Strictly non-destructive: it only toggles extension-owned classes/attributes
 * and CSS variables. When disabled (or on the `normal` preset with no
 * overrides) it restores the official ChatGPT appearance completely.
 */
export class ThemeApplier {
  private readonly controller: AppearanceController;

  constructor(root: HTMLElement = document.documentElement) {
    this.controller = new AppearanceController(root, createAdapter());
  }

  apply(settings: Settings): void {
    this.controller.apply(settings);
  }

  /** Refresh surface markers for new turns without touching classes/vars. */
  refreshMarkers(settings: Settings): void {
    this.controller.refreshMarkers(settings);
  }

  /**
   * Reconcile the stored per-conversation background override (clear stale
   * override, restore global/official fallback, apply resolved chat-or-
   * project color when present). Call only while the extension is enabled.
   */
  reconcileConversationBackgroundOverride(
    conversationFp: string | null,
    projectFp: string | null,
    settings: Settings,
  ): Promise<void> {
    return this.controller.reconcileConversationBackgroundOverride(
      conversationFp,
      projectFp,
      settings,
    );
  }

  /** Fully restore the original page appearance. */
  restore(): void {
    this.controller.restore();
  }
}

export { createDebouncedApply };
