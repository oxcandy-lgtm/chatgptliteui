/**
 * CGL X-Ray — on-demand memory observatory (Phase 5 diagnostic).
 *
 * Manual-only: NOTHING here runs unless the user presses an explicit X-Ray
 * action ("Memory Snapshot", "Memory Trace 60s", "Save memory sample").
 * When X-Ray is closed there is zero polling, zero tracing, zero
 * PerformanceObserver, and zero deep DOM scanning; closing X-Ray (or a
 * route change) cancels an active trace and releases all references.
 *
 * What it answers (and its honest limits):
 *  - legacy Chromium JS heap (`performance.memory`, labeled as such — never
 *    "physical tab memory");
 *  - UA-specific page memory (`measureUserAgentSpecificMemory`) only where
 *    the browser offers it, sanitized to scope/kind/bytes (never URLs);
 *  - counts-only document structure, media/backing-store ESTIMATES (never
 *    actual RAM), network resource payload aggregates (never live RAM);
 *  - per-turn / per-WritingBlock structural rankings (never content);
 *  - exact extension-owned live-state counts;
 *  - storage size summary (key counts + serialized chars, never values);
 *  - 60s heap-timeline trace with long-task correlation, aimed at showing
 *    idle-time reclamation (e.g. ~1.2GB settling toward ~394MB) without
 *    claiming which subsystem reclaimed it.
 *
 * Exact per-subtree physical RAM, GPU memory, and arbitrary page event
 * listener counts are NOT exposed by the platform without new permissions;
 * those capabilities report `false`/null rather than fabricated zeros.
 * No CDP, no debugger/processes/tabs permissions, no network, no backend.
 */

import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import { findSafeWritingBlocks } from "../writing-copy/writing-copy-detection.js";
import { deriveBlockIdentity } from "../writing-copy/block-identity.js";

/** Feature/capability matrix (every flag feature-detected, never guessed). */
export interface MemoryCapabilities {
  performanceMemorySupported: boolean;
  uaSpecificMemorySupported: boolean;
  crossOriginIsolated: boolean;
  longTaskSupported: boolean;
  resourceTimingSupported: boolean;
  exactRendererPrivateMemoryAvailable: boolean;
  exactSubtreeRetainedBytesAvailable: boolean;
  exactEventListenerCountAvailable: boolean;
  exactGpuMemoryAvailable: boolean;
}

export function memoryCapabilities(): MemoryCapabilities {
  const g = globalThis as unknown as {
    PerformanceObserver?: unknown;
    crossOriginIsolated?: boolean;
  };
  const perf = ((): Performance | null => {
    try {
      return typeof performance !== "undefined" ? performance : null;
    } catch {
      return null;
    }
  })();
  const perfAny = perf as unknown as Record<string, unknown> | null;
  return {
    performanceMemorySupported:
      !!perfAny && typeof perfAny["memory"] === "object" && perfAny["memory"] !== null,
    uaSpecificMemorySupported:
      !!perfAny && typeof perfAny["measureUserAgentSpecificMemory"] === "function",
    crossOriginIsolated: g.crossOriginIsolated === true,
    longTaskSupported: typeof g.PerformanceObserver === "function",
    resourceTimingSupported:
      !!perf && typeof perf.getEntriesByType === "function",
    exactRendererPrivateMemoryAvailable: false,
    exactSubtreeRetainedBytesAvailable: false,
    exactEventListenerCountAvailable: false,
    exactGpuMemoryAvailable: false,
  };
}

/** Legacy Chromium JS heap snapshot (explicitly NOT physical tab memory). */
export interface LegacyJsHeap {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export function legacyJsHeap(): LegacyJsHeap | null {
  try {
    const perf = globalThis as unknown as {
      performance?: { memory?: unknown };
    };
    const mem = perf.performance?.memory as
      | { usedJSHeapSize?: unknown; totalJSHeapSize?: unknown; jsHeapSizeLimit?: unknown }
      | undefined;
    if (!mem) return null;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const used = num(mem.usedJSHeapSize);
    const total = num(mem.totalJSHeapSize);
    const limit = num(mem.jsHeapSizeLimit);
    if (used === null || total === null || limit === null) return null;
    return { usedJSHeapSize: used, totalJSHeapSize: total, jsHeapSizeLimit: limit };
  } catch {
    return null;
  }
}

/** Sanitized UA-specific memory attribution entry (no URLs/names). */
export interface UaMemoryAttribution {
  scope: string;
  sameOrigin: boolean;
  containerKind: string;
  types: string[];
  bytes: number;
}

export interface UaMemoryResult {
  supported: boolean;
  attempted: boolean;
  success: boolean;
  errorName: string | null;
  crossOriginIsolated: boolean;
  bytes: number | null;
  breakdown: UaMemoryAttribution[];
}

/** Sanitize one raw breakdown entry to scope/kind/bytes only. */
export function sanitizeUaBreakdownEntry(raw: unknown): UaMemoryAttribution | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const str = (v: unknown): string => (typeof v === "string" ? v.slice(0, 64) : "");
  const types = Array.isArray(r["types"])
    ? (r["types"] as unknown[]).filter((t): t is string => typeof t === "string").map((t) => t.slice(0, 32)).slice(0, 8)
    : [];
  const scopeRaw = str(r["scope"]);
  return {
    scope: scopeRaw === "window" || scopeRaw === "dedicated-worker" || scopeRaw === "shared-worker" || scopeRaw === "service-worker" ? scopeRaw : "unknown",
    sameOrigin: r["sameOrigin"] === true,
    containerKind: str(r["containerKind"]) || "unknown",
    types,
    bytes: num(r["bytes"]),
  };
}

