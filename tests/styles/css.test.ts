import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src", "styles");
const variables = readFileSync(join(SRC, "variables.css"), "utf-8");
const injected = readFileSync(join(SRC, "injected.css"), "utf-8");

describe("injected CSS guards (Phase 2 scope)", () => {
  it("never sets font-size on :root (only scoped to markers)", () => {
    // Global document-root font sizing is forbidden. Scoped font rules under
    // a `.cgl-font` guard (with data-cgl-* markers) are allowed.
    expect(injected).not.toMatch(/:root\.cgl-active\s*\{\s*[^}]*font-size/);
    // Every font-size declaration must live inside a .cgl-font selector.
    const fontRuleBlocks = injected
      .split("}")
      .filter((b) => /font-size:\s*var\(--cgl-font-size\)/.test(b));
    for (const block of fontRuleBlocks) {
      const selector = block.split("{")[0]?.trim() ?? "";
      expect(selector).toContain("cgl-font");
    }
  });

  it("does not globally remove ordinary filter (only backdrop-filter)", () => {
    // The old global `filter: none` rule must be gone. Plain `filter:` must
    // not appear with `none`; only `backdrop-filter` may be disabled.
    expect(injected).not.toMatch(/(?<!backdrop-)filter:\s*none\s*!important/);
    // backdrop-filter may still be disabled.
    expect(injected).toMatch(/backdrop-filter:\s*none\s*!important/);
  });

  it("does not directly style every [role=\"main\"]", () => {
    // Width/blur/shadow are scoped to data-cgl markers, not [role="main"].
    expect(injected).not.toMatch(/\[role="main"\]\s*\{/);
    expect(injected).not.toMatch(/\[role="main"\]\s*>\s*\*/);
  });

  it("does not target [role=\"main\"] > * for compact spacing", () => {
    expect(injected).not.toMatch(/\[role="main"\]\s*>\s*\*/);
  });

  it("scopes every rule to an extension-owned cgl- guard", () => {
    // Each selector block should reference a cgl- class or marker.
    // We check that no top-level selector lacks a cgl- token.
    const blocks = injected
      .split("}")
      .map((b) => b.split("{")[0]?.trim())
      .filter((s) => s && s.length > 0 && !s.startsWith("/*"));
    for (const sel of blocks) {
      // Skip the variables file check (no rules there with cgl- toggles
      // besides variable definitions, which are fine).
      expect(sel).toMatch(/cgl-/);
    }
  });

  it("variables file defines the required custom properties", () => {
    for (const v of [
      "--cgl-page-bg",
      "--cgl-conversation-bg",
      "--cgl-user-bg",
      "--cgl-assistant-bg",
      "--cgl-input-bg",
      "--cgl-code-bg",
      "--cgl-text",
      "--cgl-conversation-width",
      "--cgl-font-size",
    ]) {
      expect(variables).toContain(v);
    }
    // future writing-block var may remain defined but unused
    expect(variables).toContain("--cgl-writing-bg");
  });
});
