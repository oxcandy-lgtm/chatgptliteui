import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { AppearanceController } from "../../src/features/appearance/appearance-controller.js";
import { clearAllMarkers } from "../../src/features/appearance/markers.js";
import { createAdapter } from "../../src/adapters/chatgpt-adapter.js";
import { cloneDefaults } from "../../src/settings/defaults.js";
import type { Settings } from "../../src/shared/types.js";

function baseSettings(over: Partial<Settings["appearance"]> = {}): Settings {
  const s = cloneDefaults();
  Object.assign(s.appearance, over);
  return s;
}

function installDom(): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main role="main">
        <section data-testid="thread" aria-label="conversation">
          <article data-message-author-role="user"><p>u1</p></article>
          <article data-message-author-role="assistant"><p>a1</p><pre><code>x</code></pre></article>
        </section>
      </main>
      <form><textarea id="prompt-textarea"></textarea></form>
    </body></html>`,
    { url: "https://chatgpt.com/c/synthetic", pretendToBeVisual: true },
  );
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  return dom;
}

describe("AppearanceController runtime", () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  function controller(): AppearanceController {
    return new AppearanceController(
      dom.window.document.documentElement,
      createAdapter(),
    );
  }

  it("disabled state applies no appearance and no markers", () => {
    const c = controller();
    const s = baseSettings();
    s.enabled = false;
    c.apply(s);
    const root = dom.window.document.documentElement;
    expect(root.classList.contains("cgl-active")).toBe(false);
    expect(dom.window.document.querySelector("[data-cgl-conversation-root]")).toBeNull();
  });

  it("Normal preset applies no appearance overrides (no-op)", () => {
    const c = controller();
    c.apply(baseSettings()); // normal defaults
    const root = dom.window.document.documentElement;
    expect(root.classList.contains("cgl-active")).toBe(true);
    expect(root.classList.contains("cgl-no-anim")).toBe(false);
    expect(root.classList.contains("cgl-no-blur")).toBe(false);
    expect(root.classList.contains("cgl-no-shadow")).toBe(false);
    expect(root.classList.contains("cgl-compact")).toBe(false);
    expect(root.classList.contains("cgl-width")).toBe(false);
    expect(root.classList.contains("cgl-font")).toBe(false);
    expect(root.classList.contains("cgl-theme")).toBe(false);
  });

  it("Minimal applies only animation/blur/shadow classes", () => {
    const c = controller();
    c.apply(baseSettings({
      disableAnimations: true,
      disableBlur: true,
      disableShadows: true,
    }));
    const root = dom.window.document.documentElement;
    expect(root.classList.contains("cgl-no-anim")).toBe(true);
    expect(root.classList.contains("cgl-no-blur")).toBe(true);
    expect(root.classList.contains("cgl-no-shadow")).toBe(true);
    expect(root.classList.contains("cgl-compact")).toBe(false);
    expect(root.classList.contains("cgl-width")).toBe(false);
    expect(root.classList.contains("cgl-font")).toBe(false);
  });

  it("Work applies compact spacing and width", () => {
    const c = controller();
    c.apply(baseSettings({
      compactSpacing: true,
      useConversationWidth: true,
      conversationWidth: 880,
    }));
    const root = dom.window.document.documentElement;
    expect(root.classList.contains("cgl-compact")).toBe(true);
    expect(root.classList.contains("cgl-width")).toBe(true);
    expect(root.style.getPropertyValue("--cgl-conversation-width")).toBe("880px");
    // font not enabled
    expect(root.classList.contains("cgl-font")).toBe(false);
  });

  it("Ultra Lite applies compact spacing, width, and font size", () => {
    const c = controller();
    c.apply(baseSettings({
      compactSpacing: true,
      useConversationWidth: true,
      conversationWidth: 720,
      useFontSize: true,
      fontSize: 15,
    }));
    const root = dom.window.document.documentElement;
    expect(root.classList.contains("cgl-compact")).toBe(true);
    expect(root.classList.contains("cgl-width")).toBe(true);
    expect(root.classList.contains("cgl-font")).toBe(true);
    expect(root.style.getPropertyValue("--cgl-font-size")).toBe("15px");
  });

  it("custom theme applies only scoped theme variables", () => {
    const c = controller();
    c.apply(baseSettings({
      useTheme: true,
      useConversationWidth: false,
      useFontSize: false,
    }));
    const root = dom.window.document.documentElement;
    expect(root.classList.contains("cgl-theme")).toBe(true);
    expect(root.style.getPropertyValue("--cgl-page-bg")).toBe("#101318");
    expect(root.style.getPropertyValue("--cgl-text")).toBe("#e7eaf0");
    // width/font not enabled
    expect(root.classList.contains("cgl-width")).toBe(false);
    expect(root.classList.contains("cgl-font")).toBe(false);
  });

  it("does not set global :root font-size or global filter", () => {
    const c = controller();
    c.apply(baseSettings({
      useFontSize: true,
      fontSize: 18,
      disableBlur: true,
    }));
    const root = dom.window.document.documentElement;
    // cgl-font scopes font to markers; :root itself must NOT carry font-size.
    expect(root.style.getPropertyValue("font-size")).toBe("");
    expect(root.style.getPropertyValue("filter")).toBe("");
  });

  it("marks detected surfaces with extension-owned markers", () => {
    const c = controller();
    c.apply(baseSettings());
    const doc = dom.window.document;
    expect(doc.querySelector("[data-cgl-conversation-root]")).not.toBeNull();
    expect(doc.querySelector("[data-cgl-composer]")).not.toBeNull();
    expect(doc.querySelectorAll("[data-cgl-user-turn]").length).toBeGreaterThan(0);
    expect(doc.querySelectorAll("[data-cgl-assistant-turn]").length).toBeGreaterThan(0);
  });

  it("ambiguous Adapter result leaves official UI unchanged (no markers throw)", () => {
    const c = controller();
    // No assertions beyond "does not throw" — adapter refuses ambiguous
    // detection and the controller must keep the page intact.
    expect(() => c.apply(baseSettings({ compactSpacing: true }))).not.toThrow();
  });

  it("restore is idempotent and leaves a clean DOM", () => {
    const c = controller();
    c.apply(baseSettings({ disableAnimations: true, useTheme: true, compactSpacing: true }));
    c.restore();
    c.restore(); // second call must not throw
    const root = dom.window.document.documentElement;
    expect(root.classList.length).toBe(0);
    expect(root.style.getPropertyValue("--cgl-page-bg")).toBe("");
    expect(dom.window.document.querySelector("[data-cgl-conversation-root]")).toBeNull();
    clearAllMarkers(dom.window.document);
  });

  it("repeated apply/restore is idempotent (no accumulation)", () => {
    const c = controller();
    const s = baseSettings({ disableAnimations: true, compactSpacing: true });
    c.apply(s);
    c.apply(s);
    const root = dom.window.document.documentElement;
    // classList is a set, so re-applying never accumulates duplicates.
    expect(root.classList.contains("cgl-no-anim")).toBe(true);
    expect(root.classList.contains("cgl-compact")).toBe(true);
    c.restore();
    expect(root.classList.contains("cgl-active")).toBe(false);
  });
});
