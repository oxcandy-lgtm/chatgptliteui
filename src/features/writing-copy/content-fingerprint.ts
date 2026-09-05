export async function fingerprintText(text: string): Promise<string> {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (typeof crypto === "undefined" || !("subtle" in crypto)) {
    throw new Error("Web Crypto SHA-256 unavailable");
  }
  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}
