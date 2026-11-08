import { Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { currentPermissions, permit } from "../utils/permissions";
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
