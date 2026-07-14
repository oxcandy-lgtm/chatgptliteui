import { describe, it, expect } from "vitest";
import {
  validateSettings,
  mergeSettings,
} from "../../src/settings/schema.js";
import { cloneDefaults } from "../../src/settings/defaults.js";
import { toEnvelope, migrateEnvelope } from "../../src/settings/migration.js";
import { SETTINGS_SCHEMA_VERSION } from "../../src/shared/types.js";

describe("settings schema validation", () => {
  it("accepts the cloned defaults", () => {
    expect(validateSettings(cloneDefaults())).toBe(true);
  });

  it("rejects a completely unrelated object", () => {
    expect(validateSettings({ foo: "bar" })).toBe(false);
    expect(validateSettings(null)).toBe(false);
    expect(validateSettings(42)).toBe(false);
  });

  it("rejects injected chat-content fields and never validates them", () => {
    const bad = cloneDefaults() as unknown as Record<string, unknown>;
    bad.messageText = "real conversation body";
    bad.chatTitle = "real conversation title";
    bad.copiedText = "real copied content";
    bad.innerHTML = "<script>alert(1)</script>";
    bad.url = "https://chatgpt.com/c/secret";
    bad.account = "user@example.com";
    expect(validateSettings(bad)).toBe(false);
  });

  it("rejects unknown nested keys", () => {
    const bad = cloneDefaults() as unknown as Record<string, unknown>;
    (bad.appearance as Record<string, unknown>).unknownFlag = true;
    expect(validateSettings(bad)).toBe(false);
  });

  it("rejects wrong enum values", () => {
    const bad = cloneDefaults();
    bad.preset = "super-lite" as unknown as typeof bad.preset;
    expect(validateSettings(bad)).toBe(false);
    const bad2 = cloneDefaults();
    bad2.sidebar.mode = "auto" as unknown as typeof bad2.sidebar.mode;
    expect(validateSettings(bad2)).toBe(false);
  });
});

describe("settings schema v2 specifics", () => {
  it("accepts neutral normal defaults (no visual overrides)", () => {
    const d = cloneDefaults();
    expect(d.preset).toBe("normal");
    expect(d.appearance.disableAnimations).toBe(false);
    expect(d.appearance.useTheme).toBe(false);
    expect(d.appearance.useConversationWidth).toBe(false);
    expect(d.appearance.useFontSize).toBe(false);
    expect(validateSettings(d)).toBe(true);
  });

  it("rejects out-of-range numeric bounds", () => {
    const bad = cloneDefaults();
    bad.appearance.conversationWidth = 100;
    expect(validateSettings(bad)).toBe(false);
    const bad2 = cloneDefaults();
    bad2.appearance.conversationWidth = 2000;
    expect(validateSettings(bad2)).toBe(false);
    const bad3 = cloneDefaults();
    bad3.appearance.fontSize = 9;
    expect(validateSettings(bad3)).toBe(false);
  });

  it("rejects fractional and non-integer numeric values", () => {
    const bad = cloneDefaults();
    bad.appearance.conversationWidth = 800.5;
    expect(validateSettings(bad)).toBe(false);
    const bad2 = cloneDefaults();
    bad2.appearance.fontSize = Number.NaN;
    expect(validateSettings(bad2)).toBe(false);
    const bad3 = cloneDefaults();
    bad3.appearance.fontSize = Infinity;
    expect(validateSettings(bad3)).toBe(false);
  });

  it("accepts safe color grammar (#rgb, #rrggbb, #rrggbbaa, transparent)", () => {
    const ok = cloneDefaults();
    ok.theme.pageBackground = "#abc";
    ok.theme.conversationBackground = "#abcdef";
    ok.theme.textColor = "#abcdef01";
    ok.theme.assistantBackground = "transparent";
    expect(validateSettings(ok)).toBe(true);
  });

  it("rejects malicious/invalid CSS color values", () => {
    const bad = cloneDefaults();
    bad.theme.pageBackground = "red; background:url(evil)";
    expect(validateSettings(bad)).toBe(false);
    const bad2 = cloneDefaults();
    bad2.theme.textColor = "var(--evil)";
    expect(validateSettings(bad2)).toBe(false);
    const bad3 = cloneDefaults();
    bad3.theme.codeBackground = "calc(1px + 2px)";
    expect(validateSettings(bad3)).toBe(false);
    const bad4 = cloneDefaults();
    bad4.theme.inputBackground = "#fff} {";
    expect(validateSettings(bad4)).toBe(false);
  });

  it("rejects assistant background that is not transparent or opaque hex", () => {
    const bad = cloneDefaults();
    bad.theme.assistantBackground = "rgba(0,0,0,0.5)";
    expect(validateSettings(bad)).toBe(false);
  });

  it("rejects unknown top-level and nested keys", () => {
    const bad = cloneDefaults() as unknown as Record<string, unknown>;
    (bad.appearance as Record<string, unknown>).unknownFlag = true;
    expect(validateSettings(bad)).toBe(false);
    const bad2 = cloneDefaults() as unknown as Record<string, unknown>;
    bad2.newSection = { x: 1 };
    expect(validateSettings(bad2)).toBe(false);
  });
});

describe("mergeSettings", () => {
  it("performs a validated deep merge of nested sections", () => {
    const base = cloneDefaults();
    const next = mergeSettings(base, {
      appearance: { ...base.appearance, conversationWidth: 900 },
      theme: { ...base.theme, pageBackground: "#222222" },
    });
    expect(next.appearance.conversationWidth).toBe(900);
    expect(next.theme.pageBackground).toBe("#222222");
    expect(next.enabled).toBe(true); // unchanged
  });

  it("rejects unknown injected fields in the patch", () => {
    const next = mergeSettings(cloneDefaults(), {
      messageText: "leak",
    } as unknown as Parameters<typeof mergeSettings>[1]);
    // Unknown top-level key must be ignored, not merged.
    expect((next as unknown as Record<string, unknown>).messageText).toBeUndefined();
    expect(validateSettings(next)).toBe(true);
  });

  it("never persists chat-content fields", () => {
    const next = mergeSettings(cloneDefaults(), {
      chatTitle: "title",
      copiedText: "copied",
      innerHTML: "<x>",
    } as unknown as Parameters<typeof mergeSettings>[1]);
    const asRec = next as unknown as Record<string, unknown>;
    expect(asRec.chatTitle).toBeUndefined();
    expect(asRec.copiedText).toBeUndefined();
    expect(asRec.innerHTML).toBeUndefined();
  });
});

describe("migration envelope", () => {
  it("round-trips current version through envelope", () => {
    const settings = cloneDefaults();
    settings.enabled = false;
    const env = toEnvelope(settings);
    expect(env.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    const back = migrateEnvelope(env);
    expect(back).not.toBeNull();
    expect(back?.enabled).toBe(false);
  });

  it("rejects an unknown future schema version", () => {
    const env = { schemaVersion: 999, settings: cloneDefaults() };
    expect(migrateEnvelope(env as never)).toBeNull();
  });

  it("falls back to defaults on malformed settings", () => {
    const env = { schemaVersion: 1, settings: { foo: "bar" } };
    const result = migrateEnvelope(env as never);
    // Invalid payload -> defaults (enabled true).
    expect(result).not.toBeNull();
    expect(result?.enabled).toBe(true);
  });
});

describe("defaults isolation", () => {
  it("cloneDefaults returns an independent object", () => {
    const a = cloneDefaults();
    const b = cloneDefaults();
    a.enabled = false;
    expect(b.enabled).toBe(true);
  });
});
