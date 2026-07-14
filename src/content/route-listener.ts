/**
 * Lightweight SPA route lifecycle for the ChatGPT web app.
 *
 * ChatGPT is a single-page app: navigating between conversations does NOT
 * trigger a full page reload, so a simple `load` listener is insufficient.
 *
 * We deliberately do NOT monkeypatch `history.pushState`/`replaceState` from
 * the isolated content-script world.
 *
 * Instead we use a combination of:
 *  - `location.pathname`/`href` signature comparison;
 *  - standard `popstate` and `pageshow` events;
 *  - a URL comparison triggered by the scoped MutationObserver in the
 *    lifecycle (see lifecycle.ts) when the conversation container changes.
 *
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

export class RouteListener {
  private lastSignature: string;
  private readonly callbacks: RouteChangeCallback[] = [];
  private popHandler: (() => void) | null = null;
  private showHandler: (() => void) | null = null;

  constructor() {
    this.lastSignature = signatureOf();
  }

  /** Register a callback fired on detected route change. */
  onChange(cb: RouteChangeCallback): void {
    this.callbacks.push(cb);
  }

  /** Begin listening to standard navigation events. */
  start(): void {
    this.popHandler = () => this.check();
    this.showHandler = () => this.check();
    window.addEventListener("popstate", this.popHandler);
    window.addEventListener("pageshow", this.showHandler);
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
    if (this.popHandler) window.removeEventListener("popstate", this.popHandler);
    if (this.showHandler) window.removeEventListener("pageshow", this.showHandler);
    this.popHandler = null;
    this.showHandler = null;
    this.callbacks.length = 0;
  }
}
