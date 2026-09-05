import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../../src/settings/defaults.js";
import type { Settings } from "../../../src/shared/types.js";
import { WritingCopyController } from "../../../src/features/writing-copy/writing-copy-controller.js";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import { runXrayScan } from "../../../src/features/maintenance/xray-scan.js";
import { diagnose } from "../../../src/features/maintenance/xray-report.js";
import type { WritingCopyControllerReceipt } from "../../../src/features/writing-copy/writing-copy-controller.js";

/**
 * COPY HOST LIFECYCLE — REAL regression run (NX: host lifecycle fix).
 *
 * Reproduces the exact observed production sequence:
 *  T0  extension enabled BEFORE conversation DOM exists
 *      -> apply() enables the controller, mounts NO host (no container yet)
 *  T1  ChatGPT DOM appears (real shape: user turn + assistant turn with
 *      WritingBlock header anchor + one associated contenteditable editor)
 *  T2  refresh() must COMPLETE the activation:
 *      safe=1, tracked=1, visible=1, active selected, host mounted +
 *      connected + visible, mountBlocker=null, exactly ONE host element.
 *
 * Plus:
 *  - repeated refresh keeps exactly one host, same element, no duplicate
 *    geometry listener attachment, active target still valid;
 *  - X-Ray diagnosis reports WRITING_COPY_CONTROLLER:HOST_NOT_MOUNTED when
 *    the receipt says so (instead of a bare WRITING_SAFE_COUNT success);
 *  - smallest local vertical run: host button click -> one clipboard write
 *    -> durable copied record -> semantic COPIED -> one copied Highlight
 *    range (CopyMarker).
 */

const STORAGE_PREFIX = "cgl:writingCopy:history:";
const STATE_ATTR = "data-cgl-writing-copy-state";
const HOST_ATTR = 'data-cgl-writing-copy-host="true"';

/** Map-backed chrome.storage.local stub. */
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

