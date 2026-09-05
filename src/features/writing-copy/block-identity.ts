import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import { findSafeWritingBlocks } from "./writing-copy-detection.js";

export interface BlockIdentity {
  turnIndex: number;
  blockIndex: number;
}

/**
 * Conversation identity (fail-closed).
 *
 * Identity comes ONLY from a supported ChatGPT conversation route
 * (`/c/<token>`). When no such token exists, persistence is unavailable and a
 * compact fingerprint cannot be derived — `null` is returned so callers fail
 * closed. Never uses `/`, an arbitrary pathname, the document title, the full
 * URL, or the query string as identity. The raw token is never persisted.
 */
export function conversationTokenFromLocation(): string | null {
  try {
    const url = new URL(window.location.href);
    const match = url.pathname.match(/\/c\/([^/?]+)/);
    const token = match?.[1];
    return token ? decodeURIComponent(token) : null;
  } catch {
    return null;
  }
}

const CONVERSATION_FP_HEX_CHARS = 32; // 128 bits

/**
 * Compact SHA-256 fingerprint of a conversation token (first 128 bits as 32
 * hex chars). SAME semantics for the current location and for sidebar anchor
 * tokens, so per-chat storage keys match exactly. Returns `null` for empty
 * input or unavailable Web Crypto — fail closed. The raw token never leaves
 * this function and is never persisted by callers.
 */
export async function conversationFingerprintFromToken(
  token: string | null,
): Promise<string | null> {
  if (!token) return null;
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const data = new TextEncoder().encode(token);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex.slice(0, CONVERSATION_FP_HEX_CHARS);
  } catch {
    return null;
  }
}

/**
 * Compact SHA-256 fingerprint of the conversation token (first 128 bits as 32
 * hex chars). Returns `null` when there is no valid conversation token or when
 * Web Crypto SHA-256 is unavailable — fail closed, never a fallback hash of
 * arbitrary location data. The raw token never leaves this function.
 */
export async function conversationFingerprintFromLocation(): Promise<string | null> {
  return conversationFingerprintFromToken(conversationTokenFromLocation());
}

/**
 * Project identifier extracted from a pathname with structural route
 * semantics (`/g/<project>` anywhere in the path). Title text is never
 * used. Returns null when the pathname carries no project segment.
 * Raw IDs stay memory-only; only fingerprints are persisted by callers.
 */
export function extractProjectIdFromPath(pathname: string): string | null {
  try {
    const match = pathname.match(/\/g\/([^/?]+)/);
    const id = match?.[1];
    return id ? decodeURIComponent(id) : null;
  } catch {
    return null;
  }
}

/** Project identifier for the current location (structural, memory-only). */
export function projectTokenFromLocation(): string | null {
  try {
    return extractProjectIdFromPath(window.location.pathname);
  } catch {
    return null;
  }
}

/**
 * SHA-256 project fingerprint with the SAME privacy pattern as conversation
 * identity (first 128 bits, 32 hex chars). Raw project IDs never leave this
 * function and are never persisted by callers.
 */
export async function projectFingerprintFromToken(
  projectId: string | null,
): Promise<string | null> {
  if (!projectId) return null;
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const data = new TextEncoder().encode(`project:${projectId}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex.slice(0, CONVERSATION_FP_HEX_CHARS);
  } catch {
    return null;
  }
}

/**
 * Structural block identity shared by save and hydration paths.
 *
 * Assistant-turn indexing is scoped to the CURRENT detected conversation via
 * the Adapter's own assistant-turn semantics (`detectAssistantTurns`), so no
 * element outside the active conversation can shift a persisted turn index.
 * Blocks within the turn use the same safe-block ordering produced by the
 * detection gate. One shared helper for both directions; no hard-coded index.
 */
export function deriveBlockIdentity(
  block: HTMLElement,
  adapter: ChatGptAdapter,
): BlockIdentity {
  const turn = block.closest(
    '[data-message-author-role="assistant"], [data-testid="assistant-message"]',
  );
  if (!turn) return { turnIndex: -1, blockIndex: -1 };

  // Scope to the current detected conversation container when present.
  const container = adapter.detectConversationContainer().element ?? document;
  const turns = Array.from(
    container.querySelectorAll(
      '[data-message-author-role="assistant"], [data-testid="assistant-message"]',
    ),
  );
  const turnIndex = turns.indexOf(turn);
  if (turnIndex < 0) return { turnIndex: -1, blockIndex: -1 };

  const blocksInTurn = findSafeWritingBlocks(adapter).filter(
    (b) => b.closest(
      '[data-message-author-role="assistant"], [data-testid="assistant-message"]',
    ) === turn,
  );
  const blockIndex = blocksInTurn.indexOf(block);
  return { turnIndex, blockIndex };
}
