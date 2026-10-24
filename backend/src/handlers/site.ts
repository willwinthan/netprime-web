import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { allowedOrigins } from "../utils/origins";
import { appUrl, escapeHtml, sendEmail } from "../utils/email";
import { issueAccountToken } from "../utils/tokens";
import { currentPermissions, permit, Permission } from "../utils/permissions";
import { createNotification } from "./notifications";
import { importNotionPage, notionPageId, NotionError } from "../utils/notion";

/**
 * Website content managed by coordinators (admin role):
 * training sessions + registrations, articles, promotions, contact inquiries and site settings.
 * Public routes live under /api/public, management routes under /api/admin/site.
 */
export const publicSiteRouter = new Hono<Env>();
export const adminSiteRouter = new Hono<Env>();

// Statuses that occupy seats in a training session.
const HOLD = ["pending", "confirmed", "paid", "attended"] as const;
const HOLD_SQL = HOLD.map(s => `'${s}'`).join(", ");
const REG_STATUSES = [...HOLD, "waitlist", "cancelled"] as const;
const STATUS_LABEL: Record<string, string> = {
  pending: "รอตรวจสอบ", confirmed: "ยืนยันแล้ว", paid: "ชำระเงินแล้ว",
  attended: "เข้าอบรมแล้ว", waitlist: "รอคิว", cancelled: "ยกเลิก"
};

// ==========================================
// Validation helpers
// ==========================================

type Kind = "text" | "email" | "date" | "int" | "bool" | "url" | readonly string[];
interface FieldSpec { kind: Kind; label: string; max?: number; min?: number; required?: boolean; default?: unknown }
type Values = Record<string, any>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Only http(s) links, site-relative paths and in-page anchors; never javascript: or data: URLs. */
function safeUrl(value: string): boolean {
  if (value.includes("\\")) return false; // "/\evil.com" is read by browsers as "//evil.com"
  if (value.startsWith("#") || (value.startsWith("/") && !value.startsWith("//"))) return true;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

/**
 * Validates a JSON body against a field spec.
 * partial=true (PATCH) skips absent keys; explicit null/"" clears optional fields.
 */
function parseFields(body: unknown, spec: Record<string, FieldSpec>, partial = false): { values: Values; error?: string } {
  const values: Values = {};
  const source = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  for (const [key, field] of Object.entries(spec)) {
    let raw = source[key];
    if (typeof raw === "string") raw = raw.trim();
    if (raw === undefined && partial) continue;
    if (raw === undefined || raw === null || raw === "") {
      if (field.required && field.default === undefined) return { values, error: `กรุณากรอก${field.label}` };
      values[key] = field.default ?? (field.kind === "bool" ? 0 : null);
      continue;
    }
    const kind = field.kind;
    if (Array.isArray(kind)) {
      if (!kind.includes(raw as string)) return { values, error: `${field.label}ไม่ถูกต้อง` };
      values[key] = raw;
    } else if (kind === "bool") {
      if (![true, false, 1, 0, "1", "0", "true", "false"].includes(raw as any)) return { values, error: `${field.label}ไม่ถูกต้อง` };
      values[key] = [true, 1, "1", "true"].includes(raw as any) ? 1 : 0;
    } else if (kind === "int") {
      const number = Number(raw);
      if (!Number.isInteger(number) || (field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) {
        return { values, error: `${field.label}ต้องเป็นจำนวนเต็ม${field.min !== undefined ? ` ตั้งแต่ ${field.min}` : ""}${field.max !== undefined ? ` ถึง ${field.max.toLocaleString("en-US")}` : ""}` };
      }
      values[key] = number;
    } else {
      if (typeof raw !== "string") return { values, error: `${field.label}ไม่ถูกต้อง` };
      if (raw.length > (field.max ?? 500)) return { values, error: `${field.label}ยาวเกิน ${field.max ?? 500} ตัวอักษร` };
      if (kind === "email" && !EMAIL_RE.test(raw)) return { values, error: `${field.label}ไม่ถูกต้อง` };
      if (kind === "date" && !validDate(raw)) return { values, error: `${field.label}ต้องเป็นรูปแบบ YYYY-MM-DD` };
      if (kind === "url" && !safeUrl(raw)) return { values, error: `${field.label}ต้องขึ้นต้นด้วย https:// หรือ /` };
      values[key] = kind === "email" ? raw.toLowerCase() : raw;
    }
  }
  return { values };
}

/** Today's date in Thailand, used for schedule visibility and registration deadlines. */
function bangkokToday(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

function pageParams(c: Context<Env>, defaultLimit = 50, maxLimit = 200) {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || String(defaultLimit), 10) || defaultLimit, 1), maxLimit);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);
  return { limit, offset };
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function uniqueViolation(error: any): boolean {
  return String(error?.message || "").includes("UNIQUE constraint failed");
}

// ==========================================
// Shared services: settings, notifications, abuse protection, audit
// ==========================================

interface SiteSettings {
  phone: string | null;
  email: string | null;
  line: string | null;
  address: string | null;
  hours: string | null;
  map_url: string | null;
  facebook_url: string | null;
  announcement: { active: boolean; text: string | null; link: string | null };
  notify_emails: string | null;
}

const DEFAULT_SETTINGS: SiteSettings = {
  phone: null, email: null, line: null, address: null, hours: null, map_url: null, facebook_url: null,
  announcement: { active: false, text: null, link: null }, notify_emails: null
};

async function loadSettings(db: D1Database): Promise<SiteSettings> {
  const row = await db.prepare("SELECT value FROM site_settings WHERE key = 'site'").first<{ value: string }>();
  let stored: Partial<SiteSettings> = {};
  try { stored = row ? JSON.parse(row.value) : {}; } catch { console.error("site_settings.site is not valid JSON"); }
  return { ...DEFAULT_SETTINGS, ...stored, announcement: { ...DEFAULT_SETTINGS.announcement, ...(stored.announcement || {}) } };
}

function notifyRecipients(settings: SiteSettings): string[] {
  return (settings.notify_emails || "").split(",").map(e => e.trim().toLowerCase()).filter(e => EMAIL_RE.test(e));
}

function siteUrl(c: Context<Env>): string {
  return allowedOrigins(c.env.FRONTEND_ORIGINS)[0] || "";
}

/** Sends email after the response; failures are logged, never shown to the visitor. */
function deliverLater(c: Context<Env>, task: Promise<unknown>) {
  const guarded = task.catch(error => console.error("Website email delivery failed:", error));
  try { c.executionCtx.waitUntil(guarded); } catch { /* No execution context (unit runtime): fire and forget. */ }
}

function emailLayout(title: string, rows: Array<[string, unknown]>, footer = ""): string {
  const table = rows.filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0">${escapeHtml(v)}</td></tr>`).join("");
  return `<div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #eaeaea;padding:20px;border-radius:10px">
    <h2 style="color:#e56b25;margin-top:0">${escapeHtml(title)}</h2>
    <table style="border-collapse:collapse;font-size:14px">${table}</table>
    ${footer}
    <p style="color:#94a3b8;font-size:12px;border-top:1px solid #eaeaea;padding-top:10px;margin-top:20px">NetPrime Training Center</p>
  </div>`;
}

/**
 * Soft per-IP limit for anonymous form posts. KV is eventually consistent,
 * so this stops casual spam; add a Cloudflare WAF rate-limit rule for hard limits.
 */
async function rateLimited(c: Context<Env>, action: string, max = 20): Promise<boolean> {
  const ip = c.req.header("CF-Connecting-IP") || "local";
  const key = `rl:${action}:${ip}`;
  const count = Number(await c.env.SESSIONS.get(key)) || 0;
  if (count >= max) return true;
  await c.env.SESSIONS.put(key, String(count + 1), { expirationTtl: 600 });
  return false;
}

/** Bot checks for public forms: hidden honeypot field + Cloudflare Turnstile when configured. */
async function botCheck(c: Context<Env>, body: Record<string, unknown>): Promise<string | null> {
  if (typeof body.website === "string" && body.website.trim() !== "") return "ไม่สามารถส่งข้อมูลได้";
  const secret = c.env.TURNSTILE_SECRET_KEY;
  if (!secret) return null;
  const token = body.turnstile_token;
  if (typeof token !== "string" || !token) return "กรุณายืนยันว่าไม่ใช่บอท";
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret, response: token, remoteip: c.req.header("CF-Connecting-IP") || "" })
  });
  const result = await res.json().catch(() => ({})) as { success?: boolean };
  return result.success ? null : "การยืนยันตัวตนไม่ผ่าน กรุณาลองใหม่";
}

async function audit(c: Context<Env>, action: string, entity: string, entityId: string | null, detail?: unknown) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("log"), c.get("user")?.id ?? null, action, entity, entityId, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000))
      .run();
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}

// ==========================================
// Training sessions
// ==========================================

const SESSION_SPEC: Record<string, FieldSpec> = {
  title: { kind: "text", label: "ชื่อหลักสูตร", max: 160, required: true },
  vendor: { kind: "text", label: "แบรนด์/หมวด", max: 40 },
  description: { kind: "text", label: "รายละเอียด", max: 2000 },
  course_id: { kind: "text", label: "คอร์สออนไลน์ที่เชื่อม", max: 80 },
  start_date: { kind: "date", label: "วันเริ่ม", required: true },
  end_date: { kind: "date", label: "วันสิ้นสุด", required: true },
  time_text: { kind: "text", label: "เวลาอบรม", max: 80 },
  mode: { kind: ["classroom", "online", "hybrid"], label: "รูปแบบ", required: true, default: "classroom" },
  location: { kind: "text", label: "สถานที่", max: 200 },
  instructor_name: { kind: "text", label: "วิทยากร", max: 120 },
  price: { kind: "int", label: "ราคา", min: 0, max: 10_000_000, required: true, default: 0 },
  capacity: { kind: "int", label: "จำนวนที่นั่ง", min: 1, max: 1000, required: true },
  registration_deadline: { kind: "date", label: "วันปิดรับสมัคร" },
  status: { kind: ["draft", "open", "closed", "cancelled"], label: "สถานะ", required: true, default: "draft" }
};
const SESSION_COLUMNS = Object.keys(SESSION_SPEC);

const SESSION_SELECT = `SELECT s.*,
  (SELECT COALESCE(SUM(attendees), 0) FROM session_registrations r WHERE r.session_id = s.id AND r.status IN (${HOLD_SQL})) AS seats_taken,
  (SELECT COUNT(*) FROM session_registrations r WHERE r.session_id = s.id AND r.status = 'pending') AS pending_count,
  (SELECT COUNT(*) FROM session_registrations r WHERE r.session_id = s.id AND r.status = 'waitlist') AS waitlist_count
  FROM training_sessions s`;

type SessionRow = Record<string, any> & {
  id: string; title: string; start_date: string; end_date: string; capacity: number; status: string;
  registration_deadline: string | null; seats_taken: number;
};

function publicSession(row: SessionRow, today = bangkokToday()) {
  const deadline = row.registration_deadline || row.start_date;
  const seatsLeft = Math.max(0, row.capacity - row.seats_taken);
  return {
    id: row.id, title: row.title, vendor: row.vendor, description: row.description, course_id: row.course_id,
    start_date: row.start_date, end_date: row.end_date, time_text: row.time_text, mode: row.mode,
    location: row.location, instructor_name: row.instructor_name, price: row.price,
    registration_deadline: deadline, seats_left: seatsLeft,
    registration_open: row.status === "open" && deadline >= today,
    waitlist: row.status === "open" && deadline >= today && seatsLeft === 0
  };
}

/** `previousCourseId`: a course already linked may stay linked after it is archived. */
async function sessionCrossCheck(db: D1Database, values: Values, previousCourseId?: string | null): Promise<string | null> {
  if (values.end_date < values.start_date) return "วันสิ้นสุดต้องไม่ก่อนวันเริ่ม";
  if (values.registration_deadline && values.registration_deadline > values.end_date) return "วันปิดรับสมัครต้องไม่หลังวันสิ้นสุด";
  if (values.course_id && values.course_id !== previousCourseId) {
    const course = await db.prepare("SELECT status FROM courses WHERE id = ?").bind(values.course_id).first<{ status: string }>();
    if (!course) return "ไม่พบคอร์สออนไลน์ที่เลือก";
    if (course.status !== "published") return "เชื่อมได้เฉพาะคอร์สออนไลน์ที่เผยแพร่แล้ว";
  }
  return null;
}

// ==========================================
// PUBLIC ROUTES  (/api/public/*)
// ==========================================

publicSiteRouter.use("*", async (c, next) => {
  await next();
  // Short shared cache for public GETs; form posts must never be cached.
  if (c.req.method === "GET" && c.res.status === 200 && !c.res.headers.has("Cache-Control")) {
    c.header("Cache-Control", "public, max-age=60");
  }
});

