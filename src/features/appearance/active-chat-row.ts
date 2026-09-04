/**
 * Active sidebar chat-row highlight (Phase 4).
 *
 * When the current conversation has a custom per-chat background, the
 * selected conversation row in ChatGPT's left sidebar is tinted with the
 * SAME color (no second preference). Identity is the in-memory route token
 * only — never persisted. The tint itself reuses the already-applied
 * `--cgl-conversation-bg` variable under the `cgl-chat-bg-override` root
 * class, so reset/teardown automatically restores the official highlight:
 * without the override class this marker paints nothing.
 *
 * Selection is geometry-based, not selector-based: current ChatGPT may
 * expose duplicate current-conversation anchors outside the visible sidebar
 * (and the legacy sidebar hooks may match nothing), so EVERY route-matching
 * connected anchor is collected and the actual visible left-sidebar
 * candidate wins (visible rect + computed visibility, left-side preference,
 * then leftmost / narrower / topmost). Exactly one anchor is ever marked.
 *
 * Rebound on every structural refresh (sidebar rerenders replace rows) and
 * on route changes through the existing lifecycle.
 */

export const ACTIVE_CHAT_ROW_ATTR = "data-cgl-active-chat-row";

/** Maximum left edge for the preferred left-sidebar zone. */
const SIDEBAR_ZONE_PX = 420;

/** A route-matching anchor measurably visible inside the viewport. */
function isCandidateVisible(a: HTMLElement): boolean {
  if (!a.isConnected) return false;
  const rect = a.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const vh = window.innerHeight || 0;
  if (rect.bottom <= 0 || rect.top >= vh) return false;
  const style = window.getComputedStyle(a);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return true;
}

/**
 * Mark the actually visible current-conversation anchor. Returns the marked
 * anchor, or null when none can be derived. Clears any stale marker first
 * (rebind-safe). Pure DOM marking.
 */
export function syncActiveChatRow(token: string | null): HTMLElement | null {
  document
    .querySelectorAll(`[${ACTIVE_CHAT_ROW_ATTR}]`)
    .forEach((el) => el.removeAttribute(ACTIVE_CHAT_ROW_ATTR));
  if (!token) return null;

  const wantedPath = `/c/${token}`;
  const vw = window.innerWidth || 0;
  const sidebarBound = Math.min(SIDEBAR_ZONE_PX, vw * 0.4);
  type Scored = { el: HTMLAnchorElement; left: number; width: number; top: number; inZone: boolean };
  const scored: Scored[] = [];
  for (const a of Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]'),
  )) {
    if (!(a instanceof HTMLElement)) continue;
    let path: string;
    try {
      path = new URL(
        a.getAttribute("href") ?? "",
        window.location.origin,
      ).pathname;
    } catch {
      continue;
    }
    if (path !== wantedPath && !path.startsWith(`${wantedPath}/`)) continue;
    if (!isCandidateVisible(a)) continue;
    const rect = a.getBoundingClientRect();
    scored.push({
      el: a,
      left: rect.left,
      width: rect.width,
      top: rect.top,
      inZone: rect.left < sidebarBound,
    });
  }
  if (scored.length === 0) return null;
  // Left-sidebar zone first, then leftmost, then narrower (sidebar-sized),
  // then topmost. Never a main-body duplicate.
  scored.sort(
    (x, y) =>
      Number(y.inZone) - Number(x.inZone) ||
      x.left - y.left ||
      x.width - y.width ||
      x.top - y.top,
  );
  const winner = scored[0]!.el;
  winner.setAttribute(ACTIVE_CHAT_ROW_ATTR, "true");
  return winner;
}

/** Remove every active-chat-row marker (disable/restore/teardown path). */
export function clearActiveChatRowMarkers(
  root: ParentNode = document,
): void {
  root
    .querySelectorAll(`[${ACTIVE_CHAT_ROW_ATTR}]`)
    .forEach((el) => el.removeAttribute(ACTIVE_CHAT_ROW_ATTR));
}