/** Attempt UA-specific memory (explicit snapshot/trace boundaries only). */
export async function attemptUaMemory(): Promise<UaMemoryResult> {
  const g = globalThis as unknown as {
    crossOriginIsolated?: boolean;
  };
  const base: UaMemoryResult = {
    supported: false,
    attempted: false,
    success: false,
    errorName: null,
    crossOriginIsolated: g.crossOriginIsolated === true,
    bytes: null,
    breakdown: [],
  };
  let measure: (() => Promise<unknown>) | null = null;
  try {
    const perf = (globalThis as unknown as Record<string, unknown>)["performance"] as
      | Record<string, unknown>
      | undefined;
    if (perf && typeof perf["measureUserAgentSpecificMemory"] === "function") {
      base.supported = true;
      measure = (perf["measureUserAgentSpecificMemory"] as () => Promise<unknown>).bind(perf);
    }
  } catch {
    return base;
  }
  if (!measure) return base;
  base.attempted = true;
  try {
    const raw = (await measure()) as {
      bytes?: unknown;
      breakdown?: unknown;
    };
    const bytes =
      typeof raw.bytes === "number" && Number.isFinite(raw.bytes) && raw.bytes >= 0
        ? raw.bytes
        : null;
    const breakdown = Array.isArray(raw.breakdown)
      ? raw.breakdown
          .map(sanitizeUaBreakdownEntry)
          .filter((e): e is UaMemoryAttribution => e !== null)
          .slice(0, 32)
      : [];
    return { ...base, success: true, bytes, breakdown };
  } catch (err) {
    return {
      ...base,
      errorName: err instanceof Error ? err.name.slice(0, 64) : "Error",
    };
  }
}

// --- document structure ----------------------------------------------------

export interface DocumentMemoryStructure {
  totalNodes: number;
  elementNodes: number;
  textNodes: number;
  commentNodes: number;
  totalTextChars: number;
  totalAttributeCount: number;
  totalAttributeValueChars: number;
  openShadowRootCount: number;
  iframeCount: number;
  sameOriginIframeCount: number;
  contentEditableCount: number;
  preCount: number;
  codeCount: number;
  svgCount: number;
  imageCount: number;
  canvasCount: number;
  videoCount: number;
  audioCount: number;
  scriptElementCount: number;
  styleElementCount: number;
  stylesheetCount: number;
  animationCount: number;
}

function zeroDocumentStructure(): DocumentMemoryStructure {
  return {
    totalNodes: 0,
    elementNodes: 0,
    textNodes: 0,
    commentNodes: 0,
    totalTextChars: 0,
    totalAttributeCount: 0,
    totalAttributeValueChars: 0,
    openShadowRootCount: 0,
    iframeCount: 0,
    sameOriginIframeCount: 0,
    contentEditableCount: 0,
    preCount: 0,
    codeCount: 0,
    svgCount: 0,
    imageCount: 0,
    canvasCount: 0,
    videoCount: 0,
    audioCount: 0,
    scriptElementCount: 0,
    styleElementCount: 0,
    stylesheetCount: 0,
    animationCount: 0,
  };
}

/**
 * Single-pass counts-only structural scan. Synchronous TreeWalker (no giant
 * arrays, no text/attribute values retained). Bounded callers should prefer
 * `scanDocumentStructureBudgeted` for huge DOMs.
 */
export function scanDocumentStructure(root: ParentNode = document): DocumentMemoryStructure {
  const out = zeroDocumentStructure();
  let walker: TreeWalker | null = null;
  try {
    walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  } catch {
    return out;
  }
  if (!walker) return out;
  let node: Node | null = walker.currentNode;
  // TreeWalker starts positioned at root; advance to first descendant below.
  node = walker.nextNode();
  for (; node; node = walker.nextNode()) {
    out.totalNodes++;
    if (node.nodeType === 3) {
      out.textNodes++;
      out.totalTextChars += (node.textContent ?? "").length;
    } else if (node.nodeType === 8) {
      out.commentNodes++;
    } else if (node.nodeType === 1) {
      out.elementNodes++;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      out.totalAttributeCount += el.attributes.length;
      for (let i = 0; i < el.attributes.length; i++) {
        out.totalAttributeValueChars += (el.attributes[i]?.value.length ?? 0);
      }
      if (tag === "pre") out.preCount++;
      else if (tag === "code") out.codeCount++;
      else if (tag === "svg") out.svgCount++;
      else if (tag === "img") out.imageCount++;
      else if (tag === "canvas") out.canvasCount++;
      else if (tag === "video") out.videoCount++;
      else if (tag === "audio") out.audioCount++;
      else if (tag === "script") out.scriptElementCount++;
      else if (tag === "style") out.styleElementCount++;
      else if (tag === "iframe") {
        out.iframeCount++;
        try {
          const doc = (el as HTMLIFrameElement).contentDocument;
          if (doc) out.sameOriginIframeCount++;
        } catch {
          /* cross-origin: counted, not accessed */
        }
      }
      if (el.getAttribute("contenteditable") === "true") out.contentEditableCount++;
      try {
        const shadow = (el as HTMLElement).shadowRoot;
        if (shadow) out.openShadowRootCount++;
      } catch {
        /* ignore */
      }
      try {
        const anims = (el as unknown as { getAnimations?: () => unknown[] }).getAnimations;
        if (typeof anims === "function") {
          const list = anims.call(el);
          if (Array.isArray(list)) out.animationCount += list.length;
        }
      } catch {
        /* ignore */
      }
    }
  }
  try {
    out.stylesheetCount = document.styleSheets.length;
  } catch {
    out.stylesheetCount = 0;
  }
  return out;
}

