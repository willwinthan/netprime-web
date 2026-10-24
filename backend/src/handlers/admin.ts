import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { audit, recountSeats, suspendSponsoredEnrollments } from "./business";

export const adminRouter = new Hono<Env>();

/**
 * Get Platform Diagnostics & Corporate Audit
 * GET /api/admin/analytics
 */
adminRouter.get("/admin/analytics", rbac(["admin"]), async (c) => {
  const db = c.env.DB;

  try {
    // 1. Query aggregate counts
    const totalCorporatesResult = await db.prepare("SELECT COUNT(*) as count FROM partners").first<{ count: number }>();
    const totalUsersResult = await db.prepare("SELECT COUNT(*) as count FROM users").first<{ count: number }>();
    const totalCoursesResult = await db.prepare("SELECT COUNT(*) as count FROM courses").first<{ count: number }>();
    const totalEnrollmentsResult = await db.prepare("SELECT COUNT(*) as count FROM enrollments").first<{ count: number }>();

    // 2. Query B2B corporate lists
    const corporates = await db
      .prepare(
        `SELECT id, company_name, partner_type, total_seats, allocated_seats as used_seats, created_at
         FROM partners
         ORDER BY company_name ASC`
      )
      .all<{ id: string; company_name: string; partner_type: string; total_seats: number; used_seats: number; created_at: string }>();

    return c.json({
      totalCorporates: totalCorporatesResult?.count || 0,
      totalUsers: totalUsersResult?.count || 0,
      totalCourses: totalCoursesResult?.count || 0,
      totalEnrollments: totalEnrollmentsResult?.count || 0,
      corporates: corporates.results
    });
  } catch (error) {
    console.error("Admin analytics fetch failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดข้อมูลวินิจฉัยระบบ" }, 500);
  }
});

/**
 * List Platform Users (Admin Audit)
 * GET /api/admin/users
 */
adminRouter.get("/admin/users", rbac(["admin"]), async (c) => {
  const db = c.env.DB;

  try {
    const users = await db
      .prepare(
        `SELECT u.id, u.email, u.name, COALESCE(u.staff_role, u.role) AS role, u.partner_id as corporate_id, p.company_name, u.created_at
         FROM users u
         LEFT JOIN partners p ON u.partner_id = p.id
         ORDER BY u.created_at DESC`
      )
      .all<{ id: string; email: string; name: string; role: any; corporate_id: string | null; company_name: string | null; created_at: string }>();

    return c.json(users.results);
  } catch (error) {
    console.error("Admin users list failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดรายชื่อผู้ใช้" }, 500);
  }
});

/**
 * Provision B2B Corporate Partner (older screen; same rules as POST /api/admin/organizations)
 * POST /api/admin/corporates
 */
adminRouter.post("/admin/corporates", rbac(["admin"]), async (c) => {
  const result = await createOrganization(c);
  if ("error" in result) return c.json({ error: result.error }, result.status);
  const org = result.organization;
  return c.json({
    message: "สร้างองค์กรลูกค้าเรียบร้อยแล้ว",
    organization: org,
    corporate: { id: org.id, company_name: org.company_name, total_seats: org.total_seats, used_seats: 0 }
  }, 201);
});

// ==========================================
// Organization management (admin)
// ==========================================

const PARTNER_TYPES = ["company", "university"] as const;
type PartnerType = typeof PARTNER_TYPES[number];
const MAX_SEATS = 100000;

interface OrganizationRow {
  id: string; company_name: string; tax_id: string | null; partner_type: PartnerType;
  total_seats: number; allocated_seats: number; members: number; sponsored_courses: number; created_at: string;
}

/** Live seat usage (seat = organization account whose primary role is student) and member counts. */
const ORGANIZATION_SELECT = `SELECT p.id, p.company_name, p.tax_id, COALESCE(p.partner_type, 'company') AS partner_type,
    p.total_seats, p.created_at,
    (SELECT COUNT(*) FROM users u WHERE u.partner_id = p.id AND u.role = 'student' AND u.staff_role IS NULL) AS allocated_seats,
    (SELECT COUNT(*) FROM users u WHERE u.partner_id = p.id) AS members,
    (SELECT COUNT(*) FROM partner_courses pc WHERE pc.partner_id = p.id) AS sponsored_courses
  FROM partners p`;

function seatCount(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SEATS ? n : null;
}

const isPartnerType = (value: unknown): value is PartnerType => PARTNER_TYPES.includes(value as PartnerType);

function loadOrganization(db: D1Database, id: string) {
  return db.prepare(`${ORGANIZATION_SELECT} WHERE p.id = ?`).bind(id).first<OrganizationRow>();
}

