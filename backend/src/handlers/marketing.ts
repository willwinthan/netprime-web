import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { permit } from "../utils/permissions";
import { appUrl, escapeHtml, sendEmail } from "../utils/email";
import { clientIp, rateLimited, tooManyRequests } from "../utils/ratelimit";
import { trackEvent } from "../utils/events";

/**
 * Marketing (v0.5): public course sales pages, affiliates/referrals, first-touch signup attribution (UTM),
 * lead forms + popups, tracking pixel settings, course reviews and bulk voucher campaigns.
 *
 * Public routes:   /api/public/marketing/*   (no sign-in; validated, rate limited, Turnstile when configured)
 * Learner routes:  /api/marketing/*          (signed in)
 * Staff routes:    /api/marketing/admin/*    (marketing.manage)
 */
export const marketingRouter = new Hono<Env>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

type Row = Record<string, any>;

// ==========================================
// Small helpers
// ==========================================

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function randomCode(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

async function readBody(c: Context<Env>): Promise<Row | null> {
  const body = await c.req.json<Row>().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
}

/** Trimmed string up to `max` characters with control characters removed; null when empty. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return clean ? clean.slice(0, max) : null;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function pageParams(c: Context<Env>, defaultLimit = 50, maxLimit = 200) {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || String(defaultLimit), 10) || defaultLimit, 1), maxLimit);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);
  return { limit, offset };
}

function validDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Only https links (promo videos, etc.). */
function safeHttps(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

/** Public display name: first name + initial of the last name ("Emma W."). */
function displayName(name: string | null | undefined): string {
  const parts = String(name || "").replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "ผู้เรียน";
  return parts.length > 1 ? `${parts[0]} ${parts[1].charAt(0)}.` : parts[0];
}

/** Quote every cell and neutralise spreadsheet formulas from visitor input. */
function csvCell(value: unknown): string {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function csvResponse(filename: string, header: string[], rows: unknown[][]): Response {
  const csv = "﻿" + [header.map(csvCell).join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function deliverLater(c: Context<Env>, task: Promise<unknown>) {
  const guarded = task.catch(error => console.error("Marketing email delivery failed:", error));
  try { c.executionCtx.waitUntil(guarded); } catch { /* No execution context: fire and forget. */ }
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

/** Same bot checks as the website forms: hidden honeypot field + Cloudflare Turnstile when configured. */
async function botCheck(c: Context<Env>, body: Row): Promise<string | null> {
  if (typeof body.website === "string" && body.website.trim() !== "") return "ไม่สามารถส่งข้อมูลได้";
  const secret = c.env.TURNSTILE_SECRET_KEY;
  if (!secret) return null;
  const token = body.turnstile_token;
  if (typeof token !== "string" || !token) return "กรุณายืนยันว่าไม่ใช่บอท";
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: c.req.header("CF-Connecting-IP") || "" })
    });
    const result = await res.json().catch(() => ({})) as { success?: boolean };
    return result.success ? null : "การยืนยันตัวตนไม่ผ่าน กรุณาลองใหม่";
  } catch {
    return "การยืนยันตัวตนไม่ผ่าน กรุณาลองใหม่";
  }
}

async function siteNotifyEmails(db: D1Database): Promise<string[]> {
  const row = await db.prepare("SELECT value FROM site_settings WHERE key = 'site'").first<{ value: string }>();
  const settings = parseJson<{ notify_emails?: string }>(row?.value, {});
  return splitEmails(settings.notify_emails);
}

function splitEmails(raw: unknown): string[] {
  return String(raw || "").split(",").map(e => e.trim().toLowerCase()).filter(e => EMAIL_RE.test(e)).slice(0, 10);
}

function emailLayout(title: string, rows: Array<[string, unknown]>): string {
  const table = rows.filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0">${escapeHtml(v)}</td></tr>`).join("");
  return `<div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #eaeaea;padding:20px;border-radius:10px">
    <h2 style="color:#e56b25;margin-top:0">${escapeHtml(title)}</h2>
    <table style="border-collapse:collapse;font-size:14px">${table}</table>
    <p style="color:#94a3b8;font-size:12px;border-top:1px solid #eaeaea;padding-top:10px;margin-top:20px">NetPrime Training Center</p>
  </div>`;
}

const staffOnly = [rbac(), permit("marketing.manage")] as const;
marketingRouter.use("/marketing/admin", ...staffOnly);
marketingRouter.use("/marketing/admin/*", ...staffOnly);

// ==========================================
// 1. Public course sales pages
// ==========================================

/** Optional sales-page columns (added by the content workstream); the first present name wins. */
const SALES_FIELDS: Record<string, string[]> = {
  slug: ["slug"],
  subtitle: ["subtitle", "tagline"],
  learning_outcomes: ["learning_outcomes", "what_you_will_learn", "what_you_learn", "outcomes"],
  requirements: ["requirements", "prerequisites"],
  audience: ["target_audience", "audience", "who_for"],
  level: ["level"],
  language: ["language"],
  duration_hours: ["duration_hours"],
  promo_video_url: ["promo_video_url", "promo_video", "trailer_url"],
  faq: ["faq", "faq_json"]
};
const LIST_FIELDS = new Set(["learning_outcomes", "requirements", "audience"]);

function listValue(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(v => String(v ?? "").trim()).filter(Boolean).slice(0, 30);
  if (typeof raw !== "string" || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const parsed = parseJson<unknown>(trimmed, null);
    if (Array.isArray(parsed)) return listValue(parsed);
  }
  return trimmed.split(/\r?\n/).map(line => line.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean).slice(0, 30);
}

function faqValue(raw: unknown): Array<{ question: string; answer: string }> {
  const parsed = typeof raw === "string" ? parseJson<unknown>(raw, null) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item: any) => ({
    question: String(item?.question ?? item?.q ?? "").trim(),
    answer: String(item?.answer ?? item?.a ?? "").trim()
  })).filter(item => item.question && item.answer).slice(0, 30);
}

function salesFields(row: Row): Row {
  const out: Row = {};
  for (const [key, names] of Object.entries(SALES_FIELDS)) {
    const name = names.find(n => row[n] !== undefined && row[n] !== null && row[n] !== "");
    const raw = name ? row[name] : null;
    if (LIST_FIELDS.has(key)) out[key] = listValue(raw);
    else if (key === "faq") out[key] = faqValue(raw);
    else if (key === "promo_video_url") out[key] = safeHttps(raw);
    else if (key === "duration_hours") out[key] = raw === null || raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);
    else out[key] = raw === null || raw === undefined ? null : String(raw);
  }
  return out;
}

/** Published course by id or slug (slug only when that column exists). */
async function findPublishedCourse(db: D1Database, idOrSlug: string): Promise<Row | null> {
  const select = `SELECT c.*, u.name AS instructor_name FROM courses c LEFT JOIN users u ON u.id = c.instructor_id`;
  const byId = await db.prepare(`${select} WHERE c.id = ? AND c.status = 'published'`).bind(idOrSlug).first<Row>();
  if (byId) return byId;
  try {
    return await db.prepare(`${select} WHERE c.slug = ? AND c.status = 'published'`).bind(idOrSlug).first<Row>() ?? null;
  } catch {
    return null; // No slug column yet.
  }
}

async function courseRating(db: D1Database, courseId: string): Promise<{ average: number | null; count: number }> {
  const row = await db.prepare(`SELECT AVG(rating) AS average, COUNT(*) AS count FROM course_reviews WHERE course_id = ? AND status = 'approved'`)
    .bind(courseId).first<{ average: number | null; count: number }>();
  return { average: row?.count ? Math.round(row.average! * 10) / 10 : null, count: row?.count ?? 0 };
}

async function approvedReviews(db: D1Database, courseId: string, limit: number, offset: number) {
  const rows = await db.prepare(`SELECT r.id, r.rating, r.body, r.created_at, r.updated_at, u.name AS user_name
    FROM course_reviews r JOIN users u ON u.id = r.user_id
    WHERE r.course_id = ? AND r.status = 'approved' ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`)
    .bind(courseId, limit, offset).all<Row>();
  return rows.results.map(r => ({ id: r.id, rating: r.rating, body: r.body, created_at: r.updated_at || r.created_at, reviewer: displayName(r.user_name) }));
}

/**
 * Sales page data: course facts, sales fields when present, curriculum outline (titles only),
 * instructor, rating + approved reviews, and upcoming training sessions for the course.
 * GET /api/public/marketing/courses/:id   (id or slug)
 */
