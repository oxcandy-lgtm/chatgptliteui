import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../../src/settings/defaults.js";
import type { Settings } from "../../../src/shared/types.js";
import { WritingCopyController } from "../../../src/features/writing-copy/writing-copy-controller.js";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import {
  saveCopiedRecord,
  getCopiedRecords,
} from "../../../src/features/writing-copy/copied-state-store.js";
import { conversationFingerprintFromLocation } from "../../../src/features/writing-copy/block-identity.js";

/**
 * STABLE COPYMARKER IDENTITY — focused regressions (NX: identity drift).
 *
 * Real bug: persisting a copy of WritingBlock A, then letting ChatGPT create
 * a NEW WritingBlock B, shifted positional identity so hydration matched A's
 * old slot against B's content, declared an "edit", and DELETED A's record —
 * erasing the CopyMarker.
 *
 * Proven here:
 *  1. identity drift: A survives B's creation (fingerprint-first matching)
 *  2. same-slot/different-fingerprint storage: B never overwrites A
 *  3. non-destructive miss: fpA absent from DOM stays persisted; restores
 *  4. duplicate fingerprints with unequal evidence: fail closed, no guessing
 *  5. existing copy success path stays green
 */

const STORAGE_PREFIX = "cgl:writingCopy:history:";
const STATE_ATTR = "data-cgl-writing-copy-state";
const HOST_ATTR = 'data-cgl-writing-copy-host="true"';

class StorageStub {
  readonly map = new Map<string, unknown>();
  async get(key: string | null): Promise<Record<string, unknown>> {
    if (key === null) return Object.fromEntries(this.map);
    if (this.map.has(key)) return { [key]: this.map.get(key) };
    return {};
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.map.set(k, v);
  }
  async remove(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) this.map.delete(k);
  }
  historyKeys(): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(STORAGE_PREFIX));
  }
}

function makeSettings(): Settings {
  const s = cloneDefaults();
  s.enabled = true;
  s.writingCopy = { ...s.writingCopy, enabled: true, position: "smart" };
  return s;
}

/** One anchored WritingBlock turn with the given editor id/text. */
function writingTurn(editorId: string, text: string): string {
  return (
    `<div data-message-author-role="assistant" data-testid="assistant-message">` +
    `<div class="writing-region">` +
    `<div class="writing-header"><button data-testid="writing-block-header-magic-edit-button">H</button></div>` +
    `<div contenteditable="true" class="editor" id="${editorId}" style="position:absolute;top:220px;left:0;width:300px;height:120px;">` +
    `<p>${text}</p>` +
    `</div></div></div>`
  );
}

