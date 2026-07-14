import type { Settings, StoredSettingsEnvelope } from "../shared/types.js";
import { SETTINGS_STORAGE_KEY } from "../shared/types.js";
import { cloneDefaults } from "./defaults.js";
import { validateSettings, mergeSettings } from "./schema.js";
import { migrateEnvelope, toEnvelope } from "./migration.js";
import { logger } from "../shared/logger.js";

/**
 * Storage layer for settings.
 *
 * Phase 0 allows the content script, popup, and options page to read and write
 * `chrome.storage.local` directly. No Service Worker is involved.
 *
 * All persisted data is presentation-only. Chat text, titles, copied content,
 * URLs, and account data are structurally impossible to persist because they
 * are not part of the Settings schema (see schema.ts).
 */

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage !== "undefined" &&
    typeof chrome.storage.local !== "undefined"
  );
}

/** Reads and validates stored settings, falling back to defaults. */
export async function getSettings(): Promise<Settings> {
  if (!hasChromeStorage()) {
    return cloneDefaults();
  }
  try {
    const raw = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    const envelope = raw[SETTINGS_STORAGE_KEY] as StoredSettingsEnvelope | undefined;
    if (!envelope || typeof envelope !== "object") {
      return cloneDefaults();
    }
    const migrated = migrateEnvelope(envelope);
    if (migrated === null) {
      logger.warn("storage", "stored settings rejected; using defaults");
      return cloneDefaults();
    }
    return migrated;
  } catch (err) {
    logger.error("storage", "failed to read settings", err);
    return cloneDefaults();
  }
}

/**
 * Applies a partial update through a validated deep merge and persists the
 * resulting envelope. Rejects unknown keys and out-of-schema fields.
 */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = mergeSettings(current, patch);
  await persist(next);
  return next;
}

/** Persists a fully validated settings object. */
export async function persist(settings: Settings): Promise<void> {
  if (!validateSettings(settings)) {
    throw new Error("refusing to persist invalid settings");
  }
  if (!hasChromeStorage()) return;
  const envelope = toEnvelope(settings);
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: envelope });
}

/** Resets storage to defaults. */
export async function resetSettings(): Promise<Settings> {
  const defaults = cloneDefaults();
  await persist(defaults);
  return defaults;
}
