import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(process.cwd(), "src/styles/injected.css"), "utf8");

describe("Blur reduction CSS (Blocker 4)", () => {
  it("disables backdrop-filter page-wide under cgl-no-blur", () => {
    // Root-guarded descendant rule disabling backdrop-filter on all elements.
    expect(CSS).toMatch(
      /:root\.cgl-active\.cgl-no-blur\s+\*,\s*:root\.cgl-active\.cgl-no-blur\s+\*::before,\s*:root\.cgl-active\.cgl-no-blur\s+\*::after\s*\{[^}]*backdrop-filter:\s*none[^}]*\}/s,
    );
    expect(CSS).toMatch(/backdrop-filter:\s*none\s*!important/);
    expect(CSS).toMatch(/-webkit-backdrop-filter:\s*none\s*!important/);
  });

  it("does NOT add a global ordinary filter:none rule", () => {
    // Negative lookbehind: only backdrop-filter may use `none`.
    expect(CSS).not.toMatch(/(?<!backdrop-)filter:\s*none\s*!important/);
  });
});
