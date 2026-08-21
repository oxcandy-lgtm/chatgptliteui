import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../../src/settings/defaults.js";
import type { Settings } from "../../../src/shared/types.js";
import { WritingCopyController } from "../../../src/features/writing-copy/writing-copy-controller.js";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import { fingerprintText } from "../../../src/features/writing-copy/content-fingerprint.js";
import {
  conversationTokenFromLocation,
  conversationFingerprintFromLocation,
} from "../../../src/features/writing-copy/block-identity.js";
import {
  isValidCopiedRecord,
  saveCopiedRecord,
} from "../../../src/features/writing-copy/copied-state-store.js";

/**
 * Authoritative Phase 4 persistent-state-spine integration RUN.
 *
 * copy B -> durable save -> teardown -> fresh runtime restore ->
 * edit invalidation -> fresh runtime stays uncopied ->
 * cross-conversation isolation -> invalid route never persists.
 */

const STORAGE_PREFIX = "cgl:writingCopy:history:";
const BLOCK_MARKER = 'data-cgl-writing-block="true"';
const STATE_ATTR = "data-cgl-writing-copy-state";

const TEXT_A = "First prose alpha.";
const TEXT_B_ORIGINAL = "Second prose beta.";
const TEXT_B_CHANGED = "Second prose rewritten.";

/** Map-backed chrome.storage.local stub with a key-aware get gate for races. */
class StorageStub {
  readonly map = new Map<string, unknown>();
  private gateKey: string | null = null;
  private gate: {
    promise: Promise<Record<string, unknown>>;
    resolve: (v: Record<string, unknown>) => void;
  } | null = null;
  gateConsumed = false;
  failNextSet = false;

  /** Hold the NEXT get for `key` until released (deep-path race control). */
  armGate(key: string): void {
    let resolve!: (v: Record<string, unknown>) => void;
    const promise = new Promise<Record<string, unknown>>((res) => {
      resolve = res;
    });
    this.gateKey = key;
    this.gate = { promise, resolve };
    this.gateConsumed = false;
  }

  releaseGate(): void {
    const key = this.gateKey;
    if (!key || !this.gate) return;
    const value = this.map.has(key) ? this.map.get(key) : undefined;
    const payload =
      value === undefined ? {} : ({ [key]: value } as Record<string, unknown>);
    this.gate.resolve(payload);
    this.gate = null;
    this.gateKey = null;
  }

