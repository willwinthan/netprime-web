import { Hono, Context } from "hono";
import { apiKey, ApiEnv, bangkokClock } from "../middleware/apikey";
import { listResponse, page } from "../utils/apiPaging";
import {
  ACTION_SELECT, ActionRow, TOOLS, describeTool, expireActions, inputHash, isFailure, isWriteTool, presentAction, toolByName, runAction, actionEvent
} from "../utils/agentTools";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_NAMES } from "../utils/webhooks";
import { matchingRule, auditAgent, RuleRow, type WriteTool } from "../utils/agentTools";
import { parseRoles, permissionsForRoles, primaryRole, rolesColumn } from "../utils/permissions";
import jwt from "@tsndr/cloudflare-worker-jwt";

/**
 * Agent-facing part of /api/v1 (mounted into publicApiRouter). Read endpoints for the coordinator's
 * work (training rounds, registrants, leads, inquiries, reports, a daily ops summary), the tool
 * catalog, the action queue (POST /v1/actions with dry_run and idempotency keys) and a pull-based
 * event feed (GET /v1/events?since=) for agents that must not expose a webhook receiver, such as a
 * model running on an office machine. See docs/AGENT-PLATFORM.md.
 */
export const agentApiRouter = new Hono<ApiEnv>();

const nowIso = () => new Date().toISOString();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOLD_SQL = "'pending', 'confirmed', 'paid', 'attended'";
const MAX_PENDING_PER_KEY = 100;

/** ?since=<ISO date-time> → the "YYYY-MM-DD HH:MM:SS" form CURRENT_TIMESTAMP columns use (UTC). */
function sinceParam(c: Context<ApiEnv>): string | null | false {
  const raw = c.req.query("since");
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

const badSince = (c: Context<ApiEnv>) => c.json({ error: "since ต้องเป็นวันเวลา ISO 8601", code: "invalid_request" }, 400);
const short = (value: string | undefined, max = 100) => value ? value.slice(0, max) : null;

// ---------- Key info and tool catalog ----------

agentApiRouter.get("/me", apiKey(), async (c) => {
  const key = c.get("apiKey");
  const row = await c.env.DB.prepare("SELECT allowed_hours, allowed_days, allowed_ips, expires_at FROM api_keys WHERE id = ?").bind(key.id)
    .first<{ allowed_hours: string | null; allowed_days: string | null; allowed_ips: string | null; expires_at: string | null }>();
  const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE api_key_id = ? AND status = 'pending'").bind(key.id).first<{ n: number }>();
  return c.json({
    data: {
      id: key.id, name: key.name, kind: key.kind, scopes: key.scopes, rate_limit_per_minute: key.rate_limit_per_minute, daily_limit: key.daily_limit,
      allowed_hours: row?.allowed_hours ?? null, allowed_days: row?.allowed_days ?? null, ip_restricted: !!row?.allowed_ips,
      expires_at: row?.expires_at ?? null, timezone: "Asia/Bangkok", pending_actions: pending?.n ?? 0
    }
  });
});

/** Every tool, marked with whether this key may use it. */
agentApiRouter.get("/tools", apiKey(), (c) => {
  const scopes = new Set<string>(c.get("apiKey").scopes);
  return c.json({ data: TOOLS.map(t => ({ ...describeTool(t), available: scopes.has(t.scope) })) });
});

// ---------- Training rounds ----------

const SESSION_FIELDS = `s.id, s.course_id, s.title, s.vendor, s.start_date, s.end_date, s.time_text, s.mode, s.location, s.instructor_name,
  s.price, s.capacity, s.registration_deadline, s.status, s.created_at, s.updated_at,
  (SELECT COALESCE(SUM(r.attendees), 0) FROM session_registrations r WHERE r.session_id = s.id AND r.status IN (${HOLD_SQL})) AS seats_taken,
  (SELECT COUNT(*) FROM session_registrations r WHERE r.session_id = s.id AND r.status = 'pending') AS pending_registrations,
  (SELECT COUNT(*) FROM session_registrations r WHERE r.session_id = s.id AND r.status = 'waitlist') AS waitlist`;

const shapeSession = (row: Record<string, any>): Record<string, any> => ({ ...row, seats_left: Math.max(0, Number(row.capacity) - Number(row.seats_taken)) });

agentApiRouter.get("/training-sessions", apiKey("sessions:read"), async (c) => {
  const p = page(c);
  if (p instanceof Response) return p;
  const from = c.req.query("from"), to = c.req.query("to"), status = c.req.query("status");
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) return c.json({ error: "from/to ต้องเป็น YYYY-MM-DD", code: "invalid_request" }, 400);
  const rows = await c.env.DB.prepare(`SELECT ${SESSION_FIELDS} FROM training_sessions s
    WHERE s.id > ? AND (? IS NULL OR s.status = ?) AND (? IS NULL OR s.end_date >= ?) AND (? IS NULL OR s.start_date <= ?)
    ORDER BY s.id LIMIT ?`).bind(p.after, short(status, 20), short(status, 20), from ?? null, from ?? null, to ?? null, to ?? null, p.limit + 1)
    .all<Record<string, any> & { id: string }>();
  return listResponse(c, rows.results.map(r => shapeSession(r) as any), p.limit);
});

