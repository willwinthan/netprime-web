import { Hono, Context } from "hono";
import { Env, rbac, UserPayload } from "../middleware/rbac";
import jwt from "@tsndr/cloudflare-worker-jwt";
import { revocationKey } from "../utils/session";
import { currentPermissions, permit } from "../utils/permissions";
import { generateStreamSignedUrl } from "../utils/stream";
import { createNotification } from "./notifications";
import { appUrl, escapeHtml, sendEmail } from "../utils/email";
import { clientIp, rateLimited, tooManyRequests } from "../utils/ratelimit";

export const coursesRouter = new Hono<Env>();

export type CourseStatus = "draft" | "review" | "published" | "archived";
export const COURSE_STATUSES: CourseStatus[] = ["draft", "review", "published", "archived"];

/** Admins and holders of courses.approve review, publish and preview every course. */
export async function canApproveCourses(c: Context<Env>): Promise<boolean> {
  return c.get("user").roles.includes("admin") || (await currentPermissions(c)).has("courses.approve");
}

/**
 * Who may see an unpublished course: its instructor, approvers, and learners who were already
 * enrolled before it was archived. Everyone else only sees published courses.
 */
async function canSeeCourse(c: Context<Env>, course: { id: string; status: string; instructor_id: string }, enrolled: boolean): Promise<boolean> {
  if (course.status === "published" || enrolled) return true;
  const user = c.get("user");
  if (course.instructor_id === user.id && user.roles.includes("instructor")) return true;
  return canApproveCourses(c);
}

/**
 * Token check for routes that do not go through rbac() (optional sign-in, video links): signature,
 * expiry and the sign-out list, plus the same account checks as rbac() (active status and
 * "sign out everywhere"). Returns the user id, or null when the token must be ignored.
 */
export async function verifiedTokenUserId(env: Env["Bindings"], token: string): Promise<string | null> {
  if (!token || !env.JWT_SECRET || env.JWT_SECRET.length < 32) return null;
  if (!(await jwt.verify(token, env.JWT_SECRET))) return null;
  const payload = jwt.decode(token).payload as UserPayload | undefined;
  if (!payload || typeof payload.id !== "string" || !Number.isFinite(payload.exp) || payload.exp! <= Date.now() / 1000) return null;
  if (await env.SESSIONS.get(await revocationKey(token))) return null;
  const account = await env.DB.prepare("SELECT status, sessions_revoked_at FROM users WHERE id = ?")
    .bind(payload.id).first<{ status: string; sessions_revoked_at: string | null }>();
  if (!account || account.status !== "active") return null;
  if (account.sessions_revoked_at) {
    const revokedAt = Date.parse(account.sessions_revoked_at);
    if (!Number.isFinite(payload.iat_ms) || payload.iat_ms! <= revokedAt) return null;
  }
  return payload.id;
}

/**
 * List Courses
 * GET /api/courses
 */
coursesRouter.get("/courses", async (c) => {
  const authHeader = c.req.header("Authorization");
  const db = c.env.DB;
  let userId: string | null = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      userId = await verifiedTokenUserId(c.env, authHeader.substring(7).trim());
    } catch (e) {
      console.error("JWT verify failed during public courses list:", e);
    }
  }

  try {
    const query = userId
      ? db.prepare(`
          SELECT c.id, c.title, c.description, c.price, c.cover_image_url, c.access_duration_days,
                 e.progress_percent, e.completed_at, e.expires_at,
                 (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count
          FROM courses c
          LEFT JOIN enrollments e ON c.id = e.course_id AND e.user_id = ?
          WHERE c.status = 'published' OR e.id IS NOT NULL
        `).bind(userId)
      : db.prepare(`
          SELECT c.id, c.title, c.description, c.price, c.cover_image_url, c.access_duration_days,
                 NULL as progress_percent, NULL as completed_at, NULL as expires_at,
                 (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count
          FROM courses c
          WHERE c.status = 'published'
        `);

    const courses = await query.all();
    return c.json(courses.results);
  } catch (error) {
    console.error("List courses error:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดรายการคอร์ส" }, 500);
  }
});

/**
 * Get Course Details (lessons list & enrollment metadata)
 * GET /api/courses/:id
 */