/**
 * Chunked variant for huge DOMs: yields through idle time (bounded
 * setTimeout fallback) and aborts promptly on `cancel()`. Resolves with the
 * same counts shape as `scanDocumentStructure`.
 */
export function scanDocumentStructureBudgeted(
  root: ParentNode = document,
  cancel: { cancelled: boolean },
  chunkNodes = 20000,
): Promise<DocumentMemoryStructure> {
  const out = zeroDocumentStructure();
  let walker: TreeWalker | null = null;
  try {
    walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  } catch {
    return Promise.resolve(out);
  }
  if (!walker) return Promise.resolve(out);
  const w: TreeWalker = walker;
  let node: Node | null = w.nextNode();
  const idle = (): Promise<void> =>
    new Promise((resolve) => {
      try {
        const ric = (globalThis as unknown as Record<string, unknown>)[
          "requestIdleCallback"
        ];
        if (typeof ric === "function") {
          (ric as (cb: () => void, opts?: object) => void)(() => resolve(), {
            timeout: 50,
          });
          return;
        }
      } catch {
        /* fall through */
      }
      setTimeout(() => resolve(), 0);
    });
  const step = async (): Promise<DocumentMemoryStructure> => {
    let n = 0;
    while (node && n < chunkNodes) {
      if (cancel.cancelled) return out;
      n++;
      const current = node;
      node = w.nextNode();
      if (current.nodeType === 3) {
        out.textNodes++;
        out.totalTextChars += (current.textContent ?? "").length;
      } else if (current.nodeType === 8) {
        out.commentNodes++;
      } else if (current.nodeType === 1) {
        out.elementNodes++;
        const el = current as Element;
        const tag = el.tagName.toLowerCase();
        out.totalAttributeCount += el.attributes.length;
        for (let i = 0; i < el.attributes.length; i++) {
          out.totalAttributeValueChars += el.attributes[i]?.value.length ?? 0;
        }
        if (tag === "pre") out.preCount++;
        else if (tag === "code") out.codeCount++;
        else if (tag === "svg") out.svgCount++;
        else if (tag === "img") out.imageCount++;
        else if (tag === "canvas") out.canvasCount++;
        else if (tag === "video") out.videoCount++;
        else if (tag === "audio") out.audioCount++;
        else if (tag === "script") out.scriptElementCount++;
        else if (tag === "style") out.styleElementCount++;
        else if (tag === "iframe") {
          out.iframeCount++;
          try {
            if ((el as HTMLIFrameElement).contentDocument) {
              out.sameOriginIframeCount++;
            }
          } catch {
            /* cross-origin */
          }
        }
        if (el.getAttribute("contenteditable") === "true") out.contentEditableCount++;
        try {
          if ((el as HTMLElement).shadowRoot) out.openShadowRootCount++;
        } catch {
          /* ignore */
        }
      }
      out.totalNodes++;
    }
    if (cancel.cancelled || !node) {
      try {
        out.stylesheetCount = document.styleSheets.length;
      } catch {
        out.stylesheetCount = 0;
      }
      return out;
    }
    await idle();
    return step();
  };
  return step();
}

// --- media pressure estimates ----------------------------------------------

export interface MediaPressure {
  imageCount: number;
  imageDecodedRgbaEstimateBytes: number;
  imageDecodedRgbaEstimateNote: string;
  canvasCount: number;
  canvasBackingEstimateBytes: number;
  canvasBackingEstimateNote: string;
  videoCount: number;
  sumVideoPixelArea: number;
  maxVideoPixelArea: number;
}

const ESTIMATE_NOTE =
  "estimate, NOT actual browser memory, NOT GPU memory";

export function mediaPressure(root: ParentNode = document): MediaPressure {
  let imageCount = 0;
  let imageBytes = 0;
  let canvasCount = 0;
  let canvasBytes = 0;
  let videoCount = 0;
  let videoArea = 0;
  let videoMax = 0;
  try {
    for (const img of Array.from(root.querySelectorAll("img"))) {
      imageCount++;
      const w = (img as HTMLImageElement).naturalWidth || 0;
      const h = (img as HTMLImageElement).naturalHeight || 0;
      if (w > 0 && h > 0) imageBytes += w * h * 4;
    }
    for (const c of Array.from(root.querySelectorAll("canvas"))) {
      canvasCount++;
      const w = (c as HTMLCanvasElement).width || 0;
      const h = (c as HTMLCanvasElement).height || 0;
      if (w > 0 && h > 0) canvasBytes += w * h * 4;
    }
    for (const v of Array.from(root.querySelectorAll("video"))) {
      videoCount++;
      const w = (v as HTMLVideoElement).videoWidth || 0;
      const h = (v as HTMLVideoElement).videoHeight || 0;
      const area = w * h;
      videoArea += area;
      if (area > videoMax) videoMax = area;
    }
  } catch {
    /* DOM access failure: return partial zeros-safe counts */
  }
  return {
    imageCount,
    imageDecodedRgbaEstimateBytes: imageBytes,
    imageDecodedRgbaEstimateNote: ESTIMATE_NOTE,
    canvasCount,
    canvasBackingEstimateBytes: canvasBytes,
    canvasBackingEstimateNote: ESTIMATE_NOTE,
    videoCount,
    sumVideoPixelArea: videoArea,
    maxVideoPixelArea: videoMax,
  };
}

