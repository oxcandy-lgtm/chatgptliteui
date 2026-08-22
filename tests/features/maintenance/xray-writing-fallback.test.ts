import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import { runXrayScan } from "../../../src/features/maintenance/xray-scan.js";
import {
  buildXrayReport,
  diagnose,
} from "../../../src/features/maintenance/xray-report.js";
import { XrayController } from "../../../src/features/maintenance/xray-controller.js";
import { cloneDefaults } from "../../../src/settings/defaults.js";

/**
 * Focused X-Ray visibility for the structural `writing-block-editor-anchored`
 * fallback: the cgl-xray-v1 report must expose exactly what the pairing did
 * (attempted / found / anchors / editors / pairs / ambiguity / rejection
 * reason) so WritingBlock recovery stays explainable.
 */

const ANCHOR_TURN = (id: string): string =>
  `<div data-message-author-role="assistant" id="${id}">
     <p>Ordinary prose.</p>
     <div class="writing-header">
       <button data-testid="writing-block-header-magic-edit-button"></button>
     </div>
     <div contenteditable="true" class="editor"><p>Payload ${id}.</p></div>
   </div>`;

const PAGE = (turns: string[]): string =>
  `<main role="main"><section data-testid="thread" aria-label="conversation">${turns.join("")}</section></main>`;

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

describe("xray writing-block fallback receipt", () => {
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

  it("accepted anchored editor: receipt found=true, safeCount=1, WRITING_SAFE_COUNT_1", () => {
    dom = installDom(PAGE([ANCHOR_TURN("a1"), ANCHOR_TURN("a2"), ANCHOR_TURN("a3")]));
    const adapter = createAdapter();
    const scan = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true });

    expect(scan.writingBlockFallback.attempted).toBe(true);
    expect(scan.writingBlockFallback.found).toBe(true);
    expect(scan.writingBlockFallback.strategyId).toBe("writing-block-editor-anchored");
    expect(scan.writingBlockFallback.confidence).toBe("high");
    expect(scan.writingBlockFallback.assistantTurnsScanned).toBe(3);
    expect(scan.writingBlockFallback.headerAnchorCount).toBe(3);
    expect(scan.writingBlockFallback.contentEditableCount).toBe(3);
    expect(scan.writingBlockFallback.pairCount).toBe(3);
    expect(scan.writingBlockFallback.acceptedEditorCount).toBe(3);
    expect(scan.writingBlockFallback.ambiguousCount).toBe(0);

    // The accepted editor appears in the pipeline with its strategy tag and
    // passes the SAME production evaluator.
    const editorCandidate = scan.writingPipeline.candidates.find(
      (c) => c.strategyId === "writing-block-editor-anchored",
    );
    expect(editorCandidate).toBeTruthy();
    expect(editorCandidate!.accepted).toBe(true);
    expect(editorCandidate!.confidence).toBe("high");

    expect(scan.writingPipeline.safeCount).toBeGreaterThanOrEqual(1);
    expect(diagnose(scan).summary).toBe("WRITING_SAFE_COUNT_3");

    const report = buildXrayReport(
      scan,
      { containerElement: adapter.detectConversationContainer().element },
      null,
      {},
    );
    expect(report.writingBlockFallback.found).toBe(true);
    const s = JSON.stringify(report);
    expect(s.includes("Payload")).toBe(false); // no chat text anywhere
    expect(s.includes("<")).toBe(false); // no HTML anywhere
  });

  it("generic editable only: attempted+found=false, NO_HEADER_ANCHOR, safe zero", () => {
    dom = installDom(PAGE([
      `<div data-message-author-role="assistant" id="a1">
         <div contenteditable="true"><p>No anchor.</p></div>
       </div>`,
      `<div data-message-author-role="assistant" id="a2"><p>plain</p></div>`,
      `<div data-message-author-role="assistant" id="a3"><p>plain</p></div>`,
    ]));
    const scan = runXrayScan(createAdapter(), { enabled: true, writingCopyEnabled: true });
    expect(scan.writingBlockFallback.attempted).toBe(true);
    expect(scan.writingBlockFallback.found).toBe(false);
    expect(scan.writingBlockFallback.rejectionReason).toBe("NO_HEADER_ANCHOR");
    expect(diagnose(scan).summary).not.toBe("RAW_CANDIDATES_PRESENT_SAFE_ZERO_LOW_OR_UNKNOWN_CONFIDENCE");
  });

  it("explicit high strategy success marks the fallback NOT_ATTEMPTED", () => {
    dom = installDom(PAGE([
      `<div data-message-author-role="assistant" id="a1">
         <div data-testid="text-block"><p>Semantic.</p></div>
       </div>`,
      `<div data-message-author-role="assistant" id="a2"><p>plain</p></div>`,
      `<div data-message-author-role="assistant" id="a3"><p>plain</p></div>`,
    ]));
    const scan = runXrayScan(createAdapter(), { enabled: true, writingCopyEnabled: true });
    expect(scan.writingBlockFallback.attempted).toBe(false);
    expect(scan.writingBlockFallback.rejectionReason).toBe(
      "NOT_ATTEMPTED_EXPLICIT_STRATEGY_SUCCEEDED",
    );
  });

  it("ambiguous pairing surfaces AMBIGUOUS_PAIRING in the report", () => {
    dom = installDom(PAGE([
      `<div data-message-author-role="assistant" id="a1">
         <div class="region">
           <button data-testid="writing-block-header-magic-edit-button"></button>
           <div contenteditable="true" id="e1"><p>one</p></div>
           <div contenteditable="true" id="e2"><p>two</p></div>
         </div>
       </div>`,
      `<div data-message-author-role="assistant" id="a2"><p>plain</p></div>`,
      `<div data-message-author-role="assistant" id="a3"><p>plain</p></div>`,
    ]));
    const scan = runXrayScan(createAdapter(), { enabled: true, writingCopyEnabled: true });
    expect(scan.writingBlockFallback.attempted).toBe(true);
    expect(scan.writingBlockFallback.found).toBe(false);
    expect(scan.writingBlockFallback.ambiguousCount).toBe(1);
    expect(scan.writingBlockFallback.rejectionReason).toBe("AMBIGUOUS_PAIRING");
    const report = buildXrayReport(
      scan,
      { containerElement: null },
      null,
      {},
    );
    expect(report.diagnosis.summary).toContain("SAFE_ZERO");
    expect(report.writingBlockFallback.rejectionReason).toBe("AMBIGUOUS_PAIRING");
  });

  it("panel paint marks accepted anchored editors as safe blocks while active", () => {
    dom = installDom(PAGE([ANCHOR_TURN("a1"), ANCHOR_TURN("a2"), ANCHOR_TURN("a3")]));
    const root = dom.window.document.documentElement;
    const settings = cloneDefaults();
    settings.enabled = true;
    settings.writingCopy.enabled = true;
    const controller = new XrayController({
      root,
      adapter: createAdapter(),
      getSettings: () => settings,
    });
    controller.toggle();
    expect(controller.isActive).toBe(true);
    const painted = dom.window.document.querySelectorAll(
      '[data-cgl-xray-safe-block="true"]',
    );
    expect(painted.length).toBeGreaterThanOrEqual(1);
    for (const el of Array.from(painted)) {
      expect(el.classList.contains("editor")).toBe(true);
    }
    // Every diagnostic attribute is extension-owned and removed on stop.
    controller.stop();
    expect(dom.window.document.querySelectorAll("[data-cgl-xray-safe-block]").length).toBe(0);
  });
});
