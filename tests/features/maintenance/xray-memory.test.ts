import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import {
  buildPageComparison,
  isMemorySampleRecordSafeForTest,
  rankRegions,
  resourceAggregates,
  sanitizeUaBreakdownEntry,
  scanDocumentStructure,
  type RegionMetrics,
} from "../../../src/features/maintenance/xray-memory.js";

/**
 * Memory observatory: privacy invariants + bounded pure behavior.
 *
 * - UA breakdown sanitization strips URLs/names, keeps scope/kind/bytes.
 * - Rankings are capped, content-free, and value-ordered.
 * - Resource aggregates never emit URLs.
 * - Document scan counts structure without retaining text.
 * - Sample records validate shape before storage use.
 */

function installDom(html: string): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://chatgpt.com/c/mem",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.NodeFilter = dom.window.NodeFilter;
  g.HTMLElement = dom.window.HTMLElement;
  return dom;
}

function region(overrides: Partial<RegionMetrics> & Pick<RegionMetrics, "kind" | "turnIndex" | "blockIndex">): RegionMetrics {
  return {
    nodeCount: 0,
    elementCount: 0,
    textNodeCount: 0,
    textChars: 0,
    codeBlockCount: 0,
    preCount: 0,
    imageCount: 0,
    imageDecodedRgbaEstimateBytes: 0,
    canvasCount: 0,
    canvasBackingEstimateBytes: 0,
    svgCount: 0,
    iframeCount: 0,
    contentEditableCount: 0,
    animationCount: 0,
    renderedWidth: 0,
    renderedHeight: 0,
    renderedArea: 0,
    ...overrides,
  };
}

describe("memory observatory privacy + bounds", () => {
  let dom: JSDOM;
  let originalGlobals: Record<string, unknown>;
  beforeEach(() => {
    originalGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      Node: globalThis.Node,
      NodeFilter: (globalThis as unknown as Record<string, unknown>).NodeFilter,
      HTMLElement: globalThis.HTMLElement,
      performance: (globalThis as unknown as Record<string, unknown>).performance,
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

  it("sanitizes UA breakdown entries (no URLs, names, or raw scopes)", () => {
    const evil = {
      bytes: 1234,
      breakdown: [
        {
          bytes: 100,
          scope: "window",
          sameOrigin: true,
          containerKind: "top",
          types: ["JS", "DOM"],
          url: "https://chatgpt.com/c/SECRET-TOKEN",
          name: "secret iframe name",
        },
        {
          bytes: 50,
          scope: "mystery-scope",
          containerKind: "x".repeat(200),
          types: ["JS", 42, "DOM"],
        },
        "not-an-object",
        null,
      ],
    };
    const out = evil.breakdown
      .map(sanitizeUaBreakdownEntry)
      .filter((e) => e !== null);
    expect(out).toHaveLength(2);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("SECRET-TOKEN");
    expect(serialized).not.toContain("secret iframe");
    expect(serialized).not.toContain("chatgpt.com");
    expect(out[0]).toMatchObject({
      scope: "window",
      sameOrigin: true,
      containerKind: "top",
      types: ["JS", "DOM"],
      bytes: 100,
    });
    expect(out[1]!.scope).toBe("unknown");
    expect(out[1]!.types).toEqual(["JS", "DOM"]);
  });

  it("rankings are capped at 10, ordered, and content-free", () => {
    const regions = Array.from({ length: 15 }, (_, i) =>
      region({ kind: "assistant-turn", turnIndex: i, blockIndex: -1, nodeCount: (i + 1) * 10 }),
    );
    const rankings = rankRegions(regions);
    expect(rankings.topByNodeCount).toHaveLength(10);
    expect(rankings.topByNodeCount[0]!.value).toBe(150);
    expect(rankings.topByNodeCount[9]!.value).toBe(60);
    for (const entry of rankings.topByNodeCount) {
      expect(Object.keys(entry).sort()).toEqual(
        ["blockIndex", "kind", "turnIndex", "value"].sort(),
      );
    }
    expect(rankings.topByTextChars).toHaveLength(0);
  });

  it("resource aggregates bucket without URLs", () => {
    const entries = [
      { initiatorType: "script", transferSize: 100, encodedBodySize: 90, decodedBodySize: 95, name: "https://cdn.example.com/secret.js" },
      { initiatorType: "css", transferSize: 50, encodedBodySize: 40, decodedBodySize: 45, name: "https://cdn.example.com/a.css" },
      { initiatorType: "link", transferSize: 10, encodedBodySize: 8, decodedBodySize: 9, name: "https://cdn.example.com/b.css" },
      { initiatorType: "img", transferSize: 200, encodedBodySize: 200, decodedBodySize: 210, name: "https://img.example.com/p.png" },
      { initiatorType: "weird", transferSize: 5, encodedBodySize: 5, decodedBodySize: 5, name: "x" },
    ];
    const g = globalThis as unknown as {
      performance: { getEntriesByType: (t: string) => unknown[] };
    };
    g.performance = { getEntriesByType: (t: string) => (t === "resource" ? entries : []) };
    const agg = resourceAggregates();
    expect(agg["script"]!.count).toBe(1);
    expect(agg["css/link"]!.count).toBe(2);
    expect(agg["img"]!.transferSize).toBe(200);
    expect(agg["other"]!.count).toBe(1);
    expect(JSON.stringify(agg)).not.toContain("cdn.example.com");
    expect(JSON.stringify(agg)).not.toContain("secret");
  });

  it("document scan counts without retaining text", () => {
    dom = installDom(
      `<main><section><p>SECRET-CHAT-TEXT-XYZ hello</p><pre><code>code()</code></pre><img /><canvas></canvas></section></main>`,
    );
    const before = (globalThis as unknown as Record<string, unknown>).performance;
    try {
      delete (globalThis as unknown as Record<string, unknown>).performance;
      const s = scanDocumentStructure(dom.window.document);
      expect(s.elementNodes).toBeGreaterThan(0);
      expect(s.textNodes).toBeGreaterThan(0);
      expect(s.totalTextChars).toBeGreaterThan(0);
      expect(s.preCount).toBe(1);
      expect(s.codeCount).toBe(1);
      expect(s.imageCount).toBe(1);
      expect(s.canvasCount).toBe(1);
      expect(JSON.stringify(s)).not.toContain("SECRET-CHAT-TEXT-XYZ");
    } finally {
      (globalThis as unknown as Record<string, unknown>).performance = before;
    }
  });

  it("sample records validate shape and comparisons stay bounded", () => {
    expect(isMemorySampleRecordSafeForTest({})).toBe(false);
    const good = {
      pageKey: "abc123",
      sampleTimestamp: 1,
      buildId: "0.1.0+x",
      uaSpecificBytes: null,
      legacyUsedJsHeap: 100,
      nodeCount: 10,
      textChars: 5,
      estimatedImageBytes: 0,
      estimatedCanvasBytes: 0,
      assistantTurnCount: 1,
      writingBlockCount: 0,
    };
    expect(isMemorySampleRecordSafeForTest(good)).toBe(true);
    const records = Array.from({ length: 12 }, (_, i) => ({
      ...good,
      pageKey: `p${i}`,
      nodeCount: (i + 1) * 100,
    }));
    const cmp = buildPageComparison(records);
    expect(cmp.records).toHaveLength(12);
    expect(cmp.topByNodeCount).toHaveLength(10);
    expect(cmp.topByNodeCount[0]!.nodeCount).toBe(1200);
    expect(cmp.comparisonWarning.length).toBeGreaterThan(0);
  });
});
