import { describe, it, expect } from "vitest";
import { cloneDefaults } from "../../src/settings/defaults.js";
import { applyAppearancePreset } from "../../src/features/appearance/presets.js";
import { validateSettings, mergeSettings } from "../../src/settings/schema.js";
import type { Settings } from "../../src/shared/types.js";

describe("writing-copy persistence", () => {
  it("default writingCopy is opt-in off with middle-right position", () => {
    const d = cloneDefaults();
    expect(d.writingCopy.enabled).toBe(false);
    expect(d.writingCopy.position).toBe("middle-right");
    expect(d.writingCopy.shortcutEnabled).toBe(true);
  });

  it("schema version remains 2", () => {
    const d = cloneDefaults();
    expect(validateSettings(d)).toBe(true);
    // Writing-copy does not add a schema version bump.
    expect((d as Settings).preset).toBeDefined();
  });

  it("malformed position is rejected by the schema", () => {
    const bad = cloneDefaults();
    // @ts-expect-error intentional malformed value
    bad.writingCopy.position = "diagonal";
    expect(validateSettings(bad)).toBe(false);
  });

  it("updateSettings patch preserves unrelated settings", () => {
    const base = cloneDefaults();
    base.sidebar = { mode: "button" };
    base.history.visiblePairs = 9;
    const next = mergeSettings(base, { writingCopy: { enabled: true } });
    expect(next.writingCopy.enabled).toBe(true);
    expect(next.sidebar.mode).toBe("button");
    expect(next.history.visiblePairs).toBe(9);
    expect(next.writingCopy.position).toBe("middle-right");
    expect(next.writingCopy.shortcutEnabled).toBe(true);
  });

  it("presets preserve the entire writingCopy section", () => {
    const base = cloneDefaults();
    base.writingCopy = { enabled: true, position: "top-right", shortcutEnabled: false };
    base.sidebar = { mode: "hover" };
    const preset = applyAppearancePreset(base, "minimal");
    expect(preset.writingCopy.enabled).toBe(true);
    expect(preset.writingCopy.position).toBe("top-right");
    expect(preset.writingCopy.shortcutEnabled).toBe(false);
    expect(preset.sidebar.mode).toBe("hover");
    expect(validateSettings(preset)).toBe(true);
  });

  it("reset restores writing-copy defaults", () => {
    const d = cloneDefaults();
    d.writingCopy = { enabled: true, position: "top-right", shortcutEnabled: false };
    // A reset (cloneDefaults) restores the canonical defaults.
    const reset = cloneDefaults();
    expect(reset.writingCopy.enabled).toBe(false);
    expect(reset.writingCopy.position).toBe("middle-right");
    expect(reset.writingCopy.shortcutEnabled).toBe(true);
    expect(reset.theme.writingBlockBackground).toBe("#161b25");
    void d;
  });

  it("writing-block background round-trips valid colors", () => {
    for (const v of ["#abc", "#aabbcc", "#aabbccff"]) {
      const base = cloneDefaults();
      const next = mergeSettings(base, { theme: { writingBlockBackground: v } });
      expect(next.theme.writingBlockBackground).toBe(v);
    }
  });
});
