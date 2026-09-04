/**
 * CGL X-Ray — maintenance controller.
 *
 * A self-diagnostic maintenance port for dissecting the CURRENT live ChatGPT
 * DOM. OFF by default, completely local (no network, no telemetry, no
 * storage, no clipboard read), activated ONLY by the exact shortcut
 * Alt+Shift+X; pressing it again tears everything down. The heartbeat never
 * depends on ChatGPT selectors succeeding.
 *
 * While active it:
 *  - runs the structural scan and paints detected structures with temporary,
 *    extension-owned diagnostic markers (all removed on close);
 *  - offers the one-shot element picker (the diagnostic click is swallowed);
 *  - writes the privacy-safe `cgl-xray-v1` AI report to the clipboard ONLY
 *    from the direct "Copy AI report" button gesture (never reads clipboard);
 *  - exposes the live runtime state for the panel.
 */

import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import { WRITING_FALLBACK_STRATEGY_ID } from "../../adapters/chatgpt-adapter.js";
import type { Settings } from "../../shared/types.js";
import { STRATEGIES, resolveStrategy } from "../../adapters/selectors.js";
import {
  evaluateWritingBlockCandidate,
} from "../writing-copy/writing-copy-detection.js";
import { runXrayScan, type XrayScan } from "./xray-scan.js";
import {
  buildXrayReport,
  diagnose,
  type PickedTargetInfo,
} from "./xray-report.js";
import { XrayHost, XRAY_HOST_ATTR, type XrayStatusInput } from "./xray-host.js";
import { isInvalidatedLatched } from "../../shared/runtime-health.js";
import type {
  WritingCopyControllerReceipt,
  CopyTransactionReceipt,
} from "../writing-copy/writing-copy-controller.js";
import type { FoldingReceipt } from "../folding/folding-controller.js";

/** Extension-owned diagnostic paint attributes (X-Ray-only, removed on close). */
const PAINT_ASSISTANT_TURN = "data-cgl-xray-assistant-turn";
const PAINT_CONVERSATION = "data-cgl-xray-conversation";
const PAINT_RAW_CANDIDATE = "data-cgl-xray-raw-candidate";
const PAINT_SAFE_BLOCK = "data-cgl-xray-safe-block";
const PAINT_REJECTED = "data-cgl-xray-rejected";
const PAINT_EDITABLE = "data-cgl-xray-editable";
const PAINT_ACTION = "data-cgl-xray-action";
const PAINT_PICKED = "data-cgl-xray-picked";

const ALL_PAINT_ATTRS = [
  PAINT_ASSISTANT_TURN,
  PAINT_CONVERSATION,
  PAINT_RAW_CANDIDATE,
  PAINT_SAFE_BLOCK,
  PAINT_REJECTED,
  PAINT_EDITABLE,
  PAINT_ACTION,
  PAINT_PICKED,
] as const;

export const ALL_XRAY_PAINT_ATTRS = ALL_PAINT_ATTRS;
export const XRAY_PAINT_SELECTOR = ALL_PAINT_ATTRS.map((a) => `[${a}]`).join(",");

/** Whether the exact Alt+Shift+X shortcut matches a keydown event. */
export function isXrayShortcut(e: {
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  code: string;
}): boolean {
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyX";
}

export interface XrayDeps {
  /** Extension root element (document.documentElement) for the guard class. */
  root: HTMLElement;
  adapter: ChatGptAdapter;
  /** Latest validated settings (already loaded by the content runtime). */
  getSettings: () => Settings | null;
  /**
   * Live Writing Copy controller receipt accessor (wired by the content
   * runtime; optional so unit tests can omit it).
   */
  getWritingCopyControllerReceipt?: () => WritingCopyControllerReceipt | null;
  /** Live last-copy-transaction accessor (optional; tests may omit). */
  getCopyTransaction?: () => CopyTransactionReceipt | null;
  /** Live folding HUD receipt accessor (optional; tests may omit). */
  getFoldingReceipt?: () => FoldingReceipt | null;
}

/** Root class guarding ALL diagnostic paint CSS (present only while active). */
export const XRAY_ROOT_CLASS = "cgl-xray-on";

export class XrayController {
  private readonly host = new XrayHost();
  private readonly root: HTMLElement;
  private readonly adapter: ChatGptAdapter;
  private readonly getSettings: () => Settings | null;
  private readonly getWritingCopyControllerReceipt:
    | (() => WritingCopyControllerReceipt | null)
    | null;
  private readonly getCopyTransaction:
    | (() => CopyTransactionReceipt | null)
    | null;
  private readonly getFoldingReceipt: (() => FoldingReceipt | null) | null;

