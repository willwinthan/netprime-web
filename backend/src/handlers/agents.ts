import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { currentPermissions, permit } from "../utils/permissions";
import { AUTONOMY, RuleRow, bangkokDayStart, parseConditions } from "../utils/agentTools";
import {
  ACTION_SELECT, ActionRow, actionEvent, auditAgent, expireActions, isWriteTool, presentAction, runAction, toolByName, describeTool, TOOLS
} from "../utils/agentTools";

/**
 * Console side of the agent platform (/api/admin/agents/*, permission agents.approve):
 * the approval queue for "act" tools, the history of everything agents did, and their request log.
 * Approving also needs the tool's own permission (e.g. payments.manage for confirm_order), and the
 * action then runs through the staff route with the approver's token (utils/agentTools.ts).
 */
export const agentsAdminRouter = new Hono<Env>();

agentsAdminRouter.use("/admin/agents/*", rbac(), permit("agents.approve"), async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

const nowIso = () => new Date().toISOString();
const ACTION_STATUSES = ["pending", "executing", "executed", "failed", "rejected", "cancelled", "expired"];

/** GET /admin/agents/actions?status=pending|history|<status>&key_id=&limit=&offset= */
agentsAdminRouter.get("/admin/agents/actions", async (c) => {
  const db = c.env.DB;
  await expireActions(db);
  const status = c.req.query("status") || "pending";
  const keyId = c.req.query("key_id") || null;
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);
  const filter = status === "history" ? "a.status != 'pending'" : ACTION_STATUSES.includes(status) ? "a.status = ?" : "1 = 1";
  const binds = ACTION_STATUSES.includes(status) ? [status] : [];
  const rows = await db.prepare(`${ACTION_SELECT} WHERE ${filter} AND (? IS NULL OR a.api_key_id = ?)
    ORDER BY ${status === "pending" ? "a.created_at" : "a.updated_at DESC"} LIMIT ? OFFSET ?`)
    .bind(...binds, keyId, keyId, limit, offset).all<ActionRow>();
  const counts = await db.prepare("SELECT status, COUNT(*) AS n FROM agent_actions GROUP BY status").all<{ status: string; n: number }>();
  const granted = await currentPermissions(c);
  return c.json({
    actions: rows.results.map(r => {
      const tool = toolByName(r.tool);
      const needs = tool && isWriteTool(tool) ? tool.approverPermission ?? null : null;
      return { ...presentAction(r, true), tool_label: tool?.label ?? r.tool, approver_permission: needs, can_approve: !needs || granted.has(needs) };
    }),
    counts: Object.fromEntries(counts.results.map(r => [r.status, r.n])),
    tools: TOOLS.map(describeTool)
  });
});

/** One action, with a fresh preview of its target so the approver sees the current state. */
agentsAdminRouter.get("/admin/agents/actions/:id", async (c) => {
  const row = await c.env.DB.prepare(`${ACTION_SELECT} WHERE a.id = ?`).bind(c.req.param("id")).first<ActionRow>();
  if (!row) return c.json({ error: "ไม่พบงานนี้" }, 404);
  const tool = toolByName(row.tool);
  let current: unknown = null;
  if (row.status === "pending" && tool && isWriteTool(tool)) {
    const value = tool.parse(JSON.parse(row.input_json));
    current = "error" in value ? { error: value.error } : await tool.preview(c.env, value);
  }
  return c.json({ action: { ...presentAction(row, true), tool_label: tool?.label ?? row.tool }, current });
});

