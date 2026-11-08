import type { Env } from "../middleware/rbac";
import type { ApiScope } from "../middleware/apikey";
import type { Permission } from "./permissions";
import { dispatchInternal } from "./dispatch";
import { deliver, emailFrame, escapeHtml } from "./email";
import { lineConfigured, linePushText, LineEnv } from "./line";
import { checkEnrollment, enrollLearner, parseEnrollmentInput, EnrollmentInput } from "./enrollment";
import { trackEvent } from "./events";
import { sha256Hex } from "./secretbox";

/**
 * Agent tools, in three tiers:
 *   read   GET endpoints of /api/v1, listed here so an agent (or a future MCP server) can discover them
 *   draft  internal-only changes nobody outside sees (lead/inquiry status and notes); run at once
 *   act    anything that reaches people or money (email, LINE, payment confirmation, publishing,
 *          course access); queued in agent_actions until a person with the tool's permission approves
 *
 * Every draft/act tool validates its input, can preview the change without making it (dry run, also
 * re-run just before an approved action executes) and runs it. Act tools that have a staff endpoint
 * run through it in-process with the approver's token (utils/dispatch.ts), so approving does exactly
 * what pressing the button in the console does.
 */
export type ToolTier = "read" | "draft" | "act";
type Bindings = Env["Bindings"];

export interface ParamSpec { type: "string" | "number" | "boolean"; required?: boolean; enum?: readonly string[]; max?: number; description: string }

export interface Preview { summary: string; target: Record<string, unknown>; warnings: string[] }
export interface Failure { error: string; code: string; status: 400 | 404 | 409 | 422 }
export interface Outcome { ok: boolean; result?: unknown; error?: string }

export interface ExecContext {
  env: Bindings;
  executionCtx?: ExecutionContext;
  agent: { id: string; name: string };
  actionId: string;
  /** Present for approved act tools: the person who approved and their Authorization header. */
  approver?: { id: string; name: string; authorization: string };
}

interface ToolBase { name: string; tier: ToolTier; scope: ApiScope; label: string; description: string }
export interface ReadTool extends ToolBase { tier: "read"; endpoint: { method: "GET"; path: string } }
export interface WriteTool<T = any> extends ToolBase {
  tier: "draft" | "act";
  /** Permission the approver needs on top of agents.approve (act tools). */
  approverPermission?: Permission;
  params: Record<string, ParamSpec>;
  parse(raw: Record<string, unknown>): T | { error: string };
  preview(env: Bindings, value: T): Promise<Preview | Failure>;
  execute(ctx: ExecContext, value: T, preview: Preview): Promise<Outcome>;
}
export type Tool = ReadTool | WriteTool;

const isFailure = (value: unknown): value is Failure => !!value && typeof value === "object" && "code" in value && "error" in value && "status" in value;
const fail = (status: Failure["status"], code: string, error: string): Failure => ({ status, code, error });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const baht = (n: unknown) => `฿${Number(n ?? 0).toLocaleString("th-TH")}`;

// ---------- Input parsing ----------

type Parsed = Record<string, string | number | boolean | null>;

/** Validates `raw` against `params`; strings are trimmed, unknown keys are rejected. */
export function parseParams(params: Record<string, ParamSpec>, raw: Record<string, unknown>): Parsed | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "input ต้องเป็น object" };
  const unknown = Object.keys(raw).filter(k => !(k in params));
  if (unknown.length) return { error: `ไม่รู้จักฟิลด์ ${unknown.join(", ")}` };
  const out: Parsed = {};
  for (const [key, spec] of Object.entries(params)) {
    const value = raw[key];
    if (value === undefined || value === null || value === "") {
      if (spec.required) return { error: `ต้องระบุ ${key}` };
      out[key] = null;
      continue;
    }
    if (spec.type === "string") {
      if (typeof value !== "string") return { error: `${key} ต้องเป็นข้อความ` };
      const text = value.trim();
      if (!text && spec.required) return { error: `ต้องระบุ ${key}` };
      if (spec.max && text.length > spec.max) return { error: `${key} ยาวได้ไม่เกิน ${spec.max} ตัวอักษร` };
      if (spec.enum && !spec.enum.includes(text)) return { error: `${key} ต้องเป็นหนึ่งใน ${spec.enum.join(", ")}` };
      out[key] = text || null;
    } else if (spec.type === "number") {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return { error: `${key} ต้องเป็นตัวเลข 0–10,000,000` };
      out[key] = Math.round(n * 100) / 100;
    } else {
      if (typeof value !== "boolean") return { error: `${key} ต้องเป็น true หรือ false` };
      out[key] = value;
    }
  }
  return out;
}

