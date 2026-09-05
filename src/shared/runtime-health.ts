/**
 * CGL runtime health layer.
 *
 * A tiny in-memory authority for the health of THIS content-script runtime:
 * build identity, boot identity, extension-context validity, and a bounded
 * internal CGL-owned error log for the X-Ray AI report.
 *
 * Strict boundaries:
 *  - observes ONLY ChatGPTLiteUI's own extension runtime (never global page
 *    errors, never ChatGPT's console);
 *  - never monkeypatches console;
 *  - health state is never persisted and never transmitted;
 *  - error events carry only codes, scopes, counts, timestamps, and
 *    SANITIZED messages (message text only, bounded length, no stacks, no
 *    URLs, no chat text, no input values, no DOM HTML).
 */

import { SETTINGS_STORAGE_KEY } from "./types.js";
import { logger } from "./logger.js";

/** Canonical code for the Chrome "Extension context invalidated" failure. */
export const CODE_EXTENSION_CONTEXT_INVALIDATED = "EXTENSION_CONTEXT_INVALIDATED";

/** Maximum number of DISTINCT retained internal error events. */
const MAX_ERROR_EVENTS = 32;

/** Maximum length of a sanitized error message. */
const MAX_SANITIZED_MESSAGE = 200;

/**
 * Build-time identity injected by esbuild `define` (see
 * scripts/build-extension.mjs): `<package-version>+<git-short-sha>` with an
 * explicit `-dirty` suffix when the tracked tree was dirty at build time.
 * Under vitest (no defines) these are undefined and honest fallbacks are used.
 */
declare const __CGL_BUILD_ID__: string | undefined;
declare const __CGL_SOURCE_HEAD__: string | undefined;
declare const __CGL_DIRTY_AT_BUILD__: boolean | undefined;

export interface BuildIdentity {
  /** `<version>+<short-sha>` (optionally `-dirty`). Non-empty always. */
  buildId: string;
  /** Short SHA of the committed source the bundle was built from. */
  sourceHead: string;
  /** Whether the tracked tree was dirty when the bundle was produced. */
  dirtyAtBuild: boolean;
}

/** Resolve build identity with honest fallbacks (never empty). */
export function getBuildIdentity(): BuildIdentity {
  const defined =
    typeof __CGL_BUILD_ID__ === "string" && __CGL_BUILD_ID__.length > 0;
  const headDefined =
    typeof __CGL_SOURCE_HEAD__ === "string" && __CGL_SOURCE_HEAD__.length > 0;
  if (defined && headDefined) {
    return {
      buildId: __CGL_BUILD_ID__,
      sourceHead: __CGL_SOURCE_HEAD__,
      dirtyAtBuild: __CGL_DIRTY_AT_BUILD__ === true,
    };
  }
  return { buildId: "dev-unbuilt", sourceHead: "unknown", dirtyAtBuild: true };
}

/** One random per-execution boot id (`boot-<random>`); not persisted. */
export function newBootId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `boot-${rand}`;
}

/** Sanitized, bounded error text: message text only, no stacks. */
export function sanitizeErrorMessage(err: unknown): string {
  let raw: string;
  if (err instanceof Error) raw = err.message;
  else if (typeof err === "string") raw = err;
  else raw = "";
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  raw = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return raw.slice(0, MAX_SANITIZED_MESSAGE);
}

/**
 * Recognize EXACTLY the Chrome extension-context invalidation failure.
 * Deliberately narrow: only the canonical Chrome message matches.
 */
export function isExtensionContextInvalidatedError(err: unknown): boolean {
  const msg = sanitizeErrorMessage(err);
  return msg.includes("Extension context invalidated");
}

/** One aggregated internal CGL error event (privacy-safe fields only). */
export interface InternalErrorEvent {
  code: string;
  scope: string;
  severity: "warn" | "error";
  /** Total occurrences of this distinct (code, scope, message) key. */
  count: number;
  /** Epoch ms of the MOST RECENT occurrence. */
  timestamp: number;
  /** First-occurrence epoch ms (ordering stability). */
  firstTimestamp: number;
  /** Bounded, sanitized message text (never stacks/URLs/chat text). */
  sanitizedMessage: string;
  /** Optional operation name (fixed CGL-owned identifier). */
  operation?: string;
}

