import type { Settings } from "../../shared/types.js";
import { debounce } from "../../shared/debounce.js";
import {
  allMarkerNames,
  clearAllMarkers,
  mark,
} from "./markers.js";
import {
  hasAppearanceEffects,
  isSafeCosmeticDetection,
} from "./presets.js";
import { resolveChatBackground } from "./project-background.js";
import { clearActiveChatRowMarkers } from "./active-chat-row.js";
import { clearSidebarChatColorMarkers } from "./sidebar-chat-colors.js";
import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";

/**
 * Appearance controller.
 *
 * Responsibilities:
 *  - apply appearance settings by toggling extension-owned root classes and
 *    setting `--cgl-*` custom properties on document.documentElement;
 *  - mark detected ChatGPT surfaces with extension-owned `data-cgl-*` markers
 *    so CSS can style them without broad/ambiguous selectors;
 *  - restore the official UI completely when disabled, on Normal preset, on
 *    route teardown, or on lifecycle teardown.
 *
 * This is strictly non-destructive: it never hides, removes, or rewrites page
 * elements. It only adds extension-owned attributes/classes and CSS variables
 * consumed by `content.css` under the `cgl-active` guard.
 */

const CGL_CLASSES = [
  "cgl-active",
  "cgl-no-anim",
  "cgl-no-blur",
  "cgl-no-shadow",
  "cgl-compact",
  "cgl-width",
  "cgl-font",
  "cgl-theme",
  "cgl-chat-bg-override",
] as const;

const CGL_VARS = [
  "--cgl-page-bg",
  "--cgl-conversation-bg",
  "--cgl-user-bg",
  "--cgl-assistant-bg",
  "--cgl-input-bg",
  "--cgl-code-bg",
  "--cgl-writing-bg",
  "--cgl-text",
  "--cgl-conversation-width",
  "--cgl-font-size",
] as const;

export class AppearanceController {
  private readonly root: HTMLElement;
  private readonly adapter: ChatGptAdapter;
  /** Elements marked in the most recent apply; released on teardown. */
  private marked: Element[] = [];

  constructor(root: HTMLElement, adapter: ChatGptAdapter) {
    this.root = root;
    this.adapter = adapter;
  }

  /** Mark detected surfaces with extension-owned markers (cosmetic only). */
  private markSurfaces(): void {
    // Release stale references first.
    this.marked = [];

    const conv = this.adapter.detectConversationContainer();
    if (isSafeCosmeticDetection(conv) && conv.element) {
      mark(conv.element, "data-cgl-conversation-root");
      this.marked.push(conv.element);
    }

    // Width applies ONLY to a safely detected conversation column, never to
    // the conversation root (which may be the whole [role="main"] shell) and
    // never to a low/unknown-confidence result.
    const column = this.adapter.detectConversationColumn();
    if (
      isSafeCosmeticDetection(column) &&
      column.element &&
      column.element !== conv.element
    ) {
      mark(column.element, "data-cgl-conversation-column");
      this.marked.push(column.element);
    }

    const composer = this.adapter.detectComposer();
    if (isSafeCosmeticDetection(composer) && composer.element) {
      mark(composer.element, "data-cgl-composer");
      this.marked.push(composer.element);
    }

    const users = this.adapter.detectUserTurns();
    if (isSafeCosmeticDetection(users)) {
      for (const u of users.elements) {
        mark(u, "data-cgl-user-turn");
        this.marked.push(u);
      }
    }
    const assistants = this.adapter.detectAssistantTurns();
    if (isSafeCosmeticDetection(assistants)) {
      for (const a of assistants.elements) {
        mark(a, "data-cgl-assistant-turn");
        this.marked.push(a);
      }
    }
  }

  /**
   * Clear stale markers, rerun safe Adapter detection, and re-mark current
   * surfaces. Leaves active root classes and CSS variables intact, and does
   * nothing when appearance has no active effect.
   */
  refreshMarkers(settings: Settings): void {
    if (!settings.enabled || !hasAppearanceEffects(settings)) return;
    this.adapter.refresh();
    // Clear only markers (not classes/vars) before re-marking.
    clearAllMarkers(document);
    this.marked = [];
    this.markSurfaces();
  }

