import { describe, it, expect } from "vitest";
import { migrateEnvelope, toEnvelope } from "../../src/settings/migration.js";
import { cloneDefaults } from "../../src/settings/defaults.js";
import { validateSettings } from "../../src/settings/schema.js";
import { SETTINGS_SCHEMA_VERSION } from "../../src/shared/types.js";
import type { Settings } from "../../src/shared/types.js";

function v1Envelope(v1: Record<string, unknown>): never {
  return { schemaVersion: 1, settings: v1 } as never;
}

describe("v1 -> v2 migration", () => {
  it("untouched v1 default (preset normal) migrates to no-override normal", () => {
    const v1 = {
      enabled: true,
      preset: "normal",
      appearance: {
        disableAnimations: false,
        disableBlur: false,
        disableShadows: false,
        conversationWidth: 768,
        fontSize: 16,
        compactSpacing: false,
      },
      theme: {
        pageBackground: "#101318",
        conversationBackground: "#151922",
        userBackground: "#1c2636",
        assistantBackground: "transparent",
        inputBackground: "#1c222d",
        codeBackground: "#11151c",
        writingBlockBackground: "#161b25",
        textColor: "#e7eaf0",
      },
    };
    const migrated = migrateEnvelope(v1Envelope(v1));
    expect(migrated).not.toBeNull();
    const s = migrated as Settings;
    expect(s.preset).toBe("normal");
    expect(s.appearance.disableAnimations).toBe(false);
    expect(s.appearance.useTheme).toBe(false);
    expect(s.appearance.useConversationWidth).toBe(false);
    expect(s.appearance.useFontSize).toBe(false);
  });

  it("v1 minimal preset migrates to the Phase 2 minimal profile", () => {
    const v1 = {
      enabled: true,
      preset: "minimal",
      appearance: {
        disableAnimations: false,
        disableBlur: false,
        disableShadows: false,
        conversationWidth: 768,
        fontSize: 16,
        compactSpacing: false,
      },
    };
    const s = migrateEnvelope(v1Envelope(v1)) as Settings;
    expect(s.preset).toBe("minimal");
    expect(s.appearance.disableAnimations).toBe(true);
    expect(s.appearance.disableBlur).toBe(true);
    expect(s.appearance.disableShadows).toBe(true);
    expect(s.appearance.useTheme).toBe(false);
  });

  it("v1 work preset migrates to width 880 + compact", () => {
    const v1 = {
      preset: "work",
      appearance: { compactSpacing: false, conversationWidth: 768 },
    };
    const s = migrateEnvelope(v1Envelope(v1)) as Settings;
    expect(s.preset).toBe("work");
    expect(s.appearance.compactSpacing).toBe(true);
    expect(s.appearance.useConversationWidth).toBe(true);
    expect(s.appearance.conversationWidth).toBe(880);
  });

  it("v1 ultra-lite preset migrates to width 720 + font 15", () => {
    const v1 = {
      preset: "ultra-lite",
      appearance: { compactSpacing: false, conversationWidth: 768, fontSize: 16 },
    };
    const s = migrateEnvelope(v1Envelope(v1)) as Settings;
    expect(s.preset).toBe("ultra-lite");
    expect(s.appearance.conversationWidth).toBe(720);
    expect(s.appearance.useFontSize).toBe(true);
    expect(s.appearance.fontSize).toBe(15);
  });

  it("manually edited v1 migrates to custom and preserves values", () => {
    const v1 = {
      preset: "normal",
      appearance: {
        disableAnimations: false,
        disableBlur: false,
        disableShadows: false,
        conversationWidth: 768,
        fontSize: 16,
        compactSpacing: true, // edited away from untouched default
      },
    };
    const s = migrateEnvelope(v1Envelope(v1)) as Settings;
    expect(s.preset).toBe("custom");
    expect(s.appearance.compactSpacing).toBe(true);
  });

  it("preserves valid v2 payloads unchanged", () => {
    const v2 = cloneDefaults();
    v2.enabled = false;
    v2.preset = "work";
    const env = toEnvelope(v2);
    const back = migrateEnvelope(env);
    expect(back).not.toBeNull();
    expect(back?.enabled).toBe(false);
    expect(back?.preset).toBe("work");
  });

  it("unknown future schema version fails closed to defaults", () => {
    const env = { schemaVersion: 999, settings: cloneDefaults() };
    expect(migrateEnvelope(env as never)).toBeNull();
  });

  it("malformed settings fall back to defaults (enabled true)", () => {
    const env = v1Envelope({ foo: "bar" });
    const result = migrateEnvelope(env);
    expect(result).not.toBeNull();
    expect(result?.enabled).toBe(true);
    expect(validateSettings(result as Settings)).toBe(true);
  });

  it("current version is 2", () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
  });
});