/** Contact details, announcement bar and active promotions for the header/footer. */
publicSiteRouter.get("/site", async (c) => {
  const settings = await loadSettings(c.env.DB);
  const today = bangkokToday();
  const promotions = await c.env.DB.prepare(`SELECT id, title, description, voucher_code, link_url, image_url, starts_at, ends_at
    FROM promotions WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)
    ORDER BY sort_order, created_at DESC LIMIT 20`).bind(today, today).all();
  const { notify_emails, ...publicSettings } = settings;
  const legal = await loadLegal(c.env.DB);
  return c.json({
    settings: publicSettings, promotions: promotions.results, home: await loadHome(c.env.DB),
    legal: LEGAL_KEYS.map(key => ({ key, path: `/${key}`, title: legal[key].title }))
  });
});

/** Privacy policy, terms and refund policy (Markdown, rendered by the site's Markdown component). */
publicSiteRouter.get("/legal/:key", async (c) => {
  const key = c.req.param("key") as LegalKey;
  if (!LEGAL_KEYS.includes(key)) return c.json({ error: "ไม่พบหน้านี้" }, 404);
  return c.json({ page: { key, ...(await loadLegal(c.env.DB))[key] } });
});

publicSiteRouter.get("/sessions", async (c) => {
  const today = bangkokToday();
  const vendor = c.req.query("vendor");
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 100);
  const rows = await c.env.DB.prepare(`${SESSION_SELECT}
    WHERE s.status IN ('open', 'closed') AND s.end_date >= ? AND (? IS NULL OR s.vendor = ?)
    ORDER BY s.start_date, s.title LIMIT ?`).bind(today, vendor || null, vendor || null, limit).all<SessionRow>();
  const vendors = await c.env.DB.prepare(`SELECT DISTINCT vendor FROM training_sessions
    WHERE status IN ('open', 'closed') AND end_date >= ? AND vendor IS NOT NULL ORDER BY vendor`).bind(today).all<{ vendor: string }>();
  return c.json({ sessions: rows.results.map(row => publicSession(row, today)), vendors: vendors.results.map(v => v.vendor) });
});

publicSiteRouter.get("/sessions/:id", async (c) => {
  const row = await c.env.DB.prepare(`${SESSION_SELECT} WHERE s.id = ? AND s.status IN ('open', 'closed')`)
    .bind(c.req.param("id")).first<SessionRow>();
  if (!row) return c.json({ error: "ไม่พบรอบอบรมนี้" }, 404);
  return c.json({ session: publicSession(row) });
});

const REGISTRATION_SPEC: Record<string, FieldSpec> = {
  name: { kind: "text", label: "ชื่อ-นามสกุล", max: 120, required: true },
  email: { kind: "email", label: "อีเมล", max: 254, required: true },
  phone: { kind: "text", label: "เบอร์โทร", max: 30, required: true },
  company: { kind: "text", label: "บริษัท/หน่วยงาน", max: 160 },
  attendees: { kind: "int", label: "จำนวนผู้เข้าอบรม", min: 1, max: 50, required: true, default: 1 },
  note: { kind: "text", label: "หมายเหตุ", max: 1000 },
  invoice_required: { kind: "bool", label: "ต้องการใบกำกับภาษี" },
  tax_id: { kind: "text", label: "เลขประจำตัวผู้เสียภาษี", max: 20 },
  billing_address: { kind: "text", label: "ที่อยู่ออกใบกำกับภาษี", max: 500 }
};

function registrationCrossCheck(values: Values): string | null {
  if (values.phone && !/^[0-9+\-\s()]{6,30}$/.test(values.phone)) return "เบอร์โทรไม่ถูกต้อง";
  if (values.invoice_required && (!values.tax_id || !values.billing_address)) return "กรุณากรอกเลขผู้เสียภาษีและที่อยู่สำหรับออกใบกำกับภาษี";
  if (values.tax_id && !/^\d{13}$/.test(values.tax_id.replace(/[\s-]/g, ""))) return "เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก";
  return null;
}

/**
 * Inserts a registration that holds seats only if capacity remains.
 * The capacity check and insert run as one SQL statement, so concurrent requests cannot overbook.
 */
async function insertRegistration(db: D1Database, sessionId: string, values: Values, status: string, source: "web" | "admin"): Promise<{ id: string; status: string } | null> {
  const id = newId("reg");
  const fields = [values.name, values.email, values.phone, values.company, values.attendees, values.note,
    values.invoice_required, values.tax_id ? values.tax_id.replace(/[\s-]/g, "") : null, values.billing_address];
  if (status === "waitlist") {
    await db.prepare(`INSERT INTO session_registrations (id, session_id, name, email, phone, company, attendees, note, invoice_required, tax_id, billing_address, status, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waitlist', ?)`).bind(id, sessionId, ...fields, source).run();
    return { id, status };
  }
  const result = await db.prepare(`INSERT INTO session_registrations (id, session_id, name, email, phone, company, attendees, note, invoice_required, tax_id, billing_address, status, source)
    SELECT ?, s.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM training_sessions s
    WHERE s.id = ? AND s.capacity >= ? + (SELECT COALESCE(SUM(attendees), 0) FROM session_registrations r WHERE r.session_id = s.id AND r.status IN (${HOLD_SQL}))`)
    .bind(id, ...fields, status, source, sessionId, values.attendees).run();
  return result.meta.changes ? { id, status } : null;
}

// ==========================================
// Registrations ↔ LMS accounts
// Classroom attendees get an account (matched by email), the session's linked online course
// once confirmed or paid, and certificates through normal course completion.
// ==========================================

/** Links a registration to the account with the same email. relink=true re-matches after an email change. */
async function linkRegistration(db: D1Database, registrationId: string, relink = false): Promise<void> {
  await db.prepare(`UPDATE session_registrations SET user_id = (SELECT u.id FROM users u WHERE u.email = session_registrations.email)
    WHERE id = ? AND (? = 1 OR user_id IS NULL)`).bind(registrationId, relink ? 1 : 0).run();
}

type AccessResult = "created" | "reactivated" | "existing" | null;

/**
 * Gives a confirmed/paid registrant the session's online course. Never duplicates an enrollment:
 * an active or completed one is left alone, a suspended or expired one is reactivated.
 * Access length follows courses.access_duration_days like a normal purchase.
 */
async function grantCourseAccess(db: D1Database, registrationId: string): Promise<AccessResult> {
  const reg = await db.prepare(`SELECT r.user_id, r.status, s.course_id, c.access_duration_days
    FROM session_registrations r JOIN training_sessions s ON s.id = r.session_id LEFT JOIN courses c ON c.id = s.course_id
    WHERE r.id = ?`).bind(registrationId).first<{ user_id: string | null; status: string; course_id: string | null; access_duration_days: number | null }>();
  if (!reg?.user_id || !reg.course_id || !["confirmed", "paid"].includes(reg.status)) return null;
  const days = reg.access_duration_days;
  const expiresAt = days && days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null;
  const inserted = await db.prepare(`INSERT INTO enrollments (id, user_id, course_id, progress_percent, status, expires_at)
    VALUES (?, ?, ?, 0, 'active', ?) ON CONFLICT(user_id, course_id) DO NOTHING`)
    .bind("enr_" + crypto.randomUUID(), reg.user_id, reg.course_id, expiresAt).run();
  if (inserted.meta.changes) return "created";
  const reactivated = await db.prepare(`UPDATE enrollments SET status = 'active', expires_at = ?
    WHERE user_id = ? AND course_id = ? AND (status = 'suspended' OR (expires_at IS NOT NULL AND expires_at <= ?))`)
    .bind(expiresAt, reg.user_id, reg.course_id, new Date().toISOString()).run();
  return reactivated.meta.changes ? "reactivated" : "existing";
}

/** After a session gains a linked course: confirmed/paid registrants with accounts get it too. */
async function grantSessionAccess(db: D1Database, sessionId: string): Promise<void> {
  const rows = await db.prepare(`SELECT id FROM session_registrations WHERE session_id = ? AND status IN ('confirmed', 'paid') AND user_id IS NOT NULL`)
    .bind(sessionId).all<{ id: string }>();
  for (const row of rows.results) await grantCourseAccess(db, row.id);
}

/** Password hash that no password can match (verifyPassword rejects the malformed pbkdf2 record). */
function unusablePasswordHash(): string {
  return `pbkdf2-sha256$unusable$${crypto.randomUUID().replace(/-/g, "")}`;
}

publicSiteRouter.post("/sessions/:id/register", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  if (await rateLimited(c, "register")) return c.json({ error: "ส่งข้อมูลบ่อยเกินไป กรุณารอสักครู่" }, 429);
  const blocked = await botCheck(c, body);
  if (blocked) return c.json({ error: blocked }, 400);
  if (body.consent !== true) return c.json({ error: "กรุณายินยอมให้เก็บข้อมูลเพื่อติดต่อกลับตามนโยบายความเป็นส่วนตัว" }, 400);

  const { values, error } = parseFields(body, REGISTRATION_SPEC);
  const problem = error || registrationCrossCheck(values);
  if (problem) return c.json({ error: problem }, 400);

  const db = c.env.DB;
  const row = await db.prepare(`${SESSION_SELECT} WHERE s.id = ? AND s.status IN ('open', 'closed')`)
    .bind(c.req.param("id")).first<SessionRow>();
  if (!row) return c.json({ error: "ไม่พบรอบอบรมนี้" }, 404);
  const session = publicSession(row);
  if (!session.registration_open) return c.json({ error: "รอบนี้ปิดรับสมัครแล้ว" }, 400);

  let created: { id: string; status: string } | null;
  try {
    created = await insertRegistration(db, row.id, values, "pending", "web")
      ?? await insertRegistration(db, row.id, values, "waitlist", "web");
  } catch (err) {
    if (uniqueViolation(err)) return c.json({ error: "อีเมลนี้ลงทะเบียนรอบนี้ไว้แล้ว เจ้าหน้าที่จะติดต่อกลับ" }, 409);
    throw err;
  }
  const waitlisted = created!.status === "waitlist";
  await linkRegistration(db, created!.id);

  const settings = await loadSettings(db);
  const details: Array<[string, unknown]> = [
    ["หลักสูตร", row.title], ["วันที่", `${row.start_date} ถึง ${row.end_date}`], ["เวลา", row.time_text],
    ["ชื่อ", values.name], ["อีเมล", values.email], ["โทร", values.phone], ["บริษัท", values.company],
    ["จำนวนผู้เข้าอบรม", values.attendees], ["ใบกำกับภาษี", values.invoice_required ? "ต้องการ" : "ไม่ต้องการ"], ["หมายเหตุ", values.note]
  ];
  deliverLater(c, Promise.all([
    sendEmail(values.email, waitlisted ? `อยู่ในรายชื่อรอคิว: ${row.title}` : `ได้รับใบสมัครแล้ว: ${row.title}`,
      emailLayout(waitlisted ? "ที่นั่งเต็มแล้ว คุณอยู่ในรายชื่อรอคิว" : "ได้รับใบสมัครอบรมของคุณแล้ว", details,
        `<p>เจ้าหน้าที่จะติดต่อกลับเพื่อยืนยันที่นั่งและแจ้งการชำระเงิน${settings.phone ? ` หรือติดต่อ ${escapeHtml(settings.phone)}` : ""}</p>`),
      c.env.RESEND_API_KEY),
    sendEmail(notifyRecipients(settings), `[ลงทะเบียนใหม่${waitlisted ? " - รอคิว" : ""}] ${row.title}`,
      emailLayout("มีผู้ลงทะเบียนอบรมใหม่", details, siteUrl(c) ? `<p>จัดการได้ที่ ${escapeHtml(siteUrl(c))}</p>` : ""),
      c.env.RESEND_API_KEY)
  ]));

  return c.json({
    message: waitlisted ? "ที่นั่งเต็มแล้ว เราบันทึกคุณไว้ในรายชื่อรอคิว" : "ลงทะเบียนสำเร็จ เจ้าหน้าที่จะติดต่อกลับเพื่อยืนยัน",
    registration: { id: created!.id, status: created!.status }
  }, 201);
});

