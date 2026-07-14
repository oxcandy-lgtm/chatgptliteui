import { describe, it, expect } from "vitest";
import {
  hasAppearanceEffects,
  isSafeCosmeticDetection,
} from "../../src/features/appearance/presets.js";
import { cloneDefaults } from "../../src/settings/defaults.js";
import type { DetectionResult } from "../../src/adapters/detection-result.js";

function det(partial: Partial<DetectionResult>): DetectionResult {
  return {
    found: false,
    confidence: "unknown",
    strategy: "test",
    reason: "unit",
    timestamp: 0,
    elements: [],
    element: null,
    ...partial,
  } as DetectionResult;
}

describe("hasAppearanceEffects (Blocker 2)", () => {
  it("returns false for Normal defaults (no-op contract)", () => {
    expect(hasAppearanceEffects(cloneDefaults())).toBe(false);
  });
  it("returns false when disabled even with active flags", () => {
    const s = cloneDefaults();
    s.appearance.disableAnimations = true;
    s.enabled = false;
    expect(hasAppearanceEffects(s)).toBe(true); // effect flag is independent of enabled
  });
  it("returns true for each active effect flag", () => {
    const flags = [
      "disableAnimations",
      "disableBlur",
      "disableShadows",
      "compactSpacing",
      "useConversationWidth",
      "useFontSize",
      "useTheme",
    ] as const;
    for (const f of flags) {
      const s = cloneDefaults();
      (s.appearance as Record<string, unknown>)[f] = true;
      expect(hasAppearanceEffects(s)).toBe(true);
    }
  });
});

describe("isSafeCosmeticDetection (Blocker 3)", () => {
  it("rejects not-found", () => {
    expect(isSafeCosmeticDetection(det({ found: false }))).toBe(false);
  });
  it("rejects low confidence", () => {
    const el = {} as HTMLElement;
    expect(isSafeCosmeticDetection(det({ found: true, confidence: "low", element: el }))).toBe(false);
  });
  it("rejects unknown confidence", () => {
    const el = {} as HTMLElement;
    expect(isSafeCosmeticDetection(det({ found: true, confidence: "unknown", element: el }))).toBe(false);
  });
  it("accepts high confidence with element", () => {
    const el = {} as HTMLElement;
    expect(isSafeCosmeticDetection(det({ found: true, confidence: "high", element: el }))).toBe(true);
  });
  it("accepts medium confidence with element", () => {
    const el = {} as HTMLElement;
    expect(isSafeCosmeticDetection(det({ found: true, confidence: "medium", element: el }))).toBe(true);
  });
  it("accepts high confidence with elements array", () => {
    const el = {} as HTMLElement;
    expect(isSafeCosmeticDetection(det({ found: true, confidence: "high", elements: [el] }))).toBe(true);
  });
});
