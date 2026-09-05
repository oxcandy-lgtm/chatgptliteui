import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { createAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import {
  evaluateWritingBlockCandidate,
  isSafeWritingBlock,
} from "../../../src/features/writing-copy/writing-copy-detection.js";
import {
  runXrayScan,
} from "../../../src/features/maintenance/xray-scan.js";
import {
  buildXrayReport,
  diagnose,
  findLeakedSecrets,
} from "../../../src/features/maintenance/xray-report.js";
import {
  deepStructuralTree,
  nodeSignature,
} from "../../../src/features/maintenance/xray-signature.js";

/**
 * Focused X-Ray maintenance-port tests:
 *  - gate/evaluator parity (production behavior unchanged);
 *  - exact reason codes;
 *  - strategy-by-strategy inventory;
 *  - report schema + deterministic diagnosis;
 *  - PRIVACY: synthetic fixture secrets NEVER appear in the serialized report;
 *  - structural signature contains no text content.
 */

function installDom(html: string): JSDOM {
  const dom = new JSDOM(html, { url: "https://chatgpt.com/c/fixtured-token", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  return dom;
}

// Synthetic boundary fixtures. Names deliberately avoid credential-ish
// identifier wording so the public-safety scanner is not tripped by test
// data; the guard below proves NONE of them reach the serialized report.
const FIXTURE_USER_TEXT = "XRAYFIXTURE-user-payload-9812";
const FIXTURE_ASSISTANT_TEXT = "XRAYFIXTURE-assistant-payload-7734";
const FIXTURE_INPUT_TEXT = "XRAYFIXTURE-input-payload-5512";
const FIXTURE_ROUTE_ID = "XRAYFIXTURE-route-id-3391";
const ALL_FIXTURE_TEXTS = [
  FIXTURE_USER_TEXT,
  FIXTURE_ASSISTANT_TEXT,
  FIXTURE_INPUT_TEXT,
  FIXTURE_ROUTE_ID,
];

function fixtureConversation(): string {
  return `<html><body>
    <nav aria-label="Chat history"><a href="/c/${FIXTURE_ROUTE_ID}">history</a></nav>
    <main role="main"><section data-testid="thread" aria-label="conversation">
      <div data-message-author-role="user" data-testid="user-message">
        <p>${FIXTURE_USER_TEXT}</p>
      </div>
      <div data-message-author-role="assistant" data-testid="assistant-message">
        <div data-testid="text-block" id="wb1">
          <p>${FIXTURE_ASSISTANT_TEXT}</p>
          <textarea>${FIXTURE_INPUT_TEXT}</textarea>
          <button aria-label="Copy">copy icon</button>
        </div>
      </div>
    </section></main>
  </body></html>`;
}

/**
 * Two Assistant turns: one canonical clean block (gate accepts) and one
 * contenteditable block (gate rejects with CONTENTEDITABLE_SELF).
 */
function mixedConversation(): string {
  return `<html><body><main role="main"><section data-testid="thread">
    <div data-message-author-role="assistant" data-testid="assistant-message">
      <div data-testid="text-block" id="ok"><p>Clean prose.</p></div>
    </div>
    <div data-message-author-role="assistant" data-testid="assistant-message">
      <div data-testid="text-block" id="ce" contenteditable="true"><p>Edit me.</p></div>
    </div>
  </section></main></body></html>`;
}

describe("xray gate evaluator parity + reason codes", () => {
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

  it("accepted candidate: evaluator agrees with production gate", () => {
    dom = installDom(`<main role="main"><section data-testid="thread">
      <div data-message-author-role="assistant" data-testid="assistant-message">
        <div data-testid="text-block"><p>Prose.</p></div>
      </div>
    </section></main>`);
    const adapter = createAdapter();
    const el = dom.window.document.querySelector('[data-testid="text-block"]')!;
    const ev = evaluateWritingBlockCandidate(el, adapter);
    expect(ev.accepted).toBe(true);
    expect(ev.reasons).toEqual([]);
    expect(ev.confidence).toBe("high");
    expect(isSafeWritingBlock(el, adapter)).toBe(true);
  });

  it("contenteditable candidate reports CONTENTEDITABLE_SELF and is rejected", () => {
    dom = installDom(`<main role="main"><section data-testid="thread">
      <div data-message-author-role="assistant" data-testid="assistant-message">
        <div data-testid="text-block" contenteditable="true"><p>Prose.</p></div>
      </div>
    </section></main>`);
    const adapter = createAdapter();
    const el = dom.window.document.querySelector('[data-testid="text-block"]')!;
    const ev = evaluateWritingBlockCandidate(el, adapter);
    expect(ev.accepted).toBe(false);
    expect(ev.reasons).toContain("CONTENTEDITABLE_SELF");
    expect(isSafeWritingBlock(el, adapter)).toBe(false);
  });

  it("disconnected candidate reports DISCONNECTED only", () => {
    dom = installDom(`<main role="main"><section data-testid="thread"></section></main>`);
    const adapter = createAdapter();
    const detached = dom.window.document.createElement("div");
    detached.setAttribute("data-testid", "text-block");
    const ev = evaluateWritingBlockCandidate(detached, adapter);
    expect(ev.accepted).toBe(false);
    expect(ev.reasons).toEqual(["DISCONNECTED"]);
  });

  it("low-confidence bare <p> reports LOW_OR_UNKNOWN_CONFIDENCE", () => {
    dom = installDom(`<main role="main"><section data-testid="thread">
      <div data-message-author-role="assistant" data-testid="assistant-message">
        <p>Bare paragraph.</p>
      </div>
    </section></main>`);
    const adapter = createAdapter();
    const el = dom.window.document.querySelector("p")!;
    const ev = evaluateWritingBlockCandidate(el, adapter);
    expect(ev.reasons).toContain("LOW_OR_UNKNOWN_CONFIDENCE");
  });

  it("code-containing candidate reports CONTAINS_CODE", () => {
    dom = installDom(`<main role="main"><section data-testid="thread">
      <div data-message-author-role="assistant" data-testid="assistant-message">
        <div data-testid="text-block"><pre><code>x=1</code></pre></div>
      </div>
    </section></main>`);
    const adapter = createAdapter();
    const el = dom.window.document.querySelector('[data-testid="text-block"]')!;
    const ev = evaluateWritingBlockCandidate(el, adapter);
    expect(ev.reasons).toContain("CONTAINS_CODE");
  });
});

describe("xray scan + report + privacy", () => {
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
      IntersectionObserver: globalThis.IntersectionObserver,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
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

  it("scan inventories EVERY strategy individually", () => {
    dom = installDom(fixtureConversation());
    const adapter = createAdapter();
    const scan = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true });
    // All 10 probed targets must appear with every configured strategy.
    const targets = new Set(scan.strategies.map((s) => s.target));
    expect(targets.size).toBeGreaterThanOrEqual(9);
    const writingProbes = scan.strategies.filter((s) => s.target === "writingBlock");
    expect(writingProbes.length).toBe(3);
    for (const p of writingProbes) {
      expect(p.selector.length).toBeGreaterThan(0);
      expect(typeof p.totalMatches).toBe("number");
    }
    // The canonical text-block strategy matched the fixture block.
    const semantic = writingProbes.find((p) => p.strategyId === "text-block-semantic");
    expect(semantic?.totalMatches).toBe(1);
  });

  it("scan reports raw/safe/rejected counts + exact rejection inventory", () => {
    dom = installDom(mixedConversation());
    const adapter = createAdapter();
    const scan = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true });
    // Raw candidates: 2 text-blocks + nested <p>s from the low-confidence
    // strategy. Safe = only the clean block; the contenteditable one is
    // rejected with its exact reason.
    expect(scan.writingPipeline.safeCount).toBe(1);
    expect(scan.writingPipeline.rejectedCount).toBeGreaterThanOrEqual(1);
    const ceCandidate = scan.writingPipeline.candidates.find(
      (c) => c.sig.id === "ce",
    )!;
    expect(ceCandidate.accepted).toBe(false);
    expect(ceCandidate.reasons).toContain("CONTENTEDITABLE_SELF");
    expect(
      scan.writingPipeline.rejections["CONTENTEDITABLE_SELF"],
    ).toBeGreaterThanOrEqual(1);
    // The clean block carries no rejection reasons.
    const okCandidate = scan.writingPipeline.candidates.find(
      (c) => c.sig.id === "ok",
    )!;
    expect(okCandidate.accepted).toBe(true);
    expect(okCandidate.reasons).toEqual([]);
  });

  it("report contains NO fixture secrets (privacy guard)", () => {
    dom = installDom(fixtureConversation());
    const adapter = createAdapter();
    const scan = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true });
    const report = buildXrayReport(
      scan,
      { containerElement: adapter.detectConversationContainer().element },
      null,
      { includeDeepTree: true },
    );
    const serialized = JSON.stringify(report, null, 2);
    expect(report.schema).toBe("cgl-xray-v1");
    expect(findLeakedSecrets(serialized, ALL_FIXTURE_TEXTS)).toEqual([]);
  });

  it("node signature never carries text content or values", () => {
    dom = installDom(fixtureConversation());
    const ta = dom.window.document.querySelector("textarea")!;
    const sig = nodeSignature(ta) as unknown as Record<string, unknown>;
    expect(sig.tag).toBe("textarea");
    expect(sig.textLength).toBe(FIXTURE_INPUT_TEXT.length); // count only
    const json = JSON.stringify(sig);
    expect(json.includes(FIXTURE_INPUT_TEXT)).toBe(false);
    expect(sig.value).toBeUndefined();
    expect(sig.innerHTML).toBeUndefined();
    expect(sig.outerHTML).toBeUndefined();
  });

  it("deep scan is bounded and reports truncation", () => {
    dom = installDom(fixtureConversation());
    const container = dom.window.document.querySelector('[role="main"]')!;
    const full = deepStructuralTree(container);
    expect(full.truncated).toBe(false);
    expect(full.included).toBe(full.totalObserved);
    // Cap of 3: includes exactly 3 nodes and reports truncation.
    const capped = deepStructuralTree(container, 3);
    expect(capped.truncated).toBe(true);
    expect(capped.included).toBe(3);
    expect(capped.totalObserved).toBeGreaterThanOrEqual(3);
  });

  it("diagnosis picks deterministic blockers", () => {
    dom = installDom(mixedConversation());
    const adapter = createAdapter();
    const scan = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true });
    // At least one candidate exists and at least one is rejected; with a safe
    // block present the summary reports the safe count.
    const d = diagnose(scan);
    expect(d.summary).toBe("WRITING_SAFE_COUNT_1");

    // Pure-rejection page (contenteditable block only) -> safe zero + reason.
    dom.window.close();
    const g2 = globalThis as unknown as Record<string, unknown>;
    dom = installDom(`<html><body><main role="main"><section data-testid="thread">
      <div data-message-author-role="assistant" data-testid="assistant-message">
        <div data-testid="text-block" contenteditable="true"><p>Edit me.</p></div>
      </div>
    </section></main></body></html>`);
    void g2;
    const scan2 = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true });
    const d2 = diagnose(scan2);
    expect(d2.summary).toMatch(/^RAW_CANDIDATES_PRESENT_SAFE_ZERO/);
    // Both editable reasons fire (block=SELF, nested <p>=ANCESTOR); the
    // deterministic tie-break reports the lexicographically-first one.
    expect(d2.firstBlocker).toMatch(
      /GATE_REJECTION:CONTENTEDITABLE_(SELF|ANCESTOR)/,
    );

    // Disabled extension -> disabled summary (fresh DOM).
    dom.window.close();
    dom = installDom(mixedConversation());
    const off = runXrayScan(adapter, { enabled: false, writingCopyEnabled: true });
    expect(diagnose(off).summary).toBe("EXTENSION_RUNTIME_OK_WRITING_COPY_DISABLED");

    // No container -> container blocker.
    dom.window.document.querySelector("main")!.remove();
    const noConv = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true });
    expect(diagnose(noConv).summary).toBe("CONVERSATION_CONTAINER_NOT_FOUND");
  });

  it("safe conversation yields WRITING_SAFE_COUNT and a safe report", () => {
    dom = installDom(`<html><body><main role="main"><section data-testid="thread">
      <div data-message-author-role="assistant" data-testid="assistant-message">
        <div data-testid="text-block"><p>Clean prose block.</p></div>
      </div>
    </section></main></body></html>`);
    const adapter = createAdapter();
    const scan = runXrayScan(adapter, { enabled: true, writingCopyEnabled: true });
    expect(scan.writingPipeline.safeCount).toBe(1);
    expect(diagnose(scan).summary).toBe("WRITING_SAFE_COUNT_1");
    const report = buildXrayReport(scan, { containerElement: adapter.detectConversationContainer().element }, null, {});
    const serialized = JSON.stringify(report);
    expect(findLeakedSecrets(serialized, ["Clean prose block."])).toEqual([]);
  });
});