agentApiRouter.get("/training-sessions/:id", apiKey("sessions:read"), async (c) => {
  const row = await c.env.DB.prepare(`SELECT ${SESSION_FIELDS}, s.description FROM training_sessions s WHERE s.id = ?`).bind(c.req.param("id")).first<Record<string, any>>();
  if (!row) return c.json({ error: "ไม่พบรอบอบรม", code: "not_found" }, 404);
  return c.json({ data: shapeSession(row) });
});

// ---------- Registrants, leads, inquiries ----------

agentApiRouter.get("/registrations", apiKey("registrations:read"), async (c) => {
  const p = page(c);
  if (p instanceof Response) return p;
  const since = sinceParam(c);
  if (since === false) return badSince(c);
  const sessionId = short(c.req.query("session_id")), status = short(c.req.query("status"), 20);
  const rows = await c.env.DB.prepare(`SELECT r.id, r.session_id, s.title AS session_title, s.start_date, r.name, r.email, r.phone, r.company, r.attendees,
      r.status, r.payment_ref, r.invoice_required, r.source, r.user_id, CASE WHEN r.slip_uploaded_at IS NULL THEN 0 ELSE 1 END AS slip_uploaded,
      r.note, r.admin_note, r.created_at, r.updated_at
    FROM session_registrations r JOIN training_sessions s ON s.id = r.session_id
    WHERE r.id > ? AND (? IS NULL OR r.session_id = ?) AND (? IS NULL OR r.status = ?) AND (? IS NULL OR r.updated_at >= ?)
    ORDER BY r.id LIMIT ?`).bind(p.after, sessionId, sessionId, status, status, since, since, p.limit + 1).all<Record<string, any> & { id: string }>();
  return listResponse(c, rows.results.map(r => ({ ...r, invoice_required: !!r.invoice_required, slip_uploaded: !!r.slip_uploaded })), p.limit);
});

agentApiRouter.get("/leads", apiKey("leads:read"), async (c) => {
  const p = page(c);
  if (p instanceof Response) return p;
  const since = sinceParam(c);
  if (since === false) return badSince(c);
  const status = short(c.req.query("status"), 20), formId = short(c.req.query("form_id"));
  const rows = await c.env.DB.prepare(`SELECT l.id, l.form_id, f.name AS form_name, l.name, l.email, l.phone, l.company, l.data_json, l.status, l.notes,
      l.page_path, l.utm_source, l.utm_medium, l.utm_campaign, l.user_id, l.created_at, l.updated_at
    FROM leads l LEFT JOIN lead_forms f ON f.id = l.form_id
    WHERE l.id > ? AND (? IS NULL OR l.status = ?) AND (? IS NULL OR l.form_id = ?) AND (? IS NULL OR l.updated_at >= ?)
    ORDER BY l.id LIMIT ?`).bind(p.after, status, status, formId, formId, since, since, p.limit + 1).all<Record<string, any> & { id: string }>();
  return listResponse(c, rows.results.map(({ data_json, ...r }) => {
    let fields: unknown = null;
    try { fields = data_json ? JSON.parse(data_json) : null; } catch { fields = null; }
    return { ...r, fields } as any;
  }), p.limit);
});