marketingRouter.get("/public/marketing/courses/:id", async (c) => {
  const db = c.env.DB;
  const row = await findPublishedCourse(db, c.req.param("id"));
  if (!row) return c.json({ error: "ไม่พบคอร์สนี้" }, 404);

  const lessons = await db.prepare("SELECT * FROM lessons WHERE course_id = ? ORDER BY sort_order ASC").bind(row.id).all<Row>();
  let sections: Array<{ id: string; title: string }> = [];
  try {
    const result = await db.prepare("SELECT id, title FROM course_sections WHERE course_id = ? ORDER BY sort_order ASC").bind(row.id).all<{ id: string; title: string }>();
    sections = result.results;
  } catch { /* Course sections are optional (content workstream). */ }
  const sectionIds = new Set(sections.map(s => s.id));
  const outline = [
    ...sections.map(s => ({ title: s.title, lessons: lessons.results.filter(l => l.section_id === s.id).map(l => ({ title: l.title })) })),
  ];
  const loose = lessons.results.filter(l => !l.section_id || !sectionIds.has(l.section_id)).map(l => ({ title: l.title }));
  if (loose.length) outline.push({ title: sections.length ? "บทเรียนเพิ่มเติม" : "เนื้อหาคอร์ส", lessons: loose });

  let category: { name: string; slug: string } | null = null;
  if (row.category_id) {
    category = await db.prepare("SELECT name, slug FROM course_categories WHERE id = ?").bind(row.category_id).first<{ name: string; slug: string }>() ?? null;
  }
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const sessions = await db.prepare(`SELECT s.id, s.title, s.start_date, s.end_date, s.time_text, s.mode, s.location, s.price, s.capacity,
      s.registration_deadline, s.status,
      (SELECT COALESCE(SUM(attendees), 0) FROM session_registrations r WHERE r.session_id = s.id AND r.status IN ('pending','confirmed','paid','attended')) AS seats_taken
    FROM training_sessions s WHERE s.course_id = ? AND s.status = 'open' AND s.end_date >= ? ORDER BY s.start_date LIMIT 6`)
    .bind(row.id, today).all<Row>();

  const rating = await courseRating(db, row.id);
  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    course: {
      id: row.id, title: row.title, description: row.description, price: row.price, cover_image_url: row.cover_image_url,
      access_duration_days: row.access_duration_days, published_at: row.published_at, lesson_count: lessons.results.length,
      category, instructor: { name: row.instructor_name || "ทีมผู้สอน NetPrime" },
      ...salesFields(row)
    },
    outline,
    rating,
    reviews: await approvedReviews(db, row.id, 10, 0),
    sessions: sessions.results.map(s => {
      const deadline = s.registration_deadline || s.start_date;
      const seatsLeft = Math.max(0, s.capacity - s.seats_taken);
      return {
        id: s.id, title: s.title, start_date: s.start_date, end_date: s.end_date, time_text: s.time_text, mode: s.mode,
        location: s.location, price: s.price, registration_deadline: deadline, seats_left: seatsLeft,
        registration_open: deadline >= today, waitlist: deadline >= today && seatsLeft === 0
      };
    })
  });
});

/** GET /api/public/marketing/courses/:id/reviews?limit&offset */
marketingRouter.get("/public/marketing/courses/:id/reviews", async (c) => {
  const row = await findPublishedCourse(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "ไม่พบคอร์สนี้" }, 404);
  const { limit, offset } = pageParams(c, 10, 50);
  return c.json({ rating: await courseRating(c.env.DB, row.id), reviews: await approvedReviews(c.env.DB, row.id, limit, offset) });
});

/** Average rating of every published course, for course cards. GET /api/public/marketing/ratings */
marketingRouter.get("/public/marketing/ratings", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT r.course_id, AVG(r.rating) AS average, COUNT(*) AS count
    FROM course_reviews r JOIN courses c ON c.id = r.course_id AND c.status = 'published'
    WHERE r.status = 'approved' GROUP BY r.course_id`).all<{ course_id: string; average: number; count: number }>();
  const ratings: Record<string, { average: number; count: number }> = {};
  for (const r of rows.results) ratings[r.course_id] = { average: Math.round(r.average * 10) / 10, count: r.count };
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ ratings });
});

// ==========================================
// 4. Tracking settings + public runtime config (ids and popups only)
// ==========================================

export const TRACKING_PATTERNS = {
  ga4_id: { re: /^G-[A-Z0-9]{4,15}$/, label: "Google Analytics 4 Measurement ID (เช่น G-ABC123XYZ)" },
  gtm_id: { re: /^GTM-[A-Z0-9]{4,10}$/, label: "Google Tag Manager ID (เช่น GTM-ABCD123)" },
  meta_pixel_id: { re: /^\d{8,20}$/, label: "Meta Pixel ID (ตัวเลข 8–20 หลัก)" },
  tiktok_pixel_id: { re: /^[A-Z0-9]{15,25}$/, label: "TikTok Pixel ID (ตัวอักษรพิมพ์ใหญ่และตัวเลข 15–25 ตัว)" }
} as const;
type TrackingKey = keyof typeof TRACKING_PATTERNS;
type TrackingSettings = Record<TrackingKey, string | null>;

async function loadTracking(db: D1Database): Promise<TrackingSettings & { updated_at: string | null }> {
  const row = await db.prepare("SELECT value, updated_at FROM site_settings WHERE key = 'marketing_tracking'").first<{ value: string; updated_at: string }>();
  const stored = parseJson<Partial<TrackingSettings>>(row?.value, {});
  const out = { updated_at: row?.updated_at ?? null } as TrackingSettings & { updated_at: string | null };
  for (const key of Object.keys(TRACKING_PATTERNS) as TrackingKey[]) {
    const value = stored[key];
    // Never expose a stored value that does not match the pattern (defence in depth).
    out[key] = typeof value === "string" && TRACKING_PATTERNS[key].re.test(value) ? value : null;
  }
  return out;
}

marketingRouter.get("/marketing/admin/tracking", async (c) => c.json({ tracking: await loadTracking(c.env.DB) }));

/** PUT /api/marketing/admin/tracking { ga4_id, gtm_id, meta_pixel_id, tiktok_pixel_id } (empty = off) */
marketingRouter.put("/marketing/admin/tracking", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const value: Partial<TrackingSettings> = {};
  for (const [key, spec] of Object.entries(TRACKING_PATTERNS) as Array<[TrackingKey, typeof TRACKING_PATTERNS[TrackingKey]]>) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") { value[key] = null; continue; }
    if (typeof raw !== "string") return c.json({ error: `${spec.label} ไม่ถูกต้อง` }, 400);
    const id = raw.trim().toUpperCase();
    if (!spec.re.test(id)) return c.json({ error: `${spec.label} ไม่ถูกต้อง` }, 400);
    value[key] = id;
  }
  // A GTM container runs arbitrary JavaScript on the site, so only admins may set or change it;
  // marketing.manage keeps the GA4 / Meta / TikTok pixel ids. Non-admins keep the stored container as is.
  const current = await loadTracking(c.env.DB);
  if ((value.gtm_id ?? null) !== current.gtm_id && !c.get("user").roles.includes("admin")) {
    if (body.gtm_id !== undefined) return c.json({ error: "การตั้งค่า Google Tag Manager ทำได้เฉพาะผู้ดูแลระบบ" }, 403);
    value.gtm_id = current.gtm_id;
  }
  await c.env.DB.prepare(`INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ('marketing_tracking', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
    .bind(JSON.stringify(value), c.get("user").id).run();
  await audit(c, "update", "marketing_tracking", null, value);
  return c.json({ tracking: await loadTracking(c.env.DB) });
});

/**
 * Runtime config for the public site: tracking ids (nothing else) and active popups.
 * GET /api/public/marketing/config
 */
marketingRouter.get("/public/marketing/config", async (c) => {
  const tracking = await loadTracking(c.env.DB);
  const forms = await c.env.DB.prepare("SELECT * FROM lead_forms WHERE active = 1 AND popup_json IS NOT NULL ORDER BY updated_at DESC LIMIT 20").all<Row>();
  const popups = forms.results.map(publicForm).filter(f => f.popup?.enabled);
  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    tracking: { ga4_id: tracking.ga4_id, gtm_id: tracking.gtm_id, meta_pixel_id: tracking.meta_pixel_id, tiktok_pixel_id: tracking.tiktok_pixel_id },
    popups
  });
});

// ==========================================
// 3. Lead forms, popups and leads
// ==========================================

const BUILTIN_FIELDS: Record<string, { label: string; type: FieldType }> = {
  name: { label: "ชื่อ-นามสกุล", type: "text" },
  email: { label: "อีเมล", type: "email" },
  phone: { label: "เบอร์โทร", type: "tel" },
  company: { label: "บริษัท / หน่วยงาน", type: "text" }
};
const FIELD_TYPES = ["text", "email", "tel", "textarea", "select", "checkbox"] as const;
type FieldType = typeof FIELD_TYPES[number];
interface FormField { key: string; label: string; type: FieldType; required: boolean; options?: string[] }
interface PopupConfig {
  enabled: boolean; trigger: "delay" | "scroll" | "exit"; delay_seconds: number; scroll_percent: number; frequency_days: number; pages: string[];
}
const DEFAULT_CONSENT = "ยินยอมให้ NetPrime เก็บและใช้ข้อมูลนี้เพื่อติดต่อกลับและส่งข่าวสารการอบรม ตามนโยบายความเป็นส่วนตัว (ยกเลิกได้ทุกเมื่อ)";

function parseFieldList(raw: unknown): { fields?: FormField[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "กรุณาเพิ่มช่องในฟอร์มอย่างน้อย 1 ช่อง" };
  if (raw.length > 12) return { error: "ฟอร์มมีได้ไม่เกิน 12 ช่อง" };
  const fields: FormField[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const key = typeof item?.key === "string" ? item.key.trim() : "";
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) return { error: "รหัสช่องต้องเป็นตัวอักษรภาษาอังกฤษพิมพ์เล็ก ตัวเลข หรือ _" };
    if (seen.has(key)) return { error: `รหัสช่อง ${key} ซ้ำกัน` };
    seen.add(key);
    const builtin = BUILTIN_FIELDS[key];
    const type = (builtin?.type ?? item?.type) as FieldType;
    if (!FIELD_TYPES.includes(type)) return { error: `ประเภทของช่อง ${key} ไม่ถูกต้อง` };
    const label = text(item?.label, 120) || builtin?.label;
    if (!label) return { error: `กรุณาตั้งชื่อช่อง ${key}` };
    const field: FormField = { key, label, type, required: key === "email" || bool(item?.required) };
    if (type === "select") {
      const options = Array.isArray(item?.options) ? item.options.map((o: unknown) => text(o, 100)).filter(Boolean) as string[] : [];
      if (options.length < 1 || options.length > 20) return { error: `ช่อง ${label} ต้องมีตัวเลือก 1–20 รายการ` };
      field.options = [...new Set(options)];
    }
    fields.push(field);
  }
  if (!seen.has("email")) fields.unshift({ key: "email", label: BUILTIN_FIELDS.email.label, type: "email", required: true });
  return { fields };
}

