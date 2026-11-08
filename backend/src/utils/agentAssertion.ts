/**
 * In-process agent identity for requests the Worker makes to its own /api/v1 routes on behalf of an
 * agent key that authenticated somewhere else (the MCP endpoint, with the raw key or an OAuth token
 * that only holds the key id). The assertion is an HMAC over the key id, MCP mode, client IP and a
 * timestamp with JWT_SECRET, so only this Worker can make one, and it is valid for 60 seconds.
 * middleware/apikey.ts accepts it in place of the raw key; every key check still runs.
 */
export const ASSERTION_HEADER = "X-NetPrime-Agent-Assertion";
export type McpMode = "read" | "write";

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const encodeIp = (ip: string) => ip.replace(/[^0-9a-fA-F:.]/g, "") || "local";

export async function signAssertion(secret: string, keyId: string, mode: McpMode, ip: string, now = Date.now()): Promise<string> {
  const body = `${keyId}~${mode}~${encodeIp(ip)}~${now}`;
  return `${body}~${await hmac(secret, body)}`;
}

export interface Assertion { keyId: string; mode: McpMode; ip: string }

export async function verifyAssertion(secret: string | undefined, value: string | undefined, now = Date.now()): Promise<Assertion | null> {
  if (!secret || secret.length < 32 || !value || value.length > 400) return null;
  const parts = value.split("~");
  if (parts.length !== 5) return null;
  const [keyId, mode, ip, ts, sig] = parts;
  if (mode !== "read" && mode !== "write") return null;
  const issued = Number(ts);
  if (!Number.isFinite(issued) || Math.abs(now - issued) > 60_000) return null;
  const expected = await hmac(secret, `${keyId}~${mode}~${ip}~${ts}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { keyId, mode, ip } : null;
}
