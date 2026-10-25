import { Context } from "hono";
import type { Env } from "../middleware/rbac";
import { currentPermissions, Permission } from "./permissions";
import { escapeHtml, sendEmail } from "./email";

/**
 * Email confirmation codes for dangerous deletions (migrations/0029_delete_confirmations.sql).
 *
 * Rule: a code is required when the target is published, has learner data or money attached, or is
 * security-critical (webhooks, API keys, SSO, PDPA account deletion). Low-risk deletes (a draft without
 * learners, a tag, a note) keep the simple browser confirm.
 *
 * Flow: GET /api/security/delete-preview → POST /api/security/delete-codes (emails a 6-digit code to the
 * resource owner or to the admins) → the delete endpoint calls requireDeleteConfirmation(), which consumes
 * the code. A code is bound to action + target + the user who asked for it, lives 10 minutes, allows
 * 5 wrong tries and works once. Only an HMAC of it is stored.
 */

export type DangerAction =
  | "course.delete" | "lesson.delete" | "section.delete" | "exam.delete" | "assignment.delete"
  | "session.delete" | "article.delete" | "product.delete" | "page.delete"
  | "webhook.delete" | "api_key.revoke" | "sso.delete" | "privacy.approve";

export type Approver = "owner" | "admin";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

type C = Context<Env>;

interface DangerTarget {
  title: string;
  ownerId: string | null;
  /** False → the endpoint keeps its simple confirm (no code). */
  required: boolean;
  counts: Array<{ label: string; value: number }>;
  consequences: string[];
  /** Text the UI asks the user to type before deleting (course title). */
  confirmText?: string | null;
}

interface ActionSpec {
  label: string;
  kind: string;
  /** Only admins may approve (code goes to the requesting admin, or to every active admin). */
  adminOnly?: boolean;
  load(db: D1Database, id: string): Promise<DangerTarget | null>;
  /** Mirrors the delete endpoint's own access check, so nobody can trigger emails for things they cannot delete. */
  allowed(c: C, target: DangerTarget): Promise<boolean>;
}

const n = (v: unknown) => Number(v) || 0;
const nonZero = (counts: DangerTarget["counts"]) => counts.filter(x => x.value > 0);

const courseOwnerOrAdmin = async (c: C, t: DangerTarget) => {
  const user = c.get("user");
  return user.roles.includes("admin") || (user.roles.includes("instructor") && !!t.ownerId && t.ownerId === user.id);
};
const hasPermission = (...required: Permission[]) => async (c: C) => {
  const granted = await currentPermissions(c);
  return required.some(p => granted.has(p));
};

const LEARNER_NOTE = "ผู้เรียนที่ลงทะเบียนอยู่จะได้รับผลกระทบทันที";