coursesRouter.get("/courses/:id", rbac(), async (c) => {
  const courseId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const course = await db
      .prepare("SELECT * FROM courses WHERE id = ?")
      .bind(courseId)
      .first<{ id: string; status: string; instructor_id: string }>();

    const enrollment = await db
      .prepare("SELECT progress_percent, completed_at, status, expires_at FROM enrollments WHERE user_id = ? AND course_id = ?")
      .bind(user.id, courseId)
      .first();

    // Unpublished courses look like missing ones to people who may not see them
    if (!course || !(await canSeeCourse(c, course, !!enrollment))) {
      return c.json({ error: "ไม่พบคอร์สนี้" }, 404);
    }

    const lessons = await db
      .prepare("SELECT id, title, video_stream_uid, video_provider, sort_order, handout_r2_key FROM lessons WHERE course_id = ? ORDER BY sort_order ASC")
      .bind(courseId)
      .all();

    let sponsored = true;
    if (user.role === "student" && user.partner_id) {
      const isMapped = await db
        .prepare("SELECT course_id FROM partner_courses WHERE partner_id = ? AND course_id = ?")
        .bind(user.partner_id, courseId)
        .first();
      sponsored = !!isMapped;
    }

    return c.json({
      course,
      lessons: lessons.results,
      enrollment: enrollment || null,
      sponsored
    });
  } catch (error) {
    console.error("Fetch course details error:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดรายละเอียดคอร์ส" }, 500);
  }
});

/**
 * Enroll in Course
 * POST /api/courses/:id/enroll
 */
coursesRouter.post("/courses/:id/enroll", rbac(["student", "admin"]), async (c) => {
  const courseId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const course = await db.prepare("SELECT id, price, status FROM courses WHERE id = ?").bind(courseId).first<{ id: string; price: number; status: string }>();
    if (!course) {
      return c.json({ error: "ไม่พบคอร์สนี้" }, 404);
    }
    if (course.status !== "published") {
      return c.json({ error: "คอร์สนี้ยังไม่เปิดให้ลงทะเบียนเรียน" }, 403);
    }

    // Enforce B2B organization course constraints
    let sponsored = false;
    if (user.role === "student" && user.partner_id) {
      const isMapped = await db
        .prepare("SELECT course_id FROM partner_courses WHERE partner_id = ? AND course_id = ?")
        .bind(user.partner_id, courseId)
        .first();
      if (!isMapped) {
        return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: องค์กรของคุณยังไม่ได้สนับสนุนหรือซื้อคอร์สนี้" }, 403);
      }
      sponsored = true;
    }

    if (course.price > 0 && !sponsored) {
      const existing = await db.prepare("SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?").bind(user.id, courseId).first();
      if (existing) return c.json({ error: "คุณลงทะเบียนเรียนคอร์สนี้แล้ว" }, 400);
      return c.json({ error: "ต้องชำระเงินก่อนลงทะเบียนเรียนคอร์สนี้" }, 403);
    }

    // The unique user/course index turns a double submit into "already enrolled" instead of a second row.
    const enrollmentId = "enr_" + crypto.randomUUID();
    const inserted = await db
      .prepare(`INSERT INTO enrollments (id, user_id, course_id, progress_percent, status, partner_id) VALUES (?, ?, ?, 0, 'active', ?)
        ON CONFLICT(user_id, course_id) DO NOTHING`)
      .bind(enrollmentId, user.id, courseId, sponsored ? user.partner_id : null)
      .run();
    if (!inserted.meta.changes) {
      return c.json({ error: "คุณลงทะเบียนเรียนคอร์สนี้แล้ว" }, 400);
    }

    return c.json({
      message: "ลงทะเบียนเรียนสำเร็จ",
      enrollment: {
        id: enrollmentId,
        user_id: user.id,
        course_id: courseId,
        progress_percent: 0,
        status: "active"
      }
    }, 201);
  } catch (error) {
    console.error("Course enrollment failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะลงทะเบียนเรียน" }, 500);
  }
});

/**
 * Cloudflare Stream Token Generator (Anti-Piracy Token)
 * GET /api/lessons/:id/stream-token
 */
coursesRouter.get("/lessons/:id/stream-token", rbac(), async (c) => {
  return handleLessonVideo(c);
});

coursesRouter.get("/lessons/:id/video", rbac(), async (c) => {
  return handleLessonVideo(c);
});