  async get(key: string): Promise<Record<string, unknown>> {
    if (this.gate && this.gateKey === key) {
      const held = this.gate;
      this.gate = null;
      this.gateKey = null;
      this.gateConsumed = true;
      return held.promise;
    }
    if (this.map.has(key)) return { [key]: this.map.get(key) };
    return {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false;
      return Promise.reject(new Error("simulated durable-write failure"));
    }
    for (const [k, v] of Object.entries(items)) this.map.set(k, v);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  snapshot(): string {
    return JSON.stringify([...this.map.entries()]);
  }

  historyKeys(): string[] {
    return this.keys().filter((k) => k.startsWith(STORAGE_PREFIX));
  }
}

function makeSettings(): Settings {
  const s = cloneDefaults();
  s.enabled = true;
  s.writingCopy = {
    enabled: true,
    position: "middle-right",
    shortcutEnabled: true,
  };
  return s;
}

/** Conversation page with two Assistant turns, one writing block each. */
const PAGE = (textA: string, textB: string): string =>
  `<main role="main"><section data-testid="thread" aria-label="conversation">` +
  `<div data-message-author-role="assistant" data-testid="assistant-message">` +
  `<div data-testid="text-block" id="block-a" style="position:absolute;top:450px;left:0;width:300px;height:100px;"><p>${textA}</p></div>` +
  `</div>` +
  `<div data-message-author-role="assistant" data-testid="assistant-message">` +
  `<div data-testid="text-block" id="block-b" style="position:absolute;top:200px;left:0;width:300px;height:100px;"><p>${textB}</p></div>` +
  `</div>` +
  `</section></main>`;

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Wait until every marked block carries a semantic state attribute. */
async function waitUntilHydrated(doc: Document): Promise<void> {
  await until(() => {
    const blocks = Array.from(
      doc.querySelectorAll(`[${BLOCK_MARKER}]`),
    ) as Element[];
    return (
      blocks.length > 0 &&
      blocks.every((b) => b.getAttribute(STATE_ATTR) != null)
    );
  });
}

describe("persistent state spine — authoritative RUN", () => {
  let dom: JSDOM;
  let storage: StorageStub;
  let writeCalls: string[];
  let originalGlobals: Record<string, unknown>;

  const stateOf = (id: string): string | null =>
    dom.window.document.getElementById(id)?.getAttribute(STATE_ATTR) ?? null;

  /** Make block `id` the most viewport-centered target. */
  const focusBlock = (id: string): void => {
    const a = dom.window.document.getElementById("block-a");
    const b = dom.window.document.getElementById("block-b");
    for (const el of [a, b]) {
      if (!el) continue;
      el.style.top = el.id === id ? "250px" : "520px";
    }
  };

  const clickHostCopyButton = (): void => {
    const host = dom.window.document.querySelector(
      '[data-cgl-writing-copy-host="true"]',
    );
    const btn = host?.shadowRoot?.querySelector("button");
    if (!btn) throw new Error("copy host button not mounted");
    (btn as HTMLButtonElement).click();
  };

  const newController = (): WritingCopyController =>
    new WritingCopyController(
      dom.window.document.documentElement,
      createAdapter(),
    );

  beforeEach(() => {
    storage = new StorageStub();
    writeCalls = [];
    originalGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      HTMLElement: globalThis.HTMLElement,
      Element: globalThis.Element,
      Node: globalThis.Node,
      DOMRect: globalThis.DOMRect,
      KeyboardEvent: globalThis.KeyboardEvent,
      MouseEvent: globalThis.MouseEvent,
      FocusEvent: globalThis.FocusEvent,
      IntersectionObserver: globalThis.IntersectionObserver,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
      navigator: globalThis.navigator,
      chrome: globalThis.chrome,
    };
  });

  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    (Object.keys(originalGlobals) as (keyof typeof originalGlobals)[]).forEach(
      (k) => {
        if (originalGlobals[k] === undefined) {
          try {
            delete g[k];
          } catch {
            /* ignore */
          }
        } else {
          try {
            const desc = Object.getOwnPropertyDescriptor(globalThis, k);
            if (desc && !desc.writable) return;
            g[k] = originalGlobals[k];
          } catch {
            /* ignore */
          }
        }
      },
    );
    dom?.window.close();
  });

  function installDom(url: string, html: string): void {
    dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
      url,
      pretendToBeVisual: true,
    });
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.HTMLElement = dom.window.HTMLElement;
    g.Node = dom.window.Node;
    // jsdom returns zero rects; synthesize from inline geometry so the tracker
    // can rank candidates by viewport-center distance.
    dom.window.Element.prototype.getBoundingClientRect = function () {
      const el = this as HTMLElement;
      const parse = (v: string): number => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
      };
      const top = parse(el.style.top);
      const left = parse(el.style.left);
      const width = parse(el.style.width);
      const height = parse(el.style.height);
      return {
        top,
        left,
        width,
        height,
        bottom: top + height,
        right: left + width,
        x: left,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    Object.defineProperty(dom.window, "innerHeight", {
      value: 600,
      configurable: true,
    });
    Object.defineProperty(dom.window, "innerWidth", {
      value: 1000,
      configurable: true,
    });
    const nav = dom.window.navigator as unknown as {
      clipboard?: { writeText(t: string): Promise<void> };
    };
    nav.clipboard = {
      writeText: (t: string) => {
        writeCalls.push(t);
        return Promise.resolve();
      },
    };
    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { clipboard: nav.clipboard },
        configurable: true,
      });
    } catch {
      /* ignore */
    }
    g.chrome = { storage: { local: storage } } as unknown as typeof chrome;
  }

  it(
    "copy B -> save -> teardown -> restore -> edit-invalidate -> isolate -> invalid route",
    { timeout: 20000 },
    async () => {
      // ---------- Step 1: copy B ----------
      installDom("https://chatgpt.com/c/conv-a", PAGE(TEXT_A, TEXT_B_ORIGINAL));
      const c1 = newController();
      c1.apply(makeSettings());
      expect(c1.isHostMounted).toBe(true);
      await waitUntilHydrated(dom.window.document);
      expect(stateOf("block-a")).toBe("uncopied");
      expect(stateOf("block-b")).toBe("uncopied");

      focusBlock("block-b");
      clickHostCopyButton();
      await until(() => stateOf("block-b") === "copied");

      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0]).toBe(TEXT_B_ORIGINAL);

      const historyA = storage.historyKeys();
      expect(historyA).toHaveLength(1);
      expect(historyA[0]).toMatch(new RegExp(`^${STORAGE_PREFIX}[0-9a-f]{32}$`));
      const keyA = historyA[0] as string;
      const recordsA = storage.map.get(keyA) as unknown[];
      expect(recordsA).toHaveLength(1);
      expect(recordsA[0]).toMatchObject({ turnIndex: 1, blockIndex: 0 });
      expect((recordsA[0] as { fingerprint: string }).fingerprint).toBe(
        await fingerprintText(TEXT_B_ORIGINAL),
      );
      // A has no record anywhere.
      expect(storage.snapshot()).not.toContain(await fingerprintText(TEXT_A));

      expect(stateOf("block-b")).toBe("copied");
      expect(stateOf("block-a")).toBe("uncopied");

      // ---------- Step 2: teardown ----------
      c1.restore();
      expect(c1.isHostMounted).toBe(false);
      expect(
        dom.window.document.querySelectorAll(`[${BLOCK_MARKER}]`),
      ).toHaveLength(0);
      expect(
        dom.window.document.querySelectorAll(`[${STATE_ATTR}]`),
      ).toHaveLength(0);
      // Durable storage survives teardown.
      expect(storage.map.get(keyA)).toEqual(recordsA);

      // ---------- Step 3: fresh runtime restores B, not A ----------
      const c2 = newController();
      c2.apply(makeSettings());
      await waitUntilHydrated(dom.window.document);
      expect(stateOf("block-a")).toBe("uncopied");
      expect(stateOf("block-b")).toBe("copied");

      // ---------- Step 4: editing B invalidates and removes the record ----------
      const pB = dom.window.document.querySelector("#block-b p");
      if (!pB) throw new Error("missing B paragraph");
      pB.textContent = TEXT_B_CHANGED;
      c2.refresh(makeSettings());
      await waitUntilHydrated(dom.window.document);
      await until(() => stateOf("block-b") === "uncopied");
      expect(stateOf("block-b")).toBe("uncopied");
      expect(stateOf("block-a")).toBe("uncopied");
      const afterEdit = storage.map.get(keyA) as unknown[];
      expect(
        afterEdit.some(
          (r) => (r as { turnIndex: number }).turnIndex === 1,
        ),
      ).toBe(false);
      // No raw previous/current text exists in storage.
      const snapAfterEdit = storage.snapshot();
      expect(snapAfterEdit).not.toContain(TEXT_B_ORIGINAL);
      expect(snapAfterEdit).not.toContain(TEXT_B_CHANGED);
      expect(snapAfterEdit).not.toContain(TEXT_A);

      // ---------- Step 5: fresh runtime again — B stays uncopied ----------
      c2.teardown();
      const c3 = newController();
      c3.apply(makeSettings());
      await waitUntilHydrated(dom.window.document);
      expect(stateOf("block-b")).toBe("uncopied");
      expect(stateOf("block-a")).toBe("uncopied");
      c3.teardown();

      // ---------- Step 6: cross-conversation isolation ----------
      // Seed a durable conv-A record for block A (unchanged text, same
      // structure), so the isolation check below is non-trivial.
      const fpA = await conversationFingerprintFromLocation();
      expect(fpA).toMatch(/^[0-9a-f]{32}$/);
      const convASeeded = [
        {
          turnIndex: 0,
          blockIndex: 0,
          fingerprint: await fingerprintText(TEXT_A),
          copiedAt: Date.now(),
        },
      ];
      storage.map.set(STORAGE_PREFIX + fpA, convASeeded);

      dom.window.history.replaceState(null, "", "/c/conv-b");
      const c4 = newController();
      c4.apply(makeSettings());
      await waitUntilHydrated(dom.window.document);
      // Identical structure + identical text, different conversation: the
      // conv-A record MUST NOT restore into conv B.
      expect(stateOf("block-a")).toBe("uncopied");
      expect(stateOf("block-b")).toBe("uncopied");
            // Storage keys are isolated: the conv-A key survives untouched, and no
      // conv-B key is fabricated (hydration never creates keys). Raw tokens
      // are never persisted.
      const keysAfter = storage.historyKeys();
      expect(keysAfter).toEqual([keyA]);
      expect(storage.map.get(keyA)).toEqual(convASeeded);
      const snapCross = storage.snapshot();
      expect(snapCross).not.toContain("conv-a");
      expect(snapCross).not.toContain("conv-b");
      expect(snapCross).not.toContain(TEXT_A);
      c4.teardown();

      // ---------- Step 7: no conversation route ----------
      installDom("https://chatgpt.com/", PAGE(TEXT_A, TEXT_B_ORIGINAL));
      const keysBeforeInvalid = new Set(storage.historyKeys());
      const writesBeforeInvalid = writeCalls.length;
      const c5 = newController();
      c5.apply(makeSettings());
      await new Promise((r) => setTimeout(r, 25)); // settle fail-closed hydration
      // Hydration claimed nothing.
      expect(
        dom.window.document.querySelectorAll(`[${STATE_ATTR}]`),
      ).toHaveLength(0);
      // Copy still works via clipboard...
      focusBlock("block-b");
      clickHostCopyButton();
      await until(() => writeCalls.length === writesBeforeInvalid + 1);
      expect(writeCalls[writeCalls.length - 1]).toBe(TEXT_B_ORIGINAL);
      await until(() => stateOf("block-b") != null);
      // ...but no copied-history key is created and COPIED is never claimed.
      expect(stateOf("block-b")).toBe("uncopied");
      expect(new Set(storage.historyKeys())).toEqual(keysBeforeInvalid);
      c5.teardown();
    },
  );

  it("stale hydration cannot apply or delete after a superseding refresh", { timeout: 10000 }, async () => {
    installDom("https://chatgpt.com/c/conv-race", PAGE("Alpha prose.", "Beta prose."));
    const fpRace = await conversationFingerprintFromLocation();
    expect(fpRace).toMatch(/^[0-9a-f]{32}$/);
    const raceKey = STORAGE_PREFIX + fpRace;
    const seeded = [
      {
        turnIndex: 0,
        blockIndex: 0,
        fingerprint: await fingerprintText("Alpha prose."),
        copiedAt: Date.now(),
      },
    ];
    storage.map.set(raceKey, seeded);
    // Hold the conv-A records read so generation 1 parks mid-hydration.
    storage.armGate(raceKey);

    const controller = newController();
    controller.apply(makeSettings());
    await until(() => storage.gateConsumed); // gen 1 is parked on the gated get

    // Supersede: route switch to conversation B starts a newer generation.
    dom.window.history.replaceState(null, "", "/c/conv-next");
    controller.refresh(makeSettings());
    await waitUntilHydrated(dom.window.document); // gen 2 completed: uncopied
    expect(stateOf("block-a")).toBe("uncopied");
    expect(stateOf("block-b")).toBe("uncopied");

    // Resolve the stale hydration for conversation A.
    storage.releaseGate();
    await until(
      () =>
        dom.window.document.querySelectorAll(`[${STATE_ATTR}="copied"]`)
          .length === 0,
    );

    // Stale generation applied NOTHING and deleted NOTHING.
    expect(
      dom.window.document.querySelectorAll(`[${STATE_ATTR}="copied"]`),
    ).toHaveLength(0);
    expect(stateOf("block-a")).toBe("uncopied");
    expect(stateOf("block-b")).toBe("uncopied");
    expect(storage.map.get(raceKey)).toEqual(seeded);
    controller.teardown();
  });
});

