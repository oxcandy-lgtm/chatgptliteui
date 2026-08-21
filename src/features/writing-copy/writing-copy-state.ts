import type { Settings, CopyPosition } from "../../shared/types.js";

/**
 * Pure state helpers for the writing-copy feature (no DOM, no Chrome APIs).
 */

/** Whether the writing-copy feature produces any active runtime effect. */
export function hasWritingCopyEffects(settings: Settings): boolean {
  return settings.writingCopy.enabled;
}

/** Whether the writing-copy shortcut listener should be attached. */
export function isWritingCopyShortcutActive(settings: Settings): boolean {
  return (
    settings.enabled &&
    settings.writingCopy.enabled &&
    settings.writingCopy.shortcutEnabled
  );
}

/** Whether the optional writing-block background should be applied. */
export function isWritingBlockBackgroundActive(settings: Settings): boolean {
  return (
    settings.enabled &&
    settings.writingCopy.enabled &&
    settings.appearance.useTheme
  );
}

export const WRITING_COPY_ROOT_CLASSES = ["cgl-writing-copy-active"] as const;

export type { CopyPosition };