const ACTIONS: Record<DangerAction, ActionSpec> = {
  "course.delete": {
    label: "ลบคอร์ส", kind: "คอร์ส",
    async load(db, id) {
      const row = await db.prepare(`SELECT c.title, c.instructor_id, c.status,
          (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS learners,
          (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS lessons,
          (SELECT COUNT(*) FROM exam_attempts a JOIN exams e ON e.id = a.exam_id WHERE e.course_id = c.id) AS attempts,
          (SELECT COUNT(*) FROM course_orders WHERE course_id = c.id) + (SELECT COUNT(*) FROM payments WHERE course_id = c.id) AS orders,
          (SELECT COUNT(*) FROM certificates WHERE course_id = c.id) AS certificates
        FROM courses c WHERE c.id = ?`).bind(id).first<Record<string, any>>();
      if (!row) return null;
      const keep = courseHasRecords(row);
      return {
        title: row.title, ownerId: row.instructor_id, required: true, confirmText: row.title,
        counts: [
          { label: "ผู้เรียนที่ลงทะเบียน", value: n(row.learners) }, { label: "บทเรียน", value: n(row.lessons) },
          { label: "การทำข้อสอบ", value: n(row.attempts) }, { label: "คำสั่งซื้อ/การชำระเงิน", value: n(row.orders) },
          { label: "ใบประกาศ", value: n(row.certificates) }
        ],
        consequences: keep
          ? ["คอร์สนี้มีข้อมูลผู้เรียนหรือการเงิน ระบบจะเก็บเข้าคลัง (archive) แทนการลบถาวร เพื่อเก็บประวัติการเรียน ใบประกาศ และเอกสารการเงิน",
             "คอร์สจะหายจากหน้าขายและรายการคอร์สทันที"]
          : ["บทเรียน แบบทดสอบ ข้อสอบ งานที่มอบหมาย และเนื้อหาทั้งหมดของคอร์สจะถูกลบถาวร กู้คืนไม่ได้"]
      };
    },
    allowed: courseOwnerOrAdmin
  },
  "lesson.delete": {
    label: "ลบบทเรียน", kind: "บทเรียน",
    async load(db, id) {
      const row = await db.prepare(`SELECT l.title, co.title AS course_title, co.instructor_id,
          (SELECT COUNT(*) FROM enrollments WHERE course_id = l.course_id) AS learners,
          (SELECT COUNT(*) FROM lesson_progress WHERE lesson_id = l.id) AS progress
        FROM lessons l JOIN courses co ON co.id = l.course_id WHERE l.id = ?`).bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: `${row.title} (คอร์ส ${row.course_title})`, ownerId: row.instructor_id, required: n(row.learners) > 0,
        counts: [{ label: "ผู้เรียนในคอร์ส", value: n(row.learners) }, { label: "ความคืบหน้าของผู้เรียนในบทนี้", value: n(row.progress) }],
        consequences: ["เนื้อหา แบบทดสอบท้ายบท และความคืบหน้าของผู้เรียนในบทเรียนนี้จะถูกลบถาวร", LEARNER_NOTE]
      };
    },
    allowed: courseOwnerOrAdmin
  },
  "section.delete": {
    label: "ลบบท (หมวด)", kind: "บทของคอร์ส",
    async load(db, id) {
      const row = await db.prepare(`SELECT s.title, co.title AS course_title, co.instructor_id,
          (SELECT COUNT(*) FROM enrollments WHERE course_id = s.course_id) AS learners,
          (SELECT COUNT(*) FROM lessons WHERE section_id = s.id) AS lessons
        FROM course_sections s JOIN courses co ON co.id = s.course_id WHERE s.id = ?`).bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: `${row.title} (คอร์ส ${row.course_title})`, ownerId: row.instructor_id, required: n(row.learners) > 0,
        counts: [{ label: "ผู้เรียนในคอร์ส", value: n(row.learners) }, { label: "บทเรียนในบทนี้", value: n(row.lessons) }],
        consequences: ["บทเรียนในบทนี้จะย้ายไปอยู่นอกบท (ไม่ถูกลบ) ลำดับเนื้อหาที่ผู้เรียนเห็นจะเปลี่ยน"]
      };
    },
    allowed: courseOwnerOrAdmin
  },
  "exam.delete": {
    label: "ลบข้อสอบ", kind: "ข้อสอบ",
    async load(db, id) {
      const row = await db.prepare(`SELECT e.title, co.instructor_id,
          (SELECT COUNT(*) FROM exam_attempts WHERE exam_id = e.id) AS attempts,
          (SELECT COUNT(DISTINCT user_id) FROM exam_attempts WHERE exam_id = e.id) AS learners
        FROM exams e JOIN courses co ON co.id = e.course_id WHERE e.id = ?`).bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: row.title, ownerId: row.instructor_id, required: n(row.attempts) > 0,
        counts: [{ label: "การทำข้อสอบ", value: n(row.attempts) }, { label: "ผู้เรียนที่เคยสอบ", value: n(row.learners) }],
        consequences: ["คะแนนและคำตอบของผู้เรียนทุกคนในข้อสอบนี้จะถูกลบถาวร สมุดคะแนนจะไม่มีผลสอบนี้อีก"]
      };
    },
    allowed: courseOwnerOrAdmin
  },
  "assignment.delete": {
    label: "ลบงานที่มอบหมาย", kind: "งานที่มอบหมาย",
    async load(db, id) {
      const row = await db.prepare(`SELECT a.title, co.instructor_id,
          (SELECT COUNT(*) FROM assignment_submissions WHERE assignment_id = a.id) AS submissions,
          (SELECT COUNT(DISTINCT user_id) FROM assignment_submissions WHERE assignment_id = a.id) AS learners
        FROM assignments a JOIN courses co ON co.id = a.course_id WHERE a.id = ?`).bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: row.title, ownerId: row.instructor_id, required: n(row.submissions) > 0,
        counts: [{ label: "งานที่ส่งแล้ว", value: n(row.submissions) }, { label: "ผู้เรียนที่ส่งงาน", value: n(row.learners) }],
        consequences: ["งานที่ผู้เรียนส่ง ไฟล์แนบ และคะแนนจะถูกลบถาวร"]
      };
    },
    allowed: courseOwnerOrAdmin
  },
  "session.delete": {
    label: "ลบรอบอบรม", kind: "รอบอบรม",
    async load(db, id) {
      const row = await db.prepare(`SELECT s.title, s.start_date, s.status, s.created_by,
          (SELECT COUNT(*) FROM session_registrations WHERE session_id = s.id) AS registrations,
          (SELECT COUNT(*) FROM session_registrations WHERE session_id = s.id AND status != 'cancelled') AS active
        FROM training_sessions s WHERE s.id = ?`).bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: `${row.title} (${row.start_date})`, ownerId: row.created_by,
        required: n(row.registrations) > 0 || row.status === "open" || row.status === "closed",
        counts: [{ label: "ใบลงทะเบียนทั้งหมด", value: n(row.registrations) }, { label: "ผู้ลงทะเบียนที่ยังไม่ยกเลิก", value: n(row.active) }],
        consequences: ["รอบอบรมและประวัติการลงทะเบียนทั้งหมดของรอบนี้จะถูกลบถาวร",
          ...(row.status !== "draft" ? ["รอบนี้เผยแพร่บนเว็บไซต์อยู่ จะหายจากหน้าเว็บทันที"] : [])]
      };
    },
    allowed: hasPermission("site.sessions")
  },
  "article.delete": {
    label: "ลบบทความ", kind: "บทความ",
    async load(db, id) {
      const row = await db.prepare("SELECT title, author_id, status FROM articles WHERE id = ?").bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: row.title, ownerId: row.author_id, required: row.status === "published", counts: [],
        consequences: ["บทความที่เผยแพร่อยู่จะหายจากเว็บไซต์ทันที ลิงก์ที่แชร์ไว้จะใช้ไม่ได้ และประวัติการแก้ไขจะถูกลบ"]
      };
    },
    async allowed(c, t) {
      const granted = await currentPermissions(c);
      return granted.has("articles.manage") || (t.ownerId === c.get("user").id && (granted.has("articles.write") || granted.has("articles.publish")));
    }
  },
  "product.delete": {
    label: "ลบแพ็กเกจ", kind: "แพ็กเกจ/ชุดคอร์ส",
    async load(db, id) {
      const row = await db.prepare(`SELECT p.title, p.created_by, p.status,
          (SELECT COUNT(*) FROM course_orders WHERE product_id = p.id) AS orders,
          (SELECT COUNT(*) FROM memberships WHERE product_id = p.id) AS members
        FROM products p WHERE p.id = ?`).bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: row.title, ownerId: row.created_by, required: row.status === "published" || n(row.orders) + n(row.members) > 0,
        counts: [{ label: "คำสั่งซื้อ", value: n(row.orders) }, { label: "สมาชิก", value: n(row.members) }],
        consequences: ["แพ็กเกจที่วางขายอยู่จะหายจากหน้าร้านทันที ลิงก์ซื้อที่แชร์ไว้จะใช้ไม่ได้"]
      };
    },
    allowed: hasPermission("commerce.manage")
  },
  "page.delete": {
    label: "ลบหน้าเว็บ", kind: "หน้าเว็บ",
    async load(db, id) {
      const row = await db.prepare("SELECT title, slug, status, created_by FROM site_pages WHERE id = ?").bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: `${row.title} (/${row.slug})`, ownerId: row.created_by, required: row.status === "published", counts: [],
        consequences: ["หน้าที่เผยแพร่อยู่จะหายจากเว็บไซต์ทันที ลิงก์และเมนูที่ชี้มาหน้านี้จะใช้ไม่ได้"]
      };
    },
    allowed: hasPermission("website.design")
  },
  "webhook.delete": {
    label: "ลบปลายทาง webhook", kind: "webhook", adminOnly: true,
    async load(db, id) {
      const row = await db.prepare(`SELECT name, url, (SELECT COUNT(*) FROM webhook_deliveries WHERE endpoint_id = w.id) AS deliveries
        FROM webhook_endpoints w WHERE id = ?`).bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: `${row.name} (${row.url})`, ownerId: null, required: true,
        counts: [{ label: "ประวัติการส่ง", value: n(row.deliveries) }],
        consequences: ["ระบบปลายทางจะไม่ได้รับเหตุการณ์อีก ประวัติการส่งทั้งหมดจะถูกลบ"]
      };
    },
    allowed: hasPermission("integrations.manage")
  },
  "api_key.revoke": {
    label: "เพิกถอน API key", kind: "API key", adminOnly: true,
    async load(db, id) {
      const row = await db.prepare("SELECT name, prefix, revoked_at FROM api_keys WHERE id = ?").bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: `${row.name} (${row.prefix}…)`, ownerId: null, required: !row.revoked_at, counts: [],
        consequences: ["ระบบที่ใช้ key นี้จะเรียก API ไม่ได้ทันที เปิดใช้ key เดิมอีกไม่ได้"]
      };
    },
    allowed: hasPermission("integrations.manage")
  },
  "sso.delete": {
    label: "ลบการเชื่อมต่อ SSO", kind: "SSO", adminOnly: true,
    async load(db, id) {
      const row = await db.prepare("SELECT name, issuer, (SELECT COUNT(*) FROM sso_identities WHERE provider_id = s.id) AS identities FROM sso_providers s WHERE id = ?")
        .bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: `${row.name} (${row.issuer})`, ownerId: null, required: true,
        counts: [{ label: "บัญชีที่ผูกกับ SSO นี้", value: n(row.identities) }],
        consequences: ["ผู้ใช้จะเข้าสู่ระบบผ่าน SSO นี้ไม่ได้ (ยังใช้รหัสผ่านได้ตามปกติ) การผูกบัญชีทั้งหมดจะถูกลบ"]
      };
    },
    allowed: hasPermission("integrations.manage")
  },
  "privacy.approve": {
    label: "อนุมัติลบบัญชี (PDPA)", kind: "คำขอลบข้อมูลส่วนบุคคล", adminOnly: true,
    async load(db, id) {
      const row = await db.prepare(`SELECT r.status, u.name, u.email,
          (SELECT COUNT(*) FROM enrollments WHERE user_id = r.user_id) AS enrollments,
          (SELECT COUNT(*) FROM course_orders WHERE user_id = r.user_id) AS orders
        FROM privacy_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?`).bind(id).first<Record<string, any>>();
      if (!row) return null;
      return {
        title: `${row.name} (${maskEmail(row.email)})`, ownerId: null, required: row.status === "pending",
        counts: [{ label: "การลงทะเบียนเรียน", value: n(row.enrollments) }, { label: "คำสั่งซื้อ", value: n(row.orders) }],
        consequences: ["ชื่อ อีเมล และข้อมูลส่วนบุคคลของบัญชีจะถูกลบหรือปิดบังถาวร บัญชีถูกระงับและออกจากระบบทุกอุปกรณ์ กู้คืนไม่ได้",
          "ประวัติการเงิน การลงทะเบียน และใบประกาศยังเก็บไว้ตามกฎหมาย"]
      };
    },
    allowed: hasPermission("privacy.manage")
  }
};

