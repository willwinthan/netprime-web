import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { permit, rolesColumn, parseRoles } from "../utils/permissions";
import { createNotification } from "./notifications";

/**
 * PDPA data subject requests (mounted at /api).
 * Users download their own data and ask for account deletion; privacy.manage approves
 * (anonymizes the account) or rejects. Financial and certificate records are kept for legal retention.
 */
export const privacyRouter = new Hono<Env>();

const DELETED_NAME = "ผู้ใช้ที่ลบแล้ว";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

async function audit(c: Context<Env>, action: string, entityId: string, detail?: unknown) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("log"), c.get("user").id, action, "privacy_request", entityId, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000)).run();
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}

// Personal data per table: [export key, table, owner column]. Tables added by later migrations
// (orders, payments) are included when present; a missing table is skipped.
const OWN_TABLES: Array<[string, string, string]> = [
  ["enrollments", "enrollments", "user_id"],
  ["lesson_progress", "lesson_progress", "user_id"],
  ["quiz_attempts", "quiz_attempts", "user_id"],
  ["quiz_answers", "quiz_answers", "user_id"],
  ["notes", "student_notes", "user_id"],
  ["questions", "lesson_qa", "user_id"],
  ["certificates", "certificates", "user_id"],
  ["payments", "payments", "user_id"],
  ["orders", "course_orders", "user_id"],
  ["internship_applications", "internship_applications", "student_id"],
  ["project_applications", "project_applications", "student_id"],
  ["gamification", "user_gamification", "user_id"],
  ["achievements", "user_achievements", "user_id"],
  ["notifications", "notifications", "user_id"],
  ["privacy_requests", "privacy_requests", "user_id"]
];

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first());
}

/** GET /api/me/export — JSON copy of the signed-in user's own data (PDPA right of access/portability). */
privacyRouter.get("/me/export", rbac(), async (c) => {
  const db = c.env.DB;
  const me = c.get("user");
  const profile = await db.prepare(`SELECT u.id, u.email, u.name, u.partner_id, p.company_name AS organization, u.status, u.created_at, u.last_login_at,
      ${rolesColumn("u")} AS role_list
    FROM users u LEFT JOIN partners p ON p.id = u.partner_id WHERE u.id = ?`).bind(me.id).first<Record<string, any>>();
  if (!profile) return c.json({ error: "ไม่พบบัญชี" }, 404);
  const { role_list, ...account } = profile;

  const data: Record<string, unknown> = {
    exported_at: new Date().toISOString(),
    profile: account,
    roles: parseRoles(role_list),
    sign_in_providers: (await db.prepare("SELECT provider, created_at FROM oauth_identities WHERE user_id = ?").bind(me.id).all()).results
  };
  for (const [key, table, column] of OWN_TABLES) {
    if (!(await tableExists(db, table))) continue;
    try {
      data[key] = (await db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).bind(me.id).all()).results;
    } catch (error) {
      console.error(`Export of ${table} failed:`, error);
    }
  }
  // Training registrations: linked to the account, or made with the same email before it existed.
  data.training_registrations = (await db.prepare(`SELECT r.id, r.session_id, s.title AS session_title, s.start_date, s.end_date, r.name, r.email, r.phone,
      r.company, r.attendees, r.note, r.invoice_required, r.tax_id, r.billing_address, r.status, r.payment_ref, r.created_at
    FROM session_registrations r JOIN training_sessions s ON s.id = r.session_id
    WHERE r.user_id = ? OR (r.user_id IS NULL AND r.email = ?) ORDER BY r.created_at`).bind(me.id, account.email).all()).results;

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="netprime-my-data-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store"
    }
  });
});

