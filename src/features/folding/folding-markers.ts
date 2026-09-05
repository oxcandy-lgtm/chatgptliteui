/**
 * Extension-owned folding markers (Phase 5).
 *
 * Exactly TWO extension-owned attribute mutations are permitted for folding,
 * and nothing else:
 *
 *   data-cgl-code-folded="true"       (collapsed long code block <pre>)
 *   data-cgl-response-folded="true"   (collapsed long assistant response)
 *
 * No classes, inline styles, text changes, or structure are ever modified.
 * Clipping is presentation-only CSS (max-height + overflow). BOTH markers
 * are removed by `clearAllFoldingMarkers()` on restore/route teardown/
 * disable. The original ChatGPT DOM always stays authoritative.
 */

/** Attribute marking a collapsed long code block. */
export const MARKER_CODE_FOLDED = "data-cgl-code-folded";

/** Attribute marking a collapsed long assistant response. */
export const MARKER_RESPONSE_FOLDED = "data-cgl-response-folded";

const ALL_FOLDING_MARKERS = [MARKER_CODE_FOLDED, MARKER_RESPONSE_FOLDED] as const;

/** Add the code-folded marker to a <pre> element. */
export function markCodeFolded(el: Element): void {
  el.setAttribute(MARKER_CODE_FOLDED, "true");
}

/** Remove the code-folded marker from an element. */
export function unmarkCodeFolded(el: Element): void {
  el.removeAttribute(MARKER_CODE_FOLDED);
}

/** Add the response-folded marker to an assistant turn. */
export function markResponseFolded(el: Element): void {
  el.setAttribute(MARKER_RESPONSE_FOLDED, "true");
}

/** Remove the response-folded marker from an element. */
export function unmarkResponseFolded(el: Element): void {
  el.removeAttribute(MARKER_RESPONSE_FOLDED);
}

/**
 * Remove every folding marker from the document, leaving the official UI
 * untouched. Idempotent: safe to call repeatedly.
 */
export function clearAllFoldingMarkers(root: ParentNode = document): void {
  for (const name of ALL_FOLDING_MARKERS) {
    root.querySelectorAll(`[${name}]`).forEach((el) => el.removeAttribute(name));
  }
}
