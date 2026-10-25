import { Hono, Context } from "hono";
import jwt from "@tsndr/cloudflare-worker-jwt";
import { Env, UserPayload, rbac } from "../middleware/rbac";
import { parseRoles, permissionsForRoles, permit, primaryRole, rolesColumn, storedRole } from "../utils/permissions";
import { onEvent, trackEvent, TrackOptions } from "../utils/events";
import { allowedOrigins } from "../utils/origins";
import { appUrl } from "../utils/email";
import { requireDeleteConfirmation } from "../utils/dangerConfirm";
import { clientIp, rateLimited, tooManyRequests } from "../utils/ratelimit";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "../utils/secretbox";
import {
  WEBHOOK_EVENTS, WEBHOOK_EVENT_NAMES, MAX_ATTEMPTS, isPrivateHost, nextAttemptAt, signatureHeader, subscribed,
  verifySignatureHeader, webhookEventFor, webhookUrlError
} from "../utils/webhooks";
import { API_SCOPES, API_SCOPE_LABELS, isApiScope } from "../middleware/apikey";
import { clearSchoolCache, loadSchoolSettings, parseDomains, parseSchoolSettings } from "../utils/school";
import {
  OidcError, assertedEmail, emailDomain, emailVerifiedClaim, loadDiscovery, loadJwks, normalizeIssuer, pkceChallenge, randomValue, tokenKid, verifyIdToken,
  b64urlDecode, b64urlEncode
} from "../utils/oidc";
import { liveRouter } from "./live";

/**
 * Platform settings and integrations (v0.5), mounted at /api:
 *   /api/admin/platform/*  school settings, outgoing webhooks, API keys, enterprise SSO (integrations.manage)
 *   /api/public/platform   public school settings (name, language, maintenance banner, sign-up terms)
 *   /api/sso/*             enterprise SSO login (OpenID Connect, PKCE + state + nonce)
 *   /api/live/*            live meetings for training sessions and course live classes (handlers/live.ts)
 * The public REST API is handlers/publicapi.ts (/api/v1).
 *
 * Webhooks: utils/events.ts listeners enqueue one webhook_deliveries row per subscribed endpoint.
 * The router-wide middleware below sends queued rows after the response via waitUntil; failures are
 * retried with backoff by later dispatches and by the daily cron (runWebhookRetries in jobs.ts).
 */
export const platformRouter = new Hono<Env>();

type Bindings = Env["Bindings"];
const isLocal = (env: Bindings) => env.ALLOW_LOCAL_SEED_PASSWORDS === "true";
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
const nowIso = () => new Date().toISOString();

async function audit(c: Context<Env>, action: string, entity: string, entityId: string | null, detail?: unknown) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("log"), c.get("user")?.id ?? null, action, entity, entityId, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000)).run();
  } catch (error) { console.error("Audit log write failed:", error); }
}

function later(c: Context<Env>, task: Promise<unknown>): Promise<unknown> {
  const guarded = task.catch(error => console.error("Background task failed:", error));
  try { c.executionCtx.waitUntil(guarded); return Promise.resolve(); } catch { return guarded; }
}

// ==========================================
// Webhook delivery engine
// ==========================================

const queuedDeliveries: string[] = [];
let endpointCache: { rows: EndpointRow[]; at: number } | null = null;

interface EndpointRow { id: string; url: string; secret_enc: string; events: string[]; active: number }

async function activeEndpoints(db: D1Database): Promise<EndpointRow[]> {
  if (endpointCache && Date.now() - endpointCache.at < 15_000) return endpointCache.rows;
  const rows = await db.prepare("SELECT id, url, secret_enc, events, active FROM webhook_endpoints WHERE active = 1").all<Omit<EndpointRow, "events"> & { events: string }>();
  const parsed = rows.results.map(r => ({ ...r, events: safeList(r.events) }));
  endpointCache = { rows: parsed, at: Date.now() };
  return parsed;
}