export const isDangerAction = (v: unknown): v is DangerAction => typeof v === "string" && Object.prototype.hasOwnProperty.call(ACTIONS, v);

/** Course rows that must be kept (enrollments, money, certificates): delete archives instead. */
export function courseHasRecords(row: { learners?: unknown; orders?: unknown; certificates?: unknown }): boolean {
  return n(row.learners) + n(row.orders) + n(row.certificates) > 0;
}

// ---------- Helpers ----------

/** "in***@netprime.com" — never the full address. */
export function maskEmail(email: string | null | undefined): string {
  const value = String(email || "");
  const at = value.lastIndexOf("@");
  if (at < 1) return "***";
  return `${value.slice(0, Math.min(2, at))}***${value.slice(at)}`;
}

/** Local test harness may send X-Test-Now (ISO) to simulate the clock; never honored in production. */
function nowMs(c: C): number {
  if (c.env.ALLOW_LOCAL_SEED_PASSWORDS === "true") {
    const override = Date.parse(c.req.header("X-Test-Now") || "");
    if (Number.isFinite(override)) return override;
  }
  return Date.now();
}

async function codeHash(secret: string, action: string, targetId: string, userId: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`danger-confirm:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${action}\n${targetId}\n${userId}\n${code}`));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  // Rejection sampling keeps the 6 digits uniform.
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

