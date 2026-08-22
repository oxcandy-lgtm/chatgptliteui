import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import {
  WRITING_FALLBACK_STRATEGY_ID,
  inferWritingBlocksFromEditorAnchors,
} from "../../../src/adapters/chatgpt-adapter.js";
import {
  findSafeWritingBlocks,
  evaluateWritingBlockCandidate,
  isProvenWritingBlockEditor,
  isSafeWritingBlock,
} from "../../../src/features/writing-copy/writing-copy-detection.js";

/**
 * Structural `writing-block-editor-anchored` WritingBlock detection.
 *
 * Fixture shape mirrors the REAL observed current ChatGPT structure:
 * an Assistant turn containing a WritingBlock header anchor
 * (`button[data-testid="writing-block-header-magic-edit-button"]`), a
 * structural wrapper, and ONE `div[contenteditable="true"]` editor holding
 * child paragraphs; header toolbar OUTSIDE the editor.
 */

function writingTurn(id: string): string {
  return (
    `<div data-message-author-role="assistant" data-testid="assistant-message" id="${id}">` +
    `<p>Ordinary prose paragraph one.</p>` +
    `<div class="writing-region">` +
    `<div class="writing-header"><button data-testid="writing-block-header-magic-edit-button">HEADER_LABEL_XYZ</button>` +
    `<button aria-label="Copy">TOOLBAR_LABEL_QRS</button></div>` +
    `<div contenteditable="true" class="editor">` +
    `<p>Editor payload line alpha.</p>` +
    `<p>Editor payload line beta.</p>` +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

const PAGE = (turns: string[]): string =>
  `<main role="main"><section data-testid="thread" aria-label="conversation">${turns.join("")}</section></main>`;

function installDom(html: string): JSDOM {
  const dom = new JSDOM(html, { url: "https://chatgpt.com/c/tok", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.HTMLElement = dom.window.HTMLElement;
  return dom;
}

describe("adapter structural writing-block editor pairing", () => {
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

  it("pairs the anchor to exactly the EDITOR element (not the wrapper)", () => {
    dom = installDom(PAGE([writingTurn("t1"), writingTurn("t2"), writingTurn("t3")]));
    const adapter = createAdapter();
    const container = adapter.detectConversationContainer().element!;
    const result = adapter.detectWritingBlocks(container);
    expect(result.found).toBe(true);
    expect(result.strategy).toBe(WRITING_FALLBACK_STRATEGY_ID);
    expect(result.confidence).toBe("high");
    expect(result.elements).toHaveLength(3);
    for (const el of result.elements) {
      expect(el.getAttribute("contenteditable")).toBe("true");
      expect(el.classList.contains("editor")).toBe(true);
    }

    const diag = inferWritingBlocksFromEditorAnchors(container).diagnostic;
    expect(diag.attempted).toBe(true);
    expect(diag.found).toBe(true);
    expect(diag.strategyId).toBe(WRITING_FALLBACK_STRATEGY_ID);
    expect(diag.confidence).toBe("high");
    expect(diag.assistantTurnsScanned).toBe(3);
    expect(diag.headerAnchorCount).toBe(3);
    expect(diag.contentEditableCount).toBe(3);
    expect(diag.pairCount).toBe(3);
    expect(diag.ambiguousCount).toBe(0);
  });

  it("supports TWO separate WritingBlocks in ONE Assistant turn", () => {
    dom = installDom(PAGE([
      `<div data-message-author-role="assistant" id="t1">
         <div class="wb-a">
           <button data-testid="writing-block-header-magic-edit-button"></button>
           <div contenteditable="true" id="ed-a"><p>A</p></div>
         </div>
         <div class="wb-b">
           <button data-testid="writing-block-header-magic-edit-button"></button>
           <div contenteditable="true" id="ed-b"><p>B</p></div>
         </div>
       </div>`,
    ]));
    const adapter = createAdapter();
    const container = adapter.detectConversationContainer().element!;
    const result = adapter.detectWritingBlocks(container);
    expect(result.found).toBe(true);
    expect(result.elements.map((e) => e.id).sort()).toEqual(["ed-a", "ed-b"]);
  });

  it("GENERIC EDITOR negative: contenteditable without an anchor finds nothing", () => {
    dom = installDom(PAGE([
      `<div data-message-author-role="assistant" id="t1">
         <div contenteditable="true"><p>No anchor here.</p></div>
       </div>`,
    ]));
    const adapter = createAdapter();
    const container = adapter.detectConversationContainer().element!;
    const result = adapter.detectWritingBlocks(container);
    expect(result.found).toBe(false);
    const diag = inferWritingBlocksFromEditorAnchors(container).diagnostic;
    expect(diag.rejectionReason).toBe("NO_HEADER_ANCHOR");
    expect(findSafeWritingBlocks(adapter)).toHaveLength(0);
  });

  it("ORDINARY PROSE negative: plain paragraphs find nothing", () => {
    dom = installDom(PAGE([
      `<div data-message-author-role="assistant" id="t1"><p>plain</p></div>`,
      `<div data-message-author-role="assistant" id="t2"><p>plain</p></div>`,
      `<div data-message-author-role="assistant" id="t3"><p>plain</p></div>`,
    ]));
    const adapter = createAdapter();
    const container = adapter.detectConversationContainer().element!;
    expect(adapter.detectWritingBlocks(container).found).toBe(false);
    const diag = inferWritingBlocksFromEditorAnchors(container).diagnostic;
    expect(diag.headerAnchorCount).toBe(0);
    expect(diag.rejectionReason).toBe("NO_HEADER_ANCHOR");
    expect(findSafeWritingBlocks(adapter)).toHaveLength(0);
  });

  it("AMBIGUOUS negative: one anchor over a two-editor region fails closed", () => {
    dom = installDom(PAGE([
      `<div data-message-author-role="assistant" id="t1">
         <div class="region">
           <button data-testid="writing-block-header-magic-edit-button"></button>
           <div contenteditable="true" id="e1"><p>one</p></div>
           <div contenteditable="true" id="e2"><p>two</p></div>
         </div>
       </div>`,
    ]));
    const adapter = createAdapter();
    const container = adapter.detectConversationContainer().element!;
    expect(adapter.detectWritingBlocks(container).found).toBe(false);
    const diag = inferWritingBlocksFromEditorAnchors(container).diagnostic;
    expect(diag.ambiguousCount).toBe(1);
    expect(diag.pairCount).toBe(0);
    expect(diag.rejectionReason).toBe("AMBIGUOUS_PAIRING");
    expect(findSafeWritingBlocks(adapter)).toHaveLength(0);
  });

  it("explicit high strategy still wins when present (ordering unchanged)", () => {
    dom = installDom(PAGE([
      writingTurn("t1"),
      `<div data-message-author-role="assistant" id="t2">
         <div data-testid="text-block"><p>Semantic block.</p></div>
       </div>`,
      writingTurn("t3"),
    ]));
    const adapter = createAdapter();
    const container = adapter.detectConversationContainer().element!;
    const result = adapter.detectWritingBlocks(container);
    expect(result.strategy).toBe("text-block-semantic");
    expect(result.confidence).toBe("high");
    // Only the semantic blocks; anchored editors are NOT merged in this case.
    expect(result.elements.every((el) => el.getAttribute("data-testid") === "text-block")).toBe(true);
  });
});

describe("surgical contenteditable exception scope", () => {
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

  it("proven anchored editor: accepted=true, confidence=high via the production evaluator", () => {
    dom = installDom(PAGE([writingTurn("t1"), writingTurn("t2"), writingTurn("t3")]));
    const adapter = createAdapter();
    const editor = dom.window.document.querySelector("#t3 .editor")!;
    const ev = evaluateWritingBlockCandidate(editor, adapter);
    expect(ev.accepted).toBe(true);
    expect(ev.reasons).toEqual([]);
    expect(ev.confidence).toBe("high");
    expect(isProvenWritingBlockEditor(editor, adapter)).toBe(true);

    const safe = findSafeWritingBlocks(adapter);
    expect(safe).toHaveLength(3);
    for (const el of safe) {
      expect(el.classList.contains("editor")).toBe(true);
    }
  });

  it("generic contenteditable WITHOUT anchor still rejected CONTENTEDITABLE_SELF", () => {
    dom = installDom(PAGE([
      `<div data-message-author-role="assistant" id="t1">
         <div contenteditable="true" id="gen"><p>Generic.</p></div>
       </div>`,
    ]));
    const adapter = createAdapter();
    const gen = dom.window.document.getElementById("gen")!;
    const ev = evaluateWritingBlockCandidate(gen, adapter);
    expect(ev.accepted).toBe(false);
    expect(ev.reasons).toContain("CONTENTEDITABLE_SELF");
    expect(isProvenWritingBlockEditor(gen, adapter)).toBe(false);
  });

  it("paragraph INSIDE the proven editor stays rejected CONTENTEDITABLE_ANCESTOR", () => {
    dom = installDom(PAGE([writingTurn("t1"), writingTurn("t2"), writingTurn("t3")]));
    const adapter = createAdapter();
    const p = dom.window.document.querySelector("#t3 .editor p")!;
    const ev = evaluateWritingBlockCandidate(p, adapter);
    expect(ev.accepted).toBe(false);
    expect(ev.reasons).toContain("CONTENTEDITABLE_ANCESTOR");
    expect(isProvenWritingBlockEditor(p, adapter)).toBe(false);
    // The low-confidence reason is present too (paragraph is not a strategy match).
    expect(ev.reasons).toContain("LOW_OR_UNKNOWN_CONFIDENCE");
  });

  it("composer-like textbox surface remains rejected even in an Assistant turn", () => {
    dom = installDom(PAGE([
      `<div data-message-author-role="assistant" id="t1">
         <div contenteditable="true" role="textbox" id="fake-composer"><p>x</p></div>
       </div>`,
    ]));
    const adapter = createAdapter();
    const el = dom.window.document.getElementById("fake-composer")!;
    const ev = evaluateWritingBlockCandidate(el, adapter);
    expect(ev.accepted).toBe(false);
    expect(ev.reasons).toContain("CONTENTEDITABLE_SELF");
    expect(isSafeWritingBlock(el, adapter)).toBe(false);
  });

  it("canonical copied text excludes header/toolbar labels (editor-only payload)", () => {
    dom = installDom(PAGE([writingTurn("t1"), writingTurn("t2"), writingTurn("t3")]));
    const adapter = createAdapter();
    const safe = findSafeWritingBlocks(adapter);
    expect(safe).toHaveLength(3);
    const text = safe[0]!.textContent ?? "";
    expect(text.includes("HEADER_LABEL_XYZ")).toBe(false);
    expect(text.includes("TOOLBAR_LABEL_QRS")).toBe(false);
    expect(text.includes("payload")).toBe(true);
  });

  it("legacy generic contenteditable test-block candidate is STILL rejected", () => {
    dom = installDom(`<main role="main"><section data-testid="thread">
      <div data-message-author-role="assistant" data-testid="assistant-message">
        <div data-testid="text-block" contenteditable="true"><p>Prose</p></div>
      </div>
    </section></main>`);
    const adapter = createAdapter();
    const block = dom.window.document.querySelector('[data-testid="text-block"]')!;
    expect(isSafeWritingBlock(block, adapter)).toBe(false);
  });
});
