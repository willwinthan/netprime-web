import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { hashPassword } from "../utils/crypto";
import { issueAccountToken } from "../utils/tokens";
import { appUrl, escapeHtml, sendEmail } from "../utils/email";

export const businessRouter = new Hono<Env>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_STATUS_TH: Record<string, string> = { active: "ใช้งาน", suspended: "ระงับ" };
const ENROLLMENT_STATUS_TH: Record<string, string> = { active: "กำลังเรียน", completed: "เรียนจบ", suspended: "ระงับสิทธิ์" };

/** Partners act on their own organization; admins choose one with partner_id. */
function scopedPartnerId(c: Context<Env>, requested?: string | null): string | null {
  const user = c.get("user");
  if (user.role !== "admin") return user.partner_id;
  return typeof requested === "string" && requested ? requested : null;
}

/** Recounts seats: organization accounts whose primary role is student. */
export function recountSeats(db: D1Database, partnerId: string) {
  return db.prepare(`UPDATE partners SET allocated_seats =
    (SELECT COUNT(*) FROM users WHERE partner_id = ?1 AND role = 'student' AND staff_role IS NULL) WHERE id = ?1`)
    .bind(partnerId);
}

/**
 * SQL condition: enrollment `e` (aliased) is one the learner paid for personally, through a
 * bank-transfer course order or a legacy completed payment. Such courses are never the organization's.
 */
export const personallyPaidSql = (e: string) => `(EXISTS (SELECT 1 FROM course_orders o
    WHERE o.user_id = ${e}.user_id AND o.course_id = ${e}.course_id AND o.status = 'paid')
  OR EXISTS (SELECT 1 FROM payments p WHERE p.user_id = ${e}.user_id AND p.course_id = ${e}.course_id AND p.status = 'completed'))`;

/**
 * SQL condition: enrollment `e` is sponsored by the organization bound as `partnerParam`: marked with
 * enrollments.partner_id, or an older unmarked row in a course the organization sponsors, and in both
 * cases not paid for personally.
 */
export const sponsoredBySql = (e: string, partnerParam: string) => `(NOT ${personallyPaidSql(e)}
  AND (${e}.partner_id = ${partnerParam}
    OR (${e}.partner_id IS NULL AND ${e}.course_id IN (SELECT course_id FROM partner_courses WHERE partner_id = ${partnerParam}))))`;

/**
 * Suspends active enrollments organization `partnerId` sponsored for `userId` (see sponsoredBySql),
 * but only once the account has left that organization, so it is a no-op when the move earlier in the
 * same batch did not apply. Courses the learner paid for personally keep running.
 */
export function suspendSponsoredEnrollments(db: D1Database, userId: string, partnerId: string) {
  return db.prepare(`UPDATE enrollments SET status = 'suspended'
    WHERE user_id = ?1 AND status = 'active'
      AND ${sponsoredBySql("enrollments", "?2")}
      AND (SELECT u.partner_id FROM users u WHERE u.id = ?1) IS NOT ?2`)
    .bind(userId, partnerId);
}

export async function audit(c: Context<Env>, action: string, entity: string, entityId: string, detail?: unknown) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("log_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), c.get("user").id, action, entity, entityId,
        detail === undefined ? null : JSON.stringify(detail).slice(0, 2000)).run();
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}

function deliverLater(c: Context<Env>, task: Promise<unknown>) {
  const guarded = task.catch(error => console.error("Employee invitation email failed:", error));
  try { c.executionCtx.waitUntil(guarded); } catch { /* No execution context (unit runtime): fire and forget. */ }
}

businessRouter.get("/business/analytics", rbac(["partner", "admin"]), async (c) => {
  return handleGetAnalytics(c);
});

businessRouter.get("/corporate/analytics", rbac(["partner", "admin"]), async (c) => {
  return handleGetAnalytics(c);
});

