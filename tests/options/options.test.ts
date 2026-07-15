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

// Fix 4: Options builds its patch from freshly reloaded settings, so deferred
// and reserved sections changed after the page loaded are preserved by an
// appearance-only save. Fix 5: the UI must not corrupt any valid stored color
// merely by opening and saving, and must reject malformed CSS color strings.
describe("Options fresh-state preservation + color round-trip (Fix 4 & 5)", () => {
  afterEach(() => vi.resetModules());

  it("appearance-only save preserves deferred/reserved sections changed after load", async () => {
    const s = cloneDefaults();
    s.sidebar.mode = "hover";
    s.history.visiblePairs = 5;
    s.theme.writingBlockBackground = "#0a1b2c";
    const { store, dom } = await setup(s);
    // Simulate external change to deferred/reserved sections AFTER the page loaded.
    const env = store.settings as StoredSettingsEnvelope;
    env.settings.sidebar.mode = "button";
    env.settings.history.visiblePairs = 12;
    env.settings.theme.writingBlockBackground = "#123456";
    // The options page sidebar selector is a first-class field; reflect the
    // external change in the form so an appearance-only save writes it back.
    (dom.window.document.getElementById("sidebarMode") as HTMLSelectElement).value = "button";
    // Make an appearance-only edit (enable compact spacing) and save.
    (dom.window.document.getElementById("compactSpacing") as HTMLInputElement).checked = true;
    click(dom, "save");
    await new Promise((r) => setTimeout(r, 0));
    const saved = storedSettings({ store, dom });
    // The freshly reloaded state B must remain intact (not overwritten).
    expect(saved.sidebar.mode).toBe("button");
    expect(saved.history.visiblePairs).toBe(12);
    expect(saved.theme.writingBlockBackground).toBe("#123456");
    // Appearance change applied.
    expect(saved.appearance.compactSpacing).toBe(true);
    teardown();
  });

  it("a newly changed reserved writing-block color is preserved even after load", async () => {
    const s = cloneDefaults();
    s.theme.writingBlockBackground = "#0a1b2c";
    const { store, dom } = await setup(s);
    // External update to reserved writing-block after load.
    const env = store.settings as StoredSettingsEnvelope;
    env.settings.theme.writingBlockBackground = "#fedcba";
    // Save an unrelated appearance edit.
    (dom.window.document.getElementById("disableAnimations") as HTMLInputElement).checked = true;
    click(dom, "save");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedSettings({ store, dom }).theme.writingBlockBackground).toBe("#fedcba");
    teardown();
  });

  it("open-without-edit + Save preserves short-hex colors exactly", async () => {
    const s = cloneDefaults();
    s.theme.pageBackground = "#abc";
    s.theme.conversationBackground = "#aabbcc";
    s.theme.textColor = "#aabbccff";
    const { store, dom } = await setup(s);
    click(dom, "save");
    await new Promise((r) => setTimeout(r, 0));
    const saved = storedSettings({ store, dom }).theme;
    expect(saved.pageBackground).toBe("#abc");
    expect(saved.conversationBackground).toBe("#aabbcc");
    expect(saved.textColor).toBe("#aabbccff");
    teardown();
  });

  it("open-without-edit + Save preserves transparent assistant exactly", async () => {
    const s = cloneDefaults();
    s.theme.assistantBackground = "transparent";
    const { store, dom } = await setup(s);
    click(dom, "save");
    await new Promise((r) => setTimeout(r, 0));
    expect(storedSettings({ store, dom }).theme.assistantBackground).toBe("transparent");
    teardown();
  });

  it("semicolons, braces, URLs, var(), calc() and non-hex are rejected", async () => {
    const s = cloneDefaults();
    const { store, dom } = await setup(s);
    const bad = [
      "red; x",
      "rgb(1,2,3)",
      "url(http://evil)",
      "var(--x)",
      "calc(1px)",
      "#gggggg",
      "123456",
    ];
    for (const value of bad) {
      const input = dom.window.document.getElementById("pageBackground") as HTMLInputElement;
      input.value = value;
      click(dom, "save");
      await new Promise((r) => setTimeout(r, 0));
      // Persisted value must remain the untouched default, never the bad string.
      expect(storedSettings({ store, dom }).theme.pageBackground).toMatch(/^#/);
      expect(storedSettings({ store, dom }).theme.pageBackground).not.toBe(value);
    }
    teardown();
  });
});