agentApiRouter.get("/inquiries", apiKey("inquiries:read"), async (c) => {
  const p = page(c);
  if (p instanceof Response) return p;
  const since = sinceParam(c);
  if (since === false) return badSince(c);
  const status = short(c.req.query("status"), 20);
  const rows = await c.env.DB.prepare(`SELECT id, name, email, phone, company, topic, message, status, admin_note, created_at, updated_at FROM inquiries
    WHERE id > ? AND (? IS NULL OR status = ?) AND (? IS NULL OR updated_at >= ?) ORDER BY id LIMIT ?`)
    .bind(p.after, status, status, since, since, p.limit + 1).all<{ id: string }>();
  return listResponse(c, rows.results, p.limit);
});

// ---------- Reports ----------

/** Bangkok calendar day [from, to] → UTC bounds in both timestamp formats used by the schema. */
function dayBounds(from: string, to: string) {
  const start = new Date(Date.parse(`${from}T00:00:00+07:00`)).toISOString();
  const end = new Date(Date.parse(`${to}T00:00:00+07:00`) + 86_400_000).toISOString();
  const plain = (iso: string) => iso.slice(0, 19).replace("T", " ");
  return { start, end, startPlain: plain(start), endPlain: plain(end) };
}

agentApiRouter.get("/reports/summary", apiKey("reports:read"), async (c) => {
  const today = bangkokClock().date;
  const from = c.req.query("from") || today, to = c.req.query("to") || from;
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return c.json({ error: "from/to ต้องเป็น YYYY-MM-DD และ to ต้องไม่ก่อน from", code: "invalid_request" }, 400);
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) return c.json({ error: "ช่วงวันที่ยาวได้ไม่เกิน 366 วัน", code: "invalid_request" }, 400);
  const b = dayBounds(from, to);
  const db = c.env.DB;
  const row = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'student' AND staff_role IS NULL AND created_at >= ?1 AND created_at < ?2) AS new_learners,
      (SELECT COUNT(*) FROM enrollments WHERE enrolled_at >= ?1 AND enrolled_at < ?2) AS enrollments,
      (SELECT COUNT(*) FROM enrollments WHERE completed_at >= ?1 AND completed_at < ?2) AS completions,
      (SELECT COUNT(*) FROM course_orders WHERE paid_at >= ?3 AND paid_at < ?4) AS orders_paid,
      (SELECT COALESCE(SUM(COALESCE(amount_received, amount)), 0) FROM course_orders WHERE paid_at >= ?3 AND paid_at < ?4) AS revenue,
      (SELECT COUNT(*) FROM course_orders WHERE created_at >= ?1 AND created_at < ?2) AS orders_created,
      (SELECT COUNT(*) FROM session_registrations WHERE created_at >= ?1 AND created_at < ?2) AS registrations,
      (SELECT COALESCE(SUM(attendees), 0) FROM session_registrations WHERE created_at >= ?1 AND created_at < ?2 AND status != 'cancelled') AS attendees,
      (SELECT COUNT(*) FROM leads WHERE created_at >= ?1 AND created_at < ?2) AS leads,
      (SELECT COUNT(*) FROM inquiries WHERE created_at >= ?1 AND created_at < ?2) AS inquiries`)
    .bind(b.startPlain, b.endPlain, b.start, b.end).first<Record<string, number>>();
  return c.json({ data: { from, to, timezone: "Asia/Bangkok", ...row } });
});

/** get_daily_ops_summary: what a coordinator should look at today, with short Thai highlights. */
agentApiRouter.get("/ops/daily-summary", apiKey("reports:read"), async (c) => {
  const date = c.req.query("date") || bangkokClock().date;
  if (!DATE_RE.test(date)) return c.json({ error: "date ต้องเป็น YYYY-MM-DD", code: "invalid_request" }, 400);
  const week = new Date(Date.parse(`${date}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const b = dayBounds(date, date);
  const db = c.env.DB;
  const key = c.get("apiKey");
  const [sessions, counts, orders] = await Promise.all([
    db.prepare(`SELECT ${SESSION_FIELDS} FROM training_sessions s WHERE s.status = 'open' AND s.start_date >= ? AND s.start_date <= ? ORDER BY s.start_date LIMIT 20`)
      .bind(date, week).all<Record<string, any>>(),
    db.prepare(`SELECT
        (SELECT COUNT(*) FROM session_registrations WHERE status = 'pending') AS registrations_pending,
        (SELECT COUNT(*) FROM session_registrations WHERE status = 'pending' AND slip_uploaded_at IS NOT NULL) AS registrations_with_slip,
        (SELECT COUNT(*) FROM session_registrations WHERE created_at >= ?1 AND created_at < ?2) AS registrations_today,
        (SELECT COUNT(*) FROM inquiries WHERE status = 'new') AS inquiries_new,
        (SELECT MIN(created_at) FROM inquiries WHERE status = 'new') AS oldest_new_inquiry_at,
        (SELECT COUNT(*) FROM leads WHERE status = 'new') AS leads_new,
        (SELECT COUNT(*) FROM leads WHERE created_at >= ?1 AND created_at < ?2) AS leads_today,
        (SELECT COUNT(*) FROM email_log WHERE status = 'failed' AND created_at >= ?1 AND created_at < ?2) AS emails_failed_today,
        (SELECT COUNT(*) FROM course_orders WHERE status = 'pending') AS orders_pending,
        (SELECT COUNT(*) FROM agent_actions WHERE status = 'pending') AS agent_actions_pending,
        (SELECT COUNT(*) FROM agent_actions WHERE status = 'pending' AND api_key_id = ?3) AS my_actions_pending`)
      .bind(b.startPlain, b.endPlain, key.id).first<Record<string, any>>(),
    db.prepare(`SELECT o.id, o.reference, o.amount, o.slip_uploaded_at, o.created_at, COALESCE(o.item_title, co.title) AS title
      FROM course_orders o LEFT JOIN courses co ON co.id = o.course_id
      WHERE o.status = 'pending' AND o.slip_uploaded_at IS NOT NULL ORDER BY o.slip_uploaded_at LIMIT 20`).all<Record<string, any>>()
  ]);
  const upcoming = sessions.results.map(shapeSession);
  const n = counts ?? {};
  const highlights: string[] = [];
  if (orders.results.length) highlights.push(`มีสลิปรอยืนยันการชำระเงิน ${orders.results.length} รายการ`);
  if (n.registrations_pending) highlights.push(`ผู้สมัครรอบอบรมรอตรวจสอบ ${n.registrations_pending} ราย${n.registrations_with_slip ? ` (แนบสลิปแล้ว ${n.registrations_with_slip})` : ""}`);
  if (n.inquiries_new) highlights.push(`ข้อความติดต่อที่ยังไม่ได้ตอบ ${n.inquiries_new} ข้อความ`);
  if (n.leads_new) highlights.push(`lead ใหม่ที่ยังไม่ได้ติดต่อ ${n.leads_new} ราย`);
  for (const s of upcoming) if (s.seats_left === 0) highlights.push(`รอบ ${s.title} (${s.start_date}) ที่นั่งเต็มแล้ว${s.waitlist ? ` มีรอคิว ${s.waitlist} ราย` : ""}`);
  for (const s of upcoming) if (s.seats_taken === 0) highlights.push(`รอบ ${s.title} (${s.start_date}) ยังไม่มีผู้สมัคร`);
  if (n.emails_failed_today) highlights.push(`อีเมลส่งไม่สำเร็จวันนี้ ${n.emails_failed_today} ฉบับ`);
  if (n.agent_actions_pending) highlights.push(`งานของ agent รออนุมัติ ${n.agent_actions_pending} รายการ`);
  return c.json({ data: { date, timezone: "Asia/Bangkok", upcoming_sessions: upcoming, orders_awaiting_confirmation: orders.results, counts: n, highlights } });
});

