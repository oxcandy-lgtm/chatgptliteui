import type { Settings, StoredSettingsEnvelope } from "../shared/types.js";
import { SETTINGS_SCHEMA_VERSION } from "../shared/types.js";
import { cloneDefaults } from "./defaults.js";
import { validateSettings } from "./schema.js";

/**
 * Migration pipeline for stored settings.
 *
 * Rules:
 *  - Detect the stored schema version first.
 *  - Migrate only known older versions (currently only v1, so a no-op until a
 *    v2 exists).
 *  - Validate the fully migrated result.
 *  - Fall back to defaults on malformed or unknown data.
 *  - Never persist unknown keys.
 */

/** A migration maps a settings object of an older schema to the current one. */
type Migration = (settings: Settings) => Settings;

const MIGRATIONS: Record<number, Migration> = {
  // Example future shape:
  // 1: (s) => { /* transform v1 -> v2 */ return s; },
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

  let settings: Settings = cloneDefaults();
  // The incoming settings are only trusted if they validate; otherwise we
  // start from defaults and ignore the payload.
  if (validateSettings(envelope.settings)) {
    settings = cloneDefaults();
    // Deep copy validated settings into the fresh default shell.
    settings.enabled = envelope.settings.enabled;
    settings.preset = envelope.settings.preset;
    Object.assign(settings.appearance, envelope.settings.appearance);
    Object.assign(settings.sidebar, envelope.settings.sidebar);
    Object.assign(settings.history, envelope.settings.history);
    Object.assign(settings.writingCopy, envelope.settings.writingCopy);
    Object.assign(settings.codeBlocks, envelope.settings.codeBlocks);
    Object.assign(settings.theme, envelope.settings.theme);
  }

  for (let v = rawVersion; v < SETTINGS_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step) settings = step(settings);
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