  private active = false;
  private pickerMode = false;
  private picked: PickedTargetInfo | null = null;
  private lastScan: XrayScan | null = null;
  private deepScanIncluded = false;

  private readonly boundPointerMove = (e: PointerEvent): void => {
    if (!this.pickerMode) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) {
      this.host.showPickerBox(null);
      return;
    }
    // Never outline our own host UI.
    if (el.closest(`[${XRAY_HOST_ATTR}]`)) return;
    const r = el.getBoundingClientRect();
    this.host.showPickerBox({ x: r.x, y: r.y, w: r.width, h: r.height });
  };

  private readonly boundClick = (e: MouseEvent): void => {
    if (!this.pickerMode) return;
    // Capture-phase listener: swallows this one diagnostic click so the site's
    // own handlers never fire for it.
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    if (target instanceof Element) this.capturePicked(target);
    this.exitPickerMode();
  };

  private readonly boundEscape = (e: KeyboardEvent): void => {
    if (!this.pickerMode) return;
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    this.exitPickerMode();
  };

  constructor(deps: XrayDeps) {
    this.root = deps.root;
    this.adapter = deps.adapter;
    this.getSettings = deps.getSettings;
    this.getWritingCopyControllerReceipt =
      deps.getWritingCopyControllerReceipt ?? null;
    this.getCopyTransaction = deps.getCopyTransaction ?? null;
    this.getFoldingReceipt = deps.getFoldingReceipt ?? null;
  }

  // --- state accessors -----------------------------------------------------

  get isActive(): boolean {
    return this.active;
  }

  get isPicking(): boolean {
    return this.pickerMode;
  }

  get pickedTarget(): PickedTargetInfo | null {
    return this.picked;
  }

  get scan(): XrayScan | null {
    return this.lastScan;
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Handle a validated Alt+Shift+X press. Safety chain (repeat / composition /
   * editable origin) is applied by the content runtime before this call.
   */
  handleKeydown(): void {
    this.toggle();
  }

  /** Toggle X-Ray ON/OFF. OFF performs complete cleanup. */
  toggle(): void {
    if (this.active) this.stop();
    else this.start();
  }

  private start(): void {
    if (this.active) return;
    this.active = true;
    this.root.classList.add(XRAY_ROOT_CLASS);
    this.host.mount({
      refresh: () => this.refresh(),
      pick: () => this.togglePicker(),
      copy: () => void this.copyReport(),
      deep: () => {
        this.deepScanIncluded = true;
        this.refresh();
      },
      close: () => this.stop(),
    });
    this.refresh();
  }

  /** Turn X-Ray OFF and remove every trace (heartbeat, panel, paint, picker). */
  stop(): void {
    if (!this.active && !this.host.isMounted) return;
    this.exitPickerMode();
    this.active = false;
    this.picked = null;
    this.lastScan = null;
    this.deepScanIncluded = false;
    this.clearPaint();
    this.root.classList.remove(XRAY_ROOT_CLASS);
    this.host.unmount();
  }

  /** Re-run the structural scan, repaint, and update the panel. */
  refresh(): void {
    if (!this.active) return;
    const settings = this.getSettings();
    this.lastScan = runXrayScan(
      this.adapter,
      {
        enabled: settings?.enabled ?? false,
        writingCopyEnabled: settings?.writingCopy.enabled ?? false,
      },
      this.getControllerReceipt(),
      this.getCopyTransactionSafe(),
      this.getFoldingReceiptSafe(),
    );
    this.paint();
    this.host.setStatus(this.statusRows(this.lastScan));
  }

  /** Live Writing Copy controller receipt, or null when not wired. */
  private getControllerReceipt(): WritingCopyControllerReceipt | null {
    if (!this.getWritingCopyControllerReceipt) return null;
    try {
      return this.getWritingCopyControllerReceipt();
    } catch {
      return null;
    }
  }

  /** Live last copy transaction, or null when not wired. */
  private getCopyTransactionSafe(): CopyTransactionReceipt | null {
    if (!this.getCopyTransaction) return null;
    try {
      return this.getCopyTransaction();
    } catch {
      return null;
    }
  }

  /** Live folding HUD receipt, or null when not wired. */
  private getFoldingReceiptSafe(): FoldingReceipt | null {
    if (!this.getFoldingReceipt) return null;
    try {
      return this.getFoldingReceipt();
    } catch {
      return null;
    }
  }

  // --- paint ---------------------------------------------------------------

  /** Paint detected structures with temporary diagnostic markers. */
  private paint(): void {
    this.clearPaint();
    const container = this.adapter.detectConversationContainer().element;
    if (container) container.setAttribute(PAINT_CONVERSATION, "true");

    for (const t of Array.from(
      document.querySelectorAll(
        '[data-message-author-role="assistant"], [data-testid="assistant-message"]',
      ),
    )) {
      t.setAttribute(PAINT_ASSISTANT_TURN, "turn");
    }

    for (const { element } of this.collectRawCandidates()) {
      element.setAttribute(PAINT_RAW_CANDIDATE, "true");
      const evaluation = evaluateWritingBlockCandidate(element, this.adapter);
      if (evaluation.accepted) element.setAttribute(PAINT_SAFE_BLOCK, "true");
      else element.setAttribute(PAINT_REJECTED, "true");
    }

    for (const el of Array.from(
      document.querySelectorAll(
        '[data-message-author-role="assistant"] [contenteditable], [data-testid="assistant-message"] [contenteditable], [data-message-author-role="assistant"] [role="textbox"], [data-testid="assistant-message"] [role="textbox"], [data-message-author-role="assistant"] textarea, [data-testid="assistant-message"] textarea',
      ),
    )) {
      el.setAttribute(PAINT_EDITABLE, "true");
    }
    for (const el of Array.from(
      document.querySelectorAll(
        '[data-message-author-role="assistant"] button, [data-testid="assistant-message"] button, [data-message-author-role="assistant"] [role="button"], [data-testid="assistant-message"] [role="button"]',
      ),
    )) {
      el.setAttribute(PAINT_ACTION, "true");
    }

    if (this.picked) this.picked.element.setAttribute(PAINT_PICKED, "true");
  }

  /** Remove every diagnostic paint attribute. Idempotent. */
  clearPaint(): void {
    for (const attr of ALL_PAINT_ATTRS) {
      document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
    }
  }

  /** Union of raw writing candidates across ALL writing strategies. */
  private collectRawCandidates(): { element: Element; strategyId: string }[] {
    const container =
      this.adapter.detectConversationContainer().element ?? document;
    const raw: { element: Element; strategyId: string }[] = [];
    const seen = new Set<Element>();
    for (const strategy of STRATEGIES.writingBlock) {
      for (const el of resolveStrategy("writingBlock", strategy, container)) {
        if (!seen.has(el)) {
          seen.add(el);
          raw.push({ element: el, strategyId: strategy.id });
        }
      }
    }
    // Structural anchored editors join the diagnostic union exactly when
    // production detection used the fallback (same rule as the scan).
    const writingDetection = this.adapter.detectWritingBlocks(container);
    if (
      writingDetection.found &&
      writingDetection.strategy === WRITING_FALLBACK_STRATEGY_ID
    ) {
      for (const el of writingDetection.elements) {
        if (!seen.has(el)) {
          seen.add(el);
          raw.push({ element: el, strategyId: WRITING_FALLBACK_STRATEGY_ID });
        }
      }
    }
    return raw;
  }

  // --- picker --------------------------------------------------------------

  private togglePicker(): void {
    if (this.pickerMode) this.exitPickerMode();
    else this.enterPickerMode();
  }

  private enterPickerMode(): void {
    if (!this.active || this.pickerMode) return;
    this.pickerMode = true;
    this.host.setPickerMode(true);
    document.addEventListener("pointermove", this.boundPointerMove, true);
    document.addEventListener("click", this.boundClick, true);
    document.addEventListener("keydown", this.boundEscape, true);
  }

  private exitPickerMode(): void {
    if (!this.pickerMode) return;
    this.pickerMode = false;
    this.host.setPickerMode(false);
    document.removeEventListener("pointermove", this.boundPointerMove, true);
    document.removeEventListener("click", this.boundClick, true);
    document.removeEventListener("keydown", this.boundEscape, true);
  }

  /** Capture the picked element + ancestor boundary for the report. */
  private capturePicked(el: Element): void {
    const turn = el.closest(
      '[data-message-author-role="assistant"], [data-testid="assistant-message"]',
    );
    const container = this.adapter.detectConversationContainer().element;
    this.picked = { element: el, boundary: turn ?? container };
    el.setAttribute(PAINT_PICKED, "true");
  }

  // --- report --------------------------------------------------------------

  /** Build the serialized report (used by tests and the copy action). */
  buildReport(): string {
    const scan = this.lastScan ?? this.scanNow();
    const report = buildXrayReport(
      scan,
      { containerElement: this.adapter.detectConversationContainer().element },
      this.picked,
      { includeDeepTree: this.deepScanIncluded },
    );
    return JSON.stringify(report, null, 2);
  }

  private scanNow(): XrayScan {
    const settings = this.getSettings();
    return runXrayScan(
      this.adapter,
      {
        enabled: settings?.enabled ?? false,
        writingCopyEnabled: settings?.writingCopy.enabled ?? false,
      },
      this.getControllerReceipt(),
      this.getCopyTransactionSafe(),
      this.getFoldingReceiptSafe(),
    );
  }

  /**
   * Write the AI report to the clipboard. Called ONLY from the direct
   * "Copy AI report" button gesture. Never reads the clipboard.
   */
  private async copyReport(): Promise<void> {
    const serialized = this.buildReport();
    try {
      if (
        typeof navigator === "undefined" ||
        typeof navigator.clipboard?.writeText !== "function"
      ) {
        return;
      }
      await navigator.clipboard.writeText(serialized);
    } catch {
      // Clipboard write may be refused; no retry, no execCommand fallback.
    }
  }

  // --- panel status --------------------------------------------------------

  private statusRows(scan: XrayScan): XrayStatusInput {
    const rt = scan.runtime;
    const wp = scan.writingPipeline;
    const health = scan.runtimeHealth;
    const invalidated = isInvalidatedLatched();

    // Visible runtime status line — obvious without reading JSON.
    const buildShort = health.buildId.split("+")[1] ?? health.buildId;
    const bootShort = health.contentScriptBootId.replace(/^boot-/, "").slice(0, 6);
    const runtimeLabel = invalidated
      ? "RUNTIME RED — EXTENSION CONTEXT INVALIDATED"
      : rt.extensionRuntimeOk
        ? "RUNTIME GREEN"
        : "RUNTIME RED";
    const runtimeTone = invalidated || !rt.extensionRuntimeOk ? "fail" : "pass";

    const rows: XrayStatusInput["rows"] = [
      { k: "BUILD", v: buildShort },
      { k: "BOOT", v: bootShort },
      { k: "RUNTIME", v: runtimeLabel, tone: runtimeTone },
      ...(health.duplicateOrStaleContentScript
        ? [{ k: "BOOT IDS", v: "DUPLICATE_OR_STALE_CONTENT_SCRIPT", tone: "fail" as const }]
        : []),
      ...(invalidated
        ? [{ k: "context", v: "STALE EXTENSION CONTEXT", tone: "fail" as const }]
        : [{ k: "context", v: health.extensionContextValid ? "valid" : "unknown", tone: health.extensionContextValid ? ("pass" as const) : ("warn" as const) }]),
      ...(health.storageProbeOk === true
        ? [{ k: "storage probe", v: "ok", tone: "pass" as const }]
        : health.storageProbeOk === false
          ? [{ k: "storage probe", v: "FAIL", tone: "fail" as const }]
          : [{ k: "storage probe", v: "n/a" }]),
      ...(health.internalErrorCount > 0
        ? [{ k: "internal errors", v: String(health.internalErrorCount), tone: "warn" as const }]
        : []),
      { k: "extension enabled", v: String(rt.extensionEnabled), tone: rt.extensionEnabled ? "pass" : "warn" },
      { k: "writing copy enabled", v: String(rt.writingCopyEnabled), tone: rt.writingCopyEnabled ? "pass" : "warn" },
      { k: "route shape", v: rt.route.shape },
      { k: "conv identity", v: rt.route.conversationIdentityAvailable ? "yes" : "no", tone: rt.route.conversationIdentityAvailable ? "pass" : "warn" },
      { k: "conversation container", v: scan.conversationContainerFound ? "found" : "NOT FOUND", tone: scan.conversationContainerFound ? "pass" : "fail" },
      ...(scan.containerFallback.attempted
        ? [
            {
              k: "container fallback",
              v: `${scan.containerFallback.accepted ? "ACCEPTED" : scan.containerFallback.rejectionReason ?? "rejected"} (${scan.containerFallback.userAnchorCount}u/${scan.containerFallback.assistantAnchorCount}a)`,
            },
          ]
        : [{ k: "container strategy", v: scan.conversationContainerStrategyId ?? "?" }]),
      ...(scan.writingBlockFallback.attempted
        ? [
            {
              k: "writing fallback",
              v: `${scan.writingBlockFallback.found ? "FOUND" : scan.writingBlockFallback.rejectionReason ?? "rejected"} (${scan.writingBlockFallback.headerAnchorCount} anchors / ${scan.writingBlockFallback.pairCount} pairs${scan.writingBlockFallback.ambiguousCount > 0 ? ` / ${scan.writingBlockFallback.ambiguousCount} ambiguous` : ""})`,
              tone: scan.writingBlockFallback.found ? ("pass" as const) : ("warn" as const),
            },
          ]
        : []),
      { k: "assistant turns", v: String(scan.assistantTurnCount) },
      { k: "user turns", v: String(scan.userTurnCount) },
      { k: "raw candidates", v: String(wp.rawCandidateCount) },
      ...(wp.rejectedCount > 0
        ? [{ k: "rejected", v: String(wp.rejectedCount), tone: "warn" as const }]
        : []),
      { k: "safe blocks", v: String(wp.safeCount), tone: wp.safeCount > 0 ? "pass" : "fail" },
      { k: "editable regions", v: String(rt.editableRegionCount) },
      { k: "action controls", v: String(rt.actionControlCount) },
      { k: "copy host count", v: String(rt.extensionCopyHostCount) },
      { k: "copied/uncopied", v: `${rt.semanticCopiedCount}/${rt.semanticUncopiedCount}` },
      { k: "Highlight API", v: rt.highlightApiSupported ? "supported" : "unsupported", tone: rt.highlightApiSupported ? "pass" : "warn" },
    ];
    if (rt.copiedRangeCount != null) {
      rows.push({ k: "cgl-copied ranges", v: String(rt.copiedRangeCount) });
    }
    rows.push({
      k: "generating indicator",
      v: rt.generatingIndicatorPresent ? "present" : "absent",
    });
    if (this.picked) rows.push({ k: "picked target", v: "captured" });
    if (scan.writingCopyController) {
      const c = scan.writingCopyController;
      rows.push(
        { k: "controller started/enabled", v: `${c.controllerStarted}/${c.enabled}` },
        { k: "safe/tracked/visible", v: `${c.detectedSafeBlockCount}/${c.trackedBlockCount}/${c.visibleBlockCount}` },
        { k: "active block", v: c.activeBlockSelected ? `#${c.activeBlockIndex}` : "none" },
        { k: "host mounted/visible", v: `${c.hostMounted && c.hostConnected}/${c.hostVisible}` },
        { k: "host status", v: c.hostStatus },
        ...(c.mountBlocker
          ? [{ k: "mount blocker", v: c.mountBlocker, tone: "fail" as const }]
          : []),
      );
    }
    const tx = scan.copyTransaction;
    if (tx && tx.attemptCount > 0) {
      rows.push(
        { k: "copy attempts", v: String(tx.attemptCount) },
        { k: "copy trigger", v: tx.trigger },
        { k: "activation", v: tx.userActivationIsActive == null ? "n/a" : tx.userActivationIsActive ? "active" : "inactive" },
        { k: "copy strategy", v: tx.strategy ?? "none" },
        ...(tx.clipboardWriteAttempted
          ? [{ k: "clipboard write", v: tx.clipboardWriteResolved ? "resolved" : `REJECTED${tx.clipboardErrorName ? ` (${tx.clipboardErrorName})` : ""}`, tone: tx.clipboardWriteResolved ? ("pass" as const) : ("fail" as const) }]
          : []),
        ...(tx.durableSaveAttempted
          ? [{ k: "durable save", v: tx.durableSaveSucceeded ? "ok" : "FAIL", tone: tx.durableSaveSucceeded ? ("pass" as const) : ("fail" as const) }]
          : [{ k: "durable save", v: "not attempted" }]),
        { k: "semantic copied", v: String(tx.semanticCopiedApplied) },
        { k: "ranges after", v: String(tx.copiedRangeCountAfter ?? "?") },
        ...(tx.failureCode
          ? [{ k: "failure code", v: tx.failureCode, tone: "fail" as const }]
          : []),
      );
    }

    const d = diagnose(scan);
    const blocker = d.firstBlocker
      ? `BLOCKER: ${d.firstBlocker}`
      : `OK: ${d.summary}`;
    return { rows, blocker, pickerActive: this.pickerMode };
  }
}
