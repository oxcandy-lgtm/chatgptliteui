import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../src/settings/defaults.js";
import type { Settings, StoredSettingsEnvelope } from "../../src/shared/types.js";

function installDom(): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main role="main">
        <section data-testid="thread" aria-label="conversation">
          <article data-message-author-role="user"><p>u1</p></article>
        </section>
      </main>
      <form><textarea id="prompt-textarea"></textarea></form>
    </body></html>`,
    { url: "https://chatgpt.com/c/aaa", pretendToBeVisual: true },
  );
  return dom;
}

function makeSettings(): Settings {
  const s = cloneDefaults();
  s.enabled = true;
  s.appearance.disableAnimations = true;
  s.appearance.useTheme = true;
  return s;
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("Scoped mutation observer + route lifecycle (Blocker 1)", () => {
  let dom: JSDOM;
  let mod: typeof import("../../src/content/index.js");
  let onChangeCalls: number;

  beforeEach(async () => {
    vi.resetModules();
    dom = installDom();
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.location = dom.window.location;
    g.MutationObserver = dom.window.MutationObserver;
    g.Node = dom.window.Node;
    // Stub chrome.storage.local so getSettings returns an active profile.
    const env: StoredSettingsEnvelope = {
      schemaVersion: 2,
      settings: makeSettings(),
    };
    const chromeStub = {
      storage: {
        local: {
          get: (k: string) => Promise.resolve({ [k]: env }),
          set: (_v: unknown) => Promise.resolve(),
        },
        onChanged: { addListener: () => {} },
      },
    };
    g.chrome = chromeStub;

    onChangeCalls = 0;
    mod = await import("../../src/content/index.js");
    mod.routeListener.onChange(() => {
      onChangeCalls++;
    });
    mod.connectObserver();
  });

  afterEach(() => {
    if (mod) mod.teardown();
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.location;
    delete g.MutationObserver;
    delete g.Node;
    delete g.chrome;
  });

  it("marks a newly appended user turn", async () => {
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const turn = dom.window.document.createElement("article");
    turn.setAttribute("data-message-author-role", "user");
    thread.appendChild(turn);
    await flush();
    expect(dom.window.document.querySelectorAll("[data-cgl-user-turn]").length).toBeGreaterThanOrEqual(2);
  });

  it("marks a newly appended assistant turn", async () => {
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const turn = dom.window.document.createElement("article");
    turn.setAttribute("data-message-author-role", "assistant");
    thread.appendChild(turn);
    await flush();
    expect(dom.window.document.querySelectorAll("[data-cgl-assistant-turn]").length).toBeGreaterThanOrEqual(1);
  });

  it("same-route message additions receive active theme markers", async () => {
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const turn = dom.window.document.createElement("article");
    turn.setAttribute("data-message-author-role", "assistant");
    thread.appendChild(turn);
    await flush();
    // useTheme active -> cgl-theme root class present and conversation marked.
    expect(dom.window.document.documentElement.classList.contains("cgl-theme")).toBe(true);
    expect(dom.window.document.querySelector("[data-cgl-conversation-root]")).not.toBeNull();
  });

  it("history.pushState followed by mutation triggers route detection", async () => {
    dom.reconfigure({ url: "https://chatgpt.com/c/bbb" });
    dom.window.history.pushState({}, "", "https://chatgpt.com/c/bbb");
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const turn = dom.window.document.createElement("article");
    turn.setAttribute("data-message-author-role", "user");
    thread.appendChild(turn);
    await flush();
    expect(onChangeCalls).toBeGreaterThanOrEqual(1);
  });

  it("repeated route transitions do not duplicate observers or callbacks", async () => {
    const before = onChangeCalls;
    for (const id of ["ccc", "ddd", "eee"]) {
      dom.reconfigure({ url: `https://chatgpt.com/c/${id}` });
      dom.window.history.pushState({}, "", `https://chatgpt.com/c/${id}`);
      const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
      const turn = dom.window.document.createElement("article");
      turn.setAttribute("data-message-author-role", "user");
      thread.appendChild(turn);
      await flush();
    }
    // Exactly three new route detections (stable callback list, no duplicates).
    expect(onChangeCalls - before).toBe(3);
  });

  it("teardown disconnects observer and clears markers", async () => {
    // Ensure markers exist first.
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const turn = dom.window.document.createElement("article");
    turn.setAttribute("data-message-author-role", "assistant");
    thread.appendChild(turn);
    await flush();
    expect(dom.window.document.querySelectorAll("[data-cgl-assistant-turn]").length).toBeGreaterThanOrEqual(1);

    mod.teardown();
    expect(dom.window.document.querySelectorAll("[data-cgl-user-turn]").length).toBe(0);
    expect(dom.window.document.querySelectorAll("[data-cgl-assistant-turn]").length).toBe(0);
    expect(dom.window.document.documentElement.classList.length).toBe(0);
  });
});
