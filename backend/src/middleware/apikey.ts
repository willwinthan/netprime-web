import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./rbac";
import { rateLimited } from "../utils/ratelimit";
import { sha256Hex } from "../utils/secretbox";

/**
 * API-key authentication for the public REST API (/api/v1). Separate from rbac(): keys belong to
 * the school, not to a user session. Keys look like "npk_<43 chars>", are shown once and stored as
 * SHA-256 hashes (table api_keys). Send them as "Authorization: Bearer npk_…" or "X-API-Key".
 *
 * Agent keys (kind = 'agent', migration 0037) are keys for external AI agents. On top of scopes and
 * the per-minute limit they have a daily quota, an Asia/Bangkok time window, an optional IP
 * allowlist and a pause switch, every request they make is logged in agent_activity, and they may
 * not call direct write endpoints: changes go through POST /v1/actions (handlers/agentApi.ts).
 */
export const API_SCOPES = [
  "users:read", "users:write", "courses:read", "enrollments:read", "enrollments:write", "orders:read",
  "sessions:read", "registrations:read", "leads:read", "inquiries:read", "reports:read", "events:read",
  "leads:write", "inquiries:write",
  "orders:confirm", "registrations:write", "sessions:publish", "articles:publish", "messages:send"
] as const;
export type ApiScope = typeof API_SCOPES[number];
export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  "users:read": "อ่านข้อมูลผู้ใช้",
  "users:write": "สร้างผู้ใช้ (ส่งคำเชิญ)",
  "courses:read": "อ่านรายการคอร์ส",
  "enrollments:read": "อ่านการลงทะเบียนเรียน",
  "enrollments:write": "ลงทะเบียนผู้เรียนเข้าคอร์ส (agent: ขอให้สิทธิ์เรียนผ่านคิวอนุมัติ)",
  "orders:read": "อ่านคำสั่งซื้อ",
  "sessions:read": "อ่านรอบอบรมและจำนวนที่นั่ง",
  "registrations:read": "อ่านผู้สมัครรอบอบรม",
  "leads:read": "อ่าน lead จากฟอร์ม",
  "inquiries:read": "อ่านข้อความติดต่อ",
  "reports:read": "อ่านรายงานและสรุปงานประจำวัน",
  "events:read": "ดึงฟีดเหตุการณ์ (GET /v1/events)",
  "leads:write": "ร่าง: เปลี่ยนสถานะและเพิ่มบันทึกของ lead",
  "inquiries:write": "ร่าง: เปลี่ยนสถานะและเพิ่มบันทึกของข้อความติดต่อ",
  "orders:confirm": "ลงมือ: ขอยืนยันการชำระเงิน (ต้องมีคนอนุมัติ)",
  "registrations:write": "ลงมือ: ขอเปลี่ยนสถานะผู้สมัครและแจ้งผู้สมัคร (ต้องมีคนอนุมัติ)",
  "sessions:publish": "ลงมือ: ขอเปิด/ปิดรับสมัครรอบอบรม (ต้องมีคนอนุมัติ)",
  "articles:publish": "ลงมือ: ขอเผยแพร่บทความ (ต้องมีคนอนุมัติ)",
  "messages:send": "ลงมือ: ขอส่งอีเมลหรือ LINE (ต้องมีคนอนุมัติ)"
};
export const isApiScope = (value: unknown): value is ApiScope => typeof value === "string" && (API_SCOPES as readonly string[]).includes(value);

export type ApiKeyKind = "integration" | "agent";

export interface ApiKeyContext {
  id: string; name: string; kind: ApiKeyKind; scopes: ApiScope[]; rate_limit_per_minute: number; daily_limit: number | null;
}

export type ApiEnv = { Bindings: Env["Bindings"]; Variables: { apiKey: ApiKeyContext } };

export const API_KEY_RE = /^npk_[A-Za-z0-9_-]{43}$/;

function presentedKey(authorization: string | undefined, header: string | undefined): string | null {
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return header?.trim() || null;
}

// ---------- Agent key rules (pure, unit-friendly) ----------

const HOURS_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** Bangkok wall clock (UTC+7, no DST): ISO weekday 1–7, minutes since midnight and the date. */
export function bangkokClock(now = new Date()): { weekday: number; minutes: number; date: string } {
  const t = new Date(now.getTime() + 7 * 3_600_000);
  return { weekday: t.getUTCDay() || 7, minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), date: t.toISOString().slice(0, 10) };
}

