import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import { runXrayScan } from "../../../src/features/maintenance/xray-scan.js";
import { buildXrayReport } from "../../../src/features/maintenance/xray-report.js";

/**
 * Focused X-Ray visibility for the structural container fallback: the
 * cgl-xray-v1 report must expose exactly what role-turn-common-ancestor did
 * (attempted / found / anchors / commonAncestorTag / rejection reason) so
 * future root recovery stays explainable.
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

const REAL_SHAPE = `
<div id="app-shell">
  <div id="conversation-scroll">
    <div class="thread-wrapper"><div class="inner-thread">
      <article data-message-author-role="user" id="u1"><p>u1</p></article>
      <article data-message-author-role="assistant" id="a1"><p>a1</p></article>
      <article data-message-author-role="assistant" id="a2"><p>a2</p></article>
    </div></div>
  </div>
</div>`;

describe("xray container-fallback visibility", () => {
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

  it("fallback accepted: report shows strategy id, anchors, ancestor tag", () => {
    dom = installDom(REAL_SHAPE);
    const adapter = createAdapter();
    const scan = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true });

    expect(scan.conversationContainerFound).toBe(true);
    expect(scan.conversationContainerStrategyId).toBe("role-turn-common-ancestor");
    expect(scan.containerFallback.attempted).toBe(true);
    expect(scan.containerFallback.accepted).toBe(true);
    expect(scan.containerFallback.userAnchorCount).toBe(1);
    expect(scan.containerFallback.assistantAnchorCount).toBe(2);
    expect(scan.containerFallback.commonAncestorTag).toBe("div");

    const report = buildXrayReport(
      scan,
      { containerElement: adapter.detectConversationContainer().element },
      null,
      {},
    );
    expect(report.schema).toBe("cgl-xray-v1");
    expect(report.containerFallback.strategyId).toBe("role-turn-common-ancestor");
    expect(report.containerFallback.confidence).toBe("medium");
    // Serialized report contains structure only.
    const s = JSON.stringify(report);
    expect(s.includes("u1")).toBe(false);
    expect(s.includes("<")).toBe(false); // no HTML anywhere
  });

  it("explicit strategy won: fallback marked NOT_ATTEMPTED", () => {
    dom = installDom(`<main role="main"><section data-testid="thread">
      <div data-message-author-role="user"><p>u</p></div>
      <div data-message-author-role="assistant"><p>a</p></div>
    </section></main>`);
    const scan = runXrayScan(createAdapter(), { enabled: true, writingCopyEnabled: true });
    expect(scan.conversationContainerStrategyId).toBe("role-main");
    expect(scan.containerFallback.attempted).toBe(false);
    expect(scan.containerFallback.rejectionReason).toBe(
      "NOT_ATTEMPTED_EXPLICIT_STRATEGY_SUCCEEDED",
    );
  });

  it("fallback rejected (body-only): report carries the rejection reason", () => {
    dom = installDom(`
      <section data-message-author-role="user"><p>u</p></section>
      <section data-message-author-role="assistant"><p>a</p></section>`);
    const scan = runXrayScan(createAdapter(), { enabled: true, writingCopyEnabled: true });
    expect(scan.conversationContainerFound).toBe(false);
    expect(scan.containerFallback.attempted).toBe(true);
    expect(scan.containerFallback.accepted).toBe(false);
    expect(scan.containerFallback.rejectionReason).toBe("COMMON_ANCESTOR_IS_BODY_OR_HTML");
  });
});
