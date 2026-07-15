/**
 * Extension-owned sidebar markers.
 *
 * Every marker name is namespaced with `cgl-sidebar-` so the extension never
 * collides with or alters ChatGPT's own attributes/classes. The ONLY permitted
 * mutation on the detected ChatGPT sidebar is one boolean marker:
 *
 *   data-cgl-sidebar-target="true"
 *
 * Hiding is performed entirely by extension-owned CSS that matches this marker
 * under the `cgl-sidebar-closed` root class, so restoration is simply removal
 * of extension-owned state. ChatGPT classes, inline styles, aria attributes,
 * IDs, and roles are never modified.
 */

/** Attribute marking the safely detected sidebar element. */
export const MARKER_SIDEBAR_TARGET = "data-cgl-sidebar-target";

const ALL_SIDEBAR_MARKERS = [MARKER_SIDEBAR_TARGET] as const;

/** All extension-owned sidebar marker attribute names. */
export function allSidebarMarkerNames(): readonly string[] {
  return ALL_SIDEBAR_MARKERS;
}

/** Add the sidebar target marker to an element. */
export function markSidebar(el: Element): void {
  el.setAttribute(MARKER_SIDEBAR_TARGET, "true");
}

/** Remove the sidebar target marker from an element. */
export function unmarkSidebar(el: Element): void {
  el.removeAttribute(MARKER_SIDEBAR_TARGET);
}

/**
 * Remove every ChatGPTLiteUI sidebar marker from the document, leaving the
 * official UI untouched. Idempotent: safe to call repeatedly.
 */
export function clearAllSidebarMarkers(root: ParentNode = document): void {
  for (const name of ALL_SIDEBAR_MARKERS) {
    root.querySelectorAll(`[${name}]`).forEach((el) => el.removeAttribute(name));
  }
}
