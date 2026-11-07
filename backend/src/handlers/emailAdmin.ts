import { Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { permit } from "../utils/permissions";
import { rateLimited } from "../utils/ratelimit";
import { currentSender, deliver, escapeHtml, emailFrame, isLiveEmailKey, retryLoggedEmail } from "../utils/email";

/**
 * Email delivery for admins (ตั้งค่าระบบ › อีเมล): whether sending is configured, a test email, and the
 * delivery log with a retry for emails that failed temporarily. Requires integrations.manage.
 */
export const emailAdminRouter = new Hono<Env>();

emailAdminRouter.use("/admin/email/*", rbac(), permit("integrations.manage"));

const STATUSES = ["sent", "failed", "logged"] as const;
const PAGE_SIZE = 50;

/**
 * GET /api/admin/email/status
 * mode "live" sends through Resend; "log_only" writes emails to the Worker log (no RESEND_API_KEY).
 */
emailAdminRouter.get("/admin/email/status", async (c) => {
  const counts = await c.env.DB.prepare(`SELECT
      SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed, SUM(status = 'logged') AS logged,
      MAX(CASE WHEN status = 'sent' THEN created_at END) AS last_sent_at
    FROM email_log WHERE created_at >= datetime('now', '-1 day')`).first<{ sent: number | null; failed: number | null; logged: number | null; last_sent_at: string | null }>();
  return c.json({
    mode: isLiveEmailKey(c.env.RESEND_API_KEY) ? "live" : "log_only",
    sender: currentSender(),
    sender_configured: !!c.env.EMAIL_FROM?.trim(),
    last_24h: { sent: counts?.sent ?? 0, failed: counts?.failed ?? 0, logged: counts?.logged ?? 0 },
    last_sent_at: counts?.last_sent_at ?? null
  });
});

/**
 * POST /api/admin/email/test { to? }  (default: the signed-in admin)
 * Sends right away and returns what the provider said, so a wrong key or an unverified domain shows up.
 */
emailAdminRouter.post("/admin/email/test", async (c) => {
  const user = c.get("user");
  if (await rateLimited(c.env.SESSIONS, "email-test", user.id, 10)) return c.json({ error: "ส่งอีเมลทดสอบบ่อยเกินไป กรุณารอสักครู่" }, 429);
  const body = await c.req.json<{ to?: unknown }>().catch(() => ({} as { to?: unknown }));
  const to = typeof body.to === "string" && body.to.trim() ? body.to.trim() : user.email;
  if (!/^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(to) || to.length > 254) return c.json({ error: "อีเมลผู้รับไม่ถูกต้อง" }, 400);
  const html = emailFrame(`
    <h2 style="color: #e56b25;">อีเมลทดสอบจาก Netprime LMS</h2>
    <p>ถ้าคุณได้รับอีเมลนี้ แปลว่าระบบส่งอีเมลตั้งค่าถูกต้องแล้ว</p>
    <p style="color: #666; font-size: 13px;">ส่งโดย ${escapeHtml(user.name)} เมื่อ ${escapeHtml(new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }))}</p>`, to);
  const outcome = await deliver(to, "อีเมลทดสอบจาก Netprime LMS", html, c.env.RESEND_API_KEY, "test");
  return c.json({ to, status: outcome.status, error: outcome.error ?? null });
});

/**
 * GET /api/admin/email/log?status=&q=&page=
 * Newest first, 50 per page; q matches the recipient or subject. Bodies are never returned.
 */
emailAdminRouter.get("/admin/email/log", async (c) => {
  const status = c.req.query("status");
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  const page = Math.max(1, Math.min(1000, Number(c.req.query("page")) || 1));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status && (STATUSES as readonly string[]).includes(status)) { where.push("status = ?"); binds.push(status); }
  if (q) { where.push("(to_email LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\')"); const like = `%${q.replace(/[\\%_]/g, ch => "\\" + ch)}%`; binds.push(like, like); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(`SELECT id, to_email, subject, kind, status, provider_id, error, attempts, retry_html IS NOT NULL AS can_retry, created_at, updated_at
      FROM email_log ${clause} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM email_log ${clause}`).bind(...binds).first<{ n: number }>()
  ]);
  c.header("Cache-Control", "no-store");
  return c.json({
    emails: rows.results.map(r => ({ ...r, can_retry: !!(r as { can_retry: number }).can_retry })),
    total: total?.n ?? 0, page, page_size: PAGE_SIZE
  });
});

/** POST /api/admin/email/log/:id/retry — only failed emails that still keep their body. */
emailAdminRouter.post("/admin/email/log/:id/retry", async (c) => {
  const outcome = await retryLoggedEmail(c.env.DB, c.req.param("id"), c.env.RESEND_API_KEY);
  if (!outcome) return c.json({ error: "ส่งซ้ำไม่ได้: อีเมลนี้ส่งสำเร็จแล้ว หรือเก็บเนื้อหาไว้ไม่ถึง (ส่งซ้ำได้ภายใน 1 วัน)" }, 409);
  return c.json({ status: outcome.status, error: outcome.error ?? null });
});