function conversation(turnsHtml: string): string {
  return `<main role="main"><section data-testid="thread" aria-label="conversation">${turnsHtml}</section></main>`;
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("stable CopyMarker identity under structural drift", () => {
  let dom: JSDOM;
  let storage: StorageStub;
  let writeCalls: string[];
  let highlightRegistry: Map<string, Highlight>;
  let originalGlobals: Record<string, unknown>;

  beforeEach(() => {
    storage = new StorageStub();
    writeCalls = [];
    highlightRegistry = new Map();
    originalGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      HTMLElement: globalThis.HTMLElement,
      Element: globalThis.Element,
      Node: globalThis.Node,
      DOMRect: globalThis.DOMRect,
      KeyboardEvent: globalThis.KeyboardEvent,
      MouseEvent: globalThis.MouseEvent,
      IntersectionObserver: globalThis.IntersectionObserver,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
      navigator: globalThis.navigator,
      chrome: globalThis.chrome,
      Range: globalThis.Range,
      Highlight: globalThis.Highlight,
      CSS: globalThis.CSS,
    };
  });

  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    (Object.keys(originalGlobals) as (keyof typeof originalGlobals)[]).forEach(
      (k) => {
        if (originalGlobals[k] === undefined) {
          try { delete g[k]; } catch { /* ignore */ }
        } else {
          try {
            const desc = Object.getOwnPropertyDescriptor(globalThis, k);
            if (desc && !desc.writable) return;
            g[k] = originalGlobals[k];
          } catch { /* ignore */ }
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
        top, left, width, height,
        bottom: top + height, right: left + width,
        x: left, y: top, toJSON: () => ({}),
      } as DOMRect;
    };
    Object.defineProperty(dom.window, "innerHeight", { value: 600, configurable: true });
    Object.defineProperty(dom.window, "innerWidth", { value: 1000, configurable: true });

    class FakeRange {
      private startNode: Node | null = null;
      get startContainer(): Node {
        return this.startNode ?? dom.window.document;
      }
      setStartBefore(node: Node): void { this.startNode = node.parentNode; }
      setEndAfter(node: Node): void { this.startNode = node.parentNode; }
      selectNodeContents(): void {}
    }
    class FakeHighlight {
      constructor(..._ranges: unknown[]) {}
    }
    const win = dom.window as unknown as Record<string, unknown>;
    win.Range = FakeRange;
    win.Highlight = FakeHighlight;
    const cssRegistry = { highlights: highlightRegistry };
    try { win.CSS = cssRegistry; } catch { /* globalThis copy below */ }
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
    } catch { /* ignore */ }
    g.Range = FakeRange;
    g.Highlight = FakeHighlight;
    g.CSS = cssRegistry;
    g.chrome = { storage: { local: storage } } as unknown as typeof chrome;
  }

  /** Give the mounted host element a REAL rendered size (jsdom layout is 0). */
  const giveHostRealSize = (): void => {
    const hostEl = dom.window.document.querySelector(
      `[${HOST_ATTR}]`,
    ) as HTMLElement | null;
    if (!hostEl) throw new Error("host not mounted");
    Object.defineProperty(hostEl, "getBoundingClientRect", {
      value: () =>
        ({
          top: 260, left: 306, width: 80, height: 32,
          bottom: 292, right: 386, x: 306, y: 260, toJSON: () => ({}),
        }) as DOMRect,
      configurable: true,
    });
  };

  const newController = (): WritingCopyController =>
    new WritingCopyController(dom.window.document.documentElement, createAdapter());

  const stateOf = (id: string): string | null =>
    dom.window.document.getElementById(id)?.getAttribute(STATE_ATTR) ?? null;

  it("1. identity drift: creating B does NOT erase A's marker or record", async () => {
    installDom(
      "https://chatgpt.com/c/identity-drift",
      conversation(writingTurn("editor-A", TEXT_A)),
    );
    await resolveConvFp();
    const c = newController();
    c.apply(makeSettings());
    giveHostRealSize();

    // Click host Copy -> A copied + durably saved.
    clickHostCopyButton();
    await until(() => c.lastTransaction.completedAt != null);
    expect(c.lastTransaction.failureCode).toBeNull();
    await until(() => stateOf("editor-A") === "copied");
    expect(await countRecords()).toBe(1);

    // ---- ChatGPT generates B: new turn inserted BEFORE/after; ordering shifts.
    const section = dom.window.document.querySelector('[data-testid="thread"]')!;
    const bTurn = dom.window.document.createElement("div");
    bTurn.innerHTML = writingTurn("editor-B", TEXT_B);
    section.appendChild(bTurn.firstElementChild!);

    // Normal refresh/hydrate after structural change.
    c.refresh(makeSettings());
    await until(() => stateOf("editor-B") != null);

    // REQUIRED: safeCount=2, A COPIED, B UNCOPIED, ranges 1, record preserved.
    expect(dom.window.document.querySelectorAll('[data-cgl-writing-block="true"]').length).toBe(2);
    expect(stateOf("editor-A")).toBe("copied");
    expect(stateOf("editor-B")).toBe("uncopied");
    expect(
      dom.window.document.querySelectorAll(`[${STATE_ATTR}="copied"]`).length,
    ).toBe(1);
    await until(() => c.visualLayer.rangeCount === 1);
    expect(await countRecords()).toBe(1); // A preserved; nothing deleted/duplicated

    // Reload-equivalent: fresh controller hydrates from durable storage only.
    const c2 = newController();
    c2.apply(makeSettings());
    giveHostRealSize();
    await until(() =>
      stateOf2("editor-A") === "copied" && stateOf2("editor-B") === "uncopied",
    );
    await until(() => c2.visualLayer.rangeCount === 1);
    c.teardown();
    c2.teardown();

    function stateOf2(id: string): string | null {
      return dom.window.document.getElementById(id)?.getAttribute(STATE_ATTR) ?? null;
    }
  });

  it("2. same-slot different fingerprint: appended, never overwritten", async () => {
    installDom("https://chatgpt.com/c/slot-collision", "<div>boot</div>");
    await resolveConvFp();
    const fpA = await fingerprintOf(TEXT_A);
    const fpB = await fingerprintOf(TEXT_B);
    // A at position X (turn 2 / block 0), then B at the SAME position X.
    await saveCopiedRecord(FP_CONV, {
      turnIndex: 2, blockIndex: 0, fingerprint: fpA, copiedAt: 111,
    });
    await saveCopiedRecord(FP_CONV, {
      turnIndex: 2, blockIndex: 0, fingerprint: fpB, copiedAt: 222,
    });
    const recs = await getCopiedRecords(FP_CONV);
    expect(recs.length).toBe(2);
    expect(recs.some((r) => r.fingerprint === fpA)).toBe(true);
    expect(recs.some((r) => r.fingerprint === fpB)).toBe(true);
  });

  it("3. non-destructive miss: absent fingerprint kept, restores when back", async () => {
    installDom(
      "https://chatgpt.com/c/non-destructive",
      conversation(writingTurn("editor-B-only", TEXT_B)),
    );
    await resolveConvFp();
    const fpA = await fingerprintOf(TEXT_A);
    // Persist ONLY fpA while the DOM currently shows only B.
    await saveCopiedRecord(FP_CONV, {
      turnIndex: 0, blockIndex: 0, fingerprint: fpA, copiedAt: 333,
    });

    const c = newController();
    c.apply(makeSettings());
    await until(() => stateOf("editor-B-only") != null);
    // B is UNCOPIED and fpA record SURVIVED the hydrate that couldn't match it.
    expect(stateOf("editor-B-only")).toBe("uncopied");
    let recs = await getCopiedRecords(FP_CONV);
    expect(recs.some((r) => r.fingerprint === fpA)).toBe(true);

    // A appears again with its exact content -> restored COPIED.
    const section = dom.window.document.querySelector('[data-testid="thread"]')!;
    const aTurn = dom.window.document.createElement("div");
    aTurn.innerHTML = writingTurn("editor-A-restored", TEXT_A);
    section.appendChild(aTurn.firstElementChild!);
    c.refresh(makeSettings());
    await until(() => stateOf("editor-A-restored") === "copied");
    recs = await getCopiedRecords(FP_CONV);
    expect(recs.some((r) => r.fingerprint === fpA)).toBe(true);
    c.teardown();
  });

  it("4. duplicate fingerprints, unequal evidence: fail closed, no guessing", async () => {
    installDom(
      "https://chatgpt.com/c/duplicate-fp",
      conversation(
        writingTurn("dup-a1", TEXT_SAME) + writingTurn("dup-a2", TEXT_SAME),
      ),
    );
    await resolveConvFp();
    // Only ONE stored record for the shared fingerprint.
    await saveCopiedRecord(FP_CONV, {
      turnIndex: 0, blockIndex: 0, fingerprint: await fingerprintOf(TEXT_SAME),
      copiedAt: 444,
    });

    const c = newController();
    c.apply(makeSettings());
    await until(() => stateOf("dup-a1") != null && stateOf("dup-a2") != null);

    // Neither receives false durable identity; record retained untouched.
    expect(stateOf("dup-a1")).toBe("uncopied");
    expect(stateOf("dup-a2")).toBe("uncopied");
    const recs = await getCopiedRecords(FP_CONV);
    expect(recs.length).toBe(1);
    expect(recs[0]?.fingerprint).toBe(await fingerprintOf(TEXT_SAME));
    c.teardown();
  });
  it("5. duplicate fingerprints with EQUAL evidence: whole group copied", async () => {
    installDom(
      "https://chatgpt.com/c/duplicate-fp-equal",
      conversation(
        writingTurn("eq-a1", TEXT_SAME) + writingTurn("eq-a2", TEXT_SAME),
      ),
    );
    await resolveConvFp();
    const fp = await fingerprintOf(TEXT_SAME);
    // Seed TWO durable records of the SAME fingerprint directly (the save
    // path dedupes identical content by design); this exercises the
    // hydration rule for equal-evidence duplicate groups only.
    const key = `${STORAGE_PREFIX}${FP_CONV}`;
    storage.map.set(key, [
      { turnIndex: 0, blockIndex: 0, fingerprint: fp, copiedAt: 555 },
      { turnIndex: 1, blockIndex: 0, fingerprint: fp, copiedAt: 556 },
    ]);

    const c = newController();
    c.apply(makeSettings());
    await until(() => stateOf("eq-a1") != null && stateOf("eq-a2") != null);
    expect(stateOf("eq-a1")).toBe("copied");
    expect(stateOf("eq-a2")).toBe("copied");
    c.teardown();
  });

  // ---- shared fixture constants/helpers ------------------------------------

  const TEXT_A = "Identity drift block ALPHA payload.";
  const TEXT_B = "Second distinct block BRAVO payload.";
  const TEXT_SAME = "Identical twin payload for ambiguity tests.";
  // Resolved per-DOM from the real URL (SHA-256 of the /c/<token>).
  let FP_CONV = "";

  async function resolveConvFp(): Promise<void> {
    FP_CONV = (await conversationFingerprintFromLocation()) ?? "";
    if (!FP_CONV) throw new Error("no conversation fingerprint for fixture URL");
  }

  async function countRecords(): Promise<number> {
    return (await getCopiedRecords(FP_CONV)).length;
  }

  async function fingerprintOf(text: string): Promise<string> {
    const { fingerprintText } = await import(
      "../../../src/features/writing-copy/content-fingerprint.js"
    );
    return fingerprintText(text);
  }

  function clickHostCopyButton(): void {
    const hostEl = dom.window.document.querySelector(
      `[${HOST_ATTR}]`,
    ) as (HTMLElement & { shadowRoot: ShadowRoot }) | null;
    const btn = hostEl?.shadowRoot.querySelector("button");
    if (!btn) throw new Error("copy host button not mounted");
    (btn as HTMLButtonElement).click();
  }
});
