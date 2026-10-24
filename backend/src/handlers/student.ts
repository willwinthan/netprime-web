import { Hono } from "hono";
import { Env, rbac, UserPayload } from "../middleware/rbac";
import { discountedPrice, findUsableVoucher } from "../utils/vouchers";
import { ordersRouter } from "./orders";
import { certificatesRouter, newCertificateCode } from "./certificates";
import { verifiedTokenUserId } from "./courses";

export const studentRouter = new Hono<Env>();

// Bank-transfer orders and certificate administration live in their own files.
studentRouter.route("/", ordersRouter);
studentRouter.route("/", certificatesRouter);

async function learningProgress(db: D1Database, userId: string, courseId: string) {
  const lessons = await db.prepare(`SELECT COUNT(*) AS total, COUNT(lp.lesson_id) AS completed
    FROM lessons l LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ? AND lp.completed = 1
    WHERE l.course_id = ?`).bind(userId, courseId).first<{ total: number; completed: number }>();
  const quizzes = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(qa.correct), 0) AS correct
    FROM quizzes q JOIN lessons l ON l.id = q.lesson_id
    LEFT JOIN quiz_answers qa ON qa.quiz_id = q.id AND qa.user_id = ?
    WHERE l.course_id = ?`).bind(userId, courseId).first<{ total: number; correct: number }>();
  return {
    totalLessons: lessons?.total || 0,
    completedLessons: lessons?.completed || 0,
    totalQuestions: quizzes?.total || 0,
    correctAnswers: quizzes?.correct || 0,
    progressPercent: lessons?.total ? Math.floor((lessons.completed / lessons.total) * 100) : 0,
    quizPercent: quizzes?.total ? Math.floor((quizzes.correct / quizzes.total) * 100) : 100
  };
}

async function canAccessLesson(db: D1Database, user: UserPayload, lessonId: string) {
  const lesson = await db.prepare(`SELECT l.id FROM lessons l JOIN courses co ON co.id = l.course_id
    LEFT JOIN enrollments e ON e.course_id = l.course_id AND e.user_id = ?
    WHERE l.id = ? AND (
      ? = 1 OR (? = 1 AND co.instructor_id = ?) OR
      (? = 1 AND e.status IN ('active', 'completed') AND
        (e.expires_at IS NULL OR e.expires_at > CURRENT_TIMESTAMP)))`)
    .bind(user.id, lessonId, user.roles.includes("admin") ? 1 : 0, user.roles.includes("instructor") ? 1 : 0, user.id,
      user.roles.includes("student") ? 1 : 0).first();
  return !!lesson;
}

/**
 * Update Student Progress
 * PATCH /api/student/progress
 */
studentRouter.patch("/student/progress", rbac(["student", "admin"]), (c) =>
  c.json({ error: "ความคืบหน้าของคอร์สคำนวณจากบทเรียนที่เรียนจบแล้ว" }, 403)
);

/**
 * Retrieve Quizzes for a Course
 * GET /api/student/courses/:id/quizzes
 */
studentRouter.get("/student/courses/:id/quizzes", rbac(["student", "admin"]), async (c) => {
  const courseId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    // Verify enrollment before serving quiz questions
    const enrolled = await db
      .prepare("SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?")
      .bind(user.id, courseId)
      .first();

    if (!enrolled && user.role !== "admin") {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องลงทะเบียนเรียนคอร์สนี้ก่อนจึงจะดูแบบทดสอบได้" }, 403);
    }

    const quizzes = await db
      .prepare(
        `SELECT q.id, q.lesson_id, q.question, q.options_json, l.title as lesson_title
         FROM quizzes q
         INNER JOIN lessons l ON q.lesson_id = l.id
         WHERE l.course_id = ?
         ORDER BY l.sort_order ASC, q.id ASC`
      )
      .bind(courseId)
      .all<{ id: string; lesson_id: string; question: string; options_json: string; lesson_title: string }>();

    // Parse options_json and redact correct_option_index to prevent student cheating
    const quizzesSanitized = quizzes.results.map(q => {
      let options = [];
      try {
        options = JSON.parse(q.options_json);
      } catch (err) {
        options = [];
      }
      return {
        id: q.id,
        lessonId: q.lesson_id,
        lessonTitle: q.lesson_title,
        question: q.question,
        options
      };
    });

    return c.json(quizzesSanitized);

  } catch (error) {
    console.error("Get course quizzes failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดแบบทดสอบ" }, 500);
  }
});

/**
 * Submit Quiz Assessment Answer
 * POST /api/student/quizzes/:id/submit
 */
studentRouter.post("/student/quizzes/:id/submit", rbac(["student", "admin"]), async (c) => {
  const quizId = c.req.param("id");
  const user = c.get("user");
  const { answer_index } = await c.req.json<{ answer_index: number }>();
  const db = c.env.DB;

  if (!Number.isInteger(answer_index) || answer_index < 0) {
    return c.json({ error: "ต้องระบุ answer_index" }, 400);
  }

  try {
    const quiz = await db
      .prepare(`SELECT q.correct_option_index, q.options_json, l.course_id FROM quizzes q
        JOIN lessons l ON l.id = q.lesson_id WHERE q.id = ?`)
      .bind(quizId)
      .first<{ correct_option_index: number; options_json: string; course_id: string }>();

    if (!quiz) {
      return c.json({ error: "ไม่พบคำถามแบบทดสอบ" }, 404);
    }

    const enrolled = await db.prepare("SELECT id FROM enrollments WHERE user_id = ? AND course_id = ? AND status IN ('active', 'completed') AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)")
      .bind(user.id, quiz.course_id).first();
    if (!enrolled) return c.json({ error: "ต้องมีการลงทะเบียนเรียนที่ใช้งานอยู่" }, 403);
    const options = JSON.parse(quiz.options_json) as unknown[];
    if (answer_index >= options.length) return c.json({ error: "คำตอบไม่ถูกต้อง" }, 400);
    const isCorrect = answer_index === quiz.correct_option_index;
    await db.prepare(`INSERT INTO quiz_answers (user_id, quiz_id, answer_index, correct)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_id, quiz_id) DO UPDATE SET
      answer_index = excluded.answer_index, correct = excluded.correct, submitted_at = CURRENT_TIMESTAMP`)
      .bind(user.id, quizId, answer_index, isCorrect ? 1 : 0).run();

    return c.json({
      quizId,
      correct: isCorrect
    });

  } catch (error) {
    console.error("Quiz submission evaluation failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะตรวจคำตอบแบบทดสอบ" }, 500);
  }
});

/**
 * Apply voucher code to course purchase checkout
 * POST /api/student/vouchers/apply
 */
studentRouter.post("/student/vouchers/apply", rbac(["student", "admin"]), async (c) => {
  const body = await c.req.json<{ code?: unknown; course_id?: unknown }>().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "";
  const courseId = typeof body?.course_id === "string" ? body.course_id : "";
  const db = c.env.DB;

  if (!code.trim() || !courseId) {
    return c.json({ error: "ต้องระบุโค้ดส่วนลดและ course_id" }, 400);
  }

  try {
    const course = await db.prepare("SELECT price FROM courses WHERE id = ?").bind(courseId).first<{ price: number }>();
    if (!course) return c.json({ error: "ไม่พบคอร์สนี้" }, 404);

    // Same rules as order creation: active, not expired, matching course, uses left.
    const voucher = await findUsableVoucher(db, code, courseId);
    if (!voucher) {
      return c.json({ error: "โค้ดส่วนลดใช้ไม่ได้ อาจหมดอายุ ใช้ครบสิทธิ์แล้ว หรือไม่ตรงกับคอร์สนี้" }, 400);
    }

    const originalPrice = Math.round(course.price);
    const finalPrice = discountedPrice(course.price, voucher);
    return c.json({
      code: voucher.code,
      discount_type: voucher.discount_type,
      discount_value: voucher.discount_value,
      original_price: originalPrice,
      discount_amount: originalPrice - finalPrice,
      final_price: finalPrice
    });
  } catch (error) {
    console.error("Apply voucher failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะใช้โค้ดส่วนลด" }, 500);
  }
});

/**
 * simulated Checkout payment transaction processing
 * POST /api/student/checkout
 */
studentRouter.post("/student/checkout", rbac(["student", "admin"]), (c) =>
  c.json({ error: "ปิดการชำระเงินจำลองแล้ว โปรดเริ่มการชำระเงินผ่านผู้ให้บริการที่ผ่านการตรวจสอบ" }, 403)
);

/**
 * Card checkout is switched off: courses are bought by bank transfer (POST /api/student/orders).
 * POST /api/student/checkout/session
 */
studentRouter.post("/student/checkout/session", rbac(["student", "admin"]), (c) =>
  c.json({ error: "ปิดการชำระเงินด้วยบัตรแล้ว กรุณากด \"ซื้อคอร์ส\" เพื่อสร้างคำสั่งซื้อและชำระด้วยการโอนเงิน", next: "/api/student/orders" }, 410)
);

/**
 * Former Omise webhook. Kept so provider retries get a clear answer; it never touches payments or enrollments.
 * POST /api/payment/omise-webhook
 */
studentRouter.post("/payment/omise-webhook", (c) =>
  c.json({ error: "ไม่ได้ใช้ผู้ให้บริการชำระเงินออนไลน์ การชำระเงินยืนยันโดยเจ้าหน้าที่" }, 410)
);

/**
 * Proxy download file from Cloudflare R2 ASSETS bucket
 * GET /api/student/lessons/:lessonId/handout
 */
studentRouter.get("/student/lessons/:lessonId/handout", rbac(["student", "admin"]), async (c) => {
  const lessonId = c.req.param("lessonId");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    // 1. Fetch lesson and check enrollment
    const lesson = await db
      .prepare(`
        SELECT l.handout_r2_key, l.course_id 
        FROM lessons l
        WHERE l.id = ?
      `)
      .bind(lessonId)
      .first<{ handout_r2_key: string | null; course_id: string }>();

    if (!lesson) {
      return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
    }

    if (!lesson.handout_r2_key) {
      return c.json({ error: "บทเรียนนี้ไม่มีเอกสารประกอบการเรียน" }, 404);
    }

    // Verify enrollment if not admin
    if (user.role !== "admin") {
      const enrollment = await db
        .prepare("SELECT id FROM enrollments WHERE user_id = ? AND course_id = ? AND status IN ('active', 'completed') AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)")
        .bind(user.id, lesson.course_id)
        .first();

      if (!enrollment) {
        return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องลงทะเบียนเรียนก่อนจึงจะดาวน์โหลดเอกสารได้" }, 403);
      }
    }

    const r2Key = lesson.handout_r2_key;
    const object = await c.env.ASSETS.get(r2Key);

    if (!object) {
      return c.json({ error: "ไม่พบไฟล์เอกสารประกอบการเรียนในที่เก็บข้อมูล" }, 404);
    }

    c.header("Content-Type", object.httpMetadata?.contentType || "application/pdf");
    c.header("Content-Disposition", `attachment; filename="${r2Key.split("/").pop() || "handout.pdf"}"`);
    return c.body(object.body);

  } catch (error) {
    console.error("Download handout failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดเอกสารประกอบการเรียน" }, 500);
  }
});

/**
 * Save quiz attempt history
 * POST /api/student/lessons/:lessonId/quiz-attempts
 */
studentRouter.post("/student/lessons/:lessonId/quiz-attempts", rbac(["student", "admin"]), (c) =>
  c.json({ error: "คะแนนแบบทดสอบคำนวณจากคำตอบที่ส่งเข้ามา" }, 403)
);

/**
 * Get quiz attempts for a course
 * GET /api/student/courses/:courseId/quiz-attempts
 */
studentRouter.get("/student/courses/:courseId/quiz-attempts", rbac(["student", "admin"]), async (c) => {
  const courseId = c.req.param("courseId");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const attempts = await db
      .prepare(`
        SELECT qa.quiz_id AS id, q.lesson_id, qa.correct AS score, 1 AS total_questions,
               qa.submitted_at, l.title AS lesson_title
        FROM quiz_answers qa
        INNER JOIN quizzes q ON q.id = qa.quiz_id
        INNER JOIN lessons l ON q.lesson_id = l.id
        WHERE l.course_id = ? AND qa.user_id = ?
        ORDER BY qa.submitted_at DESC
      `)
      .bind(courseId, user.id)
      .all();

    return c.json(attempts.results);
  } catch (error) {
    console.error("Get quiz attempts failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดประวัติการทำแบบทดสอบ" }, 500);
  }
});

/**
 * Save a timestamped lecture note
 * POST /api/student/notes
 */
studentRouter.post("/student/notes", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const { course_id, lesson_id, timestamp_seconds, content } = await c.req.json<{
    course_id: string;
    lesson_id: string;
    timestamp_seconds: number;
    content: string;
  }>();

  if (!course_id || !lesson_id || timestamp_seconds === undefined || !content?.trim()) {
    return c.json({ error: "ต้องระบุ course_id, lesson_id, timestamp_seconds และ content" }, 400);
  }

  try {
    const noteId = "note_" + crypto.randomUUID().substring(0, 8);
    await db
      .prepare(`
        INSERT INTO student_notes (id, user_id, course_id, lesson_id, timestamp_seconds, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(noteId, user.id, course_id, lesson_id, timestamp_seconds, content.trim())
      .run();

    return c.json({
      message: "บันทึกบันทึกย่อเรียบร้อยแล้ว",
      id: noteId,
      timestamp_seconds,
      content
    }, 201);
  } catch (error) {
    console.error("Save note failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะบันทึกบันทึกย่อ" }, 500);
  }
});

