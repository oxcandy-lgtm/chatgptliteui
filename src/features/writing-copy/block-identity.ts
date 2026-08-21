import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import { findSafeWritingBlocks } from "./writing-copy-detection.js";

export interface BlockIdentity {
  turnIndex: number;
  blockIndex: number;
}

export function deriveBlockIdentity(block: HTMLElement, adapter: ChatGptAdapter): BlockIdentity {
  const assistantContainer = block.closest('[data-message-author-role="assistant"]') as HTMLElement | null;
  const allAssistantContainers = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')) as HTMLElement[];
  const turnIndex = assistantContainer ? allAssistantContainers.indexOf(assistantContainer) : -1;
  if (turnIndex < 0) {
    return { turnIndex: -1, blockIndex: -1 };
  }
  const blocksInTurn = findSafeWritingBlocks(adapter).filter(b => {
    const c = b.closest('[data-message-author-role="assistant"]');
    return c === assistantContainer;
  });
  const blockIndex = blocksInTurn.indexOf(block);
  return { turnIndex, blockIndex };
}

export function conversationFingerprintFromLocation(): string {
  try {
    const url = new URL(window.location.href);
    const match = url.pathname.match(/\/c\/([^\/?]+)/);
    const token = match ? match[1] : url.pathname;
    // compact fingerprint of token
    let h = 0;
    for (let i = 0; i < token.length; i++) {
      h = ((h << 5) - h + token.charCodeAt(i)) | 0;
    }
    return "c" + Math.abs(h).toString(16);
  } catch {
    return "c0";
  }
}
