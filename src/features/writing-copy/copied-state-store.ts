

const STORAGE_KEY = "cgl:writingCopy:copiedHistory";

export interface CopiedRecord {
  conversationId: string;
  turnIndex: number;
  blockIndex: number;
  fingerprint: string;
  copiedAt: number;
}

export interface CopiedHistory {
  [conversationId: string]: CopiedRecord[];
}

export async function getCopiedHistory(): Promise<CopiedHistory> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return {};
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    const data = raw[STORAGE_KEY] as CopiedHistory | undefined;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export async function saveCopiedRecord(record: CopiedRecord): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    const history = await getCopiedHistory();
    const list = history[record.conversationId] ?? [];
    // Replace existing record with same position
    const idx = list.findIndex(r => r.turnIndex === record.turnIndex && r.blockIndex === record.blockIndex);
    if (idx >= 0) {
      list[idx] = record;
    } else {
      list.push(record);
    }
    history[record.conversationId] = list;
    await chrome.storage.local.set({ [STORAGE_KEY]: history });
  } catch {
    // ignore storage errors
  }
}

export async function clearCopiedHistory(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function findCopiedRecord(conversationId: string, turnIndex: number, blockIndex: number, fingerprint: string): Promise<boolean> {
  const history = await getCopiedHistory();
  const list = history[conversationId] ?? [];
  const rec = list.find(r => r.turnIndex === turnIndex && r.blockIndex === blockIndex && r.fingerprint === fingerprint);
  return !!rec;
}