function safeList(json: string | null): string[] {
  try { const v = JSON.parse(json || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** Zapier/Make friendly payload: flat top-level fields plus the raw event data. */
async function buildPayload(db: D1Database, event: string, userId: string | null, options: TrackOptions) {
  const [user, course] = await Promise.all([
    userId ? db.prepare("SELECT id, email, name FROM users WHERE id = ?").bind(userId).first<{ id: string; email: string; name: string }>() : null,
    options.courseId ? db.prepare("SELECT id, title FROM courses WHERE id = ?").bind(options.courseId).first<{ id: string; title: string }>() : null
  ]);
  return {
    id: newId("evt"), event, created_at: nowIso(),
    user_id: userId, user_email: user?.email ?? null, user_name: user?.name ?? null,
    course_id: options.courseId ?? null, course_title: course?.title ?? null, lesson_id: options.lessonId ?? null,
    data: options.data ?? {}
  };
}

async function enqueue(db: D1Database, endpoints: Array<{ id: string }>, event: string, payload: unknown): Promise<string[]> {
  if (!endpoints.length) return [];
  const body = JSON.stringify(payload).slice(0, 60_000);
  const ids = endpoints.map(() => newId("whd"));
  const now = nowIso();
  await db.batch(endpoints.map((e, i) => db.prepare(`INSERT INTO webhook_deliveries (id, endpoint_id, event, payload, status, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)`).bind(ids[i], e.id, event, body, now, now)));
  return ids;
}

onEvent(async (db, userId, type, options) => {
  const event = webhookEventFor(type);
  if (!event) return;
  const endpoints = (await activeEndpoints(db)).filter(e => subscribed(e.events, event));
  if (!endpoints.length) return;
  queuedDeliveries.push(...await enqueue(db, endpoints, event, await buildPayload(db, event, userId, options)));
});

// Router-wide: after any /api response, send what this request queued (waitUntil-safe).
platformRouter.use("*", async (c, next) => {
  await next();
  if (!queuedDeliveries.length) return;
  const ids = queuedDeliveries.splice(0);
  await later(c, deliverMany(c.env, ids, 10));
});

interface DeliveryRow {
  id: string; endpoint_id: string; event: string; payload: string; status: string; attempts: number;
  response_code: number | null; duration_ms: number | null; error: string | null; response_excerpt: string | null;
  next_attempt_at: string | null; created_at: string; last_attempt_at: string | null; delivered_at: string | null;
}

/** Simulated receiver for the local test harness only (https://hooks.mock.test/ok|fail). */
async function mockReceiver(url: URL, secret: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  if (url.pathname.startsWith("/fail")) return { status: 500, text: "mock failure" };
  const valid = await verifySignatureHeader(secret, headers["X-NetPrime-Signature"], body);
  return { status: 200, text: JSON.stringify({ received: true, signature_valid: valid, event: headers["X-NetPrime-Event"] }) };
}

/** Sends one delivery if it can be claimed (pending and due, or a stale "sending" lock). */
async function deliverOne(env: Bindings, id: string, force = false): Promise<void> {
  const db = env.DB;
  const now = nowIso();
  const claimed = await db.prepare(`UPDATE webhook_deliveries SET status = 'sending', locked_until = ?
    WHERE id = ? AND ((status = 'pending' AND (? = 1 OR next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (status = 'sending' AND locked_until < ?))
    RETURNING id, endpoint_id, event, payload, attempts`)
    .bind(new Date(Date.now() + 60_000).toISOString(), id, force ? 1 : 0, now, now)
    .first<{ id: string; endpoint_id: string; event: string; payload: string; attempts: number }>();
  if (!claimed) return;
  const attempts = claimed.attempts + 1;
  const finish = (ok: boolean, fields: { code?: number | null; ms?: number | null; error?: string | null; excerpt?: string | null }, final = false) => {
    const next = ok || final ? null : nextAttemptAt(attempts);
    const status = ok ? "success" : next && attempts < MAX_ATTEMPTS ? "pending" : "failed";
    return db.prepare(`UPDATE webhook_deliveries SET status = ?, attempts = ?, response_code = ?, duration_ms = ?, error = ?, response_excerpt = ?,
      next_attempt_at = ?, last_attempt_at = ?, delivered_at = CASE WHEN ? = 'success' THEN ? ELSE delivered_at END, locked_until = NULL WHERE id = ?`)
      .bind(status, attempts, fields.code ?? null, fields.ms ?? null, fields.error ? fields.error.slice(0, 300) : null, fields.excerpt ? fields.excerpt.slice(0, 500) : null,
        status === "pending" ? next : null, nowIso(), status, nowIso(), id).run();
  };
  const endpoint = await db.prepare("SELECT url, secret_enc, active FROM webhook_endpoints WHERE id = ?").bind(claimed.endpoint_id)
    .first<{ url: string; secret_enc: string; active: number }>();
  if (!endpoint || (!endpoint.active && claimed.event !== "ping")) { await finish(false, { error: "ปลายทางถูกปิดใช้งานหรือถูกลบ" }, true); return; }
  const guard = webhookUrlError(endpoint.url, { allowMock: isLocal(env) });
  if (guard) { await finish(false, { error: guard }, true); return; }
  let secret: string;
  try { secret = await decryptSecret(endpoint.secret_enc, env.JWT_SECRET, "webhook"); } catch {
    await finish(false, { error: "อ่าน secret ไม่ได้ (JWT_SECRET ถูกเปลี่ยน) กรุณาสร้าง secret ใหม่" }, true); return;
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "Content-Type": "application/json", "User-Agent": "NetPrime-Webhooks/1.0",
    "X-NetPrime-Event": claimed.event, "X-NetPrime-Delivery": claimed.id, "X-NetPrime-Timestamp": String(timestamp),
    "X-NetPrime-Signature": await signatureHeader(secret, timestamp, claimed.payload)
  };
  const started = Date.now();
  try {
    const url = new URL(endpoint.url);
    let status: number;
    let text: string;
    if (isLocal(env) && url.hostname === "hooks.mock.test") {
      ({ status, text } = await mockReceiver(url, secret, headers, claimed.payload));
    } else {
      const res = await fetch(endpoint.url, { method: "POST", headers, body: claimed.payload, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      status = res.status;
      text = (await res.text().catch(() => "")).slice(0, 500);
    }
    const ms = Date.now() - started;
    if (status >= 200 && status < 300) await finish(true, { code: status, ms, excerpt: text });
    else await finish(false, { code: status, ms, excerpt: text, error: status >= 300 && status < 400 ? "ปลายทางตอบ redirect (ไม่ติดตาม redirect)" : `ปลายทางตอบ HTTP ${status}` });
  } catch (error: any) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    await finish(false, { ms: Date.now() - started, error: timeout ? "หมดเวลารอการตอบกลับ (10 วินาที)" : "เชื่อมต่อปลายทางไม่ได้" });
  }
}

/** Sends the given deliveries, then up to `dueExtra` older ones whose retry time has come. */
async function deliverMany(env: Bindings, ids: string[], dueExtra = 0): Promise<void> {
  for (const id of ids) await deliverOne(env, id);
  if (dueExtra > 0) {
    const due = await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND locked_until < ?)
      ORDER BY next_attempt_at LIMIT ?`).bind(nowIso(), nowIso(), dueExtra).all<{ id: string }>();
    for (const row of due.results) if (!ids.includes(row.id)) await deliverOne(env, row.id);
  }
}

/** Daily cron (jobs.ts): retry due deliveries and drop log rows older than 30 days. Safe to repeat. */
export async function runWebhookRetries(env: Bindings): Promise<{ attempted: number }> {
  const due = await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND locked_until < ?)
    ORDER BY next_attempt_at LIMIT 200`).bind(nowIso(), nowIso()).all<{ id: string }>();
  for (const row of due.results) await deliverOne(env, row.id);
  await env.DB.prepare("DELETE FROM webhook_deliveries WHERE created_at < ? AND status IN ('success', 'failed')")
    .bind(new Date(Date.now() - 30 * 86_400_000).toISOString()).run();
  return { attempted: due.results.length };
}

// ==========================================
// Public school settings
// ==========================================

platformRouter.get("/public/platform", async (c) => {
  const s = await loadSchoolSettings(c.env.DB);
  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    school_name: s.school_name, contact_email: s.contact_email, contact_phone: s.contact_phone, support_email: s.support_email,
    timezone: s.timezone, default_language: s.default_language,
    signup: { open: s.signup.open, allowed_domains: s.signup.allowed_domains, require_email_verification: s.signup.require_email_verification },
    maintenance: s.maintenance.active ? { active: true, message: s.maintenance.message, level: s.maintenance.level } : { active: false }
  });
});

// ==========================================
// Admin: /api/admin/platform/*
// ==========================================

platformRouter.use("/admin/platform", rbac(), permit("integrations.manage"));
platformRouter.use("/admin/platform/*", rbac(), permit("integrations.manage"));
platformRouter.use("/admin/platform/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

platformRouter.get("/admin/platform/settings", async (c) => {
  const row = await c.env.DB.prepare("SELECT updated_at FROM site_settings WHERE key = 'school'").first<{ updated_at: string }>();
  return c.json({ settings: await loadSchoolSettings(c.env.DB), updated_at: row?.updated_at ?? null });
});

platformRouter.put("/admin/platform/settings", async (c) => {
  clearSchoolCache();
  const { settings, error } = parseSchoolSettings(await c.req.json().catch(() => null), await loadSchoolSettings(c.env.DB));
  if (error || !settings) return c.json({ error: error || "ข้อมูลการตั้งค่าไม่ถูกต้อง" }, 400);
  await c.env.DB.prepare(`INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ('school', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
    .bind(JSON.stringify(settings), c.get("user").id).run();
  clearSchoolCache();
  await audit(c, "update", "school_settings", "school", { signup: settings.signup, maintenance: settings.maintenance.active });
  return c.json({ settings, message: "บันทึกการตั้งค่าแล้ว" });
});

// ---------- Webhooks ----------

function parseEvents(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > WEBHOOK_EVENT_NAMES.length + 1) return null;
  const list = [...new Set(raw.map(String))];
  if (list.includes("*")) return ["*"];
  return list.every(e => (WEBHOOK_EVENT_NAMES as string[]).includes(e)) ? list : null;
}

const ENDPOINT_SELECT = `SELECT w.id, w.name, w.url, w.events, w.active, w.created_at, w.updated_at,
  (SELECT d.status FROM webhook_deliveries d WHERE d.endpoint_id = w.id ORDER BY d.created_at DESC LIMIT 1) AS last_status,
  (SELECT d.created_at FROM webhook_deliveries d WHERE d.endpoint_id = w.id ORDER BY d.created_at DESC LIMIT 1) AS last_delivery_at,
  (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.endpoint_id = w.id AND d.status = 'failed') AS failed_count,
  (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.endpoint_id = w.id AND d.status = 'pending') AS pending_count
  FROM webhook_endpoints w`;

const shapeEndpoint = (row: Record<string, any>) => ({ ...row, events: safeList(row.events), active: !!row.active });

platformRouter.get("/admin/platform/webhooks", async (c) => {
  const rows = await c.env.DB.prepare(`${ENDPOINT_SELECT} ORDER BY w.created_at DESC`).all();
  return c.json({
    endpoints: rows.results.map(shapeEndpoint),
    events: WEBHOOK_EVENT_NAMES.map(name => ({ name, label: WEBHOOK_EVENTS[name].label }))
  });
});

platformRouter.post("/admin/platform/webhooks", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) return c.json({ error: "กรุณาตั้งชื่อปลายทาง (ไม่เกิน 80 ตัวอักษร)" }, 400);
  const urlError = webhookUrlError(body?.url, { allowMock: isLocal(c.env) });
  if (urlError) return c.json({ error: urlError }, 400);
  const events = parseEvents(body?.events);
  if (!events) return c.json({ error: "กรุณาเลือกเหตุการณ์ที่ต้องการรับอย่างน้อย 1 รายการ" }, 400);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_endpoints").first<{ n: number }>();
  if ((count?.n ?? 0) >= 20) return c.json({ error: "สร้างปลายทาง webhook ได้สูงสุด 20 รายการ" }, 400);
  const id = newId("whk");
  const secret = "whsec_" + randomToken(24);
  await c.env.DB.prepare(`INSERT INTO webhook_endpoints (id, name, url, secret_enc, events, active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, name, String(body!.url).trim(), await encryptSecret(secret, c.env.JWT_SECRET, "webhook"), JSON.stringify(events), body?.active === false ? 0 : 1, c.get("user").id).run();
  endpointCache = null;
  await audit(c, "create", "webhook", id, { name, events });
  const endpoint = await c.env.DB.prepare(`${ENDPOINT_SELECT} WHERE w.id = ?`).bind(id).first();
  return c.json({ endpoint: shapeEndpoint(endpoint!), secret, message: "คัดลอก secret เก็บไว้ ระบบจะไม่แสดงอีก" }, 201);
});

platformRouter.patch("/admin/platform/webhooks/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return c.json({ error: "กรุณาตั้งชื่อปลายทาง (ไม่เกิน 80 ตัวอักษร)" }, 400);
    sets.push("name = ?"); binds.push(name);
  }
  if (body.url !== undefined) {
    const urlError = webhookUrlError(body.url, { allowMock: isLocal(c.env) });
    if (urlError) return c.json({ error: urlError }, 400);
    sets.push("url = ?"); binds.push(String(body.url).trim());
  }
  if (body.events !== undefined) {
    const events = parseEvents(body.events);
    if (!events) return c.json({ error: "กรุณาเลือกเหตุการณ์ที่ต้องการรับอย่างน้อย 1 รายการ" }, 400);
    sets.push("events = ?"); binds.push(JSON.stringify(events));
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return c.json({ error: "ค่าเปิด/ปิดไม่ถูกต้อง" }, 400);
    sets.push("active = ?"); binds.push(body.active ? 1 : 0);
  }
  if (!sets.length) return c.json({ error: "ไม่มีข้อมูลที่ต้องแก้ไข" }, 400);
  const res = await c.env.DB.prepare(`UPDATE webhook_endpoints SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...binds, id).run();
  if (!res.meta.changes) return c.json({ error: "ไม่พบปลายทาง webhook" }, 404);
  endpointCache = null;
  await audit(c, "update", "webhook", id, Object.keys(body));
  const endpoint = await c.env.DB.prepare(`${ENDPOINT_SELECT} WHERE w.id = ?`).bind(id).first();
  return c.json({ endpoint: shapeEndpoint(endpoint!) });
});

platformRouter.post("/admin/platform/webhooks/:id/rotate-secret", async (c) => {
  const id = c.req.param("id");
  const secret = "whsec_" + randomToken(24);
  const res = await c.env.DB.prepare("UPDATE webhook_endpoints SET secret_enc = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(await encryptSecret(secret, c.env.JWT_SECRET, "webhook"), id).run();
  if (!res.meta.changes) return c.json({ error: "ไม่พบปลายทาง webhook" }, 404);
  endpointCache = null;
  await audit(c, "rotate_secret", "webhook", id);
  return c.json({ secret, message: "สร้าง secret ใหม่แล้ว อัปเดตฝั่งผู้รับก่อนส่งครั้งถัดไป" });
});

platformRouter.delete("/admin/platform/webhooks/:id", async (c) => {
  const id = c.req.param("id");
  // Security-critical: always an emailed code (admins only).
  const denied = await requireDeleteConfirmation(c, "webhook.delete", id);
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM webhook_deliveries WHERE endpoint_id = ?").bind(id).run();
  const res = await c.env.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?").bind(id).run();
  if (!res.meta.changes) return c.json({ error: "ไม่พบปลายทาง webhook" }, 404);
  endpointCache = null;
  await audit(c, "delete", "webhook", id);
  return c.json({ message: "ลบปลายทาง webhook แล้ว" });
});

const DELIVERY_FIELDS = `id, endpoint_id, event, payload, status, attempts, response_code, duration_ms, error, response_excerpt,
  next_attempt_at, created_at, last_attempt_at, delivered_at`;

async function deliveryById(db: D1Database, id: string) {
  return db.prepare(`SELECT ${DELIVERY_FIELDS} FROM webhook_deliveries WHERE id = ?`).bind(id).first<DeliveryRow>();
}

/** Sends a "ping" event now and returns the logged delivery (works for paused endpoints too). */
platformRouter.post("/admin/platform/webhooks/:id/test", async (c) => {
  const id = c.req.param("id");
  const endpoint = await c.env.DB.prepare("SELECT id FROM webhook_endpoints WHERE id = ?").bind(id).first<{ id: string }>();
  if (!endpoint) return c.json({ error: "ไม่พบปลายทาง webhook" }, 404);
  const school = await loadSchoolSettings(c.env.DB);
  const [deliveryId] = await enqueue(c.env.DB, [endpoint], "ping", {
    id: newId("evt"), event: "ping", created_at: nowIso(), user_id: c.get("user").id, user_email: c.get("user").email, user_name: c.get("user").name,
    course_id: null, course_title: null, lesson_id: null, data: { message: `ทดสอบ webhook จาก ${school.school_name}` }
  });
  await deliverOne(c.env, deliveryId, true);
  return c.json({ delivery: await deliveryById(c.env.DB, deliveryId) });
});

platformRouter.get("/admin/platform/webhooks/:id/deliveries", async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);
  const status = c.req.query("status");
  const rows = await c.env.DB.prepare(`SELECT ${DELIVERY_FIELDS} FROM webhook_deliveries WHERE endpoint_id = ? ${status ? "AND status = ?" : ""}
    ORDER BY created_at DESC LIMIT ?`).bind(...[c.req.param("id"), ...(status ? [status] : []), limit]).all<DeliveryRow>();
  return c.json({ deliveries: rows.results });
});

/** Re-sends a logged delivery as a new delivery (same payload and event id) and returns it. */
platformRouter.post("/admin/platform/webhook-deliveries/:id/redeliver", async (c) => {
  const original = await deliveryById(c.env.DB, c.req.param("id"));
  if (!original) return c.json({ error: "ไม่พบรายการส่ง" }, 404);
  const id = newId("whd");
  const now = nowIso();
  await c.env.DB.prepare(`INSERT INTO webhook_deliveries (id, endpoint_id, event, payload, status, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)`).bind(id, original.endpoint_id, original.event, original.payload, now, now).run();
  await deliverOne(c.env, id, true);
  return c.json({ delivery: await deliveryById(c.env.DB, id) });
});

// ---------- API keys ----------

platformRouter.get("/admin/platform/api-keys", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT k.id, k.name, k.prefix, k.scopes, k.rate_limit_per_minute, k.created_at, k.last_used_at, k.revoked_at, k.expires_at,
    u.name AS created_by_name FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`).all<Record<string, any>>();
  return c.json({
    keys: rows.results.map(r => ({ ...r, scopes: safeList(r.scopes) })),
    scopes: API_SCOPES.map(s => ({ name: s, label: API_SCOPE_LABELS[s] }))
  });
});

platformRouter.post("/admin/platform/api-keys", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) return c.json({ error: "กรุณาตั้งชื่อ key (ไม่เกิน 80 ตัวอักษร)" }, 400);
  const scopes = Array.isArray(body?.scopes) ? [...new Set(body!.scopes)] : [];
  if (!scopes.length || !scopes.every(isApiScope)) return c.json({ error: "กรุณาเลือกสิทธิ์ (scope) อย่างน้อย 1 รายการ" }, 400);
  const limit = body?.rate_limit_per_minute === undefined ? 120 : Number(body.rate_limit_per_minute);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) return c.json({ error: "อัตราการเรียกต่อนาทีต้องเป็น 1–10,000" }, 400);
  let expiresAt: string | null = null;
  if (body?.expires_at) {
    const ms = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (!Number.isFinite(ms) || ms <= Date.now()) return c.json({ error: "วันหมดอายุต้องเป็นวันในอนาคต" }, 400);
    expiresAt = new Date(ms).toISOString();
  }
  const active = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL").first<{ n: number }>();
  if ((active?.n ?? 0) >= 50) return c.json({ error: "มี API key ที่ใช้งานได้สูงสุด 50 รายการ" }, 400);
  const secret = "npk_" + randomToken(32);
  const id = newId("key");
  await c.env.DB.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, scopes, rate_limit_per_minute, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, name, await sha256Hex(secret), secret.slice(0, 12), JSON.stringify(scopes), limit, expiresAt, c.get("user").id).run();
  await audit(c, "create", "api_key", id, { name, scopes });
  return c.json({
    key: { id, name, prefix: secret.slice(0, 12), scopes, rate_limit_per_minute: limit, expires_at: expiresAt, last_used_at: null, revoked_at: null },
    secret, message: "คัดลอก API key เก็บไว้ ระบบจะไม่แสดงอีก"
  }, 201);
});

