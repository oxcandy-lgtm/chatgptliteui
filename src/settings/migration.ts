import type { Settings, StoredSettingsEnvelope } from "../shared/types.js";
import { SETTINGS_SCHEMA_VERSION } from "../shared/types.js";
import { cloneDefaults } from "./defaults.js";
import { validateSettings } from "./schema.js";

/**
 * Migration pipeline for stored settings (schema v1 -> v2).
 *
 * Rules (fail-closed):
 *  - Detect the stored schema version first.
 *  - Migrate only known older versions.
 *  - Validate the fully migrated result.
 *  - Fall back to defaults on malformed or unknown data.
 *  - Never persist unknown keys.
 */

/** Best-effort structural shape of the v1 stored settings payload. */
interface V1Appearance {
  disableAnimations?: unknown;
  disableBlur?: unknown;
  disableShadows?: unknown;
  compactSpacing?: unknown;
  useConversationWidth?: unknown;
  conversationWidth?: unknown;
  useFontSize?: unknown;
  fontSize?: unknown;
  useTheme?: unknown;
}

interface V1Settings {
  enabled?: unknown;
  preset?: unknown;
  appearance?: V1Appearance;
  sidebar?: unknown;
  history?: unknown;
  writingCopy?: unknown;
  codeBlocks?: unknown;
  theme?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

const PRESETS_V1 = new Set(["normal", "minimal", "work", "ultra-lite"]);

/** The v1 "untouched default" appearance (all toggles off, neutral sizes). */
function v1IsUntouchedDefault(a: V1Appearance | undefined): boolean {
  if (!a) return false;
  return (
    a.disableAnimations === false &&
    a.disableBlur === false &&
    a.disableShadows === false &&
    a.compactSpacing === false &&
    a.conversationWidth === 768 &&
    a.fontSize === 16
  );
}

/** Appearance profile produced by the v1 `minimal` preset. */
const V1_MINIMAL_PATCH = {
  disableAnimations: true,
  disableBlur: true,
  disableShadows: true,
  compactSpacing: false,
  useConversationWidth: false,
  useFontSize: false,
  useTheme: false,
} as const;

/** Appearance profile produced by the v1 `work` preset. */
const V1_WORK_PATCH = {
  disableAnimations: true,
  disableBlur: true,
  disableShadows: true,
  compactSpacing: true,
  useConversationWidth: true,
  conversationWidth: 880,
  useFontSize: false,
  useTheme: false,
} as const;

/** Appearance profile produced by the v1 `ultra-lite` preset. */
const V1_ULTRA_PATCH = {
  disableAnimations: true,
  disableBlur: true,
  disableShadows: true,
  compactSpacing: true,
  useConversationWidth: true,
  conversationWidth: 720,
  useFontSize: true,
  fontSize: 15,
  useTheme: false,
} as const;

/**
 * Migrate a single v1 payload to v2. Caller has already validated the
 * envelope schema version and that `settings` is an object.
 */
function migrateV1(v1: V1Settings): Settings {
  const next = cloneDefaults();

  if (isBoolean(v1.enabled)) next.enabled = v1.enabled;

  const a = isObject(v1.appearance) ? v1.appearance : undefined;
  if (a) {
    if (isBoolean(a.disableAnimations)) next.appearance.disableAnimations = a.disableAnimations;
    if (isBoolean(a.disableBlur)) next.appearance.disableBlur = a.disableBlur;
    if (isBoolean(a.disableShadows)) next.appearance.disableShadows = a.disableShadows;
    if (isBoolean(a.compactSpacing)) next.appearance.compactSpacing = a.compactSpacing;
    // Carry explicit v1 activation flags; derive from values when absent so a
    // custom v1 width/font/theme is preserved as active rather than reset.
    if (isBoolean(a.useConversationWidth)) next.appearance.useConversationWidth = a.useConversationWidth;
    else if (isIntIn(a.conversationWidth, 480, 1600) && a.conversationWidth !== 768) {
      next.appearance.useConversationWidth = true;
    }
    if (isBoolean(a.useFontSize)) next.appearance.useFontSize = a.useFontSize;
    else if (isIntIn(a.fontSize, 12, 24) && a.fontSize !== 16) {
      next.appearance.useFontSize = true;
    }
    if (isBoolean(a.useTheme)) next.appearance.useTheme = a.useTheme;
    if (isIntIn(a.conversationWidth, 480, 1600)) {
      next.appearance.conversationWidth = a.conversationWidth;
    }
    if (isIntIn(a.fontSize, 12, 24)) next.appearance.fontSize = a.fontSize;
  }

  // Preserve theme colors if they came across as plain strings.
  if (isObject(v1.theme)) {
    const t = v1.theme as Record<string, unknown>;
    for (const key of Object.keys(next.theme) as (keyof Settings["theme"])[]) {
      const incoming = t[key];
      if (typeof incoming === "string") next.theme[key] = incoming;
    }
  }

  // Preserve deferred-feature sections if present and structurally okay.
  if (isObject(v1.sidebar) && typeof (v1.sidebar as Record<string, unknown>).mode === "string") {
    (next.sidebar as Record<string, unknown>).mode = (v1.sidebar as Record<string, unknown>).mode;
  }
  if (isObject(v1.history)) {
    const h = v1.history as Record<string, unknown>;
    if (isBoolean(h.enabled)) next.history.enabled = h.enabled;
    if (typeof h.visiblePairs === "number") next.history.visiblePairs = h.visiblePairs;
    if (typeof h.mode === "string") next.history.mode = h.mode as Settings["history"]["mode"];
  }
  if (isObject(v1.writingCopy)) {
    const w = v1.writingCopy as Record<string, unknown>;
    if (isBoolean(w.enabled)) next.writingCopy.enabled = w.enabled;
    if (typeof w.position === "string") next.writingCopy.position = w.position as Settings["writingCopy"]["position"];
    if (isBoolean(w.shortcutEnabled)) next.writingCopy.shortcutEnabled = w.shortcutEnabled;
  }
  if (isObject(v1.codeBlocks)) {
    const c = v1.codeBlocks as Record<string, unknown>;
    if (isBoolean(c.autoCollapse)) next.codeBlocks.autoCollapse = c.autoCollapse;
    if (typeof c.collapseAfterLines === "number") next.codeBlocks.collapseAfterLines = c.collapseAfterLines;
  }

  // Decide preset + activation flags based on the v1 source.
  // A manually edited v1 that does not exactly match a known preset must
  // preserve the user's already-migrated values (custom), never silently
  // reset them to a locked profile.
  if (v1.preset === "normal" && PRESETS_V1.has(v1.preset) && v1IsUntouchedDefault(a)) {
    next.preset = "normal";
    // All activation flags already false (defaults) -> no visual overrides.
  } else if (v1.preset === "minimal" || v1.preset === "work" || v1.preset === "ultra-lite") {
    const profile =
      v1.preset === "minimal"
        ? V1_MINIMAL_PATCH
        : v1.preset === "work"
          ? V1_WORK_PATCH
          : V1_ULTRA_PATCH;
    if (appearanceMatchesV1Preset(a, v1.preset)) {
      next.preset = v1.preset;
      Object.assign(next.appearance, profile);
    } else {
      // Manually edited v1 with a known preset name but non-matching profile:
      // preserve migrated values and mark custom.
      next.preset = "custom";
    }
  } else {
    // Manually edited v1 (or unknown preset) that does not exactly match a
    // known profile -> preserve values and mark as custom. Schema v1 did not
    // carry explicit activation flags, so derive them from the stored values.
    next.preset = "custom";
    // The Phase 0 runtime applied its stored theme values whenever enabled, so
    // a present theme object means the theme was active. Derive useTheme from
    // theme presence only when no explicit flag was supplied.
    if (!isBoolean(a?.useTheme) && isObject(v1.theme)) {
      next.appearance.useTheme = true;
    }
  }

  return next;
}

/**
 * Whether the v1 appearance object exactly matches a known preset's v1 profile
 * (treating missing fields as their neutral defaults). Used to decide between
 * locking to a preset profile vs. preserving a manual edit as `custom`.
 */
function appearanceMatchesV1Preset(
  a: V1Appearance | undefined,
  preset: "minimal" | "work" | "ultra-lite",
): boolean {
  const profile =
    preset === "minimal"
      ? V1_MINIMAL_PATCH
      : preset === "work"
        ? V1_WORK_PATCH
        : V1_ULTRA_PATCH;
  const width = a?.conversationWidth ?? 768;
  const fontSize = a?.fontSize ?? 16;
  const expectedWidth = preset === "work" ? 880 : preset === "ultra-lite" ? 720 : 768;
  const expectedFont = preset === "ultra-lite" ? 15 : 16;
  return (
    (a?.disableAnimations ?? false) === profile.disableAnimations &&
    (a?.disableBlur ?? false) === profile.disableBlur &&
    (a?.disableShadows ?? false) === profile.disableShadows &&
    (a?.compactSpacing ?? false) === profile.compactSpacing &&
    (profile.useConversationWidth ? width === expectedWidth : width === 768) &&
    (profile.useFontSize ? fontSize === expectedFont : fontSize === 16)
  );
}

/** A migration maps an older schema payload to the current Settings shape. */
type Migration = (settings: Settings, raw: unknown) => Settings;

const MIGRATIONS: Record<number, Migration> = {
  1: (_current, raw) => {
    if (!isObject(raw)) return cloneDefaults();
    return migrateV1(raw as V1Settings);
  },
};

/**
 * Apply migrations to move a stored envelope to the current schema version.
 * Unknown or newer versions are rejected (returning null) so the caller falls
 * back to defaults rather than trusting data it cannot understand.
 */
export function migrateEnvelope(
  envelope: StoredSettingsEnvelope,
): Settings | null {
  const rawVersion = envelope.schemaVersion;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion)) return null;
  if (rawVersion > SETTINGS_SCHEMA_VERSION) return null; // future/unknown
  if (rawVersion < 1) return null;

  const settings: Settings = cloneDefaults();

  if (rawVersion === SETTINGS_SCHEMA_VERSION) {
    // Already current: trust only a validating payload; else defaults.
    if (validateSettings(envelope.settings)) {
      settings.enabled = envelope.settings.enabled;
      settings.preset = envelope.settings.preset;
      Object.assign(settings.appearance, envelope.settings.appearance);
      Object.assign(settings.sidebar, envelope.settings.sidebar);
      Object.assign(settings.history, envelope.settings.history);
      Object.assign(settings.writingCopy, envelope.settings.writingCopy);
      Object.assign(settings.codeBlocks, envelope.settings.codeBlocks);
      Object.assign(settings.theme, envelope.settings.theme);
    }
  } else {
    const step = MIGRATIONS[rawVersion];
    if (!step) return null;
    Object.assign(settings, step(settings, envelope.settings));
  }

  return validateSettings(settings) ? settings : null;
}

/** Wraps settings into a versioned, validated envelope. */
export function toEnvelope(settings: Settings): StoredSettingsEnvelope {
  if (!validateSettings(settings)) {
    throw new Error("cannot persist invalid settings");
  }
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, settings };
}
