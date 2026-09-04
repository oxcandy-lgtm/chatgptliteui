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
 * Mark the clickable row whose conversation route matches `token`.
 * Returns the marked row, or null when no token/row can be derived.
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

  // Mark the clickable row/container — never the whole sidebar scope, a
  // project folder/header, or anything outside the sidebar.
  const sidebarRoot = scope ?? null;
  let row: HTMLElement | null =
    (match.closest("li") as HTMLElement | null) ??
    (match.parentElement as HTMLElement | null);
  if (!row || row === match) return null;
  if (sidebarRoot && (row === sidebarRoot || !sidebarRoot.contains(row))) {
    return null;
  }
  // Never climb into project folders/headers: keep the nearest row-level
  // container, not an ancestor grouping several chats.
  row.setAttribute(ACTIVE_CHAT_ROW_ATTR, "true");
  return row;
}

/** Remove every active-chat-row marker (disable/restore/teardown path). */
export function clearActiveChatRowMarkers(
  root: ParentNode = document,
): void {
  root
    .querySelectorAll(`[${ACTIVE_CHAT_ROW_ATTR}]`)
    .forEach((el) => el.removeAttribute(ACTIVE_CHAT_ROW_ATTR));
}
