import { describe, it, expect } from "vitest";
import { cloneDefaults } from "../../src/settings/defaults.js";
import { validateSettings, mergeSettings } from "../../src/settings/schema.js";
/**
 * Persistence invariants for the sidebar setting (no DOM, storage-layer only):
 *  - updating only `sidebar.mode` preserves every other section;
 *  - applying an appearance preset preserves the configured sidebar mode;
 *  - resetting restores `sidebar.mode = visible`;
 *  - a malformed sidebar mode is rejected by the schema.
 */

describe("sidebar persistence invariants", () => {
  it("patching only sidebar.mode preserves enabled/appearance/theme", () => {
    const s = cloneDefaults();
    s.enabled = true;
    s.appearance.useConversationWidth = true;
    s.appearance.conversationWidth = 900;
    s.theme.pageBackground = "#101418";
    const next = mergeSettings(s, { sidebar: { mode: "hidden" } });
    expect(next.sidebar.mode).toBe("hidden");
    expect(next.enabled).toBe(true);
    expect(next.appearance.useConversationWidth).toBe(true);
    expect(next.appearance.conversationWidth).toBe(900);
    expect(next.theme.pageBackground).toBe("#101418");
    expect(validateSettings(next)).toBe(true);
  });

  it("applying an appearance preset preserves sidebar.mode", () => {
    const s = cloneDefaults();
    s.sidebar.mode = "button";
    const next = mergeSettings(s, {
      preset: "minimal",
      appearance: cloneDefaults().appearance,
    });
    expect(next.preset).toBe("minimal");
    expect(next.sidebar.mode).toBe("button");
  });

  it("reset restores visible", () => {
    const s = cloneDefaults();
    s.sidebar.mode = "hidden";
    const reset = mergeSettings(s, cloneDefaults());
    expect(reset.sidebar.mode).toBe("visible");
  });

  it("malformed sidebar mode is rejected by the schema", () => {
    const s = cloneDefaults();
    // @ts-expect-error intentionally invalid mode to exercise the validator
    s.sidebar.mode = "diagonal";
    expect(validateSettings(s)).toBe(false);
  });

  it("explicit visible stays visible", () => {
    const s = cloneDefaults();
    s.sidebar.mode = "visible";
    expect(validateSettings(s)).toBe(true);
  });
});