/** Approve and run now. 409 when someone else decided first; the outcome is in action.status. */
agentsAdminRouter.post("/admin/agents/actions/:id/approve", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const body = await c.req.json<{ note?: unknown }>().catch(() => null);
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) || null : null;
  await expireActions(db);
  const row = await db.prepare(`${ACTION_SELECT} WHERE a.id = ?`).bind(c.req.param("id")).first<ActionRow>();
  if (!row) return c.json({ error: "ไม่พบงานนี้" }, 404);
  if (row.status !== "pending") return c.json({ error: `งานนี้อยู่ในสถานะ ${row.status} แล้ว` }, 409);
  const tool = toolByName(row.tool);
  if (!tool || !isWriteTool(tool)) return c.json({ error: "ไม่รู้จักเครื่องมือนี้" }, 400);
  if (tool.approverPermission && !(await currentPermissions(c)).has(tool.approverPermission)) {
    return c.json({ error: `การอนุมัติงานนี้ต้องมีสิทธิ์ ${tool.approverPermission} ด้วย` }, 403);
  }
  // Claim it: a second approver (or a double click) finds nothing left to do.
  const claimed = await db.prepare(`UPDATE agent_actions SET status = 'executing', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'`).bind(user.id, nowIso(), note, nowIso(), row.id).run();
  if (!claimed.meta.changes) return c.json({ error: "งานนี้ถูกดำเนินการไปแล้ว" }, 409);
  await auditAgent(db, row.api_key_id, user.id, "agent_approve", "agent_action", row.id, { tool: row.tool, summary: row.summary, note });
  let executionCtx: ExecutionContext | undefined;
  try { executionCtx = c.executionCtx; } catch { executionCtx = undefined; }
  await runAction({
    env: c.env, executionCtx, actionId: row.id, agent: { id: row.api_key_id, name: row.api_key_name ?? row.api_key_id },
    approver: { id: user.id, name: user.name ?? user.email ?? user.id, authorization: c.req.header("Authorization") ?? "" }
  }, row);
  const done = (await db.prepare(`${ACTION_SELECT} WHERE a.id = ?`).bind(row.id).first<ActionRow>())!;
  return c.json({ action: presentAction(done, true) });
});

agentsAdminRouter.post("/admin/agents/actions/:id/reject", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const body = await c.req.json<{ note?: unknown }>().catch(() => null);
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (!note) return c.json({ error: "กรุณาระบุเหตุผลที่ไม่อนุมัติ (agent จะเห็นข้อความนี้)" }, 400);
  const row = await db.prepare(`${ACTION_SELECT} WHERE a.id = ?`).bind(c.req.param("id")).first<ActionRow>();
  if (!row) return c.json({ error: "ไม่พบงานนี้" }, 404);
  const res = await db.prepare(`UPDATE agent_actions SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'`).bind(user.id, nowIso(), note, nowIso(), row.id).run();
  if (!res.meta.changes) return c.json({ error: `งานนี้อยู่ในสถานะ ${row.status} แล้ว` }, 409);
  await auditAgent(db, row.api_key_id, user.id, "agent_reject", "agent_action", row.id, { tool: row.tool, summary: row.summary, note });
  await actionEvent(db, row, "rejected");
  const done = (await db.prepare(`${ACTION_SELECT} WHERE a.id = ?`).bind(row.id).first<ActionRow>())!;
  return c.json({ action: presentAction(done, true) });
});

/** Agent keys (name, pause state) and their recent requests, for the queue page. */
agentsAdminRouter.get("/admin/agents/activity", async (c) => {
  const keyId = c.req.query("key_id") || null;
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "100", 10) || 100, 1), 500);
  const db = c.env.DB;
  const [agents, activity] = await Promise.all([
    db.prepare(`SELECT k.id, k.name, k.description, k.prefix, k.paused_at, k.revoked_at, k.last_used_at, k.daily_limit, k.allowed_hours, k.allowed_days,
        (SELECT COUNT(*) FROM agent_actions a WHERE a.api_key_id = k.id AND a.status = 'pending') AS pending,
        (SELECT COUNT(*) FROM agent_activity x WHERE x.api_key_id = k.id AND x.created_at >= ?) AS requests_24h
      FROM api_keys k WHERE k.kind = 'agent' ORDER BY k.revoked_at IS NOT NULL, k.name`).bind(new Date(Date.now() - 86_400_000).toISOString()).all(),
    db.prepare(`SELECT x.id, x.api_key_id, k.name AS agent_name, x.method, x.path, x.status, x.ip, x.action_id, x.created_at
      FROM agent_activity x JOIN api_keys k ON k.id = x.api_key_id WHERE (? IS NULL OR x.api_key_id = ?) ORDER BY x.id DESC LIMIT ?`)
      .bind(keyId, keyId, limit).all()
  ]);
  return c.json({ agents: agents.results, activity: activity.results });
});


/**
 * Kill switch: anyone who reviews agent work may pause an agent key at once (no email code), so a
 * misbehaving agent can be stopped by whoever notices. Resuming needs integrations.manage.
 */
