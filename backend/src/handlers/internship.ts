import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";

export const internshipRouter = new Hono<Env>();

// ==========================================
// STUDENT ENDPOINTS
// ==========================================

// Get all open internship openings
internshipRouter.get("/internships/openings", rbac(["student", "partner", "admin"]), async (c) => {
  const db = c.env.DB;
  try {
    const openings = await db.prepare(`
      SELECT io.*, p.company_name, c.title as course_title
      FROM internship_openings io
      INNER JOIN partners p ON io.partner_id = p.id
      INNER JOIN courses c ON io.required_course_id = c.id
      WHERE io.status = 'open'
      ORDER BY io.created_at DESC
    `).all();

    return c.json(openings.results);
  } catch (error: any) {
    console.error("Fetch openings failed:", error);
    return c.json({ error: "ดึงข้อมูลตำแหน่งฝึกงานไม่สำเร็จ", message: error.message }, 500);
  }
});

// Get student's own applications
internshipRouter.get("/internships/applications/me", rbac(["student"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  try {
    const applications = await db.prepare(`
      SELECT ia.*, io.title as opening_title, p.company_name, c.title as required_course_title
      FROM internship_applications ia
      INNER JOIN internship_openings io ON ia.opening_id = io.id
      INNER JOIN partners p ON io.partner_id = p.id
      INNER JOIN courses c ON io.required_course_id = c.id
      WHERE ia.student_id = ?
      ORDER BY ia.created_at DESC
    `).bind(user.id).all();

    return c.json(applications.results);
  } catch (error: any) {
    console.error("Fetch my applications failed:", error);
    return c.json({ error: "ดึงข้อมูลใบสมัครไม่สำเร็จ", message: error.message }, 500);
  }
});

// Apply for an internship opening
internshipRouter.post("/internships/applications", rbac(["student"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  try {
    const { openingId } = await c.req.json<{ openingId: string }>();
    if (!openingId) {
      return c.json({ error: "ต้องระบุ openingId" }, 400);
    }

    // 1. Verify opening exists and is open
    const opening = await db.prepare(`
      SELECT * FROM internship_openings WHERE id = ? AND status = 'open'
    `).bind(openingId).first<any>();

    if (!opening) {
      return c.json({ error: "ไม่พบตำแหน่งฝึกงานหรือปิดรับสมัครแล้ว" }, 404);
    }

    // 2. Check if student already applied
    const existing = await db.prepare(`
      SELECT id FROM internship_applications WHERE opening_id = ? AND student_id = ?
    `).bind(openingId, user.id).first<any>();

    if (existing) {
      return c.json({ error: "คุณสมัครตำแหน่งนี้ไปแล้ว" }, 400);
    }

    // 3. Verify student eligibility (completed course with progress >= 95%)
    const enrollment = await db.prepare(`
      SELECT progress_percent FROM enrollments WHERE user_id = ? AND course_id = ?
    `).bind(user.id, opening.required_course_id).first<{ progress_percent: number }>();

    if (!enrollment || enrollment.progress_percent < 95) {
      return c.json({
        error: "ตรวจสอบคุณสมบัติไม่ผ่าน",
        message: "คุณต้องเรียนคอร์สที่กำหนดให้ถึงอย่างน้อย 95% ก่อนสมัคร"
      }, 403);
    }

    // 4. Create application
    const appId = `app_${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO internship_applications (id, opening_id, student_id, status)
      VALUES (?, ?, ?, 'applied')
    `).bind(appId, openingId, user.id).run();

    return c.json({ success: true, applicationId: appId, status: "applied" });
  } catch (error: any) {
    console.error("Submit application failed:", error);
    return c.json({ error: "ส่งใบสมัครไม่สำเร็จ", message: error.message }, 500);
  }
});

// Get daily logs for a specific application
internshipRouter.get("/internships/applications/:id/logs", rbac(["student", "partner", "admin"]), async (c) => {
  const user = c.get("user");
  const appId = c.req.param("id");
  const db = c.env.DB;

  try {
    // Access control check: student can view own; partner/admin can view if company matches or student is university student
    const application = await db.prepare(`
      SELECT ia.*, io.partner_id as company_id, u.partner_id as student_univ_id
      FROM internship_applications ia
      INNER JOIN internship_openings io ON ia.opening_id = io.id
      INNER JOIN users u ON ia.student_id = u.id
      WHERE ia.id = ?
    `).bind(appId).first<any>();

    if (!application) {
      return c.json({ error: "ไม่พบใบสมัคร" }, 404);
    }

    if (user.role === "student" && application.student_id !== user.id) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึงบันทึกเวลาฝึกงาน" }, 403);
    }

    if (user.role === "partner") {
      // Must either be the company posting the opening, or the university coordinator for the student
      const partner = await db.prepare("SELECT partner_type FROM partners WHERE id = ?").bind(user.partner_id).first<{ partner_type: string }>();
      if (!partner) {
        return c.json({ error: "ไม่พบองค์กรพาร์ตเนอร์" }, 403);
      }

      if (partner.partner_type === "company" && application.company_id !== user.partner_id) {
        return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ใบสมัครนี้เป็นของบริษัทอื่น" }, 403);
      }

      if (partner.partner_type === "university" && application.student_univ_id !== user.partner_id) {
        return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ผู้เรียนคนนี้ไม่ได้ศึกษาอยู่ในมหาวิทยาลัยของคุณ" }, 403);
      }
    }

    const logs = await db.prepare(`
      SELECT * FROM internship_daily_logs
      WHERE application_id = ?
      ORDER BY log_date DESC, created_at DESC
    `).bind(appId).all();

    return c.json(logs.results);
  } catch (error: any) {
    console.error("Fetch daily logs failed:", error);
    return c.json({ error: "ดึงข้อมูลบันทึกประจำวันไม่สำเร็จ", message: error.message }, 500);
  }
});