/** Serializable runtimeHealth projection for the X-Ray AI report. */
export interface RuntimeHealthSnapshot extends BuildIdentity {
  contentScriptBootId: string;
  contentScriptBootTime: number;
  /**
   * `true` only when the extension APIs were PROVEN usable by the latest
   * probe; `false` when proven unusable; `null` when not applicable/not yet
   * probed (e.g. non-extension unit-test environments).
   */
  extensionContextValid: boolean | null;
  chromeRuntimeAvailable: boolean;
  chromeRuntimeIdAvailable: boolean;
  chromeStorageAvailable: boolean;
  storageProbeOk: boolean | null;
  invalidatedLatched: boolean;
  /** More than one distinct boot id among extension-owned runtime hosts. */
  duplicateOrStaleContentScript: boolean;
  internalErrorCount: number;
  errors: Array<{
    code: string;
    scope: string;
    count: number;
    timestamp: number;
    sanitizedMessage: string;
  }>;
}

interface HealthState {
  contentScriptBootId: string;
  contentScriptBootTime: number;
  extensionContextValid: boolean | null;
  chromeRuntimeAvailable: boolean;
  chromeRuntimeIdAvailable: boolean;
  chromeStorageAvailable: boolean;
  storageProbeOk: boolean | null;
  invalidatedLatched: boolean;
  lastInternalErrorCode: string | null;
  internalErrorCount: number;
  errors: InternalErrorEvent[];
  invalidationListenersNotified: boolean;
}

function initialState(): HealthState {
  return {
    contentScriptBootId: newBootId(),
    contentScriptBootTime: Date.now(),
    extensionContextValid: null,
    chromeRuntimeAvailable: false,
    chromeRuntimeIdAvailable: false,
    chromeStorageAvailable: false,
    storageProbeOk: null,
    invalidatedLatched: false,
    lastInternalErrorCode: null,
    internalErrorCount: 0,
    errors: [],
    invalidationListenersNotified: false,
  };
}

let state: HealthState = initialState();

type InvalidationListener = () => void;
const invalidationListeners = new Set<InvalidationListener>();

/**
 * Register a callback fired ONCE when invalidation is first latched (used by
 * the content runtime to quiesce stale extension-owned behavior). Returns an
 * unregister function.
 */
export function onInvalidated(listener: InvalidationListener): () => void {
  invalidationListeners.add(listener);
  if (state.invalidatedLatched && !state.invalidationListenersNotified) {
    // Already latched before registration: fire immediately (once).
    state.invalidationListenersNotified = true;
    listener();
  }
  return () => invalidationListeners.delete(listener);
}

/**
 * Record one internal CGL-owned error. Aggregates identical
 * (code, scope, message) occurrences into one bounded event whose count
 * grows; the FIRST occurrence emits one console error, later identical
 * occurrences only increment the count (no console flood). Different errors
 * are never hidden.
 */
export function recordInternalError(event: {
  code: string;
  scope: string;
  severity?: "warn" | "error";
  err?: unknown;
  message?: string;
  operation?: string;
}): void {
  const severity = event.severity ?? "error";
  const message =
    event.message !== undefined
      ? sanitizeErrorMessage(event.message)
      : sanitizeErrorMessage(event.err);
  state.internalErrorCount++;
  state.lastInternalErrorCode = event.code;

  const existing = state.errors.find(
    (e) =>
      e.code === event.code &&
      e.scope === event.scope &&
      e.sanitizedMessage === message,
  );
  if (existing) {
    existing.count++;
    existing.timestamp = Date.now();
    return; // identical occurrence: count only, no repeat console emission
  }

  const entry: InternalErrorEvent = {
    code: event.code,
    scope: event.scope,
    severity,
    count: 1,
    timestamp: Date.now(),
    firstTimestamp: Date.now(),
    sanitizedMessage: message,
    ...(event.operation != null ? { operation: event.operation } : {}),
  };
  if (state.errors.length >= MAX_ERROR_EVENTS) state.errors.shift();
  state.errors.push(entry);

  const opSuffix = event.operation ? ` (${event.operation})` : "";
  if (severity === "warn") {
    logger.warn(
      event.scope,
      `${event.code}${opSuffix}: ${message || "(no message)"}`,
    );
  } else {
    logger.error(
      event.scope,
      `${event.code}${opSuffix}: ${message || "(no message)"}`,
    );
  }
}

