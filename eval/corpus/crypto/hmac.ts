// HMAC-SHA256 utilities using the Web Crypto API.

export async function hmacSign(key: CryptoKey, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacVerify(key: CryptoKey, data: string, expected: string): Promise<boolean> {
  const actual = await hmacSign(key, data);
  // Constant-time comparison to prevent timing attacks.
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function importHmacKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(raw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
