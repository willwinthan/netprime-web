import type { MiddlewareHandler } from "hono";
import type { Env } from "../middleware/rbac";

/**
 * School-wide settings (site_settings key "school"): identity, contact, timezone, language,
 * sign-up terms and the maintenance banner. Edited in the settings page (integrations.manage).
 *
 * Learner gates that other handlers can reuse without touching rbac:
 *  - signupPolicyError(db, email): call before creating a self-service account.
 *  - requireVerifiedEmail(): middleware placed after rbac() on learner routes; when the school
 *    requires verification, students and partner learners with an unconfirmed email get 403
 *    { code: "email_unverified" }. Staff roles (admin, coordinator, instructor) always pass.
 */
export interface SchoolSettings {
  school_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  support_email: string | null;
  timezone: string;
  default_language: "th" | "en";
  signup: { open: boolean; allowed_domains: string[]; require_email_verification: boolean };
  maintenance: { active: boolean; message: string | null; level: "info" | "warning" };
}

export const DEFAULT_SCHOOL: SchoolSettings = {
  school_name: "NetPrime Academy",
  contact_email: null,
  contact_phone: null,
  support_email: null,
  timezone: "Asia/Bangkok",
  default_language: "th",
  signup: { open: true, allowed_domains: [], require_email_verification: false },
  maintenance: { active: false, message: null, level: "info" }
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0); return true; } catch { return false; }
}

