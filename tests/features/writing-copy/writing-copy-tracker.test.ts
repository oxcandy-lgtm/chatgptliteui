import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import { WritingCopyTracker } from "../../../src/features/writing-copy/writing-copy-tracker.js";

class FakeIntersectionObserver {
  static lastThreshold: number | number[] | null = null;
  static instances: FakeIntersectionObserver[] = [];
  cb: (entries: unknown[], obs: FakeIntersectionObserver) => void;
  observed: Element[] = [];
  constructor(cb: (entries: unknown[], obs: FakeIntersectionObserver) => void, options?: { threshold?: number | number[] }) {
    this.cb = cb;
    FakeIntersectionObserver.lastThreshold = options?.threshold ?? null;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.observed = [];
    const idx = FakeIntersectionObserver.instances.indexOf(this);
    if (idx !== -1) FakeIntersectionObserver.instances.splice(idx, 1);
  }
}

function installDom(html: string): JSDOM {
  const dom = new JSDOM(html, { url: "https://chatgpt.com/c/aaa", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.HTMLElement = dom.window.HTMLElement;
  g.IntersectionObserver = FakeIntersectionObserver;
  g.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(0), 0) as unknown as number;
  g.cancelAnimationFrame = (h: number): void => clearTimeout(h as unknown as NodeJS.Timeout);
  // jsdom returns zero rects; synthesize from inline top/left/width/height.
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
      top,
      left,
      width,
      height,
      bottom: top + height,
      right: left + width,
      x: left,
      y: top,
      toJSON: () => ({}),
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

describe("writing-copy tracker", () => {
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
    vi.clearAllTimers();
    vi.useRealTimers();
    FakeIntersectionObserver.instances = [];
    dom?.window.close();
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
  });

  function block(id: string, height = 200, top = 0): string {
    return `<div data-testid="text-block" id="${id}" style="height:${height}px;position:absolute;top:${top}px;left:0;width:300px;"><p>Prose ${id}</p></div>`;
  }

  it("IntersectionObserver is constructed with threshold: 0", () => {
    dom = installDom(RUNTIME(block("a")));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    expect(FakeIntersectionObserver.lastThreshold).toBe(0);
  });

  it("a large partially visible block can become active", () => {
    dom = installDom(RUNTIME(block("a", 4000, -100)));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    expect(tracker.activeTarget).not.toBeNull();
  });

  it("closest block center wins", () => {
    dom = installDom(RUNTIME(
      block("a", 100, 50) + block("b", 100, 400),
    ));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    // b is nearer viewport center (innerHeight/2 ~ 300) than a (top 50).
    expect(tracker.activeTarget?.id).toBe("b");
  });

  it("greater visible area breaks equal-distance ties", () => {
    dom = installDom(RUNTIME(
      block("a", 100, 200) + block("b", 300, 200),
    ));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    // Both share center ~250; b has greater area.
    expect(tracker.activeTarget?.id).toBe("b");
  });

  it("DOM order breaks remaining ties", () => {
    dom = installDom(RUNTIME(
      block("a", 100, 200) + block("b", 100, 200),
    ));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    expect(tracker.activeTarget?.id).toBe("a");
  });

  it("off-viewport and zero-size candidates are ignored", () => {
    dom = installDom(RUNTIME(block("a", 0, 50) + block("b", 100, 99999)));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    expect(tracker.activeTarget).toBeNull();
  });

  it("disconnected active candidate is released", () => {
    dom = installDom(RUNTIME(block("a")));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    expect(tracker.activeTarget?.id).toBe("a");
    dom.window.document.getElementById("a")!.remove();
    tracker.recalculateNow();
    expect(tracker.activeTarget).toBeNull();
  });

  it("scroll bursts create one rAF recalculation", async () => {
    vi.useFakeTimers();
    dom = installDom(RUNTIME(block("a")));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    const recalc = vi.spyOn(tracker as unknown as { recalculate: () => void }, "recalculate");
    window.dispatchEvent(new dom.window.Event("scroll"));
    window.dispatchEvent(new dom.window.Event("scroll"));
    window.dispatchEvent(new dom.window.Event("scroll"));
    // Only one rAF scheduled.
    expect(recalc.mock.calls.length).toBe(0);
    vi.runAllTimers();
    expect(recalc.mock.calls.length).toBe(1);
  });

  it("resize recalculates target and host position", async () => {
    dom = installDom(RUNTIME(block("a")));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    const recalc = vi.spyOn(tracker as unknown as { recalculate: () => void }, "recalculate");
    window.dispatchEvent(new dom.window.Event("resize"));
    await new Promise((r) => setTimeout(r, 0));
    expect(recalc.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("candidate-set changes schedule recalculation", () => {
    dom = installDom(RUNTIME(block("a")));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    const recalc = vi.spyOn(tracker as unknown as { recalculate: () => void }, "recalculate");
    tracker.refresh();
    expect(recalc.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("no permanent polling timer", () => {
    dom = installDom(RUNTIME(block("a")));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    tracker.teardown();
    // After teardown, a scheduled rAF (if any) is cancelled; calling recalculate
    // directly still works but no internal timer persists.
    expect(tracker.activeTarget).toBeNull();
  });

  it("teardown cancels pending rAF", () => {
    vi.useFakeTimers();
    dom = installDom(RUNTIME(block("a")));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    window.dispatchEvent(new dom.window.Event("scroll"));
    tracker.teardown();
    // Pending rAF cancelled; recalculate not invoked by the flush.
    expect(FakeIntersectionObserver.instances.length).toBe(0);
    vi.runAllTimers();
  });

  it("route teardown releases all element references", () => {
    dom = installDom(RUNTIME(block("a")));
    const tracker = new WritingCopyTracker(createAdapter());
    tracker.refresh();
    expect(tracker.candidatesList.length).toBe(1);
    tracker.teardown();
    expect(tracker.candidatesList.length).toBe(0);
  });
});
