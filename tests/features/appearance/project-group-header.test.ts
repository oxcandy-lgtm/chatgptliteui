import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { deriveProjectGroupHeader } from "../../../src/features/appearance/sidebar-chat-colors.js";

/**
 * Targeted fallback-header case: header + two child chats, no direct
 * `/g/<id>` folder anchor. The header precedes the first child, so the
 * fallback surface must be the header (DOM-order direction regression).
 */

function installDom(): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <nav aria-label="Chat history">
        <div id="group">
          <button id="folder" style="position:absolute;top:10px;left:8px;width:240px;height:40px;">timealgo</button>
          <div><a id="chat-a" href="/g/g-p-1/c/AAA">chat a</a></div>
          <div><a id="chat-b" href="/g/g-p-1/c/BBB">chat b</a></div>
        </div>
      </nav>
    </body></html>`,
    { url: "https://chatgpt.com/g/g-p-1/c/AAA", pretendToBeVisual: true },
  );
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.HTMLElement = dom.window.HTMLElement;
  // jsdom returns zero rects; synthesize from inline geometry.
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
  Object.defineProperty(dom.window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  return dom;
}

describe("project group header fallback", () => {
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
        try { delete g[k]; } catch { /* ignore */ }
      } else {
        try { g[k] = originalGlobals[k]; } catch { /* ignore */ }
      }
    });
    dom?.window.close();
  });

  it("selects the header preceding the first child chat", () => {
    dom = installDom();
    const noForeign = () => false;
    const header = dom.window.document.getElementById("folder")!;
    const chatA = dom.window.document.getElementById("chat-a") as unknown as HTMLAnchorElement;
    const chatB = dom.window.document.getElementById("chat-b") as unknown as HTMLAnchorElement;
    // Sanity: anchors lack geometry in this fixture, so style them measurable.
    for (const a of [chatA, chatB]) {
      (a as unknown as HTMLElement).style.cssText =
        "position:absolute;top:60px;left:8px;width:240px;height:36px;";
    }
    chatB.style.top = "100px";
    const surface = deriveProjectGroupHeader([chatA, chatB], noForeign, noForeign);
    expect(surface).toBe(header);
  });

  it("selects a preceding-sibling folder header outside the child container", () => {
    dom = new JSDOM(
      `<!doctype html><html><body>
        <nav aria-label="Chat history">
          <div id="folder" style="position:absolute;top:10px;left:8px;width:240px;height:40px;">timealgo</div>
          <div id="children">
            <div><a id="chat-a" href="/g/g-p-1/c/AAA" style="position:absolute;top:60px;left:8px;width:240px;height:36px;">chat a</a></div>
            <div><a id="chat-b" href="/g/g-p-1/c/BBB" style="position:absolute;top:100px;left:8px;width:240px;height:36px;">chat b</a></div>
          </div>
        </nav>
      </body></html>`,
      { url: "https://chatgpt.com/g/g-p-1/c/AAA", pretendToBeVisual: true },
    );
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.Node = dom.window.Node;
    g.HTMLElement = dom.window.HTMLElement;
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
    Object.defineProperty(dom.window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
    const noForeign = () => false;
    const header = dom.window.document.getElementById("folder")!;
    const chatA = dom.window.document.getElementById("chat-a") as unknown as HTMLAnchorElement;
    const chatB = dom.window.document.getElementById("chat-b") as unknown as HTMLAnchorElement;
    const surface = deriveProjectGroupHeader([chatA, chatB], noForeign, noForeign);
    expect(surface).toBe(header);
  });
});