export async function dangerAudit(c: C, event: string, action: string, targetId: string, detail?: unknown) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("log_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), c.get("user")?.id ?? null, event, action, targetId,
        detail === undefined ? null : JSON.stringify(detail).slice(0, 2000)).run();
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}

interface Person { id: string; email: string; name: string }

async function activeAdmins(db: D1Database): Promise<Person[]> {
  const rows = await db.prepare(`SELECT u.id, u.email, u.name FROM users u WHERE u.status = 'active'
      AND (EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'admin')
        OR (u.role = 'admin' AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id)))
    ORDER BY u.created_at LIMIT 50`).all<Person>();
  return rows.results;
}

async function activeOwner(db: D1Database, ownerId: string | null): Promise<Person | null> {
  if (!ownerId) return null;
  return db.prepare("SELECT id, email, name FROM users WHERE id = ? AND status = 'active'").bind(ownerId).first<Person>();
}

interface Resolved {
  spec: ActionSpec;
  target: DangerTarget;
  owner: Person | null;
  admins: Person[];
  options: Array<{ kind: Approver; label: string; hint: string; recipients: Person[] }>;
  defaultApprover: Approver | null;
}

/** Target, permission check and who may approve. Returns a Response on 404/403. */
async function resolve(c: C, action: DangerAction, targetId: string): Promise<Resolved | Response> {
  const spec = ACTIONS[action];
  const target = await spec.load(c.env.DB, targetId);
  if (!target) return c.json({ error: `ไม่พบ${spec.kind}` }, 404);
  if (!(await spec.allowed(c, target))) return c.json({ error: `ไม่มีสิทธิ์${spec.label}นี้` }, 403);
  const user = c.get("user");
  const isAdmin = user.roles.includes("admin");
  const owner = spec.adminOnly ? null : await activeOwner(c.env.DB, target.ownerId);
  const admins = await activeAdmins(c.env.DB);
  const options: Resolved["options"] = [];
  if (owner) options.push({ kind: "owner", label: "ส่งรหัสไปที่อีเมลเจ้าของ", hint: maskEmail(owner.email), recipients: [owner] });
  if (isAdmin) {
    options.push({ kind: "admin", label: "ส่งรหัสไปที่ผู้ดูแลระบบ", hint: maskEmail(user.email), recipients: [{ id: user.id, email: user.email, name: user.name }] });
  } else if (admins.length) {
    options.push({ kind: "admin", label: "ส่งรหัสไปที่ผู้ดูแลระบบ", hint: admins.length === 1 ? maskEmail(admins[0].email) : `ผู้ดูแลระบบ ${admins.length} คน`, recipients: admins });
  }
  const has = (k: Approver) => options.some(o => o.kind === k);
  const defaultApprover: Approver | null = owner && owner.id === user.id ? "owner" : isAdmin ? "admin" : has("owner") ? "owner" : has("admin") ? "admin" : null;
  return { spec, target, owner, admins, options, defaultApprover };
}