function parsePopup(raw: unknown): { popup?: PopupConfig | null; error?: string } {
  if (raw === null || raw === undefined) return { popup: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "การตั้งค่า popup ไม่ถูกต้อง" };
  const p = raw as Row;
  const trigger = p.trigger ?? "delay";
  if (!["delay", "scroll", "exit"].includes(trigger)) return { error: "เงื่อนไขการแสดง popup ไม่ถูกต้อง" };
  const int = (value: unknown, def: number, min: number, max: number, label: string): number | string => {
    if (value === undefined || value === null || value === "") return def;
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : `${label}ต้องเป็นจำนวนเต็ม ${min}–${max}`;
  };
  const delay = int(p.delay_seconds, 5, 0, 600, "เวลาหน่วง (วินาที) ");
  const scroll = int(p.scroll_percent, 50, 1, 100, "เปอร์เซ็นต์การเลื่อนหน้า ");
  const frequency = int(p.frequency_days, 7, 0, 365, "ความถี่ (วัน) ");
  for (const v of [delay, scroll, frequency]) if (typeof v === "string") return { error: v };
  const pages = Array.isArray(p.pages) ? p.pages : [];
  if (pages.length > 20) return { error: "ระบุหน้าที่แสดง popup ได้ไม่เกิน 20 รายการ" };
  const cleanPages: string[] = [];
  for (const page of pages) {
    const value = text(page, 200);
    if (!value) continue;
    if (!/^\/[A-Za-z0-9\-._~/%]*\*?$/.test(value)) return { error: "หน้าที่แสดง popup ต้องขึ้นต้นด้วย / เช่น /courses หรือ /blog/*" };
    cleanPages.push(value);
  }
  return { popup: { enabled: bool(p.enabled), trigger, delay_seconds: delay as number, scroll_percent: scroll as number, frequency_days: frequency as number, pages: cleanPages } };
}

function parseFormBody(body: Row, existing?: Row): { values?: Row; error?: string } {
  const merged = { ...(existing ?? {}), ...body };
  const name = text(merged.name, 120);
  if (!name) return { error: "กรุณาตั้งชื่อฟอร์ม" };
  const title = text(merged.title, 160) || name;
  const fieldsSource = body.fields !== undefined ? body.fields : parseJson(existing?.fields_json, []);
  const { fields, error } = parseFieldList(fieldsSource);
  if (error) return { error };
  const popupSource = body.popup !== undefined ? body.popup : parseJson(existing?.popup_json, null);
  const popup = parsePopup(popupSource);
  if (popup.error) return { error: popup.error };
  const autoTag = text(merged.auto_tag, 40);
  if (autoTag && !/^[\p{L}\p{N}_\- ]+$/u.test(autoTag)) return { error: "แท็กอัตโนมัติใช้ได้เฉพาะตัวอักษร ตัวเลข ช่องว่าง - และ _" };
  const notify = text(merged.notify_emails, 500);
  if (notify && splitEmails(notify).length !== notify.split(",").filter(e => e.trim()).length) return { error: "อีเมลแจ้งเตือนไม่ถูกต้อง (คั่นหลายอีเมลด้วย ,)" };
  return {
    values: {
      name, title, description: text(merged.description, 1000), fields_json: JSON.stringify(fields),
      submit_label: text(merged.submit_label, 60), success_message: text(merged.success_message, 300),
      consent_text: text(merged.consent_text, 500), auto_tag: autoTag, notify_emails: notify,
      popup_json: popup.popup ? JSON.stringify(popup.popup) : null,
      active: merged.active === undefined ? 1 : bool(merged.active) ? 1 : 0
    }
  };
}

/** Form fields visitors see (no notification recipients, tags or internal names). */
function publicForm(row: Row) {
  return {
    id: row.id, title: row.title, description: row.description,
    fields: parseJson<FormField[]>(row.fields_json, []),
    submit_label: row.submit_label || "ส่งข้อมูล",
    success_message: row.success_message || "ขอบคุณ เราได้รับข้อมูลแล้ว เจ้าหน้าที่จะติดต่อกลับโดยเร็ว",
    consent_text: row.consent_text || DEFAULT_CONSENT,
    popup: parseJson<PopupConfig | null>(row.popup_json, null)
  };
}

function adminForm(row: Row) {
  return { ...publicForm(row), name: row.name, auto_tag: row.auto_tag, notify_emails: row.notify_emails, active: !!row.active,
    lead_count: row.lead_count ?? 0, created_at: row.created_at, updated_at: row.updated_at };
}

marketingRouter.get("/marketing/admin/forms", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT f.*, (SELECT COUNT(*) FROM leads l WHERE l.form_id = f.id) AS lead_count
    FROM lead_forms f ORDER BY f.created_at DESC`).all<Row>();
  return c.json({ forms: rows.results.map(adminForm) });
});

marketingRouter.post("/marketing/admin/forms", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const { values, error } = parseFormBody(body);
  if (error || !values) return c.json({ error }, 400);
  const id = newId("form");
  await c.env.DB.prepare(`INSERT INTO lead_forms (id, name, title, description, fields_json, submit_label, success_message, consent_text,
      auto_tag, notify_emails, popup_json, active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, values.name, values.title, values.description, values.fields_json, values.submit_label, values.success_message,
      values.consent_text, values.auto_tag, values.notify_emails, values.popup_json, values.active, c.get("user").id).run();
  await audit(c, "create", "lead_form", id, { name: values.name });
  const row = await c.env.DB.prepare("SELECT * FROM lead_forms WHERE id = ?").bind(id).first<Row>();
  return c.json({ form: adminForm(row!) }, 201);
});

