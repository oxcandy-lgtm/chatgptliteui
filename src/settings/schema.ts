import type { Settings } from "../shared/types.js";
import {
  COLOR_PATTERN,
  NUMBER_BOUNDS,
  type Color,
} from "../shared/types.js";
import { cloneDefaults } from "./defaults.js";

/**
 * Schema validation for the Settings object (schema version 2).
 *
 * Design rules (fail-closed):
 *  - Every field is checked by type and by allowed value set.
 *  - Unknown keys at any level cause rejection.
 *  - Numeric appearance fields are integers within bounded ranges.
 *  - Color fields must match the conservative public grammar.
 *  - No string field may accept chat-like content; the schema simply does not
 *    contain fields for that data, so attempting to store `messageText`,
 *    `chatTitle`, `copiedText`, or `innerHTML` is rejected purely because those
 *    keys are not part of the schema.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Integer within [min, max], rejecting NaN/Infinity/fractions/out-of-range. */
function isBoundedInt(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    isFiniteNumber(value) &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

const PRESETS = new Set(["normal", "minimal", "work", "ultra-lite", "custom"]);
const SIDEBAR_MODES = new Set(["visible", "hover", "button", "hidden"]);
const HISTORY_MODES = new Set(["safe", "aggressive"]);
const COPY_POSITIONS = new Set(["top-right", "middle-right", "bottom-right"]);

function assertNoExtraKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/** Conservative color grammar check (no URLs / var() / calc() / braces). */
export function isAllowedColor(value: unknown): value is Color {
  return typeof value === "string" && COLOR_PATTERN.test(value.trim());
}

function validateAppearance(value: unknown): value is Settings["appearance"] {
  if (!isObject(value)) return false;
  const allowed = new Set([
    "disableAnimations",
    "disableBlur",
    "disableShadows",
    "compactSpacing",
    "useConversationWidth",
    "conversationWidth",
    "useFontSize",
    "fontSize",
    "useTheme",
  ]);
  if (!assertNoExtraKeys(value, allowed)) return false;
  if (!isBoolean(value.disableAnimations)) return false;
  if (!isBoolean(value.disableBlur)) return false;
  if (!isBoolean(value.disableShadows)) return false;
  if (!isBoolean(value.compactSpacing)) return false;
  if (!isBoolean(value.useConversationWidth)) return false;
  if (!isBoolean(value.useFontSize)) return false;
  if (!isBoolean(value.useTheme)) return false;
  if (
    !isBoundedInt(
      value.conversationWidth,
      NUMBER_BOUNDS.conversationWidth.min,
      NUMBER_BOUNDS.conversationWidth.max,
    )
  ) {
    return false;
  }
  if (
    !isBoundedInt(
      value.fontSize,
      NUMBER_BOUNDS.fontSize.min,
      NUMBER_BOUNDS.fontSize.max,
    )
  ) {
    return false;
  }
  return true;
}

function validateSidebar(value: unknown): value is Settings["sidebar"] {
  if (!isObject(value)) return false;
  if (!assertNoExtraKeys(value, new Set(["mode"]))) return false;
  return typeof value.mode === "string" && SIDEBAR_MODES.has(value.mode);
}

function validateHistory(value: unknown): value is Settings["history"] {
  if (!isObject(value)) return false;
  const allowed = new Set(["enabled", "visiblePairs", "mode"]);
  if (!assertNoExtraKeys(value, allowed)) return false;
  if (!isBoolean(value.enabled)) return false;
  if (!isFiniteNumber(value.visiblePairs)) return false;
  return typeof value.mode === "string" && HISTORY_MODES.has(value.mode);
}

function validateWritingCopy(value: unknown): value is Settings["writingCopy"] {
  if (!isObject(value)) return false;
  const allowed = new Set(["enabled", "position", "shortcutEnabled"]);
  if (!assertNoExtraKeys(value, allowed)) return false;
  if (!isBoolean(value.enabled)) return false;
  if (typeof value.position !== "string" || !COPY_POSITIONS.has(value.position)) {
    return false;
  }
  return isBoolean(value.shortcutEnabled);
}

function validateCodeBlocks(value: unknown): value is Settings["codeBlocks"] {
  if (!isObject(value)) return false;
  const allowed = new Set(["autoCollapse", "collapseAfterLines"]);
  if (!assertNoExtraKeys(value, allowed)) return false;
  if (!isBoolean(value.autoCollapse)) return false;
  if (!isFiniteNumber(value.collapseAfterLines)) return false;
  return true;
}

/**
 * Theme validation.
 *  - Most color fields require an opaque hex color.
 *  - `assistantBackground` may additionally be `transparent`.
 *  - `writingBlockBackground` is reserved (Phase 4) but still validated.
 */
function validateTheme(value: unknown): value is Settings["theme"] {
  if (!isObject(value)) return false;
  const allowed = new Set([
    "pageBackground",
    "conversationBackground",
    "userBackground",
    "assistantBackground",
    "inputBackground",
    "codeBackground",
    "writingBlockBackground",
    "textColor",
  ]);
  if (!assertNoExtraKeys(value, allowed)) return false;

  const opaque = (v: unknown) => isAllowedColor(v) && v !== "transparent";

  if (!opaque(value.pageBackground)) return false;
  if (!opaque(value.conversationBackground)) return false;
  if (!opaque(value.userBackground)) return false;
  if (
    !isAllowedColor(value.assistantBackground) // may be transparent
  ) {
    return false;
  }
  if (!opaque(value.inputBackground)) return false;
  if (!opaque(value.codeBackground)) return false;
  if (!opaque(value.writingBlockBackground)) return false;
  if (!opaque(value.textColor)) return false;
  return true;
}

/** Returns true only when the value matches the Settings schema exactly. */
export function validateSettings(value: unknown): value is Settings {
  if (!isObject(value)) return false;
  const allowed = new Set([
    "enabled",
    "preset",
    "appearance",
    "sidebar",
    "history",
    "writingCopy",
    "codeBlocks",
    "theme",
  ]);
  if (!assertNoExtraKeys(value, allowed)) return false;
  if (!isBoolean(value.enabled)) return false;
  if (typeof value.preset !== "string" || !PRESETS.has(value.preset)) return false;
  if (!validateAppearance(value.appearance)) return false;
  if (!validateSidebar(value.sidebar)) return false;
  if (!validateHistory(value.history)) return false;
  if (!validateWritingCopy(value.writingCopy)) return false;
  if (!validateCodeBlocks(value.codeBlocks)) return false;
  if (!validateTheme(value.theme)) return false;
  return true;
}

/**
 * Validated deep merge for nested settings.
 *
 * Unlike a naive shallow spread (`{ ...current, ...patch }`), this walks each
 * known top-level section and merges only schema-known keys, rejecting any
 * unknown key. It never persists chat text or other out-of-schema fields.
 */
export function mergeSettings(
  base: Settings,
  patch: Partial<Settings>,
): Settings {
  const next = cloneDefaults();
  // Start from a validated base (fall back to defaults if base is bad).
  if (validateSettings(base)) {
    next.enabled = base.enabled;
    next.preset = base.preset;
    Object.assign(next.appearance, base.appearance);
    Object.assign(next.sidebar, base.sidebar);
    Object.assign(next.history, base.history);
    Object.assign(next.writingCopy, base.writingCopy);
    Object.assign(next.codeBlocks, base.codeBlocks);
    Object.assign(next.theme, base.theme);
  }

  if (!isObject(patch)) return next;

  if (isBoolean(patch.enabled)) next.enabled = patch.enabled;
  if (typeof patch.preset === "string" && PRESETS.has(patch.preset)) {
    next.preset = patch.preset;
  }
  if (isObject(patch.appearance)) {
    const a = patch.appearance;
    if (isBoolean(a.disableAnimations)) next.appearance.disableAnimations = a.disableAnimations;
    if (isBoolean(a.disableBlur)) next.appearance.disableBlur = a.disableBlur;
    if (isBoolean(a.disableShadows)) next.appearance.disableShadows = a.disableShadows;
    if (isBoolean(a.compactSpacing)) next.appearance.compactSpacing = a.compactSpacing;
    if (isBoolean(a.useConversationWidth)) next.appearance.useConversationWidth = a.useConversationWidth;
    if (isBoolean(a.useFontSize)) next.appearance.useFontSize = a.useFontSize;
    if (isBoolean(a.useTheme)) next.appearance.useTheme = a.useTheme;
    if (isBoundedInt(a.conversationWidth, NUMBER_BOUNDS.conversationWidth.min, NUMBER_BOUNDS.conversationWidth.max)) {
      next.appearance.conversationWidth = a.conversationWidth;
    }
    if (isBoundedInt(a.fontSize, NUMBER_BOUNDS.fontSize.min, NUMBER_BOUNDS.fontSize.max)) {
      next.appearance.fontSize = a.fontSize;
    }
  }
  if (isObject(patch.sidebar)) {
    if (typeof patch.sidebar.mode === "string" && SIDEBAR_MODES.has(patch.sidebar.mode)) {
      next.sidebar.mode = patch.sidebar.mode;
    }
  }
  if (isObject(patch.history)) {
    const h = patch.history;
    if (isBoolean(h.enabled)) next.history.enabled = h.enabled;
    if (isFiniteNumber(h.visiblePairs)) next.history.visiblePairs = h.visiblePairs;
    if (typeof h.mode === "string" && HISTORY_MODES.has(h.mode)) next.history.mode = h.mode;
  }
  if (isObject(patch.writingCopy)) {
    const w = patch.writingCopy;
    if (isBoolean(w.enabled)) next.writingCopy.enabled = w.enabled;
    if (typeof w.position === "string" && COPY_POSITIONS.has(w.position)) {
      next.writingCopy.position = w.position;
    }
    if (isBoolean(w.shortcutEnabled)) next.writingCopy.shortcutEnabled = w.shortcutEnabled;
  }
  if (isObject(patch.codeBlocks)) {
    const c = patch.codeBlocks;
    if (isBoolean(c.autoCollapse)) next.codeBlocks.autoCollapse = c.autoCollapse;
    if (isFiniteNumber(c.collapseAfterLines)) next.codeBlocks.collapseAfterLines = c.collapseAfterLines;
  }
  if (isObject(patch.theme)) {
    for (const key of Object.keys(next.theme) as (keyof Settings["theme"])[]) {
      const incoming = (patch.theme as Record<string, unknown>)[key];
      if (isAllowedColor(incoming)) next.theme[key] = incoming;
    }
  }

  // Final guard: result must satisfy the schema.
  if (!validateSettings(next)) {
    throw new Error("mergeSettings produced an invalid settings object");
  }
  return next;
}
