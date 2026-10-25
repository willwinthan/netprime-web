/**
 * Web Push without Node dependencies (Web Crypto only):
 * - VAPID (RFC 8292): ES256 JWT signed with the application server key.
 * - Payload encryption "aes128gcm" (RFC 8188 + RFC 8291).
 *
 * Keys come from env VAPID_PUBLIC_KEY (base64url, 65-byte uncompressed P-256 point),
 * VAPID_PRIVATE_KEY (base64url, 32-byte private scalar) and VAPID_SUBJECT ("mailto:…" or "https://…"),
 * the same format `npx web-push generate-vapid-keys` prints.
 */

export interface PushSubscriptionKeys { endpoint: string; p256dh: string; auth: string }
export interface VapidConfig { publicKey: string; privateKey: string; subject: string }
export interface PushResult { ok: boolean; status: number; gone: boolean }

const encoder = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;
const utf8 = (text: string): Bytes => new Uint8Array(encoder.encode(text));

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Bytes {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const binary = atob(normalized + "===".slice((normalized.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** HKDF with a single output block (≤ 32 bytes), as used by RFC 8188/8291. */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** Valid VAPID settings from env, or null when push is not configured. */
export function vapidFromEnv(env: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim() || "mailto:noreply@netprime-lms.com";
  if (!publicKey || !privateKey) return null;
  try {
    if (b64urlDecode(publicKey).length !== 65 || b64urlDecode(privateKey).length !== 32) return null;
  } catch {
    return null;
  }
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

/** Browser push services only, so a stored endpoint can never point the Worker at an internal URL. */
export function isAllowedPushEndpoint(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  return host === "fcm.googleapis.com" || host === "android.googleapis.com"
    || host.endsWith(".push.services.mozilla.com") || host === "updates.push.services.mozilla.com"
    || host.endsWith(".notify.windows.com") || host === "web.push.apple.com" || host.endsWith(".push.apple.com");
}

/** Checks subscription keys from the browser (PushSubscription.toJSON()). */
export function validSubscriptionKeys(p256dh: unknown, auth: unknown): boolean {
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 64) return false;
  try {
    const point = b64urlDecode(p256dh);
    return point.length === 65 && point[0] === 4 && b64urlDecode(auth).length === 16;
  } catch {
    return false;
  }
}

async function vapidSigningKey(vapid: VapidConfig): Promise<CryptoKey> {
  const point = b64urlDecode(vapid.publicKey);
  return crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: vapid.privateKey,
    x: b64urlEncode(point.slice(1, 33)), y: b64urlEncode(point.slice(33, 65)), ext: true
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** `Authorization: vapid t=…, k=…` for one push service origin (valid 12 hours). */
export async function vapidAuthorization(endpoint: string, vapid: VapidConfig, now = Date.now()): Promise<string> {
  const header = b64urlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(utf8(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject
  })));
  const unsigned = `${header}.${claims}`;
  // Web Crypto returns the raw r||s signature, which is the JWS ES256 format.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await vapidSigningKey(vapid), utf8(unsigned));
  return `vapid t=${unsigned}.${b64urlEncode(signature)}, k=${vapid.publicKey}`;
}

/**
 * Encrypts `payload` for one subscription (RFC 8291, single record).
 * `salt` and `serverKeys` are only passed by tests that need deterministic output.
 */
export async function encryptPushPayload(
  sub: { p256dh: string; auth: string },
  payload: Bytes,
  options: { salt?: Bytes; serverKeys?: CryptoKeyPair } = {}
): Promise<Bytes> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  const serverKeys = options.serverKeys ?? (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, serverKeys.privateKey, 256));

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  // Single record: payload followed by the 0x02 "last record" delimiter, no padding.
  const plaintext = concat(payload, new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/** Sends one notification. `gone` means the subscription expired and should be deleted. */
export async function sendWebPush(sub: PushSubscriptionKeys, message: unknown, vapid: VapidConfig, ttlSeconds = 86400): Promise<PushResult> {
  if (!isAllowedPushEndpoint(sub.endpoint)) return { ok: false, status: 0, gone: true };
  let json = JSON.stringify(message);
  // Push services accept about 4 KB of payload; keep well below it.
  if (json.length > 3000) {
    const m = (message ?? {}) as { title?: unknown; url?: unknown };
    json = JSON.stringify({ title: String(m.title ?? "").slice(0, 200), body: "", url: typeof m.url === "string" ? m.url.slice(0, 500) : undefined });
  }
  const body = await encryptPushPayload(sub, utf8(json));
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(sub.endpoint, vapid),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSeconds),
        Urgency: "normal"
      },
      body
    });
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (error) {
    console.error("Web push request failed:", error);
    return { ok: false, status: 0, gone: false };
  }
}
