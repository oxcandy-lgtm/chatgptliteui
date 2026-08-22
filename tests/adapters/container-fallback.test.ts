import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { createAdapter, inferConversationContainerFromTurnAnchors } from "../../src/adapters/chatgpt-adapter.js";

/**
 * Focused tests for the structural conversation-container fallback
 * (`role-turn-common-ancestor`), reproducing the REAL current ChatGPT
 * topology: no `[role="main"]`, no `[data-testid="thread"]`, no
 * conversation aria-label — only nested wrappers and role turns.
 *
 * Negative cases per the FIX: BODY-ONLY (unrelated branches under body) and
 * ONE-SIDED (user or assistant anchors missing) must fail closed.
 */

function installDom(html: string): JSDOM {
  const dom = new JSDOM(html, { url: "https://chatgpt.com/c/tok", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  return dom;
}

/** REAL-shape fixture: no shell selectors at all, deep nested wrappers. */
const REAL_SHAPE = `
<div id="app-shell">
  <div class="h-full w-full">
    <div class="flex">
      <div id="sidebar-region"><nav><a href="/c/x">history</a></nav></div>
      <div id="conversation-scroll">
        <div class="thread-wrapper">
          <div class="inner-thread">
            <article data-message-author-role="user" id="u1"><p>first user</p></article>
            <article data-message-author-role="assistant" id="a1"><p>reply one</p>
              <div data-testid="text-block" id="wb1"><p>block one</p></div>
            </article>
            <article data-message-author-role="user" id="u2"><p>second user</p></article>
            <article data-message-author-role="assistant" id="a2"><p>reply two</p></article>
            <article data-message-author-role="assistant" id="a3"><p>reply three</p></article>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`;

describe("role-turn-common-ancestor container fallback", () => {
  let dom: JSDOM;
  let originalGlobals: Record<string, unknown>;
  beforeEach(() => {
    originalGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      HTMLElement: globalThis.HTMLElement,
      Element: globalThis.Element,
      Node: globalThis.Node,
    };
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    (Object.keys(originalGlobals) as (keyof typeof originalGlobals)[]).forEach((k) => {
      if (originalGlobals[k] === undefined) {
        try { delete (g as Record<string, unknown>)[k]; } catch { /* ignore */ }
      } else {
        try { g[k] = originalGlobals[k]; } catch { /* ignore */ }
      }
    });
    dom?.window.close();
  });

  it("REAL shape: explicit strategies fail; fallback finds deepest common wrapper", () => {
    dom = installDom(REAL_SHAPE);
    const adapter = createAdapter();

    // Sanity: none of the old shell selectors exist in this fixture.
    expect(dom.window.document.querySelector('[role="main"]')).toBeNull();
    expect(dom.window.document.querySelector('[data-testid="thread"]')).toBeNull();

    const r = adapter.detectConversationContainer();
    expect(r.found).toBe(true);
    expect(r.strategy).toBe("role-turn-common-ancestor");
    expect(r.confidence).toBe("medium");

    // Deepest common ancestor is the inner thread wrapper, not a broad shell.
    const el = r.element!;
    expect(el.tagName.toLowerCase()).toBe("div");
    expect(el.id === "" || el.id === "inner-thread-wrapper").toBe(true);
    expect(el.contains(dom.window.document.getElementById("u1")!)).toBe(true);
    expect(el.contains(dom.window.document.getElementById("a3")!)).toBe(true);
    // NOT the app shell / flex row.
    expect(el.contains(dom.window.document.getElementById("sidebar-region"))).toBe(false);

    // Diagnostic export matches.
    const diag = inferConversationContainerFromTurnAnchors().diagnostic;
    expect(diag.accepted).toBe(true);
    expect(diag.userAnchorCount).toBe(2);
    expect(diag.assistantAnchorCount).toBe(3);
    expect(diag.commonAncestorTag).toBe("div");
  });

  it("turn scoping reuses the inferred root for user/assistant detection", () => {
    dom = installDom(REAL_SHAPE);
    const adapter = createAdapter();
    const users = adapter.detectUserTurns();
    const assistants = adapter.detectAssistantTurns();
    expect(users.found).toBe(true);
    expect(users.elements.length).toBe(2);
    expect(assistants.found).toBe(true);
    expect(assistants.elements.length).toBe(3);
    // Fixture turns use data-message-author-role, so the role-note strategy
    // is the one that matches inside the inferred root.
    expect(users.strategy).toBe("role-note-user");
    expect(assistants.strategy).toBe("role-note-assistant");
  });

  it("BODY-ONLY: anchors as direct body children fail closed", () => {
    // No wrapper element: the deepest common HTMLElement ancestor of the two
    // anchors IS body -> must be rejected (fail closed).
    dom = installDom(`
      <section id="branch-a" data-message-author-role="user"><p>u</p></section>
      <section id="branch-b" data-message-author-role="assistant"><p>a</p></section>`);
    const adapter = createAdapter();
    const r = adapter.detectConversationContainer();
    expect(r.found).toBe(false);
    const diag = inferConversationContainerFromTurnAnchors().diagnostic;
    expect(diag.rejectionReason ?? null).toBe("COMMON_ANCESTOR_IS_BODY_OR_HTML");
    expect(diag.accepted).toBe(false);
  });

  it("ONE-SIDED: assistant-only page fails closed with NO_USER_ANCHOR", () => {
    dom = installDom(`<div><div data-message-author-role="assistant"><p>a</p></div></div>`);
    const adapter = createAdapter();
    const r = adapter.detectConversationContainer();
    expect(r.found).toBe(false);
    const diag = inferConversationContainerFromTurnAnchors().diagnostic;
    expect(diag.userAnchorCount).toBe(0);
    expect(diag.assistantAnchorCount).toBe(1);
    expect(diag.rejectionReason).toBe("NO_USER_ANCHOR");
  });

  it("ONE-SIDED: user-only page fails closed with NO_ASSISTANT_ANCHOR", () => {
    dom = installDom(`<div><div data-message-author-role="user"><p>u</p></div></div>`);
    const adapter = createAdapter();
    expect(adapter.detectConversationContainer().found).toBe(false);
    const diag = inferConversationContainerFromTurnAnchors().diagnostic;
    expect(diag.rejectionReason).toBe("NO_ASSISTANT_ANCHOR");
  });

  it("explicit strategies still win when present", () => {
    dom = installDom(`<main role="main"><section data-testid="thread">
      <div data-message-author-role="user"><p>u</p></div>
      <div data-message-author-role="assistant"><p>a</p></div>
    </section></main>`);
    const adapter = createAdapter();
    const r = adapter.detectConversationContainer();
    expect(r.found).toBe(true);
    expect(r.strategy).toBe("role-main");
  });

  it("never mutates the page DOM", () => {
    dom = installDom(REAL_SHAPE);
    const before = dom.window.document.body.innerHTML;
    const adapter = createAdapter();
    adapter.detectConversationContainer();
    adapter.detectUserTurns();
    adapter.detectAssistantTurns();
    expect(dom.window.document.body.innerHTML).toBe(before);
  });
});
