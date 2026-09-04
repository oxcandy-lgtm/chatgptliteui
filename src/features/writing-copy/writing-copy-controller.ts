import type { Settings, CopyPosition } from "../../shared/types.js";
import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import { findSafeWritingBlocks } from "./writing-copy-detection.js";
import {
  WritingCopyTracker,
  type ActiveTargetChange,
} from "./writing-copy-tracker.js";
import { WritingCopyHost, HOST_ATTR, type HostStatus } from "./writing-copy-host.js";
import { performCopyDetailed } from "./copy-action.js";
import {
  markWritingBlock,
  clearAllWritingCopyMarkers,
  setWritingCopyState,
  MARKER_WRITING_COPY_STATE,
} from "./writing-copy-markers.js";
import { WRITING_COPY_ROOT_CLASSES } from "./writing-copy-state.js";
import { saveCopiedRecord, getCopiedRecords } from "./copied-state-store.js";
import { fingerprintText } from "./content-fingerprint.js";
import { extractBlockText } from "./copy-action.js";
import {
  deriveBlockIdentity,
  conversationFingerprintFromLocation,
} from "./block-identity.js";
import { WritingCopyVisualState } from "./writing-copy-visual-state.js";

/**
 * Writing-copy controller (Phase 4).
 *
 * Strictly non-destructive. The ONLY permitted mutations on a detected ChatGPT
 * writing block are TWO extension-owned attributes: the boolean marker
 * (`data-cgl-writing-block="true"`) and the semantic state marker
 * (`data-cgl-writing-copy-state="copied|uncopied"`), plus the extension-owned
 * visibility marker maintained by the tracker and an optional guarded
 * background color scoped to the boolean marker under root classes.
 *
 * Responsibilities:
 *  - track the most viewport-centered safe Assistant writing block;
 *  - display exactly one extension-owned Shadow DOM copy button;
 *  - prefer a safely associated original ChatGPT copy action, else call
 *    `navigator.clipboard.writeText` only from a direct user gesture;
 *  - persist a durable copied record ONLY when conversation identity and the
 *    durable save succeed, then immediately reflect the semantic COPIED state;
 *  - hydrate persisted copied state with an epoch guard so a stale hydration
 *    can never apply across route switches, disables, restores, or teardowns;
 *  - drive the separate VISUAL layer (copied Highlight marker + pulse
 *    presentation) from the authoritative semantic state;
 *  - never read the clipboard, never store/log/transmit copied text;
 *  - completely restore the official UI when disabled or torn down.
 *
 * The controller owns its own tracker, host, visual state, and keyboard
 * handler. The content runtime drives `apply`/`refresh`/`teardown` and
 * forwards the shortcut.
 */

export const WRITING_COPY_HOST_ATTR = HOST_ATTR;

/** Serializable controller receipt for the X-Ray AI report (no text/DOM). */
export interface WritingCopyControllerReceipt {
  controllerStarted: boolean;
  enabled: boolean;
  detectedSafeBlockCount: number;
  trackedBlockCount: number;
  visibleBlockCount: number;
  activeBlockSelected: boolean;
  activeBlockIndex: number;
  hostMounted: boolean;
  hostConnected: boolean;
  hostVisible: boolean;
  positionMode: string;
  /** Host's own fixed status enum. */
  hostStatus: string;
  /** First deterministic blocker, or null when nothing blocks the pipeline. */
  mountBlocker: string | null;
}

/**
 * Deterministic copy-host blocker codes, evaluated in causal order. The first
 * matching code wins; `UNKNOWN` only when no specific cause is identifiable.
 */