publicSiteRouter.get("/articles", async (c) => {
  const category = c.req.query("category") || null;
  // Search title and excerpt; LIKE wildcards typed by visitors are matched literally.
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  const like = q ? `%${q.replace(/[\\%_]/g, ch => "\\" + ch)}%` : null;
  const { limit, offset } = pageParams(c, 12, 48);
  const where = `status = 'published' AND published_at <= datetime('now') AND (? IS NULL OR category = ?)
    AND (? IS NULL OR title LIKE ? ESCAPE '\\' OR excerpt LIKE ? ESCAPE '\\')`;
  const filters = [category, category, like, like, like];
  const rows = await c.env.DB.prepare(`SELECT id, slug, title, category, excerpt, cover_url, published_at FROM articles
    WHERE ${where} ORDER BY published_at DESC LIMIT ? OFFSET ?`)
    .bind(...filters, limit, offset).all();
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM articles WHERE ${where}`)
    .bind(...filters).first<{ n: number }>();
  const categories = await c.env.DB.prepare(`SELECT DISTINCT category FROM articles
    WHERE status = 'published' AND published_at <= datetime('now') AND category IS NOT NULL ORDER BY category`).all<{ category: string }>();
  return c.json({ articles: rows.results, total: total?.n ?? 0, categories: categories.results.map(r => r.category) });
});

publicSiteRouter.get("/articles/:slug", async (c) => {
  const article = await c.env.DB.prepare(`SELECT a.id, a.slug, a.title, a.category, a.excerpt, a.body, a.content_json, a.cover_url, a.published_at,
    u.name AS author_name
    FROM articles a LEFT JOIN users u ON u.id = a.author_id
    WHERE a.slug = ? AND a.status = 'published' AND a.published_at <= datetime('now')`).bind(c.req.param("slug")).first();
  if (!article) return c.json({ error: "ไม่พบบทความ" }, 404);
  return c.json({ article });
});

const INQUIRY_SPEC: Record<string, FieldSpec> = {
  name: { kind: "text", label: "ชื่อ-นามสกุล", max: 120, required: true },
  email: { kind: "email", label: "อีเมล", max: 254, required: true },
  phone: { kind: "text", label: "เบอร์โทร", max: 30 },
  company: { kind: "text", label: "บริษัท/หน่วยงาน", max: 160 },
  topic: { kind: "text", label: "หัวข้อ", max: 120 },
  message: { kind: "text", label: "ข้อความ", max: 3000, required: true }
};

publicSiteRouter.post("/inquiries", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  if (await rateLimited(c, "inquiry")) return c.json({ error: "ส่งข้อมูลบ่อยเกินไป กรุณารอสักครู่" }, 429);
  const blocked = await botCheck(c, body);
  if (blocked) return c.json({ error: blocked }, 400);
  if (body.consent !== true) return c.json({ error: "กรุณายินยอมให้ติดต่อกลับตามนโยบายความเป็นส่วนตัว" }, 400);
  const { values, error } = parseFields(body, INQUIRY_SPEC);
  if (error) return c.json({ error }, 400);

  const id = newId("inq");
  await c.env.DB.prepare("INSERT INTO inquiries (id, name, email, phone, company, topic, message) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, values.name, values.email, values.phone, values.company, values.topic, values.message).run();

  const settings = await loadSettings(c.env.DB);
  deliverLater(c, sendEmail(notifyRecipients(settings), `[ติดต่อใหม่] ${values.topic || values.name}`,
    emailLayout("มีข้อความติดต่อใหม่จากเว็บไซต์", [
      ["ชื่อ", values.name], ["อีเมล", values.email], ["โทร", values.phone], ["บริษัท", values.company],
      ["หัวข้อ", values.topic], ["ข้อความ", values.message]
    ]), c.env.RESEND_API_KEY));
  return c.json({ message: "ส่งข้อความเรียบร้อย เจ้าหน้าที่จะติดต่อกลับภายใน 1 วันทำการ", id }, 201);
});

/** Serves images uploaded from the content console (R2 prefix site/). */
publicSiteRouter.get("/images/:name", async (c) => {
  const name = c.req.param("name");
  if (!/^[a-f0-9]{32}\.(png|jpg|webp|gif)$/.test(name)) return c.json({ error: "Not found" }, 404);
  const object = await c.env.ASSETS.get(`site/${name}`);
  if (!object) return c.json({ error: "Not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff"
    }
  });
});

// ==========================================
// ADMIN ROUTES  (/api/admin/site/*)
// ==========================================

// Any signed-in user, then the feature permission of each area (editable per role by admins).
adminSiteRouter.use("*", rbac());
const guard = (paths: string[], ...permissions: Permission[]) => paths.forEach(path => adminSiteRouter.use(path, permit(...permissions)));
guard(["/summary"], "site.dashboard");
guard(["/sessions", "/sessions/*", "/registrations/*", "/course-options"], "site.sessions");
guard(["/inquiries", "/inquiries/*"], "site.inquiries");
guard(["/promotions", "/promotions/*"], "site.promotions");
guard(["/settings", "/home", "/legal", "/legal/*"], "site.settings");
guard(["/images"], "site.media");
guard(["/audit"], "site.audit");
// Per-article ownership and workflow rules live in the handlers.
guard(["/articles", "/articles/*"], "articles.write", "articles.publish", "articles.manage");
adminSiteRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

/** Work queue for coordinators: what needs attention today. */
adminSiteRouter.get("/summary", async (c) => {
  const db = c.env.DB;
  const today = bangkokToday();
  const [counts, upcoming, recent] = await db.batch([
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM inquiries WHERE status = 'new') AS new_inquiries,
      (SELECT COUNT(*) FROM session_registrations WHERE status = 'pending') AS pending_registrations,
      (SELECT COUNT(*) FROM session_registrations WHERE status = 'waitlist') AS waitlist_registrations,
      (SELECT COUNT(*) FROM training_sessions WHERE status = 'open' AND end_date >= ?) AS open_sessions,
      (SELECT COUNT(*) FROM articles WHERE status = 'published') AS published_articles`).bind(today),
    db.prepare(`${SESSION_SELECT} WHERE s.status IN ('open', 'closed') AND s.end_date >= ? ORDER BY s.start_date LIMIT 6`).bind(today),
    db.prepare(`SELECT r.id, r.name, r.company, r.attendees, r.status, r.created_at, s.id AS session_id, s.title AS session_title
      FROM session_registrations r JOIN training_sessions s ON s.id = r.session_id ORDER BY r.created_at DESC LIMIT 8`)
  ]);
  return c.json({ counts: counts.results[0], upcoming: upcoming.results, recentRegistrations: recent.results });
});

/** Published online courses a training session may link to (session form picker). */
adminSiteRouter.get("/course-options", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, title FROM courses WHERE status = 'published' ORDER BY title").all<{ id: string; title: string }>();
  return c.json({ courses: rows.results });
});

adminSiteRouter.get("/sessions", async (c) => {
  const scope = c.req.query("scope") || "upcoming"; // upcoming | past | all
  const { limit, offset } = pageParams(c, 100, 200);
  const today = bangkokToday();
  const filter = scope === "past" ? "s.end_date < ?" : scope === "all" ? "? IS NOT NULL" : "s.end_date >= ?";
  const order = scope === "past" ? "s.start_date DESC" : "s.start_date";
  const rows = await c.env.DB.prepare(`${SESSION_SELECT} WHERE ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(today, limit, offset).all();
  return c.json({ sessions: rows.results });
});

adminSiteRouter.post("/sessions", async (c) => {
  const { values, error } = parseFields(await c.req.json().catch(() => null), SESSION_SPEC);
  const problem = error || await sessionCrossCheck(c.env.DB, values);
  if (problem) return c.json({ error: problem }, 400);
  const id = newId("ses");
  await c.env.DB.prepare(`INSERT INTO training_sessions (id, ${SESSION_COLUMNS.join(", ")}, created_by)
    VALUES (?, ${SESSION_COLUMNS.map(() => "?").join(", ")}, ?)`)
    .bind(id, ...SESSION_COLUMNS.map(k => values[k]), c.get("user").id).run();
  await audit(c, "create", "session", id, { title: values.title, start_date: values.start_date });
  const session = await c.env.DB.prepare(`${SESSION_SELECT} WHERE s.id = ?`).bind(id).first();
  return c.json({ session }, 201);
});

adminSiteRouter.patch("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(`${SESSION_SELECT} WHERE s.id = ?`).bind(id).first<SessionRow>();
  if (!existing) return c.json({ error: "ไม่พบรอบอบรม" }, 404);
  const { values, error } = parseFields(await c.req.json().catch(() => null), SESSION_SPEC, true);
  if (error) return c.json({ error }, 400);
  const keys = Object.keys(values);
  if (keys.length === 0) return c.json({ error: "ไม่มีข้อมูลที่ต้องแก้ไข" }, 400);
  const merged = { ...existing, ...values };
  const problem = await sessionCrossCheck(c.env.DB, merged, existing.course_id);
  if (problem) return c.json({ error: problem }, 400);

  // Capacity may only shrink to the seats already held; checked in the same statement as the update.
  const result = await c.env.DB.prepare(`UPDATE training_sessions SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND ? >= (SELECT COALESCE(SUM(attendees), 0) FROM session_registrations WHERE session_id = ? AND status IN (${HOLD_SQL}))`)
    .bind(...keys.map(k => values[k]), id, merged.capacity, id).run();
  if (!result.meta.changes) return c.json({ error: `มีผู้จองที่นั่งแล้ว ${existing.seats_taken} ที่ ลดจำนวนที่นั่งต่ำกว่านี้ไม่ได้` }, 409);
  // A moved session gets a fresh reminder; a newly linked course is granted to confirmed registrants.
  if (values.start_date && values.start_date !== existing.start_date) {
    await c.env.DB.prepare("UPDATE session_registrations SET reminder_sent_at = NULL WHERE session_id = ?").bind(id).run();
  }
  if (values.course_id && values.course_id !== existing.course_id) await grantSessionAccess(c.env.DB, id);
  await audit(c, "update", "session", id, values);
  const session = await c.env.DB.prepare(`${SESSION_SELECT} WHERE s.id = ?`).bind(id).first();
  return c.json({ session });
});

adminSiteRouter.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const counts = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM session_registrations WHERE session_id = ? AND status != 'cancelled'")
    .bind(id).first<{ n: number }>();
  if ((counts?.n ?? 0) > 0) {
    return c.json({ error: "รอบนี้มีผู้ลงทะเบียนอยู่ ให้เปลี่ยนสถานะเป็น 'ยกเลิก' แทนการลบ เพื่อเก็บประวัติไว้" }, 409);
  }
  const result = await c.env.DB.prepare("DELETE FROM training_sessions WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบรอบอบรม" }, 404);
  await audit(c, "delete", "session", id);
  return c.json({ message: "ลบรอบอบรมแล้ว" });
});

adminSiteRouter.post("/sessions/:id/duplicate", async (c) => {
  const source = await c.env.DB.prepare("SELECT * FROM training_sessions WHERE id = ?").bind(c.req.param("id")).first<Record<string, any>>();
  if (!source) return c.json({ error: "ไม่พบรอบอบรม" }, 404);
  const id = newId("ses");
  // Copies are drafts so coordinators can change dates before publishing.
  const values: Values = { ...source, status: "draft" };
  await c.env.DB.prepare(`INSERT INTO training_sessions (id, ${SESSION_COLUMNS.join(", ")}, created_by)
    VALUES (?, ${SESSION_COLUMNS.map(() => "?").join(", ")}, ?)`)
    .bind(id, ...SESSION_COLUMNS.map(k => values[k] ?? null), c.get("user").id).run();
  await audit(c, "duplicate", "session", id, { from: source.id });
  const session = await c.env.DB.prepare(`${SESSION_SELECT} WHERE s.id = ?`).bind(id).first();
  return c.json({ session }, 201);
});

adminSiteRouter.get("/sessions/:id/registrations", async (c) => {
  const session = await c.env.DB.prepare(`${SESSION_SELECT} WHERE s.id = ?`).bind(c.req.param("id")).first();
  if (!session) return c.json({ error: "ไม่พบรอบอบรม" }, 404);
  // Account status per registrant: linked account, or an account created later with the same email.
  const rows = await c.env.DB.prepare(`SELECT r.*, u.id AS account_id, u.status AS account_status, u.last_login_at AS account_last_login,
      (SELECT 1 FROM enrollments e JOIN training_sessions s ON s.id = r.session_id
        WHERE e.user_id = u.id AND e.course_id = s.course_id AND e.status IN ('active', 'completed')) AS course_access
    FROM session_registrations r
    LEFT JOIN users u ON u.id = COALESCE(r.user_id, (SELECT x.id FROM users x WHERE x.email = r.email))
    WHERE r.session_id = ?
    ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'waitlist' THEN 1 WHEN 'confirmed' THEN 2 WHEN 'paid' THEN 3 WHEN 'attended' THEN 4 ELSE 5 END, r.created_at`)
    .bind(c.req.param("id")).all();
  return c.json({ session, registrations: rows.results });
});

/** Excel-friendly CSV (UTF-8 BOM) of a session's registrations. */
adminSiteRouter.get("/sessions/:id/registrations.csv", async (c) => {
  const session = await c.env.DB.prepare("SELECT id, title, start_date FROM training_sessions WHERE id = ?")
    .bind(c.req.param("id")).first<{ id: string; title: string; start_date: string }>();
  if (!session) return c.json({ error: "ไม่พบรอบอบรม" }, 404);
  const rows = await c.env.DB.prepare("SELECT * FROM session_registrations WHERE session_id = ? ORDER BY created_at")
    .bind(session.id).all<Record<string, any>>();
  // Quote every cell and neutralise spreadsheet formulas from visitor input.
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = ["ลำดับ", "ชื่อ-นามสกุล", "อีเมล", "โทร", "บริษัท", "จำนวนคน", "สถานะ", "ใบกำกับภาษี", "เลขผู้เสียภาษี",
    "ที่อยู่ออกใบกำกับ", "เลขอ้างอิงชำระเงิน", "หมายเหตุผู้สมัคร", "หมายเหตุเจ้าหน้าที่", "ช่องทาง", "วันที่สมัคร"];
  const lines = rows.results.map((r, i) => [i + 1, r.name, r.email, r.phone, r.company, r.attendees, STATUS_LABEL[r.status] || r.status,
    r.invoice_required ? "ต้องการ" : "", r.tax_id, r.billing_address, r.payment_ref, r.note, r.admin_note,
    r.source === "admin" ? "เจ้าหน้าที่เพิ่ม" : "เว็บไซต์", r.created_at].map(cell).join(","));
  const csv = "﻿" + [header.map(cell).join(","), ...lines].join("\r\n");
  const filename = `registrations-${session.start_date}-${session.id}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
});

/** Coordinators add phone/email registrations themselves; capacity rules still apply. */
adminSiteRouter.post("/sessions/:id/registrations", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { values, error } = parseFields(body, {
    ...REGISTRATION_SPEC,
    status: { kind: ["pending", "confirmed", "paid", "waitlist"], label: "สถานะ", required: true, default: "confirmed" },
    admin_note: { kind: "text", label: "หมายเหตุเจ้าหน้าที่", max: 1000 }
  });
  const problem = error || registrationCrossCheck(values);
  if (problem) return c.json({ error: problem }, 400);
  const session = await c.env.DB.prepare("SELECT id FROM training_sessions WHERE id = ?").bind(c.req.param("id")).first<{ id: string }>();
  if (!session) return c.json({ error: "ไม่พบรอบอบรม" }, 404);
  let created;
  try {
    created = await insertRegistration(c.env.DB, session.id, values, values.status, "admin");
  } catch (err) {
    if (uniqueViolation(err)) return c.json({ error: "อีเมลนี้ลงทะเบียนรอบนี้ไว้แล้ว" }, 409);
    throw err;
  }
  if (!created) return c.json({ error: "ที่นั่งไม่พอ เลือกสถานะ 'รอคิว' หรือเพิ่มจำนวนที่นั่งของรอบนี้ก่อน" }, 409);
  if (values.admin_note) {
    await c.env.DB.prepare("UPDATE session_registrations SET admin_note = ? WHERE id = ?").bind(values.admin_note, created.id).run();
  }
  await linkRegistration(c.env.DB, created.id);
  const access = await grantCourseAccess(c.env.DB, created.id);
  await audit(c, "create", "registration", created.id, { session_id: session.id, status: created.status, course_access: access ?? undefined });
  return c.json({ registration: created, course_access: access }, 201);
});