/**
 * List lecture notes for a course
 * GET /api/student/notes
 */
studentRouter.get("/student/notes", rbac(["student", "admin"]), async (c) => {
  const courseId = c.req.query("course_id");
  const user = c.get("user");
  const db = c.env.DB;

  if (!courseId) {
    return c.json({ error: "ต้องระบุพารามิเตอร์ course_id" }, 400);
  }

  try {
    const notes = await db
      .prepare(`
        SELECT sn.id, sn.lesson_id, sn.timestamp_seconds, sn.content, sn.created_at, l.title as lesson_title
        FROM student_notes sn
        INNER JOIN lessons l ON sn.lesson_id = l.id
        WHERE sn.user_id = ? AND sn.course_id = ?
        ORDER BY l.sort_order ASC, sn.timestamp_seconds ASC
      `)
      .bind(user.id, courseId)
      .all();

    return c.json(notes.results);
  } catch (error) {
    console.error("List notes failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดบันทึกย่อ" }, 500);
  }
});

/**
 * Delete a note
 * DELETE /api/student/notes/:id
 */
studentRouter.delete("/student/notes/:id", rbac(["student", "admin"]), async (c) => {
  const noteId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    await db
      .prepare("DELETE FROM student_notes WHERE id = ? AND user_id = ?")
      .bind(noteId, user.id)
      .run();

    return c.json({ message: "ลบบันทึกย่อเรียบร้อยแล้ว" });
  } catch (error) {
    console.error("Delete note failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะลบบันทึกย่อ" }, 500);
  }
});

