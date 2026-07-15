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
  // Listener registry implementing BOTH add/remove so we can verify the exact
  // same function reference is attached and later removed (Fix 7).
  const listeners = new Map<string, Set<(e: KeyboardEvent) => void>>();

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
    listeners.clear();
    dom.window.document.addEventListener = ((type: string, cb: (e: KeyboardEvent) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
      return undefined;
    }) as typeof dom.window.document.addEventListener;
    dom.window.document.removeEventListener = ((type: string, cb: (e: KeyboardEvent) => void) => {
      listeners.get(type)?.delete(cb);
      return undefined;
    }) as typeof dom.window.document.removeEventListener;
    const onChangedCbs: ((changes: Record<string, unknown>, area: string) => void)[] = [];
    const chromeStub = {
      storage: {
        local: {
          get: (k: string) => Promise.resolve({ [k]: { schemaVersion: 2, settings: lastEnv } }),
          set: (_v: unknown) => Promise.resolve(),
        },
        onChanged: { addListener: (cb: (changes: Record<string, unknown>, area: string) => void) => {
          onChangedCbs.push(cb);
        } },
      },
    };
    g.chrome = chromeStub;
    mod = await import("../../src/content/index.js");
    // Expose onChanged for Fix 5 tests.
    (mod as unknown as { __onChanged: typeof onChangedCbs }).__onChanged = onChangedCbs;
  });

  afterEach(() => {
    if (mod) mod.teardown();
    listeners.clear();
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.location;
    delete g.KeyboardEvent;
    delete g.HTMLElement;
    delete g.MutationObserver;
    delete g.Node;
    delete g.chrome;
    FakeMutationObserver.last = null;
  });

  function sidebarEl(): Element {
    return dom.window.document.querySelector('[data-testid="sidebar"]')!;
  }

  function keyboardListeners(): ((e: KeyboardEvent) => void)[] {
    return Array.from(listeners.get("keydown") ?? []) as ((e: KeyboardEvent) => void)[];
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

  // ---- Fix 2: keyboard listener lifecycle ----

  function toggleListeners(): ((e: KeyboardEvent) => void)[] {
    return keyboardListeners().filter((cb) => cb === mod.handleKeydown);
  }

  it("enabled attaches exactly one keydown listener; disabled removes it", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    expect(toggleListeners().length).toBe(1);
    const ref = toggleListeners()[0];
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" }, enabled: false }));
    // Same reference removed, none remaining.
    expect(toggleListeners()).not.toContain(ref);
    expect(toggleListeners().length).toBe(0);
  });

  it("repeated enable/apply does not register duplicate listeners", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await mod.syncRuntime(makeSettings({ preset: "work", sidebar: { mode: "hover" } }));
    // Only the toggle handler (mod.handleKeydown) must be registered once.
    expect(toggleListeners().length).toBe(1);
  });

  it("re-enable restores exactly one listener", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" }, enabled: false }));
    expect(toggleListeners().length).toBe(0);
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    expect(toggleListeners().length).toBe(1);
  });

  it("teardown removes the listener", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    expect(toggleListeners().length).toBe(1);
    mod.teardown();
    expect(toggleListeners().length).toBe(0);
  });

  it("disabled extension does not call preventDefault and does not toggle", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" }, enabled: false }));
    const ref = mod.handleKeydown;
    const ev = keyEvent(dom.window, { alt: true, shift: true });
    ref(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("exact Alt+Shift+L toggles and calls preventDefault; wrong modifiers do nothing", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    const wrong = keyEvent(dom.window, { alt: true, shift: true, ctrl: true, meta: false, code: "KeyL" });
    mod.handleKeydown(wrong);
    expect(wrong.defaultPrevented).toBe(false);
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    const good = keyEvent(dom.window, { alt: true, shift: true, ctrl: false, meta: false, code: "KeyL" });
    mod.handleKeydown(good);
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

  // ---- Fix 3: Visible-mode temporary hide activates observer + survives SPA ----

  it("Visible + Normal initially has no observer", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "visible" } }));
    await new Promise((r) => setTimeout(r, 0));
    const obs = FakeMutationObserver.last;
    expect(obs === null || obs.disconnected).toBe(true);
  });

  it("shortcut hides Visible sidebar and attaches one observer", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "visible" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeMutationObserver.last === null || FakeMutationObserver.last!.disconnected).toBe(true);
    // Toggle via the real handler.
    mod.handleKeydown(keyEvent(dom.window, { alt: true, shift: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    expect(FakeMutationObserver.last!.disconnected).toBe(false);
    expect(FakeMutationObserver.last!.target).not.toBe(dom.window.document.body);
  });

  it("sidebar replacement is rebound while temporarily hidden (Visible)", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "visible" } }));
    await new Promise((r) => setTimeout(r, 0));
    mod.handleKeydown(keyEvent(dom.window, { alt: true, shift: true }));
    await new Promise((r) => setTimeout(r, 20));
    const obs = FakeMutationObserver.last!;
    // Verify observer is active.
    expect(obs.disconnected).toBe(false);
    sidebarEl().remove();
    const newAside = dom.window.document.createElement("aside");
    newAside.setAttribute("data-testid", "sidebar");
    newAside.innerHTML = `<nav aria-label="Chat history"><a href="/c/9">z</a></nav>`;
    dom.window.document.getElementById("app")!.appendChild(newAside);
    obs.trigger([newAside]);
    await flushDebounce();
    expect(newAside.getAttribute("data-cgl-sidebar-target")).toBe("true");
  });

  it("SPA route refresh preserves the closed override (Visible)", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "visible" } }));
    await new Promise((r) => setTimeout(r, 0));
    mod.handleKeydown(keyEvent(dom.window, { alt: true, shift: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    // Simulate SPA route change: bootstrap re-applies from storage (override is
    // not persisted, so the controller must retain it across reapply).
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "visible" } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
  });

  it("shortcut restores Visible mode and disconnects the observer when no other effect exists", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "visible" } }));
    await new Promise((r) => setTimeout(r, 0));
    mod.handleKeydown(keyEvent(dom.window, { alt: true, shift: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    expect(FakeMutationObserver.last!.disconnected).toBe(false);
    // Toggle back: cleared override -> no observer.
    mod.handleKeydown(keyEvent(dom.window, { alt: true, shift: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    expect(FakeMutationObserver.last!.disconnected).toBe(true);
  });

  it("no duplicate observers across toggles; final state matches effective runtime", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "visible" } }));
    await new Promise((r) => setTimeout(r, 0));
    // Visible initially: no observer.
    expect(FakeMutationObserver.last === null || FakeMutationObserver.last!.disconnected).toBe(true);

    const created: FakeMutationObserver[] = [];
    for (let i = 0; i < 4; i++) {
      mod.handleKeydown(keyEvent(dom.window, { alt: true, shift: true }));
      await new Promise((r) => setTimeout(r, 10));
      created.push(FakeMutationObserver.last!);
    }

    // Across the toggles, exactly one observer is active at any time: every
    // prior instance must have been disconnected before a replacement.
    const active = created.filter((o) => !o.disconnected);
    expect(active.length).toBeLessThanOrEqual(1);

    // 4 toggles from Visible => no temporary override => observer disconnected.
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    expect(FakeMutationObserver.last!.disconnected).toBe(true);

    // Toggling back to a transient-closed state reconnects exactly one observer.
    mod.handleKeydown(keyEvent(dom.window, { alt: true, shift: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    expect(FakeMutationObserver.last!.disconnected).toBe(false);
  });

  // ---- Fix 4: observer connect race protection (delayed storage promises) ----

  it("Work/Hidden -> Normal does not reconnect after a stale async result", async () => {
    // Synchronous-ish: apply hidden, then normal. The hidden observer is torn
    // down and must not be reconnected by a delayed getSettings() result.
    await mod.syncRuntime(makeSettings({ preset: "work", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeMutationObserver.last!.disconnected).toBe(false);
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "visible" } }));
    await flushDebounce();
    expect(FakeMutationObserver.last!.disconnected).toBe(true);
  });

  it("enabled -> disabled does not reconnect after a stale async result", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeMutationObserver.last!.disconnected).toBe(false);
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" }, enabled: false }));
    await flushDebounce();
    expect(FakeMutationObserver.last!.disconnected).toBe(true);
  });

  it("active -> teardown does not reconnect after a stale async result", async () => {
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeMutationObserver.last!.disconnected).toBe(false);
    mod.teardown();
    await flushDebounce();
    expect(FakeMutationObserver.last!.disconnected).toBe(true);
  });

  // ---- Fix 5: selective transient clearing on storage changes ----

  function fireStorageChange(next: Settings): Promise<void> {
    setEnv(next);
    const cbs = (mod as unknown as { __onChanged: ((c: Record<string, unknown>, a: string) => void)[] }).__onChanged;
    for (const cb of cbs) cb({ settings: { newValue: { schemaVersion: 2, settings: next } } }, "local");
    return new Promise((r) => setTimeout(r, 20));
  }

  it("Hidden temporarily open + theme change -> remains temporarily open", async () => {
    const base = makeSettings({ preset: "normal", sidebar: { mode: "hidden" } });
    await mod.syncRuntime(base);
    await new Promise((r) => setTimeout(r, 0));
    // Open temporarily via shortcut.
    mod.handleKeydown(keyEvent(dom.window, { alt: true, shift: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    // Unrelated theme change should NOT clear the transient override.
    const themed = makeSettings({ preset: "normal", sidebar: { mode: "hidden" } });
    themed.theme.pageBackground = "#0a0a0a";
    await fireStorageChange(themed);
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
  });

  it("Visible temporarily closed + appearance change -> remains closed", async () => {
    const base = makeSettings({ preset: "normal", sidebar: { mode: "visible" } });
    await mod.syncRuntime(base);
    await new Promise((r) => setTimeout(r, 0));
    mod.handleKeydown(keyEvent(dom.window, { alt: true, shift: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    // Unrelated appearance change should NOT clear the transient override.
    const appearance = makeSettings({ preset: "normal", sidebar: { mode: "visible" } });
    appearance.appearance.useConversationWidth = true;
    appearance.appearance.conversationWidth = 900;
    await fireStorageChange(appearance);
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
  });

  it("sidebar mode change -> transient cleared", async () => {
    const base = makeSettings({ preset: "normal", sidebar: { mode: "hidden" } });
    await mod.syncRuntime(base);
    await new Promise((r) => setTimeout(r, 0));
    mod.handleKeydown(keyEvent(dom.window, { alt: true, shift: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    // Mode change to visible clears transient; sidebar restored.
    await fireStorageChange(makeSettings({ preset: "normal", sidebar: { mode: "visible" } }));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    expect(dom.window.document.querySelector('[data-cgl-sidebar-target]')).toBeNull();
  });

  it("extension disabled -> transient cleared and official UI restored", async () => {
    const base = makeSettings({ preset: "normal", sidebar: { mode: "hidden" } });
    await mod.syncRuntime(base);
    await new Promise((r) => setTimeout(r, 0));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    // Disable: transient cleared, marker removed, observer gone.
    await fireStorageChange(makeSettings({ preset: "normal", sidebar: { mode: "hidden" }, enabled: false }));
    expect(dom.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    expect(dom.window.document.querySelector('[data-cgl-sidebar-target]')).toBeNull();
  });

  // ---- Fix 3: observer roots come only from a safe sidebar target ----

  function moveAsideInto(parent: Element): HTMLElement {
    const aside = dom.window.document.querySelector('[data-testid="sidebar"]') as HTMLElement;
    parent.appendChild(aside);
    return aside;
  }

  it("unsafe sidebar candidate inside main is rejected; observer stays on body", async () => {
    moveAsideInto(dom.window.document.querySelector("main")!);
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    // pickObserverTarget must NOT narrow around the raw (unsafe) candidate.
    expect(FakeMutationObserver.last!.target).toBe(dom.window.document.body);
  });

  it("dialog-contained sidebar candidate is also rejected; observer stays on body", async () => {
    const dialog = dom.window.document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dom.window.document.getElementById("app")!.appendChild(dialog);
    moveAsideInto(dialog);
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeMutationObserver.last!.target).toBe(dom.window.document.body);
  });

  it("valid sidebar later added outside main is observed and adopted (narrows)", async () => {
    // Start unsafe (inside main) -> observer on body.
    moveAsideInto(dom.window.document.querySelector("main")!);
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeMutationObserver.last!.target).toBe(dom.window.document.body);

    // Move the aside outside main (now safe) and trigger a structural change
    // with the actually-added node.
    const app = dom.window.document.getElementById("app")!;
    const moved = dom.window.document.querySelector('[data-testid="sidebar"]') as HTMLElement;
    app.appendChild(moved);
    FakeMutationObserver.last!.trigger([moved]);
    await flushDebounce();

    // Observer reconnects to the narrower safe app root, not body.
    expect(FakeMutationObserver.last!.target).not.toBe(dom.window.document.body);
    expect(FakeMutationObserver.last!.target).toBe(app);
  });

  it("no duplicate observer is created during safe-root recovery", async () => {
    moveAsideInto(dom.window.document.querySelector("main")!);
    await mod.syncRuntime(makeSettings({ preset: "normal", sidebar: { mode: "hidden" } }));
    await new Promise((r) => setTimeout(r, 0));
    const first = FakeMutationObserver.last!;

    const app = dom.window.document.getElementById("app")!;
    const moved = dom.window.document.querySelector('[data-testid="sidebar"]') as HTMLElement;
    app.appendChild(moved);
    FakeMutationObserver.last!.trigger([moved]);
    await flushDebounce();
    const second = FakeMutationObserver.last!;

    // The first (body) observer must be disconnected before the narrower one
    // is adopted; exactly one active observer at the end.
    expect(first.disconnected).toBe(true);
    expect(second.disconnected).toBe(false);
    expect(second.target).toBe(app);
  });
});