marketingRouter.patch("/marketing/admin/forms/:id", async (c) => {
  const existing = await c.env.DB.prepare("SELECT * FROM lead_forms WHERE id = ?").bind(c.req.param("id")).first<Row>();
  if (!existing) return c.json({ error: "ไม่พบฟอร์ม" }, 404);
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const { values, error } = parseFormBody(body, existing);
  if (error || !values) return c.json({ error }, 400);
  await c.env.DB.prepare(`UPDATE lead_forms SET name = ?, title = ?, description = ?, fields_json = ?, submit_label = ?, success_message = ?,
      consent_text = ?, auto_tag = ?, notify_emails = ?, popup_json = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(values.name, values.title, values.description, values.fields_json, values.submit_label, values.success_message,
      values.consent_text, values.auto_tag, values.notify_emails, values.popup_json, values.active, existing.id).run();
  await audit(c, "update", "lead_form", existing.id, { name: values.name, active: values.active });
  const row = await c.env.DB.prepare("SELECT * FROM lead_forms WHERE id = ?").bind(existing.id).first<Row>();
  return c.json({ form: adminForm(row!) });
});

/** Deleting a form keeps its leads (form_id becomes NULL). */
marketingRouter.delete("/marketing/admin/forms/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("UPDATE leads SET form_id = NULL WHERE form_id = ?").bind(id).run();
  const result = await c.env.DB.prepare("DELETE FROM lead_forms WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบฟอร์ม" }, 404);
  await audit(c, "delete", "lead_form", id);
  return c.json({ message: "ลบฟอร์มแล้ว ข้อมูล lead ที่ได้รับยังเก็บไว้" });
});

/** GET /api/public/marketing/forms/:id — an active form for embedding on a site page. */
marketingRouter.get("/public/marketing/forms/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM lead_forms WHERE id = ? AND active = 1").bind(c.req.param("id")).first<Row>();
  if (!row) return c.json({ error: "ไม่พบฟอร์มนี้" }, 404);
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ form: publicForm(row) });
});

const LEAD_LIMIT = 10; // submissions per IP per 10 minutes

/** Id of the signed-in caller on a public route (valid Bearer session), else null. Never rejects the request. */
async function signedInUserId(c: Context<Env>): Promise<string | null> {
  if (!c.req.header("Authorization")?.startsWith("Bearer ")) return null;
  let id: string | null = null;
  try { await rbac()(c, async () => { id = c.get("user")?.id ?? null; }); } catch { return null; }
  return id;
}

/**
 * POST /api/public/marketing/forms/:id/submit
 * { values: {name,email,phone,company,<custom>}, consent: true, page_path?, utm_*?, website (honeypot), turnstile_token? }
 */
marketingRouter.post("/public/marketing/forms/:id/submit", async (c) => {
  const db = c.env.DB;
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  if (await rateLimited(c.env.SESSIONS, "lead", clientIp(c), LEAD_LIMIT)) return tooManyRequests(c);
  const blocked = await botCheck(c, body);
  if (blocked) return c.json({ error: blocked }, 400);
  const form = await db.prepare("SELECT * FROM lead_forms WHERE id = ? AND active = 1").bind(c.req.param("id")).first<Row>();
  if (!form) return c.json({ error: "ไม่พบฟอร์มนี้ หรือฟอร์มปิดรับข้อมูลแล้ว" }, 404);
  if (body.consent !== true) return c.json({ error: "กรุณายินยอมให้เก็บและใช้ข้อมูลตามนโยบายความเป็นส่วนตัว" }, 400);

  const fields = parseJson<FormField[]>(form.fields_json, []);
  const input = (body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {}) as Row;
  const answers: Row = {};
  for (const field of fields) {
    const raw = input[field.key];
    if (field.type === "checkbox") {
      const checked = bool(raw);
      if (field.required && !checked) return c.json({ error: `กรุณาเลือก${field.label}` }, 400);
      answers[field.key] = checked;
      continue;
    }
    const value = text(raw, field.type === "textarea" ? 2000 : 200);
    if (!value) {
      if (field.required) return c.json({ error: `กรุณากรอก${field.label}` }, 400);
      continue;
    }
    if (typeof raw === "string" && raw.trim().length > (field.type === "textarea" ? 2000 : 200)) return c.json({ error: `${field.label}ยาวเกินไป` }, 400);
    if (field.type === "email" && (!EMAIL_RE.test(value) || value.length > 254)) return c.json({ error: `${field.label}ไม่ถูกต้อง` }, 400);
    if (field.type === "tel" && !/^[0-9+\-\s()]{6,30}$/.test(value)) return c.json({ error: `${field.label}ไม่ถูกต้อง` }, 400);
    if (field.type === "select" && !(field.options || []).includes(value)) return c.json({ error: `${field.label}ไม่ถูกต้อง` }, 400);
    answers[field.key] = field.type === "email" ? value.toLowerCase() : value;
  }
  const email = answers.email as string | undefined;
  if (!email) return c.json({ error: "กรุณากรอกอีเมล" }, 400);

  const custom: Row = {};
  for (const [key, value] of Object.entries(answers)) if (!BUILTIN_FIELDS[key]) custom[key] = value;
  const user = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  const pagePath = text(body.page_path, 300);
  const id = newId("lead");
  const consentText = form.consent_text || DEFAULT_CONSENT;
  await db.prepare(`INSERT INTO leads (id, form_id, name, email, phone, company, data_json, consent, consent_text, page_path,
      utm_source, utm_medium, utm_campaign, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
    .bind(id, form.id, answers.name ?? null, email, answers.phone ?? null, answers.company ?? null,
      Object.keys(custom).length ? JSON.stringify(custom) : null, consentText,
      pagePath && pagePath.startsWith("/") ? pagePath : null,
      text(body.utm_source, 100), text(body.utm_medium, 100), text(body.utm_campaign, 100), user?.id ?? null).run();

  // Anyone can type any email into a public form, so the auto-tag (used for broadcast segments) is applied
  // only when the submitter is signed in as that very account; anonymous submissions just record the lead.
  if (user && form.auto_tag && (await signedInUserId(c)) === user.id) {
    await db.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, ?)").bind(user.id, form.auto_tag).run();
  }
  await trackEvent(db, user?.id ?? null, "lead_submitted", { data: { form_id: form.id, lead_id: id } });

  const recipients = splitEmails(form.notify_emails);
  const to = recipients.length ? recipients : await siteNotifyEmails(db);
  deliverLater(c, sendEmail(to, `[Lead ใหม่] ${form.title}: ${answers.name || email}`,
    emailLayout(`มี lead ใหม่จากฟอร์ม "${form.title}"`, [
      ...fields.map(f => [f.label, typeof answers[f.key] === "boolean" ? (answers[f.key] ? "ใช่" : "ไม่") : answers[f.key]] as [string, unknown]),
      ["หน้าเว็บ", pagePath], ["แหล่งที่มา (utm_source)", text(body.utm_source, 100)], ["แคมเปญ", text(body.utm_campaign, 100)],
      ["บัญชีผู้ใช้", user ? "มีบัญชีในระบบแล้ว" : ""]
    ]), c.env.RESEND_API_KEY));
  return c.json({ message: form.success_message || "ขอบคุณ เราได้รับข้อมูลแล้ว เจ้าหน้าที่จะติดต่อกลับโดยเร็ว", id }, 201);
});

const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;
export const LEAD_STATUS_LABEL: Record<string, string> = {
  new: "ใหม่", contacted: "ติดต่อแล้ว", qualified: "มีโอกาส", converted: "ปิดการขายได้", lost: "ไม่สนใจ"
};

function leadFilter(c: Context<Env>): { where: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  const formId = c.req.query("form_id");
  const status = c.req.query("status");
  const q = c.req.query("q")?.trim();
  if (formId) { clauses.push("l.form_id = ?"); binds.push(formId); }
  if (status && (LEAD_STATUSES as readonly string[]).includes(status)) { clauses.push("l.status = ?"); binds.push(status); }
  if (q) { clauses.push("(l.email LIKE ? OR l.name LIKE ? OR l.company LIKE ? OR l.phone LIKE ?)"); const like = `%${q.slice(0, 100)}%`; binds.push(like, like, like, like); }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", binds };
}

marketingRouter.get("/marketing/admin/leads", async (c) => {
  const { limit, offset } = pageParams(c);
  const { where, binds } = leadFilter(c);
  const rows = await c.env.DB.prepare(`SELECT l.*, f.title AS form_title FROM leads l LEFT JOIN lead_forms f ON f.id = l.form_id
    ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all<Row>();
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l ${where}`).bind(...binds).first<{ n: number }>();
  return c.json({ leads: rows.results.map(r => ({ ...r, data: parseJson(r.data_json, {}), data_json: undefined })), total: total?.n ?? 0 });
});

marketingRouter.patch("/marketing/admin/leads/:id", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const lead = await c.env.DB.prepare("SELECT id, status, notes FROM leads WHERE id = ?").bind(c.req.param("id")).first<Row>();
  if (!lead) return c.json({ error: "ไม่พบ lead" }, 404);
  const status = body.status === undefined ? lead.status : body.status;
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) return c.json({ error: "สถานะไม่ถูกต้อง" }, 400);
  if (typeof body.notes === "string" && body.notes.length > 3000) return c.json({ error: "บันทึกยาวเกิน 3000 ตัวอักษร" }, 400);
  const notes = body.notes === undefined ? lead.notes : text(body.notes, 3000);
  await c.env.DB.prepare("UPDATE leads SET status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, notes, lead.id).run();
  await audit(c, "update", "lead", lead.id, { status });
  return c.json({ lead: await c.env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(lead.id).first() });
});

marketingRouter.get("/marketing/admin/leads.csv", async (c) => {
  const { where, binds } = leadFilter(c);
  const rows = await c.env.DB.prepare(`SELECT l.*, f.title AS form_title FROM leads l LEFT JOIN lead_forms f ON f.id = l.form_id
    ${where} ORDER BY l.created_at DESC LIMIT 10000`).bind(...binds).all<Row>();
  const header = ["วันที่", "ฟอร์ม", "ชื่อ", "อีเมล", "โทร", "บริษัท", "ข้อมูลเพิ่มเติม", "สถานะ", "บันทึก", "หน้าเว็บ",
    "utm_source", "utm_medium", "utm_campaign", "มีบัญชีผู้ใช้", "ยินยอม (PDPA)"];
  const lines = rows.results.map(r => {
    const data = parseJson<Row>(r.data_json, {});
    return [r.created_at, r.form_title, r.name, r.email, r.phone, r.company,
      Object.entries(data).map(([k, v]) => `${k}: ${v}`).join("; "), LEAD_STATUS_LABEL[r.status] || r.status, r.notes, r.page_path,
      r.utm_source, r.utm_medium, r.utm_campaign, r.user_id ? "ใช่" : "", r.consent ? "ยินยอม" : ""];
  });
  return csvResponse(`leads-${new Date().toISOString().slice(0, 10)}.csv`, header, lines);
});

// ==========================================
// 2. Affiliates, referrals and attribution
// ==========================================

interface Program { id: string; name: string; commission_percent: number; auto_approve: number; window_days: number; active: number; is_default: number }

function parseProgram(body: Row, existing?: Row): { values?: Row; error?: string } {
  const merged = { ...(existing ?? {}), ...body };
  const name = text(merged.name, 120);
  if (!name) return { error: "กรุณาตั้งชื่อโปรแกรม" };
  const pct = Number(merged.commission_percent);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { error: "ค่าคอมมิชชันต้องอยู่ระหว่าง 0–100%" };
  const days = merged.window_days === undefined || merged.window_days === null || merged.window_days === "" ? 90 : Number(merged.window_days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return { error: "ระยะเวลานับยอดต้องเป็นจำนวนเต็ม 1–3650 วัน" };
  return {
    values: {
      name, commission_percent: Math.round(pct * 100) / 100, window_days: days,
      auto_approve: merged.auto_approve === undefined ? 1 : bool(merged.auto_approve) ? 1 : 0,
      active: merged.active === undefined ? 1 : bool(merged.active) ? 1 : 0,
      is_default: bool(merged.is_default) ? 1 : 0
    }
  };
}

marketingRouter.get("/marketing/admin/programs", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT p.*, (SELECT COUNT(*) FROM affiliates a WHERE a.program_id = p.id) AS affiliate_count
    FROM affiliate_programs p ORDER BY p.is_default DESC, p.created_at`).all<Row>();
  return c.json({ programs: rows.results });
});

marketingRouter.post("/marketing/admin/programs", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const { values, error } = parseProgram(body);
  if (error || !values) return c.json({ error }, 400);
  const id = newId("affp");
  const statements = [];
  if (values.is_default) statements.push(c.env.DB.prepare("UPDATE affiliate_programs SET is_default = 0"));
  statements.push(c.env.DB.prepare(`INSERT INTO affiliate_programs (id, name, commission_percent, auto_approve, window_days, active, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, values.name, values.commission_percent, values.auto_approve, values.window_days, values.active, values.is_default));
  await c.env.DB.batch(statements);
  await audit(c, "create", "affiliate_program", id, values);
  return c.json({ program: await c.env.DB.prepare("SELECT * FROM affiliate_programs WHERE id = ?").bind(id).first() }, 201);
});