/**
 * Save playback resume progress position
 * POST /api/student/lessons/:lessonId/progress
 */
studentRouter.post("/student/lessons/:lessonId/progress", rbac(["student", "admin"]), async (c) => {
  const lessonId = c.req.param("lessonId");
  const user = c.get("user");
  const db = c.env.DB;
  const { resume_seconds, completed } = await c.req.json<{ resume_seconds: number; completed?: number }>();

  if (!Number.isFinite(resume_seconds) || resume_seconds < 0 || (completed !== undefined && completed !== 0 && completed !== 1)) {
    return c.json({ error: "ต้องระบุค่า resume_seconds และ completed ที่ถูกต้อง" }, 400);
  }

  try {
    // 1. Fetch course_id from lesson
    const lesson = await db
      .prepare("SELECT course_id FROM lessons WHERE id = ?")
      .bind(lessonId)
      .first<{ course_id: string }>();

    if (!lesson) {
      return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
    }
    const enrolled = await db.prepare("SELECT id FROM enrollments WHERE user_id = ? AND course_id = ? AND status IN ('active', 'completed') AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)")
      .bind(user.id, lesson.course_id).first();
    if (!enrolled) return c.json({ error: "ต้องมีการลงทะเบียนเรียนที่ใช้งานอยู่" }, 403);

    // 2. Upsert progress record
    const compVal = completed ? 1 : 0;
    await db
      .prepare(`
        INSERT INTO lesson_progress (user_id, lesson_id, course_id, resume_seconds, completed)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, lesson_id) 
        DO UPDATE SET 
          resume_seconds = excluded.resume_seconds,
          completed = MAX(lesson_progress.completed, excluded.completed),
          updated_at = CURRENT_TIMESTAMP
      `)
      .bind(user.id, lessonId, lesson.course_id, resume_seconds, compVal)
      .run();

    const progress = await learningProgress(db, user.id, lesson.course_id);
    await db.prepare(`UPDATE enrollments SET progress_percent = ?,
      completed_at = CASE WHEN ? = 100 THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END,
      status = CASE WHEN ? = 100 THEN 'completed' ELSE 'active' END
      WHERE user_id = ? AND course_id = ?`)
      .bind(progress.progressPercent, progress.progressPercent, progress.progressPercent, user.id, lesson.course_id).run();

    return c.json({
      message: "บันทึกความคืบหน้าการดูบทเรียนเรียบร้อยแล้ว",
      resume_seconds,
      completed: compVal,
      progress_percent: progress.progressPercent
    });
  } catch (error) {
    console.error("Save lesson progress failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะบันทึกความคืบหน้าการดู" }, 500);
  }
});