// ---------- Endpoints' building blocks ----------

/** GET /api/security/delete-preview body. */
export async function deletePreview(c: C, action: DangerAction, targetId: string) {
  const r = await resolve(c, action, targetId);
  if (r instanceof Response) return r;
  return c.json({
    action, target_id: targetId, label: r.spec.label, kind: r.spec.kind, title: r.target.title,
    required: r.target.required, admin_only: !!r.spec.adminOnly,
    counts: nonZero(r.target.counts), consequences: r.target.consequences,
    confirm_text: r.target.confirmText ?? null,
    approvers: r.options.map(o => ({ kind: o.kind, label: o.label, hint: o.hint })),
    default_approver: r.defaultApprover,
    expires_minutes: CODE_TTL_MS / 60000, max_attempts: MAX_ATTEMPTS
  });
}

/** POST /api/security/delete-codes: stores a fresh code (older open codes for the same request stop working) and emails it. */
export async function issueDeleteCode(c: C, action: DangerAction, targetId: string, approver?: Approver) {
  const r = await resolve(c, action, targetId);
  if (r instanceof Response) return r;
  if (!r.target.required) return c.json({ error: "รายการนี้ลบได้โดยไม่ต้องใช้รหัสยืนยัน", code: "confirmation_not_required" }, 400);
  const chosen = approver ?? r.defaultApprover;
  const option = r.options.find(o => o.kind === chosen);
  if (!option) {
    return c.json({ error: r.options.length ? "ผู้อนุมัติที่เลือกใช้กับรายการนี้ไม่ได้" : "ไม่พบผู้อนุมัติที่ใช้งานอยู่ (เจ้าของหรือผู้ดูแลระบบ)" }, r.options.length ? 400 : 409);
  }
  const user = c.get("user");
  const db = c.env.DB;
  const now = nowMs(c);
  const code = randomCode();
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  await db.batch([
    db.prepare(`UPDATE danger_confirmations SET attempts = ? WHERE action = ? AND target_id = ? AND requested_by = ? AND used_at IS NULL`)
      .bind(MAX_ATTEMPTS, action, targetId, user.id),
    db.prepare(`INSERT INTO danger_confirmations (id, action, target_id, requested_by, approver_kind, code_hash, expires_at, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`).bind("dc_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20), action, targetId, user.id,
        option.kind, await codeHash(c.env.JWT_SECRET, action, targetId, user.id, code), expiresAt, new Date(now).toISOString())
  ]);

  const self = option.recipients.length === 1 && option.recipients[0].id === user.id;
  const counts = nonZero(r.target.counts);
  await Promise.all(option.recipients.map(to => sendEmail(to.email, `รหัสยืนยัน${r.spec.label}: ${r.target.title}`.slice(0, 200), `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eaeaea; padding: 20px; border-radius: 10px;">
      <h2 style="color: #dc2626;">ยืนยันการ${escapeHtml(r.spec.label)}</h2>
      <p>${self ? "คุณขอ" : `<strong>${escapeHtml(user.name)}</strong> (${escapeHtml(user.email)}) ขอ`}${escapeHtml(r.spec.label)}: <strong>${escapeHtml(r.target.title)}</strong></p>
      ${counts.length ? `<ul>${counts.map(x => `<li>${escapeHtml(x.label)}: ${x.value.toLocaleString("th-TH")}</li>`).join("")}</ul>` : ""}
      <ul>${r.target.consequences.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
      <p>รหัสยืนยัน:</p>
      <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; font-family: monospace;">${code}</p>
      <p style="color: #666; font-size: 13px;">รหัสมีอายุ ${CODE_TTL_MS / 60000} นาที ใช้ได้ครั้งเดียวและใช้ได้เฉพาะคำขอนี้
        ${self ? "" : " หากคุณอนุมัติ ให้แจ้งรหัสนี้แก่ผู้ขอด้วยตัวเอง"} หากคุณไม่ได้ขอหรือไม่อนุมัติ อย่าแจ้งรหัสนี้กับใคร และแจ้งผู้ดูแลระบบ</p>
      <p style="color: #666; font-size: 12px; border-top: 1px solid #eaeaea; padding-top: 10px; margin-top: 20px;">ส่งถึง: ${escapeHtml(to.email)} • Netprime Learning Inc.</p>
    </div>`, c.env.RESEND_API_KEY).catch(err => console.error("Delete confirmation email failed:", err))));

  await dangerAudit(c, "danger.code_requested", action, targetId, { approver: option.kind, recipients: option.recipients.map(p => p.id) });
  return c.json({
    message: `ส่งรหัสยืนยันไปที่ ${option.hint} แล้ว รหัสมีอายุ ${CODE_TTL_MS / 60000} นาที`,
    approver: option.kind, sent_to: option.hint, expires_at: expiresAt,
    // Local email is only logged; tests read the code from here. Never present in production.
    ...(c.env.ALLOW_LOCAL_SEED_PASSWORDS === "true" ? { debug_code: code } : {})
  });
}

