import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { SidebarController } from "../../../src/features/sidebar/sidebar-controller.js";
import { SidebarControlHost } from "../../../src/features/sidebar/sidebar-control-host.js";
import {
  isSafeSidebarDetection,
  normalizeSidebarTarget,
  findSafeSidebarTarget,
} from "../../../src/features/sidebar/sidebar-detection.js";
import {
  effectiveSidebarOpen,
  freshTransientState,
  hasRuntimeEffects,
  hasSidebarEffects,
} from "../../../src/features/sidebar/sidebar-state.js";
import { clearAllSidebarMarkers, markSidebar } from "../../../src/features/sidebar/sidebar-markers.js";
import { cloneDefaults } from "../../../src/settings/defaults.js";
import type { Settings, SidebarMode } from "../../../src/shared/types.js";
import type { ChatGptAdapter } from "../../../src/adapters/chatgpt-adapter.js";
import type { DetectionResult } from "../../../src/adapters/detection-result.js";

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

function settings(mode: SidebarMode, enabled = true): Settings {
  const s = cloneDefaults();
  s.enabled = enabled;
  s.sidebar.mode = mode;
  return s;
}

/** Adapter whose sidebar/composer/container results are scripted per test. */
class StubAdapter {
  sidebar: DetectionResult;
  container: DetectionResult;
  composer: DetectionResult;
  constructor(opts: {
    sidebar: DetectionResult;
    container: DetectionResult;
    composer?: DetectionResult;
  }) {
    this.sidebar = opts.sidebar;
    this.container = opts.container;
    this.composer = opts.composer ?? det({});
  }
  detectConversationContainer(): DetectionResult {
    return this.container;
  }
  detectSidebar(): DetectionResult {
    return this.sidebar;
  }
  detectComposer(): DetectionResult {
    return this.composer;
  }
  detectConversationColumn(): DetectionResult {
    return det({});
  }
  detectComposer2(): DetectionResult {
    return det({});
  }
  refresh(): void {}
}

function installDom(html: string): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://chatgpt.com/c/synthetic",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  return dom;
}

// Helper to build a ChatGPT-like sidebar wrapper with a chat-history nav.
function sidebarFixture(side: "left" | "right" = "left"): string {
  const left = side === "left";
  const aside = `<aside data-testid="sidebar" style="${left ? "left:0" : "right:0"};width:260px">
      <nav aria-label="Chat history">
        <a href="/c/1">Chat 1</a>
        <a href="/c/2">Chat 2</a>
        <button>New chat</button>
      </nav>
    </aside>`;
  // A conversation main region so the sidebar is structurally distinct.
  const main = `<main role="main"><section data-testid="thread"><div class="column"><p>hi</p></div></section></main>`;
  return left ? aside + main : main + aside;
}

