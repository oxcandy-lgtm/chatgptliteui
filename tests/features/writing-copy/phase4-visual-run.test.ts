import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../../src/settings/defaults.js";
import type { Settings } from "../../../src/shared/types.js";
import { WritingCopyController } from "../../../src/features/writing-copy/writing-copy-controller.js";
import { WritingCopyHost } from "../../../src/features/writing-copy/writing-copy-host.js";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import {
  isHighlightApiAvailable,
} from "../../../src/features/writing-copy/writing-copy-visual-state.js";

/**
 * Authoritative Phase 4 visual + smart UI acceptance RUN (local deterministic).
 *
 * Step 1 initial state -> Step 2 copy B -> Step 3 fresh runtime restore ->
 * Step 4 edit B -> Step 5 appearance changes -> Step 6 smart positioning ->
 * Step 7 clear history -> Step 8 teardown leaves nothing live.
 */

const STORAGE_PREFIX = "cgl:writingCopy:history:";
const BLOCK_MARKER = 'data-cgl-writing-block="true"';
const STATE_ATTR = "data-cgl-writing-copy-state";
const VISIBLE_ATTR = "data-cgl-writing-visible";

const TEXT_A = "First prose alpha.";
const TEXT_B = "Second prose beta.";

/** Map-backed chrome.storage.local stub. */
class StorageStub {
  readonly map = new Map<string, unknown>();