marketingRouter.patch("/marketing/admin/programs/:id", async (c) => {
  const existing = await c.env.DB.prepare("SELECT * FROM affiliate_programs WHERE id = ?").bind(c.req.param("id")).first<Row>();
  if (!existing) return c.json({ error: "ไม่พบโปรแกรม" }, 404);
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const { values, error } = parseProgram(body, existing);
  if (error || !values) return c.json({ error }, 400);
  const statements = [];
  if (values.is_default) statements.push(c.env.DB.prepare("UPDATE affiliate_programs SET is_default = 0 WHERE id <> ?").bind(existing.id));
  statements.push(c.env.DB.prepare(`UPDATE affiliate_programs SET name = ?, commission_percent = ?, auto_approve = ?, window_days = ?, active = ?,
    is_default = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(values.name, values.commission_percent, values.auto_approve, values.window_days, values.active, values.is_default, existing.id));
  await c.env.DB.batch(statements);
  await audit(c, "update", "affiliate_program", existing.id, values);
  return c.json({ program: await c.env.DB.prepare("SELECT * FROM affiliate_programs WHERE id = ?").bind(existing.id).first() });
});

async function affiliateStats(db: D1Database, affiliateId: string) {
  const row = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM affiliate_clicks WHERE affiliate_id = ?1) AS clicks,
      (SELECT COUNT(*) FROM signup_attributions WHERE affiliate_id = ?1) AS signups,
      (SELECT COUNT(*) FROM affiliate_conversions WHERE affiliate_id = ?1 AND status <> 'rejected') AS conversions,
      (SELECT COALESCE(SUM(commission_amount), 0) FROM affiliate_conversions WHERE affiliate_id = ?1 AND status = 'pending') AS pending,
      (SELECT COALESCE(SUM(commission_amount), 0) FROM affiliate_conversions WHERE affiliate_id = ?1 AND status = 'approved') AS approved,
      (SELECT COALESCE(SUM(commission_amount), 0) FROM affiliate_conversions WHERE affiliate_id = ?1 AND status = 'paid') AS paid`)
    .bind(affiliateId).first<Row>();
  const round = (n: number) => Math.round((n || 0) * 100) / 100;
  return {
    clicks: row?.clicks ?? 0, signups: row?.signups ?? 0, conversions: row?.conversions ?? 0,
    commission: { pending: round(row?.pending), approved: round(row?.approved), paid: round(row?.paid) }
  };
}

/** The learner's referral dashboard. GET /api/marketing/me/affiliate */
marketingRouter.get("/marketing/me/affiliate", rbac(), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const affiliate = await db.prepare(`SELECT a.*, p.name AS program_name, p.commission_percent, p.window_days, p.active AS program_active
    FROM affiliates a JOIN affiliate_programs p ON p.id = a.program_id WHERE a.user_id = ?`).bind(user.id).first<Row>();
  const program = await db.prepare("SELECT * FROM affiliate_programs WHERE is_default = 1 AND active = 1").first<Program>();
  if (!affiliate) return c.json({ affiliate: null, program: program ?? null });
  const conversions = await db.prepare(`SELECT ac.id, ac.order_amount, ac.commission_percent, ac.commission_amount, ac.status, ac.created_at,
      co.title AS course_title FROM affiliate_conversions ac
      LEFT JOIN course_orders o ON o.id = ac.order_id LEFT JOIN courses co ON co.id = o.course_id
      WHERE ac.affiliate_id = ? ORDER BY ac.created_at DESC LIMIT 100`).bind(affiliate.id).all<Row>();
  const payouts = await db.prepare("SELECT id, amount, reference, paid_at FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY paid_at DESC LIMIT 50")
    .bind(affiliate.id).all<Row>();
  return c.json({
    affiliate: {
      id: affiliate.id, code: affiliate.code, status: affiliate.status, created_at: affiliate.created_at,
      link: appUrl(c.env, `/?ref=${encodeURIComponent(affiliate.code)}`),
      program: { name: affiliate.program_name, commission_percent: affiliate.commission_percent, window_days: affiliate.window_days, active: !!affiliate.program_active }
    },
    program: program ?? null,
    stats: await affiliateStats(db, affiliate.id),
    conversions: conversions.results,
    payouts: payouts.results
  });
});

/** Join the default program and get a referral code. POST /api/marketing/me/affiliate */
marketingRouter.post("/marketing/me/affiliate", rbac(), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const existing = await db.prepare("SELECT id FROM affiliates WHERE user_id = ?").bind(user.id).first();
  if (existing) return c.json({ error: "คุณเข้าร่วมโปรแกรมแนะนำแล้ว" }, 409);
  const program = await db.prepare("SELECT * FROM affiliate_programs WHERE is_default = 1 AND active = 1").first<Program>();
  if (!program) return c.json({ error: "ยังไม่เปิดโปรแกรมแนะนำเพื่อนในขณะนี้" }, 400);
  const status = program.auto_approve ? "approved" : "pending";
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `NP${randomCode(6)}`;
    try {
      await db.prepare(`INSERT INTO affiliates (id, user_id, program_id, code, status, approved_at) VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'approved' THEN CURRENT_TIMESTAMP END)`)
        .bind(newId("aff"), user.id, program.id, code, status, status).run();
      await trackEvent(db, user.id, "affiliate_joined", { data: { program_id: program.id } });
      return c.json({ message: status === "approved" ? "เข้าร่วมแล้ว แชร์ลิงก์ของคุณได้ทันที" : "ส่งคำขอแล้ว รอเจ้าหน้าที่อนุมัติ", code, status }, 201);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: affiliates.user_id")) return c.json({ error: "คุณเข้าร่วมโปรแกรมแนะนำแล้ว" }, 409);
      if (!String(error).includes("UNIQUE")) throw error;
    }
  }
  return c.json({ error: "สร้างรหัสแนะนำไม่สำเร็จ กรุณาลองใหม่" }, 500);
});

function normalizeCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9]{4,20}$/.test(code) ? code : null;
}

/**
 * Records a visit from a referral link (one per visitor per affiliate per day).
 * POST /api/public/marketing/ref/click { code, path? }
 */
marketingRouter.post("/public/marketing/ref/click", async (c) => {
  const body = await readBody(c);
  const code = normalizeCode(body?.code);
  if (!code) return c.json({ valid: false });
  if (await rateLimited(c.env.SESSIONS, "refclick", clientIp(c), 30)) return tooManyRequests(c);
  const affiliate = await c.env.DB.prepare("SELECT id FROM affiliates WHERE code = ? AND status = 'approved'").bind(code).first<{ id: string }>();
  if (!affiliate) return c.json({ valid: false });
  const visitor = (await sha256Hex(`${clientIp(c)}|${c.req.header("User-Agent") || ""}|${new Date().toISOString().slice(0, 10)}`)).slice(0, 32);
  const path = text(body?.path, 300);
  await c.env.DB.prepare("INSERT OR IGNORE INTO affiliate_clicks (affiliate_id, path, visitor_hash) VALUES (?, ?, ?)")
    .bind(affiliate.id, path && path.startsWith("/") ? path : null, visitor).run();
  return c.json({ valid: true });
});

/**
 * First-touch attribution, sent by the site right after sign-up (ref code + UTM tags kept for 30 days).
 * Only new accounts (≤ 2 days) and only once; self-referral is blocked.
 * POST /api/marketing/attribution { ref?, utm_source?, utm_medium?, utm_campaign?, landing_path? }
 */