/** Parses a domain list from an array or comma/newline separated text; returns null when invalid. */
export function parseDomains(raw: unknown, max = 50): string[] | null {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : raw == null ? [] : null;
  if (!list) return null;
  const domains = [...new Set(list.map(d => String(d).trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
  if (domains.length > max || domains.some(d => !DOMAIN_RE.test(d))) return null;
  return domains;
}

/** Validates a full settings object from the API; partial input is merged over the current value. */
export function parseSchoolSettings(body: unknown, current: SchoolSettings = DEFAULT_SCHOOL): { settings?: SchoolSettings; error?: string } {
  if (!body || typeof body !== "object") return { error: "ข้อมูลการตั้งค่าไม่ถูกต้อง" };
  const b = body as Record<string, any>;
  const text = (value: unknown, max: number, label: string): string | null | { error: string } => {
    if (value === undefined) return null;
    if (value === null || value === "") return null;
    if (typeof value !== "string" || value.trim().length > max) return { error: `${label}ยาวเกิน ${max} ตัวอักษร` };
    return value.trim();
  };
  const next: SchoolSettings = JSON.parse(JSON.stringify(current));

  if (b.school_name !== undefined) {
    if (typeof b.school_name !== "string" || !b.school_name.trim() || b.school_name.trim().length > 120) return { error: "กรุณากรอกชื่อโรงเรียน (ไม่เกิน 120 ตัวอักษร)" };
    next.school_name = b.school_name.trim();
  }
  for (const [key, label] of [["contact_email", "อีเมลติดต่อ"], ["support_email", "อีเมลฝ่ายช่วยเหลือ"]] as const) {
    if (b[key] === undefined) continue;
    const value = text(b[key], 254, label);
    if (value && typeof value === "object") return value;
    if (value && !EMAIL_RE.test(value)) return { error: `${label}ไม่ถูกต้อง` };
    next[key] = value ? value.toLowerCase() : null;
  }
  if (b.contact_phone !== undefined) {
    const value = text(b.contact_phone, 40, "เบอร์โทร");
    if (value && typeof value === "object") return value;
    next.contact_phone = value;
  }
  if (b.timezone !== undefined) {
    if (typeof b.timezone !== "string" || b.timezone.length > 64 || !validTimezone(b.timezone)) return { error: "เขตเวลาไม่ถูกต้อง (เช่น Asia/Bangkok)" };
    next.timezone = b.timezone;
  }
  if (b.default_language !== undefined) {
    if (!["th", "en"].includes(b.default_language)) return { error: "ภาษาเริ่มต้นต้องเป็น th หรือ en" };
    next.default_language = b.default_language;
  }
  if (b.signup !== undefined) {
    if (!b.signup || typeof b.signup !== "object") return { error: "เงื่อนไขการสมัครไม่ถูกต้อง" };
    const s = b.signup;
    for (const key of ["open", "require_email_verification"] as const) {
      if (s[key] === undefined) continue;
      if (typeof s[key] !== "boolean") return { error: "ค่าเปิด/ปิดต้องเป็น true หรือ false" };
      next.signup[key] = s[key];
    }
    if (s.allowed_domains !== undefined) {
      const domains = parseDomains(s.allowed_domains);
      if (!domains) return { error: "โดเมนอีเมลที่อนุญาตไม่ถูกต้อง (เช่น company.co.th สูงสุด 50 โดเมน)" };
      next.signup.allowed_domains = domains;
    }
  }
  if (b.maintenance !== undefined) {
    if (!b.maintenance || typeof b.maintenance !== "object") return { error: "ข้อมูลประกาศปิดปรับปรุงไม่ถูกต้อง" };
    const m = b.maintenance;
    if (m.active !== undefined) {
      if (typeof m.active !== "boolean") return { error: "ค่าเปิด/ปิดต้องเป็น true หรือ false" };
      next.maintenance.active = m.active;
    }
    if (m.message !== undefined) {
      const value = text(m.message, 300, "ข้อความประกาศ");
      if (value && typeof value === "object") return value;
      next.maintenance.message = value;
    }
    if (m.level !== undefined) {
      if (!["info", "warning"].includes(m.level)) return { error: "ระดับประกาศต้องเป็น info หรือ warning" };
      next.maintenance.level = m.level;
    }
    if (next.maintenance.active && !next.maintenance.message) return { error: "กรุณากรอกข้อความประกาศก่อนเปิดใช้งาน" };
  }
  return { settings: next };
}

let cache: { value: SchoolSettings; at: number } | null = null;
const CACHE_MS = 15_000;

export function clearSchoolCache() { cache = null; }

export async function loadSchoolSettings(db: D1Database): Promise<SchoolSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await db.prepare("SELECT value FROM site_settings WHERE key = 'school'").first<{ value: string }>();
  let stored: Partial<SchoolSettings> = {};
  try { stored = row ? JSON.parse(row.value) : {}; } catch { stored = {}; }
  const value: SchoolSettings = {
    ...DEFAULT_SCHOOL, ...stored,
    signup: { ...DEFAULT_SCHOOL.signup, ...(stored.signup || {}) },
    maintenance: { ...DEFAULT_SCHOOL.maintenance, ...(stored.maintenance || {}) }
  };
  cache = { value, at: Date.now() };
  return value;
}

/** Thai reason a self-service sign-up must be refused, or null when it is allowed. */
export async function signupPolicyError(db: D1Database, email: string): Promise<string | null> {
  const { signup } = await loadSchoolSettings(db);
  if (!signup.open) return "ขณะนี้ปิดรับสมัครสมาชิกด้วยตนเอง กรุณาติดต่อผู้ดูแลระบบ";
  if (signup.allowed_domains.length) {
    const domain = email.trim().toLowerCase().split("@").pop() || "";
    if (!signup.allowed_domains.includes(domain)) return `รับสมัครเฉพาะอีเมลโดเมน ${signup.allowed_domains.join(", ")}`;
  }
  return null;
}

const STAFF_ROLES = ["admin", "coordinator", "instructor"];

/** Use after rbac() on learner endpoints; see the module comment. */
export function requireVerifiedEmail(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    if (!user.roles.some(r => STAFF_ROLES.includes(r))) {
      const { signup } = await loadSchoolSettings(c.env.DB);
      if (signup.require_email_verification) {
        const row = await c.env.DB.prepare("SELECT email_verified_at FROM users WHERE id = ?").bind(user.id).first<{ email_verified_at: string | null }>();
        if (!row?.email_verified_at) {
          return c.json({ error: "กรุณายืนยันอีเมลก่อนเริ่มเรียน (ส่งลิงก์ยืนยันใหม่ได้จากหน้าโปรไฟล์)", code: "email_unverified" }, 403);
        }
      }
    }
    await next();
  };
}
