import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { cloneDefaults } from "../../src/settings/defaults.js";
import type { Settings, StoredSettingsEnvelope } from "../../src/shared/types.js";

/**
 * Deterministic fake MutationObserver. index.ts uses the global
 * `MutationObserver`; we inject this so tests trigger callbacks explicitly
 * rather than depending on jsdom's real observer scheduling (which varies by
 * environment). The debounce (setTimeout) inside index.ts is still real.
 */
class FakeMutationObserver {
  static last: FakeMutationObserver | null = null;
  cb: (mutations: MutationRecord[], obs: FakeMutationObserver) => void;
  target: Node | null = null;
  disconnected = false;
  constructor(cb: (mutations: MutationRecord[], obs: FakeMutationObserver) => void) {
    this.cb = cb;
    FakeMutationObserver.last = this;
  }
  observe(target: Node): void {
    this.target = target;
    this.disconnected = false;
  }
  disconnect(): void {
    this.disconnected = true;
    this.target = null;
  }
  /** Synchronously deliver an added-node batch to the registered callback. */
  trigger(nodes: Node[]): void {
    const mutations = [
      { addedNodes: nodes as unknown as NodeListOf<Node> } as MutationRecord,
    ];
    this.cb(mutations, this);
  }
}

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
    setEnv(makeSettings());
    dom = installDom();
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.location = dom.window.location;
    g.MutationObserver = FakeMutationObserver;
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
    FakeMutationObserver.last = null;
  });

  function thread(): Element {
    return dom.window.document.querySelector('[data-testid="thread"]')!;
  }

  function appendUser(): Element {
    const turn = dom.window.document.createElement("article");
    turn.setAttribute("data-message-author-role", "user");
    thread().appendChild(turn);
    return turn;
  }

  function appendAssistant(): Element {
    const turn = dom.window.document.createElement("article");
    turn.setAttribute("data-message-author-role", "assistant");
    thread().appendChild(turn);
    return turn;
  }

  it("marks a newly appended user turn", async () => {
    const turn = appendUser();
    FakeMutationObserver.last!.trigger([turn]);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("marks a newly appended assistant turn", async () => {
    const turn = appendAssistant();
    FakeMutationObserver.last!.trigger([turn]);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-assistant-turn]").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("same-route message additions receive active theme markers", async () => {
    const turn = appendAssistant();
    FakeMutationObserver.last!.trigger([turn]);
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
    const turn = appendUser();
    FakeMutationObserver.last!.trigger([turn]);
    await flushDebounce();
    expect(onChangeCalls).toBeGreaterThanOrEqual(1);
  });

  it("repeated route transitions do not duplicate observers or callbacks", async () => {
    const before = onChangeCalls;
    for (const id of ["ccc", "ddd", "eee"]) {
      dom.reconfigure({ url: `https://chatgpt.com/c/${id}` });
      dom.window.history.pushState({}, "", `https://chatgpt.com/c/${id}`);
      const turn = appendUser();
      FakeMutationObserver.last!.trigger([turn]);
      await flushDebounce();
    }
    expect(onChangeCalls - before).toBe(3);
  });

  it("teardown disconnects observer and clears markers", async () => {
    const turn = appendAssistant();
    FakeMutationObserver.last!.trigger([turn]);
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
    const normal = makeSettings({ appearance: cloneDefaults().appearance });
    setEnv(normal);
    mod.syncRuntime(normal);
    appendUser();
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
    appendUser();
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
    const before = dom.window.document.querySelectorAll("[data-cgl-user-turn]").length;
    const turn = appendUser();
    FakeMutationObserver.last!.trigger([turn]);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBe(before + 1);
  });

  it("Work -> Normal disconnects the observer", async () => {
    const normal = makeSettings({ appearance: cloneDefaults().appearance });
    setEnv(normal);
    mod.syncRuntime(normal);
    const turn = appendUser();
    FakeMutationObserver.last!.trigger([turn]);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBe(0);
  });

  it("Normal -> Work reconnects exactly one observer", async () => {
    const normal = makeSettings({ appearance: cloneDefaults().appearance });
    setEnv(normal);
    mod.syncRuntime(normal);
    const work = makeSettings();
    setEnv(work);
    mod.syncRuntime(work);
    const before = dom.window.document.querySelectorAll("[data-cgl-user-turn]").length;
    const turn = appendUser();
    FakeMutationObserver.last!.trigger([turn]);
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBe(before + 1);
  });

  it("teardown cancels a pending debounced refresh so it cannot re-mark", async () => {
    const turn = appendUser();
    FakeMutationObserver.last!.trigger([turn]);
    // Do NOT wait for the debounce; tear down immediately.
    mod.teardown();
    await flushDebounce();
    expect(
      dom.window.document.querySelectorAll("[data-cgl-user-turn]").length,
    ).toBe(0);
  });

  it("multiple synchronous mutation batches coalesce into one marker refresh", async () => {
    const baseline = dom.window.document.querySelectorAll("[data-cgl-user-turn]").length;
    const turns: Node[] = [];
    for (let i = 0; i < 5; i++) turns.push(appendUser());
    for (let i = 0; i < 5; i++) turns.push(appendAssistant());
    // A single triggered batch (coalesced) schedules exactly one debounced refresh.
    FakeMutationObserver.last!.trigger(turns);
    // Immediately after the trigger: debounce pending, no new marks yet.
    await flush();
    const immediate = dom.window.document.querySelectorAll("[data-cgl-user-turn]").length;
    expect(immediate).toBe(baseline);
    // After the single debounce window, one coalesced refresh marked every turn.
    await flushDebounce();
    const after = dom.window.document.querySelectorAll("[data-cgl-user-turn]").length;
    expect(after).toBe(baseline + 5);
  });
});
