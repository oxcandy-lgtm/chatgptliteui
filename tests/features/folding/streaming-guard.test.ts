import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../../src/settings/defaults.js";
import { FoldingController } from "../../../src/features/folding/folding-controller.js";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";

/**
 * Streaming guard: a long code block inside the currently generating
 * assistant turn must NOT auto-fold; after generation ends, the next
 * reconciliation folds it normally.
 */

const LONG_CODE = Array.from({ length: 30 }, (_, i) => `line${i}();`).join("\n");

function installDom(html: string): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://chatgpt.com/c/stream",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  return dom;
}

const PAGE = (generating: boolean): string =>
  `<main role="main"><section data-testid="thread" aria-label="conversation">` +
  `<div data-message-author-role="assistant" data-testid="assistant-message" id="t1">` +
  `<pre id="stream-pre"><code>${LONG_CODE}</code></pre>` +
  `</div>` +
  (generating ? `<button aria-label="Stop generating">stop</button>` : ``) +
  `</section></main>`;

function settings() {
  const s = cloneDefaults();
  s.enabled = true;
  return s;
}

describe("streaming code guard", () => {
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

  it("streaming code stays unfolded, then folds after generation ends", () => {
    dom = installDom(PAGE(true));
    const c = new FoldingController(dom.window.document.documentElement, createAdapter());
    c.apply(settings());
    const pre = dom.window.document.getElementById("stream-pre")!;
    // Generating: no marker, and no control for the streaming code.
    expect(pre.hasAttribute("data-cgl-code-folded")).toBe(false);
    const labels = [
      ...dom.window.document
        .querySelector('[data-cgl-folding-host="true"]')!
        .shadowRoot!.querySelectorAll("button"),
    ].map((b) => b.textContent);
    expect(labels).not.toContain("Expand");

    // Generation ends (stop control gone): next reconcile folds normally.
    dom.window.document.querySelector('button[aria-label="Stop generating"]')!.remove();
    c.refresh(settings());
    expect(pre.getAttribute("data-cgl-code-folded")).toBe("true");
    c.teardown();
  });
});