// ---------- Action queue ----------

const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

async function loadOwnAction(c: Context<ApiEnv>, id: string): Promise<ActionRow | null> {
  return c.env.DB.prepare(`${ACTION_SELECT} WHERE a.id = ? AND a.api_key_id = ?`).bind(id, c.get("apiKey").id).first<ActionRow>();
}

/**
 * POST /v1/actions { tool, input, dry_run?, idempotency_key?, reason?, expires_in_hours? }
 * (or the Idempotency-Key header). dry_run checks and previews only. A draft tool runs at once (201);
 * an act tool is queued for approval (202). Replaying an idempotency key returns the first action
 * (200, replayed: true); the same key with a different tool or input is a 409.
 */
agentApiRouter.post("/actions", apiKey(), async (c) => {
  const key = c.get("apiKey");
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "body ต้องเป็น JSON object", code: "invalid_request" }, 400);
  const tool = toolByName(body.tool);
  if (!tool) return c.json({ error: "ไม่รู้จักเครื่องมือนี้ ดูรายการที่ GET /v1/tools", code: "unknown_tool" }, 404);
  if (!isWriteTool(tool)) return c.json({ error: `เครื่องมืออ่านข้อมูลให้เรียก ${tool.endpoint.method} /v1${tool.endpoint.path} โดยตรง`, code: "read_tool", endpoint: tool.endpoint }, 400);
  if (!key.scopes.includes(tool.scope)) return c.json({ error: `API key นี้ไม่มีสิทธิ์ ${tool.scope}`, code: "insufficient_scope", required_scope: tool.scope }, 403);

  const rawKey = body.idempotency_key ?? c.req.header("Idempotency-Key");
  const idempotencyKey = rawKey === undefined || rawKey === null || rawKey === "" ? null : String(rawKey);
  if (idempotencyKey !== null && !IDEMPOTENCY_RE.test(idempotencyKey)) return c.json({ error: "idempotency_key ใช้ได้เฉพาะ A-Z a-z 0-9 _ . : - ยาวไม่เกิน 100", code: "invalid_request" }, 400);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) || null : null;
  const hours = body.expires_in_hours === undefined ? 72 : Number(body.expires_in_hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) return c.json({ error: "expires_in_hours ต้องเป็น 1–168", code: "invalid_request" }, 400);
  const dryRun = body.dry_run === true;

  const value = tool.parse((body.input ?? {}) as Record<string, unknown>);
  if ("error" in value) return c.json({ error: String(value.error), code: "invalid_input" }, 400);
  const hash = await inputHash(tool.name, value);

  if (idempotencyKey && !dryRun) {
    const existing = await db.prepare(`${ACTION_SELECT} WHERE a.api_key_id = ? AND a.idempotency_key = ?`).bind(key.id, idempotencyKey).first<ActionRow>();
    if (existing) {
      if (existing.tool !== tool.name || existing.input_hash !== hash) {
        return c.json({ error: "idempotency_key นี้ถูกใช้กับคำขออื่นแล้ว", code: "idempotency_conflict", action_id: existing.id }, 409);
      }
      c.header("X-Agent-Action-Id", existing.id);
      return c.json({ data: presentAction(existing), replayed: true }, 200);
    }
  }

  const preview = await tool.preview(c.env, value);
  if (isFailure(preview)) return c.json({ error: preview.error, code: preview.code, tool: tool.name }, preview.status);
  if (dryRun) {
    return c.json({ dry_run: true, tool: tool.name, tier: tool.tier, requires_approval: tool.tier === "act", approver_permission: tool.approverPermission ?? null, preview });
  }

  if (tool.tier === "act") {
    const pending = await db.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE api_key_id = ? AND status = 'pending'").bind(key.id).first<{ n: number }>();
    if ((pending?.n ?? 0) >= MAX_PENDING_PER_KEY) return c.json({ error: `มีงานรออนุมัติครบ ${MAX_PENDING_PER_KEY} รายการแล้ว รอให้เจ้าหน้าที่ตรวจก่อน`, code: "queue_full" }, 429);
  }
  const id = `act_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = nowIso();
  try {
    await db.prepare(`INSERT INTO agent_actions (id, api_key_id, tool, tier, input_json, input_hash, idempotency_key, summary, preview_json, reason, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, key.id, tool.name, tool.tier, JSON.stringify(value), hash, idempotencyKey, preview.summary.slice(0, 500), JSON.stringify(preview), reason,
        tool.tier === "act" ? "pending" : "executing", new Date(Date.now() + hours * 3_600_000).toISOString(), now, now).run();
  } catch (error) {
    // A concurrent request with the same idempotency key won the insert: answer like a replay.
    if (idempotencyKey && String((error as Error)?.message || "").includes("UNIQUE")) {
      const existing = await db.prepare(`${ACTION_SELECT} WHERE a.api_key_id = ? AND a.idempotency_key = ?`).bind(key.id, idempotencyKey).first<ActionRow>();
      if (existing && existing.input_hash === hash && existing.tool === tool.name) return c.json({ data: presentAction(existing), replayed: true }, 200);
      return c.json({ error: "idempotency_key นี้ถูกใช้กับคำขออื่นแล้ว", code: "idempotency_conflict" }, 409);
    }
    throw error;
  }
  c.header("X-Agent-Action-Id", id);
  let row = (await loadOwnAction(c, id))!;
  if (tool.tier === "draft") {
    await runAction({ env: c.env, executionCtx: executionCtxOf(c), agent: { id: key.id, name: key.name }, actionId: id }, row);
    row = (await loadOwnAction(c, id))!;
    return c.json({ data: presentAction(row) }, row.status === "executed" ? 201 : 422);
  }
  const rule = await matchingRule(db, key.id, tool.name, value as Record<string, unknown>, preview);
  if (rule) {
    const done = await autoApprove(c, row, rule, tool);
    if (done) return c.json({ data: presentAction(done), auto_approved: true, rule_id: rule.id }, done.status === "executed" ? 201 : 422);
  }
  return c.json({ data: presentAction(row), requires_approval: true }, 202);
});

