import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../src/settings/defaults.js";
import type { Settings } from "../../src/shared/types.js";
import { fingerprintText } from "../../src/features/writing-copy/content-fingerprint.js";

/**
 * PART A — conversation-revisit hydration regression (RED after d403).
 *
 * Real failure: copy a WritingBlock in C1 -> travel to C2 -> return to C1.
 * The durable record survived, tracker re-detected 2 blocks, but live
 * semantic/Highlight state stayed 0/0: hydration ran while the route DOM was
 * still a skeleton and was never re-driven, because the structural observer
 * had been pinned (by the async re-apply) to the OUTGOING container, which
 * React then removed. An observer on a detached root sees nothing.
 *
 * Required route model under test:
 *  1. on route change the observer re-roots synchronously to document.body;
 *  2. the existing narrowing adopts the newly rendered container;
 *  3. the resulting refresh hydrates durable C1 state even though NO block
 *     is visible (jsdom rects are zero by construction — visibility must not
 *     gate hydration);
 *  4. no C1 marker leaks into C2 and no C2 state leaks back into C1.
 */

const STATE_ATTR = "data-cgl-writing-copy-state";
const HISTORY_PREFIX = "cgl:writingCopy:history:";
const TEXT_A = "Revisit prose alpha.";
const TEXT_B = "Revisit prose beta.";
const TEXT_C = "Other conversation gamma.";

class FakeMutationObserver {
  static last: FakeMutationObserver | null = null;
  cb: (mutations: MutationRecord[], obs: FakeMutationObserver) => void;
  target: Node | null = null;
  disconnected = false;
  constructor(cb: (mutations: MutationRecord[], obs: FakeMutationObserver) => void) {
    this.cb = cb;
    FakeMutationObserver.last = this;
  }
  observe(target: Node): void {
    this.target = target;
    this.disconnected = false;
  }
  disconnect(): void {
    this.disconnected = true;
    this.target = null;
  }
  trigger(nodes: Node[]): void {
    const mutations = [
      { addedNodes: nodes as unknown as NodeListOf<Node> } as MutationRecord,
    ];
    this.cb(mutations, this);
  }
}

