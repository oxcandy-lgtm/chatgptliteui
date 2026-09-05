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
        disableAnimations: true,
        disableBlur: true,
        disableShadows: true,
        compactSpacing: false,
        conversationWidth: 768,
        fontSize: 16,
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
      appearance: {
        disableAnimations: true,
        disableBlur: true,
        disableShadows: true,
        compactSpacing: true,
        conversationWidth: 880,
        fontSize: 16,
      },
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
      appearance: {
        disableAnimations: true,
        disableBlur: true,
        disableShadows: true,
        compactSpacing: true,
        conversationWidth: 720,
        fontSize: 15,
      },
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

  it("preserves valid v3 payloads unchanged", () => {
    const v3 = cloneDefaults();
    v3.enabled = false;
    v3.preset = "work";
    const env = toEnvelope(v3);
    const back = migrateEnvelope(env);
    expect(back).not.toBeNull();
    expect(back?.enabled).toBe(false);
    expect(back?.preset).toBe("work");
    expect(back?.writingCopy.position).toBe("smart");
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

  it("current version is 3", () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(3);
  });

  describe("v2 -> v3 migration (Phase 4 writingCopy extension)", () => {
    const v2Base = (): Record<string, unknown> => {
      const s = cloneDefaults();
      // Simulate a stored v2 payload: strip the Phase 4 fields.
      const { markerEnabled: _m, markerColor: _mc, markerOpacity: _mo, pulseEnabled: _p, pulseColor: _pc, pulseIntensity: _pi, pulsePeriodMs: _pp, backgroundEnabled: _b, ...legacyWritingCopy } = s.writingCopy;
      void _m; void _mc; void _mo; void _p; void _pc; void _pi; void _pp; void _b;
      return JSON.parse(JSON.stringify({
        enabled: s.enabled,
        preset: s.preset,
        appearance: s.appearance,
        sidebar: s.sidebar,
        history: s.history,
        writingCopy: legacyWritingCopy,
        codeBlocks: s.codeBlocks,
        theme: s.theme,
      })) as Record<string, unknown>;
    };

    function v2Envelope(v2: Record<string, unknown>): never {
      return { schemaVersion: 2, settings: v2 } as never;
    }

    it("populates Phase 4 defaults while preserving every valid v2 setting", () => {
      const v2 = v2Base();
      const s = migrateEnvelope(v2Envelope(v2)) as Settings;
      expect(s).not.toBeNull();
      // New fields populated from defaults.
      expect(s.writingCopy.markerEnabled).toBe(true);
      expect(s.writingCopy.markerOpacity).toBe(30);
      expect(s.writingCopy.pulsePeriodMs).toBe(4000);
      expect(s.writingCopy.backgroundEnabled).toBe(false);
      // No explicit legacy choice: position becomes the new default `smart`.
      expect(s.writingCopy.position).toBe("smart");
      // Old settings preserved.
      expect(s.enabled).toBe(true);
      expect(s.appearance.useTheme).toBe(false);
      expect(s.theme.writingBlockBackground).toBe("#161b25");
      expect(validateSettings(s)).toBe(true);
    });

    it("preserves an explicit legacy position choice", () => {
      const v2 = v2Base();
      (v2.writingCopy as Record<string, unknown>).position = "top-right";
      (v2.writingCopy as Record<string, unknown>).enabled = true;
      const s = migrateEnvelope(v2Envelope(v2)) as Settings;
      expect(s.writingCopy.position).toBe("top-right");
      expect(s.writingCopy.enabled).toBe(true);
      // New fields still populated.
      expect(s.writingCopy.markerEnabled).toBe(true);
    });

    it("preserves custom appearance from v2", () => {
      const v2 = v2Base();
      (v2 as { appearance: Record<string, unknown> }).appearance.disableAnimations = true;
      (v2 as { sidebar: { mode: string } }).sidebar.mode = "hover";
      (v2 as { history: { visiblePairs: number } }).history.visiblePairs = 11;
      const s = migrateEnvelope(v2Envelope(v2)) as Settings;
      expect(s.appearance.disableAnimations).toBe(true);
      expect(s.sidebar.mode).toBe("hover");
      expect(s.history.visiblePairs).toBe(11);
      expect(s.preset).toBe("normal");
    });
  });

  describe("Blocker 8: preserve valid custom v1 appearance", () => {
    it("custom v1 with active width preserves the custom width", () => {
      const v1 = {
        preset: "custom",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          useConversationWidth: true,
          conversationWidth: 1024,
          useFontSize: false,
          fontSize: 16,
          useTheme: false,
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("custom");
      expect(s.appearance.useConversationWidth).toBe(true);
      expect(s.appearance.conversationWidth).toBe(1024);
    });

    it("custom v1 with active font preserves the custom font size", () => {
      const v1 = {
        preset: "custom",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          useConversationWidth: false,
          conversationWidth: 768,
          useFontSize: true,
          fontSize: 20,
          useTheme: false,
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("custom");
      expect(s.appearance.useFontSize).toBe(true);
      expect(s.appearance.fontSize).toBe(20);
    });

    it("custom v1 with active theme preserves all theme colors", () => {
      const v1 = {
        preset: "custom",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          useConversationWidth: false,
          conversationWidth: 768,
          useFontSize: false,
          fontSize: 16,
          useTheme: true,
        },
        theme: {
          pageBackground: "#101010",
          conversationBackground: "#111111",
          userBackground: "#222222",
          assistantBackground: "#333333",
          inputBackground: "#444444",
          codeBackground: "#555555",
          writingBlockBackground: "#666666",
          textColor: "#eeeeee",
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("custom");
      expect(s.appearance.useTheme).toBe(true);
      expect(s.theme.pageBackground).toBe("#101010");
      expect(s.theme.assistantBackground).toBe("#333333");
      expect(s.theme.textColor).toBe("#eeeeee");
    });

    it("known preset name with non-matching profile migrates to custom (not reset)", () => {
      // v1 "work" preset but with custom width -> must preserve, not reset.
      const v1 = {
        preset: "work",
        appearance: {
          disableAnimations: true,
          disableBlur: true,
          disableShadows: true,
          compactSpacing: true,
          useConversationWidth: true,
          conversationWidth: 1100, // not the locked 880
          useFontSize: false,
          fontSize: 16,
          useTheme: false,
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("custom");
      expect(s.appearance.useConversationWidth).toBe(true);
      expect(s.appearance.conversationWidth).toBe(1100);
    });

    it("malformed custom v1 colors fail closed (no invalid color persisted)", () => {
      const v1 = {
        preset: "custom",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          conversationWidth: 768,
          fontSize: 16,
          compactSpacing: false,
        },
        theme: {
          pageBackground: "not-a-color",
          conversationBackground: "#111111",
          userBackground: "#222222",
          assistantBackground: "#333333",
          inputBackground: "#444444",
          codeBackground: "#555555",
          writingBlockBackground: "#666666",
          textColor: "#eeeeee",
        },
      };
      // validateSettings rejects the malformed color, so migrateEnvelope falls
      // back to defaults rather than trusting invalid data.
      const result = migrateEnvelope(v1Envelope(v1));
      expect(result).toBeNull();
    });
  });

  // Fix 1: the real schema-v1 payload did NOT contain useConversationWidth /
  // useFontSize / useTheme. These tests prove migration using the actual
  // flag-less v1 shape, deriving activation from values (and theme presence).
  describe("Fix 1: flag-less v1 shape (actual schema)", () => {
    it("flag-less v1 custom theme sets useTheme true", () => {
      const v1 = {
        preset: "custom",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          conversationWidth: 768,
          fontSize: 16,
        },
        theme: {
          pageBackground: "#101010",
          conversationBackground: "#111111",
          userBackground: "#222222",
          assistantBackground: "#333333",
          inputBackground: "#444444",
          codeBackground: "#555555",
          writingBlockBackground: "#666666",
          textColor: "#eeeeee",
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("custom");
      expect(s.appearance.useTheme).toBe(true);
    });

    it("flag-less v1 custom width becomes active", () => {
      const v1 = {
        preset: "custom",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          conversationWidth: 1024, // non-default
          fontSize: 16,
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("custom");
      expect(s.appearance.useConversationWidth).toBe(true);
      expect(s.appearance.conversationWidth).toBe(1024);
    });

    it("flag-less v1 custom font becomes active", () => {
      const v1 = {
        preset: "custom",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          conversationWidth: 768,
          fontSize: 20, // non-default
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("custom");
      expect(s.appearance.useFontSize).toBe(true);
      expect(s.appearance.fontSize).toBe(20);
    });

    it("flag-less v1 custom theme colors are preserved", () => {
      const v1 = {
        preset: "custom",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          conversationWidth: 768,
          fontSize: 16,
        },
        theme: {
          pageBackground: "#101010",
          conversationBackground: "#111111",
          userBackground: "#222222",
          assistantBackground: "#333333",
          inputBackground: "#444444",
          codeBackground: "#555555",
          writingBlockBackground: "#666666",
          textColor: "#eeeeee",
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.theme.pageBackground).toBe("#101010");
      expect(s.theme.assistantBackground).toBe("#333333");
      expect(s.theme.textColor).toBe("#eeeeee");
      expect(s.theme.writingBlockBackground).toBe("#666666");
    });

    it("flag-less v1 custom preserves anim/blur/shadow/compact flags", () => {
      const v1 = {
        preset: "custom",
        appearance: {
          disableAnimations: true,
          disableBlur: true,
          disableShadows: true,
          compactSpacing: true,
          conversationWidth: 768,
          fontSize: 16,
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("custom");
      expect(s.appearance.disableAnimations).toBe(true);
      expect(s.appearance.disableBlur).toBe(true);
      expect(s.appearance.disableShadows).toBe(true);
      expect(s.appearance.compactSpacing).toBe(true);
    });

    it("invalid flag-less v1 color fails closed", () => {
      const v1 = {
        preset: "custom",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          conversationWidth: 768,
          fontSize: 16,
        },
        theme: {
          pageBackground: "var(--evil)",
          conversationBackground: "#111111",
          userBackground: "#222222",
          assistantBackground: "#333333",
          inputBackground: "#444444",
          codeBackground: "#555555",
          writingBlockBackground: "#666666",
          textColor: "#eeeeee",
        },
      };
      expect(migrateEnvelope(v1Envelope(v1))).toBeNull();
    });
  });

  // Final-contract migration correction: a known preset name whose actual
  // v1 appearance does NOT match the locked profile must classify as custom AND
  // derive theme/width/font activation from the stored values (flag-less v1).
  describe("Final-contract: known-preset non-matching profile -> custom with derived activation", () => {
    it("preset work + untouched-default appearance + valid theme -> custom, useTheme true, colors preserved", () => {
      const v1 = {
        enabled: true,
        preset: "work",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          conversationWidth: 768,
          fontSize: 16,
        },
        theme: {
          pageBackground: "#101010",
          conversationBackground: "#111111",
          userBackground: "#222222",
          assistantBackground: "#333333",
          inputBackground: "#444444",
          codeBackground: "#555555",
          writingBlockBackground: "#666666",
          textColor: "#eeeeee",
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("custom");
      expect(s.appearance.useTheme).toBe(true);
      expect(s.theme.pageBackground).toBe("#101010");
      expect(s.theme.assistantBackground).toBe("#333333");
      expect(s.theme.writingBlockBackground).toBe("#666666");
      expect(s.theme.textColor).toBe("#eeeeee");
    });

    it("known preset name + custom width + valid theme -> custom, width active, theme active", () => {
      const v1 = {
        preset: "minimal",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          conversationWidth: 1100, // non-default vs locked 768
          fontSize: 16,
        },
        theme: {
          pageBackground: "#101010",
          conversationBackground: "#111111",
          userBackground: "#222222",
          assistantBackground: "#333333",
          inputBackground: "#444444",
          codeBackground: "#555555",
          writingBlockBackground: "#666666",
          textColor: "#eeeeee",
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("custom");
      expect(s.appearance.useConversationWidth).toBe(true);
      expect(s.appearance.conversationWidth).toBe(1100);
      expect(s.appearance.useTheme).toBe(true);
    });

    it("known preset name + invalid theme -> fail closed", () => {
      const v1 = {
        preset: "work",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          conversationWidth: 768,
          fontSize: 16,
        },
        theme: {
          pageBackground: "rgb(1,2,3)", // invalid per grammar
          conversationBackground: "#111111",
          userBackground: "#222222",
          assistantBackground: "#333333",
          inputBackground: "#444444",
          codeBackground: "#555555",
          writingBlockBackground: "#666666",
          textColor: "#eeeeee",
        },
      };
      expect(migrateEnvelope(v1Envelope(v1))).toBeNull();
    });

    it("exact untouched minimal preset -> locked profile, useTheme false", () => {
      const v1 = {
        preset: "minimal",
        appearance: {
          disableAnimations: true,
          disableBlur: true,
          disableShadows: true,
          compactSpacing: false,
          conversationWidth: 768,
          fontSize: 16,
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("minimal");
      expect(s.appearance.disableAnimations).toBe(true);
      expect(s.appearance.useTheme).toBe(false);
      expect(s.appearance.useConversationWidth).toBe(false);
    });

    it("exact untouched work preset -> locked profile, useTheme false", () => {
      const v1 = {
        preset: "work",
        appearance: {
          disableAnimations: true,
          disableBlur: true,
          disableShadows: true,
          compactSpacing: true,
          conversationWidth: 880,
          fontSize: 16,
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("work");
      expect(s.appearance.useTheme).toBe(false);
      expect(s.appearance.conversationWidth).toBe(880);
    });

    it("exact untouched ultra-lite preset -> locked profile, useTheme false", () => {
      const v1 = {
        preset: "ultra-lite",
        appearance: {
          disableAnimations: true,
          disableBlur: true,
          disableShadows: true,
          compactSpacing: true,
          conversationWidth: 720,
          fontSize: 15,
        },
      };
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("ultra-lite");
      expect(s.appearance.useTheme).toBe(false);
      expect(s.appearance.fontSize).toBe(15);
    });

    it("untouched Normal remains a no-op (preset normal, useTheme false)", () => {
      const v1 = {
        enabled: true,
        preset: "normal",
        appearance: {
          disableAnimations: false,
          disableBlur: false,
          disableShadows: false,
          compactSpacing: false,
          conversationWidth: 768,
          fontSize: 16,
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
      const s = migrateEnvelope(v1Envelope(v1)) as Settings;
      expect(s.preset).toBe("normal");
      expect(s.appearance.useTheme).toBe(false);
      expect(s.appearance.useConversationWidth).toBe(false);
      expect(s.appearance.useFontSize).toBe(false);
    });
  });
});
