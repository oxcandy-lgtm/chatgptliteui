import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { DefaultChatGptAdapter } from "../../src/adapters/chatgpt-adapter.js";
import { resolveStrategy } from "../../src/adapters/selectors.js";

describe("ChatGptAdapter (synthetic fixture)", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM(
      `<!doctype html><html><body>
        <nav aria-label="chat history">h</nav>
        <main role="main">
          <section data-testid="thread" aria-label="conversation">
            <article data-message-author-role="user"><p>u1</p></article>
            <article data-message-author-role="assistant"><p>a1</p><pre><code>x</code></pre><button aria-label="copy">c</button></article>
            <article data-message-author-role="user"><p>u2</p></article>
            <article data-message-author-role="assistant"><p>a2</p></article>
          </section>
        </main>
        <form><textarea id="prompt-textarea"></textarea></form>
        <button aria-label="Stop generating">s</button>
      </body></html>`,
      { url: "https://chatgpt.com/c/synthetic", pretendToBeVisual: true },
    );
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
  });

  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.navigator;
  });

  it("detects the conversation container with high confidence", () => {
    const adapter = new DefaultChatGptAdapter();
    const r = adapter.detectConversationContainer();
    expect(r.found).toBe(true);
    expect(r.confidence).toBe("high");
    expect(r.element?.tagName).toBe("MAIN");
  });

  it("detects user and assistant turns", () => {
    const adapter = new DefaultChatGptAdapter();
    expect(adapter.detectUserTurns().elements.length).toBe(2);
    expect(adapter.detectAssistantTurns().elements.length).toBe(2);
  });

  it("detects sidebar, composer, generating indicator", () => {
    const adapter = new DefaultChatGptAdapter();
    expect(adapter.detectSidebar().found).toBe(true);
    expect(adapter.detectComposer().found).toBe(true);
    expect(adapter.detectGeneratingIndicator().found).toBe(true);
  });

  it("detects code blocks and writing blocks within a container", () => {
    const adapter = new DefaultChatGptAdapter();
    const container = adapter.detectConversationContainer().element!;
    expect(adapter.detectCodeBlocks(container).elements.length).toBe(1);
    expect(adapter.detectWritingBlocks(container).elements.length).toBeGreaterThan(0);
  });

  it("detects the original copy button within a container", () => {
    const adapter = new DefaultChatGptAdapter();
    const container = adapter.detectConversationContainer().element!;
    expect(adapter.detectOriginalCopyButton(container).found).toBe(true);
  });

  it("reports not-found on empty document without throwing", () => {
    const dom2 = new JSDOM("<!doctype html><html><body></body></html>");
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom2.window;
    g.document = dom2.window.document;
    const adapter = new DefaultChatGptAdapter();
    expect(adapter.detectConversationContainer().found).toBe(false);
    expect(adapter.detectUserTurns().found).toBe(false);
    delete g.window;
    delete g.document;
  });
});

describe("resolveStrategy ambiguity handling", () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    const g = globalThis as unknown as Record<string, unknown>;
    g.document = dom.window.document;
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.document;
  });

  it("returns no match when a single-cardinality selector hits multiple incompatible elements", () => {
    const doc = dom.window.document;
    doc.body.innerHTML =
      '<nav aria-label="chat history" id="a"></nav><nav aria-label="chat history" id="b"></nav>';
    const result = resolveStrategy(
      "sidebar",
      {
        id: "nav-history",
        root: "document",
        selector: 'nav[aria-label*="chat history" i]',
        cardinality: "single",
        requireVisible: false,
        confidence: "high",
      },
      doc,
    );
    expect(result.length).toBe(0);
  });

  it("allows multiple matches for multiple-cardinality selectors", () => {
    const doc = dom.window.document;
    doc.body.innerHTML =
      '<article data-message-author-role="user" id="u1"></article><article data-message-author-role="user" id="u2"></article>';
    const result = resolveStrategy(
      "userTurn",
      {
        id: "role-note-user",
        root: "container",
        selector: '[data-message-author-role="user"]',
        cardinality: "multiple",
        requireVisible: false,
        confidence: "high",
      },
      doc,
    );
    expect(result.length).toBe(2);
  });
});