describe("sidebar detection gate", () => {
  let d: JSDOM;
  beforeEach(() => {
    d = installDom(sidebarFixture());
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  function adapterFor(el: Element | null, confidence: DetectionResult["confidence"]): ChatGptAdapter {
    const main = d.window.document.querySelector('[role="main"]');
    return new StubAdapter({
      sidebar: det({ found: !!el, confidence, element: el as HTMLElement | null, elements: el ? [el as HTMLElement] : [] }),
      container: det({ found: true, confidence: "high", element: main as HTMLElement | null, elements: main ? [main as HTMLElement] : [] }),
    }) as unknown as ChatGptAdapter;
  }

  it("accepts high-confidence unique nav", () => {
    const nav = d.window.document.querySelector("nav")!;
    const a = adapterFor(nav, "high");
    expect(isSafeSidebarDetection(a.detectSidebar(), a as unknown as ChatGptAdapter)).toBe(true);
  });

  it("accepts medium-confidence unique sidebar wrapper", () => {
    const aside = d.window.document.querySelector('[data-testid="sidebar"]')!;
    const a = adapterFor(aside, "medium");
    expect(isSafeSidebarDetection(a.detectSidebar(), a as unknown as ChatGptAdapter)).toBe(true);
  });

  it("rejects low and unknown confidence", () => {
    const aside = d.window.document.querySelector('[data-testid="sidebar"]')!;
    for (const c of ["low", "unknown"] as const) {
      const a = adapterFor(aside, c);
      expect(isSafeSidebarDetection(a.detectSidebar(), a as unknown as ChatGptAdapter)).toBe(false);
    }
  });

  it("rejects ambiguous (multiple) candidates", () => {
    const aside = d.window.document.querySelector('[data-testid="sidebar"]')!;
    const res = det({ found: true, confidence: "high", element: aside as HTMLElement, elements: [aside as HTMLElement, aside as HTMLElement] });
    const a = new StubAdapter({
      sidebar: res,
      container: det({ found: true, confidence: "high", element: d.window.document.querySelector('[role="main"]') as HTMLElement, elements: [] }),
    }) as unknown as ChatGptAdapter;
    expect(isSafeSidebarDetection(res, a)).toBe(false);
  });

  it("rejects nav contained in a dialog", () => {
    const dlg = d.window.document.createElement("div");
    dlg.setAttribute("role", "dialog");
    const nav = d.window.document.querySelector("nav")!;
    dlg.appendChild(nav);
    d.window.document.body.appendChild(dlg);
    const a = adapterFor(nav, "high");
    expect(isSafeSidebarDetection(a.detectSidebar(), a as unknown as ChatGptAdapter)).toBe(false);
  });

  it("rejects the conversation main / composer", () => {
    const main = d.window.document.querySelector('[role="main"]')!;
    const a = adapterFor(main, "high");
    expect(isSafeSidebarDetection(a.detectSidebar(), a as unknown as ChatGptAdapter)).toBe(false);
  });

  it("detection failure leaves official UI unchanged (no marker)", () => {
    const a = new StubAdapter({
      sidebar: det({ found: false }),
      container: det({ found: true, confidence: "high", element: d.window.document.querySelector('[role="main"]') as HTMLElement, elements: [] }),
    }) as unknown as ChatGptAdapter;
    const target = findSafeSidebarTarget(a);
    expect(target).toBeNull();
    expect(d.window.document.querySelector('[data-cgl-sidebar-target]')).toBeNull();
  });
});

describe("sidebar safe wrapper normalization", () => {
  let d: JSDOM;
  beforeEach(() => {
    d = installDom(sidebarFixture());
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  it("nav-only detection normalizes to the unique wrapper", () => {
    const nav = d.window.document.querySelector("nav")!;
    const aside = d.window.document.querySelector('[data-testid="sidebar"]')!;
    const a = new StubAdapter({
      sidebar: det({ found: true, confidence: "high", element: nav as HTMLElement, elements: [nav as HTMLElement] }),
      container: det({ found: true, confidence: "high", element: d.window.document.querySelector('[role="main"]') as HTMLElement, elements: [] }),
    }) as unknown as ChatGptAdapter;
    const normalized = normalizeSidebarTarget(a.detectSidebar(), a);
    expect(normalized).toBe(aside as HTMLElement);
  });

  it("refuses unsafe ancestor normalization (wrapper inside main)", () => {
    // Wrap the sidebar inside main so normalization must refuse.
    const aside = d.window.document.querySelector('[data-testid="sidebar"]')!;
    const main = d.window.document.querySelector('[role="main"]')!;
    main.appendChild(aside);
    const nav = aside.querySelector("nav")!;
    const a = new StubAdapter({
      sidebar: det({ found: true, confidence: "high", element: nav as HTMLElement, elements: [nav as HTMLElement] }),
      container: det({ found: true, confidence: "high", element: main as HTMLElement, elements: [] }),
    }) as unknown as ChatGptAdapter;
    // nav is now inside main -> unsafe, must reject entirely.
    expect(isSafeSidebarDetection(a.detectSidebar(), a)).toBe(false);
    expect(normalizeSidebarTarget(a.detectSidebar(), a)).toBeNull();
  });

  it("safe wrapper case returns the wrapper directly", () => {
    const aside = d.window.document.querySelector('[data-testid="sidebar"]')!;
    const a = new StubAdapter({
      sidebar: det({ found: true, confidence: "medium", element: aside as HTMLElement, elements: [aside as HTMLElement] }),
      container: det({ found: true, confidence: "high", element: d.window.document.querySelector('[role="main"]') as HTMLElement, elements: [] }),
    }) as unknown as ChatGptAdapter;
    expect(normalizeSidebarTarget(a.detectSidebar(), a)).toBe(aside as HTMLElement);
  });
});

describe("sidebar modes (non-destructive behavior)", () => {
  let d: JSDOM;
  let controller: SidebarController;
  let adapter: ChatGptAdapter;
  beforeEach(() => {
    d = installDom(sidebarFixture());
    const aside = d.window.document.querySelector('[data-testid="sidebar"]') as HTMLElement;
    const main = d.window.document.querySelector('[role="main"]') as HTMLElement;
    adapter = new StubAdapter({
      sidebar: det({ found: true, confidence: "medium", element: aside, elements: [aside] }),
      container: det({ found: true, confidence: "high", element: main, elements: [main] }),
    }) as unknown as ChatGptAdapter;
    controller = new SidebarController(d.window.document.documentElement, adapter);
  });
  afterEach(() => {
    controller.teardown();
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  it("visible produces no cgl-sidebar-closed class, marker, or host", () => {
    controller.apply(settings("visible"));
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    expect(d.window.document.querySelector('[data-cgl-sidebar-target]')).toBeNull();
    expect(controller.isHostMounted).toBe(false);
  });

  it("hidden closes the sidebar (adds closed class + marker)", () => {
    controller.apply(settings("hidden"));
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    expect(d.window.document.querySelector('[data-cgl-sidebar-target]')).not.toBeNull();
    expect(controller.isHostMounted).toBe(false);
  });

  it("hidden shortcut temporarily opens then closes", () => {
    controller.apply(settings("hidden"));
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    controller.onKeyboardToggle();
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    controller.onKeyboardToggle();
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
  });

  it("button creates exactly one host and toggles aria-expanded", () => {
    controller.apply(settings("button"));
    expect(controller.isHostMounted).toBe(true);
    expect(d.window.document.querySelectorAll("#cgl-sidebar-control-host").length).toBe(1);
    const hostEl = d.window.document.getElementById("cgl-sidebar-control-host")!;
    const btn = hostEl.shadowRoot!.querySelector(".cgl-btn")!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    // Simulate click through the controller handler directly.
    controller["onButtonClick"]();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    // Escape closes.
    controller["onEscape"]();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
  });

  it("hover rail opens on pointer and closes after debounce", () => {
    controller.apply(settings("hover"));
    expect(controller.isHostMounted).toBe(true);
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    controller["onRailEnter"]();
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    controller["onRailLeave"]();
    // After debounce the sidebar should close again.
    vi.useFakeTimers();
    controller["onRailLeave"]();
    vi.advanceTimersByTime(250);
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    vi.useRealTimers();
  });

  it("mode change clears transient override", () => {
    controller.apply(settings("hidden"));
    controller.onKeyboardToggle(); // temporarily open
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    controller.clearTransient();
    controller.apply(settings("visible"));
    // Now visible with no override -> official UI untouched.
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    expect(d.window.document.querySelector('[data-cgl-sidebar-target]')).toBeNull();
  });

  it("disabled restores official UI", () => {
    controller.apply(settings("hidden"));
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(true);
    controller.apply(settings("hidden", false));
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    expect(d.window.document.querySelector('[data-cgl-sidebar-target]')).toBeNull();
    expect(controller.isHostMounted).toBe(false);
  });
});

describe("sidebar restoration", () => {
  let d: JSDOM;
  let controller: SidebarController;
  beforeEach(() => {
    d = installDom(sidebarFixture());
    const aside = d.window.document.querySelector('[data-testid="sidebar"]') as HTMLElement;
    const main = d.window.document.querySelector('[role="main"]') as HTMLElement;
    const adapter = new StubAdapter({
      sidebar: det({ found: true, confidence: "medium", element: aside, elements: [aside] }),
      container: det({ found: true, confidence: "high", element: main, elements: [main] }),
    }) as unknown as ChatGptAdapter;
    controller = new SidebarController(d.window.document.documentElement, adapter);
    controller.apply(settings("button"));
  });
  afterEach(() => {
    controller.teardown();
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  it("removes all root classes, marker, and host; idempotent", () => {
    controller.restore();
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    expect(d.window.document.querySelector('[data-cgl-sidebar-target]')).toBeNull();
    expect(controller.isHostMounted).toBe(false);
    // ChatGPT classes/inline styles untouched.
    const aside = d.window.document.querySelector('[data-testid="sidebar"]')!;
    expect(aside.getAttribute("style")).toContain("width:260px");
    expect(aside.classList.contains("cgl-sidebar-closed")).toBe(false);
    // Second restore is safe.
    controller.restore();
    expect(controller.isHostMounted).toBe(false);
  });

  it("teardown cancels pending hover-close timer (no leak)", () => {
    // Switch to hover, pin open, then leave to start the timer.
    controller.clearTransient();
    controller.apply(settings("hover"));
    controller["onRailEnter"]();
    controller["onRailLeave"]();
    controller.teardown();
    // After teardown the controller is disabled; a stray timer firing must
    // not re-mark the DOM.
    expect(d.window.document.querySelector('[data-cgl-sidebar-target]')).toBeNull();
  });
});

describe("sidebar transient state preserved on route refresh", () => {
  let d: JSDOM;
  let controller: SidebarController;
  let adapter: ChatGptAdapter;
  beforeEach(() => {
    d = installDom(sidebarFixture());
    const aside = d.window.document.querySelector('[data-testid="sidebar"]') as HTMLElement;
    const main = d.window.document.querySelector('[role="main"]') as HTMLElement;
    adapter = new StubAdapter({
      sidebar: det({ found: true, confidence: "medium", element: aside, elements: [aside] }),
      container: det({ found: true, confidence: "high", element: main, elements: [main] }),
    }) as unknown as ChatGptAdapter;
    controller = new SidebarController(d.window.document.documentElement, adapter);
  });
  afterEach(() => {
    controller.teardown();
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  it("hidden override persists across refresh", () => {
    controller.apply(settings("hidden"));
    controller.onKeyboardToggle(); // temporarily open
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    controller.refresh(settings("hidden"));
    // Transient override preserved.
    expect(d.window.document.documentElement.classList.contains("cgl-sidebar-closed")).toBe(false);
    expect(controller.transientState.temporaryOverride).toBe("open");
  });
});

describe("sidebar control host", () => {
  let d: JSDOM;
  beforeEach(() => {
    d = installDom(sidebarFixture());
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  it("mounts exactly one host and never duplicates on repeated mount", () => {
    const host = new SidebarControlHost();
    host.mount("button", "left", {});
    host.mount("button", "left", {});
    expect(d.window.document.querySelectorAll("#cgl-sidebar-control-host").length).toBe(1);
    host.unmount();
    expect(d.window.document.querySelectorAll("#cgl-sidebar-control-host").length).toBe(0);
  });

  it("host is not inside the ChatGPT sidebar and carries an extension marker", () => {
    const host = new SidebarControlHost();
    host.mount("hover", "right", {});
    const el = d.window.document.getElementById("cgl-sidebar-control-host")!;
    const sidebar = d.window.document.querySelector('[data-testid="sidebar"]')!;
    expect(sidebar.contains(el)).toBe(false);
    expect(el.getAttribute("data-cgl-sidebar-host")).toBe("true");
    expect(d.window.document.body.contains(el)).toBe(true);
    host.unmount();
  });
});

describe("sidebar state helpers", () => {
  it("hasSidebarEffects / hasRuntimeEffects", () => {
    expect(hasSidebarEffects(settings("visible"))).toBe(false);
    expect(hasSidebarEffects(settings("hidden"))).toBe(true);
    // Normal + visible -> no runtime effects.
    const normalVisible = settings("visible");
    normalVisible.preset = "normal";
    expect(hasRuntimeEffects(normalVisible)).toBe(false);
    // visible + non-normal appearance -> runtime effects true.
    const customVisible = settings("visible");
    customVisible.preset = "custom";
    customVisible.appearance.useConversationWidth = true;
    expect(hasRuntimeEffects(customVisible)).toBe(true);
    // Normal + hidden -> runtime effects true (sidebar active).
    const normalHidden = settings("hidden");
    normalHidden.preset = "normal";
    expect(hasRuntimeEffects(normalHidden)).toBe(true);
  });

  it("effectiveSidebarOpen per mode", () => {
    const t = freshTransientState();
    expect(effectiveSidebarOpen("visible", t)).toBe(true);
    expect(effectiveSidebarOpen("hidden", t)).toBe(false);
    const tHiddenOpen = { ...t, temporaryOverride: "open" as const };
    expect(effectiveSidebarOpen("hidden", tHiddenOpen)).toBe(true);
    const tVisClosed = { ...t, temporaryOverride: "closed" as const };
    expect(effectiveSidebarOpen("visible", tVisClosed)).toBe(false);
    const tButton = { ...t, buttonOpen: true };
    expect(effectiveSidebarOpen("button", tButton)).toBe(true);
    const tHover = { ...t, hoverActive: true };
    expect(effectiveSidebarOpen("hover", tHover)).toBe(true);
  });
});

describe("sidebar markers", () => {
  let d: JSDOM;
  beforeEach(() => {
    d = installDom(sidebarFixture());
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  it("mark/unmark and clearAll are idempotent", () => {
    const aside = d.window.document.querySelector('[data-testid="sidebar"]')!;
    markSidebar(aside);
    expect(aside.getAttribute("data-cgl-sidebar-target")).toBe("true");
    clearAllSidebarMarkers(d.window.document);
    expect(d.window.document.querySelector('[data-cgl-sidebar-target]')).toBeNull();
    clearAllSidebarMarkers(d.window.document);
    expect(d.window.document.querySelector('[data-cgl-sidebar-target]')).toBeNull();
  });
});