async function handleLessonVideo(c: Context<Env>) {
  const lessonId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    // 1. Fetch the lesson and confirm access rights (verify enrollment)
    const lesson = await db
      .prepare(
        `SELECT l.video_stream_uid, l.video_provider, l.title, l.course_id, e.id as enrollment_id, e.expires_at
         FROM lessons l
         INNER JOIN enrollments e ON l.course_id = e.course_id
         WHERE l.id = ? AND e.user_id = ? AND e.status IN ('active', 'completed')`
      )
      .bind(lessonId, user.id)
      .first<{ video_stream_uid: string; video_provider: string; title: string; course_id: string; enrollment_id: string; expires_at: string | null }>();

    // Verify if access duration has expired
    if (lesson && lesson.expires_at) {
      const expiry = new Date(lesson.expires_at).getTime();
      if (expiry < Date.now()) {
        return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ระยะเวลาเข้าถึงคอร์สนี้ของคุณหมดอายุแล้ว" }, 403);
      }
    }

    // Admins and assigned Instructors bypass course enrollment verification check
    let hasAccess = !!lesson;
    let videoUid = lesson?.video_stream_uid || "";
    let videoProvider = lesson?.video_provider || "cloudflare";

    if (!hasAccess) {
      if (await canApproveCourses(c)) {
        const adminLesson = await db.prepare("SELECT video_stream_uid, video_provider FROM lessons WHERE id = ?").bind(lessonId).first<{ video_stream_uid: string; video_provider: string }>();
        if (adminLesson) {
          hasAccess = true;
          videoUid = adminLesson.video_stream_uid;
          videoProvider = adminLesson.video_provider || "cloudflare";
        }
      } else if (user.roles.includes("instructor")) {
        // Verify instructor teaches the course
        const instLesson = await db
          .prepare(
            `SELECT l.video_stream_uid, l.video_provider FROM lessons l
             INNER JOIN courses c ON l.course_id = c.id
             WHERE l.id = ? AND c.instructor_id = ?`
          )
          .bind(lessonId, user.id)
          .first<{ video_stream_uid: string; video_provider: string }>();

        if (instLesson) {
          hasAccess = true;
          videoUid = instLesson.video_stream_uid;
          videoProvider = instLesson.video_provider || "cloudflare";
        }
      }
    }

    if (!hasAccess) {
      const exists = await db.prepare("SELECT id FROM lessons WHERE id = ?").bind(lessonId).first();
      if (!exists) {
        return c.json({ error: "ไม่พบบทเรียนนี้ในเนื้อหาหลักสูตร" }, 404);
      }
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องลงทะเบียนเรียนคอร์สนี้ก่อนจึงจะดูบทเรียนได้" }, 403);
    }

    if (!videoUid) {
      return c.json({ error: "บทเรียนนี้ยังไม่ได้ตั้งค่าวิดีโอ" }, 404);
    }

    // YouTube/Vimeo embeds and R2 videos (keys contain "/", served by /student/video) need no Stream token
    if (videoProvider !== "cloudflare" || videoUid.includes("/")) {
      return c.json({ lessonId, videoStreamUid: videoUid, videoProvider, token: "", signedUrl: "", isMock: false });
    }

    // 2. Sign a playback token (RS256 with the Stream signing key; local mock keys return a dev token)
    if (!c.env.STREAM_SIGNING_KEY || !c.env.STREAM_KEY_ID) {
      return c.json({ error: "ระบบวิดีโอยังไม่ได้ตั้งค่าคีย์สำหรับเล่นวิดีโอ กรุณาติดต่อผู้ดูแลระบบ" }, 503);
    }
    const { token, signedUrl, isMock } = await generateStreamSignedUrl(videoUid, c.env.STREAM_SIGNING_KEY, c.env.STREAM_KEY_ID);

    return c.json({
      lessonId,
      videoStreamUid: videoUid,
      videoProvider,
      token,
      signedUrl,
      isMock
    });

  } catch (error) {
    console.error("CF Stream signed URL token signature failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะสร้างโทเค็นเล่นวิดีโอ" }, 500);
  }
}

// ---------- Course review workflow (draft → review → published / archived) ----------

/** In-app notification to every admin and holder of courses.approve, except `exceptUserId`. */
export async function notifyCourseApprovers(db: D1Database, title: string, content: string, exceptUserId?: string): Promise<void> {
  const rows = await db.prepare(`SELECT DISTINCT r.user_id FROM user_roles r
    WHERE r.role = 'admin' OR r.role IN (SELECT role FROM role_permissions WHERE permission = 'courses.approve')`)
    .all<{ user_id: string }>();
  for (const row of rows.results) {
    if (row.user_id !== exceptUserId) await createNotification(db, row.user_id, title, content);
  }
}