// Submit a new daily log
internshipRouter.post("/internships/applications/:id/logs", rbac(["student"]), async (c) => {
  const user = c.get("user");
  const appId = c.req.param("id");
  const db = c.env.DB;

  try {
    const { logDate, hoursWorked, activityDescription } = await c.req.json<{
      logDate: string;
      hoursWorked: number;
      activityDescription: string;
    }>();

    if (!logDate || !hoursWorked || !activityDescription) {
      return c.json({ error: "กรุณากรอกข้อมูลให้ครบทุกช่อง" }, 400);
    }

    if (hoursWorked <= 0 || hoursWorked > 24) {
      return c.json({ error: "ชั่วโมงทำงานต้องอยู่ระหว่าง 0.1 ถึง 24" }, 400);
    }

    // Verify application belongs to student and is accepted or completed
    const application = await db.prepare(`
      SELECT id, status FROM internship_applications
      WHERE id = ? AND student_id = ?
    `).bind(appId, user.id).first<{ id: string; status: string }>();

    if (!application) {
      return c.json({ error: "ไม่พบใบสมัครหรือไม่มีสิทธิ์เข้าถึง" }, 404);
    }

    if (application.status !== "accepted" && application.status !== "completed") {
      return c.json({ error: "ส่งบันทึกประจำวันได้เฉพาะการฝึกงานที่ได้รับการอนุมัติหรือกำลังดำเนินอยู่" }, 400);
    }

    const logId = `log_${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO internship_daily_logs (id, application_id, log_date, hours_worked, activity_description, company_approved, university_approved)
      VALUES (?, ?, ?, ?, ?, 0, 0)
    `).bind(logId, appId, logDate, hoursWorked, activityDescription).run();

    const { awardExp, unlockAchievement } = await import("../utils/gamification");
    const gamificationResult = await awardExp(db, user.id, 50);
    const unlockRes = await unlockAchievement(db, user.id, "ach_first_log");

    return c.json({
      success: true,
      logId,
      gamification: gamificationResult,
      achievementUnlocked: unlockRes.unlocked ? unlockRes.achievementName : null
    });
  } catch (error: any) {
    console.error("Submit log failed:", error);
    return c.json({ error: "ส่งบันทึกประจำวันไม่สำเร็จ", message: error.message }, 500);
  }
});


// ==========================================
// COMPANY ENDPOINTS
// ==========================================

// Middleware check for company partner
async function checkCompanyPartner(c: Context<Env>) {
  const user = c.get("user");
  const db = c.env.DB;

  if (user.role === "admin") return true;
  if (user.role !== "partner") return false;

  const partner = await db.prepare("SELECT partner_type FROM partners WHERE id = ?").bind(user.partner_id).first<{ partner_type: string }>();
  return partner?.partner_type === "company";
}

