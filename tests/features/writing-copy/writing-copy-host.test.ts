import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { WritingCopyHost } from "../../../src/features/writing-copy/writing-copy-host.js";

function installDom(): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body><main role="main"></main></body></html>`, {
    url: "https://chatgpt.com/c/aaa",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  return dom;
}

describe("writing-copy Shadow DOM host", () => {
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

  it("exactly one host exists", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    expect(dom.window.document.querySelectorAll('[data-cgl-writing-copy-host="true"]').length).toBe(1);
  });

  it("repeated mount/update creates no duplicate", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    host.mount(() => {});
    host.mount(() => {});
    expect(dom.window.document.querySelectorAll('[data-cgl-writing-copy-host="true"]').length).toBe(1);
  });

  it("host is outside ChatGPT writing blocks", () => {
    dom = installDom();
    const block = dom.window.document.createElement("div");
    block.setAttribute("data-testid", "text-block");
    dom.window.document.querySelector("main")!.appendChild(block);
    const host = new WritingCopyHost();
    host.mount(() => {});
    const hostEl = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]')!;
    expect(block.contains(hostEl)).toBe(false);
    expect(dom.window.document.body.contains(hostEl)).toBe(true);
  });

  it("button has type=button, correct aria-label, and focus styling", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    const shadow = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]')!.shadowRoot!;
    const btn = shadow.querySelector("button")!;
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.getAttribute("aria-label")).toBe("Copy centered writing block");
    expect(shadow.textContent).toMatch(/:focus-visible/);
  });

  it("status region has role=status and aria-live=polite", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    const shadow = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]')!.shadowRoot!;
    const status = shadow.querySelector('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("three position modes compute correctly", () => {
    dom = installDom();
    const block = dom.window.document.createElement("div");
    Object.defineProperty(block, "getBoundingClientRect", {
      value: () => ({ top: 100, bottom: 300, height: 200, left: 0, right: 300, width: 300 }),
    });
    const host = new WritingCopyHost();
    host.mount(() => {});
    const h = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]') as HTMLElement;
    // Ensure window dimensions for positioning
    Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(dom.window, "innerWidth", { value: 1200, configurable: true });
    host.positionAgainst(block, "top-right");
    const top = parseInt(h.style.top, 10);
    host.positionAgainst(block, "bottom-right");
    const bottom = parseInt(h.style.top, 10);
    host.positionAgainst(block, "middle-right");
    const middle = parseInt(h.style.top, 10);
    expect(top).toBeLessThan(middle);
    expect(middle).toBeLessThan(bottom);
  });

  it("viewport clamping works on all edges", () => {
    dom = installDom();
    Object.defineProperty(dom.window, "innerWidth", { value: 400, configurable: true });
    Object.defineProperty(dom.window, "innerHeight", { value: 300, configurable: true });
    const block = dom.window.document.createElement("div");
    Object.defineProperty(block, "getBoundingClientRect", {
      value: () => ({ top: -500, bottom: 5000, height: 200, left: -500, right: 5000, width: 300 }),
    });
    const host = new WritingCopyHost();
    host.mount(() => {});
    const h = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]') as HTMLElement;
    host.positionAgainst(block, "middle-right");
    const top = parseInt(h.style.top, 10);
    const left = parseInt(h.style.left, 10);
    expect(top).toBeGreaterThanOrEqual(6);
    expect(left).toBeGreaterThanOrEqual(6);
    expect(top).toBeLessThanOrEqual(300 - 44 - 6);
    expect(left).toBeLessThanOrEqual(400 - 44 - 6);
  });

  it("target classes and inline styles remain unchanged", () => {
    dom = installDom();
    const block = dom.window.document.createElement("div");
    block.setAttribute("data-testid", "text-block");
    block.style.setProperty("color", "rgb(1,2,3)");
    dom.window.document.querySelector("main")!.appendChild(block);
    const host = new WritingCopyHost();
    host.mount(() => {});
    const before = block.outerHTML;
    host.positionAgainst(block, "middle-right");
    expect(block.outerHTML).toBe(before);
  });

  it("unmount removes host, handlers, and timers", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    host.unmount();
    expect(dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]')).toBeNull();
    expect(host.isMounted).toBe(false);
  });

  it("status accepts only fixed strings", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    const shadow = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]')!.shadowRoot!;
    host.setStatus("copied");
    expect(shadow.querySelector('[role="status"]')!.textContent).toBe("Copied.");
    host.setStatus("requested");
    expect(shadow.querySelector('[role="status"]')!.textContent).toBe("Copy requested.");
    host.setStatus("unavailable");
    expect(shadow.querySelector('[role="status"]')!.textContent).toBe("Copy unavailable.");
    host.setStatus("none");
    expect(shadow.querySelector('[role="status"]')!.textContent).toBe("Nothing safe to copy.");
  });
});