/**
 * Latch the runtime as invalidated (sticky for this execution), record the
 * canonical internal error, and notify quiesce listeners once.
 */
export function latchInvalidated(operation?: string): void {
  state.invalidatedLatched = true;
  state.extensionContextValid = false;
  state.storageProbeOk = false;
  recordInternalError({
    code: CODE_EXTENSION_CONTEXT_INVALIDATED,
    scope: "runtime",
    severity: "error",
    message: "Extension context invalidated.",
    ...(operation != null ? { operation } : {}),
  });
  if (!state.invalidationListenersNotified) {
    state.invalidationListenersNotified = true;
    for (const listener of [...invalidationListeners]) listener();
  }
}

export function isInvalidatedLatched(): boolean {
  return state.invalidatedLatched;
}

/**
 * Authoritative runtime-ok semantics: the content script is alive (this code
 * running proves it), the extension context is VALID, and the required
 * extension API probe is healthy. Unknown/not-yet-probed (null) does NOT
 * claim broken — production boot probes immediately, and non-extension
 * environments (unit tests) are simply not applicable.
 */
export function isRuntimeOk(): boolean {
  return (
    !state.invalidatedLatched &&
    state.extensionContextValid !== false &&
    state.storageProbeOk !== false
  );
}

/**
 * Canonical extension-context health check: presence of chrome.runtime.id
 * and chrome.storage.local, followed by ONE bounded harmless storage read.
 * No writes. Updates every health flag; latches invalidation when the read
 * fails with the canonical Chrome invalidation error.
 *
 * Concurrent callers share the single in-flight probe.
 */
let inflightProbe: Promise<void> | null = null;

export function probeExtensionContext(): Promise<void> {
  if (inflightProbe) return inflightProbe;
  inflightProbe = (async () => {
    if (state.invalidatedLatched) return; // sticky: never un-red a dead runtime
    const chromeAvail = typeof chrome !== "undefined";
    const rtAvail = chromeAvail && typeof chrome.runtime !== "undefined";
    const rtIdOk =
      rtAvail &&
      typeof chrome.runtime.id === "string" &&
      chrome.runtime.id.length > 0;
    const stAvail =
      chromeAvail && typeof chrome.storage !== "undefined" && typeof chrome.storage.local !== "undefined";
    state.chromeRuntimeAvailable = rtAvail;
    state.chromeRuntimeIdAvailable = rtIdOk;
    state.chromeStorageAvailable = stAvail;

    if (!chromeAvail) {
      // Not an extension execution context at all (unit-test environment):
      // not applicable — neither green nor red.
      state.extensionContextValid = null;
      state.storageProbeOk = null;
      return;
    }
    if (!rtAvail || !rtIdOk || !stAvail) {
      state.extensionContextValid = false;
      state.storageProbeOk = false;
      recordInternalError({
        code: "EXTENSION_APIS_INCOMPLETE",
        scope: "runtime",
        severity: "error",
        message: "required chrome runtime/storage APIs unavailable",
        operation: "probeExtensionContext",
      });
      return;
    }
    try {
      await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
      state.extensionContextValid = true;
      state.storageProbeOk = true;
    } catch (err) {
      if (isExtensionContextInvalidatedError(err)) {
        latchInvalidated("probeExtensionContext");
      } else {
        state.extensionContextValid = false;
        state.storageProbeOk = false;
        recordInternalError({
          code: "STORAGE_PROBE_FAILED",
          scope: "runtime",
          severity: "error",
          err,
          operation: "probeExtensionContext",
        });
      }
    }
  })().finally(() => {
    inflightProbe = null;
  });
  return inflightProbe;
}

