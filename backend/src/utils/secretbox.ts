/**
 * Encrypts integration secrets that the Worker must read back later (webhook signing secrets,
 * OIDC client secrets). AES-256-GCM with a key derived from JWT_SECRET via HKDF-SHA-256; the
 * `purpose` is the HKDF info, so a value encrypted for one purpose never decrypts for another.
 * Stored format: "v1.<iv b64url>.<ciphertext b64url>". Values are never returned by the API.
 *
 * Pure Web Crypto (no local imports) so tests/oidc-verify.test.mjs can import it under Node.
 * Rotating JWT_SECRET makes stored secrets unreadable: re-enter them in the settings page.
 */
const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(masterSecret: string, purpose: string): Promise<CryptoKey> {
  if (!masterSecret || masterSecret.length < 32) throw new Error("SECRET_KEY_UNAVAILABLE");
  const base = await crypto.subtle.importKey("raw", encoder.encode(masterSecret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("netprime-secretbox-v1"), info: encoder.encode(purpose) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, masterSecret: string, purpose: string): Promise<string> {
  const key = await deriveKey(masterSecret, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plain));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

export async function decryptSecret(stored: string, masterSecret: string, purpose: string): Promise<string> {
  const [version, iv, data] = stored.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("SECRET_FORMAT");
  const key = await deriveKey(masterSecret, purpose);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, key, fromBase64Url(data));
  return new TextDecoder().decode(plain);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