/**
 * Get playback resume progress
 * GET /api/student/lessons/:lessonId/progress
 */
studentRouter.get("/student/lessons/:lessonId/progress", rbac(["student", "admin"]), async (c) => {
  const lessonId = c.req.param("lessonId");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const progress = await db
      .prepare("SELECT resume_seconds, completed FROM lesson_progress WHERE user_id = ? AND lesson_id = ?")
      .bind(user.id, lessonId)
      .first<{ resume_seconds: number; completed: number }>();

    if (!progress) {
      return c.json({ resume_seconds: 0, completed: 0 });
    }

    return c.json(progress);
  } catch (error) {
    console.error("Get lesson progress failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดความคืบหน้า" }, 500);
  }
});

/**
 * Issue Course Completion Certificate
 * POST /api/student/courses/:courseId/certificate
 */
studentRouter.post("/student/courses/:courseId/certificate", rbac(["student", "admin"]), async (c) => {
  const courseId = c.req.param("courseId");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    // 1. Verify active enrollment and server-recorded learning outcomes.
    const enrollment = await db
      .prepare("SELECT id FROM enrollments WHERE user_id = ? AND course_id = ? AND status IN ('active', 'completed') AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)")
      .bind(user.id, courseId)
      .first<{ id: string }>();

    if (!enrollment) {
      return c.json({ error: "คุณยังไม่ได้ลงทะเบียนเรียนคอร์สนี้" }, 404);
    }

    const progress = await learningProgress(db, user.id, courseId);
    if (progress.totalLessons === 0 || progress.completedLessons !== progress.totalLessons || progress.quizPercent < 80) {
      return c.json({ error: "ต้องเรียนจบทุกบทเรียนและได้คะแนนแบบทดสอบอย่างน้อย 80% ก่อนรับใบประกาศนียบัตร", progress }, 400);
    }

    // Return the active certificate; a revoked one can only be replaced by staff.
    const existing = await db
      .prepare("SELECT * FROM certificates WHERE user_id = ? AND course_id = ? ORDER BY revoked_at IS NULL DESC, issued_at DESC LIMIT 1")
      .bind(user.id, courseId)
      .first<{ id: string; certificate_code: string; issued_at: string; revoked_at: string | null }>();

    if (existing && !existing.revoked_at) {
      return c.json({
        message: "ออกใบประกาศนียบัตรแล้ว",
        certificate: existing
      });
    }
    if (existing) {
      return c.json({ error: "ใบประกาศนียบัตรของคอร์สนี้ถูกเพิกถอน กรุณาติดต่อเจ้าหน้าที่" }, 403);
    }

    const certificateCode = newCertificateCode(courseId);

    const certificateId = "cert_" + crypto.randomUUID().substring(0, 8);

    await db
      .prepare(`
        INSERT INTO certificates (id, enrollment_id, user_id, course_id, certificate_code)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(certificateId, enrollment.id, user.id, courseId, certificateCode)
      .run();

    // Trigger Mock Email Notification
    try {
      const course = await db
        .prepare("SELECT title FROM courses WHERE id = ?")
        .bind(courseId)
        .first<{ title: string }>();
      const courseTitle = course?.title || "คอร์ส Netprime";

      const { sendCertificateClaimedEmail, appUrl } = await import("../utils/email");
      await sendCertificateClaimedEmail(
        user.email,
        user.name,
        courseTitle,
        certificateCode,
        c.env.RESEND_API_KEY,
        appUrl(c.env, "")
      );
    } catch (emailErr) {
      console.error("Failed to send certificate notification email:", emailErr);
    }

    const result = {
      id: certificateId,
      enrollment_id: enrollment.id,
      user_id: user.id,
      course_id: courseId,
      certificate_code: certificateCode,
      issued_at: new Date().toISOString()
    };

    return c.json({
      message: "ออกใบประกาศนียบัตรเรียบร้อยแล้ว!",
      certificate: result
    }, 201);

  } catch (error) {
    console.error("Generate certificate failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะออกใบประกาศนียบัตร" }, 500);
  }
});

/**
 * Get issued certificate details for a course
 * GET /api/student/courses/:courseId/certificate
 */
studentRouter.get("/student/courses/:courseId/certificate", rbac(["student", "admin"]), async (c) => {
  const courseId = c.req.param("courseId");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    // Active certificate first; otherwise the latest revoked one so the learner sees its status.
    const cert = await db
      .prepare(`SELECT cert.id, cert.enrollment_id, cert.user_id, cert.course_id, cert.certificate_code, cert.issued_at,
          cert.revoked_at, cert.revoke_reason, co.title AS course_title, u.name AS student_name
        FROM certificates cert JOIN courses co ON co.id = cert.course_id JOIN users u ON u.id = cert.user_id
        WHERE cert.user_id = ? AND cert.course_id = ? ORDER BY cert.revoked_at IS NULL DESC, cert.issued_at DESC LIMIT 1`)
      .bind(user.id, courseId)
      .first();

    if (!cert) {
      return c.json({ error: "ไม่พบใบประกาศนียบัตรของคอร์สนี้" }, 404);
    }

    return c.json(cert);
  } catch (error) {
    console.error("Get certificate failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดใบประกาศนียบัตร" }, 500);
  }
});

/**
 * Secure Video Proxy Stream
 * GET /api/student/video
 */
studentRouter.get("/student/video", async (c) => {
  const token = c.req.query("token");
  const key = c.req.query("key");
  if (!token || !key) {
    return c.json({ error: "ไม่พบพารามิเตอร์ token หรือ key" }, 400);
  }

  try {
    // Same checks as rbac(): signature, expiry, sign-out list, active account and "sign out everywhere".
    if (!c.env.JWT_SECRET || c.env.JWT_SECRET.length < 32) return c.json({ error: "ระบบยืนยันตัวตนยังไม่ได้ตั้งค่า" }, 503);
    const userId = await verifiedTokenUserId(c.env, token);
    if (!userId) {
      return c.json({ error: "ยังไม่ได้เข้าสู่ระบบ: โทเค็นเล่นวิดีโอไม่ถูกต้อง หมดอายุ หรือเซสชันถูกยกเลิก" }, 401);
    }
    const access = await c.env.DB.prepare(`SELECT l.id FROM lessons l
      JOIN courses co ON co.id = l.course_id
      JOIN users u ON u.id = ?
      LEFT JOIN enrollments e ON e.course_id = l.course_id AND e.user_id = u.id
      WHERE l.video_stream_uid = ? AND (
        EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'admin') OR
        (co.instructor_id = u.id AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'instructor')) OR
        ((u.staff_role IS NULL OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'student'))
          AND e.status IN ('active', 'completed') AND (e.expires_at IS NULL OR e.expires_at > CURRENT_TIMESTAMP)))
      LIMIT 1`).bind(userId, key).first();
    if (!access) return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: สิทธิ์ดูวิดีโอไม่ได้เปิดใช้งาน" }, 403);

    const head = await c.env.ASSETS.head(key);
    const size = head?.size;

    if (!size) {
      return c.json({ error: "ไม่พบไฟล์วิดีโอในที่เก็บข้อมูล" }, 404);
    }

    const rangeHeader = c.req.header("Range");
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : size - 1;
        if (start >= size || end < start || end >= size) {
          c.header("Content-Range", `bytes */${size}`);
          return c.json({ error: "ช่วงไบต์ที่ร้องขอไม่ถูกต้อง" }, 416);
        }
        const length = end - start + 1;

        const object = await c.env.ASSETS.get(key, {
          range: { offset: start, length }
        });

        if (!object) {
          return c.json({ error: "โหลดช่วงวิดีโอจาก R2 ไม่สำเร็จ" }, 404);
        }

        c.status(206);
        c.header("Content-Type", object.httpMetadata?.contentType || "video/mp4");
        c.header("Content-Range", `bytes ${start}-${end}/${size}`);
        c.header("Accept-Ranges", "bytes");
        c.header("Content-Length", String(length));
        return c.body(object.body);
      }
    }

    // No range header, return full file
    const object = await c.env.ASSETS.get(key);
    if (!object) {
      return c.json({ error: "โหลดวิดีโอจาก R2 ไม่สำเร็จ" }, 500);
    }
    c.header("Content-Type", object.httpMetadata?.contentType || "video/mp4");
    c.header("Accept-Ranges", "bytes");
    c.header("Content-Length", String(size));
    return c.body(object.body);
  } catch (err: any) {
    console.error("Video proxy streaming failed:", err);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะสตรีมวิดีโอ" }, 500);
  }
});

/**
 * List QA Thread messages for a Lesson
 * GET /api/lessons/:lessonId/qa
 */
studentRouter.get("/lessons/:lessonId/qa", rbac(["student", "instructor", "admin"]), async (c) => {
  const lessonId = c.req.param("lessonId");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    if (!await canAccessLesson(db, user, lessonId)) return c.json({ error: "สิทธิ์เข้าถึงบทเรียนไม่ได้เปิดใช้งาน" }, 403);

    const query = `
      SELECT q.id, q.lesson_id, q.user_id, q.content, q.created_at, q.parent_id,
             u.name as user_name, u.role as user_role
      FROM lesson_qa q
      INNER JOIN users u ON q.user_id = u.id
      WHERE q.lesson_id = ?
      ORDER BY q.created_at ASC
    `;
    const res = await db.prepare(query).bind(lessonId).all<any>();
    const items = res.results;

    const questions = items.filter(i => !i.parent_id);
    const replies = items.filter(i => i.parent_id);

    const threaded = questions.map(q => ({
      ...q,
      replies: replies.filter(r => r.parent_id === q.id)
    }));

    return c.json(threaded);
  } catch (err: any) {
    console.error("Get QA failed:", err);
    return c.json({ error: "โหลดถามตอบไม่สำเร็จ" }, 500);
  }
});

/**
 * Post Question or Reply inside a Lesson Q&A Forum
 * POST /api/lessons/:lessonId/qa
 */
studentRouter.post("/lessons/:lessonId/qa", rbac(["student", "instructor", "admin"]), async (c) => {
  const lessonId = c.req.param("lessonId");
  const user = c.get("user");
  const db = c.env.DB;
  const { content, parent_id } = await c.req.json<{ content: string; parent_id?: string | null }>();

  if (!content || !content.trim()) {
    return c.json({ error: "ต้องระบุเนื้อหา" }, 400);
  }

  try {
    if (!await canAccessLesson(db, user, lessonId)) return c.json({ error: "สิทธิ์เข้าถึงบทเรียนไม่ได้เปิดใช้งาน" }, 403);

    if (parent_id) {
      const parent = await db.prepare("SELECT id FROM lesson_qa WHERE id = ? AND lesson_id = ?").bind(parent_id, lessonId).first();
      if (!parent) {
        return c.json({ error: "ไม่พบคำถามหลัก" }, 404);
      }
    }

    const qaId = "qa_" + crypto.randomUUID().substring(0, 8);
    await db
      .prepare("INSERT INTO lesson_qa (id, lesson_id, user_id, content, parent_id) VALUES (?, ?, ?, ?, ?)")
      .bind(qaId, lessonId, user.id, content.trim(), parent_id || null)
      .run();

    return c.json({
      id: qaId,
      lesson_id: lessonId,
      user_id: user.id,
      content: content.trim(),
      parent_id: parent_id || null,
      created_at: new Date().toISOString(),
      user_name: user.name,
      user_role: user.role
    }, 201);
  } catch (err: any) {
    console.error("Post QA failed:", err);
    return c.json({ error: "ส่งข้อความไม่สำเร็จ" }, 500);
  }
});

/**
 * Delete Q&A Thread message
 * DELETE /api/lessons/:lessonId/qa/:qaId
 */
studentRouter.delete("/lessons/:lessonId/qa/:qaId", rbac(["student", "instructor", "admin"]), async (c) => {
  const lessonId = c.req.param("lessonId");
  const qaId = c.req.param("qaId");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const post = await db.prepare(`SELECT q.user_id, co.instructor_id FROM lesson_qa q
      JOIN lessons l ON l.id = q.lesson_id JOIN courses co ON co.id = l.course_id
      WHERE q.id = ? AND q.lesson_id = ?`).bind(qaId, lessonId).first<{ user_id: string; instructor_id: string | null }>();
    if (!post) {
      return c.json({ error: "ไม่พบโพสต์" }, 404);
    }

    // Only the author, an admin, or the instructor of this lesson's course may delete a post
    // (judged by all roles held, not the role this route happens to act as).
    const moderates = user.roles.includes("admin") || (user.roles.includes("instructor") && post.instructor_id === user.id);
    if (!await canAccessLesson(db, user, lessonId) || (post.user_id !== user.id && !moderates)) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่มีสิทธิ์ลบโพสต์นี้" }, 403);
    }

    await db.prepare("DELETE FROM lesson_qa WHERE id = ?").bind(qaId).run();
    return c.json({ message: "ลบโพสต์เรียบร้อยแล้ว" });
  } catch (err: any) {
    console.error("Delete QA failed:", err);
    return c.json({ error: "ลบโพสต์ไม่สำเร็จ" }, 500);
  }
});

/**
 * Get student B2B corporate details
 * GET /api/student/corporate
 */
studentRouter.get("/student/corporate", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const partnerId = user.partner_id;

  if (!partnerId) {
    return c.json({ associated: false, partner: null });
  }

  try {
    const partner = await db
      .prepare("SELECT id, company_name, tax_id, total_seats, allocated_seats FROM partners WHERE id = ?")
      .bind(partnerId)
      .first<{ id: string; company_name: string; tax_id: string | null; total_seats: number; allocated_seats: number }>();

    if (!partner) {
      return c.json({ associated: false, partner: null });
    }

    // Get number of student courses enrolled
    const countRes = await db
      .prepare("SELECT COUNT(id) as enrolled_count FROM enrollments WHERE user_id = ?")
      .bind(user.id)
      .first<{ enrolled_count: number }>();

    // Find HR contact if any
    const hrContact = await db
      .prepare("SELECT name, email FROM users WHERE partner_id = ? AND role = 'partner' LIMIT 1")
      .bind(partnerId)
      .first<{ name: string; email: string }>();

    return c.json({
      associated: true,
      partner: {
        id: partner.id,
        companyName: partner.company_name,
        taxId: partner.tax_id,
        totalSeats: partner.total_seats,
        allocatedSeats: partner.allocated_seats
      },
      enrolledCount: countRes?.enrolled_count || 0,
      hrContact: hrContact ? { name: hrContact.name, email: hrContact.email } : null
    });
  } catch (error: any) {
    console.error("Failed to fetch student corporate info:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดข้อมูลองค์กรที่สังกัด" }, 500);
  }
});

/**
 * Get student learning metrics
 * GET /api/student/stats
 */
studentRouter.get("/student/stats", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  try {
    // 1. Count active enrollments
    const enrollmentsCount = await db
      .prepare("SELECT COUNT(id) as count FROM enrollments WHERE user_id = ? AND status = 'active'")
      .bind(user.id)
      .first<{ count: number }>();

    // 2. Count completed courses (where progress is 95% or higher)
    const completedCount = await db
      .prepare("SELECT COUNT(id) as count FROM enrollments WHERE user_id = ? AND progress_percent >= 95")
      .bind(user.id)
      .first<{ count: number }>();

    // 3. Count certificates claimed
    const certificatesCount = await db
      .prepare("SELECT COUNT(id) as count FROM certificates WHERE user_id = ? AND revoked_at IS NULL")
      .bind(user.id)
      .first<{ count: number }>();

    // 4. Total spent: confirmed bank-transfer orders plus legacy provider payments
    const paymentsSum = await db
      .prepare(`SELECT COALESCE((SELECT SUM(COALESCE(amount_received, amount)) FROM course_orders WHERE user_id = ? AND status = 'paid'), 0)
        + COALESCE((SELECT SUM(amount) FROM payments WHERE user_id = ? AND status = 'completed'), 0) AS total`)
      .bind(user.id, user.id)
      .first<{ total: number | null }>();

    // 5. Get recent quiz average score
    const quizAvg = await db
      .prepare("SELECT AVG(CAST(correct AS REAL)) as avg_score FROM quiz_answers WHERE user_id = ?")
      .bind(user.id)
      .first<{ avg_score: number | null }>();

    return c.json({
      activeCoursesCount: enrollmentsCount?.count || 0,
      completedCoursesCount: completedCount?.count || 0,
      certificatesCount: certificatesCount?.count || 0,
      totalSpent: paymentsSum?.total || 0,
      quizAveragePercent: quizAvg?.avg_score ? Math.round(quizAvg.avg_score * 100) : null
    });
  } catch (error: any) {
    console.error("Failed to fetch student stats:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดสถิติการเรียน" }, 500);
  }
});