export function deriveMountBlocker(
  receipt: Omit<WritingCopyControllerReceipt, "mountBlocker"> & {
    /** Host mounted+connected but rendered with no size in the viewport. */
    hostZeroSize: boolean;
  },
): string | null {
  if (!receipt.controllerStarted) return "CONTROLLER_NOT_STARTED";
  if (!receipt.enabled) return "CONTROLLER_NOT_STARTED";
  if (receipt.detectedSafeBlockCount === 0) return "NO_SAFE_BLOCK";
  if (receipt.visibleBlockCount === 0) return "NO_VISIBLE_BLOCK";
  if (!receipt.activeBlockSelected) return "NO_ACTIVE_BLOCK";
  if (!receipt.hostMounted || !receipt.hostConnected) return "HOST_NOT_MOUNTED";
  if (!receipt.hostVisible || receipt.hostZeroSize) return "HOST_ZERO_SIZE";
  return null;
}

/**
 * Copy Transaction Receipt — one bounded, privacy-safe in-memory record that
 * follows ONE user click end-to-end through every stage. Never persisted,
 * never transmitted. No raw text, no fingerprint values, no conversation
 * hashes, no URLs, no stacks — only booleans, enums, indices, error.name.
 */
export interface CopyTransactionReceipt {
  attemptCount: number;
  attemptId: string;
  trigger: "host-button" | "keyboard-shortcut";
  startedAt: number;
  completedAt: number | null;
  targetPresent: boolean;
  targetConnected: boolean;
  documentFocused: boolean | null;
  userActivationIsActive: boolean | null;
  userActivationHasBeenActive: boolean | null;
  originalActionFound: boolean;
  strategy: string | null;
  payloadNonEmpty: boolean;
  clipboardApiAvailable: boolean;
  clipboardWriteAttempted: boolean;
  clipboardWriteResolved: boolean;
  /** ONLY error.name; never message/stack. */
  clipboardErrorName: string | null;
  copyOutcome: "requested" | "copied" | "unavailable" | null;
  conversationIdentityAvailable: boolean;
  blockIdentityValid: boolean;
  turnIndex: number;
  blockIndex: number;
  fingerprintSucceeded: boolean;
  durableSaveAttempted: boolean;
  durableSaveSucceeded: boolean;
  semanticCopiedApplied: boolean;
  visualReconcileRan: boolean;
  copiedRangeCountAfter: number | null;
  failureCode: string | null;
}

function newTransactionReceipt(): CopyTransactionReceipt {
  return {
    attemptCount: 0,
    attemptId: "",
    trigger: "host-button",
    startedAt: 0,
    completedAt: null,
    targetPresent: false,
    targetConnected: false,
    documentFocused: null,
    userActivationIsActive: null,
    userActivationHasBeenActive: null,
    originalActionFound: false,
    strategy: null,
    payloadNonEmpty: false,
    clipboardApiAvailable: false,
    clipboardWriteAttempted: false,
    clipboardWriteResolved: false,
    clipboardErrorName: null,
    copyOutcome: null,
    conversationIdentityAvailable: false,
    blockIdentityValid: false,
    turnIndex: -1,
    blockIndex: -1,
    fingerprintSucceeded: false,
    durableSaveAttempted: false,
    durableSaveSucceeded: false,
    semanticCopiedApplied: false,
    visualReconcileRan: false,
    copiedRangeCountAfter: null,
    failureCode: null,
  };
}

/** Structured result of the durable copied-state save (no values, only flags). */
interface PersistCopiedStateResult {
  conversationIdentityAvailable: boolean;
  blockIdentityValid: boolean;
  turnIndex: number;
  blockIndex: number;
  fingerprintSucceeded: boolean;
  durableSaveAttempted: boolean;
  durableSaveSucceeded: boolean;
  /** CONVERSATION_IDENTITY_UNAVAILABLE | BLOCK_IDENTITY_INVALID |
   *  FINGERPRINT_FAILED | DURABLE_SAVE_FAILED; null on success. */
  failureCode: string | null;
}

/** Detailed persistence outcome consumed by the transaction receipt. */
interface PersistCopiedStateOutcome {
  result: PersistCopiedStateResult;
  receiptFields: () => Partial<CopyTransactionReceipt>;
}

export class WritingCopyController {
  private readonly root: HTMLElement;
  private readonly adapter: ChatGptAdapter;
  private readonly tracker: WritingCopyTracker;
  private readonly host: WritingCopyHost;
  private readonly visuals: WritingCopyVisualState;