marketingRouter.post("/marketing/attribution", rbac(), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const account = await db.prepare("SELECT created_at, (created_at >= datetime('now', '-2 days')) AS fresh FROM users WHERE id = ?")
    .bind(user.id).first<{ created_at: string; fresh: number }>();
  if (!account?.fresh) return c.json({ attributed: false, reason: "account_too_old" });
  const existing = await db.prepare("SELECT user_id FROM signup_attributions WHERE user_id = ?").bind(user.id).first();
  if (existing) return c.json({ attributed: false, reason: "already_recorded" });

  const code = normalizeCode(body.ref);
  let affiliateId: string | null = null;
  let blocked: string | null = null;
  if (code) {
    const affiliate = await db.prepare("SELECT id, user_id, status FROM affiliates WHERE code = ?").bind(code).first<Row>();
    if (!affiliate || affiliate.status !== "approved") blocked = "invalid_code";
    else if (affiliate.user_id === user.id) blocked = "self_referral";
    else affiliateId = affiliate.id;
  }
  const landing = text(body.landing_path, 300);
  const values = {
    utm_source: text(body.utm_source, 100), utm_medium: text(body.utm_medium, 100), utm_campaign: text(body.utm_campaign, 100),
    landing_path: landing && landing.startsWith("/") ? landing : null
  };
  if (!code && !values.utm_source && !values.utm_medium && !values.utm_campaign && !values.landing_path) {
    return c.json({ attributed: false, reason: "nothing_to_record" });
  }
  try {
    await db.prepare(`INSERT INTO signup_attributions (user_id, affiliate_id, ref_code, utm_source, utm_medium, utm_campaign, landing_path, blocked_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(user.id, affiliateId, code, values.utm_source, values.utm_medium, values.utm_campaign, values.landing_path, blocked).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return c.json({ attributed: false, reason: "already_recorded" });
    throw error;
  }
  if (affiliateId) await trackEvent(db, user.id, "referral_signup", { data: { affiliate_id: affiliateId } });
  return c.json({ attributed: !!affiliateId, recorded: true, ...(blocked ? { blocked } : {}) });
});

/**
 * Commission for a paid order of a referred learner. Idempotent (one conversion per order).
 * Call when an order becomes paid (orders.ts); syncAffiliateConversions() also backfills daily.
 */
export async function recordAffiliateConversion(db: D1Database, orderId: string): Promise<{ recorded: boolean; reason?: string; commission?: number }> {
  try {
    const order = await db.prepare("SELECT id, user_id, amount, status, paid_at, created_at FROM course_orders WHERE id = ?")
      .bind(orderId).first<Row>();
    if (!order || order.status !== "paid") return { recorded: false, reason: "not_paid" };
    if (!(order.amount > 0)) return { recorded: false, reason: "free_order" };
    const attr = await db.prepare(`SELECT s.created_at AS signed_up_at, a.id AS affiliate_id, a.user_id AS affiliate_user, a.status,
        p.commission_percent, p.window_days, p.active
      FROM signup_attributions s JOIN affiliates a ON a.id = s.affiliate_id JOIN affiliate_programs p ON p.id = a.program_id
      WHERE s.user_id = ?`).bind(order.user_id).first<Row>();
    if (!attr) return { recorded: false, reason: "not_referred" };
    if (attr.affiliate_user === order.user_id) return { recorded: false, reason: "self_referral" };
    if (attr.status !== "approved" || !attr.active) return { recorded: false, reason: "inactive_affiliate" };
    const signedUp = Date.parse(String(attr.signed_up_at).replace(" ", "T") + (String(attr.signed_up_at).includes("Z") ? "" : "Z"));
    const paidRaw = String(order.paid_at || order.created_at);
    const paidAt = Date.parse(paidRaw.includes("T") ? paidRaw : paidRaw.replace(" ", "T") + "Z");
    if (Number.isFinite(signedUp) && Number.isFinite(paidAt) && paidAt - signedUp > attr.window_days * 86400_000) {
      return { recorded: false, reason: "outside_window" };
    }
    const commission = commissionFor(order.amount, attr.commission_percent);
    const result = await db.prepare(`INSERT OR IGNORE INTO affiliate_conversions (id, affiliate_id, order_id, user_id, order_amount, commission_percent, commission_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(newId("conv"), attr.affiliate_id, order.id, order.user_id, order.amount, attr.commission_percent, commission).run();
    if (!result.meta.changes) return { recorded: false, reason: "already_recorded" };
    return { recorded: true, commission };
  } catch (error) {
    console.error("recordAffiliateConversion failed:", error);
    return { recorded: false, reason: "error" };
  }
}

/** Commission in baht, rounded to satang. */
export function commissionFor(amount: number, percent: number): number {
  return Math.round(amount * percent) / 100;
}

/** Reverses unpaid commission when an order is refunded (call from the refund flow). */
export async function reverseAffiliateConversion(db: D1Database, orderId: string): Promise<void> {
  await db.prepare(`UPDATE affiliate_conversions SET status = 'rejected', note = 'คำสั่งซื้อถูกคืนเงิน', updated_at = CURRENT_TIMESTAMP
    WHERE order_id = ? AND status IN ('pending', 'approved')`).bind(orderId).run();
}

/** Backfill: records missed conversions and reverses refunded ones. Safe to repeat (daily job + admin button). */
export async function syncAffiliateConversions(db: D1Database): Promise<{ recorded: number; reversed: number }> {
  const missing = await db.prepare(`SELECT o.id FROM course_orders o
    JOIN signup_attributions s ON s.user_id = o.user_id AND s.affiliate_id IS NOT NULL
    LEFT JOIN affiliate_conversions ac ON ac.order_id = o.id
    WHERE o.status = 'paid' AND o.amount > 0 AND ac.id IS NULL LIMIT 500`).all<{ id: string }>();
  let recorded = 0;
  for (const row of missing.results) if ((await recordAffiliateConversion(db, row.id)).recorded) recorded++;
  const reversed = await db.prepare(`UPDATE affiliate_conversions SET status = 'rejected', note = 'คำสั่งซื้อถูกคืนเงิน', updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('pending', 'approved') AND order_id IN (SELECT id FROM course_orders WHERE status = 'refunded')`).run();
  return { recorded, reversed: reversed.meta.changes ?? 0 };
}

marketingRouter.get("/marketing/admin/affiliates", async (c) => {
  const status = c.req.query("status");
  const rows = await c.env.DB.prepare(`SELECT a.*, u.name AS user_name, u.email AS user_email, p.name AS program_name, p.commission_percent,
      (SELECT COUNT(*) FROM affiliate_clicks k WHERE k.affiliate_id = a.id) AS clicks,
      (SELECT COUNT(*) FROM signup_attributions s WHERE s.affiliate_id = a.id) AS signups,
      (SELECT COUNT(*) FROM affiliate_conversions ac WHERE ac.affiliate_id = a.id AND ac.status <> 'rejected') AS conversions,
      (SELECT COALESCE(SUM(commission_amount), 0) FROM affiliate_conversions ac WHERE ac.affiliate_id = a.id AND ac.status = 'pending') AS commission_pending,
      (SELECT COALESCE(SUM(commission_amount), 0) FROM affiliate_conversions ac WHERE ac.affiliate_id = a.id AND ac.status = 'approved') AS commission_approved,
      (SELECT COALESCE(SUM(commission_amount), 0) FROM affiliate_conversions ac WHERE ac.affiliate_id = a.id AND ac.status = 'paid') AS commission_paid
    FROM affiliates a JOIN users u ON u.id = a.user_id JOIN affiliate_programs p ON p.id = a.program_id
    WHERE (? IS NULL OR a.status = ?) ORDER BY a.created_at DESC LIMIT 500`).bind(status || null, status || null).all<Row>();
  return c.json({ affiliates: rows.results });
});

/** PATCH /api/marketing/admin/affiliates/:id { status?, program_id? } */
marketingRouter.patch("/marketing/admin/affiliates/:id", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const affiliate = await c.env.DB.prepare("SELECT * FROM affiliates WHERE id = ?").bind(c.req.param("id")).first<Row>();
  if (!affiliate) return c.json({ error: "ไม่พบ affiliate" }, 404);
  const status = body.status ?? affiliate.status;
  if (!["pending", "approved", "suspended"].includes(status)) return c.json({ error: "สถานะไม่ถูกต้อง" }, 400);
  const programId = body.program_id ?? affiliate.program_id;
  const program = await c.env.DB.prepare("SELECT id FROM affiliate_programs WHERE id = ?").bind(programId).first();
  if (!program) return c.json({ error: "ไม่พบโปรแกรม" }, 400);
  const approving = status === "approved" && affiliate.status !== "approved";
  await c.env.DB.prepare(`UPDATE affiliates SET status = ?, program_id = ?,
      approved_by = CASE WHEN ? THEN ? ELSE approved_by END, approved_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE approved_at END WHERE id = ?`)
    .bind(status, programId, approving ? 1 : 0, c.get("user").id, approving ? 1 : 0, affiliate.id).run();
  await audit(c, "update", "affiliate", affiliate.id, { status, program_id: programId });
  return c.json({ affiliate: await c.env.DB.prepare("SELECT * FROM affiliates WHERE id = ?").bind(affiliate.id).first() });
});

marketingRouter.get("/marketing/admin/conversions", async (c) => {
  const status = c.req.query("status") || null;
  const affiliateId = c.req.query("affiliate_id") || null;
  const rows = await c.env.DB.prepare(`SELECT ac.*, o.reference AS order_reference, co.title AS course_title,
      u.name AS buyer_name, au.name AS affiliate_name, a.code AS affiliate_code
    FROM affiliate_conversions ac JOIN affiliates a ON a.id = ac.affiliate_id JOIN users au ON au.id = a.user_id
    LEFT JOIN course_orders o ON o.id = ac.order_id LEFT JOIN courses co ON co.id = o.course_id LEFT JOIN users u ON u.id = ac.user_id
    WHERE (? IS NULL OR ac.status = ?) AND (? IS NULL OR ac.affiliate_id = ?) ORDER BY ac.created_at DESC LIMIT 500`)
    .bind(status, status, affiliateId, affiliateId).all<Row>();
  return c.json({ conversions: rows.results });
});

/** Approve / reject / reopen a commission (not once paid). POST /api/marketing/admin/conversions/:id/status { status, note? } */
marketingRouter.post("/marketing/admin/conversions/:id/status", async (c) => {
  const body = await readBody(c);
  const status = body?.status;
  if (!["pending", "approved", "rejected"].includes(status)) return c.json({ error: "สถานะไม่ถูกต้อง" }, 400);
  const result = await c.env.DB.prepare(`UPDATE affiliate_conversions SET status = ?, note = COALESCE(?, note), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status <> 'paid'`).bind(status, text(body?.note, 500), c.req.param("id")).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบรายการ หรือจ่ายค่าคอมมิชชันไปแล้ว" }, 400);
  await audit(c, "update", "affiliate_conversion", c.req.param("id"), { status });
  return c.json({ conversion: await c.env.DB.prepare("SELECT * FROM affiliate_conversions WHERE id = ?").bind(c.req.param("id")).first() });
});

/** Backfill missed conversions now. POST /api/marketing/admin/conversions/sync */
marketingRouter.post("/marketing/admin/conversions/sync", async (c) => c.json(await syncAffiliateConversions(c.env.DB)));

/**
 * Record a manual payout: every approved, unpaid commission of the affiliate becomes paid.
 * POST /api/marketing/admin/affiliates/:id/payouts { reference?, note? }
 */
marketingRouter.post("/marketing/admin/affiliates/:id/payouts", async (c) => {
  const db = c.env.DB;
  const body = (await readBody(c)) ?? {};
  const affiliate = await db.prepare("SELECT id FROM affiliates WHERE id = ?").bind(c.req.param("id")).first<{ id: string }>();
  if (!affiliate) return c.json({ error: "ไม่พบ affiliate" }, 404);
  const due = await db.prepare("SELECT id, commission_amount FROM affiliate_conversions WHERE affiliate_id = ? AND status = 'approved'")
    .bind(affiliate.id).all<{ id: string; commission_amount: number }>();
  if (!due.results.length) return c.json({ error: "ไม่มีค่าคอมมิชชันที่อนุมัติแล้วรอจ่าย" }, 400);
  const amount = Math.round(due.results.reduce((sum, r) => sum + r.commission_amount, 0) * 100) / 100;
  const payoutId = newId("pay");
  const ids = due.results.map(r => r.id);
  await db.batch([
    db.prepare("INSERT INTO affiliate_payouts (id, affiliate_id, amount, reference, note, paid_by) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(payoutId, affiliate.id, amount, text(body.reference, 120), text(body.note, 500), c.get("user").id),
    ...ids.map(id => db.prepare(`UPDATE affiliate_conversions SET status = 'paid', payout_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'approved'`).bind(payoutId, id))
  ]);
  await audit(c, "payout", "affiliate", affiliate.id, { payout_id: payoutId, amount, conversions: ids.length });
  return c.json({ payout: await db.prepare("SELECT * FROM affiliate_payouts WHERE id = ?").bind(payoutId).first(), conversions: ids.length }, 201);
});

marketingRouter.get("/marketing/admin/payouts", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT p.*, a.code AS affiliate_code, u.name AS affiliate_name, s.name AS paid_by_name
    FROM affiliate_payouts p JOIN affiliates a ON a.id = p.affiliate_id JOIN users u ON u.id = a.user_id
    LEFT JOIN users s ON s.id = p.paid_by ORDER BY p.paid_at DESC LIMIT 500`).all<Row>();
  return c.json({ payouts: rows.results });
});

// ==========================================
// 4b. Attribution / marketing analytics
// ==========================================

/** GET /api/marketing/admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC dates, default last 30 days) */
marketingRouter.get("/marketing/admin/analytics", async (c) => {
  const db = c.env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const from = c.req.query("from") || new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);
  const to = c.req.query("to") || today;
  if (!validDate(from) || !validDate(to) || from > to) return c.json({ error: "ช่วงวันที่ไม่ถูกต้อง (YYYY-MM-DD)" }, 400);
  const end = new Date(Date.parse(to + "T00:00:00Z") + 86400_000).toISOString().slice(0, 10);

  const signups = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?").bind(from, end).first<{ n: number }>();
  const sources = await db.prepare(`SELECT COALESCE(s.utm_source, CASE WHEN s.affiliate_id IS NOT NULL THEN 'referral' ELSE '(direct)' END) AS source,
      COALESCE(s.utm_medium, '') AS medium, COALESCE(s.utm_campaign, '') AS campaign,
      COUNT(*) AS signups, COALESCE(SUM(o.orders), 0) AS paid_orders, COALESCE(SUM(o.revenue), 0) AS revenue
    FROM signup_attributions s
    LEFT JOIN (SELECT user_id, COUNT(*) AS orders, SUM(amount) AS revenue FROM course_orders WHERE status = 'paid' GROUP BY user_id) o ON o.user_id = s.user_id
    WHERE s.created_at >= ? AND s.created_at < ?
    GROUP BY 1, 2, 3 ORDER BY signups DESC LIMIT 100`).bind(from, end).all<Row>();
  const leadsByForm = await db.prepare(`SELECT COALESCE(f.title, '(ฟอร์มที่ถูกลบ)') AS form, COUNT(*) AS leads,
      SUM(CASE WHEN l.status = 'converted' THEN 1 ELSE 0 END) AS converted
    FROM leads l LEFT JOIN lead_forms f ON f.id = l.form_id WHERE l.created_at >= ? AND l.created_at < ? GROUP BY l.form_id ORDER BY leads DESC`)
    .bind(from, end).all<Row>();
  const leadsBySource = await db.prepare(`SELECT COALESCE(utm_source, '(direct)') AS source, COUNT(*) AS leads FROM leads
    WHERE created_at >= ? AND created_at < ? GROUP BY 1 ORDER BY leads DESC LIMIT 50`).bind(from, end).all<Row>();
  const referrals = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM affiliate_clicks WHERE created_at >= ?1 AND created_at < ?2) AS clicks,
      (SELECT COUNT(*) FROM signup_attributions WHERE affiliate_id IS NOT NULL AND created_at >= ?1 AND created_at < ?2) AS signups,
      (SELECT COUNT(*) FROM signup_attributions WHERE blocked_reason = 'self_referral' AND created_at >= ?1 AND created_at < ?2) AS blocked_self,
      (SELECT COUNT(*) FROM affiliate_conversions WHERE status <> 'rejected' AND created_at >= ?1 AND created_at < ?2) AS conversions,
      (SELECT COALESCE(SUM(commission_amount), 0) FROM affiliate_conversions WHERE status <> 'rejected' AND created_at >= ?1 AND created_at < ?2) AS commission`)
    .bind(from, end).first<Row>();
  return c.json({
    range: { from, to }, signups: signups?.n ?? 0, sources: sources.results,
    leads: { by_form: leadsByForm.results, by_source: leadsBySource.results }, referrals
  });
});

