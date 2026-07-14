/**
 * Shared value and capability types for the ChatGPTLiteUI extension.
 *
 * This module intentionally contains no browser or Chrome APIs so it can be
 * imported freely from unit tests running under Node.
 */

/** Capability level assigned to a single detection strategy. */
export type Confidence = "high" | "medium" | "low" | "unknown";

/** Preset identifiers select a coordinated group of settings. */
export type PresetName = "normal" | "minimal" | "work" | "ultra-lite";

/** Sidebar visibility strategy. */
export type SidebarMode = "visible" | "hover" | "button" | "hidden";

/** History limiting strategy. */
export type HistoryMode = "safe" | "aggressive";

/** Position for the floating copy button. */
export type CopyPosition = "top-right" | "middle-right" | "bottom-right";

/**
 * The complete settings object.
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
    disableAnimations: boolean;
    disableBlur: boolean;
    disableShadows: boolean;
    conversationWidth: number;
    fontSize: number;
    compactSpacing: boolean;
  };
  sidebar: {
    mode: SidebarMode;
  };
  history: {
    enabled: boolean;
    visiblePairs: number;
    mode: HistoryMode;
  };
  writingCopy: {
    enabled: boolean;
    position: CopyPosition;
    shortcutEnabled: boolean;
  };
  codeBlocks: {
    autoCollapse: boolean;
    collapseAfterLines: number;
  };
  theme: {
    pageBackground: string;
    conversationBackground: string;
    userBackground: string;
    assistantBackground: string;
    inputBackground: string;
    codeBackground: string;
    writingBlockBackground: string;
    textColor: string;
  };
}

/** Versioned storage envelope. */
export interface StoredSettingsEnvelope {
  schemaVersion: number;
  settings: Settings;
}

/** Current persisted schema version. */
export const SETTINGS_SCHEMA_VERSION = 1;

/** Chrome storage key for the settings envelope. */
export const SETTINGS_STORAGE_KEY = "settings";