  /** Copy Transaction Receipt — current/last click transaction (in-memory). */
  private tx: CopyTransactionReceipt = newTransactionReceipt();
  /** Monotonic attempt counter for the receipt. */
  private attemptCounter = 0;

  private enabled = false;
  private position: CopyPosition = "smart";
  private activeBlock: HTMLElement | null = null;
  /** Whether apply() has started controller activity since construction. */
  private started = false;
  /** Safe-block count from the most recent detection pass. */
  private lastDetectedSafeCount = 0;
  /**
   * Hydration epoch (race guard): every restore/teardown and every new
   * hydration generation invalidates all in-flight hydrations. A hydration
   * applies state or deletes records only while its epoch is still current.
   */
  private hydrationEpoch = 0;

  /** One ResizeObserver for the CURRENT active target only. */
  private activeResizeObserver: ResizeObserver | null = null;
  /** Observed element behind activeResizeObserver; released on teardown. */
  private observedActive: HTMLElement | null = null;
  /** rAF-coalesced geometry update id. */
  private geometryRaf: number | null = null;
  private readonly boundGeometryUpdate = (): void => this.scheduleGeometryUpdate();
  private readonly boundVvScroll = (): void => this.scheduleGeometryUpdate();
  private readonly boundVvResize = (): void => this.scheduleGeometryUpdate();
  private geometryListenersAttached = false;
  private vvListenersAttached = false;

  /** Bound keyboard handler (single reference reused for attach/detach). */
  private readonly keyHandler: (e: KeyboardEvent) => void;

  constructor(root: HTMLElement, adapter: ChatGptAdapter) {
    this.root = root;
    this.adapter = adapter;
    this.tracker = new WritingCopyTracker(adapter);
    this.host = new WritingCopyHost();
    this.visuals = new WritingCopyVisualState(root);

    const onChange: ActiveTargetChange = (target) => {
      this.activeBlock = target;
      this.syncHostToTarget();
      this.observeActiveTarget(target);
    };
    this.tracker.setOnChange(onChange);
    // Cheap post-pass reconciliation of the visual layer after every
    // recalculation (also fires when the target is unchanged).
    this.tracker.setOnRecalculate(() => void this.reconcileVisuals());
    this.keyHandler = (e: KeyboardEvent): void => this.handleKeydown(e);
  }

  // --- public accessors (tests) -------------------------------------------

  get target(): HTMLElement | null {
    return this.activeBlock;
  }

  /** Last (or in-flight) copy transaction receipt. */
  get lastTransaction(): CopyTransactionReceipt {
    return this.tx;
  }

  get isHostMounted(): boolean {
    return this.host.isMounted;
  }

  get isObserving(): boolean {
    return this.tracker.isObserving;
  }

  get candidates(): HTMLElement[] {
    return this.tracker.candidatesList;
  }

  get visualLayer(): WritingCopyVisualState {
    return this.visuals;
  }

  // --- apply / refresh / restore ------------------------------------------

  /**
   * Apply writing-copy settings. No-op (official UI untouched) when disabled.
   * Otherwise re-detect safe blocks, mark them, mount the host, begin
   * tracking the most viewport-centered block, and reconcile the visual layer.
   */
  apply(settings: Settings): void {
    this.restore();
    this.enabled = settings.enabled && settings.writingCopy.enabled;
    this.position = settings.writingCopy.position;
    this.started = this.started || this.enabled;

    if (!this.enabled) {
      this.activeBlock = null;
      this.visuals.applyPresentation(settings);
      return;
    }

    // Without a safe conversation container there is nothing to track and the
    // host must not be mounted (spec: missing container mounts no host).
    if (!this.adapter.detectConversationContainer().element) {
      this.activeBlock = null;
      this.visuals.applyPresentation(settings);
      return;
    }

    this.markSafeBlocks();
    this.visuals.applyPresentation(settings);
    this.applyBackground(settings);
    // ONE shared activation path with refresh(): host mount + geometry
    // listeners are idempotent, so apply and refresh can never diverge again.
    this.ensureOperationalSurface();
    this.tracker.refresh();
    this.syncHostToTarget();
    void this.hydrateState().then(() => this.reconcileVisuals());
  }