// Create internship opening
internshipRouter.post("/internships/openings", rbac(["partner", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  if (!(await checkCompanyPartner(c))) {
    return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องเป็นพาร์ตเนอร์องค์กรเท่านั้น" }, 403);
  }

  try {
    const { title, description, requiredCourseId } = await c.req.json<{
      title: string;
      description: string;
      requiredCourseId: string;
    }>();

    if (!title || !description || !requiredCourseId) {
      return c.json({ error: "กรุณากรอกข้อมูลให้ครบทุกช่อง" }, 400);
    }

    // Verify course exists
    const course = await db.prepare("SELECT id FROM courses WHERE id = ?").bind(requiredCourseId).first();
    if (!course) {
      return c.json({ error: "ไม่พบคอร์ส" }, 404);
    }

    const partnerId = user.role === "admin" ? c.req.query("partner_id") || "partner_acme" : user.partner_id;

    const openingId = `op_${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO internship_openings (id, partner_id, title, description, required_course_id, status)
      VALUES (?, ?, ?, ?, ?, 'open')
    `).bind(openingId, partnerId, title, description, requiredCourseId).run();

    return c.json({ success: true, openingId });
  } catch (error: any) {
    console.error("Create opening failed:", error);
    return c.json({ error: "สร้างตำแหน่งฝึกงานไม่สำเร็จ", message: error.message }, 500);
  }
});

