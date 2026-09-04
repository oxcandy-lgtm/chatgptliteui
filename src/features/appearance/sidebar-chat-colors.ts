import { conversationFingerprintFromToken } from "../writing-copy/block-identity.js";
import {
  conversationAppearanceKey,
  isValidConversationAppearance,
} from "./conversation-background.js";
import {
  deriveRowSurface,
  extractConversationTokenFromPath,
} from "./active-chat-row.js";

/**
 * Persistent per-chat sidebar row colors (Phase 4).
 *
 * Every conversation with a saved `cgl:conversationAppearance:<fp>` background
 * keeps its color on its sidebar row — including while ANOTHER conversation
 * is open. The color is a persistent conversation label, not a second
 * preference: no new persisted field exists.
 *
 * Hydration (apply / route refresh / sidebar rerender): collect visible
 * connected sidebar anchors, extract each in-memory token with the accepted
 * parser, fingerprint with the SAME semantics as current-conversation
 * storage, batch-read matching entries ONCE, and mark each saved-color row
 * surface with its own element-local `--cgl-sidebar-chat-bg` (the root's
 * CURRENT `--cgl-conversation-bg` must NOT be used — it changes per route).
 * Raw tokens stay in memory only. No polling.
 */

/** Marker for a persistently colored sidebar chat row surface. */
export const CHAT_COLOR_SURFACE_ATTR = "data-cgl-chat-color-surface";

/** Element-local color variable owned by each colored row. */
export const CHAT_COLOR_VAR = "--cgl-sidebar-chat-bg";

/** Tiny structural receipt for X-Ray (counts only — never token/URL). */
export interface SidebarChatColorDiagnostic {
  sidebarChatRouteCandidateCount: number;
  sidebarChatFingerprintedCount: number;
  sidebarChatStoredColorMatchCount: number;
  sidebarChatPaintedRowCount: number;
}

let lastDiagnostic: SidebarChatColorDiagnostic = {
  sidebarChatRouteCandidateCount: 0,
  sidebarChatFingerprintedCount: 0,
  sidebarChatStoredColorMatchCount: 0,
  sidebarChatPaintedRowCount: 0,
};

/** Most recent sidebar color hydration outcome (X-Ray diagnostics only). */
export function getSidebarChatColorDiagnostic(): SidebarChatColorDiagnostic {
  return { ...lastDiagnostic };
}

function storageArea(): chrome.storage.StorageArea | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

/**
 * Rehydrate saved-color sidebar rows. Clears stale color markers first so a
 * reset chat loses its color immediately while other saved rows persist.
 * Idempotent; safe to run on every structural refresh.
 */
export async function hydrateSidebarChatColors(): Promise<SidebarChatColorDiagnostic> {
  document
    .querySelectorAll(`[${CHAT_COLOR_SURFACE_ATTR}]`)
    .forEach((el) => {
      el.removeAttribute(CHAT_COLOR_SURFACE_ATTR);
      if (el instanceof HTMLElement) el.style.removeProperty(CHAT_COLOR_VAR);
    });

  const done = (
    partial: Partial<SidebarChatColorDiagnostic>,
  ): SidebarChatColorDiagnostic => {
    lastDiagnostic = {
      sidebarChatRouteCandidateCount: 0,
      sidebarChatFingerprintedCount: 0,
      sidebarChatStoredColorMatchCount: 0,
      sidebarChatPaintedRowCount: 0,
      ...partial,
    };
    return { ...lastDiagnostic };
  };

  // Visible connected conversation anchors only (hidden duplicates and
  // main-body links never earn a persistent label).
  const anchors: HTMLAnchorElement[] = [];
  for (const a of Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]'),
  )) {
    if (!(a instanceof HTMLElement) || !a.isConnected) continue;
    const rect = a.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    anchors.push(a);
  }
  if (anchors.length === 0) return done({});

  // Token per anchor (memory only), then fingerprint with storage-identical
  // semantics. Project and standard variants of one chat share a token.
  const fpByAnchor = new Map<HTMLAnchorElement, string>();
  for (const a of anchors) {
    let token: string | null = null;
    try {
      token = extractConversationTokenFromPath(
        new URL(a.getAttribute("href") ?? "", window.location.origin).pathname,
      );
    } catch {
      continue;
    }
    if (!token) continue;
    const fp = await conversationFingerprintFromToken(token);
    if (fp) fpByAnchor.set(a, fp);
  }
  if (fpByAnchor.size === 0) {
    return done({ sidebarChatRouteCandidateCount: anchors.length });
  }

  // ONE batched read for every distinct fingerprint.
  const store = storageArea();
  if (!store) {
    return done({
      sidebarChatRouteCandidateCount: anchors.length,
      sidebarChatFingerprintedCount: fpByAnchor.size,
    });
  }
  const keys = [...new Set(fpByAnchor.values())].map((fp) =>
    conversationAppearanceKey(fp),
  );
  let saved: Record<string, unknown> = {};
  try {
    saved = await store.get(keys);
  } catch {
    return done({
      sidebarChatRouteCandidateCount: anchors.length,
      sidebarChatFingerprintedCount: fpByAnchor.size,
    });
  }

  let matchCount = 0;
  let paintedCount = 0;
  const painted = new Set<HTMLElement>();
  for (const [anchor, fp] of fpByAnchor) {
    const value = saved[conversationAppearanceKey(fp)];
    if (!isValidConversationAppearance(value)) continue;
    matchCount++;
    if (!anchor.isConnected) continue;
    const surface = deriveRowSurface(anchor);
    if (!surface.isConnected || painted.has(surface)) continue;
    painted.add(surface);
    surface.setAttribute(CHAT_COLOR_SURFACE_ATTR, "true");
    surface.style.setProperty(CHAT_COLOR_VAR, value.background);
    paintedCount++;
  }
  return done({
    sidebarChatRouteCandidateCount: anchors.length,
    sidebarChatFingerprintedCount: fpByAnchor.size,
    sidebarChatStoredColorMatchCount: matchCount,
    sidebarChatPaintedRowCount: paintedCount,
  });
}

/** Remove every persistent color marker/var (disable/restore/teardown). */
export function clearSidebarChatColorMarkers(
  root: ParentNode = document,
): void {
  root.querySelectorAll(`[${CHAT_COLOR_SURFACE_ATTR}]`).forEach((el) => {
    el.removeAttribute(CHAT_COLOR_SURFACE_ATTR);
    if (el instanceof HTMLElement) el.style.removeProperty(CHAT_COLOR_VAR);
  });
  lastDiagnostic = {
    sidebarChatRouteCandidateCount: 0,
    sidebarChatFingerprintedCount: 0,
    sidebarChatStoredColorMatchCount: 0,
    sidebarChatPaintedRowCount: 0,
  };
}