async function createOrganization(c: Context<Env>): Promise<{ organization: OrganizationRow } | { error: string; status: 400 | 409 }> {
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return { error: "ข้อมูลไม่ถูกต้อง", status: 400 };
  const name = typeof body.company_name === "string" ? body.company_name.trim() : "";
  const seats = seatCount(body.total_seats);
  const type = body.partner_type === undefined ? "company" : body.partner_type;
  const taxId = typeof body.tax_id === "string" && body.tax_id.trim() ? body.tax_id.trim().slice(0, 40) : null;
  const requestedId = typeof body.id === "string" ? body.id.trim() : "";
  if (!name || name.length > 200) return { error: "กรุณากรอกชื่อองค์กร (ไม่เกิน 200 ตัวอักษร)", status: 400 };
  if (!seats) return { error: `จำนวนที่นั่งต้องเป็นจำนวนเต็ม 1–${MAX_SEATS.toLocaleString("en-US")}`, status: 400 };
  if (!isPartnerType(type)) return { error: "ประเภทองค์กรต้องเป็นบริษัทหรือมหาวิทยาลัย", status: 400 };
  if (requestedId && !/^[a-z0-9_-]{3,64}$/i.test(requestedId)) {
    return { error: "รหัสองค์กรใช้ได้เฉพาะ a-z 0-9 _ - ยาว 3–64 ตัวอักษร", status: 400 };
  }
  const id = requestedId || "partner_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  try {
    await db.prepare("INSERT INTO partners (id, company_name, tax_id, total_seats, allocated_seats, partner_type) VALUES (?, ?, ?, ?, 0, ?)")
      .bind(id, name, taxId, seats, type).run();
  } catch (error: any) {
    if (String(error?.message).includes("UNIQUE constraint failed")) return { error: "มีองค์กรที่ใช้รหัสนี้อยู่แล้ว", status: 409 };
    throw error;
  }
  await audit(c, "create", "organization", id, { company_name: name, partner_type: type, total_seats: seats });
  return { organization: (await loadOrganization(db, id))! };
}

/**
 * List organizations with seat usage
 * GET /api/admin/organizations
 */
adminRouter.get("/admin/organizations", rbac(["admin"]), async (c) => {
  try {
    const rows = await c.env.DB.prepare(`${ORGANIZATION_SELECT} ORDER BY p.company_name`).all<OrganizationRow>();
    return c.json({ organizations: rows.results });
  } catch (error) {
    console.error("List organizations failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดรายชื่อองค์กร" }, 500);
  }
});

/**
 * Create an organization (company or university)
 * POST /api/admin/organizations
 */
adminRouter.post("/admin/organizations", rbac(["admin"]), async (c) => {
  try {
    const result = await createOrganization(c);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({ message: "สร้างองค์กรเรียบร้อยแล้ว", organization: result.organization }, 201);
  } catch (error) {
    console.error("Create organization failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะสร้างองค์กร" }, 500);
  }
});

/**
 * Edit name, type, tax ID or total seats; seats cannot go below the seats in use
 * PATCH /api/admin/organizations/:id
 */
adminRouter.patch("/admin/organizations/:id", rbac(["admin"]), async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);

  try {
    const before = await loadOrganization(db, id);
    if (!before) return c.json({ error: "ไม่พบองค์กร" }, 404);

    const name = body.company_name === undefined ? before.company_name : typeof body.company_name === "string" ? body.company_name.trim() : "";
    const type = body.partner_type === undefined ? before.partner_type : body.partner_type;
    const seats = body.total_seats === undefined ? before.total_seats : seatCount(body.total_seats);
    const taxId = body.tax_id === undefined ? before.tax_id
      : typeof body.tax_id === "string" && body.tax_id.trim() ? body.tax_id.trim().slice(0, 40) : null;
    if (!name || name.length > 200) return c.json({ error: "กรุณากรอกชื่อองค์กร (ไม่เกิน 200 ตัวอักษร)" }, 400);
    if (!isPartnerType(type)) return c.json({ error: "ประเภทองค์กรต้องเป็นบริษัทหรือมหาวิทยาลัย" }, 400);
    if (!seats) return c.json({ error: `จำนวนที่นั่งต้องเป็นจำนวนเต็ม 1–${MAX_SEATS.toLocaleString("en-US")}` }, 400);

    // The capacity check runs in the same statement as the write, so a concurrent seat cannot slip under it.
    const results = await db.batch([
      db.prepare(`UPDATE partners SET company_name = ?1, partner_type = ?2, total_seats = ?3, tax_id = ?4
        WHERE id = ?5 AND ?3 >= (SELECT COUNT(*) FROM users u WHERE u.partner_id = ?5 AND u.role = 'student' AND u.staff_role IS NULL)`)
        .bind(name, type, seats, taxId, id),
      recountSeats(db, id)
    ]);
    if (!results[0].meta.changes) {
      const used = (await loadOrganization(db, id))?.allocated_seats ?? before.allocated_seats;
      return c.json({ error: `จำนวนที่นั่งต้องไม่น้อยกว่าที่ใช้อยู่ (${used} ที่นั่ง) นำพนักงานออกก่อนหากต้องการลดที่นั่ง` }, 400);
    }
    const changes: Record<string, unknown> = {};
    if (name !== before.company_name) changes.company_name = [before.company_name, name];
    if (type !== before.partner_type) changes.partner_type = [before.partner_type, type];
    if (seats !== before.total_seats) changes.total_seats = [before.total_seats, seats];
    if (taxId !== before.tax_id) changes.tax_id = [before.tax_id, taxId];
    if (Object.keys(changes).length) await audit(c, "update", "organization", id, changes);
    return c.json({ message: "บันทึกข้อมูลองค์กรแล้ว", organization: await loadOrganization(db, id) });
  } catch (error) {
    console.error("Update organization failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะบันทึกข้อมูลองค์กร" }, 500);
  }
});

