/**
 * Lightweight SPA route lifecycle for the ChatGPT web app.
 *
 * ChatGPT is a single-page app: navigating between conversations does NOT
 * trigger a full page reload, so a simple `load` listener is insufficient.
 *
 * We deliberately do NOT monkeypatch `history.pushState`/`replaceState` from
 * the isolated content-script world, and we never poll `location`.
 *
 * Instead we use a combination of:
 *  - the standard Navigation API `currententrychange` event when available
 *    (Chromium): fires when the current history entry commits, including
 *    pushState-style SPA navigation that produces NO `popstate`;
 *  - standard `popstate` and `pageshow` events (fallback/redundant signals);
 *  - `location.pathname`/`href` signature comparison;
 *  - a URL comparison triggered by the scoped MutationObserver in the
 *    lifecycle (see lifecycle.ts) when the conversation container changes.
 *
 * All signals funnel into the signature-deduplicated `check()`, so one
 * navigation produces exactly one callback no matter how many signals fire.
 * No permanent high-frequency timer is used. The `poll` method is only
 * invoked by the existing observer loop or on user-gesture-driven checks.
 */
export type RouteChangeCallback = (info: RouteInfo) => void;

export interface RouteInfo {
  href: string;
  pathname: string;
  /** Stable signature used for cheap comparisons. */
  signature: string;
}

function signatureOf(): string {
  const href = window.location.href;
  const pathname = window.location.pathname;
  return `${pathname}::${href}`;
}

export function currentRoute(): RouteInfo {
  const href = window.location.href;
  const pathname = window.location.pathname;
  return { href, pathname, signature: `${pathname}::${href}` };
}

/**
 * Structural subset of the Navigation API used here. The DOM lib may not
 * declare `window.navigation`, so this is resolved with a runtime feature
 * check instead of ambient typings.
 */
interface NavigationLike {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/** `window.navigation` when the runtime implements the Navigation API. */
function navigationOf(): NavigationLike | null {
  try {
    const nav = (window as unknown as { navigation?: NavigationLike }).navigation;
    if (
      nav &&
      typeof nav.addEventListener === "function" &&
      typeof nav.removeEventListener === "function"
    ) {
      return nav;
    }
  } catch {
    /* non-Chromium or restricted context: fall back to popstate/pageshow */
  }
  return null;
}

export class RouteListener {
  private lastSignature: string;
  private readonly callbacks: RouteChangeCallback[] = [];
  private popHandler: (() => void) | null = null;
  private showHandler: (() => void) | null = null;
  private navigationTarget: NavigationLike | null = null;
  private navigationHandler: (() => void) | null = null;
  private started = false;

  constructor() {
    this.lastSignature = signatureOf();
  }

  /** Register a callback fired on detected route change. */
  onChange(cb: RouteChangeCallback): void {
    this.callbacks.push(cb);
  }

  /** Begin listening to standard navigation events. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.popHandler = () => this.check();
    this.showHandler = () => this.check();
    window.addEventListener("popstate", this.popHandler);
    window.addEventListener("pageshow", this.showHandler);
    // History-API SPA navigation (pushState-style) commits a new current
    // entry with NO popstate/pageshow: observe it directly when available.
    const nav = navigationOf();
    if (nav) {
      this.navigationTarget = nav;
      this.navigationHandler = () => this.check();
      nav.addEventListener("currententrychange", this.navigationHandler);
    }
  }

  /**
   * Poll for a route change. Intended to be called from the scoped observer
   * loop or on a low-frequency interval, NOT a high-frequency timer.
   */
  check(): void {
    const sig = signatureOf();
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    const info = currentRoute();
    for (const cb of this.callbacks) cb(info);
  }

  /** Tear down event listeners and clear references. */
  stop(): void {
    this.started = false;
    if (this.popHandler) window.removeEventListener("popstate", this.popHandler);
    if (this.showHandler) window.removeEventListener("pageshow", this.showHandler);
    this.popHandler = null;
    this.showHandler = null;
    if (this.navigationTarget && this.navigationHandler) {
      try {
        this.navigationTarget.removeEventListener(
          "currententrychange",
          this.navigationHandler,
        );
      } catch {
        /* context already gone: nothing left to remove */
      }
    }
    this.navigationTarget = null;
    this.navigationHandler = null;
    this.callbacks.length = 0;
  }
}
