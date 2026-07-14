import type { Settings } from "../shared/types.js";
import { cloneDefaults } from "./defaults.js";

/**
 * Schema validation for the Settings object.
 *
 * Design rules (fail-closed):
 *  - Every field is checked by type and by allowed value set.
 *  - Unknown keys at any level cause rejection.
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

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const PRESETS = new Set(["normal", "minimal", "work", "ultra-lite"]);
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

function validateAppearance(value: unknown): value is Settings["appearance"] {
  if (!isObject(value)) return false;
  const allowed = new Set([
    "disableAnimations",
    "disableBlur",
    "disableShadows",
    "conversationWidth",
    "fontSize",
    "compactSpacing",
  ]);
  if (!assertNoExtraKeys(value, allowed)) return false;
  if (!isBoolean(value.disableAnimations)) return false;
  if (!isBoolean(value.disableBlur)) return false;
  if (!isBoolean(value.disableShadows)) return false;
  if (!isNumber(value.conversationWidth)) return false;
  if (!isNumber(value.fontSize)) return false;
  if (!isBoolean(value.compactSpacing)) return false;
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
  if (!isNumber(value.visiblePairs)) return false;
  return typeof value.mode === "string" && HISTORY_MODES.has(value.mode);
}

function validateWritingCopy(value: unknown): value is Settings["writingCopy"] {
  if (!isObject(value)) return false;
  const allowed = new Set(["enabled", "position", "shortcutEnabled"]);
  if (!assertNoExtraKeys(value, allowed)) return false;
  if (!isBoolean(value.enabled)) return false;
  if (typeof value.position !== "string" || !COPY_POSITIONS.has(value.position)) return false;
  return isBoolean(value.shortcutEnabled);
}

function validateCodeBlocks(value: unknown): value is Settings["codeBlocks"] {
  if (!isObject(value)) return false;
  const allowed = new Set(["autoCollapse", "collapseAfterLines"]);
  if (!assertNoExtraKeys(value, allowed)) return false;
  if (!isBoolean(value.autoCollapse)) return false;
  if (!isNumber(value.collapseAfterLines)) return false;
  return true;
}

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
  for (const key of allowed) {
    if (typeof value[key] !== "string") return false;
  }
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
    if (isNumber(a.conversationWidth)) next.appearance.conversationWidth = a.conversationWidth;
    if (isNumber(a.fontSize)) next.appearance.fontSize = a.fontSize;
    if (isBoolean(a.compactSpacing)) next.appearance.compactSpacing = a.compactSpacing;
  }
  if (isObject(patch.sidebar)) {
    if (typeof patch.sidebar.mode === "string" && SIDEBAR_MODES.has(patch.sidebar.mode)) {
      next.sidebar.mode = patch.sidebar.mode;
    }
  }
  if (isObject(patch.history)) {
    const h = patch.history;
    if (isBoolean(h.enabled)) next.history.enabled = h.enabled;
    if (isNumber(h.visiblePairs)) next.history.visiblePairs = h.visiblePairs;
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
    if (isNumber(c.collapseAfterLines)) next.codeBlocks.collapseAfterLines = c.collapseAfterLines;
  }
  if (isObject(patch.theme)) {
    for (const key of Object.keys(next.theme) as (keyof Settings["theme"])[]) {
      const incoming = (patch.theme as Record<string, unknown>)[key];
      if (typeof incoming === "string") next.theme[key] = incoming;
    }
  }

  // Final guard: result must satisfy the schema.
  if (!validateSettings(next)) {
    throw new Error("mergeSettings produced an invalid settings object");
  }
  return next;
}