/**
 * Phase 4: runs a queued action at once under an auto-approval rule, as the rule's creator. The
 * creator must still be active and hold agents.approve plus the tool's permission; otherwise the
 * action simply stays pending for a person. The staff route gets a two-minute token for the creator.
 */
async function autoApprove(c: Context<ApiEnv>, row: ActionRow, rule: RuleRow, tool: WriteTool): Promise<ActionRow | null> {
  const db = c.env.DB;
  const owner = await db.prepare(`SELECT u.id, u.email, u.name, u.status, u.partner_id, COALESCE(u.staff_role, u.role) AS primary_role, ${rolesColumn("u")} AS role_list
    FROM users u WHERE u.id = ?`).bind(rule.created_by)
    .first<{ id: string; email: string; name: string; status: string; partner_id: string | null; primary_role: string; role_list: string | null }>();
  if (!owner || owner.status !== "active") return null;
  const roles = parseRoles(owner.role_list, owner.primary_role);
  const granted = new Set<string>(await permissionsForRoles(db, roles));
  if (!granted.has("agents.approve") || (tool.approverPermission && !granted.has(tool.approverPermission))) return null;
  const now = nowIso();
  const claimed = await db.prepare(`UPDATE agent_actions SET status = 'executing', decided_by = ?, decided_at = ?, decision_note = ?, auto_rule_id = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'`).bind(owner.id, now, `อนุมัติอัตโนมัติตามกฎ${rule.note ? `: ${rule.note}` : ""}`.slice(0, 500), rule.id, now, row.id).run();
  if (!claimed.meta.changes) return null;
  await auditAgent(db, row.api_key_id, owner.id, "agent_auto_approve", "agent_action", row.id, { tool: row.tool, summary: row.summary, rule_id: rule.id });
  const token = await jwt.sign({ id: owner.id, email: owner.email, name: owner.name, role: primaryRole(roles), roles, partner_id: owner.partner_id,
    exp: Math.floor(Date.now() / 1000) + 120, iat_ms: Date.now(), jti: crypto.randomUUID(), auto_rule_id: rule.id } as any, c.env.JWT_SECRET);
  const key = c.get("apiKey");
  await runAction({ env: c.env, executionCtx: executionCtxOf(c), actionId: row.id, agent: { id: key.id, name: key.name },
    approver: { id: owner.id, name: owner.name, authorization: `Bearer ${token}` } }, row);
  return loadOwnAction(c, row.id);
}

