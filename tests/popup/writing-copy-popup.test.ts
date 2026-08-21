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

let originalGlobalsPopup: Record<string, unknown> | null = null;

async function setup(initial: Settings): Promise<Ctx> {
  originalGlobalsPopup = {
    window: globalThis.window,
    document: globalThis.document,
    chrome: globalThis.chrome,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    navigator: globalThis.navigator,
  };
  const store: Record<string, unknown> = { settings: toEnvelope(initial) };
  const dom = new JSDOM(POPUP_HTML, { url: "https://chatgptliteui.local/popup.html", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.chrome = {
    storage: {
      local: {
        get: (k: string) => Promise.resolve({ [k]: store.settings }),
        set: (v: Record<string, unknown>) => {
          store.settings = v.settings as StoredSettingsEnvelope;
          return Promise.resolve();
        },
      },
    },
    runtime: { openOptionsPage: () => {} },
  };
  await import("../../src/popup/popup.js");
  await new Promise((r) => setTimeout(r, 0));
  return { store, dom };
}

function teardown(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (originalGlobalsPopup) {
    (Object.keys(originalGlobalsPopup) as (keyof typeof originalGlobalsPopup)[]).forEach((k) => {
      if (originalGlobalsPopup![k] === undefined) {
        try { delete (g as Record<string, unknown>)[k]; } catch { /* ignore */ }
      } else {
        try {
          const desc = Object.getOwnPropertyDescriptor(globalThis, k);
          if (desc && !desc.writable) return;
          g[k] = originalGlobalsPopup![k];
        } catch { /* ignore */ }
      }
    });
    originalGlobalsPopup = null;
  }
  vi.resetModules();
}

describe("writing-copy popup toggle", () => {
  afterEach(() => vi.resetModules());

  it("popup patches only writingCopy.enabled", async () => {
    const s = cloneDefaults();
    s.writingCopy.enabled = false;
    s.sidebar = { mode: "hover" };
    const { store, dom } = await setup(s);
    const cb = dom.window.document.getElementById("writingCopyEnabled") as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(storedSettings({ store, dom }).writingCopy.enabled).toBe(true);
    // Unrelated settings preserved.
    expect(storedSettings({ store, dom }).sidebar.mode).toBe("hover");
    expect(storedSettings({ store, dom }).preset).toBe("normal");
    teardown();
  });

  it("popup preserves every unrelated setting", async () => {
    const s = cloneDefaults();
    s.enabled = false;
    s.preset = "work";
    s.sidebar = { mode: "button" };
    s.history = { enabled: true, visiblePairs: 7, mode: "aggressive" };
    s.appearance.useTheme = true;
    s.writingCopy = { enabled: true, position: "top-right", shortcutEnabled: false };
    const { store, dom } = await setup(s);
    const cb = dom.window.document.getElementById("writingCopyEnabled") as HTMLInputElement;
    cb.checked = false;
    cb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const saved = storedSettings({ store, dom });
    expect(saved.writingCopy.enabled).toBe(false);
    expect(saved.enabled).toBe(false);
    expect(saved.preset).toBe("work");
    expect(saved.sidebar.mode).toBe("button");
    expect(saved.history.visiblePairs).toBe(7);
    expect(saved.appearance.useTheme).toBe(true);
    expect(saved.writingCopy.position).toBe("top-right");
    teardown();
  });
});
