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

function makeSettings(overrides?: Partial<Settings>): Settings {
  const s = cloneDefaults();
  s.enabled = true;
  s.appearance.disableAnimations = true;
  s.appearance.useTheme = true;
  if (overrides) Object.assign(s, overrides);
  return s;
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Wait past the 120ms debounce window. */
function flushDebounce(): Promise<void> {
  return new Promise((r) => setTimeout(r, 200));
}

describe("Scoped mutation observer + route lifecycle (Fix 1/2)", () => {
  let dom: JSDOM;
  let mod: typeof import("../../src/content/index.js");
  let onChangeCalls: number;
  let lastEnv: StoredSettingsEnvelope;

  function setEnv(settings: Settings): void {
    lastEnv = { schemaVersion: 2, settings };
  }

  beforeEach(async () => {
    vi.resetModules();
    // Installed defaults to an active Work-like profile so an observer exists.
    setEnv(makeSettings());
    dom = installDom();
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.location = dom.window.location;
    g.MutationObserver = dom.window.MutationObserver;
    g.Node = dom.window.Node;
    const chromeStub = {
      storage: {
        local: {
          get: (k: string) => Promise.resolve({ [k]: lastEnv }),
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
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("marks a newly appended assistant turn", async () => {
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const turn = dom.window.document.createElement("article");
    turn.setAttribute("data-message-author-role", "assistant");
    thread.appendChild(turn);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-assistant-turn]").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("same-route message additions receive active theme markers", async () => {
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const turn = dom.window.document.createElement("article");
    turn.setAttribute("data-message-author-role", "assistant");
    thread.appendChild(turn);
    await flushDebounce();
    expect(
      dom.window.document.documentElement.classList.contains("cgl-theme"),
    ).toBe(true);
    expect(
      dom.window.document.querySelector("[data-cgl-conversation-root]"),
    ).not.toBeNull();
  });

  it("history.pushState followed by mutation triggers route detection", async () => {
    dom.reconfigure({ url: "https://chatgpt.com/c/bbb" });
    dom.window.history.pushState({}, "", "https://chatgpt.com/c/bbb");
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const turn = dom.window.document.createElement("article");
    turn.setAttribute("data-message-author-role", "user");
    thread.appendChild(turn);
    await flushDebounce();
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
      await flushDebounce();
    }
    expect(onChangeCalls - before).toBe(3);
  });

  it("teardown disconnects observer and clears markers", async () => {
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const turn = dom.window.document.createElement("article");
    turn.setAttribute("data-message-author-role", "assistant");
    thread.appendChild(turn);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-assistant-turn]").length,
    ).toBeGreaterThanOrEqual(1);

    mod.teardown();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBe(0);
    expect(
      dom.window.document.querySelectorAll("[data-cgl-assistant-turn]").length,
    ).toBe(0);
    expect(dom.window.document.documentElement.classList.length).toBe(0);
  });

  // --- Fix 2: effect-aware observer lifecycle ---

  it("a Normal (no-effect) profile connects no observer", async () => {
    mod.teardown();
    setEnv(makeSettings({ appearance: cloneDefaults().appearance }));
    mod.syncRuntime(makeSettings({ appearance: cloneDefaults().appearance }));
    // After syncRuntime with no effect, no observer should be active.
    const probe = dom.window.document.createElement("article");
    probe.setAttribute("data-message-author-role", "user");
    dom.window.document.querySelector('[data-testid="thread"]')!.appendChild(probe);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBe(0);
  });

  it("a disabled profile connects no observer", async () => {
    mod.teardown();
    const disabled = makeSettings();
    disabled.enabled = false;
    setEnv(disabled);
    mod.syncRuntime(disabled);
    const probe = dom.window.document.createElement("article");
    probe.setAttribute("data-message-author-role", "user");
    dom.window.document.querySelector('[data-testid="thread"]')!.appendChild(probe);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBe(0);
  });

  it("an active (Work) profile connects exactly one observer", async () => {
    mod.teardown();
    const work = makeSettings();
    setEnv(work);
    mod.syncRuntime(work);
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const before = dom.window.document.querySelectorAll("[data-cgl-user-turn]").length;
    const probe = dom.window.document.createElement("article");
    probe.setAttribute("data-message-author-role", "user");
    thread.appendChild(probe);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBe(before + 1);
  });

  it("Work -> Normal disconnects the observer", async () => {
    // Start active (observer present from beforeEach).
    const normal = makeSettings({ appearance: cloneDefaults().appearance });
    setEnv(normal);
    mod.syncRuntime(normal);
    const probe = dom.window.document.createElement("article");
    probe.setAttribute("data-message-author-role", "user");
    dom.window.document.querySelector('[data-testid="thread"]')!.appendChild(probe);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBe(0);
  });

  it("Normal -> Work reconnects exactly one observer", async () => {
    // Drop to Normal first.
    const normal = makeSettings({ appearance: cloneDefaults().appearance });
    setEnv(normal);
    mod.syncRuntime(normal);
    // Now activate Work.
    const work = makeSettings();
    setEnv(work);
    mod.syncRuntime(work);
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const before = dom.window.document.querySelectorAll("[data-cgl-user-turn]").length;
    const probe = dom.window.document.createElement("article");
    probe.setAttribute("data-message-author-role", "user");
    thread.appendChild(probe);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBe(before + 1);
  });

  it("teardown cancels a pending debounced refresh so it cannot re-mark", async () => {
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    const probe = dom.window.document.createElement("article");
    probe.setAttribute("data-message-author-role", "user");
    thread.appendChild(probe);
    // Do NOT wait for the debounce; tear down immediately.
    mod.teardown();
    await flushDebounce();
    // Teardown cleared markers; the cancelled pending refresh must not re-add.
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBe(0);
  });

  it("multiple synchronous mutation batches coalesce into one marker refresh", async () => {
    const thread = dom.window.document.querySelector('[data-testid="thread"]')!;
    // Baseline markers from the initial apply.
    const baseline = dom.window.document.querySelectorAll("[data-cgl-user-turn]").length;
    // Simulate a burst of separate mutation batches (user + assistant turns).
    for (let i = 0; i < 5; i++) {
      const probe = dom.window.document.createElement("article");
      probe.setAttribute("data-message-author-role", "user");
      thread.appendChild(probe);
    }
    for (let i = 0; i < 5; i++) {
      const probe = dom.window.document.createElement("article");
      probe.setAttribute("data-message-author-role", "assistant");
      thread.appendChild(probe);
    }
    // Immediately after the burst: debounce is still pending, so appended turns
    // must NOT be marked yet (no per-batch refresh).
    await flush();
    const immediate = dom.window.document.querySelectorAll("[data-cgl-user-turn]").length;
    expect(immediate).toBe(baseline);
    // After the single debounce window, exactly one coalesced refresh has run,
    // marking every appended turn at once (not one refresh per batch).
    await flushDebounce();
    const after = dom.window.document.querySelectorAll("[data-cgl-user-turn]").length;
    expect(after).toBe(baseline + 5);
  });
});