agentsAdminRouter.post("/admin/agents/keys/:id/pause", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const res = await db.prepare("UPDATE api_keys SET paused_at = ? WHERE id = ? AND kind = 'agent' AND paused_at IS NULL AND revoked_at IS NULL").bind(nowIso(), id).run();
  if (!res.meta.changes) return c.json({ error: "ไม่พบ agent key ที่ใช้งานอยู่" }, 404);
  await auditAgent(db, id, c.get("user").id, "pause", "api_key", id);
  return c.json({ message: "หยุด agent นี้แล้ว คำขอถัดไปของ agent จะถูกปฏิเสธทันที" });
});

agentsAdminRouter.post("/admin/agents/keys/:id/resume", async (c) => {
  if (!(await currentPermissions(c)).has("integrations.manage")) return c.json({ error: "การเปิดใช้ agent อีกครั้งต้องมีสิทธิ์ integrations.manage" }, 403);
  const db = c.env.DB;
  const id = c.req.param("id");
  const res = await db.prepare("UPDATE api_keys SET paused_at = NULL WHERE id = ? AND kind = 'agent' AND paused_at IS NOT NULL AND revoked_at IS NULL").bind(id).run();
  if (!res.meta.changes) return c.json({ error: "ไม่พบ agent key ที่ถูกหยุดไว้" }, 404);
  await auditAgent(db, id, c.get("user").id, "resume", "api_key", id);
  return c.json({ message: "เปิดใช้ agent นี้อีกครั้งแล้ว" });
});

// ---------- Phase 4: auto-approval rules (integrations.manage) ----------

const needsAdmin = async (c: Context<Env, any>) =>
  (await currentPermissions(c)).has("integrations.manage") ? null : c.json({ error: "การตั้งกฎอนุมัติอัตโนมัติต้องมีสิทธิ์ integrations.manage" }, 403);

const presentRule = (r: RuleRow & { agent_name?: string; created_by_name?: string; used_today?: number }) => {
  let conditions: unknown = {};
  try { conditions = JSON.parse(r.conditions_json); } catch { conditions = {}; }
  return { id: r.id, api_key_id: r.api_key_id, agent_name: r.agent_name ?? null, tool: r.tool, tool_label: toolByName(r.tool)?.label ?? r.tool, conditions,
    max_per_day: r.max_per_day, enabled: !!r.enabled, note: r.note, created_by_name: r.created_by_name ?? null, used_today: r.used_today ?? 0,
    created_at: r.created_at, updated_at: r.updated_at };
};

const RULE_SELECT = `SELECT r.*, k.name AS agent_name, u.name AS created_by_name,
    (SELECT COUNT(*) FROM agent_actions a WHERE a.auto_rule_id = r.id AND a.decided_at >= ?) AS used_today
  FROM agent_autonomy_rules r JOIN api_keys k ON k.id = r.api_key_id LEFT JOIN users u ON u.id = r.created_by`;

/**
 * Rules, the condition catalog per tool, and a 30-day track record per agent and tool (how often
 * people approved, rejected or saw a failure) to decide where more autonomy is earned.
 */
agentsAdminRouter.get("/admin/agents/rules", async (c) => {
  const denied = await needsAdmin(c);
  if (denied) return denied;
  const db = c.env.DB;
  const [rules, stats] = await Promise.all([
    db.prepare(`${RULE_SELECT} ORDER BY k.name, r.tool`).bind(bangkokDayStart()).all<RuleRow & { agent_name: string; created_by_name: string; used_today: number }>(),
    db.prepare(`SELECT a.api_key_id, k.name AS agent_name, a.tool,
        SUM(CASE WHEN a.status = 'executed' AND a.auto_rule_id IS NULL THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN a.status = 'executed' AND a.auto_rule_id IS NOT NULL THEN 1 ELSE 0 END) AS auto_approved,
        SUM(CASE WHEN a.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN a.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) AS pending
      FROM agent_actions a JOIN api_keys k ON k.id = a.api_key_id
      WHERE a.tier = 'act' AND a.created_at >= ? GROUP BY a.api_key_id, a.tool ORDER BY k.name, a.tool`)
      .bind(new Date(Date.now() - 30 * 86_400_000).toISOString()).all()
  ]);
  return c.json({
    rules: rules.results.map(presentRule),
    catalog: Object.entries(AUTONOMY).map(([tool, def]) => ({ tool, label: toolByName(tool)?.label ?? tool, conditions: def.conditions })),
    stats: stats.results
  });
});

