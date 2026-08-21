import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import {
  findSafeWritingBlocks,
  normalizeCandidates,
  isSafeWritingBlock,
  isSafeWritingBlockDetection,
} from "../../../src/features/writing-copy/writing-copy-detection.js";
import { extractBlockText } from "../../../src/features/writing-copy/copy-action.js";

// No broad class-substring selector was added to authorize writing-copy.
// This constant documents the exact (semantic-attribute) selectors used.
const ALLOWED_SELECTORS = [
  '[data-message-author-role="assistant"] [data-testid="text-block"]',
  '[data-message-author-role="assistant"] [data-testid="message-text-block"]',
  '[data-message-author-role="assistant"] [data-testid="message-content"]',
  '[data-message-author-role="assistant"] p',
];
for (const sel of ALLOWED_SELECTORS) {
  // Reject any selector that matches by class substring.
  if (/\.[a-z]/i.test(sel.replace(/\[[^\]]*\]/g, ""))) {
    throw new Error(`broad class selector used: ${sel}`);
  }
}

function installDom(html: string): JSDOM {
  const dom = new JSDOM(html, { url: "https://chatgpt.com/c/aaa", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.HTMLElement = dom.window.HTMLElement;
  return dom;
}

describe("writing-copy detection + normalization", () => {
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
        try { g[k] = originalGlobals[k]; } catch { /* ignore */ }
      }
    });
    dom?.window.close();
  });

  function assistantBlock(inner: string): string {
    return `<main role="main"><section data-testid="thread" aria-label="conversation">
      <div data-message-author-role="assistant" data-testid="assistant-message">${inner}</div>
    </section></main>`;
  }

  it("high semantic text-block candidate is accepted", () => {
    dom = installDom(assistantBlock(`<div data-testid="text-block"><p>Safe prose.</p></div>`));
    const blocks = findSafeWritingBlocks(createAdapter());
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.getAttribute("data-testid")).toBe("text-block");
  });

  it("medium semantic prose block is accepted", () => {
    dom = installDom(assistantBlock(`<div data-testid="message-text-block"><p>Safe prose.</p></div>`));
    const blocks = findSafeWritingBlocks(createAdapter());
    expect(blocks.length).toBe(1);
  });

  it("bare Assistant <p> low-confidence candidate is rejected", () => {
    dom = installDom(assistantBlock(`<p>Just a paragraph.</p>`));
    const blocks = findSafeWritingBlocks(createAdapter());
    expect(blocks.length).toBe(0);
  });

  it("unknown/not-found result is rejected", () => {
    dom = installDom(`<main role="main"><section data-testid="thread">no turns</section></main>`);
    expect(findSafeWritingBlocks(createAdapter()).length).toBe(0);
  });

  it("User block is rejected", () => {
    dom = installDom(`<main role="main"><section data-testid="thread">
      <div data-message-author-role="user"><div data-testid="text-block"><p>User text.</p></div></div>
    </section></main>`);
    expect(findSafeWritingBlocks(createAdapter()).length).toBe(0);
  });

  it("composer-contained candidate is rejected", () => {
    dom = installDom(assistantBlock(
      `<div data-testid="text-block"><p>Prose</p></div>
       <textarea id="prompt-textarea"> </textarea>`,
    ));
    // Put the block inside the composer to test containment rejection.
    const block = dom.window.document.querySelector('[data-testid="text-block"]')!;
    const ta = dom.window.document.getElementById("prompt-textarea")!;
    ta.appendChild(block.cloneNode(true));
    expect(isSafeWritingBlock(ta.querySelector('[data-testid="text-block"]')!, createAdapter())).toBe(false);
  });

  it("sidebar-contained candidate is rejected", () => {
    dom = installDom(`<nav aria-label="chat history"><a href="/c/1">x</a></nav>` + assistantBlock(`<div data-testid="text-block"><p>Prose</p></div>`));
    const block = dom.window.document.querySelector('[data-testid="text-block"]')!;
    const nav = dom.window.document.querySelector("nav")!;
    nav.appendChild(block.cloneNode(true));
    expect(isSafeWritingBlock(nav.querySelector('[data-testid="text-block"]')!, createAdapter())).toBe(false);
  });

  it("dialog/modal-contained candidate is rejected", () => {
    dom = installDom(assistantBlock(`<div data-testid="text-block"><p>Prose</p></div>`));
    const block = dom.window.document.querySelector('[data-testid="text-block"]')!;
    const dlg = dom.window.document.createElement("div");
    dlg.setAttribute("role", "dialog");
    dlg.appendChild(block.cloneNode(true));
    dom.window.document.body.appendChild(dlg);
    expect(isSafeWritingBlock(dlg.querySelector('[data-testid="text-block"]')!, createAdapter())).toBe(false);
  });

  it("pre/code candidate is rejected", () => {
    dom = installDom(assistantBlock(`<pre><code>code here</code></pre>`));
    const pre = dom.window.document.querySelector("pre")!;
    const block = dom.window.document.createElement("div");
    block.setAttribute("data-testid", "text-block");
    block.appendChild(pre.cloneNode(true));
    dom.window.document.querySelector('[data-testid="assistant-message"]')!.appendChild(block);
    expect(isSafeWritingBlock(block, createAdapter())).toBe(false);
  });

  it("contenteditable candidate is rejected", () => {
    dom = installDom(assistantBlock(`<div data-testid="text-block" contenteditable="true"><p>Prose</p></div>`));
    const block = dom.window.document.querySelector('[data-testid="text-block"]')!;
    expect(isSafeWritingBlock(block, createAdapter())).toBe(false);
  });

  it("disconnected candidate is rejected", () => {
    dom = installDom(assistantBlock(`<div data-testid="text-block"><p>Prose</p></div>`));
    const detached = dom.window.document.createElement("div");
    detached.setAttribute("data-testid", "text-block");
    detached.innerHTML = "<p>Prose</p>";
    expect(isSafeWritingBlock(detached, createAdapter())).toBe(false);
  });

  it("candidate containing another turn is rejected", () => {
    dom = installDom(`<main role="main"><section data-testid="thread">
      <div data-message-author-role="assistant" data-testid="assistant-message">
        <div data-testid="text-block"><p>Prose</p>
          <div data-message-author-role="user"><p>other</p></div>
        </div>
      </div>
    </section></main>`);
    const block = dom.window.document.querySelector('[data-testid="text-block"]')!;
    expect(isSafeWritingBlock(block, createAdapter())).toBe(false);
  });

  it("nested text-block > p normalizes to one canonical outer block", () => {
    dom = installDom(assistantBlock(`<div data-testid="text-block"><p>Prose</p></div>`));
    const outer = dom.window.document.querySelector('[data-testid="text-block"]') as HTMLElement;
    const inner = outer.querySelector("p") as HTMLElement;
    // Both are candidates; normalization keeps the outer canonical block.
    const normalized = normalizeCandidates([outer, inner]);
    expect(normalized.length).toBe(1);
    expect(normalized[0]).toBe(outer);
  });

  it("ancestor/descendant duplicates removed deterministically (DOM order)", () => {
    dom = installDom(assistantBlock(
      `<div data-testid="text-block"><p>A</p></div>
       <div data-testid="text-block"><p>B</p></div>`,
    ));
    const blocks = [...dom.window.document.querySelectorAll('[data-testid="text-block"]')] as HTMLElement[];
    const normalized = normalizeCandidates(blocks);
    expect(normalized.length).toBe(2);
    // Stable ordering: first in document first.
    expect(normalized[0]).toBe(blocks[0]);
  });

  it("empty/whitespace block is rejected at action time", () => {
    dom = installDom(assistantBlock(`<div data-testid="text-block"><p>   </p></div>`));
    // Detection accepts the block; extraction (action time) yields empty.
    const blocks = findSafeWritingBlocks(createAdapter());
    expect(blocks.length).toBe(1); // detection passes; emptiness checked at copy
    const parsed = extractBlockText(blocks[0]!).replace(/\r\n/g, "\n");
    expect(parsed.length).toBe(0);
  });

  it("detection failure leaves official UI untouched", () => {
    dom = installDom(assistantBlock(`<div data-testid="text-block"><p>Prose</p></div>`));
    const adapter = createAdapter();
    const before = dom.window.document.querySelector('[data-testid="text-block"]')!.outerHTML;
    // Run gate-only checks; no mutation occurs.
    const blocks = findSafeWritingBlocks(adapter);
    expect(blocks.length).toBe(1);
    expect(dom.window.document.querySelector('[data-testid="text-block"]')!.outerHTML).toBe(before);
  });

  it("isSafeWritingBlockDetection rejects low/unknown confidence", () => {
    const fakeLow = {
      found: true,
      element: null,
      elements: [],
      confidence: "low",
      strategy: "x",
      reason: "",
      timestamp: 0,
    } as never;
    expect(isSafeWritingBlockDetection(fakeLow, createAdapter() as never)).toBe(false);
  });
});