class FakeRange {
  private startNode: Node | null = null;
  get startContainer(): Node {
    return this.startNode ?? (globalThis as unknown as { document: Document }).document;
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

const C1_HTML = (a: string, b: string): string =>
  `<main role="main"><section data-testid="thread" aria-label="conversation">` +
  `<div data-message-author-role="assistant" data-testid="assistant-message">` +
  `<div data-testid="text-block" id="block-a"><p>${a}</p></div></div>` +
  `<div data-message-author-role="assistant" data-testid="assistant-message">` +
  `<div data-testid="text-block" id="block-b"><p>${b}</p></div></div>` +
  `</section></main>`;

const C2_HTML = (c: string): string =>
  `<main role="main"><section data-testid="thread" aria-label="conversation">` +
  `<div data-message-author-role="assistant" data-testid="assistant-message">` +
  `<div data-testid="text-block" id="block-c"><p>${c}</p></div></div>` +
  `</section></main>`;

const SKELETON_HTML =
  `<main role="main"><section data-testid="thread" aria-label="conversation"></section></main>`;

function makeSettings(): Settings {
  const s = cloneDefaults();
  s.enabled = true;
  s.writingCopy = {
    ...s.writingCopy,
    enabled: true,
    position: "middle-right",
    shortcutEnabled: true,
  };
  return s;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
/** Wait past the 120ms debounce window plus async hydration. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 250));
}

describe("route revisit hydration (C1 -> C2 -> C1)", () => {
  let dom: JSDOM;
  let mod: typeof import("../../src/content/index.js");
  let settings: Settings;
  let store: Map<string, unknown>;
  let highlightRegistry: Map<string, unknown>;
  let originalGlobals: Record<string, unknown>;

  const stateOf = (id: string): string | null =>
    dom.window.document.getElementById(id)?.getAttribute(STATE_ATTR) ?? null;

  const historyKeys = (): string[] =>
    [...store.keys()].filter((k) => k.startsWith(HISTORY_PREFIX));

  function installDom(url: string, html: string): void {
    dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
      url,
      pretendToBeVisual: true,
    });
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.location = dom.window.location;
    g.MutationObserver = FakeMutationObserver;
    g.Node = dom.window.Node;
    g.HTMLElement = dom.window.HTMLElement;
    g.Element = dom.window.Element;
    g.Range = FakeRange;
    g.Highlight = FakeHighlight;
    g.CSS = { highlights: highlightRegistry };
    const win = dom.window as unknown as Record<string, unknown>;
    win.Range = FakeRange;
    win.Highlight = FakeHighlight;
    win.CSS = { highlights: highlightRegistry };
    Object.defineProperty(dom.window, "innerHeight", { value: 600, configurable: true });
    Object.defineProperty(dom.window, "innerWidth", { value: 1000, configurable: true });
    const envelope = { schemaVersion: 3, settings };
    g.chrome = {
      storage: {
        local: {
          get: (k: string | string[] | null) => {
            if (k === null || k === undefined) return Promise.resolve(Object.fromEntries(store));
            const keys = Array.isArray(k) ? k : [k];
            const out: Record<string, unknown> = {};
            for (const key of keys) {
              if (key === "settings") out[key] = envelope;
              else if (store.has(key)) out[key] = store.get(key);
            }
            return Promise.resolve(out);
          },
          set: (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) store.set(k, v);
            return Promise.resolve();
          },
          remove: (k: string | string[]) => {
            for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
            return Promise.resolve();
          },
        },
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
    } as unknown as typeof chrome;
  }

  beforeEach(() => {
    originalGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      location: globalThis.location,
      MutationObserver: globalThis.MutationObserver,
      Node: globalThis.Node,
      HTMLElement: globalThis.HTMLElement,
      Element: globalThis.Element,
      Range: (globalThis as unknown as Record<string, unknown>).Range,
      Highlight: (globalThis as unknown as Record<string, unknown>).Highlight,
      CSS: (globalThis as unknown as Record<string, unknown>).CSS,
      chrome: globalThis.chrome,
    };
    settings = makeSettings();
    store = new Map<string, unknown>();
    highlightRegistry = new Map<string, unknown>();
    FakeMutationObserver.last = null;
  });

  afterEach(() => {
    if (mod) mod.teardown();
    const g = globalThis as unknown as Record<string, unknown>;
    (Object.keys(originalGlobals) as (keyof typeof originalGlobals)[]).forEach((k) => {
      if (originalGlobals[k] === undefined) {
        try { delete g[k]; } catch { /* ignore */ }
      } else {
        try { g[k] = originalGlobals[k]; } catch { /* ignore */ }
      }
    });
    FakeMutationObserver.last = null;
    dom?.window.close();
  });

  it("revisit restores C1 markers after an early empty hydration, with zero visibility", { timeout: 30000 }, async () => {
    vi.resetModules();
    installDom("https://chatgpt.com/c/conv-one", C1_HTML(TEXT_A, TEXT_B));

    // Seed durable C1 history for block A (as a real copy would have saved).
    const { conversationFingerprintFromLocation } = await import(
      "../../src/features/writing-copy/block-identity.js"
    );
    const fpC1 = await conversationFingerprintFromLocation();
    expect(fpC1).toMatch(/^[0-9a-f]{32}$/);
    const keyC1 = HISTORY_PREFIX + fpC1;
    store.set(keyC1, [
      {
        turnIndex: 0,
        blockIndex: 0,
        fingerprint: await fingerprintText(TEXT_A),
        copiedAt: Date.now(),
      },
    ]);

    mod = await import("../../src/content/index.js");
    mod.syncRuntime(settings);
    await until(() => stateOf("block-a") === "copied");
    expect(stateOf("block-b")).toBe("uncopied");
    expect(mod.writingCopyController.visualLayer.rangeCount).toBe(1);

    // ---- travel to C2 while the OLD C1 DOM is still connected (the race) ----
    dom.window.history.pushState({}, "", "/c/conv-two");
    mod.reapplyAfterRouteChange();
    // Core regression: once the async re-apply settles, the observer must sit
    // on document.body — NOT on the outgoing (still-connected) container that
    // React is about to remove. A dead root would never see the C2 render.
    await settle();
    expect(FakeMutationObserver.last?.target).toBe(dom.window.document.body);

    // React renders C2 (wholesale replacement, as a real route render does).
    dom.window.document.body.innerHTML = C2_HTML(TEXT_C);
    const c2block = dom.window.document.getElementById("block-c")!;
    FakeMutationObserver.last!.trigger([c2block]);
    await until(() => stateOf("block-c") === "uncopied");
    // No leak: C1's copied record does not mark C2, storage untouched.
    expect(historyKeys()).toEqual([keyC1]);

    // ---- return to C1: skeleton first (early hydration finds nothing) ----
    dom.window.history.pushState({}, "", "/c/conv-one");
    dom.window.document.body.innerHTML = SKELETON_HTML;
    mod.reapplyAfterRouteChange();
    await settle();
    expect(FakeMutationObserver.last?.target).toBe(dom.window.document.body);
    // Vulnerable window: the re-apply's hydration ran against the skeleton
    // (zero blocks) and claimed nothing. No batch is delivered for the
    // skeleton itself — the body root simply stays live.
    expect(
      dom.window.document.querySelectorAll(`[${STATE_ATTR}]`),
    ).toHaveLength(0);

    // ---- late C1 render replaces the skeleton wholesale (old root dies) ----
    dom.window.document.body.innerHTML = C1_HTML(TEXT_A, TEXT_B);
    const retA = dom.window.document.getElementById("block-a")!;
    const retB = dom.window.document.getElementById("block-b")!;
    FakeMutationObserver.last!.trigger([retA, retB]);

    // WITHOUT any scroll, manual refresh, or further call: A restores copied,
    // B stays uncopied, the Highlight range is recreated. Zero-size rects mean
    // no block is "visible" — hydration must not care.
    await until(() => stateOf("block-a") === "copied");
    expect(stateOf("block-b")).toBe("uncopied");
    await until(() => mod.writingCopyController.visualLayer.rangeCount === 1);
    // The narrowing adopted the new container (guard released for the route).
    expect(FakeMutationObserver.last?.target).not.toBe(dom.window.document.body);
    // Host stays hidden with nothing visible, yet state hydrated.
    expect(mod.writingCopyController.isHostMounted).toBe(true);
    expect(
      dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]')!
        .getAttribute("data-visible"),
    ).not.toBe("true");
    // Cross-route isolation both directions; C1 key untouched.
    expect(historyKeys()).toEqual([keyC1]);
  });
});