async function suppliedCode(c: C): Promise<string> {
  const header = c.req.header("X-Confirmation-Code");
  if (header) return header.trim();
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const value = body && typeof body === "object" ? body.confirmation_code : undefined;
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

/**
 * Call in a delete endpoint after its own checks, right before the destructive statement.
 * Returns null when the delete may proceed (code not required, or a valid code was consumed),
 * else a 428 (confirmation_required) / 403 (confirmation_invalid) response for the UI to prompt.
 * A missing target also returns null so the endpoint answers its own 404.
 */
export async function requireDeleteConfirmation(c: C, action: DangerAction, targetId: string): Promise<Response | null> {
  const spec = ACTIONS[action];
  const target = await spec.load(c.env.DB, targetId);
  if (!target || !target.required) return null;
  const code = await suppliedCode(c);
  if (!code) {
    return c.json({ error: `การ${spec.label}นี้ต้องยืนยันด้วยรหัสที่ส่งทางอีเมลของเจ้าของหรือผู้ดูแลระบบ`, code: "confirmation_required", action, target_id: targetId }, 428);
  }
  const user = c.get("user");
  const db = c.env.DB;
  const now = new Date(nowMs(c)).toISOString();
  const hash = /^\d{6}$/.test(code) ? await codeHash(c.env.JWT_SECRET, action, targetId, user.id, code) : "-";
  const used = await db.prepare(`UPDATE danger_confirmations SET used_at = ?
    WHERE id = (SELECT id FROM danger_confirmations WHERE action = ? AND target_id = ? AND requested_by = ? AND code_hash = ?
        AND used_at IS NULL AND attempts < ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1)
      AND used_at IS NULL RETURNING approver_kind`)
    .bind(now, action, targetId, user.id, hash, MAX_ATTEMPTS, now).first<{ approver_kind: string }>();
  if (used) {
    await dangerAudit(c, "danger.code_verified", action, targetId, { approver: used.approver_kind });
    return null;
  }
  const failed = await db.prepare(`UPDATE danger_confirmations SET attempts = attempts + 1
    WHERE action = ? AND target_id = ? AND requested_by = ? AND used_at IS NULL AND attempts < ? AND expires_at > ? RETURNING attempts`)
    .bind(action, targetId, user.id, MAX_ATTEMPTS, now).all<{ attempts: number }>();
  await dangerAudit(c, "danger.code_failed", action, targetId);
  const attempts = Math.max(0, ...failed.results.map(r => r.attempts));
  const left = MAX_ATTEMPTS - attempts;
  const error = !failed.results.length
    ? "รหัสยืนยันหมดอายุ ถูกใช้ไปแล้ว หรือไม่ได้ขอไว้สำหรับรายการนี้ กรุณาขอรหัสใหม่"
    : left > 0 ? `รหัสยืนยันไม่ถูกต้อง (ลองได้อีก ${left} ครั้ง)` : "กรอกรหัสผิดเกินกำหนด รหัสนี้ถูกยกเลิกแล้ว กรุณาขอรหัสใหม่";
  return c.json({ error, code: "confirmation_invalid", attempts_left: Math.max(0, left), action, target_id: targetId }, 403);
}