describe("conversation identity (fail-closed)", () => {
  const originalWindow = globalThis.window;

  function stubWindow(href: string): void {
    (globalThis as unknown as Record<string, unknown>).window = {
      location: { href },
    };
  }

  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (originalWindow === undefined) delete g.window;
    else g.window = originalWindow;
    vi.unstubAllGlobals();
  });

  it("derives a compact 128-bit SHA-256 fingerprint from the conversation token", async () => {
    stubWindow("https://chatgpt.com/c/abc123?model=x");
    const fp = await conversationFingerprintFromLocation();
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    // Query string and title never affect identity.
    stubWindow("https://chatgpt.com/c/abc123");
    expect(await conversationFingerprintFromLocation()).toBe(fp);
    stubWindow("https://chatgpt.com/c/other99");
    expect(await conversationFingerprintFromLocation()).not.toBe(fp);
  });

  it("returns null when no /c/<token> route exists", async () => {
    for (const href of [
      "https://chatgpt.com/",
      "https://chatgpt.com/?q=search",
      "https://chatgpt.com/g/g-123/library",
    ]) {
      stubWindow(href);
      expect(conversationTokenFromLocation()).toBeNull();
      expect(await conversationFingerprintFromLocation()).toBeNull();
    }
  });

  it("fails closed when Web Crypto is unavailable", async () => {
    stubWindow("https://chatgpt.com/c/abc123");
    vi.stubGlobal("crypto", { subtle: undefined });
    expect(await conversationFingerprintFromLocation()).toBeNull();
  });
});