// ==========================================
// 5. Course reviews & ratings
// ==========================================

export const REVIEW_MIN_PROGRESS = 30;

async function reviewEligibility(db: D1Database, userId: string, courseId: string): Promise<{ eligible: boolean; progress: number; reason?: string }> {
  const enrollment = await db.prepare("SELECT progress_percent, status, completed_at FROM enrollments WHERE user_id = ? AND course_id = ?")
    .bind(userId, courseId).first<{ progress_percent: number | null; status: string; completed_at: string | null }>();
  if (!enrollment) return { eligible: false, progress: 0, reason: "รีวิวได้เฉพาะผู้ที่ลงทะเบียนเรียนคอร์สนี้" };
  const progress = enrollment.progress_percent ?? 0;
  if (enrollment.status === "completed" || enrollment.completed_at || progress >= REVIEW_MIN_PROGRESS) return { eligible: true, progress };
  return { eligible: false, progress, reason: `รีวิวได้เมื่อเรียนไปแล้วอย่างน้อย ${REVIEW_MIN_PROGRESS}% หรือเรียนจบ` };
}

/** GET /api/marketing/courses/:id/review — eligibility and the learner's own review. */
marketingRouter.get("/marketing/courses/:id/review", rbac(), async (c) => {
  const courseId = c.req.param("id");
  const eligibility = await reviewEligibility(c.env.DB, c.get("user").id, courseId);
  const review = await c.env.DB.prepare("SELECT id, rating, body, status, created_at, updated_at FROM course_reviews WHERE course_id = ? AND user_id = ?")
    .bind(courseId, c.get("user").id).first();
  return c.json({ ...eligibility, review: review ?? null });
});

/** Create or update the learner's review; edits go back to moderation. PUT /api/marketing/courses/:id/review { rating, body? } */
marketingRouter.put("/marketing/courses/:id/review", rbac(), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const courseId = c.req.param("id");
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return c.json({ error: "กรุณาให้คะแนน 1–5 ดาว" }, 400);
  if (typeof body.body === "string" && body.body.trim().length > 2000) return c.json({ error: "รีวิวยาวเกิน 2000 ตัวอักษร" }, 400);
  if (await rateLimited(c.env.SESSIONS, "review", user.id, 20)) return tooManyRequests(c);
  const course = await db.prepare("SELECT id FROM courses WHERE id = ?").bind(courseId).first();
  if (!course) return c.json({ error: "ไม่พบคอร์สนี้" }, 404);
  const eligibility = await reviewEligibility(db, user.id, courseId);
  if (!eligibility.eligible) return c.json({ error: eligibility.reason }, 403);
  const reviewText = text(body.body, 2000);
  await db.prepare(`INSERT INTO course_reviews (id, course_id, user_id, rating, body) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(course_id, user_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, status = 'pending',
      moderated_by = NULL, moderated_at = NULL, updated_at = CURRENT_TIMESTAMP`)
    .bind(newId("rev"), courseId, user.id, rating, reviewText).run();
  await trackEvent(db, user.id, "review_submitted", { courseId, data: { rating } });
  const review = await db.prepare("SELECT id, rating, body, status, created_at, updated_at FROM course_reviews WHERE course_id = ? AND user_id = ?")
    .bind(courseId, user.id).first();
  return c.json({ message: "ส่งรีวิวแล้ว จะแสดงบนหน้าคอร์สหลังเจ้าหน้าที่ตรวจสอบ", review });
});

