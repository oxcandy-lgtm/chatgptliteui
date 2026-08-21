export async function fingerprintText(text: string): Promise<string> {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (typeof crypto !== "undefined" && "subtle" in crypto) {
    const data = new TextEncoder().encode(normalized);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  }
  // fallback simple djb2
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash) ^ normalized.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}