const REGISTRATION_UPDATE_SPEC: Record<string, FieldSpec> = {
  ...REGISTRATION_SPEC,
  status: { kind: REG_STATUSES, label: "สถานะ", required: true },
  payment_ref: { kind: "text", label: "เลขอ้างอิงชำระเงิน", max: 120 },
  admin_note: { kind: "text", label: "หมายเหตุเจ้าหน้าที่", max: 1000 }
};

adminSiteRouter.patch("/registrations/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const existing = await db.prepare(`SELECT r.*, s.title AS session_title, s.start_date, s.end_date, s.time_text, s.location, s.price
    FROM session_registrations r JOIN training_sessions s ON s.id = r.session_id WHERE r.id = ?`).bind(id).first<Record<string, any>>();
  if (!existing) return c.json({ error: "ไม่พบผู้ลงทะเบียน" }, 404);
  const { values, error } = parseFields(body, REGISTRATION_UPDATE_SPEC, true);
  const merged = { ...existing, ...values };
  const problem = error || registrationCrossCheck(merged);
  if (problem) return c.json({ error: problem }, 400);
  const keys = Object.keys(values);
  if (keys.length === 0) return c.json({ error: "ไม่มีข้อมูลที่ต้องแก้ไข" }, 400);
  if (values.tax_id) values.tax_id = values.tax_id.replace(/[\s-]/g, "");

  // When the result holds seats, the capacity check runs in the same statement as the update.
  const holds = (HOLD as readonly string[]).includes(merged.status) ? 1 : 0;
  let result;
  try {
    result = await db.prepare(`UPDATE session_registrations SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (? = 0 OR (SELECT capacity FROM training_sessions WHERE id = ?) >= ? +
        (SELECT COALESCE(SUM(attendees), 0) FROM session_registrations WHERE session_id = ? AND id != ? AND status IN (${HOLD_SQL})))`)
      .bind(...keys.map(k => values[k]), id, holds, existing.session_id, merged.attendees, existing.session_id, id).run();
  } catch (err) {
    if (uniqueViolation(err)) return c.json({ error: "อีเมลนี้ลงทะเบียนรอบนี้ไว้แล้ว" }, 409);
    throw err;
  }
  if (!result.meta.changes) return c.json({ error: "ที่นั่งไม่พอ เพิ่มจำนวนที่นั่งของรอบนี้ก่อน หรือคงไว้ในรายชื่อรอคิว" }, 409);
  await linkRegistration(db, id, values.email !== undefined && values.email !== existing.email);
  const access = await grantCourseAccess(db, id);
  await audit(c, "update", "registration", id, access ? { ...values, course_access: access } : values);

  const statusChanged = values.status && values.status !== existing.status;
  const notify = body?.notify !== false;
  if (statusChanged && notify && ["confirmed", "paid", "cancelled"].includes(values.status)) {
    const settings = await loadSettings(db);
    const titles: Record<string, string> = {
      confirmed: "ยืนยันที่นั่งอบรมของคุณแล้ว", paid: "ได้รับการชำระเงินแล้ว", cancelled: "การลงทะเบียนของคุณถูกยกเลิก"
    };
    deliverLater(c, sendEmail(merged.email, `${titles[values.status]}: ${existing.session_title}`,
      emailLayout(titles[values.status], [
        ["หลักสูตร", existing.session_title], ["วันที่", `${existing.start_date} ถึง ${existing.end_date}`],
        ["เวลา", existing.time_text], ["สถานที่", existing.location], ["จำนวนผู้เข้าอบรม", merged.attendees],
        ["เลขอ้างอิง", values.status === "paid" ? merged.payment_ref : null]
      ], settings.phone ? `<p>สอบถามเพิ่มเติม ${escapeHtml(settings.phone)}${settings.email ? ` / ${escapeHtml(settings.email)}` : ""}</p>` : ""),
      c.env.RESEND_API_KEY));
  }
  const registration = await db.prepare("SELECT * FROM session_registrations WHERE id = ?").bind(id).first();
  return c.json({ registration, course_access: access });
});

/** Issues a 7-day invitation token and emails the set-password link; returns the link. */
async function sendInvite(c: Context<Env>, userId: string, reg: { name: string; email: string; session_title: string; course_id: string | null }): Promise<string> {
  const token = await issueAccountToken(c.env.DB, userId, "invite");
  const link = appUrl(c.env, `/reset-password?token=${token}&invite=1`);
  deliverLater(c, sendEmail(reg.email, `เชิญเข้าใช้งาน NetPrime LMS: ${reg.session_title}`,
    emailLayout("บัญชีผู้เรียนของคุณพร้อมแล้ว", [["ชื่อ", reg.name], ["อีเมลสำหรับเข้าสู่ระบบ", reg.email], ["รอบอบรม", reg.session_title]],
      `<p>กดปุ่มด้านล่างเพื่อตั้งรหัสผ่าน ลิงก์ใช้ได้ 7 วันและใช้ได้ครั้งเดียว${reg.course_id ? " เมื่อยืนยันที่นั่งแล้ว คุณจะเข้าเรียนคอร์สออนไลน์ประกอบการอบรมและรับใบประกาศเมื่อเรียนจบได้จากบัญชีนี้" : ""}</p>
      <p style="text-align:center;margin:20px 0"><a href="${escapeHtml(link)}" style="background:#c2541a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold">ตั้งรหัสผ่านและเข้าสู่ระบบ</a></p>`),
    c.env.RESEND_API_KEY));
  return link;
}

/**
 * "สร้างบัญชีและส่งคำเชิญ": creates a student account for a registrant without one (the users insert
 * trigger adds the student role), links it, and emails a 7-day invitation link to set a password.
 * A registrant who already has an account is only linked.
 */
adminSiteRouter.post("/registrations/:id/invite", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const reg = await db.prepare(`SELECT r.id, r.name, r.email, r.status, r.user_id, s.title AS session_title, s.course_id
    FROM session_registrations r JOIN training_sessions s ON s.id = r.session_id WHERE r.id = ?`).bind(id)
    .first<{ id: string; name: string; email: string; status: string; user_id: string | null; session_title: string; course_id: string | null }>();
  if (!reg) return c.json({ error: "ไม่พบผู้ลงทะเบียน" }, 404);
  if (reg.status === "cancelled") return c.json({ error: "การลงทะเบียนนี้ถูกยกเลิกแล้ว" }, 400);

  await linkRegistration(db, id);
  // "Invited" = has never set a password: an unusable hash from here, or an invitation from the accounts/HR
  // screens whose links (and any reset link) were never used.
  const linked = await db.prepare(`SELECT u.id, u.status, u.last_login_at, u.password_hash,
      (EXISTS (SELECT 1 FROM account_tokens t WHERE t.user_id = u.id AND t.purpose = 'invite')
        AND NOT EXISTS (SELECT 1 FROM account_tokens t WHERE t.user_id = u.id AND t.purpose IN ('invite', 'reset')
          AND t.used_at IS NOT NULL AND t.used_at > t.created_at AND t.used_at < t.expires_at)) AS invited
    FROM session_registrations r JOIN users u ON u.id = r.user_id WHERE r.id = ?`).bind(id)
    .first<{ id: string; status: string; last_login_at: string | null; password_hash: string; invited: number }>();
  if (linked) {
    const access = await grantCourseAccess(db, id);
    // An invited account that never set a password gets a fresh link; other accounts are only linked.
    if (linked.status === "active" && !linked.last_login_at && (linked.password_hash.startsWith("pbkdf2-sha256$unusable$") || linked.invited)) {
      const link = await sendInvite(c, linked.id, reg);
      await audit(c, "invite", "registration", id, { user_id: linked.id, resend: true });
      return c.json({ message: "ส่งคำเชิญอีกครั้งแล้ว", user_id: linked.id, created: false, resent: true, course_access: access,
        ...(c.env.ALLOW_LOCAL_SEED_PASSWORDS === "true" ? { debug_url: link } : {}) });
    }
    return c.json({ message: "ผู้สมัครมีบัญชีอยู่แล้ว เชื่อมกับบัญชีเดิมให้แล้ว", user_id: linked.id, created: false, course_access: access });
  }

  const userId = "usr_" + crypto.randomUUID();
  try {
    await db.prepare("INSERT INTO users (id, email, password_hash, name, role, partner_id) VALUES (?, ?, ?, ?, 'student', NULL)")
      .bind(userId, reg.email, unusablePasswordHash(), reg.name).run();
  } catch (err) {
    // Someone signed up with this email in the meantime: link to that account instead.
    if (!uniqueViolation(err)) throw err;
    await linkRegistration(db, id, true);
    return c.json({ message: "ผู้สมัครมีบัญชีอยู่แล้ว เชื่อมกับบัญชีเดิมให้แล้ว", created: false, course_access: await grantCourseAccess(db, id) });
  }
  await db.prepare("UPDATE session_registrations SET user_id = ? WHERE email = ? AND user_id IS NULL").bind(userId, reg.email).run();
  const access = await grantCourseAccess(db, id);
  const link = await sendInvite(c, userId, reg);
  await audit(c, "invite", "registration", id, { user_id: userId, course_access: access ?? undefined });
  return c.json({
    message: "สร้างบัญชีและส่งคำเชิญทางอีเมลแล้ว", user_id: userId, created: true, course_access: access,
    ...(c.env.ALLOW_LOCAL_SEED_PASSWORDS === "true" ? { debug_url: link } : {})
  }, 201);
});

adminSiteRouter.delete("/registrations/:id", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM session_registrations WHERE id = ?").bind(c.req.param("id")).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบผู้ลงทะเบียน" }, 404);
  await audit(c, "delete", "registration", c.req.param("id"));
  return c.json({ message: "ลบรายการแล้ว" });
});

// ---------- Reminders & scheduled jobs ----------

/**
 * Daily job (jobs.ts): emails confirmed/paid registrants of sessions that start in 2 days (Asia/Bangkok).
 * Each row is claimed by setting reminder_sent_at before sending, so overlapping runs never send twice.
 */
export async function sendSessionReminders(env: Env["Bindings"]): Promise<{ sent: number; registration_ids: string[] }> {
  const db = env.DB;
  const target = new Date(Date.now() + 7 * 3600_000 + 2 * 86400_000).toISOString().slice(0, 10);
  const due = await db.prepare(`SELECT r.id FROM session_registrations r JOIN training_sessions s ON s.id = r.session_id
    WHERE s.start_date = ? AND s.status IN ('open', 'closed') AND r.status IN ('confirmed', 'paid') AND r.reminder_sent_at IS NULL
    LIMIT 500`).bind(target).all<{ id: string }>();
  if (!due.results.length) return { sent: 0, registration_ids: [] };
  const settings = await loadSettings(db);
  const sent: string[] = [];
  for (const { id } of due.results) {
    const reg = await db.prepare(`UPDATE session_registrations SET reminder_sent_at = CURRENT_TIMESTAMP
      WHERE id = ? AND reminder_sent_at IS NULL RETURNING email, attendees, user_id, session_id`).bind(id)
      .first<{ email: string; attendees: number; user_id: string | null; session_id: string }>();
    if (!reg) continue;
    const session = await db.prepare("SELECT title, start_date, end_date, time_text, location, mode, course_id FROM training_sessions WHERE id = ?")
      .bind(reg.session_id).first<Record<string, any>>();
    if (!session) continue;
    const contact = [settings.phone, settings.email].filter(Boolean).map(escapeHtml).join(" / ");
    try {
      await sendEmail(reg.email, `เตือนความจำ: ${session.title} เริ่ม ${session.start_date}`,
        emailLayout("อีก 2 วันจะถึงวันอบรมของคุณ", [
          ["หลักสูตร", session.title], ["วันที่", `${session.start_date} ถึง ${session.end_date}`], ["เวลา", session.time_text],
          ["สถานที่", session.location], ["จำนวนผู้เข้าอบรม", reg.attendees]
        ], `${reg.user_id && session.course_id ? `<p>เตรียมตัวล่วงหน้าได้ในคอร์สออนไลน์ประกอบการอบรมที่ <a href="${escapeHtml(appUrl(env, "/dashboard"))}">แดชบอร์ดของคุณ</a></p>` : ""}
          ${contact ? `<p>หากเข้าร่วมไม่ได้ กรุณาแจ้งเจ้าหน้าที่ ${contact}</p>` : ""}`),
        env.RESEND_API_KEY);
      sent.push(id);
    } catch (error) {
      // Release the claim so tomorrow's run retries this registrant.
      console.error("Reminder email failed:", error);
      await db.prepare("UPDATE session_registrations SET reminder_sent_at = NULL WHERE id = ?").bind(id).run();
    }
  }
  return { sent: sent.length, registration_ids: sent };
}

/** Runs the daily jobs now (admins; used by tests and after an outage). Same code path as the cron trigger. */
adminSiteRouter.post("/jobs/run", async (c) => {
  if (!c.get("user").roles.includes("admin")) return c.json({ error: "เฉพาะผู้ดูแลระบบเท่านั้น" }, 403);
  const { runDailyJobs } = await import("../jobs");
  const result = await runDailyJobs(c.env);
  await audit(c, "run", "jobs", null, result);
  return c.json(result);
});

// ---------- Inquiries ----------

adminSiteRouter.get("/inquiries", async (c) => {
  const status = c.req.query("status");
  const { limit, offset } = pageParams(c);
  const rows = await c.env.DB.prepare(`SELECT * FROM inquiries WHERE (? IS NULL OR status = ?)
    ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, created_at DESC LIMIT ? OFFSET ?`)
    .bind(status || null, status || null, limit, offset).all();
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE (? IS NULL OR status = ?)")
    .bind(status || null, status || null).first<{ n: number }>();
  return c.json({ inquiries: rows.results, total: total?.n ?? 0 });
});

adminSiteRouter.patch("/inquiries/:id", async (c) => {
  const { values, error } = parseFields(await c.req.json().catch(() => null), {
    status: { kind: ["new", "in_progress", "closed"], label: "สถานะ", required: true },
    admin_note: { kind: "text", label: "หมายเหตุเจ้าหน้าที่", max: 2000 }
  }, true);
  if (error) return c.json({ error }, 400);
  const keys = Object.keys(values);
  if (keys.length === 0) return c.json({ error: "ไม่มีข้อมูลที่ต้องแก้ไข" }, 400);
  const id = c.req.param("id");
  const result = await c.env.DB.prepare(`UPDATE inquiries SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(...keys.map(k => values[k]), id).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบข้อความ" }, 404);
  await audit(c, "update", "inquiry", id, values);
  return c.json({ inquiry: await c.env.DB.prepare("SELECT * FROM inquiries WHERE id = ?").bind(id).first() });
});