platformRouter.delete("/admin/platform/api-keys/:id", async (c) => {
  const id = c.req.param("id");
  const denied = await requireDeleteConfirmation(c, "api_key.revoke", id);
  if (denied) return denied;
  const res = await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowIso(), id).run();
  if (!res.meta.changes) return c.json({ error: "ไม่พบ API key หรือถูกเพิกถอนไปแล้ว" }, 404);
  await audit(c, "revoke", "api_key", id);
  return c.json({ message: "เพิกถอน API key แล้ว ระบบที่ใช้ key นี้จะเรียก API ไม่ได้ทันที" });
});

// ==========================================
// Enterprise SSO (OpenID Connect)
// ==========================================

const OIDC_MESSAGES: Record<string, string> = {
  issuer_mismatch: "issuer ในเอกสาร discovery ไม่ตรงกับ Issuer URL ที่ตั้งค่า",
  discovery_invalid: "เอกสาร discovery (.well-known/openid-configuration) ไม่ถูกต้อง",
  discovery_insecure: "endpoint ของ IdP ต้องเป็น https",
  pkce_unsupported: "IdP ไม่รองรับ PKCE แบบ S256",
  idp_unreachable: "เชื่อมต่อ IdP ไม่ได้ ตรวจสอบ Issuer URL",
  idp_invalid_json: "IdP ตอบกลับข้อมูลที่ไม่ใช่ JSON",
  idp_response_too_large: "IdP ตอบกลับข้อมูลใหญ่เกินไป",
  jwks_invalid: "JWKS ของ IdP ไม่ถูกต้อง"
};

