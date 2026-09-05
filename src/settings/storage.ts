import type { Settings, StoredSettingsEnvelope } from "../shared/types.js";
import { SETTINGS_STORAGE_KEY } from "../shared/types.js";
import { cloneDefaults } from "./defaults.js";
import { validateSettings, mergeSettings, type DeepPartial } from "./schema.js";
import { migrateEnvelope, toEnvelope } from "./migration.js";
import { logger } from "../shared/logger.js";
import {
  CODE_EXTENSION_CONTEXT_INVALIDATED,
  classifyStorageFailure,
  isExtensionContextInvalidatedError,
  isInvalidatedLatched,
  noteStorageSuccess,
  recordInternalError,
} from "../shared/runtime-health.js";

/**
 * Storage layer for settings.
 *
 * Phase 0 allows the content script, popup, and options page to read and write
 * `chrome.storage.local` directly. No Service Worker is involved.
 *
 * All persisted data is presentation-only. Chat text, titles, copied content,
 * URLs, and account data are structurally impossible to persist because they
 * are not part of the Settings schema (see schema.ts).
 *
 * FAILURE SEMANTICS (runtime-health authority):
 *  - NORMAL ABSENCE / CORRUPT SETTINGS: the historical safe fallback to
 *    defaults remains (first-run, removed key, rejected envelope).
 *  - EXTENSION CONTEXT INVALIDATED: FAIL CLOSED. `getSettings` REJECTS with
 *    `SettingsUnavailableError` — defaults are NEVER presented as
 *    authoritative settings, and no feature initializes from fake values.
 */

/** Typed rejection telling callers settings were NOT authoritatively loaded. */
export class SettingsUnavailableError extends Error {
  /** Canonical CGL internal error code (e.g. EXTENSION_CONTEXT_INVALIDATED). */
  readonly code: string;

  constructor(code: string) {
    super(`settings unavailable (${code})`);
    this.name = "SettingsUnavailableError";
    this.code = code;
  }
}

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage !== "undefined" &&
    typeof chrome.storage.local !== "undefined"
  );
}

/** Reads and validates stored settings. Rejects when the context is dead. */
export async function getSettings(): Promise<Settings> {
  if (!hasChromeStorage()) {
    // Normal absence: no extension storage API in this environment at all.
    return cloneDefaults();
  }
  try {
    const raw = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    noteStorageSuccess();
    const envelope = raw[SETTINGS_STORAGE_KEY] as StoredSettingsEnvelope | undefined;
    if (!envelope || typeof envelope !== "object") {
      return cloneDefaults();
    }
    const migrated = migrateEnvelope(envelope);
    if (migrated === null) {
      // Corrupt/unrecognized stored settings: safe fallback remains.
      logger.warn("storage", "stored settings rejected; using defaults");
      return cloneDefaults();
    }
    return migrated;
  } catch (err) {
    if (
      isExtensionContextInvalidatedError(err) ||
      isInvalidatedLatched()
    ) {
      if (!isInvalidatedLatched()) {
        classifyStorageFailure(err, "storage", "getSettings");
      }
      throw new SettingsUnavailableError(CODE_EXTENSION_CONTEXT_INVALIDATED);
    }
    recordInternalError({
      code: "STORAGE_OPERATION_FAILED",
      scope: "storage",
      err,
      operation: "getSettings",
    });
    logger.error("storage", "failed to read settings", err);
    return cloneDefaults();
  }
}

/**
 * Applies a partial update through a validated deep merge and persists the
 * resulting envelope. Rejects unknown keys and out-of-schema fields. Rejects
 * with `SettingsUnavailableError` when the extension context is invalid.
 */
export async function updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
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
  try {
    const envelope = toEnvelope(settings);
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: envelope });
    noteStorageSuccess();
  } catch (err) {
    if (isExtensionContextInvalidatedError(err) || isInvalidatedLatched()) {
      if (!isInvalidatedLatched()) {
        classifyStorageFailure(err, "storage", "persist");
      }
      throw new SettingsUnavailableError(CODE_EXTENSION_CONTEXT_INVALIDATED);
    }
    recordInternalError({
      code: "STORAGE_OPERATION_FAILED",
      scope: "storage",
      err,
      operation: "persist",
    });
    throw err;
  }
}

/** Resets storage to defaults. */
export async function resetSettings(): Promise<Settings> {
  const defaults = cloneDefaults();
  await persist(defaults);
  return defaults;
}