/**
 * Observe a storage-layer outcome without performing a probe. Used by the
 * settings storage path so EVERY real read/write keeps health current.
 */
export function noteStorageSuccess(): void {
  if (state.invalidatedLatched) return;
  state.chromeRuntimeAvailable = typeof chrome !== "undefined" && typeof chrome.runtime !== "undefined";
  state.chromeRuntimeIdAvailable =
    state.chromeRuntimeAvailable &&
    typeof chrome.runtime?.id === "string" &&
    chrome.runtime.id.length > 0;
  state.chromeStorageAvailable =
    typeof chrome !== "undefined" && typeof chrome.storage?.local !== "undefined";
  state.extensionContextValid = true;
  state.storageProbeOk = true;
}

/**
 * Classify a storage-layer failure. Returns the canonical code when this is
 * the Chrome context-invalidation failure (and latches invalidation +
 * notifies quiesce listeners), otherwise records a bounded internal error
 * event and returns a generic code.
 */
export function classifyStorageFailure(
  err: unknown,
  scope: string,
  operation: string,
): string {
  if (isExtensionContextInvalidatedError(err)) {
    latchInvalidated(operation);
    return CODE_EXTENSION_CONTEXT_INVALIDATED;
  }
  recordInternalError({ code: "STORAGE_OPERATION_FAILED", scope, err, operation });
  return "STORAGE_OPERATION_FAILED";
}

/**
 * Stamp an extension-owned runtime host element with THIS runtime's boot id.
 * X-Ray uses these marks to detect multiple distinct (duplicate or stale)
 * content-script runtimes in one page. No new visible hosts are created for
 * this check — existing extension-owned ownership is reused.
 */
export const BOOT_ID_ATTR = "data-cgl-boot-id";

export function stampBootId(el: Element): void {
  el.setAttribute(BOOT_ID_ATTR, state.contentScriptBootId);
}

/** Collect distinct boot ids among extension-owned runtime hosts. */
export function collectDistinctBootIds(doc: Document | null): string[] {
  if (!doc) return [];
  const ids = new Set<string>();
  doc.querySelectorAll(`[${BOOT_ID_ATTR}]`).forEach((el) => {
    const v = el.getAttribute(BOOT_ID_ATTR);
    if (v) ids.add(v);
  });
  return [...ids];
}

/** Serializable snapshot for the X-Ray report (privacy-safe fields only). */
export function snapshotRuntimeHealth(doc: Document | null): RuntimeHealthSnapshot {
  const identity = getBuildIdentity();
  const bootIds = collectDistinctBootIds(doc);
  return {
    ...identity,
    contentScriptBootId: state.contentScriptBootId,
    contentScriptBootTime: state.contentScriptBootTime,
    extensionContextValid: state.extensionContextValid,
    chromeRuntimeAvailable: state.chromeRuntimeAvailable,
    chromeRuntimeIdAvailable: state.chromeRuntimeIdAvailable,
    chromeStorageAvailable: state.chromeStorageAvailable,
    storageProbeOk: state.storageProbeOk,
    invalidatedLatched: state.invalidatedLatched,
    duplicateOrStaleContentScript: bootIds.length > 1,
    internalErrorCount: state.internalErrorCount,
    errors: state.errors.map((e) => ({
      code: e.code,
      scope: e.scope,
      count: e.count,
      timestamp: e.timestamp,
      sanitizedMessage: e.sanitizedMessage,
    })),
  };
}

/** Current boot identity accessors. */
export function getContentScriptBootId(): string {
  return state.contentScriptBootId;
}

export function getContentScriptBootTime(): number {
  return state.contentScriptBootTime;
}

/** TEST-ONLY: reset all in-memory health state (fresh simulated runtime). */
export function resetRuntimeHealthForTests(): void {
  state = initialState();
  invalidationListeners.clear();
  inflightProbe = null;
}
