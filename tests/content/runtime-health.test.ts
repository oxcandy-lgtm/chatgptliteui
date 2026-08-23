import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CODE_EXTENSION_CONTEXT_INVALIDATED,
  getContentScriptBootId,
  getBuildIdentity,
  isExtensionContextInvalidatedError,
  isInvalidatedLatched,
  isRuntimeOk,
  newBootId,
  onInvalidated,
  probeExtensionContext,
  recordInternalError,
  resetRuntimeHealthForTests,
  sanitizeErrorMessage,
  snapshotRuntimeHealth,
} from "../../src/shared/runtime-health.js";
import {
  getSettings,
  SettingsUnavailableError,
} from "../../src/settings/storage.js";

/**
 * Focused runtime-health tests (NX: runtime health port).
 *
 * Fixture INVALIDATED — chrome.storage.local.get throws the real Chrome
 * "Extension context invalidated" error:
 *  - classified EXTENSION_CONTEXT_INVALIDATED;
 *  - runtime invalid latched; runtimeOk=false;
 *  - defaults NOT treated as authoritative settings (getSettings rejects);
 *  - quiesce listener fired exactly once;
 *  - repeated identical failures console-error ONCE (no spam);
 *  - runtimeHealth snapshot carries code + count.
 *
 * Fixture HEALTHY — chrome.runtime.id exists and storage read succeeds:
 *  - context valid, runtimeOk true, storageProbeOk true, no internal errors.
 *
 * Fixture IDENTITY — buildId present; bootId stable per simulated runtime and
 * different across simulated runtimes.
 */

type GetStub = (keys: unknown) => Promise<Record<string, unknown>>;