// --- resource pressure -----------------------------------------------------

export interface ResourceCategoryAggregate {
  count: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
}

export type ResourceAggregates = Record<string, ResourceCategoryAggregate>;

function resourceCategory(initiatorType: string): string {
  switch (initiatorType) {
    case "script":
      return "script";
    case "css":
    case "link":
      return "css/link";
    case "img":
    case "image":
      return "img";
    case "font":
      return "font";
    case "fetch":
      return "fetch";
    case "xmlhttprequest":
      return "xmlhttprequest";
    default:
      return "other";
  }
}

/**
 * Network/resource payload aggregates by initiator category (payload sizes
 * only — NEVER labeled live RAM). No URLs are read or emitted.
 */
export function resourceAggregates(): ResourceAggregates {
  const out: ResourceAggregates = {};
  const add = (cat: string, e: Record<string, unknown>): void => {
    const cur =
      out[cat] ?? { count: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 };
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
    cur.count++;
    cur.transferSize += num(e["transferSize"]);
    cur.encodedBodySize += num(e["encodedBodySize"]);
    cur.decodedBodySize += num(e["decodedBodySize"]);
    out[cat] = cur;
  };
  try {
    const perf = globalThis as unknown as {
      performance?: { getEntriesByType?: (t: string) => unknown[] };
    };
    const entries = perf.performance?.getEntriesByType?.("resource") ?? [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      add(
        resourceCategory(typeof e["initiatorType"] === "string" ? (e["initiatorType"] as string) : ""),
        e,
      );
    }
  } catch {
    /* performance API unavailable */
  }
  return out;
}

// --- regions ---------------------------------------------------------------

export interface RegionMetrics {
  kind: "assistant-turn" | "user-turn" | "writing-block";
  turnIndex: number;
  blockIndex: number;
  nodeCount: number;
  elementCount: number;
  textNodeCount: number;
  textChars: number;
  codeBlockCount: number;
  preCount: number;
  imageCount: number;
  imageDecodedRgbaEstimateBytes: number;
  canvasCount: number;
  canvasBackingEstimateBytes: number;
  svgCount: number;
  iframeCount: number;
  contentEditableCount: number;
  animationCount: number;
  renderedWidth: number;
  renderedHeight: number;
  renderedArea: number;
}

export function regionMetricsFor(
  kind: RegionMetrics["kind"],
  el: HTMLElement,
  turnIndex: number,
  blockIndex: number,
): RegionMetrics {  const m: RegionMetrics = {
    kind,
    turnIndex,
    blockIndex,
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
  };
  try {
    const r = el.getBoundingClientRect();
    m.renderedWidth = Math.max(0, Math.round(r.width));
    m.renderedHeight = Math.max(0, Math.round(r.height));
    m.renderedArea = m.renderedWidth * m.renderedHeight;
  } catch {
    /* geometry unavailable */
  }
  let walker: TreeWalker | null = null;
  try {
    walker = document.createTreeWalker(el, NodeFilter.SHOW_ALL);
  } catch {
    return m;
  }
  if (!walker) return m;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    m.nodeCount++;
    if (node.nodeType === 3) {
      m.textNodeCount++;
      m.textChars += (node.textContent ?? "").length;
    } else if (node.nodeType === 1) {
      m.elementCount++;
      const tag = (node as Element).tagName.toLowerCase();      if (tag === "pre") m.preCount++;
      else if (tag === "code") m.codeBlockCount++;
      else if (tag === "img") {
        m.imageCount++;
        const img = node as HTMLImageElement;
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          m.imageDecodedRgbaEstimateBytes += img.naturalWidth * img.naturalHeight * 4;
        }
      } else if (tag === "canvas") {
        m.canvasCount++;
        const c = node as HTMLCanvasElement;
        if (c.width > 0 && c.height > 0) m.canvasBackingEstimateBytes += c.width * c.height * 4;
      } else if (tag === "svg") m.svgCount++;
      else if (tag === "iframe") m.iframeCount++;
      if ((node as Element).getAttribute("contenteditable") === "true") {
        m.contentEditableCount++;
      }
      // Directly associated animations only (subtree:false avoids double
      // counting descendant animations that ancestors would re-report).
      // Counts only — animation objects are never retained or emitted.
      m.animationCount += countDirectAnimations(node);
    }
  }
  return m;
}