adminSiteRouter.delete("/inquiries/:id", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM inquiries WHERE id = ?").bind(c.req.param("id")).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบข้อความ" }, 404);
  await audit(c, "delete", "inquiry", c.req.param("id"));
  return c.json({ message: "ลบข้อความแล้ว" });
});

// ---------- Articles ----------
// Authors (articles.write) write drafts and send them for review; publishers (articles.publish)
// approve or send back; managers (articles.manage) may edit anyone's article.

const ARTICLE_SPEC: Record<string, FieldSpec> = {
  title: { kind: "text", label: "หัวข้อ", max: 200, required: true },
  slug: { kind: "text", label: "ลิงก์บทความ (slug)", max: 80 },
  category: { kind: "text", label: "หมวด", max: 40 },
  excerpt: { kind: "text", label: "คำโปรย", max: 300 },
  body: { kind: "text", label: "เนื้อหา", max: 200_000, required: true },
  content_json: { kind: "text", label: "เนื้อหาแบบบล็อก", max: 800_000 },
  cover_url: { kind: "url", label: "รูปปก", max: 500 },
  status: { kind: ["draft", "review", "published"], label: "สถานะ", required: true, default: "draft" },
  published_at: { kind: "date", label: "วันที่เผยแพร่" },
  review_note: { kind: "text", label: "หมายเหตุจากผู้ตรวจ", max: 1000 },
  notion_page_id: { kind: "text", label: "หน้า Notion ต้นทาง", max: 64 }
};
const CONTENT_KEYS = ["title", "slug", "category", "excerpt", "body", "content_json", "cover_url", "notion_page_id"];

function slugify(title: string): string {
  const ascii = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const suffix = crypto.randomUUID().slice(0, 6);
  return ascii.length >= 3 ? `${ascii}-${suffix}` : `article-${suffix}`;
}

function articleValues(values: Values, existing?: Record<string, any>): string | null {
  if (values.slug !== undefined && values.slug !== null) {
    values.slug = values.slug.toLowerCase();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(values.slug) || values.slug.length < 3) return "ลิงก์บทความใช้ได้เฉพาะ a-z, 0-9 และ - อย่างน้อย 3 ตัวอักษร";
  }
  if (values.content_json) {
    try {
      if (!Array.isArray(JSON.parse(values.content_json))) return "เนื้อหาแบบบล็อกไม่ถูกต้อง";
    } catch {
      return "เนื้อหาแบบบล็อกไม่ถูกต้อง";
    }
  }
  if (values.published_at) values.published_at = `${values.published_at} 00:00:00`;
  // Publishing without a date publishes immediately; keep the original date on later edits.
  const status = values.status ?? existing?.status;
  if (status === "published" && !values.published_at && !existing?.published_at) {
    values.published_at = new Date().toISOString().slice(0, 19).replace("T", " ");
  }
  return null;
}

async function articleAccess(c: Context<Env>) {
  const perms = await currentPermissions(c);
  return {
    user: c.get("user"),
    canWrite: perms.has("articles.write"),
    canPublish: perms.has("articles.publish"),
    canManage: perms.has("articles.manage")
  };
}

const ARTICLE_LIST_SELECT = `SELECT a.id, a.slug, a.title, a.category, a.excerpt, a.cover_url, a.status, a.published_at, a.updated_at,
  a.submitted_at, a.review_note, a.author_id, u.name AS author_name
  FROM articles a LEFT JOIN users u ON u.id = a.author_id`;

/** Users who may approve articles: admins plus roles granted articles.publish. */
async function notifyPublishers(db: D1Database, exceptUserId: string, title: string, content: string) {
  const reviewers = await db.prepare(`SELECT id FROM users u WHERE status = 'active' AND id != ? AND EXISTS (
      SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND (r.role = 'admin'
        OR r.role IN (SELECT role FROM role_permissions WHERE permission = 'articles.publish')))
    LIMIT 50`).bind(exceptUserId).all<{ id: string }>();
  await Promise.all(reviewers.results.map(r => createNotification(db, r.id, title, content)));
}

/** Why this user may not change the article's content, or null when allowed. */
function contentEditError(access: { canWrite: boolean; canPublish: boolean; canManage: boolean; isAuthor: boolean }, status: string): string | null {
  if (!access.canManage && !(access.isAuthor && (access.canWrite || access.canPublish))) return "แก้ไขเนื้อหาได้เฉพาะบทความของตัวเอง";
  if (status === "published" && !access.canPublish && !access.canManage) return "บทความนี้เผยแพร่แล้ว ผู้มีสิทธิ์เผยแพร่เท่านั้นที่แก้ไขได้";
  return null;
}

// Millisecond timestamps so two saves within the same second still differ for conflict checks.
const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f', 'now')";
const REVISIONS_KEPT = 30;
// Autosaves by the same person within this window form one editing session (one revision).
const REVISION_SESSION_MS = 5 * 60_000;

async function articleConflict(c: Context<Env>, id: string): Promise<Response> {
  const latest = await c.env.DB.prepare(`SELECT a.*, u.name AS author_name, e.name AS updated_by_name FROM articles a
    LEFT JOIN users u ON u.id = a.author_id LEFT JOIN users e ON e.id = a.updated_by WHERE a.id = ?`).bind(id).first();
  return c.json({ error: "มีคนแก้บทความนี้ระหว่างที่คุณเขียน", conflict: true, article: latest }, 409);
}

function revisionChanged(existing: Record<string, any>, values: Values): boolean {
  return (["title", "body", "content_json"] as const).some(k => values[k] !== undefined && values[k] !== existing[k]);
}