/**
 * Transfer an employee to another organization (admin)
 * POST /api/admin/users/:id/transfer  { partner_id }
 * Checks a seat on the target in the same statement as the move, suspends what the previous
 * organization sponsored and recounts both organizations.
 */
adminRouter.post("/admin/users/:id/transfer", rbac(["admin"]), async (c) => {
  const db = c.env.DB;
  const userId = c.req.param("id");
  const body = await c.req.json<{ partner_id?: unknown }>().catch(() => null);
  const targetId = typeof body?.partner_id === "string" ? body.partner_id : "";
  if (!targetId) return c.json({ error: "กรุณาเลือกองค์กรปลายทาง" }, 400);

  try {
    const member = await db
      .prepare(`SELECT u.id, u.email, u.partner_id, (u.role = 'student' AND u.staff_role IS NULL) AS takes_seat,
          EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role NOT IN ('partner', 'student')) AS staff
         FROM users u WHERE u.id = ?`)
      .bind(userId)
      .first<{ id: string; email: string; partner_id: string | null; takes_seat: number; staff: number }>();
    if (!member) return c.json({ error: "ไม่พบผู้ใช้" }, 404);
    if (member.staff) return c.json({ error: "บัญชีองค์กรมีได้เฉพาะบทบาทพาร์ตเนอร์และผู้เรียน" }, 400);
    if (member.partner_id === targetId) return c.json({ error: "ผู้ใช้อยู่ในองค์กรนี้อยู่แล้ว" }, 400);
    const target = await db.prepare("SELECT id, company_name FROM partners WHERE id = ?").bind(targetId).first<{ id: string; company_name: string }>();
    if (!target) return c.json({ error: "ไม่พบองค์กรปลายทาง" }, 404);

    const fromId = member.partner_id;
    const statements = [
      db.prepare(`UPDATE users SET partner_id = ?1 WHERE id = ?2 AND partner_id IS ?3
        AND (NOT (role = 'student' AND staff_role IS NULL)
          OR (SELECT COUNT(*) FROM users x WHERE x.partner_id = ?1 AND x.role = 'student' AND x.staff_role IS NULL AND x.id != ?2)
             < (SELECT total_seats FROM partners WHERE id = ?1))`)
        .bind(targetId, userId, fromId),
      recountSeats(db, targetId)
    ];
    if (fromId) statements.push(suspendSponsoredEnrollments(db, userId, fromId), recountSeats(db, fromId));
    const results = await db.batch(statements);
    if (!results[0].meta.changes) {
      return c.json({ error: member.takes_seat ? `${target.company_name} ใช้ที่นั่งครบแล้ว เพิ่มที่นั่งก่อนย้าย` : "สถานะผู้ใช้เปลี่ยนไประหว่างดำเนินการ กรุณาโหลดข้อมูลใหม่" }, 409);
    }
    const suspended = fromId ? results[2].meta.changes || 0 : 0;
    await audit(c, "transfer", "user", userId, { email: member.email, from: fromId, to: targetId, suspended_enrollments: suspended });
    return c.json({ message: `ย้ายไป ${target.company_name} แล้ว`, from: fromId, to: targetId, suspended_enrollments: suspended });
  } catch (error) {
    console.error("Transfer employee failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะย้ายองค์กร" }, 500);
  }
});
