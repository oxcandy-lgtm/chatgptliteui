import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../../src/settings/defaults.js";
import type { Settings } from "../../../src/shared/types.js";
import { WritingCopyController } from "../../../src/features/writing-copy/writing-copy-controller.js";
import type { WritingCopyControllerReceipt } from "../../../src/features/writing-copy/writing-copy-controller.js";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import { runXrayScan } from "../../../src/features/maintenance/xray-scan.js";
import { diagnose } from "../../../src/features/maintenance/xray-report.js";

/**
 * COPY TRANSACTION RECEIPT — focused tests (NX: real copy isolation).
 *
 *  - SUCCESS: one host click -> clipboard write resolved -> durable save ->
 *    semantic COPIED -> Highlight range. Receipt must prove every stage.
 *  - CLIPBOARD REJECTED: writeText rejects NotAllowedError -> outcome
 *    unavailable, durable NOT attempted, semantic NOT applied,
 *    failureCode CLIPBOARD_WRITE_REJECTED, only error.name captured.
 *  - DURABLE FAILURE: clipboard resolves but storage set() fails ->
 *    durableSaveSucceeded false, semantic false, failureCode
 *    DURABLE_SAVE_FAILED (no fake copied state).
 *  - STATE REVERSION: successful transaction then live DOM back to UNCOPIED
 *    -> diagnosis COPY_STATE_REVERTED_AFTER_SUCCESS (observation only).
 *  - PRIVACY: secrets in copied text / route token / error message never
 *    reach the serialized report; error.name IS allowed.
 */

const STORAGE_PREFIX = "cgl:writingCopy:history:";
const STATE_ATTR = "data-cgl-writing-copy-state";
const HOST_ATTR = 'data-cgl-writing-copy-host="true"';

const SECRET_TEXT = "TXFIXTURE-secret-payload-4173";
const SECRET_ROUTE = "txfixture-route-token-9182";

class StorageStub {
  readonly map = new Map<string, unknown>();
  failNextSet = false;
  async get(key: string | null): Promise<Record<string, unknown>> {
    if (key === null) return Object.fromEntries(this.map);
    if (this.map.has(key)) return { [key]: this.map.get(key) };
    return {};
  }
  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failNextSet) throw new Error("storage unavailable");
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