function executionCtxOf(c: Context<ApiEnv>): ExecutionContext | undefined {
  try { return c.executionCtx; } catch { return undefined; }
}

agentApiRouter.get("/actions", apiKey(), async (c) => {
  const p = page(c);
  if (p instanceof Response) return p;
  await expireActions(c.env.DB);
  const status = short(c.req.query("status"), 20);
  const rows = await c.env.DB.prepare(`${ACTION_SELECT} WHERE a.api_key_id = ? AND a.id > ? AND (? IS NULL OR a.status = ?) ORDER BY a.id LIMIT ?`)
    .bind(c.get("apiKey").id, p.after, status, status, p.limit + 1).all<ActionRow>();
  return listResponse(c, rows.results.map(r => presentAction(r)) as any, p.limit);
});

agentApiRouter.get("/actions/:id", apiKey(), async (c) => {
  await expireActions(c.env.DB);
  const row = await loadOwnAction(c, c.req.param("id"));
  if (!row) return c.json({ error: "ไม่พบงานนี้", code: "not_found" }, 404);
  return c.json({ data: presentAction(row) });
});

/** The agent withdraws a request nobody decided on yet. */
agentApiRouter.post("/actions/:id/cancel", apiKey(), async (c) => {
  const row = await loadOwnAction(c, c.req.param("id"));
  if (!row) return c.json({ error: "ไม่พบงานนี้", code: "not_found" }, 404);
  const res = await c.env.DB.prepare("UPDATE agent_actions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'").bind(nowIso(), row.id).run();
  if (!res.meta.changes) return c.json({ error: `ยกเลิกไม่ได้ งานนี้อยู่ในสถานะ ${row.status}`, code: "invalid_state" }, 409);
  await actionEvent(c.env.DB, row, "cancelled");
  return c.json({ data: presentAction((await loadOwnAction(c, row.id))!) });
});

