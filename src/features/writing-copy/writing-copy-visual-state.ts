import type { Settings } from "../../shared/types.js";
import { MARKER_WRITING_COPY_STATE } from "./writing-copy-markers.js";

/**
 * Phase 4 visual layer for the writing-copy feature.
 *
 * Consumes the controller's authoritative semantic state
 * (`data-cgl-writing-copy-state="copied|uncopied"`) and produces presentation:
 *
 *  - ONE shared `Highlight` (CSS Custom Highlight API) whose Ranges cover the
 *    text of currently COPIED WritingBlocks. No spans are created, no text
 *    nodes are replaced, no ChatGPT content is cloned or restructured.
 *  - Presentation CSS variables + root classes on the extension root element
 *    so one settings change restyles every visible matching block.
 *
 * Never retains full block text: a Range references live DOM text only. All
 * registrations, Ranges, and variables are released by `teardown()`, and
 * every mutation is guarded by an epoch so stale async reconciliation can
 * never reapply after teardown/disable/route change/newer generation.
 */

/** Registration name of the extension-owned copied-marker highlight. */
const COPIED_HIGHLIGHT_NAME = "cgl-copied";

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
  has(name: string): boolean;
  clear(): void;
}

function highlights(): HighlightRegistry | null {
  const g = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistry };
  };
  return g.CSS?.highlights ?? null;
}

/** Whether the CSS Custom Highlight API is available in this runtime. */
export function isHighlightApiAvailable(): boolean {
  const g = globalThis as unknown as {
    Range?: unknown;
    Highlight?: unknown;
  };
  return (
    typeof g.Range === "function" &&
    typeof g.Highlight === "function" &&
    highlights() != null
  );
}

/**
 * Build a Range covering ONLY the block's actual text descendants
 * (element/character nodes), never extension controls, native buttons,
 * action labels, or code/pre descendants (excluded upstream by detection).
 */
function buildContentRange(block: HTMLElement): Range | null {
  const range = new Range();

  // NodeFilter.SHOW_TEXT (numeric form keeps test runtimes without the
  // NodeFilter global working — the constant is fixed by the DOM spec).
  const walker = document.createTreeWalker(
    block,
    typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_TEXT : 4,
  );
  let node = walker.nextNode();
  let start: Node | null = null;
  while (node) {
    if ((node.textContent ?? "").length > 0) {
      start = node;
      break;
    }
    node = walker.nextNode();
  }
  if (!start) return null;
  let last: Node | null = null;
  while (node) {
    if ((node.textContent ?? "").length > 0) last = node;
    node = walker.nextNode();
  }
  const end = last ?? start;
  try {
    range.setStartBefore(start);
    range.setEndAfter(end);
    return range;
  } catch {
    return null;
  }
}

export class WritingCopyVisualState {
  private readonly root: HTMLElement;
  /** Live Ranges per block element; released on uncopied/remove/teardown. */
  private ranges = new Map<HTMLElement, Range>();
  /** Presentation generation guard (reuse of the hydration-epoch pattern). */
  private epoch = 0;
  private active = false;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /**
   * Apply presentation settings: root classes + CSS custom properties.
   * Pure presentation — never touches persistent copied records.
   */
  applyPresentation(settings: Settings): void {
    this.epoch++;
    this.active =
      settings.enabled &&
      settings.writingCopy.enabled &&
      isHighlightApiAvailable();
    if (!this.active) {
      this.clearPresentation();
      return;
    }
    const w = settings.writingCopy;
    this.root.classList.add("cgl-active");
    this.root.classList.toggle("cgl-writing-marker-on", w.markerEnabled);
    this.root.classList.toggle("cgl-writing-pulse-on", w.pulseEnabled);
    this.root.style.setProperty("--cgl-copy-marker-color", w.markerColor);
    this.root.style.setProperty(
      "--cgl-copy-marker-opacity",
      String(w.markerOpacity / 100),
    );
    this.root.style.setProperty("--cgl-pulse-color", w.pulseColor);
    this.root.style.setProperty(
      "--cgl-pulse-intensity",
      String(w.pulseIntensity / 100),
    );
    this.root.style.setProperty(
      "--cgl-pulse-period",
      `${w.pulsePeriodMs}ms`,
    );
  }

  /** Remove presentation classes/variables without touching state markers. */
  clearPresentation(): void {
    this.root.classList.remove("cgl-writing-marker-on");
    this.root.classList.remove("cgl-writing-pulse-on");
    for (const v of [
      "--cgl-copy-marker-color",
      "--cgl-copy-marker-opacity",
      "--cgl-pulse-color",
      "--cgl-pulse-intensity",
      "--cgl-pulse-period",
    ]) {
      this.root.style.removeProperty(v);
    }
  }

  /**
   * Reconcile visual state from the current semantic state attributes.
   * Synchronous and idempotent: scans marked blocks, adds/removes Ranges in
   * the shared Highlight, and releases references for disappeared blocks.
   * Returns silently when inactive or when a newer generation superseded us.
   */
  reconcile(doc: Document): void {
    const gen = this.epoch;
    if (!this.active || !isHighlightApiAvailable()) return;
    const registry = highlights();
    if (!registry) return;

    // Release ranges for blocks that vanished.
    for (const el of [...this.ranges.keys()]) {
      if (!el.isConnected || !el.hasAttribute("data-cgl-writing-block")) {
        this.ranges.delete(el);
      }
    }

    // Sync ranges with the semantic COPIED claim.
    const copied = doc.querySelectorAll('[data-cgl-writing-copy-state="copied"]');
    const seen = new Set<Element>();
    for (const el of Array.from(copied)) {
      seen.add(el);
      if (!(el instanceof HTMLElement)) continue;
      if (gen !== this.epoch) return; // superseded mid-reconcile
      if (!this.ranges.has(el)) {
        const r = buildContentRange(el);
        if (r) this.ranges.set(el, r);
      }
    }
    for (const [el, r] of [...this.ranges]) {
      if (!seen.has(el) || !r.startContainer.isConnected) this.ranges.delete(el);
    }

    // Rebuild the single shared Highlight from the live Range map.
    const highlightCtor = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
    const rebuilt = new highlightCtor(...this.ranges.values());
    registry.set(COPIED_HIGHLIGHT_NAME, rebuilt);
  }

  /** Whether the copied-marker Highlight registration currently exists. */
  get isRegistered(): boolean {
    return highlights()?.has(COPIED_HIGHLIGHT_NAME) ?? false;
  }

  /** Number of live copied Ranges currently held. */
  get rangeCount(): number {
    return this.ranges.size;
  }

  /** Full release: registration, Ranges, references, presentation. Idempotent. */
  teardown(): void {
    this.epoch++;
    const registry = highlights();
    registry?.delete(COPIED_HIGHLIGHT_NAME);
    this.ranges.clear();
    this.active = false;
    this.clearPresentation();
  }
}

export { MARKER_WRITING_COPY_STATE };