/** Real-shape conversation with an anchored WritingBlock editor. */
const CONVERSATION = (): string =>
  `<main role="main"><section data-testid="thread" aria-label="conversation">` +
  `<div data-message-author-role="user" data-testid="user-message"><p>draft request</p></div>` +
  `<div data-message-author-role="assistant" data-testid="assistant-message" id="turn-0">` +
  `<div class="writing-region">` +
  `<div class="writing-header"><button data-testid="writing-block-header-magic-edit-button">HEADER</button></div>` +
  `<div contenteditable="true" class="editor" id="editor-0" style="position:absolute;top:220px;left:0;width:300px;height:120px;">` +
  `<p>${SECRET_TEXT} alpha.</p><p>beta line.</p>` +
  `</div></div></div></section></main>`;

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("copy transaction receipt", () => {
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

  function installDom(url: string, html: string, opts?: { rejectWrite?: () => void }): void {
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
        opts?.rejectWrite?.();
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

  const clickCopy = (): void => {
    const hostEl = dom.window.document.querySelector(
      `[${HOST_ATTR}]`,
    ) as (HTMLElement & { shadowRoot: ShadowRoot }) | null;
    const btn = hostEl?.shadowRoot.querySelector("button");
    if (!btn) throw new Error("copy host button not mounted");
    (btn as HTMLButtonElement).click();
  };

  it("SUCCESS: full receipt proves every stage green", async () => {
    installDom(`https://chatgpt.com/c/${SECRET_ROUTE}`, CONVERSATION());
    const c = newController();
    c.apply(makeSettings());
    giveHostRealSize();

    // No attempt yet.
    expect(c.lastTransaction.attemptCount).toBe(0);

    clickCopy();
    await until(() => c.lastTransaction.completedAt != null);

    const tx = c.lastTransaction;
    expect(tx.attemptCount).toBe(1);
    expect(tx.trigger).toBe("host-button");
    expect(tx.targetPresent).toBe(true);
    expect(tx.targetConnected).toBe(true);
    expect(tx.clipboardApiAvailable).toBe(true);
    expect(tx.clipboardWriteAttempted).toBe(true);
    expect(tx.clipboardWriteResolved).toBe(true);
    expect(tx.copyOutcome).toBe("copied");
    expect(tx.conversationIdentityAvailable).toBe(true);
    expect(tx.blockIdentityValid).toBe(true);
    expect(tx.turnIndex).toBe(0);
    expect(tx.blockIndex).toBe(0);
    expect(tx.fingerprintSucceeded).toBe(true);
    expect(tx.durableSaveAttempted).toBe(true);
    expect(tx.durableSaveSucceeded).toBe(true);
    expect(tx.semanticCopiedApplied).toBe(true);
    expect(tx.visualReconcileRan).toBe(true);
    expect(tx.copiedRangeCountAfter).toBe(1);
    expect(tx.failureCode).toBeNull();
    // Host status enum reflects the completed copy.
    expect(c.buildReceipt().hostStatus).toBe("copied");

    // Live state agrees: exactly one copied block + one range + one record.
    await until(() => c.visualLayer.rangeCount === 1);
    expect(storage.historyKeys()).toHaveLength(1);
  });

  it("CLIPBOARD REJECTED: NotAllowedError classified, no durable attempt, no fake state", async () => {
    installDom(`https://chatgpt.com/c/${SECRET_ROUTE}`, CONVERSATION(), {
      rejectWrite: () => {
        throw new DOMException("denied for fixture", "NotAllowedError");
      },
    });
    const c = newController();
    c.apply(makeSettings());
    giveHostRealSize();

    clickCopy();
    await until(() => c.lastTransaction.completedAt != null);

    const tx = c.lastTransaction;
    expect(tx.attemptCount).toBe(1);
    expect(tx.clipboardApiAvailable).toBe(true);
    expect(tx.clipboardWriteAttempted).toBe(true);
    expect(tx.clipboardWriteResolved).toBe(false);
    expect(tx.clipboardErrorName).toBe("NotAllowedError");
    expect(tx.copyOutcome).toBe("unavailable");
    expect(tx.durableSaveAttempted).toBe(false);
    expect(tx.semanticCopiedApplied).toBe(false);
    expect(tx.failureCode).toBe("CLIPBOARD_WRITE_REJECTED");
    expect(stateOf("editor-0")).not.toBe("copied");
    expect(c.buildReceipt().hostStatus).toBe("unavailable");
  });

  it("DURABLE SAVE FAILED: clipboard ok but storage fails -> uncopied, exact code", async () => {
    installDom(`https://chatgpt.com/c/${SECRET_ROUTE}`, CONVERSATION());
    storage.failNextSet = true;
    const c = newController();
    c.apply(makeSettings());
    giveHostRealSize();

    clickCopy();
    await until(() => c.lastTransaction.completedAt != null);

    const tx = c.lastTransaction;
    expect(tx.clipboardWriteResolved).toBe(true);
    expect(tx.copyOutcome).toBe("copied");
    expect(tx.durableSaveAttempted).toBe(true);
    expect(tx.durableSaveSucceeded).toBe(false);
    expect(tx.semanticCopiedApplied).toBe(false);
    expect(stateOf("editor-0")).toBe("uncopied");
    expect(tx.failureCode).toBe("DURABLE_SAVE_FAILED");
  });

  it("STATE REVERSION: applied-then-lost COPIED observed by diagnosis (no polling)", async () => {
    installDom(`https://chatgpt.com/c/${SECRET_ROUTE}`, CONVERSATION());
    const c = newController();
    c.apply(makeSettings());
    giveHostRealSize();
    clickCopy();
    await until(() => c.lastTransaction.completedAt != null);
    await until(() => stateOf("editor-0") === "copied");
    expect(c.lastTransaction.semanticCopiedApplied).toBe(true);

    const adapter = createAdapter();
    const healthy: WritingCopyControllerReceipt = {
      ...c.buildReceipt(),
      mountBlocker: null,
    };

    // Complete transaction -> REAL_COPYMARKER_GREEN.
    const scanGreen = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true }, healthy, c.lastTransaction);
    expect(diagnose(scanGreen).summary).toBe("REAL_COPYMARKER_GREEN");

    // Simulate loss: copied marker gone, uncopied present (e.g. hydration
    // invalidated the fingerprint), receipt still claims applied.
    dom.window.document.getElementById("editor-0")!.setAttribute(STATE_ATTR, "uncopied");
    const scanReverted = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true }, healthy, c.lastTransaction);
    const d = diagnose(scanReverted);
    expect(d.summary).toBe("COPY_STATE_REVERTED_AFTER_SUCCESS");
    expect(d.firstBlocker).toBe("REAL_COPY_TRANSACTION:COPY_STATE_REVERTED_AFTER_SUCCESS");
    c.teardown();
  });

  it("PRIVACY: secrets never appear in the serialized X-Ray report", async () => {
    installDom(`https://chatgpt.com/c/${SECRET_ROUTE}`, CONVERSATION(), {
      rejectWrite: () => {
        throw new DOMException(`denied: ${SECRET_TEXT} ${SECRET_ROUTE}`, "NotAllowedError");
      },
    });
    const c = newController();
    c.apply(makeSettings());
    giveHostRealSize();
    clickCopy();
    await until(() => c.lastTransaction.completedAt != null);

    const adapter = createAdapter();
    const healthy: WritingCopyControllerReceipt = { ...c.buildReceipt(), mountBlocker: null };
    const report = buildXrayReportShim(
      runXrayScan(adapter, { enabled: true, writingCopyEnabled: true }, healthy, c.lastTransaction),
    );
    expect(report.includes(SECRET_TEXT)).toBe(false);
    expect(report.includes(SECRET_ROUTE)).toBe(false);
    // error.name IS allowed and present.
    expect(report.includes("NotAllowedError")).toBe(true);
    c.teardown();
  });

  function stateOf(id: string): string | null {
    return dom.window.document.getElementById(id)?.getAttribute(STATE_ATTR) ?? null;
  }

  /** Minimal serializer mirroring buildXrayReport's field set. */
  function buildXrayReportShim(scan: ReturnType<typeof runXrayScan>): string {
    return JSON.stringify({
      runtimeState: scan.runtime,
      runtimeHealth: scan.runtimeHealth,
      writingCopyController: scan.writingCopyController,
      copyTransaction: scan.copyTransaction,
      diagnosis: diagnose(scan),
    });
  }
});