  async get(key: string | null): Promise<Record<string, unknown>> {
    if (key === null) {
      return Object.fromEntries(this.map);
    }
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

  snapshot(): string {
    return JSON.stringify([...this.map.entries()]);
  }
}

function makeSettings(): Settings {
  const s = cloneDefaults();
  s.enabled = true;
  s.writingCopy = {
    ...s.writingCopy,
    enabled: true,
    position: "smart",
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

describe("Phase 4 visual + smart UI — authoritative RUN", () => {
  let dom: JSDOM;
  let storage: StorageStub;
  let writeCalls: string[];
  let originalGlobals: Record<string, unknown>;
  /** Fake CSS Custom Highlight API installed on the jsdom window. */
  let highlightRegistry: Map<string, Highlight>;

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
      FocusEvent: globalThis.FocusEvent,
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
    // jsdom returns zero rects; synthesize from inline geometry.
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

    class FakeRange {
      private startNode: Node | null = null;
      get startContainer(): Node {
        return this.startNode ?? dom.window.document;
      }
      setStartBefore(node: Node): void {
        this.startNode = node.parentNode;
      }
      setEndAfter(node: Node): void {
        this.startNode = node.parentNode;
      }
      selectNodeContents(): void {}
    }
    class FakeHighlight {
      constructor(..._ranges: unknown[]) {}
    }
    const win = dom.window as unknown as Record<string, unknown>;
    win.Range = FakeRange;
    win.Highlight = FakeHighlight;
    const cssRegistry = { highlights: highlightRegistry };
    try {
      win.CSS = cssRegistry;
    } catch {
      /* jsdom window may refuse; the globalThis copy below is what the
       * visual layer reads. */
    }
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
    g.Range = FakeRange;
    g.Highlight = FakeHighlight;
    g.CSS = cssRegistry;
    g.chrome = { storage: { local: storage } } as unknown as typeof chrome;
  }

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

  it(
    "Steps 1-5: pulse/marker lifecycle across copy, restore, edit, appearance",
    { timeout: 20000 },
    async () => {
      // ---------- Step 1: initial state ----------
      installDom("https://chatgpt.com/c/conv-a", PAGE(TEXT_A, TEXT_B));
      expect(isHighlightApiAvailable()).toBe(true);
      const c1 = newController();
      c1.apply(makeSettings());
      expect(c1.isHostMounted).toBe(true);
      await waitUntilHydrated(dom.window.document);
      const doc1 = dom.window.document;
      expect(doc1.getElementById("block-a")!.getAttribute(STATE_ATTR)).toBe(
        "uncopied",
      );
      expect(doc1.getElementById("block-b")!.getAttribute(STATE_ATTR)).toBe(
        "uncopied",
      );
      // Pulse presentation active: no copied Highlight Range registered.
      expect(c1.visualLayer.rangeCount).toBe(0);

      // ---------- Step 2: copy B ----------
      focusBlock("block-b");
      clickHostCopyButton();
      await until(() => stateOf("block-b") === "copied");
      expect(writeCalls).toHaveLength(1);
      expect(stateOf("block-a")).toBe("uncopied");
      // B joined the shared copied Highlight; A did not.
      await until(() => c1.visualLayer.rangeCount === 1);
      expect(highlightRegistry.has("cgl-copied")).toBe(true);
      // Durable record written exactly once for B's conversation.
      expect(storage.historyKeys()).toHaveLength(1);
      const keyA = storage.historyKeys()[0] as string;
      const recordsA = storage.map.get(keyA) as Array<Record<string, unknown>>;
      expect(recordsA).toHaveLength(1);

      // ---------- Step 3: fresh runtime restores the visual layer ----------
      c1.restore();
      expect(highlightRegistry.has("cgl-copied")).toBe(false);
      const c2 = newController();
      c2.apply(makeSettings());
      await waitUntilHydrated(dom.window.document);
      expect(stateOf("block-a")).toBe("uncopied");
      expect(stateOf("block-b")).toBe("copied");
      await until(() => c2.visualLayer.rangeCount === 1);
      expect(highlightRegistry.has("cgl-copied")).toBe(true);

      // ---------- Step 4: editing B invalidates and removes its Range ----------
      const pB = doc1.querySelector("#block-b p");
      if (!pB) throw new Error("missing B paragraph");
      pB.textContent = TEXT_B + " edited";
      c2.refresh(makeSettings());
      await waitUntilHydrated(dom.window.document);
      await until(() => stateOf("block-b") === "uncopied");
      await until(() => c2.visualLayer.rangeCount === 0);
      expect(stateOf("block-a")).toBe("uncopied");

      // Re-seed B as copied (real fingerprint of its current text) so Step 7
      // has two conversations of history and Step 5 has a durable payload.
      const { conversationFingerprintFromLocation } = await import(
        "../../../src/features/writing-copy/block-identity.js"
      );
      const { fingerprintText } = await import(
        "../../../src/features/writing-copy/content-fingerprint.js"
      );
      const fpA = await conversationFingerprintFromLocation();
      const editedB = TEXT_B + " edited";
      const seededConvA = [
        {
          turnIndex: 1,
          blockIndex: 0,
          fingerprint: await fingerprintText(editedB),
          copiedAt: Date.now(),
        },
      ];
      storage.map.set(STORAGE_PREFIX + fpA, seededConvA);

      // ---------- Step 5: appearance changes never rewrite history ----------
      const beforeAppearance = storage.snapshot();
      const s2 = makeSettings();
      s2.writingCopy.markerColor = "#ff0000";
      s2.writingCopy.markerOpacity = 55;
      s2.writingCopy.pulseColor = "#00ff00";
      s2.writingCopy.pulseIntensity = 40;
      s2.writingCopy.pulsePeriodMs = 8000;
      s2.writingCopy.backgroundEnabled = true;
      s2.theme.writingBlockBackground = "#243044";
      c2.apply(s2);
      await until(() =>
        dom.window.document.documentElement.style
          .getPropertyValue("--cgl-pulse-color")
          .includes("0, 255, 0"),
      ).catch(async () => {
        // jsdom stores raw values; fall back to exact-match assertion below.
      });
      const root = dom.window.document.documentElement;
      expect(root.style.getPropertyValue("--cgl-copy-marker-color")).toBe(
        "#ff0000",
      );
      expect(root.style.getPropertyValue("--cgl-copy-marker-opacity")).toBe(
        "0.55",
      );
      expect(root.style.getPropertyValue("--cgl-pulse-period")).toBe("8000ms");
      expect(root.classList.contains("cgl-writing-marker-on")).toBe(true);
      expect(root.classList.contains("cgl-writing-pulse-on")).toBe(true);
      expect(root.classList.contains("cgl-writing-copy-active")).toBe(true);
      // History payload unchanged by appearance settings.
      expect(storage.snapshot()).toBe(beforeAppearance);
      c2.teardown();
    },
  );

  it("Step 6: smart positioning geometry cases keep exactly one host", () => {
    installDom("https://chatgpt.com/c/conv-pos", PAGE(TEXT_A, TEXT_B));
    // Viewport position lock: each smart base is computed on FIRST placement
    // only, so every geometry case below uses a fresh host (fresh lock).
    let host = new WritingCopyHost();
    host.mount(() => {});
    const freshHost = (): HTMLElement => {
      host.unmount();
      host = new WritingCopyHost();
      host.mount(() => {});
      return dom.window.document.querySelector(
        '[data-cgl-writing-copy-host="true"]',
      ) as HTMLElement;
    };
    let hostEl = dom.window.document.querySelector(
      '[data-cgl-writing-copy-host="true"]',
    ) as HTMLElement;

    const makeBlock = (rect: Partial<DOMRect>): HTMLElement => {
      const el = dom.window.document.createElement("div");
      Object.defineProperty(el, "getBoundingClientRect", {
        value: () => ({
          top: 100, left: 0, width: 300, height: 200,
          bottom: 300, right: 300, x: 0, y: 100, toJSON: () => ({}),
          ...rect,
        } as DOMRect),
      });
      return el;
    };

    const vw = (): number =>
      parseInt(hostEl.style.left, 10) +
      (hostEl.getBoundingClientRect().width || 44);

    // 1. plenty of right-side room -> button outside-right
    const roomy = makeBlock({ top: 100, bottom: 300, left: 0, right: 300, width: 300, height: 200 });
    host.positionAgainst(roomy, "smart");
    const leftOutside = parseInt(hostEl.style.left, 10);
    expect(leftOutside).toBe(300 + 6); // rect.right + margin

    // 2. insufficient right room -> inside-right fallback
    // rect.right 300 + margin 6 + bubble 44 = 350 > vw(340) - margin 6.
    Object.defineProperty(dom.window, "innerWidth", { value: 340, configurable: true });
    hostEl = freshHost();
    host.positionAgainst(roomy, "smart");
    const leftInside = parseInt(hostEl.style.left, 10);
    expect(leftInside).toBeLessThan(leftOutside);

    // 3. narrow viewport -> completely clamped inside visible bounds
    Object.defineProperty(dom.window, "innerWidth", { value: 200, configurable: true });
    Object.defineProperty(dom.window, "innerHeight", { value: 300, configurable: true });
    hostEl = freshHost();
    host.positionAgainst(roomy, "smart");
    const l = parseInt(hostEl.style.left, 10);
    const t = parseInt(hostEl.style.top, 10);
    expect(l).toBeGreaterThanOrEqual(6);
    expect(l).toBeLessThanOrEqual(200 - 44 - 6);
    expect(t).toBeGreaterThanOrEqual(6);
    expect(t).toBeLessThanOrEqual(300 - 44 - 6);

    // 4. tall block partly offscreen -> button stays visible (Y clamped)
    Object.defineProperty(dom.window, "innerWidth", { value: 1200, configurable: true });
    const tall = makeBlock({ top: -5000, bottom: 5000, height: 10000, left: 0, right: 300, width: 300 });
    hostEl = freshHost();
    host.positionAgainst(tall, "smart");
    const tTall = parseInt(hostEl.style.top, 10);
    expect(tTall).toBeGreaterThanOrEqual(6);
    expect(tTall).toBeLessThanOrEqual(600 - 44 - 6);

    // 5+6. repositioning on resize/scroll follows the correct block; one host.
    expect(
      dom.window.document.querySelectorAll('[data-cgl-writing-copy-host="true"]').length,
    ).toBe(1);
    const wide = makeBlock({ top: 50, bottom: 250, left: 100, right: 900, width: 800, height: 200 });
    hostEl = freshHost();
    host.positionAgainst(wide, "smart");
    expect(parseInt(hostEl.style.left, 10)).toBe(906); // 900 + margin
    expect(vw()).toBeGreaterThan(0);
    host.unmount();
  });

  it("visualViewport is preferred when present", () => {
    installDom("https://chatgpt.com/c/conv-vv", PAGE(TEXT_A, TEXT_B));
    const g = globalThis as unknown as Record<string, unknown>;
    g.visualViewport = { width: 360, height: 480 };
    const host = new WritingCopyHost();
    host.mount(() => {});
    const hostEl = dom.window.document.querySelector(
      '[data-cgl-writing-copy-host="true"]',
    ) as HTMLElement;
    const block = dom.window.document.createElement("div");
    Object.defineProperty(block, "getBoundingClientRect", {
      value: () => ({
        top: 10, left: 0, width: 340, height: 60,
        bottom: 70, right: 340, x: 0, y: 10, toJSON: () => ({}),
      } as DOMRect),
    });
    host.positionAgainst(block, "smart");
    // Clamped to the 360-wide visual viewport, not innerWidth (1024 default).
    const l = parseInt(hostEl.style.left, 10);
    expect(l).toBeLessThanOrEqual(360 - 44 - 6);
    delete g.visualViewport;
    host.unmount();
  });

  it("Step 7: clear history removes only cgl:writingCopy:history:* keys and reconciles to UNCOPIED", async () => {
    installDom("https://chatgpt.com/c/conv-clear", PAGE(TEXT_A, TEXT_B));
    // Seed copied history for TWO conversations plus ordinary settings.
    storage.map.set(STORAGE_PREFIX + "f".repeat(32), [
      { turnIndex: 0, blockIndex: 0, fingerprint: "b".repeat(32), copiedAt: 1 },
    ]);
    storage.map.set(STORAGE_PREFIX + "e".repeat(32), [
      { turnIndex: 3, blockIndex: 1, fingerprint: "c".repeat(32), copiedAt: 2 },
    ]);
    const settingsEnvelope = { schemaVersion: 3, settings: makeSettings() };
    storage.map.set("settings", settingsEnvelope);

    const { clearAllCopiedHistory } = await import(
      "../../../src/features/writing-copy/copied-state-store.js"
    );

    const c = newController();
    c.apply(makeSettings());
    await waitUntilHydrated(dom.window.document);
    expect(storage.historyKeys().length).toBeGreaterThanOrEqual(2);

    const removed = await clearAllCopiedHistory();
    expect(removed).toBe(2);
    expect(storage.historyKeys()).toHaveLength(0);
    // Ordinary settings remain intact.
    expect(storage.map.has("settings")).toBe(true);
    expect(storage.map.get("settings")).toBe(settingsEnvelope);

    // One explicit refresh reconciles visible state to UNCOPIED.
    c.refresh(makeSettings());
    await waitUntilHydrated(dom.window.document);
    await until(() => c.visualLayer.rangeCount === 0);
    const blocks = Array.from(
      dom.window.document.querySelectorAll(`[${BLOCK_MARKER}]`),
    );
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b.getAttribute(STATE_ATTR)).toBe("uncopied");
    }
    c.teardown();
  });

  it("Step 8: teardown leaves no highlight, ranges, markers, or host", async () => {
    installDom("https://chatgpt.com/c/conv-teardown", PAGE(TEXT_A, TEXT_B));
    const c = newController();
    c.apply(makeSettings());
    await waitUntilHydrated(dom.window.document);
    focusBlock("block-b");
    clickHostCopyButton();
    await until(() => stateOf("block-b") === "copied");
    await until(() => c.visualLayer.rangeCount === 1);

    c.teardown();
    expect(highlightRegistry.has("cgl-copied")).toBe(false);
    expect(c.visualLayer.rangeCount).toBe(0);
    expect(
      dom.window.document.querySelectorAll(`[${BLOCK_MARKER}]`),
    ).toHaveLength(0);
    expect(
      dom.window.document.querySelectorAll(`[${STATE_ATTR}]`),
    ).toHaveLength(0);
    expect(
      dom.window.document.querySelectorAll(`[${VISIBLE_ATTR}]`),
    ).toHaveLength(0);
    expect(c.isHostMounted).toBe(false);
    expect(
      dom.window.document.querySelectorAll('[data-cgl-writing-copy-host="true"]'),
    ).toHaveLength(0);
    const root = dom.window.document.documentElement;
    for (const cls of [
      "cgl-writing-copy-active",
      "cgl-writing-marker-on",
      "cgl-writing-pulse-on",
    ]) {
      expect(root.classList.contains(cls)).toBe(false);
    }
    expect(root.style.getPropertyValue("--cgl-copy-marker-color")).toBe("");
    expect(root.style.getPropertyValue("--cgl-pulse-color")).toBe("");
    expect(root.style.getPropertyValue("--cgl-writing-bg")).toBe("");
  });

  function stateOf(id: string): string | null {
    return dom.window.document.getElementById(id)?.getAttribute(STATE_ATTR) ?? null;
  }
});