/** Tells the course owner about a review decision (in-app and email; email failures are only logged). */
async function notifyCourseOwner(c: Context<Env>, courseId: string, title: string, content: string): Promise<void> {
  const owner = await c.env.DB.prepare(`SELECT u.id, u.email, u.name, co.title AS course_title FROM courses co
    INNER JOIN users u ON u.id = co.instructor_id WHERE co.id = ?`).bind(courseId)
    .first<{ id: string; email: string; name: string; course_title: string }>();
  if (!owner) return;
  await createNotification(c.env.DB, owner.id, title, content);
  try {
    await sendEmail(owner.email, `${title}: ${owner.course_title}`, `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto;">
        <p>เรียน ${escapeHtml(owner.name)}</p>
        <p>${escapeHtml(content)}</p>
        <p><a href="${escapeHtml(appUrl(c.env, "/instructor"))}">เปิดหน้าผู้สอน</a></p>
      </div>`, c.env.RESEND_API_KEY);
  } catch (error) {
    console.error("Course review email failed:", error);
  }
}

coursesRouter.use("/admin/courses", rbac());
coursesRouter.use("/admin/courses/*", rbac());
coursesRouter.use("/admin/courses", permit("courses.approve"));
coursesRouter.use("/admin/courses/*", permit("courses.approve"));

/**
 * All courses for reviewers, review queue first
 * GET /api/admin/courses?status=&instructor_id=&q=
 */
coursesRouter.get("/admin/courses", async (c) => {
  const status = c.req.query("status") || "";
  const instructorId = c.req.query("instructor_id") || "";
  const q = (c.req.query("q") || "").trim();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    if (!COURSE_STATUSES.includes(status as CourseStatus)) return c.json({ error: "สถานะคอร์สไม่ถูกต้อง" }, 400);
    where.push("co.status = ?"); binds.push(status);
  }
  if (instructorId) { where.push("co.instructor_id = ?"); binds.push(instructorId); }
  if (q) { where.push("(co.title LIKE ? OR co.description LIKE ?)"); binds.push(`%${q}%`, `%${q}%`); }

  try {
    const courses = await c.env.DB.prepare(`
      SELECT co.id, co.title, co.description, co.price, co.cover_image_url, co.status, co.created_at,
             co.submitted_at, co.published_at, co.review_note, co.instructor_id,
             u.name AS instructor_name, u.email AS instructor_email,
             (SELECT COUNT(*) FROM lessons l WHERE l.course_id = co.id) AS lesson_count,
             (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = co.id) AS enrollment_count
      FROM courses co
      LEFT JOIN users u ON u.id = co.instructor_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY CASE co.status WHEN 'review' THEN 0 WHEN 'draft' THEN 1 WHEN 'published' THEN 2 ELSE 3 END,
               COALESCE(co.submitted_at, co.created_at) DESC
    `).bind(...binds).all();
    const instructors = await c.env.DB.prepare(`SELECT DISTINCT u.id, u.name FROM courses co
      INNER JOIN users u ON u.id = co.instructor_id ORDER BY u.name`).all();
    const counts = await c.env.DB.prepare("SELECT status, COUNT(*) AS count FROM courses GROUP BY status").all<{ status: string; count: number }>();
    return c.json({
      courses: courses.results,
      instructors: instructors.results,
      counts: Object.fromEntries(counts.results.map(r => [r.status, r.count]))
    });
  } catch (error) {
    console.error("List courses for review failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดรายการคอร์ส" }, 500);
  }
});

/** Moves a course to `to` when its current status is one of `from`; 409 otherwise. */
async function transitionCourse(c: Context<Env>, to: CourseStatus, from: CourseStatus[], note: string | null): Promise<{ error: Response } | { courseId: string }> {
  const courseId = c.req.param("id");
  const course = await c.env.DB.prepare("SELECT id, status FROM courses WHERE id = ?").bind(courseId).first<{ id: string; status: string }>();
  if (!course) return { error: c.json({ error: "ไม่พบคอร์ส" }, 404) };
  const result = await c.env.DB.prepare(`UPDATE courses SET status = ?, review_note = ?,
      published_at = CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP ELSE published_at END
    WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`)
    .bind(to, note, to, courseId, ...from).run();
  if (!result.meta.changes) return { error: c.json({ error: "สถานะคอร์สเปลี่ยนไปแล้ว กรุณารีเฟรชหน้า" }, 409) };
  return { courseId: course.id };
}

/**
 * Approve and publish
 * POST /api/admin/courses/:id/approve
 */
