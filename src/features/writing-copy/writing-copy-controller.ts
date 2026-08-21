import type { Settings, CopyPosition } from "../../shared/types.js";
import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import { findSafeWritingBlocks } from "./writing-copy-detection.js";
import {
  WritingCopyTracker,
  type ActiveTargetChange,
} from "./writing-copy-tracker.js";
import { WritingCopyHost, HOST_ATTR } from "./writing-copy-host.js";
import { performCopy } from "./copy-action.js";
import {
  markWritingBlock,
  clearAllWritingCopyMarkers,
} from "./writing-copy-markers.js";
import {
  hasWritingCopyEffects,
  isWritingBlockBackgroundActive,
  WRITING_COPY_ROOT_CLASSES,
} from "./writing-copy-state.js";

/**
 * Writing-copy controller (Phase 4).
 *
 * Strictly non-destructive. The ONLY permitted mutation on a detected ChatGPT
 * writing block is ONE extension-owned boolean marker
 * (`data-cgl-writing-block="true"`), plus an optional guarded background color
 * scoped to that marker under the `cgl-writing-copy-active` root class.
 *
 * Responsibilities:
 *  - track the most viewport-centered safe Assistant writing block;
 *  - display exactly one extension-owned Shadow DOM copy button;
 *  - prefer a safely associated original ChatGPT copy action, else call
 *    `navigator.clipboard.writeText` only from a direct user gesture;
 *  - never read the clipboard, never store/log/transmit copied text;
 *  - completely restore the official UI when disabled or torn down.
 *
 * The controller owns its own tracker, host, and keyboard handler. The content
 * runtime drives `apply`/`refresh`/`teardown` and forwards the shortcut.
 */

export const WRITING_COPY_HOST_ATTR = HOST_ATTR;

export class WritingCopyController {
  private readonly root: HTMLElement;
  private readonly adapter: ChatGptAdapter;
  private readonly tracker: WritingCopyTracker;
  private readonly host: WritingCopyHost;

  private enabled = false;
  private position: CopyPosition = "middle-right";
  private activeBlock: HTMLElement | null = null;

  /** Bound keyboard handler (single reference reused for attach/detach). */
  private readonly keyHandler: (e: KeyboardEvent) => void;

  constructor(root: HTMLElement, adapter: ChatGptAdapter) {
    this.root = root;
    this.adapter = adapter;
    this.tracker = new WritingCopyTracker(adapter);
    this.host = new WritingCopyHost();

    const onChange: ActiveTargetChange = (target) => {
      this.activeBlock = target;
      this.syncHostToTarget();
    };
    this.tracker.setOnChange(onChange);
    this.keyHandler = (e: KeyboardEvent): void => this.handleKeydown(e);
  }

  // --- public accessors (tests) -------------------------------------------

  get target(): HTMLElement | null {
    return this.activeBlock;
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

  // --- apply / refresh / restore ------------------------------------------

  /**
   * Apply writing-copy settings. No-op (official UI untouched) when disabled.
   * Otherwise re-detect safe blocks, mark them, mount the host, and begin
   * tracking the most viewport-centered block.
   */
  apply(settings: Settings): void {
    this.restore();
    this.enabled = settings.enabled && settings.writingCopy.enabled;
    this.position = settings.writingCopy.position;

    if (!this.enabled) {
      this.activeBlock = null;
      return;
    }

    // Without a safe conversation container there is nothing to track and the
    // host must not be mounted (spec: missing container mounts no host).
    if (!this.adapter.detectConversationContainer().element) {
      this.activeBlock = null;
      return;
    }

    this.markSafeBlocks();
    this.host.mount(() => void this.onCopyRequested());
    this.tracker.refresh();
    this.applyBackground(settings);
    this.syncHostToTarget();
  }

  /** Re-detect and rebind after SPA route change or structural mutation. */
  refresh(settings: Settings): void {
    if (!this.enabled) return;
    if (!this.adapter.detectConversationContainer().element) {
      this.restore();
      return;
    }
    this.markSafeBlocks();
    this.tracker.refresh();
    this.applyBackground(settings);
    this.syncHostToTarget();
  }

  /** Recompute the active target immediately (used before a copy action). */
  private currentSafeTarget(): HTMLElement | null {
    return this.tracker.recalculateNow();
  }

  /** Mark all currently safe writing blocks with the extension marker. */
  private markSafeBlocks(): void {
    for (const el of findSafeWritingBlocks(this.adapter)) {
      if (el.isConnected) markWritingBlock(el);
    }
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

  /** Apply the optional guarded writing-block background. */
  private applyBackground(settings: Settings): void {
    if (isWritingBlockBackgroundActive(settings)) {
      this.root.classList.add("cgl-writing-copy-active");
    } else {
      this.root.classList.remove("cgl-writing-copy-active");
    }
  }

  // --- copy action ---------------------------------------------------------

  /** Invoked by the Shadow DOM button (a direct user gesture). */
  private async onCopyRequested(): Promise<void> {
    this.host.setStatus("idle");
    const outcome = await performCopy(
      () => this.currentSafeTarget(),
      this.adapter,
    );
    switch (outcome) {
      case "requested":
        this.host.setStatus("requested");
        break;
      case "copied":
        this.host.setStatus("copied");
        break;
      case "unavailable":
      default:
        this.host.setStatus("unavailable");
        break;
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
    void this.onCopyRequested();
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
    for (const cls of WRITING_COPY_ROOT_CLASSES) {
      this.root.classList.remove(cls);
    }
    clearAllWritingCopyMarkers(document);
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
    this.position = "middle-right";
  }

  /** Expose the handler reference so the runtime can attach/detach it. */
  get keyboardHandler(): (e: KeyboardEvent) => void {
    return this.keyHandler;
  }
}

export { hasWritingCopyEffects };