// ---------- Event feed ----------

/** Public event name → user_events types. Webhook events plus the outcome of this key's own actions. */
const FEED_EVENTS: Record<string, readonly string[]> = {
  ...Object.fromEntries(WEBHOOK_EVENT_NAMES.map(name => [name, WEBHOOK_EVENTS[name].types])),
  "action.updated": ["agent_action"]
};
const TYPE_TO_EVENT = new Map(Object.entries(FEED_EVENTS).flatMap(([name, types]) => types.map(t => [t, name] as const)));

/**
 * GET /v1/events?since=<next_since>&types=order.paid,registration.created&limit=
 * Events with an id above `since`, oldest first. Without `since`: the last 24 hours. Store
 * next_since and pass it on the next call; has_more means call again straight away.
 */
agentApiRouter.get("/events", apiKey("events:read"), async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "100", 10) || 100, 1), 500);
  const rawSince = c.req.query("since");
  if (rawSince !== undefined && rawSince !== "" && !/^\d{1,15}$/.test(rawSince)) return c.json({ error: "since ต้องเป็นตัวเลข next_since จากครั้งก่อน", code: "invalid_request" }, 400);
  const requested = c.req.query("types")?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
  const unknown = requested.filter(t => !(t in FEED_EVENTS));
  if (unknown.length) return c.json({ error: `ไม่รู้จักเหตุการณ์ ${unknown.join(", ")}`, code: "invalid_request", events: Object.keys(FEED_EVENTS) }, 400);
  const types = (requested.length ? requested : Object.keys(FEED_EVENTS)).flatMap(name => FEED_EVENTS[name]);
  const since = rawSince ? Number(rawSince) : null;
  const db = c.env.DB;
  const keyId = c.get("apiKey").id;
  const rows = await db.prepare(`SELECT id, type, user_id, course_id, lesson_id, data_json, created_at FROM user_events
    WHERE id > ? AND (? IS NOT NULL OR created_at >= ?) AND type IN (${types.map(() => "?").join(", ")})
      AND (type != 'agent_action' OR json_extract(data_json, '$.api_key_id') = ?)
    ORDER BY id LIMIT ?`)
    .bind(since ?? 0, since, new Date(Date.now() - 86_400_000).toISOString(), ...types, keyId, limit + 1)
    .all<{ id: number; type: string; user_id: string | null; course_id: string | null; lesson_id: string | null; data_json: string | null; created_at: string }>();
  const more = rows.results.length > limit;
  const list = more ? rows.results.slice(0, limit) : rows.results;
  let nextSince: number;
  if (list.length) nextSince = list[list.length - 1].id;
  else if (since !== null) nextSince = since;
  else nextSince = (await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM user_events").first<{ id: number }>())?.id ?? 0;
  return c.json({
    data: list.map(r => {
      let data: any = null;
      try { data = r.data_json ? JSON.parse(r.data_json) : null; } catch { data = null; }
      if (r.type === "agent_action" && data) delete data.api_key_id;
      return { id: r.id, event: TYPE_TO_EVENT.get(r.type), occurred_at: r.created_at, user_id: r.user_id, course_id: r.course_id, lesson_id: r.lesson_id, data };
    }),
    next_since: String(nextSince),
    has_more: more
  });
});

