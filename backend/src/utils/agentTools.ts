import type { Env } from "../middleware/rbac";
import type { ApiScope } from "../middleware/apikey";
import type { Permission } from "./permissions";
import { dispatchInternal } from "./dispatch";
import { deliver, emailFrame, escapeHtml } from "./email";
import { lineConfigured, linePushText, LineEnv } from "./line";
import { checkEnrollment, enrollLearner, parseEnrollmentInput, EnrollmentInput } from "./enrollment";
import { trackEvent } from "./events";
import { sha256Hex } from "./secretbox";
import { checkAgentSession, insertAgentArticle, insertAgentSession, parseAgentArticle, parseAgentSession } from "../handlers/site";

/**
 * Agent tools, in three tiers:
 *   read   GET endpoints of /api/v1, listed here so an agent (or a future MCP server) can discover them
 *   draft  internal-only changes nobody outside sees (lead/inquiry status and notes, draft training
 *          sessions and articles that are not public until publish_session / publish_article); run at once
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

/** excerpts: text the approver should read in full before deciding (shown as quotes in the queue). */
export interface Preview { summary: string; target: Record<string, unknown>; warnings: string[]; excerpts?: { label: string; text: string }[] }
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
export interface ReadTool extends ToolBase { tier: "read"; endpoint: { method: "GET"; path: string }; params: Record<string, ParamSpec> }
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
      target: { registration_id: reg.id, session_id: reg.session_id, name: reg.name, email: reg.email, status: reg.status, attendees: reg.attendees, seats_left: Math.max(0, reg.capacity - reg.others), seats_ok: !holds || reg.others + reg.attendees <= reg.capacity },
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