function installChrome(get: GetStub): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.chrome = {
    runtime: { id: "fixture-extension-id" },
    storage: {
      local: {
        get,
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
}

function removeChrome(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.chrome;
}

describe("runtime-health classifier", () => {
  beforeEach(() => resetRuntimeHealthForTests());
  afterEach(() => removeChrome());

  it("classifies ONLY the canonical Chrome invalidation message", () => {
    expect(
      isExtensionContextInvalidatedError(new Error("Extension context invalidated.")),
    ).toBe(true);
    expect(
      isExtensionContextInvalidatedError(new Error("Extension context invalidated")),
    ).toBe(true);
    // Loose/unrelated look-alikes must NOT match.
    expect(
      isExtensionContextInvalidatedError(new Error("some other context invalidated")),
    ).toBe(false);
    expect(isExtensionContextInvalidatedError(new Error("Network error"))).toBe(false);
    expect(isExtensionContextInvalidatedError(undefined)).toBe(false);
  });

  it("sanitized messages are bounded and control-char-free", () => {
    const out = sanitizeErrorMessage(`Extension context invalidated.\n\t ${"x".repeat(400)}`);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toMatch(/[\n\t]/);
  });
});

describe("runtime-health probe + fail-closed storage", () => {
  let consoleErrors: string[];
  let origConsoleError: typeof console.error;
  let origConsoleWarn: typeof console.warn;

  beforeEach(() => {
    resetRuntimeHealthForTests();
    removeChrome();
    consoleErrors = [];
    origConsoleError = console.error;
    origConsoleWarn = console.warn;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error = origConsoleError;
    console.warn = origConsoleWarn;
    vi.restoreAllMocks();
    removeChrome();
  });

  it("INVALIDATED: classified + latched + runtimeOk=false + quiesce once", async () => {
    installChrome(() => Promise.reject(new Error("Extension context invalidated.")));
    let quiesceCalls = 0;
    onInvalidated(() => {
      quiesceCalls++;
    });

    await probeExtensionContext();

    expect(isInvalidatedLatched()).toBe(true);
    expect(isRuntimeOk()).toBe(false);
    expect(quiesceCalls).toBe(1);

    const snap = snapshotRuntimeHealth(null);
    expect(snap.invalidatedLatched).toBe(true);
    expect(snap.extensionContextValid).toBe(false);
    expect(snap.storageProbeOk).toBe(false);
    const evt = snap.errors.find(
      (e) => e.code === CODE_EXTENSION_CONTEXT_INVALIDATED,
    );
    expect(evt?.count).toBe(1);
  });

  it("HEALTHY: context valid, probe ok, no internal errors", async () => {
    installChrome(() =>
      Promise.resolve({
        settings: { schemaVersion: 3, settings: { enabled: true } },
      }),
    );
    await probeExtensionContext();

    expect(isInvalidatedLatched()).toBe(false);
    expect(isRuntimeOk()).toBe(true);
    const snap = snapshotRuntimeHealth(null);
    expect(snap.extensionContextValid).toBe(true);
    expect(snap.storageProbeOk).toBe(true);
    expect(snap.chromeRuntimeIdAvailable).toBe(true);
    expect(snap.chromeStorageAvailable).toBe(true);
    expect(snap.errors.length).toBe(0);
    expect(snap.internalErrorCount).toBe(0);
  });

  it("repeated identical failure console-errors ONCE (no spam)", async () => {
    installChrome(() => Promise.reject(new Error("Extension context invalidated.")));
    await probeExtensionContext();
    await probeExtensionContext();
    await probeExtensionContext();
    const logs = consoleErrors.filter((l) =>
      l.includes(CODE_EXTENSION_CONTEXT_INVALIDATED),
    );
    expect(logs.length).toBe(1);
  });

  it("getSettings FAILS CLOSED after invalidation (rejects, no defaults)", async () => {
    installChrome(() => Promise.reject(new Error("Extension context invalidated.")));
    await probeExtensionContext();
    await expect(getSettings()).rejects.toBeInstanceOf(SettingsUnavailableError);
  });

  it("getSettings classifies a raw invalidation throw even without prior probe", async () => {
    installChrome(() => Promise.reject(new Error("Extension context invalidated.")));
    await expect(getSettings()).rejects.toMatchObject({
      code: CODE_EXTENSION_CONTEXT_INVALIDATED,
    });
    expect(isInvalidatedLatched()).toBe(true);
    expect(isRuntimeOk()).toBe(false);
  });

  it("normal storage ABSENCE still falls back safely (no latch)", async () => {
    installChrome(() => Promise.resolve({}));
    const s = await getSettings();
    expect(typeof s.enabled).toBe("boolean");
    expect(isInvalidatedLatched()).toBe(false);
    expect(isRuntimeOk()).toBe(true);
  });

  it("different errors are never collapsed away", () => {
    recordInternalError({ code: "A", scope: "s", message: "first" });
    recordInternalError({ code: "B", scope: "s", message: "second" });
    recordInternalError({ code: "A", scope: "s", message: "third-distinct" });
    const snap = snapshotRuntimeHealth(null);
    expect(snap.errors.filter((e) => e.code === "A").length).toBe(2);
    expect(snap.errors.some((e) => e.code === "B")).toBe(true);
    expect(snap.internalErrorCount).toBe(3);
  });
});

describe("build/boot identity", () => {
  beforeEach(() => resetRuntimeHealthForTests());
  afterEach(() => removeChrome());

  it("buildId is present and non-empty", () => {
    const id = getBuildIdentity();
    expect(id.buildId.length).toBeGreaterThan(0);
    expect(id.sourceHead.length).toBeGreaterThan(0);
    expect(typeof id.dirtyAtBuild).toBe("boolean");
  });

  it("bootId non-empty and stable within one simulated runtime", () => {
    const first = getContentScriptBootId();
    expect(first).toMatch(/^boot-/);
    expect(getContentScriptBootId()).toBe(first);
    expect(snapshotRuntimeHealth(null).contentScriptBootId).toBe(first);
  });

  it("a NEW simulated runtime gets a different bootId", () => {
    const old = newBootId();
    resetRuntimeHealthForTests();
    expect(getContentScriptBootId()).not.toBe(old);
  });
});
