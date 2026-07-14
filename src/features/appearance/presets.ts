import type { PresetName, Settings } from "../../shared/types.js";
import { cloneDefaults } from "../../settings/defaults.js";

/**
 * Phase 2 appearance-only preset profiles.
 *
 * These presets affect ONLY appearance fields. Deferred feature sections
 * (sidebar, history, writingCopy, codeBlocks) are left untouched so a preset
 * never mutates a future feature's settings.
 *
 * `custom` is never produced by these definitions; it is derived automatically
 * when the user manually edits an appearance field.
 */

const PRESET_PROFILES: Record<
  Exclude<PresetName, "custom">,
  Settings["appearance"]
> = {
  normal: {
    disableAnimations: false,
    disableBlur: false,
    disableShadows: false,
    compactSpacing: false,
    useConversationWidth: false,
    conversationWidth: 768,
    useFontSize: false,
    fontSize: 16,
    useTheme: false,
  },
  minimal: {
    disableAnimations: true,
    disableBlur: true,
    disableShadows: true,
    compactSpacing: false,
    useConversationWidth: false,
    conversationWidth: 768,
    useFontSize: false,
    fontSize: 16,
    useTheme: false,
  },
  work: {
    disableAnimations: true,
    disableBlur: true,
    disableShadows: true,
    compactSpacing: true,
    useConversationWidth: true,
    conversationWidth: 880,
    useFontSize: false,
    fontSize: 16,
    useTheme: false,
  },
  "ultra-lite": {
    disableAnimations: true,
    disableBlur: true,
    disableShadows: true,
    compactSpacing: true,
    useConversationWidth: true,
    conversationWidth: 720,
    useFontSize: true,
    fontSize: 15,
    useTheme: false,
  },
};

/** Names of the user-selectable predefined presets. */
export const PRESET_NAMES: Exclude<PresetName, "custom">[] = [
  "normal",
  "minimal",
  "work",
  "ultra-lite",
];

/**
 * Apply a predefined appearance preset onto the current settings, preserving
 * unrelated (deferred-feature) sections and the `enabled` flag.
 *
 * Never uses a shallow merge: the appearance section is replaced wholesale
 * with a fresh deep copy of the profile, and `preset` is set to the applied
 * name (never `custom`).
 */
export function applyAppearancePreset(
  current: Settings,
  preset: Exclude<PresetName, "custom">,
): Settings {
  const next = cloneDefaults();
  // Carry forward everything that is not appearance-related.
  next.enabled = current.enabled;
  next.preset = preset;
  next.sidebar = structuredClone(current.sidebar);
  next.history = structuredClone(current.history);
  next.writingCopy = structuredClone(current.writingCopy);
  next.codeBlocks = structuredClone(current.codeBlocks);
  next.theme = structuredClone(current.theme);
  // Replace appearance wholesale with the profile copy.
  next.appearance = structuredClone(PRESET_PROFILES[preset]);
  return next;
}

/**
 * Detect which predefined preset (if any) the given settings match exactly.
 * Returns `custom` when the appearance profile does not exactly match a
 * predefined one, or when manually edited.
 */
export function detectAppearancePreset(settings: Settings): PresetName {
  for (const name of PRESET_NAMES) {
    const profile = PRESET_PROFILES[name];
    const a = settings.appearance;
    if (
      a.disableAnimations === profile.disableAnimations &&
      a.disableBlur === profile.disableBlur &&
      a.disableShadows === profile.disableShadows &&
      a.compactSpacing === profile.compactSpacing &&
      a.useConversationWidth === profile.useConversationWidth &&
      a.conversationWidth === profile.conversationWidth &&
      a.useFontSize === profile.useFontSize &&
      a.fontSize === profile.fontSize &&
      a.useTheme === profile.useTheme
    ) {
      return name;
    }
  }
  return "custom";
}
