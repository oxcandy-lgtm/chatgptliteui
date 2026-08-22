import { describe, it, expect } from "vitest";
import { cloneDefaults } from "../../src/settings/defaults.js";
import { applyAppearancePreset } from "../../src/features/appearance/presets.js";
import { validateSettings, mergeSettings } from "../../src/settings/schema.js";
import { SETTINGS_SCHEMA_VERSION } from "../../src/shared/types.js";
import type { Settings } from "../../src/shared/types.js";

describe("writing-copy persistence", () => {
  it("default writingCopy is opt-in off with smart position", () => {
    const d = cloneDefaults();
    expect(d.writingCopy.enabled).toBe(false);
    expect(d.writingCopy.position).toBe("smart");
    expect(d.writingCopy.shortcutEnabled).toBe(true);
  });

  it("Phase 4 presentation defaults are pulse-on, marker-on, background-off", () => {
    const d = cloneDefaults();
    expect(d.writingCopy.markerEnabled).toBe(true);
    expect(d.writingCopy.pulseEnabled).toBe(true);
    expect(d.writingCopy.backgroundEnabled).toBe(false);
    // Conservative bounded slow-range defaults.
    expect(d.writingCopy.markerOpacity).toBe(30);
    expect(d.writingCopy.pulseIntensity).toBe(18);
    expect(d.writingCopy.pulsePeriodMs).toBe(4000);
  });

  it("schema version is 3 (Phase 4 writingCopy extension)", () => {
    const d = cloneDefaults();
    expect(validateSettings(d)).toBe(true);
    expect(SETTINGS_SCHEMA_VERSION).toBe(3);
  });

  it("malformed position is rejected by the schema", () => {
    const bad = cloneDefaults();
    // @ts-expect-error intentional malformed value
    bad.writingCopy.position = "diagonal";
    expect(validateSettings(bad)).toBe(false);
  });

  it("smart position and legacy positions all validate", () => {
    for (const position of ["smart", "top-right", "middle-right", "bottom-right"] as const) {
      const base = cloneDefaults();
      base.writingCopy.position = position;
      expect(validateSettings(base)).toBe(true);
    }
  });

  it("out-of-bounds Phase 4 numerics are rejected by the schema", () => {
    for (const mutate of [
      (s: Settings) => { s.writingCopy.markerOpacity = 101; },
      (s: Settings) => { s.writingCopy.markerOpacity = -1; },
      (s: Settings) => { s.writingCopy.pulseIntensity = 150; },
      (s: Settings) => { s.writingCopy.pulsePeriodMs = 500; },
      (s: Settings) => { s.writingCopy.pulsePeriodMs = 20000; },
      (s: Settings) => { s.writingCopy.markerColor = "rgb(1,2,3)"; },
      (s: Settings) => { s.writingCopy.pulseColor = "transparent"; },
    ]) {
      const bad = cloneDefaults();
      mutate(bad);
      expect(validateSettings(bad)).toBe(false);
    }
  });

  it("updateSettings patch preserves unrelated settings", () => {
    const base = cloneDefaults();
    base.sidebar = { mode: "button" };
    base.history.visiblePairs = 9;
    const next = mergeSettings(base, { writingCopy: { enabled: true } });
    expect(next.writingCopy.enabled).toBe(true);
    expect(next.sidebar.mode).toBe("button");
    expect(next.history.visiblePairs).toBe(9);
    expect(next.writingCopy.position).toBe("smart");
    expect(next.writingCopy.shortcutEnabled).toBe(true);
  });

  it("presets preserve the entire writingCopy section", () => {
    const base = cloneDefaults();
    base.writingCopy = {
      ...base.writingCopy,
      enabled: true,
      position: "top-right",
      shortcutEnabled: false,
    };
    base.sidebar = { mode: "hover" };
    const preset = applyAppearancePreset(base, "minimal");
    expect(preset.writingCopy.enabled).toBe(true);
    expect(preset.writingCopy.position).toBe("top-right");
    expect(preset.writingCopy.shortcutEnabled).toBe(false);
    expect(preset.sidebar.mode).toBe("hover");
    expect(validateSettings(preset)).toBe(true);
  });

  it("appearance changes never rewrite the writingCopy presentation fields", () => {
    const base = cloneDefaults();
    base.writingCopy = { ...base.writingCopy, markerColor: "#112233", pulsePeriodMs: 6000 };
    const next = applyAppearancePreset(base, "work");
    expect(next.writingCopy.markerColor).toBe("#112233");
    expect(next.writingCopy.pulsePeriodMs).toBe(6000);
  });

  it("reset restores writing-copy defaults", () => {
    const d = cloneDefaults();
    d.writingCopy = {
      ...d.writingCopy,
      enabled: true,
      position: "top-right",
      shortcutEnabled: false,
    };
    // A reset (cloneDefaults) restores the canonical defaults.
    const reset = cloneDefaults();
    expect(reset.writingCopy.enabled).toBe(false);
    expect(reset.writingCopy.position).toBe("smart");
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
