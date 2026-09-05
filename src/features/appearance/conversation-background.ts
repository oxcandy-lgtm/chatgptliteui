/**
 * Per-conversation ChatGPT background overrides (Phase 4).
 *
 * Each `/c/<conversation>` remembers its own main background color across
 * reload, route travel, and extension restarts. Identity reuses ONLY the
 * existing SHA-256-derived compact conversation fingerprint — the raw token,
 * URL, title, and chat text are never persisted. Storage is plain
 * `chrome.storage.local` under narrowly prefixed keys:
 *
 *   cgl:conversationAppearance:<fingerprint> = { background: "#rrggbb" }
 *   cgl:currentConversation                   = { fingerprint: string | null }
 *
 * The content script publishes the current fingerprint (cheap change-guarded
 * write) so the popup can operate WITHOUT reading tab URLs and WITHOUT any
 * new permission or messaging channel: popup and content coordinate purely
 * through storage, and live updates flow through the existing
 * `chrome.storage.onChanged` path. No IndexedDB, no backend, no network.
 */

export const CONVERSATION_APPEARANCE_PREFIX = "cgl:conversationAppearance:";
export const CURRENT_CONVERSATION_KEY = "cgl:currentConversation";

/** Compact conversation fingerprint format (128-bit hex, see block-identity). */
const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;

/** Native color-picker value format. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export interface ConversationAppearance {
  background: string;
}

export function isValidConversationAppearance(
  value: unknown,
): value is ConversationAppearance {
  if (typeof value !== "object" || value === null) return false;
  const background = (value as Record<string, unknown>).background;
  return typeof background === "string" && HEX_COLOR_PATTERN.test(background);
}

export function isValidConversationFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

export function conversationAppearanceKey(fingerprint: string): string {
  return `${CONVERSATION_APPEARANCE_PREFIX}${fingerprint}`;
}

function storageArea(): chrome.storage.StorageArea | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

/** Stored override color for a conversation, or null when absent/invalid. */
export async function getConversationBackground(
  fingerprint: string,
): Promise<string | null> {
  const store = storageArea();
  if (!store || !isValidConversationFingerprint(fingerprint)) return null;
  try {
    const raw = await store.get(conversationAppearanceKey(fingerprint));
    const value = raw[conversationAppearanceKey(fingerprint)];
    return isValidConversationAppearance(value) ? value.background : null;
  } catch {
    return null;
  }
}

/** Persist a conversation override. Returns true only on a real write. */
export async function setConversationBackground(
  fingerprint: string,
  background: string,
): Promise<boolean> {
  const store = storageArea();
  if (
    !store ||
    !isValidConversationFingerprint(fingerprint) ||
    !HEX_COLOR_PATTERN.test(background)
  ) {
    return false;
  }
  try {
    await store.set({
      [conversationAppearanceKey(fingerprint)]: { background },
    });
    return true;
  } catch {
    return false;
  }
}

/** Delete a conversation override. Missing keys count as success. */
export async function clearConversationBackground(
  fingerprint: string,
): Promise<boolean> {
  const store = storageArea();
  if (!store || !isValidConversationFingerprint(fingerprint)) return false;
  try {
    await store.remove(conversationAppearanceKey(fingerprint));
    return true;
  } catch {
    return false;
  }
}

/** Fingerprint currently published by the content script (if any). */
export async function readCurrentConversationFingerprint(): Promise<string | null> {
  const store = storageArea();
  if (!store) return null;
  try {
    const raw = await store.get(CURRENT_CONVERSATION_KEY);
    const entry = raw[CURRENT_CONVERSATION_KEY] as
      | { fingerprint?: unknown }
      | undefined;
    const fp = entry?.fingerprint ?? null;
    return isValidConversationFingerprint(fp) ? fp : null;
  } catch {
    return null;
  }
}

/**
 * Publish the content script's current conversation identity (content side
 * only — callers must change-guard to avoid storage churn). `null` marks a
 * page with no chat identity so the popup disables itself.
 */
export async function publishCurrentConversationFingerprint(
  fingerprint: string | null,
): Promise<void> {
  const store = storageArea();
  if (!store) return;
  if (fingerprint !== null && !isValidConversationFingerprint(fingerprint)) {
    return;
  }
  try {
    await store.set({ [CURRENT_CONVERSATION_KEY]: { fingerprint } });
  } catch {
    /* best-effort pointer; the override path does not depend on it */
  }
}