  /**
   * Re-detect and rebind after SPA route change or structural mutation.
   *
   * LIFECYCLE RECOVERY: when the first apply() ran before ChatGPT produced a
   * usable conversation container (host intentionally not mounted), a later
   * refresh() must complete the activation — mark blocks, ensure the host is
   * mounted, and ensure geometry listeners exist — before tracker/host sync.
   */
  refresh(settings: Settings): void {
    if (!this.enabled) return;
    if (!this.adapter.detectConversationContainer().element) {
      this.restore();
      return;
    }
    this.markSafeBlocks();
    this.visuals.applyPresentation(settings);
    this.applyBackground(settings);
    this.ensureOperationalSurface();
    this.tracker.refresh();
    this.syncHostToTarget();
    void this.hydrateState().then(() => this.reconcileVisuals());
  }

  /**
   * ONE idempotent operational-activation path shared by apply() and
   * refresh(): exactly one copy host (mounted + click-bound), geometry
   * listeners attached exactly once. No timers, no polling.
   */
  private ensureOperationalSurface(): void {
    this.host.mount(() => void this.onCopyRequested());
    this.attachGeometryListeners();
  }

  private async hydrateState(): Promise<void> {
    const epoch = ++this.hydrationEpoch;
    const conversationFp = await conversationFingerprintFromLocation();
    if (!conversationFp || !this.isHydrationCurrent(epoch)) return;
    const records = await getCopiedRecords(conversationFp);
    if (!this.isHydrationCurrent(epoch)) return;
    const blocks = findSafeWritingBlocks(this.adapter);

    // Compute the exact content fingerprint for every current safe block
    // FIRST, then match on CONTENT IDENTITY. turnIndex/blockIndex are
    // position HINTS only — they may NEVER override a fingerprint match and
    // a hydration miss is observation, never proof for deletion.
    type Entry = {
      block: HTMLElement;
      fingerprint: string | null;
    };
    const entries: Entry[] = [];
    for (const block of blocks) {
      try {
        const fingerprint = await fingerprintText(extractBlockText(block));
        entries.push({ block, fingerprint });
      } catch {
        entries.push({ block, fingerprint: null });
      }
      if (!this.isHydrationCurrent(epoch)) return;
    }

    // Group current blocks by fingerprint; group records by fingerprint.
    const blocksByFp = new Map<string, Entry[]>();
    for (const e of entries) {
      if (!e.fingerprint) continue;
      const list = blocksByFp.get(e.fingerprint);
      if (list) list.push(e);
      else blocksByFp.set(e.fingerprint, [e]);
    }
    const recordsByFp = new Map<string, number>();
    for (const r of records) {
      recordsByFp.set(r.fingerprint, (recordsByFp.get(r.fingerprint) ?? 0) + 1);
    }

    for (const e of entries) {
      if (!this.isHydrationCurrent(epoch) || !e.block.isConnected) continue;

      // Fingerprint unavailable -> UNCOPIED (fail closed), record untouched.
      if (!e.fingerprint) {
        setWritingCopyState(e.block, "uncopied");
        continue;
      }

      const blockCount = blocksByFp.get(e.fingerprint)?.length ?? 0;
      const recordCount = recordsByFp.get(e.fingerprint) ?? 0;

      let copied: boolean;
      if (blockCount === 1) {
        // Normal real case: unique content identity matches regardless of
        // current position. Position hints are ignored entirely here.
        copied = recordCount >= 1;
      } else if (blockCount === recordCount) {
        // Duplicate content with EQUAL durable evidence: the whole group is
        // legitimately copied. No need to distinguish identical blocks.
        copied = true;
      } else {
        // Ambiguous duplicates (unequal counts): fail closed — no positional
        // guessing. Persisted records remain untouched.
        copied = false;
      }
      setWritingCopyState(e.block, copied ? "copied" : "uncopied");
    }
    // NOTE: no storage mutation anywhere in hydration. History cleanup is
    // not hydration's job (Options "Clear copy history" stays the only path).
  }

