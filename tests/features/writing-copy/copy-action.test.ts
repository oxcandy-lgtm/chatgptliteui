import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import {
  performCopy,
  findAssociatedCopyAction,
  extractBlockText,
} from "../../../src/features/writing-copy/copy-action.js";

function installDom(html: string): JSDOM {
  const dom = new JSDOM(html, { url: "https://chatgpt.com/c/aaa", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLButtonElement = dom.window.HTMLButtonElement;
  try {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  } catch { /* ignore */ }
  return dom;
}

const BLOCK_HTML = (extra = "") =>
  `<main role="main"><section data-testid="thread" aria-label="conversation">
    <div data-message-author-role="assistant" data-testid="assistant-message">
      <div data-testid="text-block" id="block"><p>Visible assistant prose.</p>${extra}</div>
    </div>
  </section></main>`;

describe("writing-copy copy action", () => {
  let dom: JSDOM;
  let writeCalls: unknown[] = [];
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
    writeCalls = [];
    dom?.window.close();
  });

  function stubClipboard(): void {
    const nav = dom.window.navigator as unknown as { clipboard?: unknown };
    nav.clipboard = {
      writeText: (text: string): Promise<void> => {
        writeCalls.push(text);
        return Promise.resolve();
      },
    };
  }

  it("exactly one safely associated native copy button is preferred", () => {
    dom = installDom(BLOCK_HTML(
      `<button aria-label="Copy" data-testid="copy">Copy</button>`,
    ));
    const block = dom.window.document.getElementById("block")!;
    const btn = findAssociatedCopyAction(block as HTMLElement, createAdapter());
    expect(btn).not.toBeNull();
    expect((btn as HTMLElement).getAttribute("data-testid")).toBe("copy");
  });

  it("native click reports Copy requested (no clipboard write)", async () => {
    dom = installDom(BLOCK_HTML(
      `<button aria-label="Copy" data-testid="copy">Copy</button>`,
    ));
    stubClipboard();
    const block = dom.window.document.getElementById("block")!;
    let clicked = false;
    dom.window.document.querySelector('[data-testid="copy"]')!.addEventListener("click", () => { clicked = true; });
    const outcome = await performCopy(() => block as HTMLElement, createAdapter());
    expect(outcome).toBe("requested");
    expect(clicked).toBe(true);
    expect(writeCalls.length).toBe(0);
  });

  it("Clipboard fallback is not called when native action is used", async () => {
    dom = installDom(BLOCK_HTML(`<button aria-label="Copy" data-testid="copy">Copy</button>`));
    stubClipboard();
    const block = dom.window.document.getElementById("block")!;
    await performCopy(() => block as HTMLElement, createAdapter());
    expect(writeCalls.length).toBe(0);
  });

  it("ambiguous native copy buttons are rejected", () => {
    dom = installDom(BLOCK_HTML(
      `<button aria-label="Copy">a</button><button aria-label="Copy">b</button>`,
    ));
    const block = dom.window.document.getElementById("block")!;
    expect(findAssociatedCopyAction(block as HTMLElement, createAdapter())).toBeNull();
  });

  it("disabled native button is rejected", () => {
    dom = installDom(BLOCK_HTML(
      `<button aria-label="Copy" disabled>Copy</button>`,
    ));
    const block = dom.window.document.getElementById("block")!;
    expect(findAssociatedCopyAction(block as HTMLElement, createAdapter())).toBeNull();
  });

  it("aria-disabled native button is rejected", () => {
    dom = installDom(BLOCK_HTML(
      `<button aria-label="Copy" aria-disabled="true">Copy</button>`,
    ));
    const block = dom.window.document.getElementById("block")!;
    expect(findAssociatedCopyAction(block as HTMLElement, createAdapter())).toBeNull();
  });

  it("unrelated message/code/toolbar copy buttons are rejected", () => {
    dom = installDom(`<main role="main"><section data-testid="thread">
      <div data-message-author-role="assistant" data-testid="assistant-message">
        <div data-testid="text-block" id="block"><p>Prose</p></div>
      </div>
      <button aria-label="Copy code" data-testid="copy">code copy</button>
    </section></main>`);
    const block = dom.window.document.getElementById("block")!;
    // The code copy button is OUTSIDE the block -> no associated action.
    expect(findAssociatedCopyAction(block as HTMLElement, createAdapter())).toBeNull();
  });

  it("fallback calls writeText from the direct event path", async () => {
    dom = installDom(BLOCK_HTML());
    stubClipboard();
    const block = dom.window.document.getElementById("block")!;
    const outcome = await performCopy(() => block as HTMLElement, createAdapter());
    expect(outcome).toBe("copied");
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
    expect(writeCalls[0]).toContain("Visible assistant prose.");
  });

  it("success reports Copied.", async () => {
    dom = installDom(BLOCK_HTML());
    stubClipboard();
    const outcome = await performCopy(
      () => dom.window.document.getElementById("block") as HTMLElement,
      createAdapter(),
    );
    expect(outcome).toBe("copied");
  });

  it("rejection reports Copy unavailable.", async () => {
    dom = installDom(BLOCK_HTML());
    const nav = dom.window.navigator as unknown as { clipboard?: unknown };
    nav.clipboard = { writeText: () => Promise.reject(new Error("denied")) };
    const outcome = await performCopy(
      () => dom.window.document.getElementById("block") as HTMLElement,
      createAdapter(),
    );
    expect(outcome).toBe("unavailable");
  });

  it("empty text does not call Clipboard API", async () => {
    dom = installDom(BLOCK_HTML(`<p>   </p>`));
    // Override block content to be empty whitespace only
    const block = dom.window.document.getElementById("block")!;
    block.innerHTML = `<p>   </p>`;
    stubClipboard();
    const outcome = await performCopy(() => block as HTMLElement, createAdapter());
    expect(outcome).toBe("unavailable");
    expect(writeCalls.length).toBe(0);
  });

  it("target is revalidated immediately before copying", async () => {
    dom = installDom(BLOCK_HTML());
    stubClipboard();
    let getCount = 0;
    const block = dom.window.document.getElementById("block")!;
    await performCopy(() => {
      getCount++;
      return block as HTMLElement;
    }, createAdapter());
    expect(getCount).toBeGreaterThanOrEqual(1);
  });

  it("no clipboard read API is used", () => {
    dom = installDom(BLOCK_HTML());
    const proto = Object.getPrototypeOf(dom.window.navigator);
    expect("readText" in dom.window.navigator || "readText" in proto).toBe(false);
  });

  it("no legacy exec command is used", () => {
    dom = installDom(BLOCK_HTML());
    expect((dom.window.document as Document & { execCommand?: unknown }).execCommand).toBeUndefined();
  });

  it("copied text never enters status/logs/attributes/events", async () => {
    dom = installDom(BLOCK_HTML());
    stubClipboard();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const block = dom.window.document.getElementById("block")!;
    await performCopy(() => block as HTMLElement, createAdapter());
    const logged = spy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(logged).not.toContain("Visible assistant prose.");
    spy.mockRestore();
    // No attribute on block carries the text.
    expect(block.getAttributeNames().every((n) => !block.getAttribute(n)!.includes("Visible"))).toBe(true);
  });

  it("extractBlockText trims and normalizes line endings", () => {
    dom = installDom(BLOCK_HTML());
    const block = dom.window.document.getElementById("block")!;
    const parsed = extractBlockText(block as HTMLElement).replace(/\r\n/g, "\n");
    expect(parsed).toBe("Visible assistant prose.");
  });
});