// List company's own openings
internshipRouter.get("/internships/openings/my", rbac(["partner", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  if (!(await checkCompanyPartner(c))) {
    return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องเป็นพาร์ตเนอร์องค์กรเท่านั้น" }, 403);
  }

  const partnerId = user.role === "admin" ? c.req.query("partner_id") || "partner_acme" : user.partner_id;

  try {
    const openings = await db.prepare(`
      SELECT io.*, c.title as course_title
      FROM internship_openings io
      INNER JOIN courses c ON io.required_course_id = c.id
      WHERE io.partner_id = ?
      ORDER BY io.created_at DESC
    `).bind(partnerId).all();

    return c.json(openings.results);
  } catch (error: any) {
    console.error("Fetch openings failed:", error);
    return c.json({ error: "ดึงข้อมูลตำแหน่งฝึกงานไม่สำเร็จ", message: error.message }, 500);
  }
});

// List applications received by the company
internshipRouter.get("/internships/applications/company", rbac(["partner", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  if (!(await checkCompanyPartner(c))) {
    return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องเป็นพาร์ตเนอร์องค์กรเท่านั้น" }, 403);
  }

  const partnerId = user.role === "admin" ? c.req.query("partner_id") || "partner_acme" : user.partner_id;

  try {
    const apps = await db.prepare(`
      SELECT ia.*, io.title as opening_title, u.name as student_name, u.email as student_email,
             e.progress_percent as course_progress, p.company_name as student_univ_name
      FROM internship_applications ia
      INNER JOIN internship_openings io ON ia.opening_id = io.id
      INNER JOIN users u ON ia.student_id = u.id
      LEFT JOIN enrollments e ON u.id = e.user_id AND io.required_course_id = e.course_id
      LEFT JOIN partners p ON u.partner_id = p.id AND p.partner_type = 'university'
      WHERE io.partner_id = ?
      ORDER BY ia.created_at DESC
    `).bind(partnerId).all();

    return c.json(apps.results);
  } catch (error: any) {
    console.error("Fetch company applications failed:", error);
    return c.json({ error: "ดึงข้อมูลใบสมัครไม่สำเร็จ", message: error.message }, 500);
  }
});

// Update application status/evaluation by company
internshipRouter.patch("/internships/applications/:id/status", rbac(["partner", "admin"]), async (c) => {
  const user = c.get("user");
  const appId = c.req.param("id");
  const db = c.env.DB;

  if (!(await checkCompanyPartner(c))) {
    return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องเป็นพาร์ตเนอร์องค์กรเท่านั้น" }, 403);
  }

  try {
    const { status, evaluationScore, evaluationFeedback } = await c.req.json<{
      status?: string;
      evaluationScore?: number;
      evaluationFeedback?: string;
    }>();

    // Verify company owns the opening
    const app = await db.prepare(`
      SELECT ia.*, io.partner_id
      FROM internship_applications ia
      INNER JOIN internship_openings io ON ia.opening_id = io.id
      WHERE ia.id = ?
    `).bind(appId).first<any>();

    if (!app) {
      return c.json({ error: "ไม่พบใบสมัคร" }, 404);
    }

    if (user.role !== "admin" && app.partner_id !== user.partner_id) {
      return c.json({ error: "ไม่มีสิทธิ์แก้ไขใบสมัครนี้" }, 403);
    }

    let query = "UPDATE internship_applications SET updated_at = CURRENT_TIMESTAMP";
    const params: any[] = [];

    if (status !== undefined) {
      query += ", status = ?";
      params.push(status);
    }
    if (evaluationScore !== undefined) {
      query += ", evaluation_score = ?";
      params.push(evaluationScore);
    }
    if (evaluationFeedback !== undefined) {
      query += ", evaluation_feedback = ?";
      params.push(evaluationFeedback);
    }

    query += " WHERE id = ?";
    params.push(appId);

    await db.prepare(query).bind(...params).run();

    let gamificationResult = null;
    let achievementUnlocked = null;

    if (status === "completed" && app.status !== "completed") {
      const { awardExp, unlockAchievement } = await import("../utils/gamification");
      gamificationResult = await awardExp(db, app.student_id, 1000);

      const score = evaluationScore !== undefined ? evaluationScore : (app.evaluation_score || 0);
      if (score >= 90) {
        const unlockRes = await unlockAchievement(db, app.student_id, "ach_high_eval");
        if (unlockRes.unlocked) {
          achievementUnlocked = unlockRes.achievementName;
        }
      }
    }

    return c.json({
      success: true,
      gamification: gamificationResult,
      achievementUnlocked
    });
  } catch (error: any) {
    console.error("Update status failed:", error);
    return c.json({ error: "อัปเดตใบสมัครไม่สำเร็จ", message: error.message }, 500);
  }
});

// Approve log by company
internshipRouter.patch("/internships/logs/:logId/approve-company", rbac(["partner", "admin"]), async (c) => {
  const user = c.get("user");
  const logId = c.req.param("logId");
  const db = c.env.DB;

  if (!(await checkCompanyPartner(c))) {
    return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องเป็นพาร์ตเนอร์องค์กรเท่านั้น" }, 403);
  }

  try {
    const { approved } = await c.req.json<{ approved: number }>(); // 1: approve, -1: reject

    // Verify company owns the internship opening for the log
    const log = await db.prepare(`
      SELECT idl.*, io.partner_id as company_id, ia.student_id
      FROM internship_daily_logs idl
      INNER JOIN internship_applications ia ON idl.application_id = ia.id
      INNER JOIN internship_openings io ON ia.opening_id = io.id
      WHERE idl.id = ?
    `).bind(logId).first<any>();

    if (!log) {
      return c.json({ error: "ไม่พบบันทึกประจำวัน" }, 404);
    }

    if (user.role !== "admin" && log.company_id !== user.partner_id) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ผู้เรียนคนนี้ฝึกงานกับบริษัทอื่น" }, 403);
    }

    await db.prepare(`
      UPDATE internship_daily_logs
      SET company_approved = ?
      WHERE id = ?
    `).bind(approved, logId).run();

    let gamificationResult = null;
    let achievementUnlocked = null;

    if (approved === 1 && log.company_approved !== 1) {
      const { awardExp, unlockAchievement } = await import("../utils/gamification");
      gamificationResult = await awardExp(db, log.student_id, 100);

      // Check count of company approved logs
      const approvedCount = await db.prepare(`
        SELECT COUNT(idl.id) as count
        FROM internship_daily_logs idl
        INNER JOIN internship_applications ia ON idl.application_id = ia.id
        WHERE ia.student_id = ? AND idl.company_approved = 1
      `).bind(log.student_id).first<{ count: number }>();

      if (approvedCount && approvedCount.count >= 5) {
        const unlockRes = await unlockAchievement(db, log.student_id, "ach_diligent_work");
        if (unlockRes.unlocked) {
          achievementUnlocked = unlockRes.achievementName;
        }
      }
    }

    return c.json({
      success: true,
      gamification: gamificationResult,
      achievementUnlocked
    });
  } catch (error: any) {
    console.error("Company log approval failed:", error);
    return c.json({ error: "อัปเดตสถานะบันทึกประจำวันไม่สำเร็จ", message: error.message }, 500);
  }
});


// ==========================================
// UNIVERSITY COORDINATOR ENDPOINTS
// ==========================================

// Middleware check for university partner
async function checkUniversityPartner(c: Context<Env>) {
  const user = c.get("user");
  const db = c.env.DB;

  if (user.role === "admin") return true;
  if (user.role !== "partner") return false;

  const partner = await db.prepare("SELECT partner_type FROM partners WHERE id = ?").bind(user.partner_id).first<{ partner_type: string }>();
  return partner?.partner_type === "university";
}

// Get student application details for university
internshipRouter.get("/internships/applications/university", rbac(["partner", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  if (!(await checkUniversityPartner(c))) {
    return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องเป็นผู้ประสานงานมหาวิทยาลัยเท่านั้น" }, 403);
  }

  const partnerId = user.role === "admin" ? c.req.query("partner_id") || "partner_mit" : user.partner_id;

  try {
    const apps = await db.prepare(`
      SELECT ia.*, io.title as opening_title, u.name as student_name, u.email as student_email,
             e.progress_percent as course_progress, p.company_name as company_name
      FROM internship_applications ia
      INNER JOIN internship_openings io ON ia.opening_id = io.id
      INNER JOIN users u ON ia.student_id = u.id
      LEFT JOIN enrollments e ON u.id = e.user_id AND io.required_course_id = e.course_id
      INNER JOIN partners p ON io.partner_id = p.id
      WHERE u.partner_id = ?
      ORDER BY ia.created_at DESC
    `).bind(partnerId).all();

    return c.json(apps.results);
  } catch (error: any) {
    console.error("Fetch university student applications failed:", error);
    return c.json({ error: "ดึงข้อมูลใบสมัครไม่สำเร็จ", message: error.message }, 500);
  }
});

// Update coordinator feedback
internshipRouter.patch("/internships/applications/:id/university-feedback", rbac(["partner", "admin"]), async (c) => {
  const user = c.get("user");
  const appId = c.req.param("id");
  const db = c.env.DB;

  if (!(await checkUniversityPartner(c))) {
    return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องเป็นผู้ประสานงานมหาวิทยาลัยเท่านั้น" }, 403);
  }

  try {
    const { universityFeedback } = await c.req.json<{ universityFeedback: string }>();

    // Verify student belongs to this coordinator's university
    const app = await db.prepare(`
      SELECT ia.*, u.partner_id as student_univ_id
      FROM internship_applications ia
      INNER JOIN users u ON ia.student_id = u.id
      WHERE ia.id = ?
    `).bind(appId).first<any>();

    if (!app) {
      return c.json({ error: "ไม่พบใบสมัคร" }, 404);
    }

    if (user.role !== "admin" && app.student_univ_id !== user.partner_id) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ผู้เรียนสังกัดมหาวิทยาลัยอื่น" }, 403);
    }

    await db.prepare(`
      UPDATE internship_applications
      SET university_feedback = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(universityFeedback, appId).run();

    return c.json({ success: true });
  } catch (error: any) {
    console.error("Update university feedback failed:", error);
    return c.json({ error: "อัปเดตความคิดเห็นไม่สำเร็จ", message: error.message }, 500);
  }
});

// Approve log by university coordinator
internshipRouter.patch("/internships/logs/:logId/approve-university", rbac(["partner", "admin"]), async (c) => {
  const user = c.get("user");
  const logId = c.req.param("logId");
  const db = c.env.DB;

  if (!(await checkUniversityPartner(c))) {
    return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องเป็นผู้ประสานงานมหาวิทยาลัยเท่านั้น" }, 403);
  }

  try {
    const { approved } = await c.req.json<{ approved: number }>(); // 1: approve, -1: reject

    // Verify student belongs to this university
    const log = await db.prepare(`
      SELECT idl.*, u.partner_id as student_univ_id, ia.student_id
      FROM internship_daily_logs idl
      INNER JOIN internship_applications ia ON idl.application_id = ia.id
      INNER JOIN users u ON ia.student_id = u.id
      WHERE idl.id = ?
    `).bind(logId).first<any>();

    if (!log) {
      return c.json({ error: "ไม่พบบันทึกประจำวัน" }, 404);
    }

    if (user.role !== "admin" && log.student_univ_id !== user.partner_id) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ผู้เรียนสังกัดมหาวิทยาลัยอื่น" }, 403);
    }

    await db.prepare(`
      UPDATE internship_daily_logs
      SET university_approved = ?
      WHERE id = ?
    `).bind(approved, logId).run();

    let gamificationResult = null;
    let achievementUnlocked = null;

    if (approved === 1 && log.university_approved !== 1) {
      const { awardExp, unlockAchievement } = await import("../utils/gamification");
      gamificationResult = await awardExp(db, log.student_id, 100);

      // Check count of university approved logs
      const approvedCount = await db.prepare(`
        SELECT COUNT(idl.id) as count
        FROM internship_daily_logs idl
        INNER JOIN internship_applications ia ON idl.application_id = ia.id
        WHERE ia.student_id = ? AND idl.university_approved = 1
      `).bind(log.student_id).first<{ count: number }>();

      if (approvedCount && approvedCount.count >= 5) {
        const unlockRes = await unlockAchievement(db, log.student_id, "ach_diligent_work");
        if (unlockRes.unlocked) {
          achievementUnlocked = unlockRes.achievementName;
        }
      }
    }

    return c.json({
      success: true,
      gamification: gamificationResult,
      achievementUnlocked
    });
  } catch (error: any) {
    console.error("University log approval failed:", error);
    return c.json({ error: "อัปเดตสถานะบันทึกประจำวันไม่สำเร็จ", message: error.message }, 500);
  }
});