function issuerError(raw: unknown, env: Bindings): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 300) return "กรุณาระบุ Issuer URL";
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return "Issuer URL ไม่ถูกต้อง"; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "Issuer URL ต้องเป็น https และไม่มี query string";
  if (isLocal(env) && url.hostname === "idp.mock.test") return null;
  if (isPrivateHost(url.hostname) || !url.hostname.includes(".")) return "Issuer URL ต้องเป็นโดเมนสาธารณะ";
  if (url.hostname === "login.microsoftonline.com" && /\/(common|organizations|consumers)(\/|$)/.test(url.pathname)) {
    return "ใช้ Issuer แบบระบุ tenant เช่น https://login.microsoftonline.com/<tenant-id>/v2.0 (ไม่รองรับ common)";
  }
  return null;
}

const SSO_SELECT = `SELECT s.id, s.name, s.issuer, s.client_id, s.allowed_domains, s.default_role, s.auto_create, s.jit_tags, s.partner_id, s.enabled,
  s.created_at, s.updated_at, s.last_login_at, p.company_name AS partner_name,
  (SELECT COUNT(*) FROM sso_identities i WHERE i.provider_id = s.id) AS linked_users
  FROM sso_providers s LEFT JOIN partners p ON p.id = s.partner_id`;

const shapeSso = (row: Record<string, any>) => ({
  ...row, allowed_domains: String(row.allowed_domains || "").split(",").filter(Boolean), jit_tags: String(row.jit_tags || "").split(",").filter(Boolean),
  auto_create: !!row.auto_create, enabled: !!row.enabled, has_client_secret: true
});

