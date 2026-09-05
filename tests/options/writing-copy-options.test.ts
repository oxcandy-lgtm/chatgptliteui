import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../src/settings/defaults.js";
import { toEnvelope } from "../../src/settings/migration.js";
import type { Settings, StoredSettingsEnvelope } from "../../src/shared/types.js";

const OPTIONS_HTML = readFileSync(join(process.cwd(), "src/options/options.html"), "utf8");

interface Ctx {
  store: Record<string, unknown>;
  dom: JSDOM;
}

function storedSettings(ctx: Ctx): Settings {
  return (ctx.store.settings as StoredSettingsEnvelope).settings;
}

async function setup(initial: Settings): Promise<Ctx> {
  const store: Record<string, unknown> = { settings: toEnvelope(initial) };
  const historyKeys = new Map<string, unknown>();
  const dom = new JSDOM(OPTIONS_HTML, { url: "https://chatgptliteui.local/options.html", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  const chrome = {
    storage: {
      local: {
        get: (k: string | null) => {
          if (k === null) {
            const out: Record<string, unknown> = Object.fromEntries(historyKeys);
            out.settings = store.settings;
            return Promise.resolve(out);
          }
          if (historyKeys.has(k)) return Promise.resolve({ [k]: historyKeys.get(k) });
          if (k in store) return Promise.resolve({ [k]: store[k] });
          return Promise.resolve({});
        },
        set: (v: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(v)) store[key] = value;
          return Promise.resolve();
        },
        remove: (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) historyKeys.delete(key);
          return Promise.resolve();
        },
      },
      onChanged: { addListener: () => {} },
    },
  };
  // Seed copied-history keys through the same remove() map so enumeration
  // sees them.
  historyKeys.set("cgl:writingCopy:history:" + "a".repeat(32), []);
  historyKeys.set("cgl:writingCopy:history:" + "b".repeat(32), []);
  historyKeys.set("unrelated:key", { keep: true });
  g.chrome = chrome;
  await import("../../src/options/options.js");
  await new Promise((r) => setTimeout(r, 0));
  return { store, dom };
}

function teardown(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.document;
  delete g.chrome;
  vi.resetModules();
}

describe("Options Writing Copy / CopyMarker section", () => {
  afterEach(() => vi.resetModules());

  it("round-trips every Phase 4 writingCopy control through save", async () => {
    const s = cloneDefaults();
    s.writingCopy = {
      ...s.writingCopy,
      enabled: true,
      position: "smart",
      shortcutEnabled: true,
      markerEnabled: true,
      markerColor: "#112233",
      markerOpacity: 45,
      pulseEnabled: true,
      pulseColor: "#445566",
      pulseIntensity: 25,
      pulsePeriodMs: 6000,
      backgroundEnabled: true,
    };
    const { store, dom } = await setup(s);
    // Form reflects stored values.
    expect((dom.window.document.getElementById("writingCopyMarkerColor") as HTMLInputElement).value).toBe("#112233");
    expect((dom.window.document.getElementById("writingCopyMarkerOpacity") as HTMLInputElement).value).toBe("45");
    expect((dom.window.document.getElementById("writingCopyPulsePeriod") as HTMLInputElement).value).toBe("6000");
    expect((dom.window.document.getElementById("writingCopyBackgroundEnabled") as HTMLInputElement).checked).toBe(true);
    // Edit and save.
    (dom.window.document.getElementById("writingCopyPulsePeriod") as HTMLInputElement).value = "8000";
    click(dom, "save");
    await new Promise((r) => setTimeout(r, 0));
    const saved = storedSettings({ store, dom }).writingCopy;
    expect(saved.position).toBe("smart");
    expect(saved.markerColor).toBe("#112233");
    expect(saved.pulsePeriodMs).toBe(8000);
    expect(saved.backgroundEnabled).toBe(true);
    teardown();
  });

  it("clear copy history removes only cgl:writingCopy:history:* keys", async () => {
    const s = cloneDefaults();
    const { dom } = await setup(s);
    click(dom, "clearCopyHistory");
    await new Promise((r) => setTimeout(r, 0));
    const status = (dom.window.document.getElementById("status") as HTMLSpanElement).textContent ?? "";
    expect(status).toContain("Cleared copied-state history (2 conversations)");
    teardown();
  });
});

function click(dom: JSDOM, id: string): void {
  (dom.window.document.getElementById(id) as HTMLButtonElement).dispatchEvent(
    new dom.window.Event("click", { bubbles: true }),
  );
}
