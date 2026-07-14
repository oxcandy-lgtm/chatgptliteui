import type { Settings } from "../shared/types.js";

/**
 * Default settings for ChatGPTLiteUI.
 *
 * These values are presentation-only. They never contain chat text, titles,
 * copied content, account data, URLs, or DOM snapshots.
 *
 * The canonical `normal` profile is intentionally NEUTRAL: every visual
 * override flag is false, so a default install does not modify the official
 * ChatGPT UI in any way. Theme colors are only applied when `useTheme` is
 * enabled (which it is not by default).
 *
 * `cloneDefaults` returns a deep copy so callers cannot mutate the canonical
 * default object.
 */
export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  preset: "normal",
  appearance: {
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
  sidebar: {
    mode: "visible",
  },
  history: {
    enabled: false,
    visiblePairs: 20,
    mode: "safe",
  },
  writingCopy: {
    enabled: false,
    position: "middle-right",
    shortcutEnabled: true,
  },
  codeBlocks: {
    autoCollapse: false,
    collapseAfterLines: 40,
  },
  theme: {
    // Neutral placeholders. Only used when useTheme is true.
    pageBackground: "#101318",
    conversationBackground: "#151922",
    userBackground: "#1c2636",
    assistantBackground: "transparent",
    inputBackground: "#1c222d",
    codeBackground: "#11151c",
    writingBlockBackground: "#161b25",
    textColor: "#e7eaf0",
  },
};

/** Returns a deep clone of the default settings. */
export function cloneDefaults(): Settings {
  return structuredClone(DEFAULT_SETTINGS);
}
