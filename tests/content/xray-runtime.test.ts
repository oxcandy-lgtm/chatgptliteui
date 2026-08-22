import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createAdapter } from "../../src/adapters/chatgpt-adapter.js";
import {
  XrayController,
  isXrayShortcut,
  ALL_XRAY_PAINT_ATTRS,
} from "../../src/features/maintenance/xray-controller.js";
import type { Settings } from "../../src/shared/types.js";
import { cloneDefaults } from "../../src/settings/defaults.js";

/**
 * Focused X-Ray lifecycle tests:
 *  - exact Alt+Shift+X matching (no Ctrl/Meta);
 *  - toggle ON mounts the Shadow DOM host (heartbeat + panel) with zero
 *    dependency on ChatGPT selectors;
 *  - picker mode swallows the diagnostic click and captures the target;
 *  - OFF removes host + every diagnostic paint attribute (complete cleanup);
 *  - runtime keydown route works even when the extension is disabled.
 */

function installDom(html: string): JSDOM {
  const dom = new JSDOM(html, { url: "https://chatgpt.com/c/tok", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  return dom;
}

function makeSettings(overrides?: Partial<Settings>): Settings {
  const s = cloneDefaults();
  s.enabled = true;
  if (overrides) Object.assign(s, overrides);
  return s;
}

const CONV = `<html><body><main role="main"><section data-testid="thread">
  <div data-message-author-role="assistant" data-testid="assistant-message">
    <div data-testid="text-block" id="wb1"><p>Prose block.</p></div>
    <button aria-label="Copy">copy</button>
  </div>
</section></main></body></html>`;

describe("xray lifecycle", () => {
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
      PointerEvent: globalThis.PointerEvent,
      MouseEvent: globalThis.MouseEvent,
    };
  });

  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    (Object.keys(originalGlobals) as (keyof typeof originalGlobals)[]).forEach((k) => {
      if (originalGlobals[k] === undefined) {
        try { delete (g as Record<string, unknown>)[k]; } catch { /* ignore */ }
      } else {
        try { g[k] = originalGlobals[k]; } catch { /* ignore */ }
      }
    });
    dom?.window.close();
  });

  function makeController(settings: Settings): XrayController {
    return new XrayController({
      root: dom.window.document.documentElement,
      adapter: createAdapter(),
      getSettings: () => settings,
    });
  }

  it("isXrayShortcut matches exactly Alt+Shift+KeyX without Ctrl/Meta", () => {
    const base = { altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code: "KeyX" };
    expect(isXrayShortcut(base)).toBe(true);
    expect(isXrayShortcut({ ...base, code: "KeyL" })).toBe(false);
    expect(isXrayShortcut({ ...base, ctrlKey: true })).toBe(false);
    expect(isXrayShortcut({ ...base, metaKey: true })).toBe(false);
    expect(isXrayShortcut({ ...base, altKey: false })).toBe(false);
  });

  it("toggle ON mounts host; OFF unmounts and clears all paint attrs", () => {
    dom = installDom(CONV);
    const c = makeController(makeSettings());
    expect(c.isActive).toBe(false);
    c.toggle();
    expect(c.isActive).toBe(true);
    expect(dom.window.document.querySelectorAll("[data-cgl-xray-host]").length).toBe(1);
    // Paint applied to detected structures.
    expect(
      dom.window.document.querySelectorAll("[data-cgl-xray-safe-block]").length,
    ).toBe(1);
    expect(
      dom.window.document.querySelectorAll("[data-cgl-xray-assistant-turn]").length,
    ).toBe(1);
    // Toggle OFF -> everything gone.
    c.toggle();
    expect(c.isActive).toBe(false);
    expect(dom.window.document.querySelectorAll("[data-cgl-xray-host]").length).toBe(0);
    for (const attr of ALL_XRAY_PAINT_ATTRS) {
      expect(dom.window.document.querySelectorAll(`[${attr}]`).length).toBe(0);
    }
  });

  it("heartbeat exists even when NO ChatGPT structure is detectable", () => {
    dom = installDom(`<html><body><div>nothing relevant</div></body></html>`);
    const c = makeController(makeSettings());
    c.toggle();
    expect(c.isActive).toBe(true);
    expect(dom.window.document.querySelectorAll("[data-cgl-xray-host]").length).toBe(1);
    c.toggle();
    expect(dom.window.document.querySelectorAll("[data-cgl-xray-host]").length).toBe(0);
  });

  /** Click an X-Ray panel button by its visible label via the open Shadow root. */
  function pressPanelButton(label: string): void {
    const host = dom.window.document.querySelector("[data-cgl-xray-host]")!;
    const shadow = (host as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot;
    const btns = Array.from(shadow.querySelectorAll("button"));
    const target = btns.find((b) => b.textContent === label);
    if (!target) throw new Error(`panel button not found: ${label}`);
    target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  }

  it("picker captures target, swallows click, exits cleanly on Escape", () => {
    dom = installDom(CONV);
    const c = makeController(makeSettings());
    c.toggle();

    // Enter picker mode through the REAL panel button.
    pressPanelButton("Pick element");
    expect(c.isPicking).toBe(true);

    const block = dom.window.document.getElementById("wb1")!;
    const click = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(click, "target", { value: block });
    dom.window.document.dispatchEvent(click);

    expect(c.isPicking).toBe(false);
    expect(c.pickedTarget?.element).toBe(block);

    // Picked element is painted magenta.
    expect(block.hasAttribute("data-cgl-xray-picked")).toBe(true);

    // Report includes pickedTarget.
    const report = JSON.parse(c.buildReport()) as { pickedTarget: unknown };
    expect(report.pickedTarget).not.toBeNull();

    // Close cleans the picked paint too.
    c.stop();
    expect(block.hasAttribute("data-cgl-xray-picked")).toBe(false);
  });

  it("runtime handleXrayKeydown toggles even when extension disabled", async () => {
    dom = installDom(CONV);
    await setupRuntime();
    const s = makeSettings();
    s.enabled = false;
    mod.syncRuntime(s);
    await tick();
    const before = dom.window.document.querySelectorAll("[data-cgl-xray-host]").length;
    pressAltShiftX();
    await tick();
    const afterOn = dom.window.document.querySelectorAll("[data-cgl-xray-host]").length;
    expect(afterOn).toBe(before + 1);
    pressAltShiftX();
    await tick();
    expect(dom.window.document.querySelectorAll("[data-cgl-xray-host]").length).toBe(before);
  });

  // --- runtime harness -----------------------------------------------------

  let mod: typeof import("../../src/content/index.js");
  let listeners: Map<string, Set<(e: KeyboardEvent) => void>>;
  let chromeStub: unknown;

  async function setupRuntime(): Promise<void> {
    listeners = new Map();
    const doc = dom.window.document;
    doc.addEventListener = ((type: string, cb: (e: KeyboardEvent) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    }) as typeof doc.addEventListener;
    doc.removeEventListener = ((type: string, cb: (e: KeyboardEvent) => void) => {
      listeners.get(type)?.delete(cb);
    }) as typeof doc.removeEventListener;

    const settings = makeSettings();
    chromeStub = {
      storage: {
        local: {
          get: (k: string) =>
            Promise.resolve({ [k]: { schemaVersion: 3, settings } }),
          set: () => Promise.resolve(),
        },
        onChanged: { addListener: () => {} },
      },
    };
    const g = globalThis as unknown as Record<string, unknown>;
    g.MutationObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
    g.IntersectionObserver = class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    };
    g.chrome = chromeStub;
    vi.resetModules();
    mod = await import("../../src/content/index.js");
    await tick();
  }

  function tick(): Promise<void> {
    return new Promise((r) => setTimeout(r, 5));
  }

  function pressAltShiftX(): void {
    const ev = new dom.window.KeyboardEvent("keydown", {
      altKey: true,
      shiftKey: true,
      code: "KeyX",
      bubbles: true,
    });
    for (const cb of listeners.get("keydown") ?? []) cb(ev);
  }
});