/** GET /api/me/deletion-request — the latest request and its status (for the profile page). */
privacyRouter.get("/me/deletion-request", rbac(), async (c) => {
  const request = await c.env.DB.prepare(`SELECT id, status, reason, admin_note, created_at, processed_at FROM privacy_requests
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).bind(c.get("user").id).first();
  return c.json({ request: request ?? null });
});

/** POST /api/me/deletion-request {reason?} — one open request per user. */
privacyRouter.post("/me/deletion-request", rbac(), async (c) => {
  const body = await c.req.json<{ reason?: unknown }>().catch(() => null);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length > 1000) return c.json({ error: "เหตุผลยาวเกิน 1,000 ตัวอักษร" }, 400);
  const me = c.get("user");
  const id = newId("pdpa");
  try {
    await c.env.DB.prepare("INSERT INTO privacy_requests (id, user_id, type, reason) VALUES (?, ?, 'deletion', ?)").bind(id, me.id, reason || null).run();
  } catch (err: any) {
    if (String(err?.message || "").includes("UNIQUE constraint failed")) return c.json({ error: "คุณมีคำขอลบบัญชีที่รอดำเนินการอยู่แล้ว" }, 409);
    throw err;
  }
  // Tell admins (they hold privacy.manage) and roles granted it.
  const managers = await c.env.DB.prepare(`SELECT DISTINCT r.user_id AS id FROM user_roles r JOIN users u ON u.id = r.user_id
    WHERE u.status = 'active' AND (r.role = 'admin' OR r.role IN (SELECT role FROM role_permissions WHERE permission = 'privacy.manage')) LIMIT 50`)
    .all<{ id: string }>();
  await Promise.all(managers.results.map(m => createNotification(c.env.DB, m.id, "คำขอลบบัญชี (PDPA)", `${me.name} ขอลบบัญชีและข้อมูลส่วนบุคคล`).catch(() => undefined)));
  return c.json({ message: "ส่งคำขอลบบัญชีแล้ว เจ้าหน้าที่จะดำเนินการภายใน 30 วัน", request: { id, status: "pending" } }, 201);
});

// ---------- Admin side (privacy.manage) ----------

privacyRouter.use("/admin/privacy/*", rbac(), permit("privacy.manage"));

privacyRouter.get("/admin/privacy/requests", async (c) => {
  const status = c.req.query("status");
  const rows = await c.env.DB.prepare(`SELECT q.*, u.name AS user_name, u.email AS user_email, u.status AS account_status, p.name AS processed_by_name
    FROM privacy_requests q JOIN users u ON u.id = q.user_id LEFT JOIN users p ON p.id = q.processed_by
    WHERE (? IS NULL OR q.status = ?)
    ORDER BY CASE q.status WHEN 'pending' THEN 0 ELSE 1 END, q.created_at DESC LIMIT 200`).bind(status || null, status || null).all();
  return c.json({ requests: rows.results });
});

async function openRequest(c: Context<Env>) {
  return c.env.DB.prepare("SELECT id, user_id, status FROM privacy_requests WHERE id = ?").bind(c.req.param("id"))
    .first<{ id: string; user_id: string; status: string }>();
}

function adminNote(body: { note?: unknown } | null): string | null | undefined {
  if (body?.note === undefined || body.note === null) return null;
  if (typeof body.note !== "string" || body.note.length > 1000) return undefined;
  return body.note.trim() || null;
}

/**
 * Approve → anonymize: name and email replaced, account suspended, sessions revoked, personal notes,
 * sign-in identities, tokens and notifications deleted, registration contact details blanked.
 * Orders, payments, enrollments and certificates stay (tax/accounting retention, certificate checks).
 */
privacyRouter.post("/admin/privacy/requests/:id/approve", async (c) => {
  const db = c.env.DB;
  const request = await openRequest(c);
  if (!request) return c.json({ error: "ไม่พบคำขอ" }, 404);
  if (request.status !== "pending") return c.json({ error: "คำขอนี้ดำเนินการไปแล้ว" }, 409);
  const note = adminNote(await c.req.json().catch(() => null));
  if (note === undefined) return c.json({ error: "หมายเหตุไม่ถูกต้อง (ไม่เกิน 1,000 ตัวอักษร)" }, 400);
  const userId = request.user_id;
  if (await db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'admin'").bind(userId).first()) {
    return c.json({ error: "บัญชีนี้เป็นผู้ดูแลระบบ ให้ถอดบทบาทผู้ดูแลก่อนลบบัญชี" }, 409);
  }
  const account = await db.prepare("SELECT partner_id FROM users WHERE id = ?").bind(userId).first<{ partner_id: string | null }>();
  const email = `deleted-${userId}@invalid`;
  const unusable = `pbkdf2-sha256$deleted$${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date().toISOString();

  const statements = [
    db.prepare(`UPDATE privacy_requests SET status = 'approved', admin_note = ?, processed_by = ?, processed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'`).bind(note, c.get("user").id, request.id),
    db.prepare(`UPDATE users SET name = ?, email = ?, password_hash = ?, status = 'suspended', partner_id = NULL, sessions_revoked_at = ?
      WHERE id = ?`).bind(DELETED_NAME, email, unusable, now, userId),
    db.prepare("DELETE FROM student_notes WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM oauth_identities WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM account_tokens WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM notifications WHERE user_id = ?").bind(userId),
    // Contact details go; company/tax details stay only where a tax invoice was requested.
    db.prepare(`UPDATE session_registrations SET name = ?, email = 'deleted-' || id || '@invalid', phone = '-', note = NULL,
        company = CASE WHEN invoice_required = 1 THEN company ELSE NULL END
      WHERE user_id = ?`).bind(DELETED_NAME, userId)
  ];
  if (account?.partner_id) {
    statements.push(db.prepare(`UPDATE partners SET allocated_seats =
      (SELECT COUNT(*) FROM users WHERE partner_id = ? AND role = 'student' AND staff_role IS NULL) WHERE id = ?`).bind(account.partner_id, account.partner_id));
  }
  const [claimed] = await db.batch(statements);
  if (!claimed.meta.changes) return c.json({ error: "คำขอนี้ดำเนินการไปแล้ว" }, 409);
  await audit(c, "approve", request.id, { user_id: userId });
  return c.json({ message: "ลบข้อมูลส่วนบุคคลและปิดบัญชีแล้ว", request: { id: request.id, status: "approved" } });
});

privacyRouter.post("/admin/privacy/requests/:id/reject", async (c) => {
  const request = await openRequest(c);
  if (!request) return c.json({ error: "ไม่พบคำขอ" }, 404);
  if (request.status !== "pending") return c.json({ error: "คำขอนี้ดำเนินการไปแล้ว" }, 409);
  const note = adminNote(await c.req.json().catch(() => null));
  if (!note) return c.json({ error: "กรุณาระบุเหตุผลที่ปฏิเสธ (ผู้ใช้จะเห็นข้อความนี้)" }, 400);
  const result = await c.env.DB.prepare(`UPDATE privacy_requests SET status = 'rejected', admin_note = ?, processed_by = ?, processed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'`).bind(note, c.get("user").id, request.id).run();
  if (!result.meta.changes) return c.json({ error: "คำขอนี้ดำเนินการไปแล้ว" }, 409);
  await createNotification(c.env.DB, request.user_id, "คำขอลบบัญชีถูกปฏิเสธ", note).catch(() => undefined);
  await audit(c, "reject", request.id, { user_id: request.user_id, note });
  return c.json({ message: "ปฏิเสธคำขอแล้ว", request: { id: request.id, status: "rejected" } });
});