/** Stable JSON (sorted keys) for the idempotency hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const inputHash = (tool: string, input: unknown) => sha256Hex(`${tool}\n${canonicalJson(input)}`);

const agentNote = (ctx: ExecContext, note: string) => `[agent ${ctx.agent.name} ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC] ${note}`;

/** Runs a staff route as the approver and turns its answer into an outcome. */
async function viaStaffRoute(ctx: ExecContext, method: string, path: string, body: unknown): Promise<Outcome> {
  if (!ctx.approver) return { ok: false, error: "ต้องมีผู้อนุมัติ" };
  const res = await dispatchInternal(ctx.env, ctx.executionCtx, ctx.approver.authorization, method, path, body);
  if (res.status >= 200 && res.status < 300) return { ok: true, result: res.data };
  return { ok: false, error: `${res.status}: ${typeof res.data?.error === "string" ? res.data.error : "ทำรายการไม่สำเร็จ"}`, result: res.data };
}

/** Audit entry made on an agent's behalf (user_id = approver, or NULL for draft tools). */
export async function auditAgent(db: D1Database, apiKeyId: string, userId: string | null, action: string, entity: string, entityId: string | null, detail?: unknown) {
  try {
    await db.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail, api_key_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(`log_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, userId, action, entity, entityId,
        detail === undefined ? null : JSON.stringify(detail).slice(0, 2000), apiKeyId).run();
  } catch (error) { console.error("Agent audit log write failed:", error); }
}

// ---------- Act tools ----------

const confirmOrder: WriteTool<Parsed> = {
  name: "confirm_order", tier: "act", scope: "orders:confirm", approverPermission: "payments.manage",
  label: "ยืนยันการชำระเงินคำสั่งซื้อ", description: "ยืนยันยอดโอนของคำสั่งซื้อคอร์ส (ชำระครั้งเดียว) เปิดสิทธิ์เรียน และออกใบเสร็จ เหมือนกดยืนยันในหน้าคำสั่งซื้อ",
  params: {
    order_id: { type: "string", required: true, max: 100, description: "id หรือเลขอ้างอิง (NP-…) ของคำสั่งซื้อ" },
    amount_received: { type: "number", required: true, description: "ยอดเงินที่ได้รับจริง (บาท)" },
    note: { type: "string", max: 500, description: "หมายเหตุสำหรับเจ้าหน้าที่" }
  },
  parse(raw) { return parseParams(this.params, raw); },
  async preview(env, v) {
    const order = await env.DB.prepare(`SELECT o.id, o.reference, o.status, o.amount, o.installment_count, o.slip_uploaded_at,
        COALESCE(o.item_title, c.title) AS title, u.name AS user_name, u.email AS user_email
      FROM course_orders o LEFT JOIN courses c ON c.id = o.course_id LEFT JOIN users u ON u.id = o.user_id
      WHERE o.id = ? OR o.reference = ?`).bind(v.order_id, v.order_id)
      .first<{ id: string; reference: string; status: string; amount: number; installment_count: number; slip_uploaded_at: string | null; title: string | null; user_name: string; user_email: string }>();
    if (!order) return fail(404, "not_found", "ไม่พบคำสั่งซื้อ");
    if (order.installment_count > 1) return fail(422, "installments_not_supported", "คำสั่งซื้อแบบผ่อนชำระ ให้เจ้าหน้าที่ยืนยันทีละงวดในคอนโซล");
    if (!["pending", "expired"].includes(order.status)) return fail(409, "invalid_state", `คำสั่งซื้อนี้อยู่ในสถานะ ${order.status} ยืนยันไม่ได้`);
    const warnings: string[] = [];
    if (!order.slip_uploaded_at) warnings.push("ผู้ซื้อยังไม่ได้อัปโหลดสลิป");
    if (Number(v.amount_received) !== Number(order.amount)) warnings.push(`ยอดที่ได้รับ ${baht(v.amount_received)} ไม่ตรงกับยอดที่ต้องชำระ ${baht(order.amount)}`);
    return {
      summary: `ยืนยันการชำระเงิน ${order.reference} ${order.title ?? ""} ของ ${order.user_name} ยอดที่ได้รับ ${baht(v.amount_received)}`,
      target: { order_id: order.id, reference: order.reference, status: order.status, amount: order.amount, user_name: order.user_name, user_email: order.user_email, slip_uploaded: !!order.slip_uploaded_at },
      warnings
    };
  },
  async execute(ctx, v, p) {
    const note = agentNote(ctx, typeof v.note === "string" ? v.note : "ยืนยันตามคำขอของ agent");
    return viaStaffRoute(ctx, "POST", `/manage/orders/${encodeURIComponent(String(p.target.order_id))}/confirm`, { amount_received: v.amount_received, note: note.slice(0, 500) });
  }
};

const REG_STATUSES = ["pending", "confirmed", "paid", "waitlist", "cancelled", "attended"] as const;
const HOLD_SQL = "'pending', 'confirmed', 'paid', 'attended'";

const updateRegistration: WriteTool<Parsed> = {
  name: "update_registration", tier: "act", scope: "registrations:write", approverPermission: "site.sessions",
  label: "เปลี่ยนสถานะผู้สมัครรอบอบรม", description: "ยืนยันที่นั่ง บันทึกว่าชำระแล้ว ย้ายรอคิว ยกเลิก หรือบันทึกว่าเข้าอบรมแล้ว ระบบส่งอีเมลแจ้งผู้สมัครเมื่อ notify เป็น true (ค่าเริ่มต้น)",
  params: {
    registration_id: { type: "string", required: true, max: 100, description: "id ผู้สมัคร (reg_…)" },
    status: { type: "string", required: true, enum: REG_STATUSES, description: "สถานะใหม่" },
    payment_ref: { type: "string", max: 100, description: "เลขอ้างอิงการชำระเงิน" },
    admin_note: { type: "string", max: 1000, description: "หมายเหตุเจ้าหน้าที่" },
    notify: { type: "boolean", description: "ส่งอีเมลแจ้งผู้สมัคร (ค่าเริ่มต้น true)" }
  },
  parse(raw) { return parseParams(this.params, raw); },
  async preview(env, v) {
    const reg = await env.DB.prepare(`SELECT r.id, r.name, r.email, r.status, r.attendees, r.session_id, s.title AS session_title, s.start_date, s.capacity,
        (SELECT COALESCE(SUM(attendees), 0) FROM session_registrations x WHERE x.session_id = r.session_id AND x.id != r.id AND x.status IN (${HOLD_SQL})) AS others
      FROM session_registrations r JOIN training_sessions s ON s.id = r.session_id WHERE r.id = ?`).bind(v.registration_id)
      .first<{ id: string; name: string; email: string; status: string; attendees: number; session_id: string; session_title: string; start_date: string; capacity: number; others: number }>();
    if (!reg) return fail(404, "not_found", "ไม่พบผู้สมัคร");
    if (reg.status === v.status) return fail(409, "no_change", `ผู้สมัครอยู่ในสถานะ ${reg.status} อยู่แล้ว`);
    const warnings: string[] = [];
    const holds = ["pending", "confirmed", "paid", "attended"].includes(String(v.status));
    if (holds && reg.others + reg.attendees > reg.capacity) warnings.push(`ที่นั่งไม่พอ (เหลือ ${Math.max(0, reg.capacity - reg.others)} ที่ ต้องการ ${reg.attendees} ที่) ระบบจะไม่ยอมให้เปลี่ยน`);
    const notify = v.notify !== false;
    if (notify && ["confirmed", "paid", "cancelled"].includes(String(v.status))) warnings.push(`ระบบจะส่งอีเมลแจ้ง ${reg.email}`);
    return {
      summary: `เปลี่ยนสถานะ ${reg.name} (${reg.session_title} ${reg.start_date}) จาก ${reg.status} เป็น ${v.status}`,
      target: { registration_id: reg.id, session_id: reg.session_id, name: reg.name, email: reg.email, status: reg.status, attendees: reg.attendees, seats_left: Math.max(0, reg.capacity - reg.others) },
      warnings
    };
  },
  async execute(ctx, v) {
    const body: Record<string, unknown> = { status: v.status, notify: v.notify !== false };
    if (v.payment_ref) body.payment_ref = v.payment_ref;
    if (v.admin_note) body.admin_note = agentNote(ctx, String(v.admin_note)).slice(0, 2000);
    return viaStaffRoute(ctx, "PATCH", `/admin/site/registrations/${encodeURIComponent(String(v.registration_id))}`, body);
  }
};

const publishSession: WriteTool<Parsed> = {
  name: "publish_session", tier: "act", scope: "sessions:publish", approverPermission: "site.sessions",
  label: "เปิด/ปิดรับสมัครรอบอบรม", description: "เปลี่ยนสถานะรอบอบรมเป็น open (แสดงบนเว็บและรับสมัคร) closed (ปิดรับสมัคร) หรือ cancelled",
  params: {
    session_id: { type: "string", required: true, max: 100, description: "id รอบอบรม (ses_…)" },
    status: { type: "string", required: true, enum: ["open", "closed", "cancelled"], description: "สถานะใหม่" }
  },
  parse(raw) { return parseParams(this.params, raw); },
  async preview(env, v) {
    const s = await env.DB.prepare(`SELECT s.id, s.title, s.status, s.start_date, s.capacity,
        (SELECT COUNT(*) FROM session_registrations r WHERE r.session_id = s.id AND r.status IN (${HOLD_SQL})) AS registrants
      FROM training_sessions s WHERE s.id = ?`).bind(v.session_id)
      .first<{ id: string; title: string; status: string; start_date: string; capacity: number; registrants: number }>();
    if (!s) return fail(404, "not_found", "ไม่พบรอบอบรม");
    if (s.status === v.status) return fail(409, "no_change", `รอบอบรมนี้อยู่ในสถานะ ${s.status} อยู่แล้ว`);
    const warnings: string[] = [];
    if (v.status === "open" && s.start_date < new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)) warnings.push("วันเริ่มอบรมผ่านไปแล้ว");
    if (v.status === "cancelled" && s.registrants > 0) warnings.push(`มีผู้สมัครที่จองที่นั่งอยู่ ${s.registrants} ราย ระบบไม่แจ้งผู้สมัครอัตโนมัติ`);
    return {
      summary: `เปลี่ยนสถานะรอบอบรม ${s.title} (${s.start_date}) จาก ${s.status} เป็น ${v.status}`,
      target: { session_id: s.id, title: s.title, status: s.status, start_date: s.start_date, registrants: s.registrants },
      warnings
    };
  },
  async execute(ctx, v) {
    return viaStaffRoute(ctx, "PATCH", `/admin/site/sessions/${encodeURIComponent(String(v.session_id))}`, { status: v.status });
  }
};

const publishArticle: WriteTool<Parsed> = {
  name: "publish_article", tier: "act", scope: "articles:publish", approverPermission: "articles.publish",
  label: "เผยแพร่บทความ", description: "เผยแพร่บทความที่เป็นฉบับร่างหรือรอตรวจขึ้นเว็บไซต์",
  params: { article_id: { type: "string", required: true, max: 100, description: "id บทความ" } },
  parse(raw) { return parseParams(this.params, raw); },
  async preview(env, v) {
    const a = await env.DB.prepare("SELECT id, slug, title, status FROM articles WHERE id = ?").bind(v.article_id)
      .first<{ id: string; slug: string; title: string; status: string }>();
    if (!a) return fail(404, "not_found", "ไม่พบบทความ");
    if (a.status === "published") return fail(409, "no_change", "บทความนี้เผยแพร่แล้ว");
    return { summary: `เผยแพร่บทความ "${a.title}" (/blog/${a.slug})`, target: { article_id: a.id, slug: a.slug, title: a.title, status: a.status }, warnings: [] };
  },
  async execute(ctx, v) {
    return viaStaffRoute(ctx, "PATCH", `/admin/site/articles/${encodeURIComponent(String(v.article_id))}`, { status: "published" });
  }
};

const grantEnrollment: WriteTool<EnrollmentInput> = {
  name: "grant_enrollment", tier: "act", scope: "enrollments:write", approverPermission: "users.manage",
  label: "ให้สิทธิ์เรียนคอร์ส", description: "ลงทะเบียนผู้เรียนเข้าคอร์สออนไลน์ที่เผยแพร่แล้ว (เรียกซ้ำได้ ไม่ซ้ำซ้อน)",
  params: {
    course_id: { type: "string", required: true, max: 100, description: "id คอร์ส" },
    user_id: { type: "string", max: 100, description: "id ผู้เรียน (หรือระบุ email)" },
    email: { type: "string", max: 254, description: "อีเมลผู้เรียน (หรือระบุ user_id)" },
    expires_at: { type: "string", max: 40, description: "วันหมดสิทธิ์ ISO 8601 (เว้นว่าง = ตามคอร์ส)" }
  },
  parse(raw) {
    const checked = parseParams(this.params, raw);
    if ("error" in checked) return { error: String(checked.error) };
    return parseEnrollmentInput(checked as Record<string, unknown>);
  },
  async preview(env, v) {
    const checked = await checkEnrollment(env.DB, v);
    if ("error" in checked) return fail(checked.status, checked.code, checked.error);
    const warnings: string[] = [];
    if (checked.existing?.status === "active" || checked.existing?.status === "completed") warnings.push("ผู้เรียนมีสิทธิ์เรียนคอร์สนี้อยู่แล้ว");
    if (checked.existing?.status === "suspended") warnings.push("จะเปิดสิทธิ์ที่ถูกระงับไว้อีกครั้ง");
    return {
      summary: `ให้สิทธิ์ ${checked.user.name} (${checked.user.email}) เรียนคอร์ส ${checked.course.title}`,
      target: { course_id: checked.course.id, course_title: checked.course.title, user_id: checked.user.id, user_email: checked.user.email, existing_status: checked.existing?.status ?? null },
      warnings
    };
  },
  async execute(ctx, v) {
    const done = await enrollLearner(ctx.env.DB, v, { method: "agent", api_key_id: ctx.agent.id, action_id: ctx.actionId, approved_by: ctx.approver?.id ?? null });
    if ("error" in done) return { ok: false, error: done.error };
    await auditAgent(ctx.env.DB, ctx.agent.id, ctx.approver?.id ?? null, "enroll", "enrollment", (done.enrollment as { id?: string })?.id ?? null,
      { course_id: v.course_id, user: v.user_id || v.email, action_id: ctx.actionId });
    return { ok: true, result: done };
  }
};

/** An address the school already deals with: a user, registrant, lead or inquiry sender. Agents never email strangers. */
async function knownContact(db: D1Database, email: string): Promise<{ name: string | null; source: string } | null> {
  const row = await db.prepare(`SELECT name, source FROM (
      SELECT name, 'user' AS source, 1 AS rank FROM users WHERE email = ?1
      UNION ALL SELECT name, 'registration', 2 FROM session_registrations WHERE email = ?1
      UNION ALL SELECT name, 'inquiry', 3 FROM inquiries WHERE email = ?1
      UNION ALL SELECT name, 'lead', 4 FROM leads WHERE email = ?1
    ) ORDER BY rank LIMIT 1`).bind(email).first<{ name: string | null; source: string }>();
  return row ?? null;
}

const sendEmailTool: WriteTool<Parsed> = {
  name: "send_email", tier: "act", scope: "messages:send", approverPermission: "communication.manage",
  label: "ส่งอีเมล", description: "ส่งอีเมลข้อความธรรมดาถึงผู้ติดต่อที่มีในระบบแล้ว (ผู้ใช้ ผู้สมัคร ผู้ส่งข้อความติดต่อ หรือ lead) เท่านั้น",
  params: {
    to: { type: "string", required: true, max: 254, description: "อีเมลผู้รับ" },
    subject: { type: "string", required: true, max: 150, description: "หัวเรื่อง" },
    body: { type: "string", required: true, max: 5000, description: "เนื้อหา (ข้อความธรรมดา เว้นบรรทัดได้)" }
  },
  parse(raw) {
    const v = parseParams(this.params, raw);
    if ("error" in v) return v;
    v.to = String(v.to).toLowerCase();
    if (!EMAIL_RE.test(String(v.to))) return { error: "อีเมลผู้รับไม่ถูกต้อง" };
    return v;
  },
  async preview(env, v) {
    const contact = await knownContact(env.DB, String(v.to));
    if (!contact) return fail(422, "unknown_recipient", "ส่งได้เฉพาะผู้ติดต่อที่มีในระบบ (ผู้ใช้ ผู้สมัคร ข้อความติดต่อ หรือ lead)");
    const warnings = env.RESEND_API_KEY ? [] : ["ยังไม่ได้ตั้ง RESEND_API_KEY อีเมลจะถูกบันทึกไว้เท่านั้น ไม่ได้ส่งจริง"];
    return { summary: `ส่งอีเมลถึง ${contact.name ?? v.to} <${v.to}> เรื่อง "${v.subject}"`, target: { to: v.to, name: contact.name, contact_source: contact.source, subject: v.subject, body: v.body }, warnings };
  },
  async execute(ctx, v) {
    const paragraphs = String(v.body).split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
    const outcome = await deliver(String(v.to), String(v.subject), emailFrame(paragraphs, String(v.to)), ctx.env.RESEND_API_KEY, "agent");
    await auditAgent(ctx.env.DB, ctx.agent.id, ctx.approver?.id ?? null, "send_email", "email", String(v.to), { subject: v.subject, status: outcome.status, action_id: ctx.actionId });
    return outcome.status === "failed" ? { ok: false, error: outcome.error || "ส่งอีเมลไม่สำเร็จ", result: outcome } : { ok: true, result: outcome };
  }
};

const sendLine: WriteTool<Parsed> = {
  name: "send_line", tier: "act", scope: "messages:send", approverPermission: "communication.manage",
  label: "ส่งข้อความ LINE", description: "ส่งข้อความ LINE ถึงผู้ใช้ที่เชื่อมบัญชี LINE กับ LINE Official Account ของโรงเรียนแล้ว",
  params: {
    user_id: { type: "string", required: true, max: 100, description: "id ผู้ใช้" },
    text: { type: "string", required: true, max: 2000, description: "ข้อความ" }
  },
  parse(raw) { return parseParams(this.params, raw); },
  async preview(env, v) {
    const row = await env.DB.prepare("SELECT u.id, u.name, l.line_user_id FROM users u LEFT JOIN line_links l ON l.user_id = u.id WHERE u.id = ?")
      .bind(v.user_id).first<{ id: string; name: string; line_user_id: string | null }>();
    if (!row) return fail(404, "not_found", "ไม่พบผู้ใช้");
    if (!row.line_user_id) return fail(422, "line_not_linked", "ผู้ใช้นี้ยังไม่ได้เชื่อมบัญชี LINE");
    const warnings = lineConfigured(env as unknown as LineEnv) ? [] : ["ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN ส่งจริงไม่ได้"];
    return { summary: `ส่ง LINE ถึง ${row.name}`, target: { user_id: row.id, name: row.name, text: v.text }, warnings };
  },
  async execute(ctx, v) {
    const row = await ctx.env.DB.prepare("SELECT line_user_id FROM line_links WHERE user_id = ?").bind(v.user_id).first<{ line_user_id: string }>();
    if (!row) return { ok: false, error: "ผู้ใช้นี้ยังไม่ได้เชื่อมบัญชี LINE" };
    const sent = await linePushText(ctx.env as unknown as LineEnv, row.line_user_id, String(v.text));
    await auditAgent(ctx.env.DB, ctx.agent.id, ctx.approver?.id ?? null, "send_line", "user", String(v.user_id), { sent, action_id: ctx.actionId });
    return sent ? { ok: true, result: { sent: true } } : { ok: false, error: "LINE ส่งไม่สำเร็จ" };
  }
};

// ---------- Draft tools ----------

/** Appends `note` to a text column, one entry per line. */
const APPEND = (column: string) => `${column} = CASE WHEN ?2 IS NULL THEN ${column} ELSE substr(COALESCE(${column} || char(10), '') || ?2, -4000) END`;

const updateLead: WriteTool<Parsed> = {
  name: "update_lead", tier: "draft", scope: "leads:write",
  label: "อัปเดต lead", description: "เปลี่ยนสถานะ lead และ/หรือเพิ่มบันทึก (เห็นเฉพาะเจ้าหน้าที่ ไม่ส่งถึงลูกค้า)",
  params: {
    lead_id: { type: "string", required: true, max: 100, description: "id lead" },
    status: { type: "string", enum: ["new", "contacted", "qualified", "converted", "lost"], description: "สถานะใหม่" },
    note: { type: "string", max: 1000, description: "บันทึกที่จะต่อท้าย" }
  },
  parse(raw) {
    const v = parseParams(this.params, raw);
    if (!("error" in v) && !v.status && !v.note) return { error: "ต้องระบุ status หรือ note" };
    return v;
  },
  async preview(env, v) {
    const lead = await env.DB.prepare("SELECT id, name, email, status FROM leads WHERE id = ?").bind(v.lead_id).first<{ id: string; name: string | null; email: string; status: string }>();
    if (!lead) return fail(404, "not_found", "ไม่พบ lead");
    return { summary: `อัปเดต lead ${lead.name ?? lead.email}${v.status ? ` สถานะ ${lead.status} → ${v.status}` : ""}${v.note ? " เพิ่มบันทึก" : ""}`, target: { lead_id: lead.id, status: lead.status }, warnings: [] };
  },
  async execute(ctx, v) {
    const note = v.note ? agentNote(ctx, String(v.note)) : null;
    await ctx.env.DB.prepare(`UPDATE leads SET status = COALESCE(?1, status), ${APPEND("notes")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?3`)
      .bind(v.status, note, v.lead_id).run();
    await auditAgent(ctx.env.DB, ctx.agent.id, null, "update", "lead", String(v.lead_id), { status: v.status, note: !!note, action_id: ctx.actionId });
    return { ok: true, result: await ctx.env.DB.prepare("SELECT id, status, notes, updated_at FROM leads WHERE id = ?").bind(v.lead_id).first() };
  }
};

const updateInquiry: WriteTool<Parsed> = {
  name: "update_inquiry", tier: "draft", scope: "inquiries:write",
  label: "อัปเดตข้อความติดต่อ", description: "เปลี่ยนสถานะข้อความติดต่อและ/หรือเพิ่มหมายเหตุเจ้าหน้าที่ (ไม่ส่งถึงผู้ติดต่อ)",
  params: {
    inquiry_id: { type: "string", required: true, max: 100, description: "id ข้อความติดต่อ" },
    status: { type: "string", enum: ["new", "in_progress", "closed"], description: "สถานะใหม่" },
    note: { type: "string", max: 1000, description: "หมายเหตุที่จะต่อท้าย" }
  },
  parse(raw) {
    const v = parseParams(this.params, raw);
    if (!("error" in v) && !v.status && !v.note) return { error: "ต้องระบุ status หรือ note" };
    return v;
  },
  async preview(env, v) {
    const row = await env.DB.prepare("SELECT id, name, topic, status FROM inquiries WHERE id = ?").bind(v.inquiry_id).first<{ id: string; name: string; topic: string | null; status: string }>();
    if (!row) return fail(404, "not_found", "ไม่พบข้อความติดต่อ");
    return { summary: `อัปเดตข้อความติดต่อจาก ${row.name}${v.status ? ` สถานะ ${row.status} → ${v.status}` : ""}${v.note ? " เพิ่มหมายเหตุ" : ""}`, target: { inquiry_id: row.id, status: row.status, topic: row.topic }, warnings: [] };
  },
  async execute(ctx, v) {
    const note = v.note ? agentNote(ctx, String(v.note)) : null;
    await ctx.env.DB.prepare(`UPDATE inquiries SET status = COALESCE(?1, status), ${APPEND("admin_note")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?3`)
      .bind(v.status, note, v.inquiry_id).run();
    await auditAgent(ctx.env.DB, ctx.agent.id, null, "update", "inquiry", String(v.inquiry_id), { status: v.status, note: !!note, action_id: ctx.actionId });
    return { ok: true, result: await ctx.env.DB.prepare("SELECT id, status, admin_note, updated_at FROM inquiries WHERE id = ?").bind(v.inquiry_id).first() };
  }
};

// ---------- Read tools (discoverable GET endpoints) ----------

const read = (name: string, scope: ApiScope, path: string, label: string, description: string): ReadTool =>
  ({ name, tier: "read", scope, label, description, endpoint: { method: "GET", path } });

export const TOOLS: Tool[] = [
  read("get_daily_ops_summary", "reports:read", "/ops/daily-summary", "สรุปงานประจำวัน", "งานที่ต้องทำวันนี้: รอบอบรมใกล้ถึง ผู้สมัครรอตรวจ สลิปรอยืนยัน ข้อความติดต่อใหม่ lead ใหม่ อีเมลส่งไม่สำเร็จ และงานของ agent ที่รออนุมัติ"),
  read("get_report_summary", "reports:read", "/reports/summary", "รายงานสรุปช่วงเวลา", "ตัวเลขช่วงวันที่ ?from=YYYY-MM-DD&to=YYYY-MM-DD: ผู้ใช้ใหม่ การลงทะเบียนเรียน รายได้ ผู้สมัครอบรม lead และข้อความติดต่อ"),
  read("list_training_sessions", "sessions:read", "/training-sessions", "รอบอบรม", "รอบอบรมพร้อมที่นั่งคงเหลือ กรอง ?status= ?from= ?to="),
  read("list_registrations", "registrations:read", "/registrations", "ผู้สมัครรอบอบรม", "ผู้สมัคร กรอง ?session_id= ?status= ?since="),
  read("list_leads", "leads:read", "/leads", "lead", "lead จากฟอร์ม กรอง ?status= ?form_id= ?since="),
  read("list_inquiries", "inquiries:read", "/inquiries", "ข้อความติดต่อ", "ข้อความจากฟอร์มติดต่อ กรอง ?status= ?since="),
  read("list_orders", "orders:read", "/orders", "คำสั่งซื้อ", "คำสั่งซื้อคอร์ส กรอง ?status="),
  read("list_courses", "courses:read", "/courses", "คอร์ส", "คอร์สที่เผยแพร่แล้ว"),
  read("list_users", "users:read", "/users", "ผู้ใช้", "ผู้ใช้ กรอง ?email="),
  read("list_enrollments", "enrollments:read", "/enrollments", "การลงทะเบียนเรียน", "กรอง ?user_id= ?course_id= ?status="),
  read("get_events", "events:read", "/events", "ฟีดเหตุการณ์", "เหตุการณ์ใหม่ตั้งแต่ ?since=<next_since> (agent ดึงเอง ไม่ต้องเปิดรับ webhook)"),
  updateLead, updateInquiry,
  confirmOrder, updateRegistration, publishSession, publishArticle, grantEnrollment, sendEmailTool, sendLine
];

export const toolByName = (name: unknown): Tool | undefined => typeof name === "string" ? TOOLS.find(t => t.name === name) : undefined;
export const isWriteTool = (tool: Tool): tool is WriteTool => tool.tier !== "read";

/** Catalog entry (GET /v1/tools): JSON Schema input, so MCP clients can use it as is later. */
export function describeTool(tool: Tool) {
  const base = { name: tool.name, tier: tool.tier, scope: tool.scope, label: tool.label, description: tool.description };
  if (!isWriteTool(tool)) return { ...base, requires_approval: false, endpoint: tool.endpoint };
  const properties = Object.fromEntries(Object.entries(tool.params).map(([key, p]) => [key, {
    type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}), ...(p.max ? { maxLength: p.max } : {})
  }]));
  return {
    ...base, requires_approval: tool.tier === "act", approver_permission: tool.approverPermission ?? null,
    endpoint: { method: "POST", path: "/actions" },
    input_schema: { type: "object", additionalProperties: false, required: Object.entries(tool.params).filter(([, p]) => p.required).map(([k]) => k), properties }
  };
}

// ---------- Queue ----------

export interface ActionRow {
  id: string; api_key_id: string; tool: string; tier: "draft" | "act"; input_json: string; input_hash: string; idempotency_key: string | null;
  summary: string; preview_json: string | null; reason: string | null; status: string; result_json: string | null; error: string | null;
  decided_by: string | null; decided_at: string | null; decision_note: string | null; executed_at: string | null; expires_at: string; created_at: string; updated_at: string;
  api_key_name?: string; decided_by_name?: string | null;
}

const safeJson = (text: string | null) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

export function presentAction(row: ActionRow, forStaff = false) {
  return {
    id: row.id, tool: row.tool, tier: row.tier, status: row.status, summary: row.summary, reason: row.reason,
    input: safeJson(row.input_json), preview: safeJson(row.preview_json), result: safeJson(row.result_json), error: row.error,
    idempotency_key: row.idempotency_key, requires_approval: row.tier === "act",
    decided_at: row.decided_at, decision_note: row.decision_note, executed_at: row.executed_at, expires_at: row.expires_at,
    created_at: row.created_at, updated_at: row.updated_at,
    ...(forStaff ? { api_key_id: row.api_key_id, agent_name: row.api_key_name ?? null, decided_by_name: row.decided_by_name ?? null } : {})
  };
}

export const ACTION_SELECT = `SELECT a.*, k.name AS api_key_name, u.name AS decided_by_name FROM agent_actions a
  JOIN api_keys k ON k.id = a.api_key_id LEFT JOIN users u ON u.id = a.decided_by`;

/** Lets the agent see the outcome in GET /v1/events (event "action.updated"). */
export async function actionEvent(db: D1Database, row: Pick<ActionRow, "id" | "api_key_id" | "tool">, status: string) {
  await trackEvent(db, null, "agent_action", { data: { action_id: row.id, api_key_id: row.api_key_id, tool: row.tool, status } });
}

const nowIso = () => new Date().toISOString();

/** Runs a claimed action (status executing): re-checks the target, executes and records the outcome. */
export async function runAction(ctx: ExecContext, row: ActionRow): Promise<void> {
  const db = ctx.env.DB;
  const tool = toolByName(row.tool);
  let status = "failed";
  let error: string | null = null;
  let result: unknown = null;
  let previewJson = row.preview_json;
  try {
    if (!tool || !isWriteTool(tool)) throw new Error("ไม่รู้จักเครื่องมือนี้แล้ว");
    const value = tool.parse(safeJson(row.input_json) ?? {});
    if ("error" in value) throw new Error(String(value.error));
    const preview = await tool.preview(ctx.env, value);
    if (isFailure(preview)) {
      error = `ข้อมูลเปลี่ยนไปหลังส่งคำขอ: ${preview.error}`;
    } else {
      previewJson = JSON.stringify(preview);
      const outcome = await tool.execute(ctx, value, preview);
      status = outcome.ok ? "executed" : "failed";
      error = outcome.ok ? null : outcome.error ?? "ทำรายการไม่สำเร็จ";
      result = outcome.result ?? null;
    }
  } catch (err) {
    console.error("Agent action failed:", err);
    error = err instanceof Error ? err.message : "เกิดข้อผิดพลาดภายในระบบ";
  }
  await db.prepare(`UPDATE agent_actions SET status = ?, error = ?, result_json = ?, preview_json = ?, executed_at = ?, updated_at = ? WHERE id = ?`)
    .bind(status, error?.slice(0, 1000) ?? null, result === null ? null : JSON.stringify(result).slice(0, 8000), previewJson, nowIso(), nowIso(), row.id).run();
  await auditAgent(db, row.api_key_id, ctx.approver?.id ?? null, status === "executed" ? "agent_execute" : "agent_failed", "agent_action", row.id,
    { tool: row.tool, summary: row.summary, error });
  await actionEvent(db, row, status);
}

/** Pending actions past their expiry become expired (lazily on reads, and by the daily job). */
export async function expireActions(db: D1Database): Promise<number> {
  const due = await db.prepare("SELECT id, api_key_id, tool FROM agent_actions WHERE status = 'pending' AND expires_at < ? LIMIT 200")
    .bind(nowIso()).all<{ id: string; api_key_id: string; tool: string }>();
  for (const row of due.results) {
    const res = await db.prepare("UPDATE agent_actions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(nowIso(), row.id).run();
    if (res.meta.changes) await actionEvent(db, row, "expired");
  }
  return due.results.length;
}

/** Daily job: expire old requests and keep 90 days of agent activity. */
export async function runAgentJobs(env: { DB: D1Database }): Promise<void> {
  await expireActions(env.DB);
  await env.DB.prepare("DELETE FROM agent_activity WHERE created_at < ?").bind(new Date(Date.now() - 90 * 86_400_000).toISOString()).run();
}

export { isFailure };