async function handleGetAnalytics(c: Context<Env>) {
  const user = c.get("user");
  const db = c.env.DB;

  // Determine target partner ID
  let partnerId = user.role === "partner" ? user.partner_id : c.req.query("partner_id");

  if (!partnerId) {
    if (user.role === "admin") {
      // Admin defaults to the first partner if none is specified
      const firstPartner = await db.prepare("SELECT id FROM partners LIMIT 1").first<{ id: string }>();
      partnerId = firstPartner?.id || null;
    }
  }

  if (!partnerId) {
    return c.json({ error: "ต้องผูกบัญชีกับรหัสองค์กรพาร์ตเนอร์" }, 400);
  }

  try {
    // 1. Fetch partner info
    const partner = await db
      .prepare("SELECT id, company_name, tax_id, total_seats, allocated_seats, partner_type FROM partners WHERE id = ?")
      .bind(partnerId)
      .first<{ id: string; company_name: string; tax_id: string | null; total_seats: number; allocated_seats: number; partner_type: string }>();

    if (!partner) {
      return c.json({ error: "ไม่พบองค์กรพาร์ตเนอร์" }, 404);
    }

    // 2. Query roster of B2B students with their aggregate learning stats
    const roster = await db
      .prepare(
        `SELECT u.id, u.email, u.name, u.created_at, u.status, u.last_login_at,
                COUNT(e.id) as courses_enrolled,
                AVG(e.progress_percent) as avg_progress
         FROM users u
         LEFT JOIN enrollments e ON u.id = e.user_id
         WHERE u.partner_id = ? AND u.role = 'student' AND u.staff_role IS NULL
         GROUP BY u.id
         ORDER BY u.name`
      )
      .bind(partnerId)
      .all<{ id: string; email: string; name: string; created_at: string; status: string; last_login_at: string | null; courses_enrolled: number; avg_progress: number | null }>();

    // 3. Calculate average cohort completion rate
    const cohortAvg = await db
      .prepare(
        `SELECT AVG(e.progress_percent) as avg_completion
         FROM enrollments e
         INNER JOIN users u ON e.user_id = u.id
         WHERE u.partner_id = ? AND u.role = 'student' AND u.staff_role IS NULL`
      )
      .bind(partnerId)
      .first<{ avg_completion: number | null }>();

    // Clean nulls in the results
    const rosterClean = roster.results.map((student: any) => ({
      ...student,
      avg_progress: student.avg_progress !== null ? Math.round(student.avg_progress) : null
    }));

    return c.json({
      partnerId: partner.id,
      companyName: partner.company_name,
      taxId: partner.tax_id,
      totalSeats: partner.total_seats,
      usedSeats: partner.allocated_seats,
      partnerType: partner.partner_type,
      activeLearners: rosterClean.filter((s: any) => s.courses_enrolled > 0).length,
      averageCompletionRate: cohortAvg?.avg_completion !== null ? Math.round(cohortAvg?.avg_completion || 0) : 0,
      roster: rosterClean
    });

  } catch (error) {
    console.error("Fetch B2B analytics failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดสถิติองค์กร" }, 500);
  }
}

businessRouter.post("/business/seats/assign", rbac(["partner", "admin"]), async (c) => {
  return handleAssignSeat(c);
});

businessRouter.post("/corporate/roster", rbac(["partner", "admin"]), async (c) => {
  return handleAssignSeat(c);
});

/**
 * Adds an employee to the organization. Either an initial password (same 12-character rule as the
 * account screens) or `invite: true`, which emails a set-password link instead (the console default).
 */