describe("copied-state store validation and ack", () => {
  const originalChrome = globalThis.chrome;

  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (originalChrome === undefined) delete g.chrome;
    else g.chrome = originalChrome;
  });

  const VALID = {
    turnIndex: 0,
    blockIndex: 1,
    fingerprint: "a".repeat(32),
    copiedAt: 100,
  };

  it("accepts only well-formed records", () => {
    expect(isValidCopiedRecord(VALID)).toBe(true);
    expect(isValidCopiedRecord({ ...VALID, turnIndex: -1 })).toBe(false);
    expect(isValidCopiedRecord({ ...VALID, turnIndex: 1.5 })).toBe(false);
    expect(isValidCopiedRecord({ ...VALID, turnIndex: Number.NaN })).toBe(false);
    expect(isValidCopiedRecord({ ...VALID, blockIndex: -3 })).toBe(false);
    expect(isValidCopiedRecord({ ...VALID, fingerprint: "" })).toBe(false);
    expect(isValidCopiedRecord({ ...VALID, fingerprint: "xyz" })).toBe(false);
    expect(isValidCopiedRecord({ ...VALID, fingerprint: "A".repeat(32) })).toBe(
      false,
    );
    expect(isValidCopiedRecord({ ...VALID, copiedAt: -1 })).toBe(false);
    expect(isValidCopiedRecord({ ...VALID, copiedAt: Number.NaN })).toBe(false);
    expect(isValidCopiedRecord(null)).toBe(false);
    expect(isValidCopiedRecord("record")).toBe(false);
  });

  it("reports real durable-save success and failure", async () => {
    const backing = new Map<string, unknown>();
    const g = globalThis as unknown as Record<string, unknown>;
    const failing = {
      storage: {
        local: {
          get: async (k: string) =>
            backing.has(k) ? { [k]: backing.get(k) } : {},
          set: async () => Promise.reject(new Error("quota")),
          remove: async (k: string) => void backing.delete(k),
        },
      },
    };
    g.chrome = failing;
    await expect(saveCopiedRecord("f".repeat(32), VALID)).resolves.toBe(false);

    const working = {
      storage: {
        local: {
          get: async (k: string) =>
            backing.has(k) ? { [k]: backing.get(k) } : {},
          set: async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) backing.set(k, v);
          },
          remove: async (k: string) => void backing.delete(k),
        },
      },
    };
    g.chrome = working;
    await expect(saveCopiedRecord("f".repeat(32), VALID)).resolves.toBe(true);
    expect(backing.has(STORAGE_PREFIX + "f".repeat(32))).toBe(true);

    // No chrome storage at all: persistence unavailable, reported honestly.
    delete g.chrome;
    await expect(saveCopiedRecord("f".repeat(32), VALID)).resolves.toBe(false);
  });
});