// ---------- OpenAPI ----------

/** Paths merged into /v1/openapi.json by publicapi.ts. */
export function agentOpenApiPaths(op: (summary: string, scope: string, extra: Record<string, unknown>) => unknown, paging: unknown[]) {
  const q = (name: string, description?: string) => ({ name, in: "query", schema: { type: "string" }, ...(description ? { description } : {}) });
  const ok = { "200": { description: "OK" } };
  return {
    "/me": { get: op("ข้อมูลของ key นี้ (scope โควตา ช่วงเวลา)", "-", { responses: ok }) },
    "/tools": { get: op("รายการเครื่องมือ (อ่าน / ร่าง / ลงมือ) พร้อม input_schema", "-", { responses: ok }) },
    "/training-sessions": { get: op("รอบอบรมพร้อมที่นั่งคงเหลือ", "sessions:read", { parameters: [...paging, q("status"), q("from", "YYYY-MM-DD"), q("to", "YYYY-MM-DD")], responses: ok }) },
    "/training-sessions/{id}": { get: op("รอบอบรมหนึ่งรอบ", "sessions:read", { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: ok }) },
    "/registrations": { get: op("ผู้สมัครรอบอบรม", "registrations:read", { parameters: [...paging, q("session_id"), q("status"), q("since", "ISO 8601 (updated_at)")], responses: ok }) },
    "/leads": { get: op("lead จากฟอร์ม", "leads:read", { parameters: [...paging, q("status"), q("form_id"), q("since", "ISO 8601 (updated_at)")], responses: ok }) },
    "/inquiries": { get: op("ข้อความติดต่อ", "inquiries:read", { parameters: [...paging, q("status"), q("since", "ISO 8601 (updated_at)")], responses: ok }) },
    "/reports/summary": { get: op("รายงานสรุปช่วงวันที่ (เวลาไทย)", "reports:read", { parameters: [q("from", "YYYY-MM-DD"), q("to", "YYYY-MM-DD")], responses: ok }) },
    "/ops/daily-summary": { get: op("สรุปงานประจำวัน (get_daily_ops_summary)", "reports:read", { parameters: [q("date", "YYYY-MM-DD")], responses: ok }) },
    "/actions": {
      get: op("งานที่ key นี้ส่ง", "-", { parameters: [...paging, q("status")], responses: ok }),
      post: op("ส่งงานร่าง/ลงมือ (dry_run, idempotency_key) งานลงมือเข้าคิวอนุมัติ", "ตาม tool", {
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["tool", "input"], properties: {
          tool: { type: "string" }, input: { type: "object" }, dry_run: { type: "boolean" }, idempotency_key: { type: "string" },
          reason: { type: "string" }, expires_in_hours: { type: "integer", minimum: 1, maximum: 168, default: 72 }
        } } } } },
        responses: { "200": { description: "dry run หรือ replay ของ idempotency_key" }, "201": { description: "งานร่างทำแล้ว" }, "202": { description: "เข้าคิวรออนุมัติ" }, "409": { description: "idempotency_conflict / invalid_state" } }
      })
    },
    "/actions/{id}": { get: op("สถานะงานหนึ่งรายการ", "-", { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: ok }) },
    "/actions/{id}/cancel": { post: op("ถอนงานที่ยังรออนุมัติ", "-", { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: ok }) },
    "/events": { get: op("ฟีดเหตุการณ์แบบดึงเอง", "events:read", { parameters: [q("since", "next_since จากครั้งก่อน"), q("types", "เช่น order.paid,registration.created"), { name: "limit", in: "query", schema: { type: "integer", maximum: 500, default: 100 } }], responses: ok }) }
  };
}