async function handleAssignSeat(c: Context<Env>) {
  const user = c.get("user");
  const db = c.env.DB;

  const body = await c.req.json<{
    email?: string;
    name?: string;
    password?: string;
    invite?: boolean;
    partner_id?: string;
  }>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);

  const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" && body.password ? body.password : null;
  const invite = !password && body.invite === true;

  if (!EMAIL_RE.test(email) || email.length > 254 || !name || name.length > 120) {
    return c.json({ error: "ต้องระบุอีเมลที่ถูกต้องและชื่อ (ไม่เกิน 120 ตัวอักษร)" }, 400);
  }
  if (password && (password.length < 12 || password.length > 256)) {
    return c.json({ error: "รหัสผ่านเริ่มต้นต้องยาว 12–256 ตัวอักษร" }, 400);
  }
  if (!password && !invite) {
    return c.json({ error: "ต้องตั้งรหัสผ่านเริ่มต้นอย่างน้อย 12 ตัวอักษร หรือเลือกส่งลิงก์เชิญทางอีเมล" }, 400);
  }

  // Determine target partner ID
  const targetPartnerId = scopedPartnerId(c, body.partner_id);

  if (!targetPartnerId) {
    return c.json({ error: "ต้องผูกบัญชีกับรหัสองค์กรพาร์ตเนอร์" }, 400);
  }

  try {
    // 1. Fetch current seat parameters
    const partner = await db
      .prepare("SELECT company_name, total_seats, allocated_seats FROM partners WHERE id = ?")
      .bind(targetPartnerId)
      .first<{ company_name: string; total_seats: number; allocated_seats: number }>();

    if (!partner) {
      return c.json({ error: "ไม่พบองค์กรพาร์ตเนอร์" }, 404);
    }

    // Count actual members in the same transaction as insertion; a stale counter cannot oversell a seat.
    // An invited account gets an unusable random password until the link is used.
    const newUserId = "usr_" + crypto.randomUUID();
    const passwordHash = await hashPassword(password ?? crypto.randomUUID() + crypto.randomUUID());
    const results = await db.batch([
      db.prepare(`INSERT INTO users (id, email, password_hash, name, role, partner_id)
        SELECT ?, ?, ?, ?, 'student', p.id FROM partners p
        WHERE p.id = ? AND
          (SELECT COUNT(*) FROM users u WHERE u.partner_id = p.id AND u.role = 'student' AND u.staff_role IS NULL) < p.total_seats`)
        .bind(newUserId, email, passwordHash, name, targetPartnerId),
      recountSeats(db, targetPartnerId)
    ]);
    if (!results[0].meta.changes) {
      return c.json({ error: "ใช้ที่นั่งครบตามจำนวนที่ได้รับแล้ว โปรดซื้อที่นั่งเพิ่ม" }, 400);
    }

    let debugUrl: string | undefined;
    if (invite) {
      const token = await issueAccountToken(db, newUserId, "invite");
      const link = appUrl(c.env, `/reset-password?token=${token}&invite=1`);
      deliverLater(c, sendEmail(email, `คำเชิญเข้าเรียนกับ ${partner.company_name}`,
        `<div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #eaeaea;padding:20px;border-radius:10px">
          <h2 style="color:#e56b25;margin-top:0">สวัสดีคุณ ${escapeHtml(name)}</h2>
          <p>${escapeHtml(partner.company_name)} เพิ่มคุณเป็นผู้เรียนใน NetPrime LMS กดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านและเริ่มเรียน (ลิงก์ใช้ได้ 7 วัน ใช้ได้ครั้งเดียว)</p>
          <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#e56b25;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">ตั้งรหัสผ่าน</a></p>
          <p style="font-size:12px;color:#64748b">หากคุณไม่ได้คาดหวังอีเมลนี้ ไม่ต้องดำเนินการใด ๆ</p>
        </div>`, c.env.RESEND_API_KEY));
      // Local test harness only: lets tests follow the link without reading the mailbox.
      if (c.env.ALLOW_LOCAL_SEED_PASSWORDS === "true") debugUrl = link;
    }
    await audit(c, "create", "user", newUserId, { email, partner_id: targetPartnerId, invite });

    return c.json({
      message: invite ? "เพิ่มผู้เรียนและส่งลิงก์เชิญทางอีเมลแล้ว" : "เพิ่มที่นั่งผู้เรียนเรียบร้อยแล้ว",
      invited: invite,
      ...(debugUrl ? { debug_url: debugUrl } : {}),
      student: {
        id: newUserId,
        email,
        name,
        role: "student",
        partner_id: targetPartnerId
      }
    }, 201);

  } catch (error: any) {
    console.error("B2B seat allocation failed:", error);
    if (error.message && error.message.includes("UNIQUE constraint failed")) {
      return c.json({ error: "มีผู้ใช้อีเมลนี้ลงทะเบียนในระบบแล้ว" }, 400);
    }
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะเพิ่มที่นั่งผู้เรียน" }, 500);
  }
}

