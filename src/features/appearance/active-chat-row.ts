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
 * Rebound on every structural refresh (sidebar rerenders replace rows) and
 * on route changes through the existing lifecycle. Exactly one row is ever
 * marked; project folders/headers and unrelated controls are untouched.
 */

export const ACTIVE_CHAT_ROW_ATTR = "data-cgl-active-chat-row";

/** Sidebar scope candidates (official structural hooks only). */
const SIDEBAR_SCOPE_SELECTOR =
  '[data-testid="sidebar"], nav[aria-label*="chat history" i]';

/**
 * Mark the current conversation anchor itself. The official selected rounded
 * paint lives on the clickable <a>, so the marker goes on the anchor — never
 * climbed to an li/parent (whose paint would miss the selected shape).
 * Returns the marked anchor, or null when no token/anchor can be derived.
 * Clears any stale marker first (rebind-safe). Pure DOM marking.
 */
export function syncActiveChatRow(token: string | null): HTMLElement | null {
  document
    .querySelectorAll(`[${ACTIVE_CHAT_ROW_ATTR}]`)
    .forEach((el) => el.removeAttribute(ACTIVE_CHAT_ROW_ATTR));
  if (!token) return null;

  const scope =
    document.querySelector(SIDEBAR_SCOPE_SELECTOR) ?? undefined;
  const wantedPath = `/c/${token}`;
  const anchors = Array.from(
    (scope ?? document).querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]'),
  );
  let match: HTMLAnchorElement | null = null;
  for (const a of anchors) {
    if (!a.isConnected) continue;
    try {
      const path = new URL(
        a.getAttribute("href") ?? "",
        window.location.origin,
      ).pathname;
      if (path === wantedPath || path.startsWith(`${wantedPath}/`)) {
        match = a;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!match) return null;

  match.setAttribute(ACTIVE_CHAT_ROW_ATTR, "true");
  return match;
}

/** Remove every active-chat-row marker (disable/restore/teardown path). */
export function clearActiveChatRowMarkers(
  root: ParentNode = document,
): void {
  root
    .querySelectorAll(`[${ACTIVE_CHAT_ROW_ATTR}]`)
    .forEach((el) => el.removeAttribute(ACTIVE_CHAT_ROW_ATTR));
}
