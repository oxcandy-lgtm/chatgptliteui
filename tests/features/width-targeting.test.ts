import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { AppearanceController } from "../../src/features/appearance/appearance-controller.js";
import { cloneDefaults } from "../../src/settings/defaults.js";
import type { Settings } from "../../src/shared/types.js";
import type { ChatGptAdapter } from "../../src/adapters/chatgpt-adapter.js";
import type { DetectionResult } from "../../src/adapters/detection-result.js";

function det(partial: Partial<DetectionResult>): DetectionResult {
  return {
    found: false,
    confidence: "unknown",
    strategy: "test",
    reason: "unit",
    timestamp: 0,
    elements: [],
    element: null,
    ...partial,
  } as DetectionResult;
}

function settings(): Settings {
  const s = cloneDefaults();
  s.enabled = true;
  s.appearance.useConversationWidth = true;
  s.appearance.conversationWidth = 800;
  return s;
}

/** Minimal adapter stub whose detection can be scripted per test. */
class StubAdapter {
  container: DetectionResult;
  column: DetectionResult;
  constructor(opts: { container: DetectionResult; column: DetectionResult }) {
    this.container = opts.container;
    this.column = opts.column;
  }
  detectConversationContainer(): DetectionResult {
    return this.container;
  }
  detectConversationColumn(): DetectionResult {
    return this.column;
  }
  detectComposer(): DetectionResult {
    return det({});
  }
  detectUserTurns(): DetectionResult {
    return det({ found: true, confidence: "high", elements: [] });
  }
  detectAssistantTurns(): DetectionResult {
    return det({ found: true, confidence: "high", elements: [] });
  }
  refresh(): void {}
}