/** "HH:MM-HH:MM" or null. A window that ends before it starts runs overnight (22:00-06:00). */
export function normalizeHours(raw: unknown): string | null | false {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return false;
  const value = raw.replace(/\s+/g, "");
  const m = HOURS_RE.exec(value);
  if (!m || value.slice(0, 5) === value.slice(6)) return false;
  return value;
}

/** "1,2,3" (ISO weekdays, sorted) or null for every day. */
export function normalizeDays(raw: unknown): string | null | false {
  if (raw === null || raw === undefined || raw === "") return null;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (!list) return false;
  const days = [...new Set(list.map(d => Number(String(d).trim())))];
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 1 || d > 7)) return false;
  return days.length === 7 ? null : days.sort().join(",");
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const ipv4ToInt = (ip: string): number | null => {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some(p => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
};

/** Comma-separated exact IPs (v4 or v6) and IPv4 CIDRs, or null for anywhere. */
export function normalizeIps(raw: unknown): string | null | false {
  if (raw === null || raw === undefined || raw === "") return null;
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[,\s]+/) : null;
  if (!list) return false;
  const entries = [...new Set(list.map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!entries.length || entries.length > 20) return false;
  for (const entry of entries) {
    const [ip, bits, extra] = entry.split("/");
    if (extra !== undefined) return false;
    if (bits !== undefined) {
      if (ipv4ToInt(ip) === null || !/^\d{1,2}$/.test(bits) || Number(bits) > 32) return false;
    } else if (ipv4ToInt(ip) === null && !/^[0-9a-f:]+$/.test(ip)) return false;
    else if (!ip.includes(".") && !ip.includes(":")) return false;
  }
  return entries.join(",");
}

export function ipAllowed(list: string | null, ip: string): boolean {
  if (!list) return true;
  const address = ip.trim().toLowerCase();
  const value = ipv4ToInt(address);
  return list.split(",").some(entry => {
    const [base, bits] = entry.split("/");
    if (bits === undefined) return base === address;
    const start = ipv4ToInt(base);
    if (start === null || value === null) return false;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return ((start & mask) >>> 0) === ((value & mask) >>> 0);
  });
}

/** True when `now` falls inside the key's allowed days and hours (Asia/Bangkok). */
export function withinWindow(hours: string | null, days: string | null, now = new Date()): boolean {
  const clock = bangkokClock(now);
  if (days && !days.split(",").map(Number).includes(clock.weekday)) return false;
  if (!hours) return true;
  const m = HOURS_RE.exec(hours);
  if (!m) return true;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return start < end ? clock.minutes >= start && clock.minutes < end : clock.minutes >= start || clock.minutes < end;
}

// ---------- Middleware ----------

interface KeyRow {
  id: string; name: string; kind: ApiKeyKind; scopes: string; rate_limit_per_minute: number; daily_limit: number | null;
  allowed_hours: string | null; allowed_days: string | null; allowed_ips: string | null; paused_at: string | null; last_used_at: string | null;
}

const clientAddress = (c: Context<ApiEnv>) => c.req.header("CF-Connecting-IP") || "local";

function later(c: Context<ApiEnv>, task: Promise<unknown>) {
  const guarded = task.catch(error => console.error("Agent activity log failed:", error));
  try { c.executionCtx.waitUntil(guarded); } catch { return guarded; }
}

/** Counts one request against an agent key's daily quota (Bangkok day); true when it is used up. */
async function dailyQuotaUsed(kv: KVNamespace, keyId: string, limit: number): Promise<boolean> {
  const key = `agentday:${keyId}:${bangkokClock().date}`;
  const count = Number(await kv.get(key)) || 0;
  if (count >= limit) return true;
  await kv.put(key, String(count + 1), { expirationTtl: 2 * 86_400 });
  return false;
}

export interface ApiKeyOptions {
  /**
   * The route changes data directly (POST /v1/users, POST /v1/enrollments). Agent keys are refused
   * with code approval_required and must submit the matching tool through POST /v1/actions.
   */
  directWrite?: { tool?: string };
}

/**
 * Requires a live key holding `scope` (omit `scope` for routes any valid key may call, such as
 * /v1/me). Counts one hit against the key's per-minute limit and, for agent keys, its daily quota.
 */
export function apiKey(scope?: ApiScope, options: ApiKeyOptions = {}): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    const raw = presentedKey(c.req.header("Authorization"), c.req.header("X-API-Key"));
    if (!raw || !API_KEY_RE.test(raw)) return c.json({ error: "ต้องส่ง API key ที่ถูกต้อง (Authorization: Bearer npk_…)", code: "unauthorized" }, 401);
    const row = await c.env.DB.prepare(`SELECT id, name, kind, scopes, rate_limit_per_minute, daily_limit, allowed_hours, allowed_days, allowed_ips,
        paused_at, last_used_at FROM api_keys
      WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(await sha256Hex(raw), new Date().toISOString()).first<KeyRow>();
    if (!row) return c.json({ error: "API key ไม่ถูกต้อง ถูกเพิกถอน หรือหมดอายุ", code: "unauthorized" }, 401);
    const agent = row.kind === "agent";
    const ip = clientAddress(c);

    // From here on, every answer an agent key gets is logged, refusals included.
    const respond = async (): Promise<Response | void> => {
      if (row.paused_at) return c.json({ error: "key นี้ถูกหยุดใช้งานชั่วคราวโดยผู้ดูแล", code: "key_paused" }, 403);
      if (!ipAllowed(row.allowed_ips, ip)) return c.json({ error: "ไม่อนุญาตให้ใช้ key นี้จาก IP นี้", code: "ip_not_allowed" }, 403);
      if (!withinWindow(row.allowed_hours, row.allowed_days)) {
        return c.json({ error: "อยู่นอกช่วงเวลาที่อนุญาตให้ key นี้ทำงาน (เวลาไทย)", code: "outside_allowed_hours",
          allowed_hours: row.allowed_hours, allowed_days: row.allowed_days }, 403);
      }
      let scopes: ApiScope[] = [];
      try { scopes = (JSON.parse(row.scopes) as unknown[]).filter(isApiScope); } catch { scopes = []; }
      if (scope && !scopes.includes(scope)) return c.json({ error: `API key นี้ไม่มีสิทธิ์ ${scope}`, code: "insufficient_scope", required_scope: scope }, 403);
      if (agent && options.directWrite) {
        return c.json({
          error: "agent key แก้ข้อมูลโดยตรงไม่ได้ ให้ส่งงานผ่าน POST /v1/actions เพื่อเข้าคิวอนุมัติ", code: "approval_required",
          ...(options.directWrite.tool ? { tool: options.directWrite.tool } : {})
        }, 403);
      }
      c.header("X-RateLimit-Limit", String(row.rate_limit_per_minute));
      if (await rateLimited(c.env.SESSIONS, "apikey", row.id, row.rate_limit_per_minute, 60)) {
        c.header("Retry-After", "60");
        return c.json({ error: "เรียก API บ่อยเกินกำหนดของ key นี้ กรุณารอ 1 นาที", code: "rate_limited" }, 429);
      }
      if (agent && row.daily_limit && await dailyQuotaUsed(c.env.SESSIONS, row.id, row.daily_limit)) {
        return c.json({ error: "ใช้โควตารายวันของ key นี้ครบแล้ว เริ่มนับใหม่หลังเที่ยงคืน (เวลาไทย)", code: "daily_quota_exceeded", daily_limit: row.daily_limit }, 429);
      }
      // Throttled "last used" write: at most once a minute per key.
      const now = new Date();
      if (!row.last_used_at || Date.parse(row.last_used_at) < now.getTime() - 60_000) {
        await c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now.toISOString(), row.id).run();
      }
      c.set("apiKey", { id: row.id, name: row.name, kind: row.kind, scopes, rate_limit_per_minute: row.rate_limit_per_minute, daily_limit: row.daily_limit });
      await next();
    };

    const refused = await respond();
    if (agent) {
      const url = new URL(c.req.url);
      const status = refused ? refused.status : c.res.status;
      const actionId = c.res.headers.get("X-Agent-Action-Id");
      later(c, c.env.DB.prepare("INSERT INTO agent_activity (api_key_id, method, path, status, ip, action_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(row.id, c.req.method, (url.pathname + url.search).slice(0, 500), status, ip.slice(0, 64), refused ? null : actionId).run());
    }
    if (refused) return refused;
  };
}