/**
 * Remove an employee from the organization
 * POST /api/business/employees/:id/remove
 * The account stays as an individual learner, the seat is returned and courses the organization
 * sponsored are suspended; personal purchases keep working. Partners only manage their own organization.
 */
businessRouter.post("/business/employees/:id/remove", rbac(["partner", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const employeeId = c.req.param("id");

  try {
    const employee = await db
      .prepare(`SELECT u.id, u.email, u.partner_id,
          EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'partner') AS is_partner
         FROM users u WHERE u.id = ?`)
      .bind(employeeId)
      .first<{ id: string; email: string; partner_id: string | null; is_partner: number }>();

    // Admins act on the employee's own organization; partners only see their own members.
    const partnerId = user.role === "admin" ? employee?.partner_id ?? null : user.partner_id;
    if (!employee || !partnerId || employee.partner_id !== partnerId) {
      return c.json({ error: "ไม่พบพนักงานคนนี้ในองค์กรของคุณ" }, 404);
    }
    if (employee.is_partner) {
      return c.json({ error: "บัญชีนี้เป็นผู้ดูแลองค์กร เปลี่ยนบทบาทที่หน้า \"ผู้ใช้และสิทธิ์\" ก่อน" }, 400);
    }

    const results = await db.batch([
      db.prepare("UPDATE users SET partner_id = NULL WHERE id = ? AND partner_id = ?").bind(employeeId, partnerId),
      suspendSponsoredEnrollments(db, employeeId, partnerId),
      recountSeats(db, partnerId)
    ]);
    if (!results[0].meta.changes) {
      return c.json({ error: "สถานะพนักงานเปลี่ยนไประหว่างดำเนินการ กรุณาโหลดข้อมูลใหม่" }, 409);
    }
    const suspended = results[1].meta.changes || 0;
    await audit(c, "remove_member", "user", employeeId, { email: employee.email, partner_id: partnerId, suspended_enrollments: suspended });

    return c.json({
      message: "นำพนักงานออกจากองค์กรแล้ว บัญชียังใช้งานต่อได้ในฐานะผู้เรียนทั่วไป",
      suspended_enrollments: suspended
    });
  } catch (error) {
    console.error("Remove employee failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะนำพนักงานออกจากองค์กร" }, 500);
  }
});

/**
 * Excel-friendly CSV (UTF-8 BOM) of the roster with per-course progress
 * GET /api/business/export.csv
 * Lists courses the organization sponsors; an employee's personal purchases are not the employer's to see.
 */
