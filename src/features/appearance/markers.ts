/**
 * Extension-owned markers for cosmetic DOM marking.
 *
 * Every marker name is namespaced with `cgl-` so the extension never collides
 * with or alters ChatGPT's own attributes/classes. Marking is the ONLY DOM
 * mutation the appearance feature performs; styling is driven entirely by CSS
 * selectors that match these markers under the `cgl-active` root class.
 */

/** Attribute name marking the detected conversation root. */
export const MARKER_CONVERSATION_ROOT = "data-cgl-conversation-root";
/** Attribute name marking the detected conversation/content column. */
export const MARKER_CONVERSATION_COLUMN = "data-cgl-conversation-column";
/** Attribute name marking the detected composer/input surface. */
export const MARKER_COMPOSER = "data-cgl-composer";
/** Attribute name marking a detected user message. */
export const MARKER_USER_TURN = "data-cgl-user-turn";
/** Attribute name marking a detected assistant message. */
export const MARKER_ASSISTANT_TURN = "data-cgl-assistant-turn";

const ALL_MARKERS = [
  MARKER_CONVERSATION_ROOT,
  MARKER_CONVERSATION_COLUMN,
  MARKER_COMPOSER,
  MARKER_USER_TURN,
  MARKER_ASSISTANT_TURN,
] as const;

/** All extension-owned marker attribute names. */
export function allMarkerNames(): readonly string[] {
  return ALL_MARKERS;
}

/** Add a boolean-valued marker attribute to an element. */
export function mark(el: Element, name: string): void {
  el.setAttribute(name, "true");
}

/** Remove a single marker attribute from an element. */
export function unmark(el: Element, name: string): void {
  el.removeAttribute(name);
}

/**
 * Remove every ChatGPTLiteUI marker from the document, leaving official UI
 * untouched. Idempotent: safe to call repeatedly.
 */
export function clearAllMarkers(root: ParentNode = document): void {
  for (const name of ALL_MARKERS) {
    root.querySelectorAll(`[${name}]`).forEach((el) => el.removeAttribute(name));
  }
}
