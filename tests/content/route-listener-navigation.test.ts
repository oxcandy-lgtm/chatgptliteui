import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RouteListener, type RouteInfo } from "../../src/content/route-listener.js";

/**
 * REGRESSION 1 — History-API SPA navigation is detected WITHOUT popstate,
 * pageshow, or any DOM mutation signal (the d403/3bf61cb detection gap:
 * ChatGPT sidebar navigation commits pushState-style entries that fire
 * neither popstate nor pageshow).
 *
 * REGRESSION 5 — teardown detaches every route signal (popstate, pageshow,
 * Navigation API) and start/stop/start never duplicates listeners.
 */

class FakeNavigation {
  listeners = new Map<string, Set<() => void>>();
  addCalls: string[] = [];
  removeCalls: string[] = [];
  addEventListener(type: string, cb: () => void): void {
    this.addCalls.push(type);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.removeCalls.push(type);
    this.listeners.get(type)?.delete(cb);
  }
  dispatch(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function makeWindow(url: string, navigation: FakeNavigation | null): Record<string, unknown> {
  const listeners = new Map<string, Set<() => void>>();
  const u = new URL(url);
  const location = {
    get href(): string {
      return u.href;
    },
    get pathname(): string {
      return u.pathname;
    },
    __set(path: string): void {
      u.pathname = path;
    },
  };
  return {
    location,
    __listeners: listeners,
    addEventListener: (type: string, cb: () => void): void => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: () => void): void => {
      listeners.get(type)?.delete(cb);
    },
    __dispatch: (type: string): void => {
      for (const cb of [...(listeners.get(type) ?? [])]) cb();
    },
    navigation,
  };
}

describe("route-listener history-API detection + teardown", () => {
  let win: Record<string, unknown>;
  let nav: FakeNavigation;
  let originalWindow: unknown;

  beforeEach(() => {
    originalWindow = (globalThis as unknown as Record<string, unknown>).window;
    nav = new FakeNavigation();
    win = makeWindow("https://chatgpt.com/c/C1", nav);
  });

  afterEach(() => {
    (globalThis as unknown as Record<string, unknown>).window = originalWindow;
  });

  function install(): void {
    (globalThis as unknown as Record<string, unknown>).window = win;
  }

  it("navigation commit without popstate/pageshow/mutation fires exactly once", async () => {
    install();
    const listener = new RouteListener();
    const seen: RouteInfo[] = [];
    listener.onChange((info: RouteInfo) => {
      seen.push(info);
    });
    listener.start();

    // SPA commit: URL changes, Navigation API fires, nothing else does.
    (win.location as { __set(p: string): void }).__set("/c/C2");
    nav.dispatch("currententrychange");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pathname).toBe("/c/C2");

    // A later mutation-driven check() for the same entry must NOT duplicate.
    listener.check();
    expect(seen).toHaveLength(1);

    // A popstate for the same entry must NOT duplicate either.
    (win.__dispatch as (t: string) => void)("popstate");
    expect(seen).toHaveLength(1);
    listener.stop();
  });

  it("popstate fallback still works when the Navigation API is absent", async () => {
    win = makeWindow("https://chatgpt.com/c/C1", null);
    install();
    const listener = new RouteListener();
    const seen: RouteInfo[] = [];
    listener.onChange((info: RouteInfo) => {
      seen.push(info);
    });
    listener.start();
    (win.location as { __set(p: string): void }).__set("/c/C2");
    (win.__dispatch as (t: string) => void)("popstate");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pathname).toBe("/c/C2");
    listener.stop();
  });

  it("stop() detaches all three signals; start/stop/start never duplicates", async () => {
    install();
    const listener = new RouteListener();
    const seen: RouteInfo[] = [];
    listener.onChange((info: RouteInfo) => {
      seen.push(info);
    });
    listener.start();
    listener.start(); // idempotent: no duplicate registration
    expect(nav.count("currententrychange")).toBe(1);
    expect(
      (win.__listeners as Map<string, Set<() => void>>).get("popstate")?.size,
    ).toBe(1);
    expect(
      (win.__listeners as Map<string, Set<() => void>>).get("pageshow")?.size,
    ).toBe(1);

    listener.stop();
    expect(nav.count("currententrychange")).toBe(0);
    expect(nav.removeCalls).toContain("currententrychange");
    expect(
      (win.__listeners as Map<string, Set<() => void>>).get("popstate")?.size ?? 0,
    ).toBe(0);
    expect(
      (win.__listeners as Map<string, Set<() => void>>).get("pageshow")?.size ?? 0,
    ).toBe(0);

    // No callback after stop through any signal.
    (win.location as { __set(p: string): void }).__set("/c/C9");
    nav.dispatch("currententrychange");
    (win.__dispatch as (t: string) => void)("popstate");
    listener.check();
    expect(seen).toHaveLength(0);

    // Restart works exactly once per signal.
    listener.onChange((info: RouteInfo) => {
      seen.push(info);
    });
    listener.start();
    expect(nav.count("currententrychange")).toBe(1);
    (win.location as { __set(p: string): void }).__set("/c/C10");
    nav.dispatch("currententrychange");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pathname).toBe("/c/C10");
    listener.stop();
  });
});