const callbackUrl = (c: Context<Env>) => `${new URL(c.req.url).origin}/api/sso/callback`;

async function parseSsoBody(c: Context<Env>, body: Record<string, unknown> | null, existing?: Record<string, any>): Promise<{ values?: Record<string, unknown>; error?: string }> {
  if (!body) return { error: "ข้อมูลไม่ถูกต้อง" };
  const partial = !!existing;
  const values: Record<string, unknown> = {};
  const has = (key: string) => body[key] !== undefined;
  if (!partial || has("name")) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return { error: "กรุณาตั้งชื่อการเชื่อมต่อ (ไม่เกิน 80 ตัวอักษร)" };
    values.name = name;
  }
  if (!partial || has("issuer")) {
    const error = issuerError(body.issuer, c.env);
    if (error) return { error };
    values.issuer = normalizeIssuer(String(body.issuer));
  }
  if (!partial || has("client_id")) {
    const id = typeof body.client_id === "string" ? body.client_id.trim() : "";
    if (!id || id.length > 200) return { error: "กรุณาระบุ Client ID" };
    values.client_id = id;
  }
  if (!partial || (typeof body.client_secret === "string" && body.client_secret.trim())) {
    const secret = typeof body.client_secret === "string" ? body.client_secret.trim() : "";
    if (!secret || secret.length > 500) return { error: "กรุณาระบุ Client secret" };
    values.client_secret_enc = await encryptSecret(secret, c.env.JWT_SECRET, "oidc-client");
  }
  if (!partial || has("allowed_domains")) {
    const domains = parseDomains(body.allowed_domains, 20);
    if (!domains || !domains.length) return { error: "กรุณาระบุโดเมนอีเมลขององค์กรอย่างน้อย 1 โดเมน (เช่น company.co.th)" };
    values.allowed_domains = domains.join(",");
  }
  if (!partial || has("default_role")) {
    const role = body.default_role ?? "student";
    if (!["student", "instructor"].includes(role as string)) return { error: "บทบาทเริ่มต้นต้องเป็นผู้เรียนหรือผู้สอน" };
    values.default_role = role;
  }
  for (const key of ["auto_create", "enabled"] as const) {
    if (!partial && body[key] === undefined) { values[key] = 1; continue; }
    if (has(key)) {
      if (typeof body[key] !== "boolean") return { error: "ค่าเปิด/ปิดไม่ถูกต้อง" };
      values[key] = body[key] ? 1 : 0;
    }
  }
  if (!partial || has("jit_tags")) {
    const raw = body.jit_tags ?? [];
    const tags = (Array.isArray(raw) ? raw : String(raw).split(",")).map(t => String(t).trim()).filter(Boolean);
    if (tags.length > 10 || tags.some(t => t.length > 40 || t.includes(","))) return { error: "แท็กสูงสุด 10 รายการ ยาวไม่เกิน 40 ตัวอักษร" };
    values.jit_tags = [...new Set(tags)].join(",") || null;
  }
  if (!partial || has("partner_id")) {
    const partnerId = body.partner_id ? String(body.partner_id) : null;
    if (partnerId && !(await c.env.DB.prepare("SELECT id FROM partners WHERE id = ?").bind(partnerId).first())) return { error: "ไม่พบองค์กรพาร์ตเนอร์" };
    values.partner_id = partnerId;
  }
  return { values };
}

platformRouter.get("/admin/platform/sso", async (c) => {
  const [rows, partners] = await c.env.DB.batch([
    c.env.DB.prepare(`${SSO_SELECT} ORDER BY s.created_at`),
    c.env.DB.prepare("SELECT id, company_name FROM partners ORDER BY company_name")
  ]);
  return c.json({ providers: (rows.results as Record<string, any>[]).map(shapeSso), partners: partners.results, redirect_uri: callbackUrl(c) });
});

platformRouter.post("/admin/platform/sso", async (c) => {
  const { values, error } = await parseSsoBody(c, await c.req.json<Record<string, unknown>>().catch(() => null));
  if (error || !values) return c.json({ error }, 400);
  const id = newId("sso");
  const keys = Object.keys(values);
  await c.env.DB.prepare(`INSERT INTO sso_providers (id, ${keys.join(", ")}, created_by) VALUES (?, ${keys.map(() => "?").join(", ")}, ?)`)
    .bind(id, ...keys.map(k => values[k]), c.get("user").id).run();
  await audit(c, "create", "sso_provider", id, { name: values.name, issuer: values.issuer });
  const row = await c.env.DB.prepare(`${SSO_SELECT} WHERE s.id = ?`).bind(id).first();
  return c.json({ provider: shapeSso(row!), redirect_uri: callbackUrl(c) }, 201);
});

