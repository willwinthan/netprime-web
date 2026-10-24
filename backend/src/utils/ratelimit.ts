import { Context } from "hono";
import { Env } from "../middleware/rbac";

/**
 * Fixed-window counters in KV (same idea as the public form limit in handlers/site.ts).
 * KV is eventually consistent, so this slows brute force and spam rather than giving exact limits;
 * add a Cloudflare WAF rate-limit rule for hard guarantees.
 */
export const RATE_LIMIT_MESSAGE = "ทำรายการบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่";

export function clientIp(c: Context<Env>): string {
  return c.req.header("CF-Connecting-IP") || "local";
}

async function windowKey(scope: string, subject: string, windowSeconds: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject.toLowerCase()));
  const id = [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
  return `rl:${scope}:${id}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
}

/** True when `subject` already used `max` hits in the current window (does not count a hit). */
export async function isLimited(kv: KVNamespace, scope: string, subject: string, max: number, windowSeconds = 600): Promise<boolean> {
  const count = Number(await kv.get(await windowKey(scope, subject, windowSeconds))) || 0;
  return count >= max;
}

/** Counts one hit for `subject` in the current window. */
export async function hit(kv: KVNamespace, scope: string, subject: string, windowSeconds = 600): Promise<void> {
  const key = await windowKey(scope, subject, windowSeconds);
  const count = Number(await kv.get(key)) || 0;
  // KV requires a TTL of at least 60 seconds; the window number in the key makes it fixed anyway.
  await kv.put(key, String(count + 1), { expirationTtl: Math.max(60, windowSeconds + 60) });
}

/** Checks and counts in one step; true means the caller should answer 429. */
export async function rateLimited(kv: KVNamespace, scope: string, subject: string, max: number, windowSeconds = 600): Promise<boolean> {
  if (await isLimited(kv, scope, subject, max, windowSeconds)) return true;
  await hit(kv, scope, subject, windowSeconds);
  return false;
}

export function tooManyRequests(c: Context<Env>) {
  c.header("Retry-After", "600");
  return c.json({ error: RATE_LIMIT_MESSAGE }, 429);
}