marketingRouter.get("/marketing/admin/reviews", async (c) => {
  const status = c.req.query("status") || null;
  const courseId = c.req.query("course_id") || null;
  const { limit, offset } = pageParams(c, 100, 500);
  const rows = await c.env.DB.prepare(`SELECT r.*, u.name AS user_name, u.email AS user_email, co.title AS course_title, m.name AS moderated_by_name
    FROM course_reviews r JOIN users u ON u.id = r.user_id JOIN courses co ON co.id = r.course_id LEFT JOIN users m ON m.id = r.moderated_by
    WHERE (? IS NULL OR r.status = ?) AND (? IS NULL OR r.course_id = ?) ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`)
    .bind(status, status, courseId, courseId, limit, offset).all<Row>();
  return c.json({ reviews: rows.results });
});

/** PATCH /api/marketing/admin/reviews/:id { status: approved | hidden | pending } */
marketingRouter.patch("/marketing/admin/reviews/:id", async (c) => {
  const body = await readBody(c);
  if (!["approved", "hidden", "pending"].includes(body?.status)) return c.json({ error: "สถานะไม่ถูกต้อง" }, 400);
  const result = await c.env.DB.prepare(`UPDATE course_reviews SET status = ?, moderated_by = ?, moderated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(body!.status, c.get("user").id, c.req.param("id")).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบรีวิว" }, 404);
  await audit(c, "moderate", "course_review", c.req.param("id"), { status: body!.status });
  return c.json({ review: await c.env.DB.prepare("SELECT * FROM course_reviews WHERE id = ?").bind(c.req.param("id")).first() });
});

// ==========================================
// 6. Coupon campaigns (bulk single-use voucher codes)
// ==========================================

const MAX_CAMPAIGN_CODES = 1000;

marketingRouter.get("/marketing/admin/campaigns", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT vc.*, co.title AS course_title, u.name AS created_by_name,
      (SELECT COUNT(*) FROM voucher_campaign_codes k WHERE k.campaign_id = vc.id) AS code_count,
      (SELECT COUNT(*) FROM voucher_campaign_codes k JOIN vouchers v ON v.id = k.voucher_id WHERE k.campaign_id = vc.id AND v.used_count >= COALESCE(v.max_uses, 1)) AS used_count,
      (SELECT COUNT(*) FROM voucher_campaign_codes k JOIN vouchers v ON v.id = k.voucher_id WHERE k.campaign_id = vc.id AND v.active = 1) AS active_count
    FROM voucher_campaigns vc LEFT JOIN courses co ON co.id = vc.course_id LEFT JOIN users u ON u.id = vc.created_by
    ORDER BY vc.created_at DESC LIMIT 200`).all<Row>();
  return c.json({ campaigns: rows.results });
});

/**
 * POST /api/marketing/admin/campaigns
 * { name, prefix?, discount_type: percent|fixed, discount_value, course_id?, expires_on: YYYY-MM-DD, quantity: 1–1000 }
 */
marketingRouter.post("/marketing/admin/campaigns", async (c) => {
  const db = c.env.DB;
  const body = await readBody(c);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const name = text(body.name, 120);
  if (!name) return c.json({ error: "กรุณาตั้งชื่อแคมเปญ" }, 400);
  const prefix = (typeof body.prefix === "string" && body.prefix.trim() ? body.prefix.trim().toUpperCase() : "NP");
  if (!/^[A-Z0-9]{1,12}$/.test(prefix)) return c.json({ error: "คำนำหน้าโค้ดใช้ได้เฉพาะ A–Z และ 0–9 ไม่เกิน 12 ตัว" }, 400);
  const type = body.discount_type;
  if (type !== "percent" && type !== "fixed") return c.json({ error: "ประเภทส่วนลดไม่ถูกต้อง" }, 400);
  const value = Number(body.discount_value);
  if (!Number.isFinite(value) || value <= 0 || (type === "percent" && value > 100) || (type === "fixed" && value > 1_000_000)) {
    return c.json({ error: type === "percent" ? "ส่วนลดต้องอยู่ระหว่าง 1–100%" : "ส่วนลดต้องมากกว่า 0 บาท" }, 400);
  }
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CAMPAIGN_CODES) return c.json({ error: `จำนวนโค้ดต้องเป็น 1–${MAX_CAMPAIGN_CODES}` }, 400);
  const expiresOn = typeof body.expires_on === "string" ? body.expires_on.trim() : "";
  if (!validDate(expiresOn)) return c.json({ error: "กรุณาระบุวันหมดอายุ (YYYY-MM-DD)" }, 400);
  // End of that day in Thailand, stored as UTC ISO (vouchers.expires_at is compared with toISOString()).
  const expiresAt = new Date(Date.parse(`${expiresOn}T23:59:59+07:00`)).toISOString();
  if (expiresAt <= new Date().toISOString()) return c.json({ error: "วันหมดอายุต้องเป็นวันในอนาคต" }, 400);
  const courseId = text(body.course_id, 100);
  if (courseId && !(await db.prepare("SELECT id FROM courses WHERE id = ?").bind(courseId).first())) return c.json({ error: "ไม่พบคอร์สที่เลือก" }, 400);

  const campaignId = newId("vcmp");
  const staffId = c.get("user").id;
  await db.prepare(`INSERT INTO voucher_campaigns (id, name, prefix, discount_type, discount_value, course_id, expires_at, quantity, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(campaignId, name, prefix, type, value, courseId, expiresAt, quantity, staffId).run();

  // Batches are transactions: a rare code collision rolls back only that chunk, which is retried with fresh codes.
  let created = 0;
  for (let start = 0; start < quantity; start += 40) {
    const size = Math.min(40, quantity - start);
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      const statements: D1PreparedStatement[] = [];
      const codes = new Set<string>();
      while (codes.size < size) codes.add(`${prefix}-${randomCode(8)}`);
      for (const code of codes) {
        const voucherId = newId("vch");
        statements.push(db.prepare(`INSERT INTO vouchers (id, code, discount_type, discount_value, course_id, active, expires_at, created_by, max_uses, used_count)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, 0)`).bind(voucherId, code, type, value, courseId, expiresAt, staffId));
        statements.push(db.prepare("INSERT INTO voucher_campaign_codes (campaign_id, voucher_id) VALUES (?, ?)").bind(campaignId, voucherId));
      }
      try {
        await db.batch(statements);
        created += size;
        done = true;
      } catch (error) {
        if (!String(error).includes("UNIQUE")) throw error;
      }
    }
    if (!done) break;
  }
  await audit(c, "create", "voucher_campaign", campaignId, { name, quantity, created });
  const campaign = await db.prepare("SELECT * FROM voucher_campaigns WHERE id = ?").bind(campaignId).first();
  return c.json({ campaign, created }, created === quantity ? 201 : 207);
});

/** Turn every unused code of a campaign off (or back on). PATCH /api/marketing/admin/campaigns/:id { active } */
marketingRouter.patch("/marketing/admin/campaigns/:id", async (c) => {
  const body = await readBody(c);
  if (!body || body.active === undefined) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const campaign = await c.env.DB.prepare("SELECT id FROM voucher_campaigns WHERE id = ?").bind(c.req.param("id")).first();
  if (!campaign) return c.json({ error: "ไม่พบแคมเปญ" }, 404);
  const active = bool(body.active) ? 1 : 0;
  const result = await c.env.DB.prepare(`UPDATE vouchers SET active = ? WHERE id IN (SELECT voucher_id FROM voucher_campaign_codes WHERE campaign_id = ?)`)
    .bind(active, c.req.param("id")).run();
  await audit(c, active ? "activate" : "deactivate", "voucher_campaign", c.req.param("id"));
  return c.json({ updated: result.meta.changes ?? 0 });
});

marketingRouter.get("/marketing/admin/campaigns/:id/codes.csv", async (c) => {
  const campaign = await c.env.DB.prepare("SELECT * FROM voucher_campaigns WHERE id = ?").bind(c.req.param("id")).first<Row>();
  if (!campaign) return c.json({ error: "ไม่พบแคมเปญ" }, 404);
  const rows = await c.env.DB.prepare(`SELECT v.code, v.discount_type, v.discount_value, v.used_count, v.max_uses, v.active, v.expires_at
    FROM voucher_campaign_codes k JOIN vouchers v ON v.id = k.voucher_id WHERE k.campaign_id = ? ORDER BY v.code`).bind(campaign.id).all<Row>();
  const header = ["โค้ด", "ส่วนลด", "สถานะ", "หมดอายุ"];
  const lines = rows.results.map(v => [v.code, v.discount_type === "percent" ? `${v.discount_value}%` : `${v.discount_value} บาท`,
    v.used_count >= (v.max_uses ?? 1) ? "ใช้แล้ว" : v.active ? "ยังไม่ใช้" : "ปิดใช้งาน", v.expires_at]);
  return csvResponse(`vouchers-${campaign.prefix}-${campaign.id}.csv`, header, lines);
});