agentsAdminRouter.post("/admin/agents/rules", async (c) => {
  const denied = await needsAdmin(c);
  if (denied) return denied;
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const keyId = typeof body?.api_key_id === "string" ? body.api_key_id : "";
  const tool = typeof body?.tool === "string" ? body.tool : "";
  const key = await db.prepare("SELECT id FROM api_keys WHERE id = ? AND kind = 'agent' AND revoked_at IS NULL").bind(keyId).first();
  if (!key) return c.json({ error: "ไม่พบ agent key" }, 404);
  const conditions = parseConditions(tool, body?.conditions);
  if (typeof conditions === "string") return c.json({ error: conditions }, 400);
  const maxPerDay = body?.max_per_day === undefined ? 20 : Number(body.max_per_day);
  if (!Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 1000) return c.json({ error: "จำนวนต่อวันต้องเป็น 1–1,000" }, 400);
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) || null : null;
  const id = `rul_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await db.prepare(`INSERT INTO agent_autonomy_rules (id, api_key_id, tool, conditions_json, max_per_day, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, keyId, tool, JSON.stringify(conditions), maxPerDay, note, c.get("user").id).run();
  await auditAgent(db, keyId, c.get("user").id, "create", "agent_rule", id, { tool, conditions, max_per_day: maxPerDay });
  const row = await db.prepare(`${RULE_SELECT} WHERE r.id = ?`).bind(bangkokDayStart(), id).first<any>();
  return c.json({ rule: presentRule(row) }, 201);
});

agentsAdminRouter.patch("/admin/agents/rules/:id", async (c) => {
  const denied = await needsAdmin(c);
  if (denied) return denied;
  const db = c.env.DB;
  const id = c.req.param("id");
  const existing = await db.prepare("SELECT * FROM agent_autonomy_rules WHERE id = ?").bind(id).first<RuleRow>();
  if (!existing) return c.json({ error: "ไม่พบกฎนี้" }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const values: Record<string, unknown> = {};
  if (body?.conditions !== undefined) {
    const conditions = parseConditions(existing.tool, body.conditions);
    if (typeof conditions === "string") return c.json({ error: conditions }, 400);
    values.conditions_json = JSON.stringify(conditions);
  }
  if (body?.max_per_day !== undefined) {
    const n = Number(body.max_per_day);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return c.json({ error: "จำนวนต่อวันต้องเป็น 1–1,000" }, 400);
    values.max_per_day = n;
  }
  if (body?.enabled !== undefined) values.enabled = body.enabled ? 1 : 0;
  if (body?.note !== undefined) values.note = typeof body.note === "string" ? body.note.trim().slice(0, 300) || null : null;
  const keys = Object.keys(values);
  if (!keys.length) return c.json({ error: "ไม่มีข้อมูลที่ต้องแก้ไข" }, 400);
  // Whoever changes a rule becomes the person its actions run as.
  await db.prepare(`UPDATE agent_autonomy_rules SET ${keys.map(k => `${k} = ?`).join(", ")}, created_by = ?, updated_at = ? WHERE id = ?`)
    .bind(...keys.map(k => values[k]), c.get("user").id, nowIso(), id).run();
  await auditAgent(db, existing.api_key_id, c.get("user").id, "update", "agent_rule", id, values);
  const row = await db.prepare(`${RULE_SELECT} WHERE r.id = ?`).bind(bangkokDayStart(), id).first<any>();
  return c.json({ rule: presentRule(row) });
});

agentsAdminRouter.delete("/admin/agents/rules/:id", async (c) => {
  const denied = await needsAdmin(c);
  if (denied) return denied;
  const db = c.env.DB;
  const existing = await db.prepare("SELECT api_key_id, tool FROM agent_autonomy_rules WHERE id = ?").bind(c.req.param("id")).first<{ api_key_id: string; tool: string }>();
  if (!existing) return c.json({ error: "ไม่พบกฎนี้" }, 404);
  await db.prepare("DELETE FROM agent_autonomy_rules WHERE id = ?").bind(c.req.param("id")).run();
  await auditAgent(db, existing.api_key_id, c.get("user").id, "delete", "agent_rule", c.req.param("id"), { tool: existing.tool });
  return c.json({ message: "ลบกฎแล้ว งานถัดไปจะกลับไปรอคนอนุมัติ" });
});
