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
  const dom = new JSDOM(OPTIONS_HTML, { url: "https://chatgptliteui.local/options.html", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  const chrome = {
    storage: {
      local: {
        get: (k: string) => Promise.resolve({ [k]: store.settings }),
        set: (v: Record<string, unknown>) => {
          store.settings = (v.settings as StoredSettingsEnvelope);
          return Promise.resolve();
        },
      },
      onChanged: { addListener: () => {} },
    },
  };
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

function click(dom: JSDOM, id: string): void {
  (dom.window.document.getElementById(id) as HTMLButtonElement).dispatchEvent(
    new dom.window.Event("click", { bubbles: true }),
  );
}

describe("Options transparent assistant + reserved field (Blockers 6 & 7)", () => {
  afterEach(() => vi.resetModules());

  it("transparent assistant background round-trips as transparent", async () => {
    const s = cloneDefaults();
    s.theme.assistantBackground = "transparent";
    const { store, dom } = await setup(s);
    const input = dom.window.document.getElementById("assistantBackground") as HTMLInputElement;
    // Color input must never hold the literal "transparent".
    expect(input.value.toLowerCase()).not.toBe("transparent");
    // Checkbox reflects transparency.
    expect((dom.window.document.getElementById("assistantTransparent") as HTMLInputElement).checked).toBe(true);
    // Save persists transparent.
    click(dom, "save");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedSettings({ store, dom }).theme.assistantBackground).toBe("transparent");
    teardown();
  });

  it("opening and saving without changes does not convert transparent to black", async () => {
    const s = cloneDefaults();
    s.theme.assistantBackground = "transparent";
    const { store, dom } = await setup(s);
    // No edits: just save.
    click(dom, "save");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedSettings({ store, dom }).theme.assistantBackground).toBe("transparent");
    teardown();
  });

  it("opaque assistant colors round-trip", async () => {
    const s = cloneDefaults();
    s.theme.assistantBackground = "#224466";
    const { store, dom } = await setup(s);
    const input = dom.window.document.getElementById("assistantBackground") as HTMLInputElement;
    expect(input.value.toLowerCase()).toBe("#224466");
    expect((dom.window.document.getElementById("assistantTransparent") as HTMLInputElement).checked).toBe(false);
    click(dom, "save");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedSettings({ store, dom }).theme.assistantBackground).toBe("#224466");
    teardown();
  });

  it("toggling transparent off restores a valid opaque color", async () => {
    const s = cloneDefaults();
    s.theme.assistantBackground = "transparent";
    const { store, dom } = await setup(s);
    const cb = dom.window.document.getElementById("assistantTransparent") as HTMLInputElement;
    cb.checked = false;
    cb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const input = dom.window.document.getElementById("assistantBackground") as HTMLInputElement;
    expect(input.value.toLowerCase()).not.toBe("transparent");
    expect(input.value).toMatch(/^#[0-9a-fA-F]{6}$/);
    click(dom, "save");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedSettings({ store, dom }).theme.assistantBackground).toBe(input.value);
    teardown();
  });

  it("reserved writing-block background survives an unrelated save", async () => {
    const s = cloneDefaults();
    s.theme.writingBlockBackground = "#0a1b2c"; // non-default reserved value
    const { store, dom } = await setup(s);
    // Edit an unrelated field (font size) then save.
    (dom.window.document.getElementById("useFontSize") as HTMLInputElement).checked = true;
    (dom.window.document.getElementById("fontSize") as HTMLInputElement).value = "18";
    click(dom, "save");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedSettings({ store, dom }).theme.writingBlockBackground).toBe("#0a1b2c");
    teardown();
  });

  it("invalid color values are rejected (save fails closed)", async () => {
    const s = cloneDefaults();
    const { store, dom } = await setup(s);
    const input = dom.window.document.getElementById("pageBackground") as HTMLInputElement;
    input.value = "not-a-color";
    click(dom, "save");
    await new Promise((r) => setTimeout(r, 0));
    // Persisted settings must remain valid (unchanged valid default).
    expect(typeof storedSettings({ store, dom }).theme.pageBackground).toBe("string");
    expect(storedSettings({ store, dom }).theme.pageBackground).toMatch(/^#/);
    teardown();
  });
});
