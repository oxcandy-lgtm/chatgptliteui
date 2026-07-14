import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../src/settings/defaults.js";
import type { Settings } from "../../src/shared/types.js";

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

function makeSettings(overrides?: Partial<Settings>): Settings {
  const s = cloneDefaults();
  s.enabled = true;
  if (overrides) Object.assign(s, overrides);
  return s;
}

function flushDebounce(): Promise<void> {
  return new Promise((r) => setTimeout(r, 200));
}

function keyEvent(
  win: { document: Document; KeyboardEvent: typeof KeyboardEvent },
  opts: {
    alt?: boolean;
    shift?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    code?: string;
    key?: string;
    repeat?: boolean;
    target?: string;
    contenteditable?: boolean;
  },
): KeyboardEvent {
  const ev = new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "altKey", { value: opts.alt ?? false });
  Object.defineProperty(ev, "shiftKey", { value: opts.shift ?? false });
  Object.defineProperty(ev, "ctrlKey", { value: opts.ctrl ?? false });
  Object.defineProperty(ev, "metaKey", { value: opts.meta ?? false });
  Object.defineProperty(ev, "code", { value: opts.code ?? "KeyL" });
  Object.defineProperty(ev, "key", { value: opts.key ?? "l" });
  Object.defineProperty(ev, "repeat", { value: opts.repeat ?? false });
  Object.defineProperty(ev, "isComposing", { value: false });
  if (opts.target || opts.contenteditable) {
    const t = win.document.createElement(opts.target ?? "div");
    if (opts.contenteditable) t.setAttribute("contenteditable", "true");
    Object.defineProperty(ev, "target", { value: t });
  }
  return ev;
}

