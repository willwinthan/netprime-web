import type { MiddlewareHandler } from "hono";
import type { Env } from "./rbac";
import { rateLimited } from "../utils/ratelimit";
import { sha256Hex } from "../utils/secretbox";

/**
 * API-key authentication for the public REST API (/api/v1). Separate from rbac(): keys belong to
 * the school, not to a user session. Keys look like "npk_<43 chars>", are shown once and stored as
 * SHA-256 hashes (table api_keys). Send them as "Authorization: Bearer npk_…" or "X-API-Key".
 */
export const API_SCOPES = ["users:read", "users:write", "courses:read", "enrollments:read", "enrollments:write", "orders:read"] as const;
export type ApiScope = typeof API_SCOPES[number];
export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  "users:read": "อ่านข้อมูลผู้ใช้",
  "users:write": "สร้างผู้ใช้ (ส่งคำเชิญ)",
  "courses:read": "อ่านรายการคอร์ส",
  "enrollments:read": "อ่านการลงทะเบียนเรียน",
  "enrollments:write": "ลงทะเบียนผู้เรียนเข้าคอร์ส",
  "orders:read": "อ่านคำสั่งซื้อ"
};
export const isApiScope = (value: unknown): value is ApiScope => typeof value === "string" && (API_SCOPES as readonly string[]).includes(value);

export interface ApiKeyContext { id: string; name: string; scopes: ApiScope[]; rate_limit_per_minute: number }

export type ApiEnv = { Bindings: Env["Bindings"]; Variables: { apiKey: ApiKeyContext } };

export const API_KEY_RE = /^npk_[A-Za-z0-9_-]{43}$/;

function presentedKey(authorization: string | undefined, header: string | undefined): string | null {
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return header?.trim() || null;
}

/** Requires a live key holding `scope`; counts one hit against the key's per-minute limit. */
export function apiKey(scope: ApiScope): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    const raw = presentedKey(c.req.header("Authorization"), c.req.header("X-API-Key"));
    if (!raw || !API_KEY_RE.test(raw)) return c.json({ error: "ต้องส่ง API key ที่ถูกต้อง (Authorization: Bearer npk_…)", code: "unauthorized" }, 401);
    const row = await c.env.DB.prepare(`SELECT id, name, scopes, rate_limit_per_minute, last_used_at FROM api_keys
      WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(await sha256Hex(raw), new Date().toISOString())
      .first<{ id: string; name: string; scopes: string; rate_limit_per_minute: number; last_used_at: string | null }>();
    if (!row) return c.json({ error: "API key ไม่ถูกต้อง ถูกเพิกถอน หรือหมดอายุ", code: "unauthorized" }, 401);
    let scopes: ApiScope[] = [];
    try { scopes = (JSON.parse(row.scopes) as unknown[]).filter(isApiScope); } catch { scopes = []; }
    if (!scopes.includes(scope)) return c.json({ error: `API key นี้ไม่มีสิทธิ์ ${scope}`, code: "insufficient_scope", required_scope: scope }, 403);
    c.header("X-RateLimit-Limit", String(row.rate_limit_per_minute));
    if (await rateLimited(c.env.SESSIONS, "apikey", row.id, row.rate_limit_per_minute, 60)) {
      c.header("Retry-After", "60");
      return c.json({ error: "เรียก API บ่อยเกินกำหนดของ key นี้ กรุณารอ 1 นาที", code: "rate_limited" }, 429);
    }
    // Throttled "last used" write: at most once a minute per key.
    const now = new Date();
    if (!row.last_used_at || Date.parse(row.last_used_at) < now.getTime() - 60_000) {
      await c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now.toISOString(), row.id).run();
    }
    c.set("apiKey", { id: row.id, name: row.name, scopes, rate_limit_per_minute: row.rate_limit_per_minute });
    await next();
  };
}
