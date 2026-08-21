/**
 * Extension-owned writing-block markers.
 *
 * The ONLY permitted mutation on a detected ChatGPT writing block is one
 * boolean marker:
 *
 *   data-cgl-writing-block="true"
 *
 * Nothing else about the block (classes, inline styles, aria, ids, roles,
 * structure) is ever modified. The marker simply identifies the safe block so
 * guarded CSS can apply the optional writing-block background under the
 * `cgl-writing-copy-active` root class.
 */

/** Attribute marking a safely detected Assistant writing block. */
export const MARKER_WRITING_BLOCK = "data-cgl-writing-block";

const ALL_WRITING_COPY_MARKERS = [MARKER_WRITING_BLOCK] as const;

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

/**
 * Remove every ChatGPTLiteUI writing-copy marker from the document, leaving
 * the official UI untouched. Idempotent: safe to call repeatedly.
 */
export function clearAllWritingCopyMarkers(root: ParentNode = document): void {
  for (const name of ALL_WRITING_COPY_MARKERS) {
    root.querySelectorAll(`[${name}]`).forEach((el) => el.removeAttribute(name));
  }
}
