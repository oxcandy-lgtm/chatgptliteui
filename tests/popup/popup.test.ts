import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../src/settings/defaults.js";
import { toEnvelope } from "../../src/settings/migration.js";
import type { Settings, StoredSettingsEnvelope } from "../../src/shared/types.js";

const POPUP_HTML = readFileSync(join(process.cwd(), "src/popup/popup.html"), "utf8");

interface Ctx {
  store: Record<string, unknown>;
  dom: JSDOM;
}

function storedSettings(ctx: Ctx): Settings {
  return (ctx.store.settings as StoredSettingsEnvelope).settings;
}

async function setup(initial: Settings, opts: { failSet?: boolean } = {}): Promise<Ctx> {
  const store: Record<string, unknown> = { settings: toEnvelope(initial) };
  const dom = new JSDOM(POPUP_HTML, { url: "https://chatgptliteui.local/popup.html", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  const chrome = {
    storage: {
      local: {
        get: (k: string) => Promise.resolve({ [k]: store.settings }),
        set: (v: Record<string, unknown>) => {
          if (opts.failSet) return Promise.reject(new Error("boom"));
          store.settings = (v.settings as StoredSettingsEnvelope);
          return Promise.resolve();
        },
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { openOptionsPage: () => {} },
  };
  g.chrome = chrome;
  await import("../../src/popup/popup.js");
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

function fire(dom: JSDOM, id: string, type = "change"): void {
  const el = dom.window.document.getElementById(id) as HTMLSelectElement;
  el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
}

function selectPreset(dom: JSDOM, value: string): void {
  const preset = dom.window.document.getElementById("preset") as HTMLSelectElement;
  preset.value = value;
  fire(dom, "preset");
}

describe("Popup preset application (Blocker 5)", () => {
  afterEach(() => vi.resetModules());

  it("disabled state remains disabled after selecting a preset", async () => {
    const s = cloneDefaults();
    s.enabled = false;
    s.preset = "normal";
    const { store, dom } = await setup(s);
    selectPreset(dom, "work");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedSettings({ store, dom }).enabled).toBe(false);
    expect(storedSettings({ store, dom }).preset).toBe("work");
    teardown();
  });

  it("two sequential preset changes use the latest persisted state", async () => {
    const s = cloneDefaults();
    s.enabled = true;
    s.preset = "normal";
    const { store, dom } = await setup(s);
    selectPreset(dom, "minimal");
    await new Promise((r) => setTimeout(r, 0));
    selectPreset(dom, "work");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedSettings({ store, dom }).preset).toBe("work");
    expect(storedSettings({ store, dom }).sidebar).toEqual(cloneDefaults().sidebar);
    teardown();
  });

  it("unrelated sidebar/history/copy/code settings remain unchanged", async () => {
    const s = cloneDefaults();
    s.enabled = true;
    s.preset = "normal";
    s.sidebar = { mode: "hover" };
    s.history = { enabled: true, visiblePairs: 10, mode: "safe" };
    const { store, dom } = await setup(s);
    selectPreset(dom, "ultra-lite");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedSettings({ store, dom }).sidebar.mode).toBe("hover");
    expect(storedSettings({ store, dom }).history.visiblePairs).toBe(10);
    teardown();
  });

  it("update errors produce a visible status and no unhandled rejection", async () => {
    const s = cloneDefaults();
    s.enabled = true;
    s.preset = "normal";
    const { dom } = await setup(s, { failSet: true });
    const captured: unknown[] = [];
    dom.window.addEventListener("unhandledrejection", (e) => captured.push(e));
    selectPreset(dom, "minimal");
    await new Promise((r) => setTimeout(r, 0));
    const status = dom.window.document.getElementById("status")!.textContent ?? "";
    expect(status).toMatch(/fail/i);
    expect(captured.length).toBe(0);
    teardown();
  });
});