platformRouter.patch("/admin/platform/sso/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM sso_providers WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!existing) return c.json({ error: "ไม่พบการตั้งค่า SSO" }, 404);
  const { values, error } = await parseSsoBody(c, await c.req.json<Record<string, unknown>>().catch(() => null), existing);
  if (error || !values) return c.json({ error }, 400);
  const keys = Object.keys(values);
  if (!keys.length) return c.json({ error: "ไม่มีข้อมูลที่ต้องแก้ไข" }, 400);
  await c.env.DB.prepare(`UPDATE sso_providers SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(...keys.map(k => values[k]), id).run();
  await audit(c, "update", "sso_provider", id, keys.filter(k => k !== "client_secret_enc"));
  const row = await c.env.DB.prepare(`${SSO_SELECT} WHERE s.id = ?`).bind(id).first();
  return c.json({ provider: shapeSso(row!) });
});

platformRouter.delete("/admin/platform/sso/:id", async (c) => {
  const id = c.req.param("id");
  const denied = await requireDeleteConfirmation(c, "sso.delete", id);
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM sso_identities WHERE provider_id = ?").bind(id).run();
  const res = await c.env.DB.prepare("DELETE FROM sso_providers WHERE id = ?").bind(id).run();
  if (!res.meta.changes) return c.json({ error: "ไม่พบการตั้งค่า SSO" }, 404);
  await audit(c, "delete", "sso_provider", id);
  return c.json({ message: "ลบการเชื่อมต่อ SSO แล้ว ผู้ใช้ยังเข้าสู่ระบบด้วยรหัสผ่านได้ตามปกติ" });
});

/** Fetches the IdP discovery document (fresh) to confirm the issuer is reachable and compatible. */
platformRouter.post("/admin/platform/sso/:id/test", async (c) => {
  const row = await c.env.DB.prepare("SELECT issuer FROM sso_providers WHERE id = ?").bind(c.req.param("id")).first<{ issuer: string }>();
  if (!row) return c.json({ error: "ไม่พบการตั้งค่า SSO" }, 404);
  try {
    const doc = await loadDiscovery(c.env.SESSIONS, row.issuer, ssoFetcher(c.env), true);
    await loadJwks(c.env.SESSIONS, doc.jwks_uri, ssoFetcher(c.env), true);
    return c.json({ ok: true, issuer: doc.issuer, authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint, redirect_uri: callbackUrl(c) });
  } catch (error) {
    const code = error instanceof OidcError ? error.code : "idp_unreachable";
    return c.json({ ok: false, error: OIDC_MESSAGES[code] || "ตรวจสอบการเชื่อมต่อ IdP ไม่สำเร็จ", code }, 502);
  }
});

// ---------- Local mock IdP (test harness only: https://idp.mock.test when ALLOW_LOCAL_SEED_PASSWORDS=true) ----------

let mockKeys: Promise<{ privateKey: CryptoKey; jwk: JsonWebKey }> | null = null;
function mockKeyPair() {
  mockKeys ??= (async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
    return { privateKey: pair.privateKey, jwk };
  })();
  return mockKeys;
}

const MOCK_ISSUER = "https://idp.mock.test";

/**
 * Test code from the harness carries the claims to sign: base64url(JSON {sub, email, nonce, code_challenge, ...}).
 * The mock checks client_secret "mock-secret" and the PKCE verifier like a real IdP would.
 */
async function mockIdp(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/.well-known/openid-configuration") {
    return json({ issuer: MOCK_ISSUER, authorization_endpoint: `${MOCK_ISSUER}/authorize`, token_endpoint: `${MOCK_ISSUER}/token`, jwks_uri: `${MOCK_ISSUER}/jwks`,
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post"], id_token_signing_alg_values_supported: ["RS256"] });
  }
  if (url.pathname === "/jwks") return json({ keys: [{ ...(await mockKeyPair()).jwk, kid: "mock-1", alg: "RS256", use: "sig" }] });
  if (url.pathname === "/token") {
    const form = new URLSearchParams(String(init?.body || ""));
    if (form.get("client_secret") !== "mock-secret") return json({ error: "invalid_client" }, 401);
    let claims: Record<string, any>;
    try { claims = JSON.parse(new TextDecoder().decode(b64urlDecode(form.get("code") || ""))); } catch { return json({ error: "invalid_grant" }, 400); }
    if (claims.code_challenge !== await pkceChallenge(form.get("code_verifier") || "")) return json({ error: "invalid_grant", error_description: "PKCE" }, 400);
    const { code_challenge, ...rest } = claims;
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: MOCK_ISSUER, aud: form.get("client_id"), iat: now, exp: now + 300, ...rest };
    const enc = (v: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
    const input = `${enc({ alg: "RS256", kid: "mock-1", typ: "JWT" })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (await mockKeyPair()).privateKey, new TextEncoder().encode(input));
    return json({ access_token: "mock-access", token_type: "Bearer", id_token: `${input}.${b64urlEncode(new Uint8Array(sig))}` });
  }
  return json({ error: "not_found" }, 404);
}

function ssoFetcher(env: Bindings) {
  return (input: string, init?: RequestInit): Promise<Response> => {
    if (isLocal(env) && input.startsWith(`${MOCK_ISSUER}/`)) return mockIdp(input, init);
    return fetch(input, init);
  };
}

// ---------- SSO login ----------

interface SsoProviderRow {
  id: string; name: string; issuer: string; client_id: string; client_secret_enc: string; allowed_domains: string; default_role: string;
  auto_create: number; jit_tags: string | null; partner_id: string | null; enabled: number;
}

/** `binding` is the SHA-256 (hex) of a secret the SPA keeps in sessionStorage; /sso/exchange must present the secret. */
interface SsoState { provider_id: string; verifier: string; nonce: string; return_to: string; redirect_uri: string; binding: string }
const BINDING_RE = /^[a-f0-9]{64}$/;
const BINDING_SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/;
/** Roles whose accounts are never auto-linked to an SSO identity by email (they link from their profile after a password sign-in). */
const NO_AUTO_LINK_ROLES = new Set(["admin", "coordinator", "instructor"]);

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function returnOrigin(env: Bindings, raw: unknown): string {
  const fallback = appUrl(env, "").replace(/\/$/, "");
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    const origin = new URL(raw).origin;
    return allowedOrigins(env.FRONTEND_ORIGINS).includes(origin) ? origin : fallback;
  } catch { return fallback; }
}

platformRouter.get("/sso/status", async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM sso_providers WHERE enabled = 1").first<{ n: number }>();
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ enabled: (row?.n ?? 0) > 0 });
});

