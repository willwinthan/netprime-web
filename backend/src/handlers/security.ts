import { Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { deletePreview, issueDeleteCode, isDangerAction } from "../utils/dangerConfirm";
import { rateLimited, tooManyRequests } from "../utils/ratelimit";

/**
 * Email confirmation codes for dangerous deletions (mounted at /api). See utils/dangerConfirm.ts for the rule
 * and the list of protected actions; delete endpoints call requireDeleteConfirmation().
 */
export const securityRouter = new Hono<Env>();

securityRouter.use("/security/*", rbac());
securityRouter.use("/security/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

const targetId = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 100 ? v : null;

/** GET /api/security/delete-preview?action=&target_id= — what will be deleted, counts, and who can approve. */
securityRouter.get("/security/delete-preview", async (c) => {
  const action = c.req.query("action");
  const id = targetId(c.req.query("target_id"));
  if (!isDangerAction(action) || !id) return c.json({ error: "ระบุ action และ target_id ให้ถูกต้อง" }, 400);
  return deletePreview(c, action, id);
});

/** POST /api/security/delete-codes { action, target_id, approver?: "owner" | "admin" } — emails a 6-digit code. */
securityRouter.post("/security/delete-codes", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const action = body?.action;
  const id = targetId(body?.target_id);
  if (!isDangerAction(action) || !id) return c.json({ error: "ระบุ action และ target_id ให้ถูกต้อง" }, 400);
  const approver = body?.approver;
  if (approver !== undefined && approver !== null && approver !== "owner" && approver !== "admin") {
    return c.json({ error: "ผู้อนุมัติต้องเป็น owner หรือ admin" }, 400);
  }
  const user = c.get("user");
  if (await rateLimited(c.env.SESSIONS, "danger-code", `${user.id}:${action}:${id}`, 5, 900)) return tooManyRequests(c);
  if (await rateLimited(c.env.SESSIONS, "danger-code-user", user.id, 30, 900)) return tooManyRequests(c);
  return issueDeleteCode(c, action, id, approver ?? undefined);
});