const parseUtc = (value: string) => Date.parse(value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z"));

/**
 * The version being replaced, unless it is the same person's autosave from the last few minutes
 * (then the revision taken at the start of their editing session already covers it).
 */
function revisionStatement(db: D1Database, existing: Record<string, any>, userId: string, force = false) {
  const savedBy = existing.updated_by ?? existing.author_id ?? null;
  const recent = Date.now() - parseUtc(existing.updated_at) < REVISION_SESSION_MS;
  if (!force && savedBy === userId && recent && existing.updated_by) return null;
  return db.prepare("INSERT INTO article_revisions (id, article_id, title, content_json, body, saved_by, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(newId("rev"), existing.id, existing.title, existing.content_json ?? null, existing.body, savedBy, existing.updated_at);
}

async function storeRevision(db: D1Database, articleId: string, statement: D1PreparedStatement) {
  await db.batch([
    statement,
    db.prepare(`DELETE FROM article_revisions WHERE article_id = ? AND id NOT IN
      (SELECT id FROM article_revisions WHERE article_id = ? ORDER BY saved_at DESC, rowid DESC LIMIT ${REVISIONS_KEPT})`).bind(articleId, articleId)
  ]);
}

adminSiteRouter.get("/articles", async (c) => {
  const { user, canPublish, canManage } = await articleAccess(c);
  const { limit, offset } = pageParams(c);
  const status = c.req.query("status");
  // Authors see their own articles; reviewers and managers see everyone's.
  const mineOnly = c.req.query("mine") === "1" || !(canPublish || canManage);
  const where = `WHERE (? = 0 OR a.author_id = ?) AND (? IS NULL OR a.status = ?)`;
  const filters = [mineOnly ? 1 : 0, user.id, status || null, status || null];
  const rows = await c.env.DB.prepare(`${ARTICLE_LIST_SELECT} ${where}
    ORDER BY CASE a.status WHEN 'review' THEN 0 ELSE 1 END, COALESCE(a.published_at, a.updated_at) DESC LIMIT ? OFFSET ?`)
    .bind(...filters, limit, offset).all();
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM articles a ${where}`).bind(...filters).first<{ n: number }>();
  const review = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM articles WHERE status = 'review'").first<{ n: number }>();
  return c.json({ articles: rows.results, total: total?.n ?? 0, reviewCount: canPublish || canManage ? review?.n ?? 0 : undefined });
});

adminSiteRouter.get("/articles/:id", async (c) => {
  const { user, canPublish, canManage } = await articleAccess(c);
  const article = await c.env.DB.prepare(`SELECT a.*, u.name AS author_name FROM articles a LEFT JOIN users u ON u.id = a.author_id WHERE a.id = ?`)
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!article || !(canPublish || canManage || article.author_id === user.id)) return c.json({ error: "ไม่พบบทความ" }, 404);
  return c.json({ article });
});

adminSiteRouter.post("/articles", async (c) => {
  const { user, canPublish } = await articleAccess(c);
  const { values, error } = parseFields(await c.req.json().catch(() => null), ARTICLE_SPEC);
  const problem = error || articleValues(values);
  if (problem) return c.json({ error: problem }, 400);
  if (values.status === "published" && !canPublish) return c.json({ error: "บัญชีของคุณยังเผยแพร่เองไม่ได้ กรุณาส่งตรวจ" }, 403);
  if (values.review_note && !canPublish) values.review_note = null;
  if (!values.slug) values.slug = slugify(values.title);
  const id = newId("art");
  const keys = Object.keys(ARTICLE_SPEC);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  try {
    await c.env.DB.prepare(`INSERT INTO articles (id, ${keys.join(", ")}, author_id, submitted_at, reviewed_by)
      VALUES (?, ${keys.map(() => "?").join(", ")}, ?, ?, ?)`)
      .bind(id, ...keys.map(k => values[k]), user.id, values.status === "review" ? now : null, values.status === "published" ? user.id : null).run();
  } catch (err) {
    if (uniqueViolation(err)) return c.json({ error: "ลิงก์บทความนี้ถูกใช้แล้ว" }, 409);
    throw err;
  }
  await audit(c, "create", "article", id, { title: values.title, status: values.status });
  if (values.status === "review") {
    await notifyPublishers(c.env.DB, user.id, "มีบทความรอตรวจ", `${user.name} ส่งบทความ "${values.title}" ให้ตรวจ`);
  }
  return c.json({ article: await c.env.DB.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first() }, 201);
});

adminSiteRouter.patch("/articles/:id", async (c) => {
  const { user, canWrite, canPublish, canManage } = await articleAccess(c);
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first<Record<string, any>>();
  const isAuthor = existing?.author_id === user.id;
  if (!existing || !(canPublish || canManage || isAuthor)) return c.json({ error: "ไม่พบบทความ" }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const { values, error } = parseFields(body, ARTICLE_SPEC, true);
  if (values.slug === null) delete values.slug; // Slug is required once created.
  const problem = error || articleValues(values, existing);
  if (problem) return c.json({ error: problem }, 400);
  const keys = Object.keys(values);
  if (keys.length === 0) return c.json({ error: "ไม่มีข้อมูลที่ต้องแก้ไข" }, 400);

  const changesContent = keys.some(k => CONTENT_KEYS.includes(k));
  const contentError = contentEditError({ canWrite, canPublish, canManage, isAuthor }, existing.status);
  if (changesContent && contentError) return c.json({ error: contentError }, 403);
  const nextStatus = values.status ?? existing.status;
  const publishing = nextStatus === "published" || (existing.status === "published" && nextStatus !== "published");
  if (publishing && values.status !== undefined && values.status !== existing.status && !canPublish) {
    return c.json({ error: "บัญชีของคุณยังเผยแพร่หรือยกเลิกการเผยแพร่เองไม่ได้ กรุณาส่งตรวจ" }, 403);
  }
  if (values.review_note !== undefined && !canPublish) return c.json({ error: "เฉพาะผู้ตรวจเท่านั้นที่เขียนหมายเหตุได้" }, 403);
  if (values.status === "review" && !isAuthor && !canManage) return c.json({ error: "ส่งตรวจได้เฉพาะผู้เขียน" }, 403);

  // Workflow bookkeeping.
  if (values.status === "review" && existing.status !== "review") {
    values.submitted_at = new Date().toISOString().slice(0, 19).replace("T", " ");
    if (values.review_note === undefined) values.review_note = null;
  }
  if (values.status === "published" && existing.status !== "published") values.reviewed_by = user.id;

  // Optimistic concurrency: the editor sends the updated_at it loaded; a newer save wins only when
  // the client explicitly overwrites (sends no expected_updated_at). The check is part of the UPDATE.
  const expected = typeof body?.expected_updated_at === "string" ? body.expected_updated_at : null;
  if (expected && expected !== existing.updated_at) return articleConflict(c, id);
  const revision = changesContent && revisionChanged(existing, values) ? revisionStatement(c.env.DB, existing, user.id) : null;

  const setKeys = Object.keys(values);
  let result;
  try {
    result = await c.env.DB.prepare(`UPDATE articles SET ${setKeys.map(k => `${k} = ?`).join(", ")}, updated_by = ?, updated_at = ${NOW_MS}
      WHERE id = ? AND (? IS NULL OR updated_at = ?)`)
      .bind(...setKeys.map(k => values[k]), user.id, id, expected, expected).run();
  } catch (err) {
    if (uniqueViolation(err)) return c.json({ error: "ลิงก์บทความนี้ถูกใช้แล้ว" }, 409);
    throw err;
  }
  if (!result.meta.changes) return articleConflict(c, id);
  if (revision) await storeRevision(c.env.DB, id, revision);
  await audit(c, "update", "article", id, { ...values, body: values.body ? "(changed)" : undefined, content_json: values.content_json ? "(changed)" : undefined });

  const title = values.title ?? existing.title;
  if (values.status === "review" && existing.status !== "review") {
    await notifyPublishers(c.env.DB, user.id, "มีบทความรอตรวจ", `${user.name} ส่งบทความ "${title}" ให้ตรวจ`);
  } else if (existing.author_id && existing.author_id !== user.id && values.status && values.status !== existing.status) {
    const message = values.status === "published"
      ? `บทความ "${title}" ได้รับการอนุมัติและเผยแพร่แล้ว`
      : `บทความ "${title}" ถูกส่งกลับให้แก้ไข${values.review_note ? `: ${values.review_note}` : ""}`;
    await createNotification(c.env.DB, existing.author_id, values.status === "published" ? "บทความเผยแพร่แล้ว" : "บทความถูกส่งกลับ", message);
  }
  return c.json({ article: await c.env.DB.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first() });
});

adminSiteRouter.get("/articles/:id/revisions", async (c) => {
  const { user, canPublish, canManage } = await articleAccess(c);
  const article = await c.env.DB.prepare("SELECT author_id FROM articles WHERE id = ?").bind(c.req.param("id")).first<{ author_id: string | null }>();
  if (!article || !(canPublish || canManage || article.author_id === user.id)) return c.json({ error: "ไม่พบบทความ" }, 404);
  const rows = await c.env.DB.prepare(`SELECT r.id, r.title, r.saved_at, r.saved_by, u.name AS saved_by_name, substr(r.body, 1, 280) AS excerpt, length(r.body) AS length
    FROM article_revisions r LEFT JOIN users u ON u.id = r.saved_by WHERE r.article_id = ? ORDER BY r.saved_at DESC, r.rowid DESC`)
    .bind(c.req.param("id")).all();
  return c.json({ revisions: rows.results });
});

adminSiteRouter.get("/articles/:id/revisions/:revisionId", async (c) => {
  const { user, canPublish, canManage } = await articleAccess(c);
  const row = await c.env.DB.prepare(`SELECT r.*, a.author_id, u.name AS saved_by_name FROM article_revisions r JOIN articles a ON a.id = r.article_id
    LEFT JOIN users u ON u.id = r.saved_by WHERE r.id = ? AND r.article_id = ?`).bind(c.req.param("revisionId"), c.req.param("id")).first<Record<string, any>>();
  if (!row || !(canPublish || canManage || row.author_id === user.id)) return c.json({ error: "ไม่พบฉบับที่เลือก" }, 404);
  const { author_id, ...revision } = row;
  return c.json({ revision });
});

/** Restores an older version; the current version is kept as a revision first, so a restore can be undone. */
adminSiteRouter.post("/articles/:id/restore", async (c) => {
  const { user, canWrite, canPublish, canManage } = await articleAccess(c);
  const id = c.req.param("id");
  const db = c.env.DB;
  const existing = await db.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first<Record<string, any>>();
  const isAuthor = existing?.author_id === user.id;
  if (!existing || !(canPublish || canManage || isAuthor)) return c.json({ error: "ไม่พบบทความ" }, 404);
  const denied = contentEditError({ canWrite, canPublish, canManage, isAuthor }, existing.status);
  if (denied) return c.json({ error: denied }, 403);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const revision = await db.prepare("SELECT * FROM article_revisions WHERE id = ? AND article_id = ?")
    .bind(typeof body?.revision_id === "string" ? body.revision_id : "", id).first<Record<string, any>>();
  if (!revision) return c.json({ error: "ไม่พบฉบับที่เลือก" }, 404);
  const expected = typeof body?.expected_updated_at === "string" ? body.expected_updated_at : null;
  if (expected && expected !== existing.updated_at) return articleConflict(c, id);

  const snapshot = revisionStatement(db, existing, user.id, true)!;
  const result = await db.prepare(`UPDATE articles SET title = ?, content_json = ?, body = ?, updated_by = ?, updated_at = ${NOW_MS}
    WHERE id = ? AND updated_at = ?`).bind(revision.title, revision.content_json, revision.body, user.id, id, existing.updated_at).run();
  if (!result.meta.changes) return articleConflict(c, id);
  await storeRevision(db, id, snapshot);
  await audit(c, "restore", "article", id, { revision: revision.id, saved_at: revision.saved_at });
  return c.json({ article: await db.prepare("SELECT a.*, u.name AS author_name FROM articles a LEFT JOIN users u ON u.id = a.author_id WHERE a.id = ?").bind(id).first() });
});

adminSiteRouter.delete("/articles/:id", async (c) => {
  const { user, canManage } = await articleAccess(c);
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT author_id, status FROM articles WHERE id = ?").bind(id).first<{ author_id: string | null; status: string }>();
  if (!existing) return c.json({ error: "ไม่พบบทความ" }, 404);
  if (!canManage && !(existing.author_id === user.id && existing.status !== "published")) {
    return c.json({ error: "ลบได้เฉพาะบทความของตัวเองที่ยังไม่เผยแพร่" }, 403);
  }
  await c.env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  await audit(c, "delete", "article", id);
  return c.json({ message: "ลบบทความแล้ว" });
});

/** Copies a Notion page (shared with the integration) into editor blocks; the author reviews and saves it. */
adminSiteRouter.post("/articles/import-notion", permit("articles.import_notion"), async (c) => {
  const body = await c.req.json<{ url?: unknown }>().catch(() => null);
  const pageId = typeof body?.url === "string" ? notionPageId(body.url) : null;
  if (!pageId) return c.json({ error: "ลิงก์ Notion ไม่ถูกต้อง ให้คัดลอกลิงก์ของหน้า (Copy link) มาวาง" }, 400);
  if (!c.env.NOTION_TOKEN) return c.json({ error: "ยังไม่ได้เชื่อม Notion กับระบบ ให้ผู้ดูแลตั้งค่า NOTION_TOKEN ก่อน" }, 503);
  try {
    const page = await importNotionPage(pageId, c.env.NOTION_TOKEN, async (bytes, contentType) => {
      const ext = IMAGE_TYPES[contentType]?.ext;
      if (!ext || bytes.byteLength > 5 * 1024 * 1024) return null;
      const name = `${crypto.randomUUID().replace(/-/g, "")}.${ext}`;
      await c.env.ASSETS.put(`site/${name}`, bytes, { httpMetadata: { contentType } });
      return `${new URL(c.req.url).origin}/api/public/images/${name}`;
    });
    await audit(c, "import", "article", pageId, { title: page.title, blocks: page.blocks.length, warnings: page.warnings.length });
    return c.json(page);
  } catch (err) {
    if (err instanceof NotionError) return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 502);
    throw err;
  }
});

// ---------- Promotions ----------

const PROMOTION_SPEC: Record<string, FieldSpec> = {
  title: { kind: "text", label: "ชื่อโปรโมชั่น", max: 160, required: true },
  description: { kind: "text", label: "รายละเอียด", max: 1000 },
  voucher_code: { kind: "text", label: "โค้ดส่วนลด", max: 40 },
  link_url: { kind: "url", label: "ลิงก์", max: 500 },
  image_url: { kind: "url", label: "รูปภาพ", max: 500 },
  starts_at: { kind: "date", label: "วันเริ่ม" },
  ends_at: { kind: "date", label: "วันสิ้นสุด" },
  active: { kind: "bool", label: "เปิดใช้งาน", default: 1 },
  sort_order: { kind: "int", label: "ลำดับ", min: 0, max: 1000, default: 0 }
};

function promotionCrossCheck(values: Values): string | null {
  if (values.starts_at && values.ends_at && values.ends_at < values.starts_at) return "วันสิ้นสุดต้องไม่ก่อนวันเริ่ม";
  if (values.voucher_code) values.voucher_code = values.voucher_code.toUpperCase();
  return null;
}

adminSiteRouter.get("/promotions", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM promotions ORDER BY active DESC, sort_order, created_at DESC LIMIT 200").all();
  return c.json({ promotions: rows.results });
});

adminSiteRouter.post("/promotions", async (c) => {
  const { values, error } = parseFields(await c.req.json().catch(() => null), PROMOTION_SPEC);
  const problem = error || promotionCrossCheck(values);
  if (problem) return c.json({ error: problem }, 400);
  const id = newId("promo");
  const keys = Object.keys(PROMOTION_SPEC);
  await c.env.DB.prepare(`INSERT INTO promotions (id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`)
    .bind(id, ...keys.map(k => values[k])).run();
  await audit(c, "create", "promotion", id, { title: values.title });
  return c.json({ promotion: await c.env.DB.prepare("SELECT * FROM promotions WHERE id = ?").bind(id).first() }, 201);
});

adminSiteRouter.patch("/promotions/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM promotions WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!existing) return c.json({ error: "ไม่พบโปรโมชั่น" }, 404);
  const { values, error } = parseFields(await c.req.json().catch(() => null), PROMOTION_SPEC, true);
  const problem = error || promotionCrossCheck({ ...existing, ...values });
  if (problem) return c.json({ error: problem }, 400);
  if (values.voucher_code) values.voucher_code = values.voucher_code.toUpperCase();
  const keys = Object.keys(values);
  if (keys.length === 0) return c.json({ error: "ไม่มีข้อมูลที่ต้องแก้ไข" }, 400);
  await c.env.DB.prepare(`UPDATE promotions SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(...keys.map(k => values[k]), id).run();
  await audit(c, "update", "promotion", id, values);
  return c.json({ promotion: await c.env.DB.prepare("SELECT * FROM promotions WHERE id = ?").bind(id).first() });
});

adminSiteRouter.delete("/promotions/:id", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM promotions WHERE id = ?").bind(c.req.param("id")).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบโปรโมชั่น" }, 404);
  await audit(c, "delete", "promotion", c.req.param("id"));
  return c.json({ message: "ลบโปรโมชั่นแล้ว" });
});