const answerLessonQuestion: WriteTool<Parsed> = {
  name: "answer_lesson_question", tier: "act", scope: "qa:answer", approverPermission: "community.moderate",
  label: "ตอบคำถามในบทเรียน",
  description: "ร่างคำตอบคำถามของผู้เรียนใต้บทเรียน (ดูคำถามจาก list_lesson_questions) ผู้อนุมัติต้องเป็นผู้สอนของคอร์สหรือผู้ดูแลระบบ คำตอบจะโพสต์ในชื่อผู้อนุมัติ ผู้อนุมัติแก้ข้อความไม่ได้ ถ้าต้องแก้ให้ปฏิเสธพร้อมหมายเหตุ",
  params: {
    question_id: { type: "string", required: true, max: 100, description: "id คำถาม (qa_…) ต้องเป็นคำถามหลัก ไม่ใช่คำตอบ" },
    answer: { type: "string", required: true, max: 5000, description: "คำตอบที่จะโพสต์ อ้างอิงเนื้อหาบทเรียนหรือคำตอบเดิมของผู้สอน ถ้าไม่แน่ใจให้บอกว่าจะส่งต่อผู้สอน" }
  },
  parse(raw) { return parseParams(this.params, raw); },
  async preview(env, v) {
    const q = await env.DB.prepare(`SELECT q.id, q.parent_id, q.lesson_id, q.content, u.name AS asker_name, l.title AS lesson_title,
        co.title AS course_title, co.instructor_id, iu.name AS instructor_name,
        (SELECT COUNT(*) FROM lesson_qa r WHERE r.parent_id = q.id AND r.user_id <> q.user_id AND (r.user_id = co.instructor_id OR
          EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = r.user_id AND ur.role IN ('admin', 'coordinator', 'instructor'))))
          AS staff_replies
      FROM lesson_qa q JOIN users u ON u.id = q.user_id JOIN lessons l ON l.id = q.lesson_id JOIN courses co ON co.id = l.course_id
      LEFT JOIN users iu ON iu.id = co.instructor_id WHERE q.id = ?`).bind(v.question_id)
      .first<{ id: string; parent_id: string | null; lesson_id: string; content: string; asker_name: string; lesson_title: string;
        course_title: string; instructor_id: string | null; instructor_name: string | null; staff_replies: number }>();
    if (!q) return fail(404, "not_found", "ไม่พบคำถาม");
    if (q.parent_id) return fail(422, "not_a_question", "id นี้เป็นคำตอบ ให้ส่ง id ของคำถามหลัก");
    const warnings = ["คำตอบจะแสดงในชื่อผู้อนุมัติ ผู้อนุมัติต้องเป็นผู้สอนของคอร์สนี้หรือผู้ดูแลระบบ"];
    if (q.staff_replies > 0) warnings.push(`คำถามนี้มีคำตอบจากผู้สอนหรือเจ้าหน้าที่แล้ว ${q.staff_replies} ข้อความ`);
    return {
      summary: `ตอบคำถามของ ${q.asker_name} ในบทเรียน "${q.lesson_title}" (${q.course_title})`,
      target: { question_id: q.id, lesson_id: q.lesson_id, course_title: q.course_title, lesson_title: q.lesson_title,
        instructor_name: q.instructor_name },
      excerpts: [{ label: `คำถามของ ${q.asker_name}`, text: q.content.slice(0, 2000) }, { label: "คำตอบที่ agent ร่าง (จะโพสต์ตามนี้)", text: String(v.answer) }],
      warnings
    };
  },
  async execute(ctx, v, preview) {
    const lessonId = String(preview.target.lesson_id);
    const out = await viaStaffRoute(ctx, "POST", `/lessons/${encodeURIComponent(lessonId)}/qa`, { content: v.answer, parent_id: v.question_id });
    if (!out.ok && out.error?.startsWith("403")) return { ...out, error: "ผู้อนุมัติต้องเป็นผู้สอนของคอร์สนี้หรือผู้ดูแลระบบจึงโพสต์คำตอบได้" };
    return out;
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

type Values = Record<string, any>;
const present = (v: Parsed, skip: string[] = []) => Object.fromEntries(Object.entries(v).filter(([k, value]) => value !== null && !skip.includes(k)));
/** Field rules of the console forms (handlers/site.ts). The stored input stays in tool-param form, so it re-parses. */
const sessionValues = (v: Parsed) => parseAgentSession(present(v));
const articleValues = (v: Parsed) => parseAgentArticle(present(v, ["submit_for_review"]), v.submit_for_review !== false);
const DATE_PARAM = (description: string, required = false): ParamSpec => ({ type: "string", required, max: 10, description });

const draftSession: WriteTool<Parsed> = {
  name: "draft_session", tier: "draft", scope: "sessions:write",
  label: "ร่างรอบอบรมใหม่", description: "สร้างรอบอบรมใหม่เป็นฉบับร่าง (ยังไม่แสดงบนเว็บ) เพื่อให้เจ้าหน้าที่ตรวจ แล้วเปิดรับสมัครด้วย publish_session",
  params: {
    title: { type: "string", required: true, max: 160, description: "ชื่อหลักสูตร" },
    start_date: DATE_PARAM("วันเริ่ม YYYY-MM-DD", true),
    end_date: DATE_PARAM("วันสิ้นสุด YYYY-MM-DD", true),
    capacity: { type: "number", required: true, description: "จำนวนที่นั่ง 1–1000" },
    price: { type: "number", description: "ราคาต่อคน (บาท) ค่าเริ่มต้น 0" },
    mode: { type: "string", enum: ["classroom", "online", "hybrid"], description: "รูปแบบ (ค่าเริ่มต้น classroom)" },
    vendor: { type: "string", max: 40, description: "แบรนด์/หมวด เช่น Cisco" },
    description: { type: "string", max: 2000, description: "รายละเอียด" },
    session_dates: { type: "string", max: 700, description: "วันอบรมเมื่อไม่ต่อเนื่อง คั่นด้วยจุลภาค เช่น 2027-03-01,2027-03-08 (วันแรก/วันสุดท้ายต้องตรงกับวันเริ่ม/วันสิ้นสุด)" },
    time_text: { type: "string", max: 80, description: "เวลาอบรม เช่น 09:00–16:00" },
    location: { type: "string", max: 200, description: "สถานที่" },
    instructor_name: { type: "string", max: 120, description: "ชื่อวิทยากรที่แสดง" },
    instructor_id: { type: "string", max: 80, description: "id บัญชีวิทยากร (ถ้ามี)" },
    course_id: { type: "string", max: 80, description: "id คอร์สออนไลน์ที่เผยแพร่แล้วที่จะเชื่อม" },
    registration_deadline: DATE_PARAM("วันปิดรับสมัคร YYYY-MM-DD")
  },
  parse(raw) {
    const v = parseParams(this.params, raw);
    if ("error" in v) return v;
    const parsed = sessionValues(v);
    return "error" in parsed ? parsed : v;
  },
  async preview(env, input) {
    const parsed = sessionValues(input);
    if ("error" in parsed) return fail(422, "invalid_input", parsed.error);
    const v = parsed.values;
    const checked = await checkAgentSession(env.DB, v);
    if ("error" in checked) return fail(422, "invalid_input", checked.error);
    const dates = v.start_date === v.end_date ? v.start_date : `${v.start_date} ถึง ${v.end_date}`;
    return { summary: `ร่างรอบอบรม "${v.title}" ${dates} ${v.capacity} ที่นั่ง ราคา ${baht(v.price)} (ฉบับร่าง ยังไม่แสดงบนเว็บ)`,
      target: { title: v.title, start_date: v.start_date, end_date: v.end_date, status: "draft" }, warnings: checked.warnings };
  },
  async execute(ctx, input) {
    const parsed = sessionValues(input);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    const v = parsed.values;
    const session = await insertAgentSession(ctx.env.DB, v);
    const id = String(session?.id ?? "");
    await auditAgent(ctx.env.DB, ctx.agent.id, null, "create", "session", id, { title: v.title, start_date: v.start_date, status: "draft", action_id: ctx.actionId });
    return { ok: true, result: { session } };
  }
};

const draftArticle: WriteTool<Parsed> = {
  name: "draft_article", tier: "draft", scope: "articles:write",
  label: "ร่างบทความ", description: "สร้างบทความใหม่ (เนื้อหา Markdown) เป็นฉบับร่างหรือส่งตรวจ ไม่แสดงบนเว็บจนกว่าจะเผยแพร่ด้วย publish_article หรือเจ้าหน้าที่กดเผยแพร่",
  params: {
    title: { type: "string", required: true, max: 200, description: "หัวข้อ" },
    body: { type: "string", required: true, max: 200_000, description: "เนื้อหาแบบ Markdown (ไม่ต้องใส่ชื่อเรื่องเป็น # หัวข้อซ้ำ เพราะหน้าเว็บแสดงชื่อเรื่องให้แล้ว)" },
    excerpt: { type: "string", max: 300, description: "คำโปรย" },
    category: { type: "string", max: 40, description: "หมวด" },
    slug: { type: "string", max: 80, description: "ลิงก์บทความ a-z 0-9 และ - (เว้นว่างให้ระบบตั้งให้)" },
    cover_url: { type: "string", max: 500, description: "URL รูปปก (https)" },
    submit_for_review: { type: "boolean", description: "ส่งเข้าคิวตรวจของเจ้าหน้าที่ (ค่าเริ่มต้น true) หรือเก็บเป็นฉบับร่าง" }
  },
  parse(raw) {
    const v = parseParams(this.params, raw);
    if ("error" in v) return v;
    const parsed = articleValues(v);
    return "error" in parsed ? parsed : v;
  },
  async preview(env, input) {
    const parsed = articleValues(input);
    if ("error" in parsed) return fail(422, "invalid_input", parsed.error);
    const v = parsed.values;
    // Without a slug one is generated when the article is created (random suffix, never taken)
    const taken = input.slug ? await env.DB.prepare("SELECT id FROM articles WHERE slug = ?").bind(v.slug).first<{ id: string }>() : null;
    if (taken) return fail(409, "slug_taken", `ลิงก์บทความ ${v.slug} ถูกใช้แล้ว (${taken.id})`);
    const warnings: string[] = [];
    if (String(v.body).length < 300) warnings.push("เนื้อหาสั้นกว่า 300 ตัวอักษร");
    if (!v.excerpt) warnings.push("ยังไม่มีคำโปรย");
    return { summary: `ร่างบทความ "${v.title}"${input.slug ? ` (/blog/${v.slug})` : ""} ${v.status === "review" ? "ส่งเข้าคิวตรวจ" : "เก็บเป็นฉบับร่าง"} ยังไม่เผยแพร่`,
      target: { slug: input.slug ?? null, status: v.status }, warnings };
  },
  async execute(ctx, input) {
    const parsed = articleValues(input);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    const v = parsed.values;
    const article = await insertAgentArticle(ctx.env.DB, v);
    if (article === "slug_taken") return { ok: false, error: `ลิงก์บทความ ${v.slug} ถูกใช้แล้ว` };
    await auditAgent(ctx.env.DB, ctx.agent.id, null, "create", "article", String(article.id), { title: v.title, status: v.status, action_id: ctx.actionId });
    return { ok: true, result: { article } };
  }
};

// ---------- Read tools (discoverable GET endpoints) ----------

const PAGE: Record<string, ParamSpec> = {
  limit: { type: "number", description: "จำนวนต่อหน้า 1–200 (ค่าเริ่มต้น 50)" },
  cursor: { type: "string", max: 200, description: "next_cursor จากหน้าก่อน" }
};
const SINCE: ParamSpec = { type: "string", max: 40, description: "เฉพาะรายการที่แก้ไขตั้งแต่เวลานี้ (ISO 8601)" };
const DATE = (description: string): ParamSpec => ({ type: "string", max: 10, description });

const read = (name: string, scope: ApiScope, path: string, label: string, description: string, params: Record<string, ParamSpec> = {}): ReadTool =>
  ({ name, tier: "read", scope, label, description, endpoint: { method: "GET", path }, params });

export const TOOLS: Tool[] = [
  read("get_daily_ops_summary", "reports:read", "/ops/daily-summary", "สรุปงานประจำวัน", "งานที่ต้องทำวันนี้: รอบอบรมใกล้ถึง ผู้สมัครรอตรวจ สลิปรอยืนยัน ข้อความติดต่อใหม่ lead ใหม่ อีเมลส่งไม่สำเร็จ และงานของ agent ที่รออนุมัติ",
    { date: DATE("วันที่ YYYY-MM-DD (เวลาไทย ค่าเริ่มต้นวันนี้)") }),
  read("get_report_summary", "reports:read", "/reports/summary", "รายงานสรุปช่วงเวลา", "ตัวเลขช่วงวันที่: ผู้ใช้ใหม่ การลงทะเบียนเรียน รายได้ ผู้สมัครอบรม lead และข้อความติดต่อ",
    { from: DATE("วันเริ่ม YYYY-MM-DD"), to: DATE("วันสิ้นสุด YYYY-MM-DD") }),
  read("list_training_sessions", "sessions:read", "/training-sessions", "รอบอบรม", "รอบอบรมพร้อมที่นั่งคงเหลือ",
    { status: { type: "string", enum: ["draft", "open", "closed", "cancelled"], description: "สถานะ" }, from: DATE("จบไม่ก่อนวันนี้ YYYY-MM-DD"), to: DATE("เริ่มไม่หลังวันนี้ YYYY-MM-DD"), ...PAGE }),
  read("list_registrations", "registrations:read", "/registrations", "ผู้สมัครรอบอบรม", "ผู้สมัครรอบอบรม",
    { session_id: { type: "string", max: 100, description: "id รอบอบรม" }, status: { type: "string", enum: REG_STATUSES, description: "สถานะ" }, since: SINCE, ...PAGE }),
  read("list_leads", "leads:read", "/leads", "lead", "lead จากฟอร์มบนเว็บไซต์",
    { status: { type: "string", enum: ["new", "contacted", "qualified", "converted", "lost"], description: "สถานะ" }, form_id: { type: "string", max: 100, description: "id ฟอร์ม" }, since: SINCE, ...PAGE }),
  read("list_inquiries", "inquiries:read", "/inquiries", "ข้อความติดต่อ", "ข้อความจากฟอร์มติดต่อ",
    { status: { type: "string", enum: ["new", "in_progress", "closed"], description: "สถานะ" }, since: SINCE, ...PAGE }),
  read("list_orders", "orders:read", "/orders", "คำสั่งซื้อ", "คำสั่งซื้อคอร์ส",
    { status: { type: "string", enum: ["pending", "partial", "paid", "rejected", "cancelled", "expired", "refunded"], description: "สถานะ" }, ...PAGE }),
  read("list_courses", "courses:read", "/courses", "คอร์ส", "คอร์สที่เผยแพร่แล้ว", { ...PAGE }),
  read("list_users", "users:read", "/users", "ผู้ใช้", "ผู้ใช้ในระบบ", { email: { type: "string", max: 254, description: "ค้นด้วยอีเมล" }, ...PAGE }),
  read("list_enrollments", "enrollments:read", "/enrollments", "การลงทะเบียนเรียน", "การลงทะเบียนเรียนคอร์ส",
    { user_id: { type: "string", max: 100, description: "id ผู้เรียน" }, course_id: { type: "string", max: 100, description: "id คอร์ส" }, status: { type: "string", enum: ["active", "suspended", "completed"], description: "สถานะ" }, ...PAGE }),
  read("list_lesson_questions", "qa:read", "/lesson-questions", "คำถามในบทเรียน",
    "คำถามของผู้เรียนใต้บทเรียน พร้อมคำตอบเดิม (author_type: instructor / staff / learner) และเนื้อหาบทเรียนแบบข้อความ (lesson_text, เฉพาะบทเรียนข้อความ) ใช้ status=unanswered หาคำถามที่ยังไม่มีผู้สอนตอบ",
    { status: { type: "string", enum: ["unanswered", "answered"], description: "unanswered = ยังไม่มีผู้สอนหรือเจ้าหน้าที่ตอบ" }, course_id: { type: "string", max: 100, description: "id คอร์ส" },
      lesson_id: { type: "string", max: 100, description: "id บทเรียน" }, since: { type: "string", max: 40, description: "เฉพาะคำถามที่ถามตั้งแต่เวลานี้ (ISO 8601)" }, ...PAGE }),
  read("get_events", "events:read", "/events", "ฟีดเหตุการณ์", "เหตุการณ์ใหม่ตั้งแต่ since (ส่ง next_since จากครั้งก่อน) เช่น registration.created inquiry.created order.paid action.updated",
    { since: { type: "string", max: 15, description: "next_since จากครั้งก่อน (ว่าง = 24 ชั่วโมงล่าสุด)" }, types: { type: "string", max: 300, description: "ชื่อเหตุการณ์คั่นด้วยจุลภาค" }, limit: { type: "number", description: "สูงสุด 500" } }),
  updateLead, updateInquiry, draftSession, draftArticle,
  confirmOrder, updateRegistration, publishSession, publishArticle, grantEnrollment, answerLessonQuestion, sendEmailTool, sendLine
];

export const toolByName = (name: unknown): Tool | undefined => typeof name === "string" ? TOOLS.find(t => t.name === name) : undefined;
export const isWriteTool = (tool: Tool): tool is WriteTool => tool.tier !== "read";

/** JSON Schema for a parameter list (GET /v1/tools and the MCP tool list). */
export function jsonSchemaFor(params: Record<string, ParamSpec>, extra: Record<string, unknown> = {}) {
  const properties: Record<string, unknown> = Object.fromEntries(Object.entries(params).map(([key, p]) => [key, {
    type: p.type, description: p.description, ...(p.enum ? { enum: [...p.enum] } : {}), ...(p.max && p.type === "string" ? { maxLength: p.max } : {})
  }]));
  return {
    type: "object" as const, additionalProperties: false, properties: { ...properties, ...extra },
    required: Object.entries(params).filter(([, p]) => p.required).map(([k]) => k)
  };
}

/** Catalog entry (GET /v1/tools): JSON Schema input, used as is by the MCP server. */
export function describeTool(tool: Tool) {
  const base = { name: tool.name, tier: tool.tier, scope: tool.scope, label: tool.label, description: tool.description, input_schema: jsonSchemaFor(tool.params) };
  if (!isWriteTool(tool)) return { ...base, requires_approval: false, endpoint: tool.endpoint };
  return { ...base, requires_approval: tool.tier === "act", approver_permission: tool.approverPermission ?? null, endpoint: { method: "POST", path: "/actions" } };
}

// ---------- Queue ----------

export interface ActionRow {
  id: string; api_key_id: string; tool: string; tier: "draft" | "act"; input_json: string; input_hash: string; idempotency_key: string | null;
  summary: string; preview_json: string | null; reason: string | null; status: string; result_json: string | null; error: string | null;
  decided_by: string | null; decided_at: string | null; decision_note: string | null; executed_at: string | null; expires_at: string; created_at: string; updated_at: string;
  auto_rule_id?: string | null; api_key_name?: string; decided_by_name?: string | null;
}

const safeJson = (text: string | null) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

export function presentAction(row: ActionRow, forStaff = false) {
  return {
    id: row.id, tool: row.tool, tier: row.tier, status: row.status, summary: row.summary, reason: row.reason,
    input: safeJson(row.input_json), preview: safeJson(row.preview_json), result: safeJson(row.result_json), error: row.error,
    idempotency_key: row.idempotency_key, requires_approval: row.tier === "act", auto_approved: !!row.auto_rule_id,
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

// ---------- Phase 4: auto-approval rules ----------

/**
 * Conditions an admin can set per act tool. A request from the rule's agent key that meets them
 * (checked against the fresh preview) runs at once as the rule's creator, up to max_per_day a day.
 * Anything else still waits for a person. There is deliberately no "anything goes" rule.
 */
export interface ConditionSpec { type: "boolean" | "number" | "list"; label: string; options?: readonly string[]; default?: unknown; required?: boolean }

type Conditions = Record<string, unknown>;
type Check = (c: Conditions, input: Record<string, unknown>, preview: Preview) => string | null;

const listOf = (value: unknown) => Array.isArray(value) ? value.map(String) : [];

export const AUTONOMY: Record<string, { conditions: Record<string, ConditionSpec>; check: Check }> = {
  confirm_order: {
    conditions: {
      require_slip: { type: "boolean", label: "ต้องมีสลิปแนบแล้ว", default: true },
      exact_amount: { type: "boolean", label: "ยอดที่ได้รับต้องเท่ากับยอดที่ต้องชำระพอดี", default: true },
      max_amount: { type: "number", label: "ยอดคำสั่งซื้อสูงสุด (บาท)", required: true }
    },
    check: (c, input, p) => {
      if (c.require_slip !== false && !p.target.slip_uploaded) return "ยังไม่มีสลิป";
      if (c.exact_amount !== false && Number(input.amount_received) !== Number(p.target.amount)) return "ยอดไม่ตรง";
      if (Number(p.target.amount) > Number(c.max_amount)) return "ยอดเกินที่กำหนด";
      return null;
    }
  },
  update_registration: {
    conditions: {
      statuses: { type: "list", label: "สถานะใหม่ที่อนุญาต", options: REG_STATUSES, required: true },
      allow_notify: { type: "boolean", label: "อนุญาตให้ส่งอีเมลแจ้งผู้สมัคร", default: false }
    },
    check: (c, input, p) => {
      if (!listOf(c.statuses).includes(String(input.status))) return "สถานะนี้ไม่อยู่ในกฎ";
      if (p.target.seats_ok === false) return "ที่นั่งไม่พอ";
      if (input.notify !== false && c.allow_notify !== true && ["confirmed", "paid", "cancelled"].includes(String(input.status))) return "กฎไม่อนุญาตให้ส่งอีเมล";
      return null;
    }
  },
  publish_session: {
    conditions: { statuses: { type: "list", label: "สถานะใหม่ที่อนุญาต", options: ["open", "closed", "cancelled"], required: true } },
    check: (c, input, p) => !listOf(c.statuses).includes(String(input.status)) ? "สถานะนี้ไม่อยู่ในกฎ" : p.warnings.length ? "มีคำเตือน" : null
  },
  publish_article: {
    conditions: {},
    check: (_c, _input, p) => p.warnings.length ? "มีคำเตือน" : null
  },
  grant_enrollment: {
    conditions: {
      course_ids: { type: "list", label: "คอร์สที่อนุญาต (id)", required: true },
      new_only: { type: "boolean", label: "เฉพาะผู้ที่ยังไม่เคยลงทะเบียนคอร์สนี้", default: true }
    },
    check: (c, _input, p) => {
      if (!listOf(c.course_ids).includes(String(p.target.course_id))) return "คอร์สนี้ไม่อยู่ในกฎ";
      if (c.new_only !== false && p.target.existing_status) return "เคยลงทะเบียนแล้ว";
      return null;
    }
  },
  send_email: {
    conditions: { contact_sources: { type: "list", label: "ผู้รับที่อนุญาต", options: ["user", "registration", "inquiry", "lead"], required: true } },
    check: (c, _input, p) => !listOf(c.contact_sources).includes(String(p.target.contact_source)) ? "ผู้รับประเภทนี้ไม่อยู่ในกฎ" : p.warnings.length ? "มีคำเตือน" : null
  },
  send_line: {
    conditions: {},
    check: (_c, _input, p) => p.warnings.length ? "มีคำเตือน" : null
  }
};

/** Validates and fills defaults; returns an error message or the normalized conditions. */
export function parseConditions(tool: string, raw: unknown): Conditions | string {
  const def = AUTONOMY[tool];
  if (!def) return "เครื่องมือนี้ตั้งอนุมัติอัตโนมัติไม่ได้";
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const unknown = Object.keys(input).filter(k => !(k in def.conditions));
  if (unknown.length) return `ไม่รู้จักเงื่อนไข ${unknown.join(", ")}`;
  const out: Conditions = {};
  for (const [key, spec] of Object.entries(def.conditions)) {
    const value = input[key] ?? spec.default;
    if (value === undefined || value === null || value === "" || (spec.type === "list" && Array.isArray(value) && !value.length)) {
      if (spec.required) return `ต้องระบุเงื่อนไข: ${spec.label}`;
      continue;
    }
    if (spec.type === "boolean") {
      if (typeof value !== "boolean") return `${spec.label} ต้องเป็น true/false`;
      out[key] = value;
    } else if (spec.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return `${spec.label} ต้องเป็นตัวเลข`;
      out[key] = n;
    } else {
      if (!Array.isArray(value) || value.length > 50) return `${spec.label} ต้องเป็นรายการ (ไม่เกิน 50)`;
      const items = [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
      if (spec.options && items.some(i => !spec.options!.includes(i))) return `${spec.label} ต้องเป็นค่าใน ${spec.options.join(", ")}`;
      if (items.some(i => i.length > 100)) return `${spec.label} ยาวเกินไป`;
      out[key] = items;
    }
  }
  return out;
}

export interface RuleRow {
  id: string; api_key_id: string; tool: string; conditions_json: string; max_per_day: number; enabled: number; note: string | null;
  created_by: string; created_at: string; updated_at: string;
}

/** Start of today in Asia/Bangkok as an ISO instant (daily caps). */
export function bangkokDayStart(now = new Date()): string {
  const t = new Date(now.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - 7 * 3_600_000).toISOString();
}

/** First enabled rule of this key and tool whose conditions hold and whose daily cap has room. */
export async function matchingRule(db: D1Database, apiKeyId: string, tool: string, input: Record<string, unknown>, preview: Preview): Promise<RuleRow | null> {
  const def = AUTONOMY[tool];
  if (!def) return null;
  const rules = await db.prepare("SELECT * FROM agent_autonomy_rules WHERE api_key_id = ? AND tool = ? AND enabled = 1 ORDER BY created_at")
    .bind(apiKeyId, tool).all<RuleRow>();
  for (const rule of rules.results) {
    const conditions = safeJson(rule.conditions_json) ?? {};
    if (def.check(conditions, input, preview) !== null) continue;
    const used = await db.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE auto_rule_id = ? AND decided_at >= ?")
      .bind(rule.id, bangkokDayStart()).first<{ n: number }>();
    if ((used?.n ?? 0) < rule.max_per_day) return rule;
  }
  return null;
}
