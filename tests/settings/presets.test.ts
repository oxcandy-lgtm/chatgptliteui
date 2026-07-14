import { describe, it, expect } from "vitest";
import {
  applyAppearancePreset,
  detectAppearancePreset,
  PRESET_NAMES,
} from "../../src/features/appearance/presets.js";
import { cloneDefaults } from "../../src/settings/defaults.js";
import type { Settings } from "../../src/shared/types.js";

function presetFor(name: "normal" | "minimal" | "work" | "ultra-lite"): Settings["appearance"] {
  return applyAppearancePreset(cloneDefaults(), name).appearance;
}

describe("preset profiles (Phase 2 locked values)", () => {
  it("normal is a no-op appearance profile", () => {
    const a = presetFor("normal");
    expect(a.disableAnimations).toBe(false);
    expect(a.disableBlur).toBe(false);
    expect(a.disableShadows).toBe(false);
    expect(a.compactSpacing).toBe(false);
    expect(a.useConversationWidth).toBe(false);
    expect(a.useFontSize).toBe(false);
    expect(a.useTheme).toBe(false);
  });

  it("minimal disables animation/blur/shadow only", () => {
    const a = presetFor("minimal");
    expect(a.disableAnimations).toBe(true);
    expect(a.disableBlur).toBe(true);
    expect(a.disableShadows).toBe(true);
    expect(a.compactSpacing).toBe(false);
    expect(a.useConversationWidth).toBe(false);
    expect(a.useFontSize).toBe(false);
    expect(a.useTheme).toBe(false);
  });

  it("work adds compact spacing and width 880", () => {
    const a = presetFor("work");
    expect(a.compactSpacing).toBe(true);
    expect(a.useConversationWidth).toBe(true);
    expect(a.conversationWidth).toBe(880);
    expect(a.useFontSize).toBe(false);
    expect(a.useTheme).toBe(false);
  });

  it("ultra-lite adds width 720 and font 15", () => {
    const a = presetFor("ultra-lite");
    expect(a.compactSpacing).toBe(true);
    expect(a.useConversationWidth).toBe(true);
    expect(a.conversationWidth).toBe(720);
    expect(a.useFontSize).toBe(true);
    expect(a.fontSize).toBe(15);
    expect(a.useTheme).toBe(false);
  });

  it("every predefined preset name has an exact profile", () => {
    for (const name of PRESET_NAMES) {
      const s = applyAppearancePreset(cloneDefaults(), name);
      expect(s.preset).toBe(name);
      expect(detectAppearancePreset(s)).toBe(name);
    }
  });
});

describe("applyAppearancePreset", () => {
  it("preserves unrelated future-feature settings", () => {
    const base = cloneDefaults();
    base.sidebar.mode = "hidden";
    base.history.enabled = true;
    const next = applyAppearancePreset(base, "work");
    expect(next.sidebar.mode).toBe("hidden");
    expect(next.history.enabled).toBe(true);
    expect(next.writingCopy.position).toBe(base.writingCopy.position);
  });

  it("never uses a shallow merge (replaces appearance wholesale)", () => {
    const base = cloneDefaults();
    base.appearance.disableAnimations = true;
    const next = applyAppearancePreset(base, "normal");
    // normal profile resets all toggles, even though base had disableAnimations.
    expect(next.appearance.disableAnimations).toBe(false);
    expect(next.appearance.useTheme).toBe(false);
  });

  it("does not mutate the input settings", () => {
    const base = cloneDefaults();
    applyAppearancePreset(base, "ultra-lite");
    expect(base.preset).toBe("normal");
    expect(base.appearance.disableAnimations).toBe(false);
  });
});

describe("detectAppearancePreset", () => {
  it("derives custom when manually edited", () => {
    const s = applyAppearancePreset(cloneDefaults(), "minimal");
    s.appearance.compactSpacing = true; // minimal has compactSpacing=false
    expect(detectAppearancePreset(s)).toBe("custom");
  });

  it("derives the correct predefined name when exactly matching", () => {
    const s = cloneDefaults();
    s.appearance = { ...presetFor("work") };
    expect(detectAppearancePreset(s)).toBe("work");
  });

  it("returns custom for untouched defaults (normal profile)", () => {
    expect(detectAppearancePreset(cloneDefaults())).toBe("normal");
  });
});