// ---------- Settings ----------

adminSiteRouter.get("/settings", async (c) => {
  return c.json({ settings: await loadSettings(c.env.DB) });
});

adminSiteRouter.put("/settings", async (c) => {
  const body = await c.req.json<Record<string, any>>().catch(() => null);
  const { values, error } = parseFields(body, {
    phone: { kind: "text", label: "เบอร์โทร", max: 40 },
    email: { kind: "email", label: "อีเมลติดต่อ", max: 254 },
    line: { kind: "text", label: "LINE", max: 60 },
    address: { kind: "text", label: "ที่อยู่", max: 300 },
    hours: { kind: "text", label: "เวลาทำการ", max: 80 },
    map_url: { kind: "url", label: "ลิงก์แผนที่", max: 500 },
    facebook_url: { kind: "url", label: "ลิงก์ Facebook", max: 500 },
    notify_emails: { kind: "text", label: "อีเมลรับแจ้งเตือน", max: 1000 }
  });
  if (error) return c.json({ error }, 400);
  const announcement = parseFields(body?.announcement, {
    active: { kind: "bool", label: "การแสดงประกาศ" },
    text: { kind: "text", label: "ข้อความประกาศ", max: 200 },
    link: { kind: "url", label: "ลิงก์ประกาศ", max: 500 }
  });
  if (announcement.error) return c.json({ error: announcement.error }, 400);
  if (announcement.values.active && !announcement.values.text) return c.json({ error: "กรุณากรอกข้อความประกาศ หรือปิดการแสดงประกาศ" }, 400);
  const notify = (values.notify_emails || "").split(",").map((e: string) => e.trim()).filter(Boolean);
  if (notify.length > 10 || notify.some((e: string) => !EMAIL_RE.test(e))) {
    return c.json({ error: "อีเมลรับแจ้งเตือนไม่ถูกต้อง (คั่นด้วย , สูงสุด 10 อีเมล)" }, 400);
  }
  const settings: SiteSettings = {
    ...values as Omit<SiteSettings, "announcement">,
    notify_emails: notify.join(", ") || null,
    announcement: { ...announcement.values, active: announcement.values.active === 1 } as SiteSettings["announcement"]
  };
  await c.env.DB.prepare(`INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ('site', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
    .bind(JSON.stringify(settings), c.get("user").id).run();
  await audit(c, "update", "settings", "site");
  return c.json({ settings });
});

// ---------- Homepage content & legal pages ----------
// Stored as JSON in site_settings ('home', 'legal'); the built-in content below is the default
// until a coordinator saves their own version.

const HOME_ICONS = ["video", "certificate", "building", "briefcase", "network", "cloud", "shield", "users"] as const;

interface HomeContent {
  hero: { eyebrow: string; title: string; lead: string };
  brands: Array<{ name: string; text: string; link: string | null }>;
  services: Array<{ title: string; text: string; icon: typeof HOME_ICONS[number] }>;
  faq: Array<{ q: string; a: string }>;
}

const DEFAULT_HOME: HomeContent = {
  hero: {
    eyebrow: "Network · Cloud · Security",
    title: "อบรมด้าน IT ทั้งในห้องเรียนและออนไลน์ ในที่เดียว",
    lead: "เลือกเรียนคอร์สออนไลน์ด้วยตัวเอง หรือสมัครรอบอบรมกับผู้สอน จบแล้วได้ใบประกาศนียบัตรที่ใครก็ตรวจสอบได้ออนไลน์"
  },
  brands: [
    { name: "Cisco", text: "CCNA, CCNP และ SD-WAN พร้อม Lab อุปกรณ์จริง", link: "/schedule" },
    { name: "Aruba", text: "ออกแบบและติดตั้ง Wireless องค์กร", link: "/schedule" },
    { name: "AWS", text: "เตรียมสอบ Solutions Architect และออกแบบระบบคลาวด์", link: "/courses" },
    { name: "Juniper", text: "Routing และ Switching ด้วย Junos", link: "/courses" },
    { name: "Cloudflare", text: "Workers, D1 และ R2 สำหรับนักพัฒนา", link: "/courses" },
    { name: "CompTIA", text: "Security+ และพื้นฐานความปลอดภัยไซเบอร์", link: "/schedule" }
  ],
  services: [
    { title: "เรียนออนไลน์ครบในที่เดียว", text: "วิดีโอ แบบทดสอบ บันทึกย่อตามเวลาในวิดีโอ และถามตอบกับผู้สอน", icon: "video" },
    { title: "ใบประกาศตรวจสอบได้", text: "เรียนครบทุกบทและตอบแบบทดสอบถูกอย่างน้อย 80% ได้ใบประกาศพร้อมรหัสตรวจสอบออนไลน์", icon: "certificate" },
    { title: "สำหรับองค์กร", text: "ซื้อที่นั่งให้ทีม กำหนดคอร์ส และดูความคืบหน้าของพนักงานแต่ละคน", icon: "building" },
    { title: "ฝึกงานและงานจริง", text: "สมัครฝึกงานกับบริษัทพาร์ตเนอร์ และเสนอราคางานโปรเจกต์ Outsource", icon: "briefcase" }
  ],
  faq: [
    { q: "ลงทะเบียนรอบอบรมแล้ว ชำระเงินอย่างไร", a: "เจ้าหน้าที่จะติดต่อกลับเพื่อยืนยันที่นั่ง และแจ้งวิธีชำระเงินทางโอนหรือใบแจ้งหนี้ ระบบยังไม่เก็บเงินตอนลงทะเบียน" },
    { q: "ขอใบกำกับภาษีได้ไหม", a: "ได้ ติ๊ก \"ต้องการใบกำกับภาษี\" ในฟอร์มลงทะเบียน แล้วกรอกเลขผู้เสียภาษีและที่อยู่" },
    { q: "ที่นั่งเต็มแล้วทำอย่างไร", a: "ลงชื่อรอคิวได้จากปุ่มเดิม เจ้าหน้าที่จะติดต่อเมื่อมีที่ว่าง" },
    { q: "ได้ใบประกาศนียบัตรเมื่อไร", a: "คอร์สออนไลน์: เมื่อเรียนครบทุกบทและตอบแบบทดสอบถูกอย่างน้อย 80% ผู้เข้าอบรมในห้องเรียนจะได้บัญชีและคอร์สออนไลน์ประกอบการอบรม และได้ใบประกาศเมื่อเรียนจบเช่นกัน" }
  ]
};

async function loadJsonSetting<T>(db: D1Database, key: string): Promise<{ value: Partial<T>; updated_at: string | null }> {
  const row = await db.prepare("SELECT value, updated_at FROM site_settings WHERE key = ?").bind(key).first<{ value: string; updated_at: string }>();
  if (!row) return { value: {}, updated_at: null };
  try { return { value: JSON.parse(row.value), updated_at: row.updated_at }; } catch {
    console.error(`site_settings.${key} is not valid JSON`);
    return { value: {}, updated_at: null };
  }
}

async function saveJsonSetting(c: Context<Env>, key: string, value: unknown) {
  await c.env.DB.prepare(`INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
    .bind(key, JSON.stringify(value), c.get("user").id).run();
}

async function loadHome(db: D1Database): Promise<HomeContent> {
  const { value } = await loadJsonSetting<HomeContent>(db, "home");
  // Each section falls back separately, so an older saved document still renders new sections.
  return {
    hero: { ...DEFAULT_HOME.hero, ...(value.hero || {}) },
    brands: Array.isArray(value.brands) ? value.brands : DEFAULT_HOME.brands,
    services: Array.isArray(value.services) ? value.services : DEFAULT_HOME.services,
    faq: Array.isArray(value.faq) ? value.faq : DEFAULT_HOME.faq
  };
}

/** Validates a list section; every item is parsed with the same field spec. */
function parseList(raw: unknown, label: string, max: number, spec: Record<string, FieldSpec>): { items: Values[]; error?: string } {
  if (!Array.isArray(raw)) return { items: [], error: `${label}ไม่ถูกต้อง` };
  if (raw.length > max) return { items: [], error: `${label}ใส่ได้สูงสุด ${max} รายการ` };
  const items: Values[] = [];
  for (const [i, item] of raw.entries()) {
    const { values, error } = parseFields(item, spec);
    if (error) return { items: [], error: `${label} รายการที่ ${i + 1}: ${error}` };
    items.push(values);
  }
  return { items };
}

function parseHome(body: Record<string, any> | null): { home?: HomeContent; error?: string } {
  const hero = parseFields(body?.hero, {
    eyebrow: { kind: "text", label: "ข้อความเหนือหัวข้อ", max: 60 },
    title: { kind: "text", label: "หัวข้อหลัก", max: 120, required: true },
    lead: { kind: "text", label: "คำอธิบายใต้หัวข้อ", max: 300, required: true }
  });
  if (hero.error) return { error: hero.error };
  const brands = parseList(body?.brands, "แบรนด์", 12, {
    name: { kind: "text", label: "ชื่อแบรนด์", max: 40, required: true },
    text: { kind: "text", label: "คำอธิบาย", max: 160 },
    link: { kind: "url", label: "ลิงก์", max: 500 }
  });
  if (brands.error) return { error: brands.error };
  const services = parseList(body?.services, "บริการ", 8, {
    title: { kind: "text", label: "ชื่อบริการ", max: 80, required: true },
    text: { kind: "text", label: "คำอธิบาย", max: 300, required: true },
    icon: { kind: HOME_ICONS, label: "ไอคอน", required: true, default: "network" }
  });
  if (services.error) return { error: services.error };
  const faq = parseList(body?.faq, "คำถามที่พบบ่อย", 20, {
    q: { kind: "text", label: "คำถาม", max: 200, required: true },
    a: { kind: "text", label: "คำตอบ", max: 1000, required: true }
  });
  if (faq.error) return { error: faq.error };
  return {
    home: {
      hero: { ...hero.values, eyebrow: hero.values.eyebrow ?? "" } as HomeContent["hero"],
      brands: brands.items.map(b => ({ name: b.name, text: b.text ?? "", link: b.link })),
      services: services.items as HomeContent["services"],
      faq: faq.items as HomeContent["faq"]
    }
  };
}

adminSiteRouter.get("/home", async (c) => {
  const { updated_at } = await loadJsonSetting(c.env.DB, "home");
  return c.json({ home: await loadHome(c.env.DB), defaults: DEFAULT_HOME, icons: HOME_ICONS, updated_at, is_default: !updated_at });
});

adminSiteRouter.put("/home", async (c) => {
  const { home, error } = parseHome(await c.req.json<Record<string, any>>().catch(() => null));
  if (error || !home) return c.json({ error: error || "ข้อมูลไม่ถูกต้อง" }, 400);
  await saveJsonSetting(c, "home", home);
  await audit(c, "update", "settings", "home");
  return c.json({ home });
});

const LEGAL_KEYS = ["privacy", "terms", "refund-policy"] as const;
type LegalKey = typeof LEGAL_KEYS[number];
interface LegalPage { title: string; content: string; updated_at: string | null; is_default: boolean }

const DRAFT_NOTE = "> **ร่างเอกสาร (แม่แบบ)** — เนื้อหานี้เป็นแม่แบบเริ่มต้นของระบบ ต้องให้ที่ปรึกษากฎหมายตรวจทานและแก้ข้อความในวงเล็บ [ ] ให้ตรงกับธุรกิจจริงก่อนใช้งาน";

const DEFAULT_LEGAL: Record<LegalKey, { title: string; content: string }> = {
  privacy: {
    title: "นโยบายความเป็นส่วนตัว",
    content: `${DRAFT_NOTE}

[ชื่อบริษัท] ("บริษัท") ให้ความสำคัญกับข้อมูลส่วนบุคคลของผู้เรียน ผู้เข้าอบรม และผู้ติดต่อ นโยบายนี้อธิบายการเก็บ ใช้ และเปิดเผยข้อมูลตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 (PDPA)

## ข้อมูลที่เราเก็บ

- ข้อมูลบัญชี: ชื่อ อีเมล รหัสผ่าน (เก็บแบบเข้ารหัสทางเดียว) และบทบาทในระบบ
- ข้อมูลการลงทะเบียนอบรม: ชื่อ อีเมล เบอร์โทร บริษัท จำนวนผู้เข้าอบรม และข้อมูลออกใบกำกับภาษี
- ข้อมูลการเรียน: ความคืบหน้า คะแนนแบบทดสอบ บันทึกย่อ คำถามถึงผู้สอน และใบประกาศนียบัตร
- ข้อมูลการชำระเงิน: ยอดเงิน เลขอ้างอิง และสถานะ (บริษัทไม่เก็บเลขบัตรเครดิต)
- ข้อมูลทางเทคนิค: หมายเลข IP และข้อมูลการเข้าใช้งานเพื่อความปลอดภัยของระบบ

## วัตถุประสงค์และฐานทางกฎหมาย

- ให้บริการคอร์สออนไลน์และรอบอบรมตามสัญญา (ฐานสัญญา)
- ออกใบเสร็จ ใบกำกับภาษี และเก็บหลักฐานทางบัญชี (ฐานหน้าที่ตามกฎหมาย)
- ติดต่อกลับเมื่อคุณส่งแบบฟอร์ม และส่งอีเมลเตือนก่อนวันอบรม (ฐานสัญญา/ประโยชน์โดยชอบด้วยกฎหมาย)
- ส่งข่าวสารและโปรโมชั่น เฉพาะเมื่อได้รับความยินยอม (ฐานความยินยอม)

## การเปิดเผยข้อมูล

เราเปิดเผยข้อมูลเท่าที่จำเป็นให้ผู้ให้บริการที่ทำงานแทนเรา เช่น ผู้ให้บริการคลาวด์ ระบบส่งอีเมล และผู้ให้บริการชำระเงิน และให้องค์กรต้นสังกัดเห็นความคืบหน้าการเรียนเมื่อองค์กรซื้อที่นั่งให้คุณ

## ระยะเวลาเก็บรักษา

- ข้อมูลบัญชีและการเรียน: ตลอดระยะเวลาที่มีบัญชี
- ข้อมูลการเงินและใบกำกับภาษี: [อย่างน้อย 5 ปี] ตามกฎหมายบัญชีและภาษี
- ข้อมูลใบประกาศนียบัตร: เก็บไว้เพื่อให้บุคคลภายนอกตรวจสอบความถูกต้องได้

## สิทธิของเจ้าของข้อมูล

คุณมีสิทธิขอเข้าถึง ขอรับสำเนา ขอแก้ไข ขอลบ ขอระงับ หรือคัดค้านการประมวลผลข้อมูล และถอนความยินยอมได้ ผู้ใช้ที่มีบัญชีดาวน์โหลดข้อมูลของตนเองและส่งคำขอลบบัญชีได้ที่หน้าโปรไฟล์ หรือติดต่อเจ้าหน้าที่คุ้มครองข้อมูลส่วนบุคคลด้านล่าง เราจะตอบกลับภายใน 30 วัน

## ติดต่อเรา

เจ้าหน้าที่คุ้มครองข้อมูลส่วนบุคคล (DPO): [ชื่อ] · อีเมล [dpo@example.com] · ที่อยู่ [ที่อยู่บริษัท]

ปรับปรุงล่าสุด: [วันที่]`
  },
  terms: {
    title: "ข้อกำหนดการใช้งาน",
    content: `${DRAFT_NOTE}

ข้อกำหนดนี้ใช้กับการใช้งานเว็บไซต์ ระบบเรียนออนไลน์ และการสมัครรอบอบรมของ [ชื่อบริษัท]

## บัญชีผู้ใช้

- ข้อมูลที่ใช้สมัครต้องเป็นความจริง และคุณต้องรักษารหัสผ่านไว้เป็นความลับ
- บัญชีหนึ่งใช้ได้สำหรับผู้เรียนหนึ่งคน ห้ามแบ่งปันบัญชี
- บริษัทอาจระงับบัญชีที่ละเมิดข้อกำหนดหรือใช้งานผิดวัตถุประสงค์

## เนื้อหาและลิขสิทธิ์

วิดีโอ เอกสาร แบบทดสอบ และเนื้อหาทั้งหมดเป็นลิขสิทธิ์ของบริษัทหรือผู้สอน ใช้เพื่อการเรียนส่วนตัวเท่านั้น ห้ามบันทึก ทำซ้ำ หรือเผยแพร่ต่อ

## การอบรมและใบประกาศนียบัตร

- การลงทะเบียนรอบอบรมจะสมบูรณ์เมื่อเจ้าหน้าที่ยืนยันที่นั่ง
- บริษัทอาจเลื่อนหรือยกเลิกรอบอบรมเมื่อผู้สมัครไม่ถึงจำนวนขั้นต่ำ โดยจะแจ้งล่วงหน้าและดำเนินการตามนโยบายการคืนเงิน
- ใบประกาศนียบัตรออกเมื่อผ่านเกณฑ์ของแต่ละหลักสูตร และอาจถูกเพิกถอนหากพบการทุจริต

## ข้อจำกัดความรับผิด

บริษัทพยายามให้ระบบพร้อมใช้งานตลอดเวลา แต่ไม่รับประกันว่าระบบจะไม่มีข้อผิดพลาดหรือหยุดชะงัก [ขอบเขตความรับผิดตามที่ที่ปรึกษากฎหมายกำหนด]

## กฎหมายที่ใช้บังคับ

ข้อกำหนดนี้อยู่ภายใต้กฎหมายไทย

ปรับปรุงล่าสุด: [วันที่]`
  },
  "refund-policy": {
    title: "นโยบายการคืนเงิน",
    content: `${DRAFT_NOTE}

## รอบอบรมในห้องเรียนและออนไลน์สด

- ยกเลิกก่อนวันอบรม [14] วันขึ้นไป: คืนเงินเต็มจำนวน หรือโอนสิทธิ์ไปรอบถัดไปได้
- ยกเลิกภายใน [7–13] วันก่อนวันอบรม: คืนเงิน [50%] หรือโอนสิทธิ์ไปรอบถัดไปได้หนึ่งครั้ง
- ยกเลิกน้อยกว่า [7] วัน หรือไม่มาอบรม: ไม่คืนเงิน แต่เปลี่ยนชื่อผู้เข้าอบรมได้
- บริษัทยกเลิกหรือเลื่อนรอบอบรม: คืนเงินเต็มจำนวน หรือเลือกรอบใหม่

## คอร์สออนไลน์

- ขอคืนเงินได้ภายใน [7] วันหลังชำระเงิน หากเรียนไปไม่เกิน [20%] ของบทเรียน
- คอร์สที่ได้รับใบประกาศนียบัตรแล้วไม่สามารถคืนเงินได้
- ที่นั่งที่องค์กรซื้อให้พนักงานเป็นไปตามสัญญากับองค์กรนั้น

## วิธีขอคืนเงิน

ติดต่อเจ้าหน้าที่ทางอีเมล [billing@example.com] พร้อมเลขอ้างอิงการชำระเงิน เราจะคืนเงินผ่านช่องทางเดิมภายใน [30] วันหลังอนุมัติ

ปรับปรุงล่าสุด: [วันที่]`
  }
};

async function loadLegal(db: D1Database): Promise<Record<LegalKey, LegalPage>> {
  const { value } = await loadJsonSetting<Record<LegalKey, { title: string; content: string; updated_at: string }>>(db, "legal");
  return Object.fromEntries(LEGAL_KEYS.map(key => {
    const saved = value[key];
    return [key, saved?.content
      ? { title: saved.title || DEFAULT_LEGAL[key].title, content: saved.content, updated_at: saved.updated_at ?? null, is_default: false }
      : { ...DEFAULT_LEGAL[key], updated_at: null, is_default: true }];
  })) as Record<LegalKey, LegalPage>;
}

adminSiteRouter.get("/legal", async (c) => {
  return c.json({ pages: await loadLegal(c.env.DB), defaults: DEFAULT_LEGAL });
});

adminSiteRouter.put("/legal/:key", async (c) => {
  const key = c.req.param("key") as LegalKey;
  if (!LEGAL_KEYS.includes(key)) return c.json({ error: "ไม่พบหน้านี้" }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  // reset=true goes back to the built-in draft template.
  const { value } = await loadJsonSetting<Record<string, unknown>>(c.env.DB, "legal");
  if (body?.reset === true) {
    delete value[key];
  } else {
    const { values, error } = parseFields(body, {
      title: { kind: "text", label: "ชื่อหน้า", max: 120, required: true },
      content: { kind: "text", label: "เนื้อหา", max: 50_000, required: true }
    });
    if (error) return c.json({ error }, 400);
    value[key] = { title: values.title, content: values.content, updated_at: new Date().toISOString() };
  }
  await saveJsonSetting(c, "legal", value);
  await audit(c, body?.reset === true ? "reset" : "update", "settings", `legal:${key}`);
  return c.json({ page: { key, ...(await loadLegal(c.env.DB))[key] } });
});

// ---------- Images & audit ----------

const IMAGE_TYPES: Record<string, { ext: string; magic: number[] }> = {
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/gif": { ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
  "image/webp": { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] }
};

adminSiteRouter.post("/images", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File)) return c.json({ error: "กรุณาเลือกไฟล์รูปภาพ" }, 400);
  const type = IMAGE_TYPES[file.type];
  if (!type) return c.json({ error: "รองรับเฉพาะไฟล์ PNG, JPG, WEBP หรือ GIF" }, 400);
  if (file.size > 5 * 1024 * 1024) return c.json({ error: "ไฟล์รูปต้องไม่เกิน 5 MB" }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!type.magic.every((byte, i) => bytes[i] === byte)) return c.json({ error: "ไฟล์ไม่ใช่รูปภาพตามชนิดที่ระบุ" }, 400);
  const name = `${crypto.randomUUID().replace(/-/g, "")}.${type.ext}`;
  await c.env.ASSETS.put(`site/${name}`, bytes, { httpMetadata: { contentType: file.type } });
  await audit(c, "upload", "image", name, { size: file.size });
  return c.json({ url: `${new URL(c.req.url).origin}/api/public/images/${name}` }, 201);
});

adminSiteRouter.get("/audit", async (c) => {
  const { limit, offset } = pageParams(c, 50, 200);
  const rows = await c.env.DB.prepare(`SELECT l.*, u.name AS user_name FROM admin_audit_log l LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.created_at DESC LIMIT ? OFFSET ?`).bind(limit, offset).all();
  return c.json({ entries: rows.results });
});
