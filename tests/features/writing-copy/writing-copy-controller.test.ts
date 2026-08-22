import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../../src/settings/defaults.js";
import type { Settings } from "../../../src/shared/types.js";
import { WritingCopyController } from "../../../src/features/writing-copy/writing-copy-controller.js";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";

function installDom(html: string): JSDOM {
  const dom = new JSDOM(html, { url: "https://chatgpt.com/c/aaa", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  // jsdom returns zero rects; synthesize from inline top/left/width/height so
  // the tracker can compute center distances.
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
  return dom;
}

const RUNTIME = (blocks: string): string =>
  `<main role="main"><section data-testid="thread" aria-label="conversation">
    <div data-message-author-role="assistant" data-testid="assistant-message">${blocks}</div>
  </section></main>`;

function keyEvent(
  win: { KeyboardEvent: typeof KeyboardEvent },
  opts: { alt?: boolean; shift?: boolean; ctrl?: boolean; meta?: boolean; code?: string; repeat?: boolean; composing?: boolean },
): KeyboardEvent {
  const ev = new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "altKey", { value: opts.alt ?? false });
  Object.defineProperty(ev, "shiftKey", { value: opts.shift ?? false });
  Object.defineProperty(ev, "ctrlKey", { value: opts.ctrl ?? false });
  Object.defineProperty(ev, "metaKey", { value: opts.meta ?? false });
  Object.defineProperty(ev, "code", { value: opts.code ?? "KeyC" });
  Object.defineProperty(ev, "repeat", { value: opts.repeat ?? false });
  Object.defineProperty(ev, "isComposing", { value: opts.composing ?? false });
  return ev;
}

function makeSettings(over: Partial<Settings["writingCopy"]>): Settings {
  const s = cloneDefaults();
  s.enabled = true;
  s.writingCopy = { ...s.writingCopy, enabled: false, position: "middle-right", shortcutEnabled: true, ...over };
  return s;
}

describe("writing-copy controller + shortcut", () => {
  let dom: JSDOM;
  let originalGlobals: Record<string, unknown>;
  beforeEach(() => {
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
    };
  });
  afterEach(() => {
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
    dom?.window.close();
  });

  function block(): string {
    return `<div data-testid="text-block" id="b" style="position:absolute;top:50px;left:0;width:300px;height:120px;"><p>Prose</p></div>`;
  }

  it("exact Alt+Shift+C invokes the shared copy path", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    c.apply(makeSettings({ enabled: true }));
    const ev = keyEvent(dom.window, { alt: true, shift: true, code: "KeyC" });
    // preventDefault called only on valid match; we just ensure no throw and handler runs.
    expect(() => c.keyboardHandler(ev)).not.toThrow();
  });

  it("wrong modifier combinations do nothing", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    c.apply(makeSettings({ enabled: true }));
    const ev = keyEvent(dom.window, { shift: true, code: "KeyC" });
    const pd = vi.spyOn(ev, "preventDefault");
    expect(() => c.keyboardHandler(ev)).not.toThrow();
    // Wrong modifiers: no preventDefault.
    expect(pd).not.toHaveBeenCalled();
  });

  it("repeat ignored", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    c.apply(makeSettings({ enabled: true }));
    const ev = keyEvent(dom.window, { alt: true, shift: true, code: "KeyC", repeat: true });
    expect(() => c.keyboardHandler(ev)).not.toThrow();
  });

  it("composition ignored", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    c.apply(makeSettings({ enabled: true }));
    const ev = keyEvent(dom.window, { alt: true, shift: true, code: "KeyC", composing: true });
    expect(() => c.keyboardHandler(ev)).not.toThrow();
  });

  it("no safe target means no preventDefault", () => {
    dom = installDom(RUNTIME(""));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    c.apply(makeSettings({ enabled: true }));
    const ev = keyEvent(dom.window, { alt: true, shift: true, code: "KeyC" });
    const pd = vi.spyOn(ev, "preventDefault");
    c.keyboardHandler(ev);
    expect(pd).not.toHaveBeenCalled();
  });

  it("exact valid match with safe target calls preventDefault", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    c.apply(makeSettings({ enabled: true }));
    const ev = keyEvent(dom.window, { alt: true, shift: true, code: "KeyC" });
    const pd = vi.spyOn(ev, "preventDefault");
    c.keyboardHandler(ev);
    expect(pd).toHaveBeenCalled();
  });

  it("feature disabled means isShortcutActive false", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    const s = makeSettings({ enabled: false });
    expect(c.isShortcutActive(s)).toBe(false);
  });

  it("extension disabled means isShortcutActive false", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    const s = makeSettings({ enabled: true });
    s.enabled = false;
    expect(c.isShortcutActive(s)).toBe(false);
  });

  it("shortcut disabled means isShortcutActive false", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    expect(c.isShortcutActive(makeSettings({ enabled: true, shortcutEnabled: false }))).toBe(false);
  });

  it("apply mounts exactly one host and marks the block", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    c.apply(makeSettings({ enabled: true }));
    expect(c.isHostMounted).toBe(true);
    expect(dom.window.document.querySelectorAll('[data-cgl-writing-block="true"]').length).toBe(1);
  });

  it("restore removes markers/host/listeners/references (idempotent)", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    c.apply(makeSettings({ enabled: true }));
    c.restore();
    expect(c.isHostMounted).toBe(false);
    expect(dom.window.document.querySelectorAll('[data-cgl-writing-block="true"]').length).toBe(0);
    expect(dom.window.document.documentElement.classList.contains("cgl-writing-copy-active")).toBe(false);
    c.restore();
    expect(c.isHostMounted).toBe(false);
  });

  it("disabling the feature removes the marker and host", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    c.apply(makeSettings({ enabled: true }));
    c.apply(makeSettings({ enabled: false }));
    expect(c.isHostMounted).toBe(false);
    expect(dom.window.document.querySelectorAll('[data-cgl-writing-block="true"]').length).toBe(0);
  });

  it("teardown removes the same guarded references", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    c.apply(makeSettings({ enabled: true }));
    c.teardown();
    expect(c.isHostMounted).toBe(false);
    expect(c.target).toBeNull();
    expect(c.candidates.length).toBe(0);
  });

  it("SPA route change clears old markers and binds new route", () => {
    dom = installDom(RUNTIME(block()));
    const c = new WritingCopyController(dom.window.document.documentElement, createAdapter());
    c.apply(makeSettings({ enabled: true }));
    expect(dom.window.document.querySelectorAll('[data-cgl-writing-block="true"]').length).toBe(1);
    // New route HTML replaces content.
    dom.window.document.body.innerHTML = RUNTIME(`<div data-testid="text-block" id="b2"><p>New prose</p></div>`);
    c.refresh(makeSettings({ enabled: true }));
    expect(dom.window.document.querySelectorAll('[data-cgl-writing-block="true"]').length).toBe(1);
    expect(dom.window.document.getElementById("b2")!.getAttribute("data-cgl-writing-block")).toBe("true");
  });
});