describe("sidebar content runtime + keyboard", () => {
  let dom: JSDOM;
  let mod: typeof import("../../src/content/index.js");
  let lastEnv: Settings;
  const keymap: ((e: KeyboardEvent) => void)[] = [];

  function setEnv(s: Settings): void {
    lastEnv = s;
  }

  function installDom(): JSDOM {
    return new JSDOM(
      `<!doctype html><html><body>
        <div id="app">
          <aside data-testid="sidebar"><nav aria-label="Chat history"><a href="/c/1">a</a><a href="/c/2">b</a></nav></aside>
          <main role="main"><section data-testid="thread" aria-label="conversation"></section></main>
        </div>
      </body></html>`,
      { url: "https://chatgpt.com/c/aaa", pretendToBeVisual: true },
    );
  }

  beforeEach(async () => {
    vi.resetModules();
    setEnv(makeSettings());
    dom = installDom();
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.location = dom.window.location;
    g.KeyboardEvent = dom.window.KeyboardEvent;
    g.HTMLElement = dom.window.HTMLElement;
    g.MutationObserver = FakeMutationObserver;
    g.Node = dom.window.Node;
    dom.window.document.addEventListener = ((type: string, cb: (e: KeyboardEvent) => void) => {
      if (type === "keydown") keymap.push(cb);
      return undefined;
    }) as typeof dom.window.document.addEventListener;
    const chromeStub = {
      storage: {
        local: {
          get: (k: string) => Promise.resolve({ [k]: { schemaVersion: 2, settings: lastEnv } }),
          set: (_v: unknown) => Promise.resolve(),
        },
        onChanged: { addListener: () => {} },
      },
    };
    g.chrome = chromeStub;
    mod = await import("../../src/content/index.js");
  });

  afterEach(() => {
    if (mod) mod.teardown();
    keymap.length = 0;
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.location;
    delete g.KeyboardEvent;
    delete g.MutationObserver;
    delete g.Node;
    delete g.chrome;
    FakeMutationObserver.last = null;
  });

  function sidebarEl(): Element {
    return dom.window.document.querySelector('[data-testid="sidebar"]')!;
  }

  it("non-visible sidebar mode activates structural observation even on Normal appearance", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    const obs = FakeMutationObserver.last!;
    expect(obs.disconnected).toBe(false);
    expect(obs.target).not.toBe(dom.window.document.body);
  });

  it("visible + Normal has no structural observer", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "visible" } }));
    await new Promise((r) => setTimeout(r, 0));
    const obs = FakeMutationObserver.last;
    expect(obs === null || obs.disconnected).toBe(true);
    // Official sidebar untouched (no closed class, no marker).
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
  });

  it("observer narrows from body to a narrower app root after sidebar appears", async () => {
    const bodyOnly = new JSDOM(`<!doctype html><html><body></body></html>`, {
      url: "https://chatgpt.com/c/x",
      pretendToBeVisual: true,
    });
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = bodyOnly.window;
    g.document = bodyOnly.window.document;
    g.location = bodyOnly.window.location;
    g.KeyboardEvent = bodyOnly.window.KeyboardEvent;
    g.HTMLElement = bodyOnly.window.HTMLElement;
    g.MutationObserver = FakeMutationObserver;
    g.Node = bodyOnly.window.Node;
    setEnv(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    const first = FakeMutationObserver.last!;
    expect(first.target).toBe(bodyOnly.window.document.body);

    bodyOnly.window.document.body.innerHTML = `
      <div id="app">
        <aside data-testid="sidebar"><nav aria-label="Chat history"><a href="/c/1">a</a></nav></aside>
        <main role="main"><section data-testid="thread"></section></main>
      </div>`;
    first.trigger([bodyOnly.window.document.getElementById("app")!]);
    await flushDebounce();
    const second = FakeMutationObserver.last!;
    expect(second.target).not.toBe(bodyOnly.window.document.body);
    expect(second.target).toBe(bodyOnly.window.document.getElementById("app"));
  });

  it("extension host mutation does not trigger a refresh loop", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    const obs = FakeMutationObserver.last!;
    const host = dom.window.document.createElement("div");
    host.id = "cgl-sidebar-control-host";
    dom.window.document.body.appendChild(host);
    const before = FakeMutationObserver.last;
    obs.trigger([host]);
    await flushDebounce();
    expect(FakeMutationObserver.last).toBe(before);
  });

  it("sidebar replacement gets rebound (marker moves to new element)", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    const obs = FakeMutationObserver.last!;
    sidebarEl().remove();
    const newAside = dom.window.document.createElement("aside");
    newAside.setAttribute("data-testid", "sidebar");
    newAside.innerHTML = `<nav aria-label="Chat history"><a href="/c/9">z</a></nav>`;
    dom.window.document.getElementById("app")!.appendChild(newAside);
    obs.trigger([newAside]);
    await flushDebounce();
    expect(newAside.getAttribute("data-cgl-sidebar-target")).toBe("true");
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
  });

  it("exact Alt+Shift+L toggles and calls preventDefault; wrong modifiers do nothing", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    const wrong = keyEvent(dom.window, { alt: true, shift: true, ctrl: true, meta: false, code: "KeyL" });
    keymap.forEach((cb) => cb(wrong));
    expect(wrong.defaultPrevented).toBe(false);
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    const good = keyEvent(dom.window, { alt: true, shift: true, ctrl: false, meta: false, code: "KeyL" });
    keymap.forEach((cb) => cb(good));
    await new Promise((r) => setTimeout(r, 20));
    expect(good.defaultPrevented).toBe(true);
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
  });

  it("keyboard toggle ignores repeat, composition, and editable fields", () => {
    const handler = mod.handleKeydown;
    const repeat = keyEvent(dom.window, { alt: true, shift: true, repeat: true });
    handler(repeat);
    expect(repeat.defaultPrevented).toBe(false);
    const inp = keyEvent(dom.window, { alt: true, shift: true, target: "input" });
    handler(inp);
    expect(inp.defaultPrevented).toBe(false);
    const ce = keyEvent(dom.window, { alt: true, shift: true, contenteditable: true });
    handler(ce);
    expect(ce.defaultPrevented).toBe(false);
    const good = keyEvent(dom.window, { alt: true, shift: true });
    handler(good);
    expect(good.defaultPrevented).toBe(true);
  });
});
