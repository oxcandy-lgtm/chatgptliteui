import type { Settings } from "../shared/types.js";
import { debounce } from "../shared/debounce.js";

/**
 * Applies presentation settings by toggling the extension-owned root class and
 * setting CSS custom properties on `document.documentElement`.
 *
 * This is strictly non-destructive: it never hides, removes, or rewrites page
 * elements. When disabled, all extension classes are removed and the official
 * ChatGPT appearance is fully restored.
 */
export class ThemeApplier {
  private readonly root: HTMLElement;

  constructor(root: HTMLElement = document.documentElement) {
    this.root = root;
  }

  apply(settings: Settings): void {
    if (!settings.enabled) {
      this.remove();
      return;
    }
    this.root.classList.add("cgl-active");
    this.root.classList.toggle("cgl-compact", settings.appearance.compactSpacing);
    this.root.classList.toggle("cgl-no-anim", settings.appearance.disableAnimations);
    this.root.classList.toggle("cgl-no-blur", settings.appearance.disableBlur);
    this.root.classList.toggle("cgl-no-shadow", settings.appearance.disableShadows);

    this.root.style.setProperty(
      "--cgl-conversation-width",
      `${settings.appearance.conversationWidth}px`,
    );
    this.root.style.setProperty("--cgl-font-size", `${settings.appearance.fontSize}px`);

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

  /** Fully restore the original page appearance. */
  remove(): void {
    this.root.classList.remove(
      "cgl-active",
      "cgl-compact",
      "cgl-no-anim",
      "cgl-no-blur",
      "cgl-no-shadow",
    );
    const props = [
      "--cgl-conversation-width",
      "--cgl-font-size",
      "--cgl-page-bg",
      "--cgl-conversation-bg",
      "--cgl-user-bg",
      "--cgl-assistant-bg",
      "--cgl-input-bg",
      "--cgl-code-bg",
      "--cgl-writing-bg",
      "--cgl-text",
    ];
    for (const p of props) {
      this.root.style.removeProperty(p);
    }
  }
}

/** Create a debounced applier for use with storage change events. */
export function createDebouncedApply(
  apply: (s: Settings) => void,
  waitMs = 120,
): (s: Settings) => void {
  return debounce(apply, waitMs);
}