/** Number of animations directly associated with one element (count only). */
function countDirectAnimations(node: Node): number {
  try {
    const target = node as unknown as {
      getAnimations?: (options?: { subtree?: boolean }) => unknown;
    };
    if (typeof target.getAnimations !== "function") return 0;
    let list: unknown = null;
    try {
      list = target.getAnimations({ subtree: false });
    } catch {
      list = target.getAnimations();
    }
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

export interface RegionRankEntry {
  kind: RegionMetrics["kind"];
  turnIndex: number;
  blockIndex: number;
  value: number;
}

export interface RegionRankings {
  topByNodeCount: RegionRankEntry[];
  topByTextChars: RegionRankEntry[];
  topByEstimatedImageBytes: RegionRankEntry[];
  topByEstimatedCanvasBytes: RegionRankEntry[];
  topByRenderedHeight: RegionRankEntry[];
  topByAnimationCount: RegionRankEntry[];
}

const RANK_CAP = 10;

function rank(
  regions: RegionMetrics[],
  pick: (m: RegionMetrics) => number,
): RegionRankEntry[] {
  return regions
    .map((m) => ({
      kind: m.kind,
      turnIndex: m.turnIndex,
      blockIndex: m.blockIndex,
      value: pick(m),
    }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, RANK_CAP);
}

export function rankRegions(regions: RegionMetrics[]): RegionRankings {
  return {
    topByNodeCount: rank(regions, (m) => m.nodeCount),
    topByTextChars: rank(regions, (m) => m.textChars),
    topByEstimatedImageBytes: rank(regions, (m) => m.imageDecodedRgbaEstimateBytes),
    topByEstimatedCanvasBytes: rank(regions, (m) => m.canvasBackingEstimateBytes),
    topByRenderedHeight: rank(regions, (m) => m.renderedHeight),
    topByAnimationCount: rank(regions, (m) => m.animationCount),
  };
}

// --- CGL-owned live state ----------------------------------------------------

export interface CglOwnedState {
  cglHostElementCount: number;
  cglMarkedElementCount: number;
  writingCopyTrackedBlockCount: number;
  writingCopyCopiedRangeCount: number;
  foldingMountedButtonCount: number;
  foldingRetainedTargetCount: number;
  xrayPaintedElementCount: number;
  xrayHostElementCount: number;
  activeObserverCountKnownByCgl: number;
  activeRafCountKnownByCgl: number;
}

export interface CglStateInputs {
  writingCopyTrackedBlockCount: number;
  writingCopyCopiedRangeCount: number;
  foldingMountedButtonCount: number;
  foldingRetainedTargetCount: number;
  activeObserverCountKnownByCgl: number;
  activeRafCountKnownByCgl: number;
}

/** Exact extension-owned live-state counts (DOM-derived + owned inputs). */
export function cglOwnedState(inputs: CglStateInputs): CglOwnedState {
  const count = (selector: string): number => {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  };
  return {
    cglHostElementCount: count(
      '[data-cgl-sidebar-host="true"], [data-cgl-writing-copy-host="true"], [data-cgl-folding-host="true"], [data-cgl-xray-host="true"], #cgl-sidebar-control-host, #cgl-writing-copy-host',
    ),
    cglMarkedElementCount: count(
      "[data-cgl-writing-block], [data-cgl-writing-copy-state], [data-cgl-writing-surface], [data-cgl-sidebar-target], [data-cgl-conversation-root], [data-cgl-active-chat-row], [data-cgl-active-chat-surface], [data-cgl-chat-color-surface], [data-cgl-project-color-surface]",
    ),
    writingCopyTrackedBlockCount: inputs.writingCopyTrackedBlockCount,
    writingCopyCopiedRangeCount: inputs.writingCopyCopiedRangeCount,
    foldingMountedButtonCount: inputs.foldingMountedButtonCount,
    foldingRetainedTargetCount: inputs.foldingRetainedTargetCount,
    xrayPaintedElementCount: count("[data-cgl-xray-assistant-turn], [data-cgl-xray-conversation]"),
    xrayHostElementCount: count('[data-cgl-xray-host="true"]'),
    activeObserverCountKnownByCgl: inputs.activeObserverCountKnownByCgl,
    activeRafCountKnownByCgl: inputs.activeRafCountKnownByCgl,
  };
}

// --- storage size ------------------------------------------------------------

export interface StorageCategorySize {
  keyCount: number;
  approxSerializedChars: number;
}

export interface StorageSizeSummary {
  settings: StorageCategorySize;
  writingCopyHistory: StorageCategorySize;
  conversationAppearance: StorageCategorySize;
  projectAppearance: StorageCategorySize;
  xrayMemorySamples: StorageCategorySize;
  otherCgl: StorageCategorySize;
}

function zeroStorageCategory(): StorageCategorySize {
  return { keyCount: 0, approxSerializedChars: 0 };
}

function storageArea(): chrome.storage.StorageArea | null {
  try {
    const c = globalThis as unknown as { chrome?: { storage?: { local?: chrome.storage.StorageArea } } };
    return c.chrome?.storage?.local ?? null;
  } catch {
    return null;
  }
}

/**
 * One-shot storage size summary (explicit snapshot only). Emits key counts
 * plus approximate serialized chars per prefix category — never key
 * suffixes, never values.
 */
export async function storageSizeSummary(): Promise<StorageSizeSummary> {
  const out: StorageSizeSummary = {
    settings: zeroStorageCategory(),
    writingCopyHistory: zeroStorageCategory(),
    conversationAppearance: zeroStorageCategory(),
    projectAppearance: zeroStorageCategory(),
    xrayMemorySamples: zeroStorageCategory(),
    otherCgl: zeroStorageCategory(),
  };
  const store = storageArea();
  if (!store) return out;
  let all: Record<string, unknown> = {};
  try {
    all = (await store.get(null)) as Record<string, unknown>;
  } catch {
    return out;
  }
  for (const [key, value] of Object.entries(all)) {
    let chars = 0;
    try {
      chars = JSON.stringify(value)?.length ?? 0;
    } catch {
      chars = 0;
    }
    const cat = key.startsWith("cgl:writingCopy:history:")
      ? out.writingCopyHistory
      : key.startsWith("cgl:conversationAppearance:")
        ? out.conversationAppearance
        : key.startsWith("cgl:projectAppearance:")
          ? out.projectAppearance
          : key.startsWith("cgl:xray:memory:")
            ? out.xrayMemorySamples
            : key === "settings"
              ? out.settings
              : key.startsWith("cgl:")
                ? out.otherCgl
                : null;
    if (!cat) continue;
    cat.keyCount++;
    cat.approxSerializedChars += chars;
  }
  return out;
}

// --- memory samples (page comparison) -----------------------------------------

export const MEMORY_SAMPLE_PREFIX = "cgl:xray:memory:";
const MAX_MEMORY_SAMPLE_RECORDS = 50;

export interface MemorySampleRecord {
  pageKey: string;
  sampleTimestamp: number;
  buildId: string;
  uaSpecificBytes: number | null;
  legacyUsedJsHeap: number | null;
  nodeCount: number;
  textChars: number;
  estimatedImageBytes: number;
  estimatedCanvasBytes: number;
  assistantTurnCount: number;
  writingBlockCount: number;
}

export interface MemoryPageComparison {
  records: MemorySampleRecord[];
  topByUaSpecificBytes: MemorySampleRecord[];
  topByLegacyUsedJsHeap: MemorySampleRecord[];
  topByNodeCount: MemorySampleRecord[];
  topByEstimatedImageBytes: MemorySampleRecord[];
  comparisonWarning: string;
}

const COMPARISON_WARNING =
  "JS heap and process memory can be shared or retained across SPA routes; " +
  "compare pages only after a hard reload plus a settled 60s trace. " +
  "UA-specific bytes are unavailable where the platform withholds them.";

/** Shape validator for sample records (exported for focused tests). */
export function isMemorySampleRecordSafeForTest(v: unknown): boolean {
  return isMemorySampleRecordInternal(v);
}

function isMemorySampleRecordInternal(v: unknown): v is MemorySampleRecord {  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["pageKey"] === "string" &&
    typeof r["sampleTimestamp"] === "number" &&
    typeof r["buildId"] === "string" &&
    typeof r["nodeCount"] === "number"
  );
}

/** Load all saved page samples (numeric summaries only). */
export async function loadMemorySamples(): Promise<MemorySampleRecord[]> {
  const store = storageArea();
  if (!store) return [];
  try {
    const all = (await store.get(null)) as Record<string, unknown>;
    const out: MemorySampleRecord[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(MEMORY_SAMPLE_PREFIX) && isMemorySampleRecordInternal(value)) {
        out.push(value);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Save one page sample (explicit user action only). One latest record per
 * page; evicts oldest beyond the bound. Numeric/boolean diagnostics only.
 */
export async function saveMemorySample(record: MemorySampleRecord): Promise<boolean> {
  const store = storageArea();
  if (!store) return false;
  try {
    const key = `${MEMORY_SAMPLE_PREFIX}${record.pageKey}`;
    await store.set({ [key]: record });
    const rest = await loadMemorySamples();
    if (rest.length > MAX_MEMORY_SAMPLE_RECORDS) {
      rest.sort((a, b) => a.sampleTimestamp - b.sampleTimestamp);
      const evict = rest.slice(0, rest.length - MAX_MEMORY_SAMPLE_RECORDS);
      for (const r of evict) {
        await store.remove(`${MEMORY_SAMPLE_PREFIX}${r.pageKey}`);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Delete all saved memory samples (explicit user action only). */
export async function clearMemorySamples(): Promise<boolean> {
  const store = storageArea();
  if (!store) return false;
  try {
    const rest = await loadMemorySamples();
    for (const r of rest) {
      await store.remove(`${MEMORY_SAMPLE_PREFIX}${r.pageKey}`);
    }
    return true;
  } catch {
    return false;
  }
}

function topRecords(
  records: MemorySampleRecord[],
  pick: (r: MemorySampleRecord) => number | null,
): MemorySampleRecord[] {
  return records
    .filter((r) => {
      const v = pick(r);
      return typeof v === "number" && v > 0;
    })
    .sort((a, b) => (pick(b) ?? 0) - (pick(a) ?? 0))
    .slice(0, 10);
}

export function buildPageComparison(
  records: MemorySampleRecord[],
): MemoryPageComparison {
  return {
    records,
    topByUaSpecificBytes: topRecords(records, (r) => r.uaSpecificBytes),
    topByLegacyUsedJsHeap: topRecords(records, (r) => r.legacyUsedJsHeap),
    topByNodeCount: topRecords(records, (r) => r.nodeCount),
    topByEstimatedImageBytes: topRecords(records, (r) => r.estimatedImageBytes),
    comparisonWarning: COMPARISON_WARNING,
  };
}

// --- trace --------------------------------------------------------------------

export interface HeapSample {
  tMs: number;
  usedJSHeapSize: number | null;
  totalJSHeapSize: number | null;
  visibilityState: string;
}

export interface TraceLongTasks {
  longTaskCount: number;
  longTaskTotalDurationMs: number;
  longTaskMaxDurationMs: number;
  bucketTop: number;
  bucketIframe: number;
  bucketUnknown: number;
}

export interface MemoryTraceResult {
  active: boolean;
  samples: HeapSample[];
  startUsedHeap: number | null;
  endUsedHeap: number | null;
  minUsedHeap: number | null;
  maxUsedHeap: number | null;
  deltaBytes: number | null;
  dropPercent: number | null;
  startNodeCount: number | null;
  endNodeCount: number | null;
  nodeDelta: number | null;
  startStructure: DocumentMemoryStructure | null;
  endStructure: DocumentMemoryStructure | null;
  startUa: UaMemoryResult | null;
  endUa: UaMemoryResult | null;
  longTasks: TraceLongTasks;
}

export const TRACE_DURATION_MS = 60000;
export const TRACE_SAMPLE_INTERVAL_MS = 2000;
export const TRACE_MAX_SAMPLES = 31;

function bucketLongTask(entry: unknown): "top" | "iframe" | "unknown" {
  try {
    const e = entry as {
      attribution?: Array<{ containerType?: unknown }>;
    };
    const attribution = Array.isArray(e.attribution) ? e.attribution : [];
    if (attribution.length === 0) return "unknown";
    for (const a of attribution) {
      if (
        typeof a === "object" &&
        a !== null &&
        (a as { containerType?: unknown }).containerType === "iframe"
      ) {
        return "iframe";
      }
    }
    return "top";
  } catch {
    return "unknown";
  }
}

/**
 * Explicit 60s trace controller. Samples lightweight heap data every 2s
 * (never a full DOM scan per sample); full structural snapshots and
 * UA-specific attempts happen at start/end only. LongTask observation
 * lives exactly while the trace is active. All timers/observers released
 * on finish, cancel, or route change.
 */
export class MemoryTrace {
  private timer: ReturnType<typeof setInterval> | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private longTaskObserver: PerformanceObserver | null = null;
  private startedAt = 0;
  private samples: HeapSample[] = [];
  private longTasks: TraceLongTasks = {
    longTaskCount: 0,
    longTaskTotalDurationMs: 0,
    longTaskMaxDurationMs: 0,
    bucketTop: 0,
    bucketIframe: 0,
    bucketUnknown: 0,
  };
  private startStructure: DocumentMemoryStructure | null = null;
  private startUa: UaMemoryResult | null = null;
  private running = false;
  private done: ((result: MemoryTraceResult) => void) | null = null;

  get isRunning(): boolean {
    return this.running;
  }

  /** Begin a trace; resolves with the summary when the 60s elapse. */
  start(): Promise<MemoryTraceResult> {
    this.cancel();
    this.running = true;
    this.startedAt = Date.now();
    this.samples = [];
    this.longTasks = {
      longTaskCount: 0,
      longTaskTotalDurationMs: 0,
      longTaskMaxDurationMs: 0,
      bucketTop: 0,
      bucketIframe: 0,
      bucketUnknown: 0,
    };
    this.startStructure = scanDocumentStructure(document);
    void attemptUaMemory().then((r) => {
      if (this.running) this.startUa = r;
    });
    this.attachLongTaskObserver();
    this.sample();
    this.timer = setInterval(() => this.sample(), TRACE_SAMPLE_INTERVAL_MS);
    this.finishTimer = setTimeout(() => {
      void this.finish().then((result) => {
        const done = this.done;
        this.done = null;
        done?.(result);
      });
    }, TRACE_DURATION_MS);
    return new Promise<MemoryTraceResult>((resolve) => {
      this.done = resolve;
    });
  }

  /** Cancel early; resolves with a partial result. */
  async cancelToResult(): Promise<MemoryTraceResult> {
    const result = await this.finish();
    const done = this.done;
    this.done = null;
    done?.(result);
    return result;
  }

  /** Cancel and release everything without resolving. */
  cancel(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.finishTimer !== null) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    this.detachLongTaskObserver();
    this.running = false;
  }

  private sample(): void {
    if (!this.running) return;
    if (this.samples.length >= TRACE_MAX_SAMPLES) return;
    const heap = legacyJsHeap();
    let visibility = "unknown";
    try {
      if (typeof document !== "undefined" && typeof document.visibilityState === "string") {
        visibility = document.visibilityState;
      }
    } catch {
      /* ignore */
    }
    this.samples.push({
      tMs: Date.now() - this.startedAt,
      usedJSHeapSize: heap?.usedJSHeapSize ?? null,
      totalJSHeapSize: heap?.totalJSHeapSize ?? null,
      visibilityState: visibility.slice(0, 16),
    });
  }

  private attachLongTaskObserver(): void {
    try {
      const PO = (globalThis as unknown as Record<string, unknown>)[
        "PerformanceObserver"
      ] as
        | (new (cb: (list: { getEntries: () => unknown[] }) => void) => {
            observe: (opts: object) => void;
            disconnect: () => void;
          })
        | undefined;
      if (typeof PO !== "function") return;
      const obs = new PO((list) => {
        for (const entry of list.getEntries()) {
          const duration =
            typeof (entry as { duration?: unknown }).duration === "number"
              ? ((entry as { duration: number }).duration as number)
              : 0;
          this.longTasks.longTaskCount++;
          this.longTasks.longTaskTotalDurationMs += duration;
          if (duration > this.longTasks.longTaskMaxDurationMs) {
            this.longTasks.longTaskMaxDurationMs = duration;
          }
          const bucket = bucketLongTask(entry);
          if (bucket === "top") this.longTasks.bucketTop++;
          else if (bucket === "iframe") this.longTasks.bucketIframe++;
          else this.longTasks.bucketUnknown++;
        }
      });
      obs.observe({ type: "longtask", buffered: false });
      this.longTaskObserver = obs as unknown as PerformanceObserver;
    } catch {
      this.longTaskObserver = null;
    }
  }

  private detachLongTaskObserver(): void {
    try {
      this.longTaskObserver?.disconnect();
    } catch {
      /* ignore */
    }
    this.longTaskObserver = null;
  }

  private async finish(): Promise<MemoryTraceResult> {
    const wasRunning = this.running;
    this.cancel();
    const endStructure = wasRunning ? scanDocumentStructure(document) : null;
    const endUa = wasRunning ? await attemptUaMemory() : null;
    const used = this.samples
      .map((s) => s.usedJSHeapSize)
      .filter((v): v is number => typeof v === "number");
    const startUsed = used.length > 0 ? (used[0] as number) : null;
    const endUsed = used.length > 0 ? (used[used.length - 1] as number) : null;
    const minUsed = used.length > 0 ? Math.min(...used) : null;
    const maxUsed = used.length > 0 ? Math.max(...used) : null;
    const delta =
      startUsed !== null && endUsed !== null ? endUsed - startUsed : null;
    const drop =
      delta !== null && startUsed !== null && startUsed > 0
        ? Math.round(((startUsed - endUsed!) / startUsed) * 1000) / 10
        : null;
    const startNodes = this.startStructure?.totalNodes ?? null;
    const endNodes = endStructure?.totalNodes ?? null;
    return {
      active: false,
      samples: [...this.samples],
      startUsedHeap: startUsed,
      endUsedHeap: endUsed,
      minUsedHeap: minUsed,
      maxUsedHeap: maxUsed,
      deltaBytes: delta,
      dropPercent: drop,
      startNodeCount: startNodes,
      endNodeCount: endNodes,
      nodeDelta:
        startNodes !== null && endNodes !== null ? endNodes - startNodes : null,
      startStructure: this.startStructure,
      endStructure: endStructure,
      startUa: this.startUa,
      endUa: endUa,
      longTasks: { ...this.longTasks },
    };
  }
}

// --- composite snapshot ---------------------------------------------------------

export interface MemorySnapshotSections {
  memoryCapabilities: MemoryCapabilities;
  legacyChromiumJsHeap: LegacyJsHeap | null;
  uaMemory: UaMemoryResult | null;
  memoryDocument: DocumentMemoryStructure;
  mediaPressure: MediaPressure;
  resourceAggregates: ResourceAggregates;
  storageSize: StorageSizeSummary;
}

/**
 * Collect per-region metrics for every assistant turn, user turn, and safe
 * WritingBlock (counts only, structural identity only — never content).
 */
export function collectRegions(adapter: ChatGptAdapter): {
  regions: RegionMetrics[];
  rankings: RegionRankings;
} {
  const regions: RegionMetrics[] = [];
  try {
    const container = adapter.detectConversationContainer().element;
    const scope: ParentNode = container ?? document;
    const assistants = Array.from(
      scope.querySelectorAll<HTMLElement>(
        '[data-message-author-role="assistant"], [data-testid="assistant-message"]',
      ),
    ).filter((el) => el instanceof HTMLElement && el.isConnected);
    assistants.forEach((el, i) => {
      regions.push(regionMetricsFor("assistant-turn", el, i, -1));
    });
    const users = Array.from(
      scope.querySelectorAll<HTMLElement>(
        '[data-message-author-role="user"], [data-testid="user-message"]',
      ),
    ).filter((el) => el instanceof HTMLElement && el.isConnected);
    users.forEach((el, i) => {
      regions.push(regionMetricsFor("user-turn", el, i, -1));
    });
  } catch {
    /* detection failure: regions stay partial */
  }
  try {
    for (const block of findSafeWritingBlocks(adapter)) {
      if (!(block instanceof HTMLElement) || !block.isConnected) continue;
      let turnIndex = -1;
      let blockIndex = -1;
      try {
        const identity = deriveBlockIdentity(block, adapter);
        turnIndex = identity.turnIndex;
        blockIndex = identity.blockIndex;
      } catch {
        /* identity failure: keep -1 */
      }
      regions.push(regionMetricsFor("writing-block", block, turnIndex, blockIndex));
    }
  } catch {
    /* detection failure */
  }
  return { regions, rankings: rankRegions(regions) };
}

/** One explicit snapshot: capabilities + heap + structure + media + resources + storage. */
export async function takeMemorySnapshot(): Promise<MemorySnapshotSections> {
  const [ua, storage] = await Promise.all([
    attemptUaMemory(),
    storageSizeSummary(),
  ]);
  return {
    memoryCapabilities: memoryCapabilities(),
    legacyChromiumJsHeap: legacyJsHeap(),
    uaMemory: ua,
    memoryDocument: scanDocumentStructure(document),
    mediaPressure: mediaPressure(document),
    resourceAggregates: resourceAggregates(),
    storageSize: storage,
  };
}
