/**
 * LINE Messaging API (official account push messages).
 * env LINE_CHANNEL_ACCESS_TOKEN (long-lived channel token) and LINE_CHANNEL_SECRET (webhook signatures).
 * Every function is a no-op when the channel is not configured.
 */

export interface LineEnv { LINE_CHANNEL_ACCESS_TOKEN?: string; LINE_CHANNEL_SECRET?: string }

export const lineConfigured = (env: LineEnv) => !!env.LINE_CHANNEL_ACCESS_TOKEN?.trim();

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** X-Line-Signature = base64(HMAC-SHA256(channel secret, raw request body)). */
export async function verifyLineSignature(secret: string, rawBody: string, signature: string | undefined | null): Promise<boolean> {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  let given: Uint8Array;
  try {
    const binary = atob(signature.trim());
    given = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  } catch {
    return false;
  }
  return timingSafeEqual(expected, given);
}

async function callLine(env: LineEnv, path: string, body: unknown): Promise<boolean> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  if (!token) return false;
  try {
    const res = await fetch(`https://api.line.me/v2/bot/message/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) console.error(`LINE ${path} failed with status ${res.status}`);
    return res.ok;
  } catch (error) {
    console.error(`LINE ${path} request failed:`, error);
    return false;
  }
}

/** Text push to one linked LINE user (max 5000 characters per message). */
export async function linePushText(env: LineEnv, lineUserId: string, text: string): Promise<boolean> {
  return callLine(env, "push", { to: lineUserId, messages: [{ type: "text", text: text.slice(0, 4900) }] });
}

/** Reply to a webhook event (free of the monthly push quota). */
export async function lineReplyText(env: LineEnv, replyToken: string, text: string): Promise<boolean> {
  return callLine(env, "reply", { replyToken, messages: [{ type: "text", text: text.slice(0, 4900) }] });
}
