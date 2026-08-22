/**
 * CGL X-Ray — privacy-safe structural node signatures.
 *
 * Everything here is STRUCTURE ONLY. Text content, input/textarea values,
 * innerHTML/outerHTML, arbitrary attributes, wholesale style, and textual
 * accessibility fields of content nodes are NEVER serialized. For CONTROL
 * elements only (buttons, links, labeled form controls), a short `aria-label`
 * is allowed so Copy/Edit/Stop/Fullscreen actions can be told apart.
 */

/** Cap on class tokens reported per node. */
const MAX_CLASS_TOKENS = 12;
/** Cap on aria-label length for control elements. */
const MAX_CONTROL_LABEL = 40;
/** Default cap for deep-scan traversal. */
export const DEFAULT_NODE_CAP = 4000;

/** Privacy-safe structural signature of a single element. */
export interface NodeSignature {
  tag: string;
  id?: string;
  role?: string;
  testid?: string;
  authorRole?: string;
  contentEditable?: string;
  type?: string;
  /** Class tokens, capped. Never the raw class attribute string. */
  classes?: string[];
  childElementCount: number;
  textLength: number;
  visible: boolean;
  rect: { x: number; y: number; w: number; h: number };
  layout?: {
    display?: string;
    position?: string;
    visibility?: string;
    overflowX?: string;
    overflowY?: string;
    pointerEvents?: string;
    zIndex?: string;
  };
  /** Short aria-label — CONTROL ELEMENTS ONLY (Copy/Edit/Stop/etc). */
  label?: string;
}

/** Whether this element qualifies as a "control" whose short aria-label may be included. */
function isControlElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return (
    tag === "button" ||
    tag === "a" ||
    tag === "label" ||
    el.getAttribute("role") === "button" ||
    el.getAttribute("role") === "tab" ||
    el.getAttribute("role") === "menuitem" ||
    tag === "input" ||
    tag === "textarea"
  );
}

/** Structural visibility: computed style plus non-degenerate layout box. */
export function xrayIsVisible(el: Element): boolean {
  const style =
    typeof window !== "undefined" && typeof window.getComputedStyle === "function"
      ? window.getComputedStyle(el)
      : null;
  if (
    style &&
    (style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0")
  ) {
    return false;
  }
  // jsdom and other no-layout environments report a zero rect for everything.
  const hasLayout =
    typeof el.getBoundingClientRect !== "function" ||
    (() => {
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    })();
  if (!hasLayout) {
    // No layout info available: fall back to style-only visibility.
    return true;
  }
  return true;
}

/** Build the privacy-safe signature of one element. */
export function nodeSignature(el: Element): NodeSignature {
  const rect = el.getBoundingClientRect();
  const sig: NodeSignature = {
    tag: el.tagName.toLowerCase(),
    childElementCount: el.childElementCount,
    textLength: (el.textContent ?? "").length,
    visible: xrayIsVisible(el),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    },
  };
  const id = el.id;
  if (id) sig.id = id;
  const role = el.getAttribute("role");
  if (role) sig.role = role;
  const testid = el.getAttribute("data-testid");
  if (testid) sig.testid = testid;
  const authorRole = el.getAttribute("data-message-author-role");
  if (authorRole) sig.authorRole = authorRole;
  const ce = el.getAttribute("contenteditable");
  if (ce != null) sig.contentEditable = ce;
  const type = el.getAttribute("type");
  if (type) sig.type = type;

  const classAttr = el.getAttribute("class");
  if (classAttr) {
    const tokens = classAttr.split(/\s+/).filter(Boolean).slice(0, MAX_CLASS_TOKENS);
    if (tokens.length > 0) sig.classes = tokens;
  }

  const style =
    typeof window !== "undefined" && typeof window.getComputedStyle === "function"
      ? window.getComputedStyle(el)
      : null;
  if (style) {
    sig.layout = {
      display: style.display,
      position: style.position,
      visibility: style.visibility,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      pointerEvents: style.pointerEvents,
      zIndex: style.zIndex,
    };
  }

  if (isControlElement(el)) {
    const label = (el.getAttribute("aria-label") ?? "").trim();
    if (label.length > 0) sig.label = label.slice(0, MAX_CONTROL_LABEL);
  }

  return sig;
}

/** One node in the structural deep tree. */
export interface DeepNode {
  sig: NodeSignature;
  depth: number;
  siblingIndex: number;
  children: DeepNode[];
}

/** Result of a bounded structural traversal. */
export interface DeepScanResult {
  root: DeepNode | null;
  truncated: boolean;
  totalObserved: number;
  included: number;
}

/**
 * Bounded element-only structural tree of `root`. Never descends into
 * extension-owned hosts or Shadow DOM; counts but does not include nodes
 * beyond `cap`.
 */
export function deepStructuralTree(
  root: Element,
  cap: number = DEFAULT_NODE_CAP,
): DeepScanResult {
  let observed = 0;
  let included = 0;
  let truncated = false;

  const walk = (el: Element, depth: number, siblingIndex: number): DeepNode | null => {
    observed++;
    if (included >= cap) {
      truncated = true;
      return null;
    }
    included++;
    const node: DeepNode = {
      sig: nodeSignature(el),
      depth,
      siblingIndex,
      children: [],
    };
    const children = el.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Element;
      // Never descend into extension-owned diagnostic/UI hosts.
      if (child.hasAttribute("data-cgl-xray-host")) continue;
      if (included >= cap) {
        truncated = true;
        break;
      }
      const built = walk(child, depth + 1, i);
      if (built) node.children.push(built);
    }
    return node;
  };

  const tree = walk(root, 0, 0);
  return { root: tree, truncated, totalObserved: observed, included };
}

/** Ancestor chain from an element up to (and including) a boundary ancestor. */
export function ancestorChain(el: Element, stopAt: Element | null): NodeSignature[] {
  const chain: NodeSignature[] = [];
  let cur: Element | null = el;
  while (cur) {
    chain.push(nodeSignature(cur));
    if (stopAt && cur === stopAt) break;
    cur = cur.parentElement;
  }
  return chain;
}
