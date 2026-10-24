import { Context, Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { permit } from "../utils/permissions";
import { createNotification } from "./notifications";

/**
 * Certificate revocation and reissue for certificates.manage holders. Mounted under /api through studentRouter.
 * A revoked certificate stays in the table so public verification can say "revoked" instead of "not found".
 */
export const certificatesRouter = new Hono<Env>();

/**
 * Unique, hard-to-guess verification code with 64 random bits, e.g. NP-WORKERS-8F8D-9812-03AC-77E1.
 * Older codes (NP-PREFIX-XXXX-XXXX, 32 bits) stay valid; the public verify endpoint is rate-limited.
 */
export function newCertificateCode(courseId: string): string {
  const prefix = courseId.replace("course_", "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().substring(0, 8) || "COURSE";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `NP-${prefix}-${hex.match(/.{4}/g)!.join("-")}`;
}

async function audit(c: Context<Env>, action: string, entityId: string, detail?: unknown) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("log_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), c.get("user").id, action, "certificate", entityId,
        detail === undefined ? null : JSON.stringify(detail).slice(0, 2000)).run();
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}

interface CertRow {
  id: string; enrollment_id: string; user_id: string; course_id: string; certificate_code: string; issued_at: string;
  revoked_at: string | null; revoked_by: string | null; revoke_reason: string | null; reissued_from: string | null;
  user_name: string; user_email: string; course_title: string; revoked_by_name: string | null;
}

const CERT_SELECT = `SELECT cert.*, u.name AS user_name, u.email AS user_email, co.title AS course_title, rb.name AS revoked_by_name
  FROM certificates cert JOIN users u ON u.id = cert.user_id JOIN courses co ON co.id = cert.course_id
  LEFT JOIN users rb ON rb.id = cert.revoked_by`;

const readReason = async (c: Context<Env>) => {
  const body = await c.req.json<{ reason?: unknown }>().catch(() => null);
  return typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";
};

certificatesRouter.use("/manage/certificates", rbac(), permit("certificates.manage"));
certificatesRouter.use("/manage/certificates/*", rbac(), permit("certificates.manage"));

/**
 * GET /api/manage/certificates?q=code/name/email/course
 */
certificatesRouter.get("/manage/certificates", async (c) => {
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  const like = q ? `%${q.replace(/[\\%_]/g, ch => "\\" + ch)}%` : null;
  const rows = await c.env.DB.prepare(`${CERT_SELECT}
    WHERE (? IS NULL OR cert.certificate_code LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR co.title LIKE ? ESCAPE '\\')
    ORDER BY cert.issued_at DESC LIMIT 200`).bind(like, like, like, like, like).all<CertRow>();
  return c.json({ certificates: rows.results });
});

/**
 * POST /api/manage/certificates/:id/revoke { reason }
 */
certificatesRouter.post("/manage/certificates/:id/revoke", async (c) => {
  const reason = await readReason(c);
  if (!reason) return c.json({ error: "กรุณาระบุเหตุผลการเพิกถอน" }, 400);
  const db = c.env.DB;
  const cert = await db.prepare(`${CERT_SELECT} WHERE cert.id = ?`).bind(c.req.param("id")).first<CertRow>();
  if (!cert) return c.json({ error: "ไม่พบใบประกาศ" }, 404);
  const result = await db.prepare(`UPDATE certificates SET revoked_at = CURRENT_TIMESTAMP, revoked_by = ?, revoke_reason = ?
    WHERE id = ? AND revoked_at IS NULL`).bind(c.get("user").id, reason, cert.id).run();
  if (!result.meta.changes) return c.json({ error: "ใบประกาศนี้ถูกเพิกถอนไปแล้ว" }, 400);
  await audit(c, "revoke", cert.id, { code: cert.certificate_code, reason });
  await createNotification(db, cert.user_id, "ใบประกาศถูกเพิกถอน",
    `ใบประกาศคอร์ส ${cert.course_title} (รหัส ${cert.certificate_code}) ถูกเพิกถอน: ${reason}`);
  return c.json({ certificate: await db.prepare(`${CERT_SELECT} WHERE cert.id = ?`).bind(cert.id).first() });
});

/**
 * Issue a replacement with a new code; the old one is revoked.
 * POST /api/manage/certificates/:id/reissue { reason? }
 */
certificatesRouter.post("/manage/certificates/:id/reissue", async (c) => {
  const reason = await readReason(c);
  const db = c.env.DB;
  const staffId = c.get("user").id;
  const cert = await db.prepare(`${CERT_SELECT} WHERE cert.id = ?`).bind(c.req.param("id")).first<CertRow>();
  if (!cert) return c.json({ error: "ไม่พบใบประกาศ" }, 404);
  const active = await db.prepare("SELECT id FROM certificates WHERE user_id = ? AND course_id = ? AND revoked_at IS NULL AND id != ?")
    .bind(cert.user_id, cert.course_id, cert.id).first();
  if (active) return c.json({ error: "ผู้เรียนมีใบประกาศที่ใช้งานได้ของคอร์สนี้อยู่แล้ว" }, 400);

  const id = "cert_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const code = newCertificateCode(cert.course_id);
  const statements = [
    db.prepare("INSERT INTO certificates (id, enrollment_id, user_id, course_id, certificate_code, reissued_from) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, cert.enrollment_id, cert.user_id, cert.course_id, code, cert.id)
  ];
  if (!cert.revoked_at) {
    statements.push(db.prepare(`UPDATE certificates SET revoked_at = CURRENT_TIMESTAMP, revoked_by = ?, revoke_reason = ?
      WHERE id = ? AND revoked_at IS NULL`).bind(staffId, `ออกใบใหม่แทน (${code})${reason ? ": " + reason : ""}`, cert.id));
  }
  await db.batch(statements);
  await audit(c, "reissue", id, { old_code: cert.certificate_code, new_code: code, reason });
  await createNotification(db, cert.user_id, "ออกใบประกาศใหม่แล้ว",
    `ใบประกาศคอร์ส ${cert.course_title} ได้รหัสใหม่ ${code} รหัสเดิม ${cert.certificate_code} ใช้ไม่ได้แล้ว`);
  return c.json({ certificate: await db.prepare(`${CERT_SELECT} WHERE cert.id = ?`).bind(id).first() }, 201);
});