businessRouter.get("/business/export.csv", rbac(["partner", "admin"]), async (c) => {
  const db = c.env.DB;
  const partnerId = scopedPartnerId(c, c.req.query("partner_id"));
  if (!partnerId) {
    return c.json({ error: "ต้องผูกบัญชีกับรหัสองค์กรพาร์ตเนอร์" }, 400);
  }

  try {
    const partner = await db.prepare("SELECT id, company_name FROM partners WHERE id = ?")
      .bind(partnerId).first<{ id: string; company_name: string }>();
    if (!partner) return c.json({ error: "ไม่พบองค์กรพาร์ตเนอร์" }, 404);

    const rows = await db
      .prepare(
        `SELECT u.name, u.email, u.status AS account_status, u.created_at, u.last_login_at,
                c.title AS course_title, e.status, e.progress_percent, e.enrolled_at, e.completed_at, e.expires_at
         FROM users u
         LEFT JOIN enrollments e ON e.user_id = u.id AND ${sponsoredBySql("e", "?1")}
         LEFT JOIN courses c ON c.id = e.course_id
         WHERE u.partner_id = ?1 AND u.role = 'student' AND u.staff_role IS NULL
         ORDER BY u.name, u.email, c.title`
      )
      .bind(partnerId)
      .all<Record<string, any>>();

    // Quote every cell and neutralise spreadsheet formulas (names and titles are user input).
    const cell = (value: unknown) => {
      let text = String(value ?? "");
      if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const header = ["ชื่อ-นามสกุล", "อีเมล", "สถานะบัญชี", "วันที่เพิ่มเข้าระบบ", "เข้าสู่ระบบล่าสุด",
      "คอร์ส", "สถานะการเรียน", "ความคืบหน้า (%)", "วันที่เริ่มเรียน", "วันที่เรียนจบ", "สิทธิ์หมดอายุ"];
    const lines = rows.results.map(r => [r.name, r.email, ACCOUNT_STATUS_TH[r.account_status] || r.account_status,
      r.created_at, r.last_login_at, r.course_title, r.status ? ENROLLMENT_STATUS_TH[r.status] || r.status : "ยังไม่ได้ลงทะเบียน",
      r.course_title ? r.progress_percent ?? 0 : "", r.enrolled_at, r.completed_at, r.expires_at].map(cell).join(","));
    const csv = "﻿" + [header.map(cell).join(","), ...lines].join("\r\n");
    const filename = `employees-${partner.id.replace(/[^\w-]/g, "")}-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    console.error("B2B roster export failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะส่งออกรายชื่อพนักงาน" }, 500);
  }
});

/**
 * List organizations. Admins see every organization in full; a partner sees only their own; an
 * instructor sees only organizations that sponsor one of their courses (to assign seats). Only admins
 * see tax IDs.
 * GET /api/business/partners
 */
businessRouter.get("/business/partners", rbac(["admin", "instructor", "partner"]), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const columns = "p.id, p.company_name, p.partner_type, p.total_seats, p.allocated_seats";
  try {
    let stmt: D1PreparedStatement;
    if (user.roles.includes("admin")) {
      stmt = db.prepare("SELECT * FROM partners p ORDER BY company_name ASC");
    } else if (user.roles.includes("instructor")) {
      stmt = db.prepare(`SELECT ${columns} FROM partners p
        WHERE p.id = ?1 OR EXISTS (SELECT 1 FROM partner_courses pc JOIN courses co ON co.id = pc.course_id
          WHERE pc.partner_id = p.id AND co.instructor_id = ?2)
        ORDER BY p.company_name ASC`).bind(user.roles.includes("partner") ? user.partner_id : null, user.id);
    } else {
      if (!user.partner_id) return c.json([]);
      stmt = db.prepare(`SELECT ${columns} FROM partners p WHERE p.id = ?`).bind(user.partner_id);
    }
    const partners = await stmt.all();
    return c.json(partners.results);
  } catch (error) {
    console.error("List partners failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดรายชื่อองค์กรลูกค้า" }, 500);
  }
});

/**
 * List sponsored courses for B2B partner
 * GET /api/business/courses
 */
businessRouter.get("/business/courses", rbac(["partner", "admin"]), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");

  let partnerId = user.role === "partner" ? user.partner_id : c.req.query("partner_id");
  if (!partnerId) {
    return c.json({ error: "ต้องผูกบัญชีกับรหัสองค์กรพาร์ตเนอร์" }, 400);
  }

  try {
    // 1. Fetch all courses with a flag indicating if they are sponsored for this partner
    const coursesRes = await db
      .prepare(
        `SELECT c.id, c.title, c.description, c.price,
                CASE WHEN pc.partner_id IS NOT NULL THEN 1 ELSE 0 END as is_sponsored
         FROM courses c
         LEFT JOIN partner_courses pc ON c.id = pc.course_id AND pc.partner_id = ?
         WHERE c.status = 'published'`
      )
      .bind(partnerId)
      .all<{ id: string; title: string; description: string; price: number; is_sponsored: number }>();

    return c.json(coursesRes.results);
  } catch (error: any) {
    console.error("List B2B courses failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดคอร์สขององค์กร" }, 500);
  }
});

/**
 * Assign sponsored course to student seat
 * POST /api/business/courses/assign
 */
businessRouter.post("/business/courses/assign", rbac(["partner", "admin"]), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const { student_id, course_id } = await c.req.json<{ student_id: string; course_id: string }>();

  if (!student_id || !course_id) {
    return c.json({ error: "ต้องระบุ student_id และ course_id" }, 400);
  }

  const partnerId = scopedPartnerId(c, c.req.query("partner_id"));
  if (!partnerId) {
    return c.json({ error: "ต้องผูกบัญชีกับรหัสองค์กรพาร์ตเนอร์" }, 400);
  }

  try {
    // 1. Verify student belongs to this partner
    const student = await db
      .prepare("SELECT id FROM users WHERE id = ? AND partner_id = ? AND role = 'student'")
      .bind(student_id, partnerId)
      .first<{ id: string }>();

    if (!student) {
      return c.json({ error: "ผู้เรียนนี้ไม่ได้อยู่ในองค์กรของคุณ" }, 404);
    }

    // 2. Verify course is sponsored/purchased by this partner
    const sponsored = await db
      .prepare(`SELECT pc.course_id FROM partner_courses pc JOIN courses co ON co.id = pc.course_id
        WHERE pc.partner_id = ? AND pc.course_id = ? AND co.status = 'published'`)
      .bind(partnerId, course_id)
      .first<{ course_id: string }>();

    if (!sponsored) {
      return c.json({ error: "องค์กรของคุณยังไม่ได้สนับสนุนหรือซื้อคอร์สนี้" }, 400);
    }

    // 3. Check if enrollment already exists
    const existing = await db
      .prepare("SELECT id, status FROM enrollments WHERE user_id = ? AND course_id = ?")
      .bind(student_id, course_id)
      .first<{ id: string; status: string }>();

    if (existing && existing.status !== "suspended") {
      return c.json({ message: "ผู้เรียนลงทะเบียนเรียนคอร์สนี้แล้ว" });
    }
    if (existing) {
      // Suspended earlier (e.g. left a previous organization): this organization sponsors it again.
      await db.prepare("UPDATE enrollments SET status = 'active', partner_id = ? WHERE id = ?").bind(partnerId, existing.id).run();
      return c.json({ message: "เปิดสิทธิ์คอร์สนี้ให้ผู้เรียนอีกครั้งแล้ว", enrollment: { id: existing.id, user_id: student_id, course_id } });
    }

    // 4. Insert enrollment, marked as sponsored by this organization
    const enrollmentId = "enr_" + crypto.randomUUID().substring(0, 8);
    await db
      .prepare("INSERT INTO enrollments (id, user_id, course_id, progress_percent, status, partner_id) VALUES (?, ?, ?, 0, 'active', ?) ON CONFLICT(user_id, course_id) DO NOTHING")
      .bind(enrollmentId, student_id, course_id, partnerId)
      .run();

    return c.json({
      message: "มอบหมายคอร์สให้ผู้เรียนเรียบร้อยแล้ว",
      enrollment: {
        id: enrollmentId,
        user_id: student_id,
        course_id
      }
    }, 201);
  } catch (error: any) {
    console.error("Assign course failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะมอบหมายคอร์ส" }, 500);
  }
});
