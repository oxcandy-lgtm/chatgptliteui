/**
 * Shared value and capability types for the ChatGPTLiteUI extension.
 *
 * This module intentionally contains no browser or Chrome APIs so it can be
 * imported freely from unit tests running under Node.
 */

/** Capability level assigned to a single detection strategy. */
export type Confidence = "high" | "medium" | "low" | "unknown";

/**
 * Preset identifiers select a coordinated group of appearance settings.
 * `custom` is set automatically when the user manually edits an appearance
 * control; it is never a user-selectable predefined preset.
 */
export type PresetName = "normal" | "minimal" | "work" | "ultra-lite" | "custom";

/** Sidebar visibility strategy (deferred feature; preserved for forward-compat). */
export type SidebarMode = "visible" | "hover" | "button" | "hidden";

/** History limiting strategy (deferred feature; preserved for forward-compat). */
export type HistoryMode = "safe" | "aggressive";

/** Position for the floating copy button (deferred feature). */
export type CopyPosition = "top-right" | "middle-right" | "bottom-right";

/** A normalized `Color` value. Only these shapes are accepted. */
export type Color = string;

/**
 * The complete settings object (schema version 2).
 *
 * This schema is the strict boundary of what the extension is allowed to
 * persist. It contains only presentation preferences (colors, sizes,
 * toggles, counts, preset names). It deliberately omits any field that could
 * hold chat text, titles, copied content, URLs, account data, or DOM
 * snapshots.
 */
export interface Settings {
  enabled: boolean;
  preset: PresetName;
  appearance: {
    /** Opt-in animation/transition/smooth-scroll reduction. */
    disableAnimations: boolean;
    /** Disable backdrop-filter only (not ordinary filters). */
    disableBlur: boolean;
    /** Disable box-shadow and text-shadow. */
    disableShadows: boolean;
    /** Compact spacing on message surfaces only. */
    compactSpacing: boolean;

    /** Apply a custom conversation width. */
    useConversationWidth: boolean;
    /** Integer px, 480–1600. */
    conversationWidth: number;

    /** Apply a custom conversation font size. */
    useFontSize: boolean;
    /** Integer px, 12–24. */
    fontSize: number;

    /** Apply the custom theme variables. */
    useTheme: boolean;
  };
  /** Deferred feature; preserved for forward-compatibility only. */
  sidebar: {
    mode: SidebarMode;
  };
  /** Deferred feature; preserved for forward-compatibility only. */
  history: {
    enabled: boolean;
    visiblePairs: number;
    mode: HistoryMode;
  };
  /** Deferred feature; preserved for forward-compatibility only. */
  writingCopy: {
    enabled: boolean;
    position: CopyPosition;
    shortcutEnabled: boolean;
  };
  /** Deferred feature; preserved for forward-compatibility only. */
  codeBlocks: {
    autoCollapse: boolean;
    collapseAfterLines: number;
  };
  theme: {
    pageBackground: Color;
    conversationBackground: Color;
    userBackground: Color;
    assistantBackground: Color;
    inputBackground: Color;
    codeBackground: Color;
    /** Reserved for writing-block support (Phase 4). Not applied in this phase. */
    writingBlockBackground: Color;
    textColor: Color;
  };
}

/** Versioned storage envelope. */
export interface StoredSettingsEnvelope {
  schemaVersion: number;
  settings: Settings;
}

/** Current persisted schema version. */
export const SETTINGS_SCHEMA_VERSION = 2;

/** Chrome storage key for the settings envelope. */
export const SETTINGS_STORAGE_KEY = "settings";

/** Bounds for the integer-only numeric appearance fields. */
export const NUMBER_BOUNDS = {
  conversationWidth: { min: 480, max: 1600 },
  fontSize: { min: 12, max: 24 },
} as const;

/**
 * Allowed color grammar for theme fields.
 *  - #rgb
 *  - #rrggbb
 *  - #rrggbbaa
 *  - transparent
 * No URLs, var(), calc(), functions, semicolons, or braces.
 */
export const COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^transparent$/;