/** Finds the organization's IdP by the work email domain and returns the IdP authorization URL. */
platformRouter.post("/sso/start", async (c) => {
  c.header("Cache-Control", "no-store");
  if (await rateLimited(c.env.SESSIONS, "sso-start", clientIp(c), 30)) return tooManyRequests(c);
  const body = await c.req.json<{ email?: unknown; return_to?: unknown; binding?: unknown }>().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return c.json({ error: "กรุณากรอกอีเมลองค์กรที่ถูกต้อง" }, 400);
  const binding = typeof body?.binding === "string" ? body.binding.toLowerCase() : "";
  if (!BINDING_RE.test(binding)) return c.json({ error: "คำขอเข้าสู่ระบบไม่ถูกต้อง กรุณารีเฟรชหน้าแล้วลองใหม่" }, 400);
  const domain = emailDomain(email);
  const rows = await c.env.DB.prepare("SELECT * FROM sso_providers WHERE enabled = 1 ORDER BY partner_id IS NULL, created_at").all<SsoProviderRow>();
  const provider = rows.results.find(p => p.allowed_domains.split(",").includes(domain));
  if (!provider) return c.json({ error: "ไม่พบการเข้าสู่ระบบ SSO สำหรับโดเมนอีเมลนี้ กรุณาใช้อีเมลและรหัสผ่าน หรือติดต่อผู้ดูแลระบบ" }, 404);
  let doc;
  try { doc = await loadDiscovery(c.env.SESSIONS, provider.issuer, ssoFetcher(c.env)); } catch (error) {
    console.error("SSO discovery failed", error instanceof OidcError ? error.code : error);
    return c.json({ error: "เชื่อมต่อระบบยืนยันตัวตนขององค์กรไม่ได้ กรุณาลองใหม่ภายหลัง" }, 502);
  }
  const state = randomValue();
  const saved: SsoState = { provider_id: provider.id, verifier: randomValue(48), nonce: randomValue(), return_to: returnOrigin(c.env, body?.return_to), redirect_uri: callbackUrl(c), binding };
  await c.env.SESSIONS.put(`sso-state:${await sha256Hex(state)}`, JSON.stringify(saved), { expirationTtl: 600 });
  const url = new URL(doc.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: provider.client_id, response_type: "code", scope: "openid email profile", redirect_uri: saved.redirect_uri,
    state, nonce: saved.nonce, code_challenge: await pkceChallenge(saved.verifier), code_challenge_method: "S256", login_hint: email
  }).toString();
  return c.json({ url: url.toString(), provider: provider.name });
});

class SsoLoginError extends Error {}

async function resolveSsoUser(env: Bindings, provider: SsoProviderRow, claims: { sub: string; email: string; name: string; emailVerified: boolean }): Promise<{ userId: string; created: boolean }> {
  const db = env.DB;
  const linked = await db.prepare(`SELECT u.id, u.status FROM sso_identities i JOIN users u ON u.id = i.user_id WHERE i.provider_id = ? AND i.subject = ?`)
    .bind(provider.id, claims.sub).first<{ id: string; status: string }>();
  if (linked) {
    if (linked.status !== "active") throw new SsoLoginError("account_suspended");
    await db.prepare("UPDATE sso_identities SET last_login_at = ?, email = ? WHERE provider_id = ? AND subject = ?").bind(nowIso(), claims.email, provider.id, claims.sub).run();
    return { userId: linked.id, created: false };
  }
  // Link by email only for the organization's own (allowed) domains; checked by the caller.
  const existing = await db.prepare(`SELECT u.id, u.status, u.role, u.staff_role, ${rolesColumn("u")} AS role_list FROM users u WHERE u.email = ?`)
    .bind(claims.email).first<{ id: string; status: string; role: string | null; staff_role: string | null; role_list: string | null }>();
  if (existing) {
    if (existing.status !== "active") throw new SsoLoginError("account_suspended");
    // Staff accounts are never taken over by an IdP assertion: they sign in with their password and link SSO from their profile.
    const roles = new Set<string>([...parseRoles(existing.role_list, existing.staff_role || existing.role), existing.role || "", existing.staff_role || ""]);
    if ([...roles].some(r => NO_AUTO_LINK_ROLES.has(r))) throw new SsoLoginError("staff_link_required");
    // Linking by email needs a positive email_verified (or Entra xms_edov) assertion; a missing claim is not enough.
    if (!claims.emailVerified) throw new SsoLoginError("email_unverified");
    const other = await db.prepare("SELECT subject FROM sso_identities WHERE provider_id = ? AND user_id = ?").bind(provider.id, existing.id).first();
    if (other) throw new SsoLoginError("account_link_conflict");
    await db.batch([
      db.prepare("INSERT INTO sso_identities (provider_id, subject, user_id, email, last_login_at) VALUES (?, ?, ?, ?, ?)").bind(provider.id, claims.sub, existing.id, claims.email, nowIso()),
      db.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").bind(nowIso(), existing.id)
    ]);
    return { userId: existing.id, created: false };
  }
  if (!provider.auto_create) throw new SsoLoginError("not_provisioned");
  const id = "usr_" + crypto.randomUUID();
  const stored = storedRole(provider.default_role === "instructor" ? "instructor" : "student");
  const tags = (provider.jit_tags || "").split(",").filter(Boolean);
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, password_hash, name, role, staff_role, partner_id, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, claims.email, `pbkdf2-sha256$unusable$${crypto.randomUUID().replace(/-/g, "")}`, claims.name.slice(0, 120), stored.role, stored.staff_role, provider.partner_id, nowIso()),
    db.prepare("INSERT INTO sso_identities (provider_id, subject, user_id, email, last_login_at) VALUES (?, ?, ?, ?, ?)").bind(provider.id, claims.sub, id, claims.email, nowIso()),
    ...tags.map(tag => db.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, ?)").bind(id, tag))
  ]);
  return { userId: id, created: true };
}