/** Real-shape conversation: user turn + anchored WritingBlock editor. */
const CONVERSATION = (): string =>
  `<main role="main"><section data-testid="thread" aria-label="conversation">` +
  `<div data-message-author-role="user" data-testid="user-message"><p>Write me a draft.</p></div>` +
  `<div data-message-author-role="assistant" data-testid="assistant-message" id="turn-0">` +
  `<div class="writing-region">` +
  `<div class="writing-header"><button data-testid="writing-block-header-magic-edit-button">HEADER_LABEL_XYZ</button>` +
  `<button aria-label="Copy">TOOLBAR_LABEL_QRS</button></div>` +
  `<div contenteditable="true" class="editor" id="editor-0" style="position:absolute;top:220px;left:0;width:300px;height:120px;">` +
  `<p>Editor payload line alpha.</p>` +
  `<p>Editor payload line beta.</p>` +
  `</div>` +
  `</div>` +
  `</div>` +
  `</section></main>`;

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("copy host lifecycle recovery (apply-before-container -> refresh)", () => {
  let dom: JSDOM;
  let storage: StorageStub;
  let writeCalls: string[];
  let highlightRegistry: Map<string, Highlight>;
  let vvAdds: string[];
  let originalGlobals: Record<string, unknown>;

  beforeEach(() => {
    storage = new StorageStub();
    writeCalls = [];
    highlightRegistry = new Map();
    vvAdds = [];
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

  /** jsdom with zero-rect synthesis, clipboard stub, storage stub, fake Highlight. */
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
    } catch { /* the globalThis copy below is what the visual layer reads */ }
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
    g.visualViewport = {
      addEventListener: (t: string) => {
        vvAdds.push(t);
      },
    };
    g.chrome = { storage: { local: storage } } as unknown as typeof chrome;
  }

  const newController = (): WritingCopyController =>
    new WritingCopyController(dom.window.document.documentElement, createAdapter());

  /** Give the mounted host element a REAL rendered size (jsdom has layout=0). */
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

  const stateOf = (id: string): string | null =>
    dom.window.document.getElementById(id)?.getAttribute(STATE_ATTR) ?? null;

  it("T0 apply without container -> T1 DOM appears -> T2 refresh recovers host", async () => {
    // ---------- T0: enabled BEFORE any conversation DOM exists ----------
    installDom("https://chatgpt.com/c/lifecycle-fix", `<html><body><div>loading…</div></body></html>`);
    const c = newController();
    c.apply(makeSettings());

    expect(c.isHostMounted).toBe(false);
    expect(
      dom.window.document.querySelectorAll(`[${HOST_ATTR}]`).length,
    ).toBe(0);
    let receipt = c.buildReceipt();
    expect(receipt.controllerStarted).toBe(true);
    expect(receipt.enabled).toBe(true);
    expect(receipt.detectedSafeBlockCount).toBe(0);
    expect(receipt.mountBlocker).toBe("NO_SAFE_BLOCK");

    // ---------- T1: ChatGPT DOM appears (real shape) ----------
    const main = dom.window.document.createElement("main");
    main.setAttribute("role", "main");
    main.innerHTML = CONVERSATION().replace(/^<main[^>]*>|<\/main>$/g, "");
    dom.window.document.body.appendChild(main);

    // ---------- T2: refresh completes the activation ----------
    c.refresh(makeSettings());
    giveHostRealSize();
    receipt = c.buildReceipt();

    expect(receipt.detectedSafeBlockCount).toBe(1);
    expect(receipt.trackedBlockCount).toBe(1);
    expect(receipt.visibleBlockCount).toBe(1);
    expect(receipt.activeBlockSelected).toBe(true);
    expect(receipt.activeBlockIndex).toBe(0);
    expect(receipt.hostMounted).toBe(true);
    expect(receipt.hostConnected).toBe(true);
    expect(receipt.hostVisible).toBe(true);
    expect(receipt.mountBlocker).toBeNull();
    expect(
      dom.window.document.querySelectorAll(`[${HOST_ATTR}]`).length,
    ).toBe(1);
    // Active target is the anchored editor itself.
    expect(c.target?.id).toBe("editor-0");

    // Hydration marks the safe block with semantic state.
    await until(() => stateOf("editor-0") != null);
    expect(stateOf("editor-0")).toBe("uncopied");

    // ---------- local vertical run: one real copy through the host ----------
    const hostEl = dom.window.document.querySelector(`[${HOST_ATTR}]`)!;
    const btn = (hostEl as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot.querySelector("button");
    if (!btn) throw new Error("copy host button not mounted");
    (btn as HTMLButtonElement).click();

    await until(() => writeCalls.length === 1);
    expect(writeCalls[0]).toContain("Editor payload line alpha.");
    await until(() => stateOf("editor-0") === "copied");
    await until(() => c.visualLayer.rangeCount === 1);
    expect(storage.historyKeys()).toHaveLength(1);
    // CopyMarker Highlight registered under the extension-owned name.
    expect(highlightRegistry.has("cgl-copied")).toBe(true);
    // Host still exactly one; runtime untouched.
    expect(dom.window.document.querySelectorAll(`[${HOST_ATTR}]`).length).toBe(1);
    c.teardown();
  });

  it("repeated refresh: one host, same element, no duplicate geometry listeners", () => {
    installDom("https://chatgpt.com/c/lifecycle-repeat", `<html><body><div>boot</div></body></html>`);
    const c = newController();
    c.apply(makeSettings());
    expect(c.isHostMounted).toBe(false);

    const main = dom.window.document.createElement("main");
    main.setAttribute("role", "main");
    main.innerHTML = CONVERSATION().replace(/^<main[^>]*>|<\/main>$/g, "");
    dom.window.document.body.appendChild(main);

    c.refresh(makeSettings());
    const firstHost = dom.window.document.querySelector(`[${HOST_ATTR}]`);
    const vvAfterFirst = vvAdds.length; // scroll + resize on visualViewport
    expect(vvAfterFirst).toBe(2);

    c.refresh(makeSettings());
    c.refresh(makeSettings());
    c.refresh(makeSettings());

    // Exactly ONE host, the SAME logical element, no duplicate vv listeners.
    const hosts = dom.window.document.querySelectorAll(`[${HOST_ATTR}]`);
    expect(hosts.length).toBe(1);
    expect(hosts[0]).toBe(firstHost);
    expect(vvAdds.length).toBe(vvAfterFirst);
    // Active target remains valid across repeated refreshes.
    expect(c.target?.isConnected).toBe(true);
    expect(c.target?.id).toBe("editor-0");
    c.teardown();
  });

  it("X-Ray diagnosis surfaces the controller blocker instead of a bare safe-count", () => {
    installDom("https://chatgpt.com/c/lifecycle-diag", CONVERSATION());
    const adapter = createAdapter();

    const notMounted: WritingCopyControllerReceipt = {
      controllerStarted: true,
      enabled: true,
      detectedSafeBlockCount: 1,
      trackedBlockCount: 1,
      visibleBlockCount: 1,
      activeBlockSelected: true,
      activeBlockIndex: 0,
      hostMounted: false,
      hostConnected: false,
      hostVisible: false,
      positionMode: "smart",
      hostStatus: "idle",
      mountBlocker: "HOST_NOT_MOUNTED",
    };
    const scan = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true }, notMounted);
    expect(scan.writingPipeline.safeCount).toBe(1);
    const d = diagnose(scan);
    expect(d.summary).toBe("WRITING_COPY_HOST_NOT_MOUNTED");
    expect(d.firstBlocker).toBe("WRITING_COPY_CONTROLLER:HOST_NOT_MOUNTED");

    // Healthy receipt: no invented blocker; with NO copy attempt yet the
    // transaction stage reports READY (never a manufactured failure).
    const healthy: WritingCopyControllerReceipt = { ...notMounted, mountBlocker: null };
    const scan2 = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true }, healthy);
    expect(diagnose(scan2).summary).toBe("WRITING_COPY_READY");
    expect(diagnose(scan2).firstBlocker).toBe("");
  });
});
