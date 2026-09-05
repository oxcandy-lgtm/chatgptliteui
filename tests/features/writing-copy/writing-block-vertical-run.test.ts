import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../../src/settings/defaults.js";
import type { Settings } from "../../../src/shared/types.js";
import { WritingCopyController } from "../../../src/features/writing-copy/writing-copy-controller.js";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";

/**
 * Local vertical RUN on the REAL observed ChatGPT shape:
 *
 *   detect -> mark editor -> UNCOPIED -> copy via existing clipboard
 *   fallback -> durable save -> COPIED -> CopyMarker Highlight range
 *
 * Reuses the Phase 1-3 persistence spine unchanged; proves only that the
 * structural `writing-block-editor-anchored` editor flows through it.
 */

const STORAGE_PREFIX = "cgl:writingCopy:history:";
const BLOCK_MARKER = 'data-cgl-writing-block="true"';
const STATE_ATTR = "data-cgl-writing-copy-state";
const HOST_SELECTOR = '[data-cgl-writing-copy-host="true"]';

/** Map-backed chrome.storage.local stub (same model as the Phase 4 RUN). */
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
  s.writingCopy = {
    ...s.writingCopy,
    enabled: true,
    position: "smart",
    shortcutEnabled: true,
  };
  return s;
}

/**
 * Real observed structure: ordinary Assistant turns A/B, WritingBlock turn C
 * (header anchor + wrapper + ONE contenteditable editor + outside toolbar).
 */
const PAGE = (): string =>
  `<main role="main"><section data-testid="thread" aria-label="conversation">` +
  `<div data-message-author-role="assistant" data-testid="assistant-message">` +
  `<p>Ordinary prose turn A.</p></div>` +
  `<div data-message-author-role="assistant" data-testid="assistant-message">` +
  `<p>Ordinary prose turn B.</p></div>` +
  `<div data-message-author-role="assistant" data-testid="assistant-message" id="turn-c">` +
  `<p>Ordinary prose before the writing block.</p>` +
  `<div class="writing-region">` +
  `<div class="writing-header">` +
  `<button data-testid="writing-block-header-magic-edit-button">HEADER_TOOL</button>` +
  `<button aria-label="Copy">NATIVE_COPY</button>` +
  `</div>` +
  `<div contenteditable="true" id="editor-c" ` +
  `style="position:absolute;top:250px;left:0;width:300px;height:100px;">` +
  `<p>Writing payload alpha.</p><p>Writing payload beta.</p>` +
  `</div>` +
  `</div></div>` +
  `</section></main>`;

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("vertical RUN — anchored editor through the full writing-copy spine", () => {
  let dom: JSDOM;
  let storage: StorageStub;
  let writeCalls: string[];
  let originalGlobals: Record<string, unknown>;
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
          try { g[k] = originalGlobals[k]; } catch { /* ignore */ }
        }
      },
    );
    dom?.window.close();
  });

  function installDom(): void {
    dom = new JSDOM(`<!doctype html><html><body>${PAGE()}</body></html>`, {
      url: "https://chatgpt.com/c/conv-vertical",
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
    try { win.CSS = cssRegistry; } catch { /* ignore */ }
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

  it("detect -> mark -> UNCOPIED -> one copy -> durable COPIED -> marker range", async () => {
    installDom();
    const doc = dom.window.document;
    const controller = new WritingCopyController(
      doc.documentElement,
      createAdapter(),
    );

    // --- DETECT + MARK ---
    controller.apply(makeSettings());
    expect(controller.isHostMounted).toBe(true);

    // Exactly ONE canonical block: the EDITOR — never the wrapper/turn.
    await until(() => doc.querySelectorAll(`[${BLOCK_MARKER}]`).length === 1);
    const marked = doc.querySelectorAll(`[${BLOCK_MARKER}]`);
    expect(marked).toHaveLength(1);
    const editor = doc.getElementById("editor-c")!;
    expect(marked[0]).toBe(editor);
    // Ordinary prose is untouched.
    expect(doc.querySelector('[data-message-author-role="assistant"] > p')!
      .hasAttribute("data-cgl-writing-block")).toBe(false);

    // --- UNCOPIED after hydration ---
    await until(() => editor.getAttribute(STATE_ATTR) === "uncopied");

    // --- COPY once via the existing host button ---
    const host = doc.querySelector(HOST_SELECTOR);
    const btn = host?.shadowRoot?.querySelector("button");
    expect(btn).toBeTruthy();
    (btn as HTMLButtonElement).click();

    // Clipboard fallback used EXACTLY once, with ONLY editor text.
    await until(() => editor.getAttribute(STATE_ATTR) === "copied");
    expect(writeCalls).toHaveLength(1);
    const copiedText = writeCalls[0] ?? "";
    expect(copiedText.includes("payload")).toBe(true);
    expect(copiedText.includes("HEADER_TOOL")).toBe(false);
    expect(copiedText.includes("NATIVE_COPY")).toBe(false);

    // Durable record saved exactly once.
    expect(storage.historyKeys()).toHaveLength(1);
    const recs = storage.map.get(storage.historyKeys()[0]!) as Array<unknown>;
    expect(recs).toHaveLength(1);

    // --- CopyMarker range targets the editor content ---
    await until(() => controller.visualLayer.rangeCount === 1);
    expect(highlightRegistry.has("cgl-copied")).toBe(true);

    // Runtime receipt mirrors the X-Ray runtime section.
    expect(doc.querySelectorAll(HOST_SELECTOR)).toHaveLength(1);

    controller.teardown();
    expect(highlightRegistry.has("cgl-copied")).toBe(false);
    expect(doc.querySelectorAll(`[${BLOCK_MARKER}]`)).toHaveLength(0);
    expect(doc.querySelectorAll(`[${STATE_ATTR}]`)).toHaveLength(0);
    expect(doc.querySelectorAll(HOST_SELECTOR)).toHaveLength(0);
  });

  it("fresh runtime hydrates the persisted COPIED state onto the same editor", async () => {
    installDom();
    const doc = dom.window.document;

    // First runtime performs the real copy (durable save happens here).
    const c1 = new WritingCopyController(doc.documentElement, createAdapter());
    c1.apply(makeSettings());
    await until(() => doc.getElementById("editor-c")?.getAttribute(STATE_ATTR) === "uncopied");
    const btn1 = doc.querySelector(HOST_SELECTOR)?.shadowRoot?.querySelector("button");
    (btn1 as HTMLButtonElement).click();
    await until(() => doc.getElementById("editor-c")?.getAttribute(STATE_ATTR) === "copied");
    const writesAfterCopy = writeCalls.length;
    expect(writesAfterCopy).toBe(1);
    c1.teardown();

    // Fresh runtime: hydration restores COPIED + marker range, no re-copy.
    const c2 = new WritingCopyController(doc.documentElement, createAdapter());
    c2.apply(makeSettings());
    await until(() => doc.getElementById("editor-c")?.getAttribute(STATE_ATTR) === "copied");
    await until(() => c2.visualLayer.rangeCount === 1);
    expect(highlightRegistry.has("cgl-copied")).toBe(true);
    // Hydration restored the marker WITHOUT a new clipboard write.
    expect(writeCalls).toHaveLength(1);
    c2.teardown();
  });
});