/** IdP redirect target. Always answers with a redirect to the front end: #ticket=… or #error=<code>. */
platformRouter.get("/sso/callback", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const fallback = returnOrigin(c.env, null);
  const back = (origin: string, fragment: Record<string, string>) => c.redirect(`${origin}/auth/sso/complete#${new URLSearchParams(fragment)}`, 302);
  const state = c.req.query("state") || "";
  if (!state || state.length > 200) return back(fallback, { error: "state_invalid" });
  const key = `sso-state:${await sha256Hex(state)}`;
  const saved = await c.env.SESSIONS.get(key, "json") as SsoState | null;
  if (!saved) return back(fallback, { error: "state_invalid" });
  await c.env.SESSIONS.delete(key);
  if (c.req.query("error")) return back(saved.return_to, { error: "idp_error" });
  const code = c.req.query("code") || "";
  if (!code || code.length > 4096) return back(saved.return_to, { error: "idp_error" });
  const provider = await c.env.DB.prepare("SELECT * FROM sso_providers WHERE id = ? AND enabled = 1").bind(saved.provider_id).first<SsoProviderRow>();
  if (!provider) return back(saved.return_to, { error: "provider_disabled" });
  const fetcher = ssoFetcher(c.env);
  try {
    const doc = await loadDiscovery(c.env.SESSIONS, provider.issuer, fetcher);
    const secret = await decryptSecret(provider.client_secret_enc, c.env.JWT_SECRET, "oidc-client");
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: saved.redirect_uri, code_verifier: saved.verifier, client_id: provider.client_id });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    const methods = doc.token_endpoint_auth_methods_supported;
    if (!methods || methods.includes("client_secret_basic")) {
      headers.Authorization = "Basic " + btoa(`${encodeURIComponent(provider.client_id)}:${encodeURIComponent(secret)}`);
    } else {
      form.set("client_secret", secret);
    }
    const tokenRes = await fetcher(doc.token_endpoint, { method: "POST", headers, body: form.toString(), redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const tokens = await tokenRes.json<any>().catch(() => ({}));
    if (!tokenRes.ok || typeof tokens.id_token !== "string") return back(saved.return_to, { error: "token_exchange_failed" });
    let jwks = await loadJwks(c.env.SESSIONS, doc.jwks_uri, fetcher);
    const kid = tokenKid(tokens.id_token);
    if (kid && !jwks.keys.some(k => k.kid === kid)) jwks = await loadJwks(c.env.SESSIONS, doc.jwks_uri, fetcher, true); // key rotation
    const claims = await verifyIdToken(tokens.id_token, { issuer: provider.issuer, clientId: provider.client_id, nonce: saved.nonce, jwks });
    const email = assertedEmail(claims);
    if (!email) return back(saved.return_to, { error: "email_missing" });
    const allowed = provider.allowed_domains.split(",");
    if (!allowed.includes(emailDomain(email))) return back(saved.return_to, { error: "domain_not_allowed" });
    // Google: a consumer account may use a work address; the hosted-domain claim proves Workspace membership.
    if (normalizeIssuer(provider.issuer) === "https://accounts.google.com" && (typeof claims.hd !== "string" || !allowed.includes(claims.hd.toLowerCase()))) {
      return back(saved.return_to, { error: "domain_not_allowed" });
    }
    const name = (typeof claims.name === "string" && claims.name.trim()) || email.split("@")[0];
    const { userId, created } = await resolveSsoUser(c.env, provider, { sub: claims.sub, email, name, emailVerified: emailVerifiedClaim(claims) });
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").bind(userId),
      c.env.DB.prepare("UPDATE sso_providers SET last_login_at = ? WHERE id = ?").bind(nowIso(), provider.id)
    ]);
    if (created) await trackEvent(c.env.DB, userId, "signup", { data: { method: "sso", provider_id: provider.id } });
    await trackEvent(c.env.DB, userId, "login", { data: { method: "sso", provider_id: provider.id } });
    const ticket = randomValue();
    await c.env.SESSIONS.put(`sso-ticket:${await sha256Hex(ticket)}`, JSON.stringify({ user_id: userId, binding: saved.binding }), { expirationTtl: 120 });
    return back(saved.return_to, { ticket });
  } catch (error) {
    if (error instanceof SsoLoginError) return back(saved.return_to, { error: error.message });
    if (error instanceof OidcError) {
      console.error("SSO ID token rejected:", error.code);
      return back(saved.return_to, { error: "id_token_invalid" });
    }
    console.error("SSO callback failed:", error);
    return back(saved.return_to, { error: "server_error" });
  }
});

/** Swaps the one-time ticket from the callback redirect for a normal NetPrime session. */
platformRouter.post("/sso/exchange", async (c) => {
  c.header("Cache-Control", "no-store");
  if (await rateLimited(c.env.SESSIONS, "sso-exchange", clientIp(c), 30)) return tooManyRequests(c);
  if (!c.env.JWT_SECRET || c.env.JWT_SECRET.length < 32) return c.json({ error: "ระบบยืนยันตัวตนยังไม่ได้ตั้งค่า" }, 503);
  const body = await c.req.json<{ ticket?: unknown; secret?: unknown }>().catch(() => null);
  const ticket = typeof body?.ticket === "string" ? body.ticket : "";
  const secret = typeof body?.secret === "string" ? body.secret : "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return c.json({ error: "ลิงก์เข้าสู่ระบบไม่ถูกต้องหรือหมดอายุ" }, 400);
  const key = `sso-ticket:${await sha256Hex(ticket)}`;
  const saved = await c.env.SESSIONS.get(key, "json") as { user_id: string; binding?: string } | null;
  if (!saved) return c.json({ error: "ลิงก์เข้าสู่ระบบไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่" }, 400);
  // Single use: the ticket is burned even when the browser binding does not match.
  await c.env.SESSIONS.delete(key);
  // The ticket only works in the browser that started the login (login CSRF / session fixation guard).
  if (!saved.binding || !BINDING_SECRET_RE.test(secret) || !sameHex(await sha256Hex(secret), saved.binding)) {
    return c.json({ error: "ลิงก์เข้าสู่ระบบนี้ไม่ได้เริ่มจากเบราว์เซอร์นี้ กรุณาเริ่มเข้าสู่ระบบด้วย SSO ใหม่อีกครั้ง" }, 400);
  }
  const row = await c.env.DB.prepare(`SELECT u.id, u.email, u.name, COALESCE(u.staff_role, u.role) AS role, ${rolesColumn("u")} AS role_list, u.partner_id, u.status, u.email_verified_at
    FROM users u WHERE u.id = ?`).bind(saved.user_id)
    .first<{ id: string; email: string; name: string; role: string; role_list: string | null; partner_id: string | null; status: string; email_verified_at: string | null }>();
  if (!row || row.status !== "active") return c.json({ error: "บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ" }, 403);
  const roles = parseRoles(row.role_list, row.role);
  const identity: UserPayload = { id: row.id, email: row.email, name: row.name, role: primaryRole(roles), roles, partner_id: row.partner_id };
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const token = await jwt.sign({ ...identity, exp, iat_ms: Date.now(), jti: crypto.randomUUID() } as any, c.env.JWT_SECRET);
  return c.json({
    message: "เข้าสู่ระบบด้วย SSO องค์กรสำเร็จ", token,
    user: { ...identity, corporate_id: identity.partner_id, permissions: await permissionsForRoles(c.env.DB, roles), email_verified: !!row.email_verified_at, auth_provider: "sso" }
  });
});

// ==========================================
// Live meetings
// ==========================================

platformRouter.route("/live", liveRouter);