  /**
   * Apply appearance settings.
   * A complete no-op (no root class, no markers, no variables) when the
   * extension is disabled or when no appearance effect is active (e.g. Normal).
   */
  apply(settings: Settings): void {
    this.restore();
    if (!settings.enabled) return;
    if (!hasAppearanceEffects(settings)) return;

    this.root.classList.add("cgl-active");
    const a = settings.appearance;

    this.root.classList.toggle("cgl-no-anim", a.disableAnimations);
    this.root.classList.toggle("cgl-no-blur", a.disableBlur);
    this.root.classList.toggle("cgl-no-shadow", a.disableShadows);
    this.root.classList.toggle("cgl-compact", a.compactSpacing);
    this.root.classList.toggle("cgl-width", a.useConversationWidth);
    this.root.classList.toggle("cgl-font", a.useFontSize);
    this.root.classList.toggle("cgl-theme", a.useTheme);

    if (a.useConversationWidth) {
      this.root.style.setProperty(
        "--cgl-conversation-width",
        `${a.conversationWidth}px`,
      );
    }
    if (a.useFontSize) {
      this.root.style.setProperty("--cgl-font-size", `${a.fontSize}px`);
    }
    if (a.useTheme) {
      const t = settings.theme;
      this.root.style.setProperty("--cgl-page-bg", t.pageBackground);
      this.root.style.setProperty("--cgl-conversation-bg", t.conversationBackground);
      this.root.style.setProperty("--cgl-user-bg", t.userBackground);
      this.root.style.setProperty("--cgl-assistant-bg", t.assistantBackground);
      this.root.style.setProperty("--cgl-input-bg", t.inputBackground);
      this.root.style.setProperty("--cgl-code-bg", t.codeBackground);
      this.root.style.setProperty("--cgl-writing-bg", t.writingBlockBackground);
      this.root.style.setProperty("--cgl-text", t.textColor);
    }

    // Mark surfaces last so styles have targets; harmless if detection fails.
    this.adapter.refresh();
    this.markSurfaces();
  }

  /**
   * Reconcile the per-conversation background override. Resolution order:
   * explicit chat color, else project color, else the global/official
   * fallback (restored first so a reset chat inside a colored project
   * immediately shows the project color, and a project reset immediately
   * drops inherited paint). Overrides ONLY the page/conversation background
   * variables — never user/assistant/code/writing/pulse/marker values and
   * never global theme settings.
   */
  async reconcileConversationBackgroundOverride(
    conversationFp: string | null,
    projectFp: string | null,
    settings: Settings,
  ): Promise<void> {
    this.root.classList.remove("cgl-chat-bg-override");
    if (
      settings.enabled &&
      settings.appearance &&
      settings.appearance.useTheme
    ) {
      this.root.style.setProperty(
        "--cgl-page-bg",
        settings.theme.pageBackground,
      );
      this.root.style.setProperty(
        "--cgl-conversation-bg",
        settings.theme.conversationBackground,
      );
    } else {
      this.root.style.removeProperty("--cgl-page-bg");
      this.root.style.removeProperty("--cgl-conversation-bg");
    }
    if (!conversationFp && !projectFp) return;
    const background = await resolveChatBackground(conversationFp, projectFp);
    if (!background) return;
    this.root.classList.add("cgl-chat-bg-override");
    this.root.style.setProperty("--cgl-page-bg", background);
    this.root.style.setProperty("--cgl-conversation-bg", background);
  }

  /**
   * Completely restore the official ChatGPT UI. Removes every extension-owned
   * class, inline `--cgl-*` custom property, and `data-cgl-*` marker. Idempotent.
   */
  restore(): void {
    for (const cls of CGL_CLASSES) this.root.classList.remove(cls);
    for (const v of CGL_VARS) this.root.style.removeProperty(v);
    // Release references to avoid retaining detached nodes.
    this.marked = [];
    clearAllMarkers(document);
    clearActiveChatRowMarkers(document);
    clearSidebarChatColorMarkers(document);
  }
}

/** Create a debounced appearance applier for storage-change events. */
export function createDebouncedApply(
  apply: (s: Settings) => void,
  waitMs = 120,
): (s: Settings) => void {
  return debounce(apply, waitMs);
}

/** Exposed for diagnostics/tests: list extension-owned marker names. */
export { allMarkerNames };