  /** Whether the given hydration generation is still authoritative. */
  private isHydrationCurrent(epoch: number): boolean {
    return (
      epoch === this.hydrationEpoch &&
      this.enabled &&
      // The runtime document can disappear (teardown, context invalidation);
      // a hydration without a live document must not touch the DOM.
      typeof document !== "undefined"
    );
  }

  /** Recompute the active target immediately (used before a copy action). */
  private currentSafeTarget(): HTMLElement | null {
    return this.tracker.recalculateNow();
  }

  /** Mark all currently safe writing blocks with the extension marker. */
  private markSafeBlocks(): void {
    const safe = findSafeWritingBlocks(this.adapter).filter((el) => el.isConnected);
    this.lastDetectedSafeCount = safe.length;
    for (const el of safe) {
      markWritingBlock(el);
    }
  }

  /**
   * Serializable controller receipt for the X-Ray AI report (structure only:
   * counts and flags, never text or DOM HTML). Uses ACTUAL controller state.
   */
  buildReceipt(): WritingCopyControllerReceipt {
    const tracked = this.tracker.candidatesList;
    const vh = (typeof window !== "undefined" ? window.innerHeight : 0) || 0;
    const visible = tracked.filter((el) => {
      if (!el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh;
    });
    const size = this.host.renderedSize;
    const zeroSize = this.host.isMounted && (!size || size.w <= 0 || size.h <= 0);
    const base: Omit<WritingCopyControllerReceipt, "mountBlocker"> & {
      hostZeroSize: boolean;
      /** Host's own status enum (structural, never DOM-scraped). */
      hostStatus: HostStatus;
    } = {
      controllerStarted: this.started,
      enabled: this.enabled,
      detectedSafeBlockCount: this.lastDetectedSafeCount,
      trackedBlockCount: tracked.length,
      visibleBlockCount: visible.length,
      activeBlockSelected: this.activeBlock != null && this.activeBlock.isConnected,
      activeBlockIndex: tracked.indexOf(this.activeBlock as HTMLElement),
      hostMounted: this.host.isMounted,
      hostConnected: this.host.isMounted && this.host.renderedSize != null,
      hostVisible: this.host.isVisible,
      positionMode: this.position,
      hostStatus: this.host.status,
      hostZeroSize: zeroSize,
    };
    return { ...base, mountBlocker: deriveMountBlocker(base) };
  }

  /** Show/hide + position the host against the active block. */
  private syncHostToTarget(): void {
    if (!this.enabled || !this.activeBlock || !this.activeBlock.isConnected) {
      this.host.setVisible(false);
      this.host.setStatus("none");
      return;
    }
    this.host.positionAgainst(this.activeBlock, this.position);
    this.host.setStatus("none");
  }

  /**
   * Apply the optional guarded writing-block background INDEPENDENTLY of the
   * general custom theme: it activates under writingCopy.backgroundEnabled.
   */
  private applyBackground(settings: Settings): void {
    if (
      settings.enabled &&
      settings.writingCopy.enabled &&
      settings.writingCopy.backgroundEnabled
    ) {
      this.root.classList.add("cgl-writing-copy-active");
      this.root.style.setProperty(
        "--cgl-writing-bg",
        settings.theme.writingBlockBackground,
      );
    } else {
      this.root.classList.remove("cgl-writing-copy-active");
      this.root.style.removeProperty("--cgl-writing-bg");
    }
  }

  // --- visual layer --------------------------------------------------------

  /** Reconcile the copied-marker Highlight from semantic state. */
  private reconcileVisuals(): void {
    // The runtime document can disappear (teardown, context invalidation).
    if (!this.enabled || typeof document === "undefined") return;
    this.visuals.reconcile(document);
  }

  // --- smart-position geometry ---------------------------------------------

  /**
   * Attach scroll/resize/visualViewport listeners EXACTLY ONCE. Idempotent:
   * repeated apply/refresh never accumulates duplicate callbacks.
   */
  private attachGeometryListeners(): void {
    if (this.geometryListenersAttached) return;
    window.addEventListener("scroll", this.boundGeometryUpdate, { passive: true });
    window.addEventListener("resize", this.boundGeometryUpdate);
    this.geometryListenersAttached = true;
    const vv = (
      globalThis as unknown as {
        visualViewport?: {
          addEventListener?: (t: string, l: () => void) => void;
        };
      }
    ).visualViewport;
    if (vv?.addEventListener) {
      vv.addEventListener("scroll", this.boundVvScroll);
      vv.addEventListener("resize", this.boundVvResize);
      this.vvListenersAttached = true;
    }
  }

  /** Detach all geometry listeners (idempotent). */
  private detachGeometryListeners(): void {
    if (this.geometryListenersAttached) {
      window.removeEventListener("scroll", this.boundGeometryUpdate);
      window.removeEventListener("resize", this.boundGeometryUpdate);
      this.geometryListenersAttached = false;
    }
    const vv = (
      globalThis as unknown as {
        visualViewport?: {
          removeEventListener?: (t: string, l: () => void) => void;
        };
      }
    ).visualViewport;
    if (this.vvListenersAttached && vv?.removeEventListener) {
      vv.removeEventListener("scroll", this.boundVvScroll);
      vv.removeEventListener("resize", this.boundVvResize);
      this.vvListenersAttached = false;
    }
  }

  /** Observe ONLY the current active target's size changes (one observer). */
  private observeActiveTarget(target: HTMLElement | null): void {
    if (
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    if (!target) {
      this.activeResizeObserver?.disconnect();
      this.observedActive = null;
      return;
    }
    if (this.observedActive === target) return;
    if (!this.activeResizeObserver) {
      this.activeResizeObserver = new ResizeObserver(() =>
        this.scheduleGeometryUpdate(),
      );
    }
    this.activeResizeObserver.disconnect();
    this.activeResizeObserver.observe(target);
    this.observedActive = target;
  }

  /** rAF-coalesced host repositioning (no work when nothing changes). */
  private scheduleGeometryUpdate(): void {
    if (this.geometryRaf != null) return;
    const raf =
      typeof requestAnimationFrame !== "undefined"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback): number =>
            setTimeout(() => cb(0), 16) as unknown as number;
    this.geometryRaf = raf(() => {
      this.geometryRaf = null;
      if (!this.enabled || !this.activeBlock || !this.activeBlock.isConnected) {
        this.host.setVisible(false);
        return;
      }
      this.host.positionAgainst(this.activeBlock, this.position);
    });
  }

  // --- copy action ---------------------------------------------------------

  /**
   * Begin a NEW transaction receipt at the FIRST synchronous entry of a click
   * (or shortcut) — activation state must be captured before any await.
   */
  private beginTransaction(trigger: CopyTransactionReceipt["trigger"]): void {
    this.attemptCounter++;
    const g = globalThis as unknown as {
      navigator?: {
        userActivation?: { isActive: boolean; hasBeenActive: boolean };
      };
    };
    this.tx = {
      ...newTransactionReceipt(),
      attemptCount: this.attemptCounter,
      attemptId: `attempt-${this.attemptCounter}-${Math.random().toString(36).slice(2, 8)}`,
      trigger,
      startedAt: Date.now(),
      documentFocused:
        typeof document !== "undefined" && typeof document.hasFocus === "function"
          ? document.hasFocus()
          : null,
      userActivationIsActive: g.navigator?.userActivation?.isActive ?? null,
      userActivationHasBeenActive:
        g.navigator?.userActivation?.hasBeenActive ?? null,
    };
  }

  /** Invoked by the Shadow DOM button or the keyboard shortcut (user gesture). */
  private async onCopyRequested(
    trigger: CopyTransactionReceipt["trigger"] = "host-button",
  ): Promise<void> {
    // FIRST synchronous entry: new receipt + activation snapshot.
    this.beginTransaction(trigger);
    this.host.setStatus("idle");
    const target = this.currentSafeTarget();
    this.tx.targetPresent = target != null;
    this.tx.targetConnected = !!target?.isConnected;

    const exec = await performCopyDetailed(() => target, this.adapter);
    this.tx.originalActionFound = exec.originalActionFound;
    this.tx.strategy = exec.strategy;
    this.tx.payloadNonEmpty = exec.payloadNonEmpty;
    this.tx.clipboardApiAvailable = exec.clipboardApiAvailable;
    this.tx.clipboardWriteAttempted = exec.clipboardWriteAttempted;
    this.tx.clipboardWriteResolved = exec.clipboardWriteResolved;
    this.tx.clipboardErrorName = exec.clipboardErrorName;
    this.tx.copyOutcome = exec.outcome;
    if (exec.failureCode) this.tx.failureCode = exec.failureCode;

    switch (exec.outcome) {
      case "requested":
        this.host.setStatus("requested");
        break;
      case "copied": {
        // Durable-first ordering: visible success (check icon + accent) and
        // the "Copied." announcement must NEVER precede durable persistence
        // and marker verification. Clipboard success alone is not success.
        const persisted = await this.persistCopiedStateDetailed(target);
        Object.assign(this.tx, persisted.receiptFields());
        if (persisted.result.durableSaveSucceeded && target) {
          setWritingCopyState(target, "copied");
        } else if (target) {
          setWritingCopyState(target, "uncopied");
          this.tx.failureCode = persisted.result.failureCode;
        }
        // Verify the ACTUAL semantic state; never assume the setter worked.
        this.tx.semanticCopiedApplied =
          !!target && target.getAttribute(MARKER_WRITING_COPY_STATE) === "copied";
        this.reconcileVisuals();
        this.tx.visualReconcileRan = true;
        this.tx.copiedRangeCountAfter = this.visuals.rangeCount;
        if (
          this.tx.semanticCopiedApplied &&
          (this.tx.copiedRangeCountAfter ?? 0) < 1
        ) {
          this.tx.failureCode = "COPYMARKER_RANGE_MISSING";
        }
        // Success feedback ONLY on genuine durable copy: saved + semantic +
        // marker range + no failure anywhere. Anything else is a neutral
        // non-success state (the hidden status must not announce "Copied.").
        if (
          persisted.result.durableSaveSucceeded &&
          this.tx.semanticCopiedApplied &&
          (this.tx.copiedRangeCountAfter ?? 0) >= 1 &&
          this.tx.failureCode == null
        ) {
          this.host.setStatus("copied");
        } else {
          this.host.setStatus("unavailable");
        }
        break;
      }
      case "unavailable":
      default:
        this.host.setStatus("unavailable");
        break;
    }
    this.tx.completedAt = Date.now();
  }

  /**
   * Durable-save path reporting WHY it failed. Values stay local; only
   * booleans/enums/indices are reported. Invariant unchanged: clipboard
   * success alone NEVER implies semantic COPIED.
   */
  private async persistCopiedStateDetailed(
    target: HTMLElement | null,
  ): Promise<PersistCopiedStateOutcome> {
    const result: PersistCopiedStateResult = {
      conversationIdentityAvailable: false,
      blockIdentityValid: false,
      turnIndex: -1,
      blockIndex: -1,
      fingerprintSucceeded: false,
      durableSaveAttempted: false,
      durableSaveSucceeded: false,
      failureCode: null,
    };

    const fields = (
      code: string | null,
    ): Partial<CopyTransactionReceipt> => ({
      conversationIdentityAvailable: result.conversationIdentityAvailable,
      blockIdentityValid: result.blockIdentityValid,
      turnIndex: result.turnIndex,
      blockIndex: result.blockIndex,
      fingerprintSucceeded: result.fingerprintSucceeded,
      durableSaveAttempted: result.durableSaveAttempted,
      durableSaveSucceeded: result.durableSaveSucceeded,
      ...(code ? { failureCode: code } : {}),
    });
    const fail = (code: string): PersistCopiedStateOutcome => ({
      result: { ...result, failureCode: code },
      receiptFields: () => fields(code),
    });

    if (!target) return fail("BLOCK_IDENTITY_INVALID");
    try {
      const conversationFp = await conversationFingerprintFromLocation();
      result.conversationIdentityAvailable = conversationFp != null;
      if (!conversationFp) return fail("CONVERSATION_IDENTITY_UNAVAILABLE");

      const identity = deriveBlockIdentity(target, this.adapter);
      result.turnIndex = identity.turnIndex;
      result.blockIndex = identity.blockIndex;
      result.blockIdentityValid =
        identity.turnIndex >= 0 && identity.blockIndex >= 0;
      if (!result.blockIdentityValid) return fail("BLOCK_IDENTITY_INVALID");

      let fingerprint: string;
      try {
        fingerprint = await fingerprintText(extractBlockText(target));
        result.fingerprintSucceeded = true;
      } catch {
        return fail("FINGERPRINT_FAILED");
      }

      result.durableSaveAttempted = true;
      result.durableSaveSucceeded = await saveCopiedRecord(conversationFp, {
        turnIndex: identity.turnIndex,
        blockIndex: identity.blockIndex,
        fingerprint,
        copiedAt: Date.now(),
      });
      if (!result.durableSaveSucceeded) return fail("DURABLE_SAVE_FAILED");
      return { result, receiptFields: () => fields(null) };
    } catch {
      return fail(
        result.fingerprintSucceeded ? "DURABLE_SAVE_FAILED" : "FINGERPRINT_FAILED",
      );
    }
  }

  // --- keyboard shortcut ---------------------------------------------------

  /**
   * Fixed shortcut `Alt+Shift+C`. Called by the content runtime's global
   * keydown listener (which already validated enabled state, repeat,
   * composition, and event origin). Re-checks the exact modifier match and a
   * currently safe target, then calls preventDefault and performs the copy via
   * the same path as the Shadow DOM button.
   */
  handleKeydown(e: KeyboardEvent): void {
    const match =
      e.altKey &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      e.code === "KeyC";
    if (!match) return;
    const target = this.currentSafeTarget();
    if (!target) return; // no preventDefault without a safe target
    e.preventDefault();
    void this.onCopyRequested("keyboard-shortcut");
  }

  /** Whether the shortcut listener should currently be attached. */
  isShortcutActive(settings: Settings): boolean {
    return (
      settings.enabled &&
      settings.writingCopy.enabled &&
      settings.writingCopy.shortcutEnabled
    );
  }

  // --- teardown / restore --------------------------------------------------

  /** Completely restore the official ChatGPT UI. Idempotent. */
  restore(): void {
    // Invalidate any in-flight hydration: a stale generation must never apply
    // state markers or delete records after restore/teardown.
    this.hydrationEpoch++;
    for (const cls of WRITING_COPY_ROOT_CLASSES) {
      this.root.classList.remove(cls);
    }
    clearAllWritingCopyMarkers(document);
    this.visuals.teardown();
    this.detachGeometryListeners();
    if (this.geometryRaf != null) {
      const caf =
        typeof cancelAnimationFrame !== "undefined"
          ? cancelAnimationFrame
          : clearTimeout;
      caf(this.geometryRaf);
      this.geometryRaf = null;
    }
    this.observeActiveTarget(null);
    this.activeResizeObserver = null;
    this.observedActive = null;
    this.activeBlock = null;
    this.host.setVisible(false);
    this.host.setStatus("idle");
    this.host.unmount();
    this.tracker.teardown();
  }

  /** Tear down observers, host, listeners, and references. */
  teardown(): void {
    this.restore();
    this.enabled = false;
    this.position = "smart";
  }

  /** Expose the handler reference so the runtime can attach/detach it. */
  get keyboardHandler(): (e: KeyboardEvent) => void {
    return this.keyHandler;
  }
}
