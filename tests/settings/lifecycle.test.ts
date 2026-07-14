import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { ThemeApplier } from "../../src/content/lifecycle.js";
import { RouteListener } from "../../src/content/route-listener.js";

describe("ThemeApplier", () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    const g = globalThis as unknown as Record<string, unknown>;
    g.document = dom.window.document;
    g.window = dom.window;
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.document;
    delete g.window;
  });

  it("adds extension-owned class and scoped custom properties when enabled", () => {
    const applier = new ThemeApplier(dom.window.document.documentElement);
    applier.apply({
      enabled: true,
      preset: "normal",
      appearance: { disableAnimations: true, disableBlur: false, disableShadows: false, compactSpacing: true, useConversationWidth: true, conversationWidth: 800, useFontSize: true, fontSize: 15, useTheme: true },
      sidebar: { mode: "visible" },
      history: { enabled: false, visiblePairs: 20, mode: "safe" },
      writingCopy: { enabled: false, position: "middle-right", shortcutEnabled: true },
      codeBlocks: { autoCollapse: false, collapseAfterLines: 40 },
      theme: { pageBackground: "#101010", conversationBackground: "#111111", userBackground: "#222222", assistantBackground: "transparent", inputBackground: "#333333", codeBackground: "#444444", writingBlockBackground: "#555555", textColor: "#eeeeee" },
    } as never);
    const root = dom.window.document.documentElement;
    expect(root.classList.contains("cgl-active")).toBe(true);
    expect(root.classList.contains("cgl-compact")).toBe(true);
    expect(root.classList.contains("cgl-no-anim")).toBe(true);
    expect(root.classList.contains("cgl-width")).toBe(true);
    expect(root.classList.contains("cgl-font")).toBe(true);
    expect(root.classList.contains("cgl-theme")).toBe(true);
    expect(root.style.getPropertyValue("--cgl-page-bg")).toBe("#101010");
    expect(root.style.getPropertyValue("--cgl-conversation-width")).toBe("800px");
    expect(root.style.getPropertyValue("--cgl-font-size")).toBe("15px");
  });

  it("fully removes extension classes and properties when disabled", () => {
    const applier = new ThemeApplier(dom.window.document.documentElement);
    applier.apply({
      enabled: true,
      preset: "normal",
      appearance: { disableAnimations: true, disableBlur: false, disableShadows: false, compactSpacing: true, useConversationWidth: false, conversationWidth: 800, useFontSize: false, fontSize: 15, useTheme: false },
      sidebar: { mode: "visible" },
      history: { enabled: false, visiblePairs: 20, mode: "safe" },
      writingCopy: { enabled: false, position: "middle-right", shortcutEnabled: true },
      codeBlocks: { autoCollapse: false, collapseAfterLines: 40 },
      theme: { pageBackground: "#101010", conversationBackground: "#111111", userBackground: "#222222", assistantBackground: "transparent", inputBackground: "#333333", codeBackground: "#444444", writingBlockBackground: "#555555", textColor: "#eeeeee" },
    } as never);
    applier.restore();
    const root = dom.window.document.documentElement;
    expect(root.classList.contains("cgl-active")).toBe(false);
    expect(root.style.getPropertyValue("--cgl-page-bg")).toBe("");
  });

  it("Normal preset adds only the active guard and no override classes", () => {
    const applier = new ThemeApplier(dom.window.document.documentElement);
    applier.apply({
      enabled: true,
      preset: "normal",
      appearance: { disableAnimations: false, disableBlur: false, disableShadows: false, compactSpacing: false, useConversationWidth: false, conversationWidth: 768, useFontSize: false, fontSize: 16, useTheme: false },
      sidebar: { mode: "visible" },
      history: { enabled: false, visiblePairs: 20, mode: "safe" },
      writingCopy: { enabled: false, position: "middle-right", shortcutEnabled: true },
      codeBlocks: { autoCollapse: false, collapseAfterLines: 40 },
      theme: { pageBackground: "#101010", conversationBackground: "#111111", userBackground: "#222222", assistantBackground: "transparent", inputBackground: "#333333", codeBackground: "#444444", writingBlockBackground: "#555555", textColor: "#eeeeee" },
    } as never);
    const root = dom.window.document.documentElement;
    expect(root.classList.contains("cgl-active")).toBe(true);
    // No visual override flags should be set for Normal.
    expect(root.classList.contains("cgl-no-anim")).toBe(false);
    expect(root.classList.contains("cgl-no-blur")).toBe(false);
    expect(root.classList.contains("cgl-no-shadow")).toBe(false);
    expect(root.classList.contains("cgl-compact")).toBe(false);
    expect(root.classList.contains("cgl-width")).toBe(false);
    expect(root.classList.contains("cgl-font")).toBe(false);
    expect(root.classList.contains("cgl-theme")).toBe(false);
    expect(root.style.getPropertyValue("--cgl-page-bg")).toBe("");
  });
});

describe("RouteListener lifecycle", () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://chatgpt.com/c/aaa",
    });
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.location = dom.window.location;
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.location;
  });

  it("fires onChange when the pathname changes and is idempotent on stop", () => {
    const listener = new RouteListener();
    let calls = 0;
    listener.onChange(() => {
      calls++;
    });
    listener.start();
    // Simulate a route change by mutating the URL.
    dom.reconfigure({ url: "https://chatgpt.com/c/bbb" });
    listener.check();
    expect(calls).toBe(1);
    // Same URL again -> no new call.
    listener.check();
    expect(calls).toBe(1);
    listener.stop();
    listener.check(); // after stop, callback list cleared
    expect(calls).toBe(1);
  });

  it("does not fire when URL is unchanged", () => {
    const listener = new RouteListener();
    let calls = 0;
    listener.onChange(() => {
      calls++;
    });
    listener.check();
    expect(calls).toBe(0);
  });
});
