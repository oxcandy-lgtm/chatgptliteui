const STORAGE_PREFIX = "cgl:writingCopy:history:";

export interface CopiedRecord {
  turnIndex: number;
  blockIndex: number;
  fingerprint: string;
  copiedAt: number;
}

function storageKey(conversationFingerprint: string) {
  return `${STORAGE_PREFIX}${conversationFingerprint}`;
}

export async function getCopiedRecords(conversationFingerprint: string): Promise<CopiedRecord[]> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
  try {
    const raw = await chrome.storage.local.get(storageKey(conversationFingerprint));
    const data = raw[storageKey(conversationFingerprint)] as CopiedRecord[] | undefined;
    if (!Array.isArray(data)) return [];
    return data.filter(r =>
      typeof r.turnIndex === "number" &&
      typeof r.blockIndex === "number" &&
      typeof r.fingerprint === "string" &&
      typeof r.copiedAt === "number"
    );
  } catch {
    return [];
  }
}

export async function saveCopiedRecord(conversationFingerprint: string, record: CopiedRecord): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    const list = await getCopiedRecords(conversationFingerprint);
    const idx = list.findIndex(r => r.turnIndex === record.turnIndex && r.blockIndex === record.blockIndex);
    if (idx >= 0) {
      list[idx] = record;
    } else {
      list.push(record);
    }
    await chrome.storage.local.set({ [storageKey(conversationFingerprint)]: list });
  } catch {
    // ignore
  }
}

export async function removeCopiedRecord(conversationFingerprint: string, turnIndex: number, blockIndex: number): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    const list = await getCopiedRecords(conversationFingerprint);
    const filtered = list.filter(r => !(r.turnIndex === turnIndex && r.blockIndex === blockIndex));
    await chrome.storage.local.set({ [storageKey(conversationFingerprint)]: filtered });
  } catch {
    // ignore
  }
}

export async function clearCopiedHistory(conversationFingerprint: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    await chrome.storage.local.remove(storageKey(conversationFingerprint));
  } catch {
    // ignore
  }
}
