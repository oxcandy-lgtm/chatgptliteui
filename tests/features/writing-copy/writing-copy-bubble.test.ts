import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  WritingCopyHost,
  COPY_BUBBLE_PX,
  INITIAL_ROW_OFFSET_PX,
  SUCCESS_FEEDBACK_MS,
} from "../../../src/features/writing-copy/writing-copy-host.js";
import { XrayHost } from "../../../src/features/maintenance/xray-host.js";

/**
 * Draggable circular copy bubble.
 *
 * Contract: one 44px true-circle bubble with an inline SVG copy icon (no
 * visible "Copy" text), one invisible upper-right drag hit-zone (hover
 * affordance is the `move` cursor alone), session-local manual offset added
 * to the smart position and clamped onscreen, and a z-layer strictly above
 * the normal X-Ray panel.
 */

function installDom(): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body><main role="main"></main></body></html>`, {
    url: "https://chatgpt.com/c/bubble",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  Object.defineProperty(dom.window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  return dom;
}

function blockWith(rect: { top: number; left: number; width: number; height: number }, dom: JSDOM): HTMLElement {
  const el = dom.window.document.createElement("div");
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      top: rect.top, left: rect.left, width: rect.width, height: rect.height,
      bottom: rect.top + rect.height, right: rect.left + rect.width,
      x: rect.left, y: rect.top, toJSON: () => ({}),
    }),
    configurable: true,
  });
  return el;
}

function shadowOf(dom: JSDOM): ShadowRoot {
  return dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]')!.shadowRoot!;
}

function styleText(dom: JSDOM): string {
  return shadowOf(dom).querySelector("style")!.textContent ?? "";
}

/** jsdom has no PointerEvent constructor; a MouseEvent of the same type carries clientX/Y. */
function pointerEvent(dom: JSDOM, type: string, x: number, y: number): Event {
  return new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
}

describe("draggable copy bubble", () => {
  let dom: JSDOM;
  let originalGlobals: Record<string, unknown>;
  beforeEach(() => {
    originalGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      HTMLElement: globalThis.HTMLElement,
      Element: globalThis.Element,
      Node: globalThis.Node,
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

  it("bubble is a 44px true circle with no visible Copy text", () => {
    dom = installDom();
    new WritingCopyHost().mount(() => {});
    expect(COPY_BUBBLE_PX).toBe(44);
    const css = styleText(dom);
    expect(css).toContain(".cgl-copy-bubble");
    expect(css).toContain("width: 44px");
    expect(css).toContain("height: 44px");
    expect(css).toContain("border-radius: 50%");
    expect(css).toContain("padding: 0");
    expect(css).toContain("place-items: center");
    const btn = shadowOf(dom).querySelector("button")!;
    expect(btn.textContent).toBe("");
  });

  it("bubble carries one inline SVG copy icon and keeps its aria-label", () => {
    dom = installDom();
    new WritingCopyHost().mount(() => {});
    const btn = shadowOf(dom).querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("Copy centered writing block");
    const svgs = btn.querySelectorAll("svg");
    expect(svgs.length).toBe(1);
    expect(svgs[0]!.getAttribute("aria-hidden")).toBe("true");
    const css = styleText(dom);
    expect(css).toContain("width: 21px");
    // Icon carries geometry only — never copied content.
    expect(btn.textContent).toBe("");
  });

  it("exactly one invisible upper-right drag hit-zone exists with move cursor", () => {
    dom = installDom();
    new WritingCopyHost().mount(() => {});
    const handles = shadowOf(dom).querySelectorAll(".cgl-drag-handle");
    expect(handles.length).toBe(1);
    expect(handles[0]!.getAttribute("aria-label")).toBe("Move copy button");
    const css = styleText(dom);
    expect(css).toContain("top: -4px");
    expect(css).toContain("right: -4px");
    expect(css).toContain("width: 16px");
    expect(css).toContain("height: 16px");
    // No permanent decoration: fully transparent, no dots/nub/border.
    expect(css).toContain("background: transparent");
    expect(css).toContain("background-image: none");
    expect(css).toContain("opacity: 0");
    expect(css).not.toContain("radial-gradient");
    // Hover/drag affordance is the cursor alone.
    expect(css).toContain("cursor: move");
    expect(css).not.toContain("grab");
  });

  it("status region stays accessibility-only (visually hidden, live region intact)", () => {
    dom = installDom();
    new WritingCopyHost().mount(() => {});
    const status = shadowOf(dom).querySelector('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.classList.contains("cgl-visually-hidden")).toBe(true);
  });

  it("pointer drag on the handle moves the bubble (smart + offset)", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    const block = blockWith({ top: 100, left: 0, width: 300, height: 200 }, dom);
    host.positionAgainst(block, "smart");
    const el = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]') as HTMLElement;
    expect(el.style.left).toBe("306px");
    expect(el.style.top).toBe("132px");

    const handle = shadowOf(dom).querySelector(".cgl-drag-handle")!;
    handle.dispatchEvent(pointerEvent(dom, "pointerdown", 500, 500));
    handle.dispatchEvent(pointerEvent(dom, "pointermove", 540, 530));
    handle.dispatchEvent(pointerEvent(dom, "pointerup", 540, 530));

    expect(el.style.left).toBe("346px");
    expect(el.style.top).toBe("162px");
    expect(host.dragOffset).toEqual({ x: 40, y: 30 });
  });

  it("drag far beyond every edge keeps the full circle inside the viewport", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    host.positionAgainst(blockWith({ top: 100, left: 0, width: 300, height: 200 }, dom), "smart");
    const el = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]') as HTMLElement;
    const handle = shadowOf(dom).querySelector(".cgl-drag-handle")!;

    handle.dispatchEvent(pointerEvent(dom, "pointerdown", 500, 500));
    handle.dispatchEvent(pointerEvent(dom, "pointermove", 9000, 9000));
    handle.dispatchEvent(pointerEvent(dom, "pointerup", 9000, 9000));
    expect(parseInt(el.style.left, 10)).toBe(1000 - 44 - 6);
    expect(parseInt(el.style.top, 10)).toBe(800 - 44 - 6);

    handle.dispatchEvent(pointerEvent(dom, "pointerdown", 500, 500));
    handle.dispatchEvent(pointerEvent(dom, "pointermove", -9000, -9000));
    handle.dispatchEvent(pointerEvent(dom, "pointerup", -9000, -9000));
    expect(parseInt(el.style.left, 10)).toBe(6);
    expect(parseInt(el.style.top, 10)).toBe(6);
  });

  it("dragging the handle never copies; clicking the bubble copies once", () => {
    dom = installDom();
    let copies = 0;
    const host = new WritingCopyHost();
    host.mount(() => { copies++; });
    host.positionAgainst(blockWith({ top: 100, left: 0, width: 300, height: 200 }, dom), "smart");
    const handle = shadowOf(dom).querySelector(".cgl-drag-handle")!;
    handle.dispatchEvent(pointerEvent(dom, "pointerdown", 500, 500));
    handle.dispatchEvent(pointerEvent(dom, "pointermove", 560, 560));
    handle.dispatchEvent(pointerEvent(dom, "pointerup", 560, 560));
    expect(copies).toBe(0);

    const btn = shadowOf(dom).querySelector("button") as HTMLButtonElement;
    btn.click();
    expect(copies).toBe(1);
  });

  it("manual offset survives repositioning against another WritingBlock", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    host.positionAgainst(blockWith({ top: 100, left: 0, width: 300, height: 200 }, dom), "smart");
    const handle = shadowOf(dom).querySelector(".cgl-drag-handle")!;
    handle.dispatchEvent(pointerEvent(dom, "pointerdown", 500, 500));
    handle.dispatchEvent(pointerEvent(dom, "pointermove", 540, 530));
    handle.dispatchEvent(pointerEvent(dom, "pointerup", 540, 530));
    expect(host.dragOffset).toEqual({ x: 40, y: 30 });

    // Viewport position lock: a later smart call against another block does
    // NOT re-anchor — the locked position and the manual offset both survive.
    host.positionAgainst(blockWith({ top: 400, left: 200, width: 400, height: 200 }, dom), "smart");
    const el = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]') as HTMLElement;
    expect(el.style.left).toBe(`${300 + 6 + 40}px`);
    expect(el.style.top).toBe(`${132 + 30}px`);
    expect(host.dragOffset).toEqual({ x: 40, y: 30 });
  });

  it("teardown releases drag state, listeners, and DOM", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    host.positionAgainst(blockWith({ top: 100, left: 0, width: 300, height: 200 }, dom), "smart");
    const handle = shadowOf(dom).querySelector(".cgl-drag-handle")!;
    handle.dispatchEvent(pointerEvent(dom, "pointerdown", 500, 500));
    host.unmount();
    expect(dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]')).toBeNull();
    expect(host.isMounted).toBe(false);
    expect(host.dragOffset).toEqual({ x: 0, y: 0 });
    // Late pointerup after teardown is a harmless no-op.
    handle.dispatchEvent(pointerEvent(dom, "pointerup", 500, 500));
    // Fresh mount starts with zero offset.
    let copies = 0;
    host.mount(() => { copies++; });
    expect(host.dragOffset).toEqual({ x: 0, y: 0 });
    expect(dom.window.document.querySelectorAll('[data-cgl-writing-copy-host="true"]').length).toBe(1);
    expect(copies).toBe(0);
  });

  it("copy bubble layers strictly above the normal X-Ray panel", () => {
    dom = installDom();
    new WritingCopyHost().mount(() => {});
    new XrayHost().mount({ refresh: () => {}, pick: () => {}, copy: () => {}, deep: () => {}, close: () => {} });
    const copyCss = styleText(dom);
    const xrayCss =
      dom.window.document.querySelector('[data-cgl-xray-host="true"]')!.shadowRoot!.querySelector("style")!.textContent ?? "";
    const copyZ = /:host\s*{[^}]*z-index:\s*(\d+)/.exec(copyCss)?.[1];
    const panelZ = /\.xray-panel\s*{[^}]*z-index:\s*(\d+)/.exec(xrayCss)?.[1];
    expect(copyZ).toBeDefined();
    expect(panelZ).toBeDefined();
    expect(Number(copyZ)).toBeGreaterThan(Number(panelZ));
  });

  it("smart base is a fixed viewport slot, independent of block geometry", () => {
    expect(INITIAL_ROW_OFFSET_PX).toBe(3 * COPY_BUBBLE_PX);
    dom = installDom();
    const firstPlacement = (rect: { top: number; left: number; width: number; height: number }): HTMLElement => {
      const host = new WritingCopyHost();
      host.mount(() => {});
      host.positionAgainst(blockWith(rect, dom), "smart");
      const el = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]') as HTMLElement;
      host.unmount();
      return el;
    };
    // Same right edge, wildly different tops/heights -> identical Y slot.
    // (864/4520 mirrors the real bottom-of-viewport failure case.)
    let el = firstPlacement({ top: 100, left: 500, width: 300, height: 200 });
    expect(el.style.left).toBe("806px");
    expect(el.style.top).toBe("132px");
    el = firstPlacement({ top: 100, left: 500, width: 300, height: 2000 });
    expect(el.style.left).toBe("806px");
    expect(el.style.top).toBe("132px");
    el = firstPlacement({ top: 864, left: 500, width: 300, height: 4520 });
    expect(el.style.left).toBe("806px");
    expect(el.style.top).toBe("132px");
  });

  it("manual offset survives reposition and viewport resize", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    const el = dom.window.document.querySelector('[data-cgl-writing-copy-host="true"]') as HTMLElement;
    host.positionAgainst(blockWith({ top: 100, left: 0, width: 300, height: 200 }, dom), "smart");
    const handle = shadowOf(dom).querySelector(".cgl-drag-handle")!;
    handle.dispatchEvent(pointerEvent(dom, "pointerdown", 500, 500));
    handle.dispatchEvent(pointerEvent(dom, "pointermove", 520, 510));
    handle.dispatchEvent(pointerEvent(dom, "pointerup", 520, 510));
    expect(host.dragOffset).toEqual({ x: 20, y: 10 });

    // Geometry recalculation keeps the offset.
    host.positionAgainst(blockWith({ top: 100, left: 0, width: 300, height: 200 }, dom), "smart");
    expect(el.style.left).toBe(`${300 + 6 + 20}px`);
    expect(el.style.top).toBe(`${132 + 10}px`);

    // Viewport resize re-clamps but preserves the offset.
    Object.defineProperty(dom.window, "innerWidth", { value: 612, configurable: true });
    host.positionAgainst(blockWith({ top: 100, left: 0, width: 300, height: 200 }, dom), "smart");
    expect(host.dragOffset).toEqual({ x: 20, y: 10 });
    expect(parseInt(el.style.left, 10)).toBeLessThanOrEqual(612 - 44 - 6);
    expect(parseInt(el.style.left, 10)).toBeGreaterThanOrEqual(6);
  });

  it("press contract: only the central bubble scales, with reduced-motion guard", () => {
    dom = installDom();
    new WritingCopyHost().mount(() => {});
    const css = styleText(dom);
    expect(css).toMatch(/\.cgl-copy-bubble:active\s*{[^}]*scale\(0\.88\)/);
    expect(css).toContain("prefers-reduced-motion");
    // The drag zone must not receive the press transform.
    const handleRules = [...css.matchAll(/\.cgl-drag-handle[^{]*{[^}]*}/g)].join(" ");
    expect(handleRules).not.toContain("transform");
    expect(handleRules).not.toContain("scale");
  });

  it("copied status shows a check for ~900ms, then restores the copy icon", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    expect(SUCCESS_FEEDBACK_MS).toBe(900);
    vi.useFakeTimers();
    try {
      const btn = () => shadowOf(dom).querySelector("button")!;
      expect(btn().querySelector(".cgl-copy-icon")).not.toBeNull();
      host.setStatus("copied");
      expect(host.isSuccessVisible).toBe(true);
      expect(btn().querySelector(".cgl-check-icon")).not.toBeNull();
      expect(btn().querySelector(".cgl-copy-icon")).toBeNull();
      // Geometry unchanged during feedback.
      const css = styleText(dom);
      expect(css).toContain("width: 44px");

      vi.advanceTimersByTime(899);
      expect(host.isSuccessVisible).toBe(true);
      vi.advanceTimersByTime(1);
      expect(host.isSuccessVisible).toBe(false);
      expect(btn().querySelector(".cgl-copy-icon")).not.toBeNull();
      expect(btn().querySelector(".cgl-check-icon")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("non-copied statuses never show the success check", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    vi.useFakeTimers();
    try {
      host.setStatus("unavailable");
      expect(host.isSuccessVisible).toBe(false);
      expect(shadowOf(dom).querySelector("button")!.querySelector(".cgl-check-icon")).toBeNull();
      host.setStatus("requested");
      expect(host.isSuccessVisible).toBe(false);
      host.setStatus("idle");
      expect(host.isSuccessVisible).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("success timer is cleared on unmount with no retained refs", () => {
    dom = installDom();
    const host = new WritingCopyHost();
    host.mount(() => {});
    vi.useFakeTimers();
    try {
      host.setStatus("copied");
      expect(host.isSuccessVisible).toBe(true);
      host.unmount();
      expect(host.isMounted).toBe(false);
      expect(host.isSuccessVisible).toBe(false);
      vi.advanceTimersByTime(5000);
      // Fresh mount restores the normal icon with no pending timer.
      host.mount(() => {});
      const btn = shadowOf(dom).querySelector("button")!;
      expect(btn.querySelector(".cgl-copy-icon")).not.toBeNull();
      expect(btn.querySelector(".cgl-check-icon")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