function installDom(): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main role="main">
        <section data-testid="thread"><div class="column"><p>hi</p></div></section>
      </main>
    </body></html>`,
    { url: "https://chatgpt.com/c/synthetic", pretendToBeVisual: true },
  );
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  return dom;
}

describe("Conversation width targeting (Blocker 3)", () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  it("never marks [role=main] itself with a width marker", () => {
    const main = dom.window.document.querySelector('[role="main"]')!;
    const adapter = new StubAdapter({
      container: det({ found: true, confidence: "high", element: main as HTMLElement }),
      column: det({ found: true, confidence: "high", element: main as HTMLElement }),
    }) as unknown as ChatGptAdapter;
    const c = new AppearanceController(dom.window.document.documentElement, adapter);
    c.apply(settings());
    // The whole main shell must never receive a width class.
    expect(main.hasAttribute("data-cgl-conversation-column")).toBe(false);
    expect(main.hasAttribute("data-cgl-conversation-root")).toBe(true);
    // But CSS width rule targets the column marker, not the root.
  });

  it("low-confidence column detection does not activate width", () => {
    const main = dom.window.document.querySelector('[role="main"]')!;
    const column = dom.window.document.querySelector(".column")!;
    const adapter = new StubAdapter({
      container: det({ found: true, confidence: "high", element: main as HTMLElement }),
      column: det({ found: true, confidence: "low", element: column as HTMLElement }),
    }) as unknown as ChatGptAdapter;
    const c = new AppearanceController(dom.window.document.documentElement, adapter);
    c.apply(settings());
    expect(column.hasAttribute("data-cgl-conversation-column")).toBe(false);
  });

  it("medium/high unique column detection activates width marker", () => {
    const main = dom.window.document.querySelector('[role="main"]')!;
    const column = dom.window.document.querySelector(".column")!;
    for (const conf of ["medium", "high"] as const) {
      const adapter = new StubAdapter({
        container: det({ found: true, confidence: "high", element: main as HTMLElement }),
        column: det({ found: true, confidence: conf, element: column as HTMLElement }),
      }) as unknown as ChatGptAdapter;
      const c = new AppearanceController(dom.window.document.documentElement, adapter);
      c.apply(settings());
      expect(column.hasAttribute("data-cgl-conversation-column")).toBe(true);
      c.restore();
    }
  });

  it("ambiguous columns result in no width override", () => {
    const main = dom.window.document.querySelector('[role="main"]')!;
    const a = new StubAdapter({
      container: det({ found: true, confidence: "high", element: main as HTMLElement }),
      column: det({ found: false, confidence: "unknown", elements: [], element: null }),
    }) as unknown as ChatGptAdapter;
    const c = new AppearanceController(dom.window.document.documentElement, a);
    c.apply(settings());
    const column = dom.window.document.querySelector(".column")!;
    expect(column.hasAttribute("data-cgl-conversation-column")).toBe(false);
  });
});

// Fix 3: every detected surface must pass isSafeCosmeticDetection before a
// marker is added. User and Assistant turns use the same uniform gate.
describe("Confidence-gated surface marking (Fix 3)", () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  class TurnStubAdapter extends StubAdapter {
    constructor(opts: {
      container: DetectionResult;
      column: DetectionResult;
      user: DetectionResult;
      assistant: DetectionResult;
    }) {
      super(opts);
      this.userConf = opts.user;
      this.assistantConf = opts.assistant;
    }
    userConf: DetectionResult;
    assistantConf: DetectionResult;
    override detectUserTurns(): DetectionResult {
      return this.userConf;
    }
    override detectAssistantTurns(): DetectionResult {
      return this.assistantConf;
    }
  }

  function mkRoot(): HTMLElement {
    return dom.window.document.documentElement;
  }

  it("low-confidence User result creates no marker", () => {
    const main = dom.window.document.querySelector('[role="main"]')!;
    const adapter = new TurnStubAdapter({
      container: det({ found: true, confidence: "high", element: main as HTMLElement }),
      column: det({ found: true, confidence: "high", element: main as HTMLElement }),
      user: det({ found: true, confidence: "low", elements: [main as HTMLElement] }),
      assistant: det({ found: true, confidence: "high", elements: [] }),
    }) as unknown as ChatGptAdapter;
    const c = new AppearanceController(mkRoot(), adapter);
    c.apply(settings());
    expect(main.hasAttribute("data-cgl-user-turn")).toBe(false);
  });

  it("low-confidence Assistant result creates no marker", () => {
    const main = dom.window.document.querySelector('[role="main"]')!;
    const adapter = new TurnStubAdapter({
      container: det({ found: true, confidence: "high", element: main as HTMLElement }),
      column: det({ found: true, confidence: "high", element: main as HTMLElement }),
      user: det({ found: true, confidence: "high", elements: [] }),
      assistant: det({ found: true, confidence: "low", elements: [main as HTMLElement] }),
    }) as unknown as ChatGptAdapter;
    const c = new AppearanceController(mkRoot(), adapter);
    c.apply(settings());
    expect(main.hasAttribute("data-cgl-assistant-turn")).toBe(false);
  });

  it("medium/high User and Assistant results are marked", () => {
    const main = dom.window.document.querySelector('[role="main"]')!;
    for (const [uc, ac] of [
      ["medium", "medium"],
      ["high", "high"],
    ] as const) {
      const adapter = new TurnStubAdapter({
        container: det({ found: true, confidence: "high", element: main as HTMLElement }),
        column: det({ found: true, confidence: "high", element: main as HTMLElement }),
        user: det({ found: true, confidence: uc, elements: [main as HTMLElement] }),
        assistant: det({ found: true, confidence: ac, elements: [main as HTMLElement] }),
      }) as unknown as ChatGptAdapter;
      const c = new AppearanceController(mkRoot(), adapter);
      c.apply(settings());
      expect(main.hasAttribute("data-cgl-user-turn")).toBe(true);
      expect(main.hasAttribute("data-cgl-assistant-turn")).toBe(true);
      c.restore();
    }
  });

  it("unknown/ambiguous results leave the DOM unchanged", () => {
    const main = dom.window.document.querySelector('[role="main"]')!;
    const adapter = new TurnStubAdapter({
      container: det({ found: true, confidence: "high", element: main as HTMLElement }),
      column: det({ found: true, confidence: "high", element: main as HTMLElement }),
      user: det({ found: false, confidence: "unknown", elements: [] }),
      assistant: det({ found: false, confidence: "unknown", elements: [] }),
    }) as unknown as ChatGptAdapter;
    const c = new AppearanceController(mkRoot(), adapter);
    c.apply(settings());
    expect(main.hasAttribute("data-cgl-user-turn")).toBe(false);
    expect(main.hasAttribute("data-cgl-assistant-turn")).toBe(false);
  });
});
