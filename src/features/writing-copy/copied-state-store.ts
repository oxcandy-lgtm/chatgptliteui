const STORAGE_PREFIX = "cgl:writingCopy:history:";

export interface CopiedRecord {
  turnIndex: number;
  blockIndex: number;
  fingerprint: string;
  copiedAt: number;
}

/** Expected fingerprint format: non-empty lowercase hex (SHA-256 truncation). */
const FINGERPRINT_PATTERN = /^[0-9a-f]{8,64}$/;

/**
 * Minimal structural validation for a stored record (no schema framework):
 *  - turnIndex/blockIndex: integers >= 0
 *  - fingerprint: non-empty fixed-format hash
 *  - copiedAt: finite, non-negative number
 * Malformed entries are ignored/dropped.
 */
export function isValidCopiedRecord(r: unknown): r is CopiedRecord {
  if (typeof r !== "object" || r === null) return false;
  const rec = r as Record<string, unknown>;
  return (
    typeof rec.turnIndex === "number" &&
    Number.isInteger(rec.turnIndex) &&
    rec.turnIndex >= 0 &&
    typeof rec.blockIndex === "number" &&
    Number.isInteger(rec.blockIndex) &&
    rec.blockIndex >= 0 &&
    typeof rec.fingerprint === "string" &&
    FINGERPRINT_PATTERN.test(rec.fingerprint) &&
    typeof rec.copiedAt === "number" &&
    Number.isFinite(rec.copiedAt) &&
    rec.copiedAt >= 0
  );
}

function storageKey(conversationFingerprint: string) {
  return `${STORAGE_PREFIX}${conversationFingerprint}`;
}

function storage(): chrome.storage.StorageArea | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

export async function getCopiedRecords(
  conversationFingerprint: string,
): Promise<CopiedRecord[]> {
  const store = storage();
  if (!store || !conversationFingerprint) return [];
  try {
    const raw = await store.get(storageKey(conversationFingerprint));
    const data = raw[storageKey(conversationFingerprint)] as
      | CopiedRecord[]
      | undefined;
    if (!Array.isArray(data)) return [];
    return data.filter(isValidCopiedRecord);
  } catch {
    return [];
  }
}

/**
 * Persist a copied record and report REAL success.
 *
 * IDENTITY SEMANTICS: `turnIndex`/`blockIndex` are POSITION HINTS for
 * diagnostics/locality only — never durable identity. The same slot holding a
 * DIFFERENT fingerprint is a DIFFERENT logical block, so position alone can
 * NEVER cause an overwrite (the old record is preserved and the new one is
 * appended).
 *
 * Same-fingerprint handling:
 *  - exactly one existing record with that fingerprint -> refresh its
 *    position hints + copiedAt in place;
 *  - multiple same-fingerprint records -> update only on an EXACT unique
 *    position match; otherwise append (never delete/replace another).
 *
 * Returns `true` only when the durable write actually succeeded. No retries.
 */
export async function saveCopiedRecord(
  conversationFingerprint: string,
  record: CopiedRecord,
): Promise<boolean> {
  const store = storage();
  if (!store || !conversationFingerprint || !isValidCopiedRecord(record)) {
    return false;
  }
  try {
    const list = await getCopiedRecords(conversationFingerprint);

    const sameFpIdx: number[] = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r && r.fingerprint === record.fingerprint) sameFpIdx.push(i);
    }

    if (sameFpIdx.length === 1) {
      // Unique content match: refresh hints + timestamp, keep one record.
      const i = sameFpIdx[0] as number;
      const existing = list[i] as CopiedRecord;
      list[i] = {
        ...existing,
        turnIndex: record.turnIndex,
        blockIndex: record.blockIndex,
        copiedAt: record.copiedAt,
      };
    } else {
      let exactPosIdx = -1;
      for (const i of sameFpIdx) {
        const r = list[i] as CopiedRecord;
        if (
          r.turnIndex === record.turnIndex &&
          r.blockIndex === record.blockIndex
        ) {
          if (exactPosIdx >= 0) {
            exactPosIdx = -1; // exact position not unique
            break;
          }
          exactPosIdx = i;
        }
      }
      if (sameFpIdx.length === 0 || exactPosIdx < 0) {
        // Different fingerprint at any slot (including the old slot), or
        // ambiguous duplicates: APPEND. Never overwrite/delete another.
        list.push(record);
      } else {
        const existing = list[exactPosIdx] as CopiedRecord;
        list[exactPosIdx] = { ...existing, copiedAt: record.copiedAt };
      }
    }

    await store.set({ [storageKey(conversationFingerprint)]: list });
    return true;
  } catch {
    // Real failure surfaced to the caller; no retries.
    return false;
  }
}

export async function removeCopiedRecord(
  conversationFingerprint: string,
  turnIndex: number,
  blockIndex: number,
): Promise<boolean> {
  const store = storage();
  if (!store || !conversationFingerprint) return false;
  try {
    const list = await getCopiedRecords(conversationFingerprint);
    const filtered = list.filter(
      (r) => !(r.turnIndex === turnIndex && r.blockIndex === blockIndex),
    );
    await store.set({ [storageKey(conversationFingerprint)]: filtered });
    return true;
  } catch {
    return false;
  }
}

export async function clearCopiedHistory(
  conversationFingerprint: string,
): Promise<void> {
  const store = storage();
  if (!store || !conversationFingerprint) return;
  try {
    await store.remove(storageKey(conversationFingerprint));
  } catch {
    // ignore
  }
}

/**
 * Remove ALL extension-owned copied-state history across every conversation
 * (Options "Clear copy history" action). Enumerates extension storage keys
 * ONCE on this explicit user action (`store.get(null)`) and removes only keys
 * matching the `cgl:writingCopy:history:*` prefix — never
 * `chrome.storage.local.clear()`, so normal ChatGPTLiteUI settings survive
 * untouched.
 */
export async function clearAllCopiedHistory(): Promise<number> {
  const store = storage();
  if (!store) return 0;
  try {
    const all = await store.get(null);
    const historyKeys = Object.keys(all).filter((k) =>
      k.startsWith(STORAGE_PREFIX),
    );
    if (historyKeys.length === 0) return 0;
    await store.remove(historyKeys);
    return historyKeys.length;
  } catch {
    return 0;
  }
}
