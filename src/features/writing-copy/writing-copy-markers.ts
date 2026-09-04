/**
 * Extension-owned writing-block markers.
 *
 * Exactly THREE extension-owned attribute mutations are permitted on ChatGPT
 * content, and nothing else:
 *
 *   data-cgl-writing-block="true"             (canonical safe editor)
 *
 *   data-cgl-writing-copy-state="copied" | "uncopied"   (semantic state)
 *
 *   data-cgl-writing-surface="true"           (whole-card visual surface:
 *     deepest safe container pairing the editor with its exact header
 *     anchor; visual pulse paint only, never semantic identity)
 *
 * No classes, inline styles, aria, ids, roles, or structure are ever modified.
 * The boolean marker identifies the safe block so guarded CSS can apply the
 * optional writing-block background under the `cgl-writing-copy-active` root
 * class. The semantic state marker carries the runtime copied/uncopied claim.
 * The surface marker lets the uncopied pulse paint the whole visible card.
 * ALL markers are extension-owned and ALL are removed by
 * `clearAllWritingCopyMarkers()` on restore/route teardown/disable.
 */

/** Attribute marking a safely detected Assistant writing block. */
export const MARKER_WRITING_BLOCK = "data-cgl-writing-block";

/** Attribute carrying the semantic copied/uncopied state of a block. */
export const MARKER_WRITING_COPY_STATE = "data-cgl-writing-copy-state";

/** Attribute marking the resolved whole-card visual surface of a block. */
export const MARKER_WRITING_SURFACE = "data-cgl-writing-surface";

export type WritingCopySemanticState = "copied" | "uncopied";

const ALL_WRITING_COPY_MARKERS = [
  MARKER_WRITING_BLOCK,
  MARKER_WRITING_COPY_STATE,
  MARKER_WRITING_SURFACE,
] as const;

/** All extension-owned writing-copy marker attribute names. */
export function allWritingCopyMarkerNames(): readonly string[] {
  return ALL_WRITING_COPY_MARKERS;
}

/** Add the writing-block marker to an element. */
export function markWritingBlock(el: Element): void {
  el.setAttribute(MARKER_WRITING_BLOCK, "true");
}

/** Remove the writing-block marker from an element. */
export function unmarkWritingBlock(el: Element): void {
  el.removeAttribute(MARKER_WRITING_BLOCK);
}

/** Set the semantic copied/uncopied state marker on a block. */
export function setWritingCopyState(
  el: Element,
  state: WritingCopySemanticState,
): void {
  el.setAttribute(MARKER_WRITING_COPY_STATE, state);
}

/**
 * Remove every ChatGPTLiteUI writing-copy marker from the document, leaving
 * the official UI untouched. Idempotent: safe to call repeatedly.
 */
export function clearAllWritingCopyMarkers(root: ParentNode = document): void {
  for (const name of ALL_WRITING_COPY_MARKERS) {
    root.querySelectorAll(`[${name}]`).forEach((el) => el.removeAttribute(name));
  }
}
