import { describe, it, expect, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../src/settings/defaults.js";
import type { Settings } from "../../src/shared/types.js";

class FakeMutationObserver {
  static last: FakeMutationObserver | null = null;
  static instances: FakeMutationObserver[] = [];
  /** Most recent STRUCTURAL observer (excludes the tagged sidebar observer). */
  static structuralLast(): FakeMutationObserver | null {
    const list = FakeMutationObserver.instances.filter(
      (o) => !(o as unknown as Record<string, unknown>).cglSidebarColorObserver,
    );
    return list.length > 0 ? list[list.length - 1]! : null;
  }
  cb: (mutations: MutationRecord[], obs: FakeMutationObserver) => void;
  target: Node | null = null;
  disconnected = false;
  constructor(cb: (mutations: MutationRecord[], obs: FakeMutationObserver) => void) {
    this.cb = cb;
    FakeMutationObserver.last = this;
    FakeMutationObserver.instances.push(this);
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
    this.cb(
      [{ addedNodes: nodes as unknown as NodeListOf<Node> } as MutationRecord],
      this,
    );
  }
}

function makeSettings(overrides?: Partial<Settings>): Settings {
  const s = cloneDefaults();
  s.enabled = true;
  if (overrides) Object.assign(s, overrides);
  return s;
}

function flushDebounce(): Promise<void> {
  return new Promise((r) => setTimeout(r, 200));
}

function installDom(): JSDOM {
  return new JSDOM(
    `<!doctype html><html><body>
      <div id="app">
        <aside data-testid="sidebar"><nav aria-label="Chat history"><a href="/c/1">a</a></nav></aside>
        <main role="main"><section data-testid="thread" aria-label="conversation">
          <div data-message-author-role="assistant" data-testid="assistant-message">
            <div data-testid="text-block" id="w1"><p>Prose one.</p></div>
          </div>
        </section></main>
      </div>
    </body></html>`,
    { url: "https://chatgpt.com/c/aaa", pretendToBeVisual: true },
  );
}

describe("writing-copy runtime integration", () => {
  let dom: JSDOM;
  let mod: typeof import("../../src/content/index.js");
  let lastEnv: Settings;
  const listeners = new Map<string, Set<(e: KeyboardEvent) => void>>();
  let originalGlobals: Record<string, unknown>;

  function setEnv(s: Settings): void {
    lastEnv = s;
  }

  beforeEachHook();

  function beforeEachHook(): void {
    afterEach(async () => {
      const g = globalThis as unknown as Record<string, unknown>;
      (Object.keys(originalGlobals) as (keyof typeof originalGlobals)[]).forEach((k) => {
        if (originalGlobals[k] === undefined) {
          try { delete (g as Record<string, unknown>)[k]; } catch { /* ignore */ }
        } else {
          try {
            const desc = Object.getOwnPropertyDescriptor(globalThis, k);
            if (desc && !desc.writable) return;
            g[k] = originalGlobals[k];
          } catch { /* ignore */ }
        }
      });
      vi.restoreAllMocks();
      listeners.clear();
      dom?.window.close();
    });
  }

  async function setup(): Promise<void> {
    vi.resetModules();
    originalGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      location: globalThis.location,
      KeyboardEvent: globalThis.KeyboardEvent,
      HTMLElement: globalThis.HTMLElement,
      Element: globalThis.Element,
      Node: globalThis.Node,
      DOMRect: globalThis.DOMRect,
      MutationObserver: globalThis.MutationObserver,
      IntersectionObserver: globalThis.IntersectionObserver,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
      navigator: globalThis.navigator,
      chrome: globalThis.chrome,
    };
    setEnv(makeSettings());
    dom = installDom();
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.location = dom.window.location;
    g.KeyboardEvent = dom.window.KeyboardEvent;
    g.HTMLElement = dom.window.HTMLElement;
    g.Node = dom.window.Node;
    g.MutationObserver = FakeMutationObserver;
    FakeMutationObserver.last = null;
    FakeMutationObserver.instances = [];
    listeners.clear();
    dom.window.document.addEventListener = ((type: string, cb: (e: KeyboardEvent) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    }) as typeof dom.window.document.addEventListener;
    dom.window.document.removeEventListener = ((type: string, cb: (e: KeyboardEvent) => void) => {
      listeners.get(type)?.delete(cb);
    }) as typeof dom.window.document.removeEventListener;
    const chromeStub = {
      storage: {
        local: {
          get: (k: string) => Promise.resolve({ [k]: { schemaVersion: 3, settings: lastEnv } }),
          set: () => Promise.resolve(),
        },
        onChanged: { addListener: () => {} },
      },
    };
    g.chrome = chromeStub;
    mod = await import("../../src/content/index.js");
    await new Promise((r) => setTimeout(r, 0));
  }

  it("writing-copy alone activates the shared structural observer", async () => {
    await setup();
    const s = makeSettings({ appearance: cloneDefaults().appearance, sidebar: { mode: "visible" }, writingCopy: { ...cloneDefaults().writingCopy, enabled: true, position: "middle-right", shortcutEnabled: true } });
    mod.syncRuntime(s);
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeMutationObserver.structuralLast()).not.toBeNull();
  });

  it("writing-copy disabled does not activate it by itself", async () => {
    await setup();
    const s = makeSettings({ appearance: cloneDefaults().appearance, sidebar: { mode: "visible" }, writingCopy: { ...cloneDefaults().writingCopy, enabled: false, position: "middle-right", shortcutEnabled: true } });
    mod.syncRuntime(s);
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeMutationObserver.structuralLast()).toBeNull();
  });

  it("new Assistant block is discovered after mutation", async () => {
    await setup();
    const s = makeSettings({ sidebar: { mode: "visible" }, writingCopy: { ...cloneDefaults().writingCopy, enabled: true, position: "middle-right", shortcutEnabled: true } });
    mod.syncRuntime(s);
    await new Promise((r) => setTimeout(r, 0));
    expect(mod.writingCopyController.isHostMounted).toBe(true);
    // Add another block.
    const msg = dom.window.document.querySelector('[data-testid="assistant-message"]')!;
    const nb = dom.window.document.createElement("div");
    nb.setAttribute("data-testid", "text-block");
    nb.innerHTML = "<p>Prose two.</p>";
    msg.appendChild(nb);
    FakeMutationObserver.structuralLast()!.trigger([nb]);
    await flushDebounce();
    expect(mod.writingCopyController.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("host mutation does not create a refresh loop", async () => {
    await setup();
    const s = makeSettings({ sidebar: { mode: "visible" }, writingCopy: { ...cloneDefaults().writingCopy, enabled: true, position: "middle-right", shortcutEnabled: true } });
    mod.syncRuntime(s);
    await new Promise((r) => setTimeout(r, 0));
    const host = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]')!;
    const before = FakeMutationObserver.structuralLast()!;
    // Trigger a mutation with the host node; observer must ignore extension hosts.
    FakeMutationObserver.structuralLast()!.trigger([host]);
    await flushDebounce();
    expect(FakeMutationObserver.structuralLast()).toBe(before); // no new observer created
  });

  it("disable writing-copy removes marker/host/shortcut/IO", async () => {
    await setup();
    const on = makeSettings({ sidebar: { mode: "visible" }, writingCopy: { ...cloneDefaults().writingCopy, enabled: true, position: "middle-right", shortcutEnabled: true } });
    mod.syncRuntime(on);
    await new Promise((r) => setTimeout(r, 0));
    expect(mod.writingCopyController.isHostMounted).toBe(true);
    const off = makeSettings({ sidebar: { mode: "visible" }, writingCopy: { ...cloneDefaults().writingCopy, enabled: false, position: "middle-right", shortcutEnabled: true } });
    mod.syncRuntime(off);
    await new Promise((r) => setTimeout(r, 0));
    expect(mod.writingCopyController.isHostMounted).toBe(false);
    expect(dom.window.document.querySelectorAll('[data-cgl-writing-block="true"]').length).toBe(0);
    const keyLs = listeners.get("keydown") ?? new Set();
    // sidebar (Alt+Shift+L) + ALWAYS-ON X-Ray maintenance port (Alt+Shift+X).
    expect(keyLs.size).toBe(2);
  });

  it("repeated sync never duplicates the writing-copy host", async () => {
    await setup();
    const s = makeSettings({ sidebar: { mode: "visible" }, writingCopy: { ...cloneDefaults().writingCopy, enabled: true, position: "middle-right", shortcutEnabled: true } });
    mod.syncRuntime(s);
    mod.syncRuntime(s);
    mod.syncRuntime(s);
    await new Promise((r) => setTimeout(r, 0));
    expect(dom.window.document.querySelectorAll('[data-cgl-writing-copy-host="true"]').length).toBe(1);
  });

  it("missing safe conversation container mounts no host", async () => {
    await setup();
    dom.window.document.querySelector("main")!.remove();
    const s = makeSettings({ sidebar: { mode: "visible" }, writingCopy: { ...cloneDefaults().writingCopy, enabled: true, position: "middle-right", shortcutEnabled: true } });
    mod.syncRuntime(s);
    await new Promise((r) => setTimeout(r, 0));
    expect(mod.writingCopyController.isHostMounted).toBe(false);
  });
});