coursesRouter.post("/admin/courses/:id/approve", async (c) => {
  try {
    const done = await transitionCourse(c, "published", ["draft", "review", "archived"], null);
    if ("error" in done) return done.error;
    await notifyCourseOwner(c, done.courseId, "คอร์สได้รับการอนุมัติ", "คอร์สของคุณผ่านการตรวจและเผยแพร่ในแคตตาล็อกแล้ว");
    return c.json({ message: "อนุมัติและเผยแพร่คอร์สแล้ว", status: "published" });
  } catch (error) {
    console.error("Approve course failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะอนุมัติคอร์ส" }, 500);
  }
});

/**
 * Send back to the instructor with a note
 * POST /api/admin/courses/:id/send-back { note }
 */
coursesRouter.post("/admin/courses/:id/send-back", async (c) => {
  const { note } = await c.req.json<{ note?: string }>().catch(() => ({ note: undefined }));
  const text = typeof note === "string" ? note.trim().slice(0, 2000) : "";
  if (!text) return c.json({ error: "กรุณาระบุสิ่งที่ผู้สอนต้องแก้ไข" }, 400);
  try {
    const done = await transitionCourse(c, "draft", ["review", "published", "archived"], text);
    if ("error" in done) return done.error;
    await notifyCourseOwner(c, done.courseId, "คอร์สถูกส่งกลับให้แก้ไข", `ผู้ตรวจแจ้งว่า: ${text}`);
    return c.json({ message: "ส่งคอร์สกลับให้ผู้สอนแก้ไขแล้ว", status: "draft" });
  } catch (error) {
    console.error("Send back course failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะส่งคอร์สกลับ" }, 500);
  }
});

/**
 * Archive (unpublish). Enrolled learners keep access; the course leaves the catalog.
 * POST /api/admin/courses/:id/archive
 */
coursesRouter.post("/admin/courses/:id/archive", async (c) => {
  try {
    const done = await transitionCourse(c, "archived", ["draft", "review", "published"], null);
    if ("error" in done) return done.error;
    await notifyCourseOwner(c, done.courseId, "คอร์สถูกเก็บเข้าคลัง", "คอร์สของคุณถูกนำออกจากแคตตาล็อก ผู้เรียนที่ลงทะเบียนแล้วยังเรียนต่อได้");
    return c.json({ message: "เก็บคอร์สเข้าคลังแล้ว", status: "archived" });
  } catch (error) {
    console.error("Archive course failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะเก็บคอร์สเข้าคลัง" }, 500);
  }
});

/**
 * Public Verification Route for Certificates
 * GET /api/certificates/verify/:code
 */
coursesRouter.get("/certificates/verify/:code", async (c) => {
  const code = c.req.param("code").toUpperCase().trim().slice(0, 80);
  const db = c.env.DB;
  // The answer includes the learner's name, so slow down code guessing per IP.
  if (await rateLimited(c.env.SESSIONS, "cert_verify", clientIp(c), 30)) return tooManyRequests(c);

  try {
    const cert = await db
      .prepare(`
        SELECT cert.certificate_code, cert.issued_at, cert.revoked_at, u.name as student_name, c.title as course_title
        FROM certificates cert
        INNER JOIN users u ON cert.user_id = u.id
        INNER JOIN courses c ON cert.course_id = c.id
        WHERE cert.certificate_code = ?
      `)
      .bind(code)
      .first<{ certificate_code: string; issued_at: string; revoked_at: string | null; student_name: string; course_title: string }>();

    if (!cert) {
      return c.json({ verified: false, error: "รหัสตรวจสอบใบประกาศนียบัตรไม่ถูกต้อง ไม่พบข้อมูลที่ตรงกัน" }, 404);
    }
    // Revoked certificates (see handlers/certificates.ts) are reported as such, without the internal reason.
    if (cert.revoked_at) {
      return c.json({
        verified: false, revoked: true, revokedAt: cert.revoked_at,
        certificateCode: cert.certificate_code, issuedAt: cert.issued_at, studentName: cert.student_name, courseTitle: cert.course_title,
        error: "ใบประกาศนียบัตรนี้ถูกเพิกถอนแล้ว ใช้อ้างอิงไม่ได้"
      });
    }

    return c.json({
      verified: true,
      certificateCode: cert.certificate_code,
      issuedAt: cert.issued_at,
      studentName: cert.student_name,
      courseTitle: cert.course_title,
      verifyingAuthority: "หน่วยออกใบรับรอง Netprime LMS"
    });
  } catch (error) {
    console.error("Certificate verification query failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะตรวจสอบใบประกาศนียบัตร" }, 500);
  }
});
