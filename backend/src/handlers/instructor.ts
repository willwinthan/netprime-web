import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { canApproveCourses, notifyCourseApprovers } from "./courses";
import { createStreamDirectUpload } from "../utils/stream";

export const instructorRouter = new Hono<Env>();

/** R2 prefix for files a user uploads; lesson files must point inside it (see checkLessonAssets). */
const uploadPrefix = (userId: string) => `uploads/${userId}/`;

/** KV record of who created a Stream direct upload, so only the uploader can attach that video. */
const streamOwnerKey = (uid: string) => `stream:${uid}`;
const STREAM_OWNER_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * A lesson may only reference files its instructor uploaded (or already used in their own lessons),
 * so nobody can attach another course's handout or video to their own course. Admins are exempt.
 * A new Stream UID must come from the instructor's own direct upload when Stream is configured;
 * without Stream (local/dev) any UID not used by another instructor's lesson is accepted.
 * Returns an error message or null.
 */
async function checkLessonAssets(c: Context<Env>, handoutKey: string | null | undefined, videoUid: string | null | undefined, provider: string): Promise<string | null> {
  const user = c.get("user");
  if (user.roles.includes("admin")) return null;
  const db = c.env.DB;
  const ownedBefore = (column: "handout_r2_key" | "video_stream_uid", value: string) => db.prepare(`SELECT 1 FROM lessons l
    INNER JOIN courses co ON co.id = l.course_id WHERE l.${column} = ? AND co.instructor_id = ? LIMIT 1`).bind(value, user.id).first();

  if (handoutKey && !handoutKey.startsWith(uploadPrefix(user.id)) && !(await ownedBefore("handout_r2_key", handoutKey)))
    return "ไฟล์เอกสารต้องอัปโหลดผ่านระบบด้วยบัญชีของคุณ";
  if (videoUid && provider === "cloudflare" && !videoUid.startsWith(uploadPrefix(user.id)) && !(await ownedBefore("video_stream_uid", videoUid))) {
    // R2 keys contain "/" and must be the user's own upload; a Stream UID must not belong to another instructor's lesson
    if (videoUid.includes("/")) return "ไฟล์วิดีโอต้องอัปโหลดผ่านระบบด้วยบัญชีของคุณ";
    const foreign = await db.prepare(`SELECT 1 FROM lessons l INNER JOIN courses co ON co.id = l.course_id
      WHERE l.video_stream_uid = ? AND co.instructor_id != ? LIMIT 1`).bind(videoUid, user.id).first();
    if (foreign) return "วิดีโอนี้เป็นของคอร์สอื่น ไม่สามารถนำมาใช้ได้";
    if (c.env.STREAM_ACCOUNT_ID && c.env.STREAM_API_TOKEN && (await c.env.SESSIONS.get(streamOwnerKey(videoUid))) !== user.id)
      return "วิดีโอต้องอัปโหลดผ่านระบบด้วยบัญชีของคุณ";
  }
  return null;
}

/**
 * Get Instructor Analytics & Curriculum Metrics
 * GET /api/instructor/analytics
 */
instructorRouter.get("/instructor/analytics", rbac(["instructor", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const isGlobal = user.roles.includes("admin");
    const targetId = user.id;

    // 1. Fetch instructor's courses list with student count and average progress metrics
    const coursesQuery = isGlobal 
      ? `SELECT c.id, c.title, c.description, c.created_at, c.status, c.submitted_at, c.published_at, c.review_note,
                COUNT(e.id) as student_count,
                AVG(e.progress_percent) as avg_progress
         FROM courses c
         LEFT JOIN enrollments e ON c.id = e.course_id
         GROUP BY c.id
         ORDER BY c.created_at DESC`
      : `SELECT c.id, c.title, c.description, c.created_at, c.status, c.submitted_at, c.published_at, c.review_note,
                COUNT(e.id) as student_count,
                AVG(e.progress_percent) as avg_progress
         FROM courses c
         LEFT JOIN enrollments e ON c.id = e.course_id
         WHERE c.instructor_id = ?
         GROUP BY c.id
         ORDER BY c.created_at DESC`;

    const coursesStmt = isGlobal ? db.prepare(coursesQuery) : db.prepare(coursesQuery).bind(targetId);
    const coursesResult = await coursesStmt.all<{ id: string; title: string; description: string; created_at: string; status: string; submitted_at: string | null; published_at: string | null; review_note: string | null; student_count: number; avg_progress: number | null }>();

    // 2. Fetch total unique students
    const studentsQuery = isGlobal
      ? `SELECT COUNT(DISTINCT e.user_id) as total_students FROM enrollments e`
      : `SELECT COUNT(DISTINCT e.user_id) as total_students 
         FROM enrollments e 
         INNER JOIN courses c ON e.course_id = c.id 
         WHERE c.instructor_id = ?`;

    const studentsStmt = isGlobal ? db.prepare(studentsQuery) : db.prepare(studentsQuery).bind(targetId);
    const studentsResult = await studentsStmt.first<{ total_students: number }>();

    // 3. Fetch average cohort progress rate
    const progressQuery = isGlobal
      ? `SELECT AVG(e.progress_percent) as avg_progress FROM enrollments e`
      : `SELECT AVG(e.progress_percent) as avg_progress 
         FROM enrollments e 
         INNER JOIN courses c ON e.course_id = c.id 
         WHERE c.instructor_id = ?`;

    const progressStmt = isGlobal ? db.prepare(progressQuery) : db.prepare(progressQuery).bind(targetId);
    const progressResult = await progressStmt.first<{ avg_progress: number | null }>();

    // 4. Fetch recent student telemetry stream
    const activityQuery = isGlobal
      ? `SELECT u.name, u.email, c.title as course_title, e.progress_percent, e.completed_at
         FROM enrollments e
         INNER JOIN users u ON e.user_id = u.id
         INNER JOIN courses c ON e.course_id = c.id
         ORDER BY e.enrolled_at DESC LIMIT 15`
      : `SELECT u.name, u.email, c.title as course_title, e.progress_percent, e.completed_at
         FROM enrollments e
         INNER JOIN users u ON e.user_id = u.id
         INNER JOIN courses c ON e.course_id = c.id
         WHERE c.instructor_id = ?
         ORDER BY e.enrolled_at DESC LIMIT 15`;

    const activityStmt = isGlobal ? db.prepare(activityQuery) : db.prepare(activityQuery).bind(targetId);
    const activityResult = await activityStmt.all<{ name: string; email: string; course_title: string; progress_percent: number; completed_at: string | null }>();

    // Add placeholder thumbnails dynamically for the premium UI cards
    const coursesClean = coursesResult.results.map((c, index) => {
      // Pick dynamic tech thumbnails based on title keywords or index
      const titleLower = c.title.toLowerCase();
      let thumb = "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=600&auto=format&fit=crop&q=60"; // Default generic network
      if (titleLower.includes("cisco")) {
        thumb = "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&auto=format&fit=crop&q=60";
      } else if (titleLower.includes("aws") || titleLower.includes("cloud")) {
        thumb = "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=600&auto=format&fit=crop&q=60";
      } else if (titleLower.includes("juniper") || titleLower.includes("arista") || titleLower.includes("aruba")) {
        thumb = "https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=600&auto=format&fit=crop&q=60";
      } else if (titleLower.includes("security") || titleLower.includes("cyber")) {
        thumb = "https://images.unsplash.com/photo-1563986768609-322da13575f3?w=600&auto=format&fit=crop&q=60";
      } else if (titleLower.includes("cloudflare") || titleLower.includes("serverless")) {
        thumb = "https://images.unsplash.com/photo-1618401471353-b98aedd07871?w=600&auto=format&fit=crop&q=60";
      }
      
      return {
        ...c,
        thumbnail_url: thumb,
        avg_progress: c.avg_progress !== null ? Math.round(c.avg_progress) : null
      };
    });

    return c.json({
      totalCourses: coursesClean.length,
      totalStudents: studentsResult?.total_students || 0,
      averageCohortProgress: progressResult?.avg_progress !== null ? Math.round(progressResult?.avg_progress || 0) : 0,
      courses: coursesClean,
      recentActivity: activityResult.results
    });

  } catch (error) {
    console.error("Instructor analytics failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะรวบรวมสถิติหลักสูตร" }, 500);
  }
});

/**
 * Create Course Listing
 * POST /api/instructor/courses
 */
instructorRouter.post("/instructor/courses", rbac(["instructor", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const { title, description, price, cover_image_url, access_duration_days, publish } = await c.req.json<{
    title: string;
    description: string;
    price?: number;
    cover_image_url?: string | null;
    access_duration_days?: number | null;
    /** Approvers may publish their own course at once; everyone else starts with a draft. */
    publish?: boolean;
  }>();

  if (!title || !description) {
    return c.json({ error: "ต้องระบุชื่อและคำอธิบาย" }, 400);
  }
  const status = publish === true && await canApproveCourses(c) ? "published" : "draft";

  const courseId = "course_" + crypto.randomUUID().substring(0, 8);
  const coursePrice = price !== undefined ? Number(price) : 0.0;
  const coverUrl = cover_image_url || null;
  const duration = access_duration_days !== undefined ? (access_duration_days === null ? null : Number(access_duration_days)) : null;

  try {
    // Default to registering under the current logged-in user as instructor
    await db
      .prepare(`INSERT INTO courses (id, title, description, instructor_id, price, cover_image_url, access_duration_days, status, published_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP END)`)
      .bind(courseId, title, description, user.id, coursePrice, coverUrl, duration, status, status)
      .run();

    return c.json({
      message: "สร้างคอร์สเรียบร้อยแล้ว",
      course: {
        id: courseId,
        title,
        description,
        instructor_id: user.id,
        price: coursePrice,
        cover_image_url: coverUrl,
        access_duration_days: duration,
        status
      }
    }, 201);
  } catch (error) {
    console.error("Create course failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะสร้างคอร์ส" }, 500);
  }
});

/**
 * Add Lesson Module
 * POST /api/instructor/lessons
 */
instructorRouter.post("/instructor/lessons", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const db = c.env.DB;
  const user = c.get("user");
  const { course_id, title, video_stream_uid, video_provider, handout_r2_key, sort_order } = await c.req.json<{
    course_id: string;
    title: string;
    video_stream_uid: string;
    video_provider?: string;
    handout_r2_key?: string;
    sort_order: number;
  }>();

  if (!course_id || !title || !video_stream_uid || sort_order === undefined) {
    return c.json({ error: "ต้องระบุ course_id, title, video_stream_uid และ sort_order" }, 400);
  }

  const order = Number(sort_order);
  const lessonId = "lesson_" + crypto.randomUUID().substring(0, 8);
  const provider = video_provider || "cloudflare";

  try {
    // Verify course exists
    const course = await db.prepare("SELECT id, instructor_id FROM courses WHERE id = ?")
      .bind(course_id).first<{ id: string; instructor_id: string }>();
    if (!course) {
      return c.json({ error: "ไม่พบคอร์สที่ระบุ" }, 404);
    }
    if (!user.roles.includes("admin") && course.instructor_id !== user.id)
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นเจ้าของคอร์สนี้" }, 403);

    const handoutKey = handout_r2_key || null;
    const assetError = await checkLessonAssets(c, handoutKey, video_stream_uid, provider);
    if (assetError) return c.json({ error: assetError }, 403);

    await db
      .prepare("INSERT INTO lessons (id, course_id, title, video_stream_uid, video_provider, handout_r2_key, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(lessonId, course_id, title, video_stream_uid, provider, handoutKey, order)
      .run();

    return c.json({
      message: "เพิ่มบทเรียนเรียบร้อยแล้ว",
      lesson: {
        id: lessonId,
        course_id,
        title,
        video_stream_uid,
        video_provider: provider,
        handout_r2_key: handoutKey,
        sort_order: order
      }
    }, 201);
  } catch (error) {
    console.error("Add lesson module failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะเพิ่มบทเรียน" }, 500);
  }
});

/**
 * Update Course Listing
 * PATCH /api/instructor/courses/:id
 */
instructorRouter.patch("/instructor/courses/:id", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const courseId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;
  const { title, description, price, cover_image_url, access_duration_days } = await c.req.json<{
    title?: string;
    description?: string;
    price?: number;
    cover_image_url?: string | null;
    access_duration_days?: number | null;
  }>();

  try {
    const course = await db
      .prepare("SELECT instructor_id, title, description, price, cover_image_url, access_duration_days FROM courses WHERE id = ?")
      .bind(courseId)
      .first<{ instructor_id: string; title: string; description: string; price: number; cover_image_url: string | null; access_duration_days: number | null }>();

    if (!course) {
      return c.json({ error: "ไม่พบคอร์ส" }, 404);
    }

    if (!user.roles.includes("admin") && course.instructor_id !== user.id) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นเจ้าของคอร์สนี้" }, 403);
    }

    const newTitle = title !== undefined ? title : course.title;
    const newDescription = description !== undefined ? description : course.description;
    const newPrice = price !== undefined ? Number(price) : course.price;
    const newCover = cover_image_url !== undefined ? cover_image_url : course.cover_image_url;
    const newDuration = access_duration_days !== undefined ? (access_duration_days === null ? null : Number(access_duration_days)) : course.access_duration_days;

    await db
      .prepare("UPDATE courses SET title = ?, description = ?, price = ?, cover_image_url = ?, access_duration_days = ? WHERE id = ?")
      .bind(newTitle, newDescription, newPrice, newCover, newDuration, courseId)
      .run();

    return c.json({
      message: "อัปเดตคอร์สเรียบร้อยแล้ว",
      course: {
        id: courseId,
        title: newTitle,
        description: newDescription,
        price: newPrice,
        cover_image_url: newCover,
        access_duration_days: newDuration
      }
    });
  } catch (error) {
    console.error("Update course failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะอัปเดตคอร์ส" }, 500);
  }
});

/**
 * Submit a draft for review ("ส่งตรวจ")
 * POST /api/instructor/courses/:id/submit
 */
instructorRouter.post("/instructor/courses/:id/submit", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const courseId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const course = await db.prepare("SELECT instructor_id, title, status FROM courses WHERE id = ?")
      .bind(courseId).first<{ instructor_id: string; title: string; status: string }>();
    if (!course) return c.json({ error: "ไม่พบคอร์ส" }, 404);
    if (course.instructor_id !== user.id && !user.roles.includes("admin"))
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นเจ้าของคอร์สนี้" }, 403);
    if (course.status !== "draft")
      return c.json({ error: "ส่งตรวจได้เฉพาะคอร์สที่เป็นฉบับร่าง" }, 409);
    const lessons = await db.prepare("SELECT COUNT(*) AS count FROM lessons WHERE course_id = ?").bind(courseId).first<{ count: number }>();
    if (!lessons?.count) return c.json({ error: "เพิ่มบทเรียนอย่างน้อย 1 บทก่อนส่งตรวจ" }, 400);

    const result = await db.prepare(`UPDATE courses SET status = 'review', submitted_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'draft'`).bind(courseId).run();
    if (!result.meta.changes) return c.json({ error: "สถานะคอร์สเปลี่ยนไปแล้ว กรุณารีเฟรชหน้า" }, 409);

    await notifyCourseApprovers(db, "มีคอร์สรอตรวจ", `${user.name} ส่งคอร์ส "${course.title}" ให้ตรวจก่อนเผยแพร่`, user.id);
    return c.json({ message: "ส่งคอร์สให้ผู้ตรวจแล้ว", status: "review" });
  } catch (error) {
    console.error("Submit course for review failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะส่งคอร์สตรวจ" }, 500);
  }
});

/**
 * Delete Course Listing
 * DELETE /api/instructor/courses/:id
 */
instructorRouter.delete("/instructor/courses/:id", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const courseId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const course = await db
      .prepare("SELECT instructor_id FROM courses WHERE id = ?")
      .bind(courseId)
      .first<{ instructor_id: string }>();

    if (!course) {
      return c.json({ error: "ไม่พบคอร์ส" }, 404);
    }

    if (!user.roles.includes("admin") && course.instructor_id !== user.id) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นเจ้าของคอร์สนี้" }, 403);
    }

    await db.prepare("DELETE FROM courses WHERE id = ?").bind(courseId).run();

    return c.json({ message: "ลบคอร์สและเนื้อหาหลักสูตรเรียบร้อยแล้ว" });
  } catch (error) {
    console.error("Delete course failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะลบคอร์ส" }, 500);
  }
});

/**
 * Update Lesson Module
 * PATCH /api/instructor/lessons/:id
 */
instructorRouter.patch("/instructor/lessons/:id", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const lessonId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;
  const { title, video_stream_uid, video_provider, handout_r2_key, sort_order } = await c.req.json<{
    title?: string;
    video_stream_uid?: string;
    video_provider?: string;
    handout_r2_key?: string;
    sort_order?: number;
  }>();

  try {
    const lesson = await db
      .prepare(
        `SELECT l.title, l.video_stream_uid, l.video_provider, l.handout_r2_key, l.sort_order, c.instructor_id
         FROM lessons l
         INNER JOIN courses c ON l.course_id = c.id
         WHERE l.id = ?`
      )
      .bind(lessonId)
      .first<{ title: string; video_stream_uid: string; video_provider: string; handout_r2_key: string; sort_order: number; instructor_id: string }>();

    if (!lesson) {
      return c.json({ error: "ไม่พบบทเรียน" }, 404);
    }

    if (!user.roles.includes("admin") && lesson.instructor_id !== user.id) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นผู้สอนคอร์สของบทเรียนนี้" }, 403);
    }

    const newTitle = title !== undefined ? title : lesson.title;
    const newVideoUid = video_stream_uid !== undefined ? video_stream_uid : lesson.video_stream_uid;
    const newVideoProvider = video_provider !== undefined ? video_provider : lesson.video_provider;
    const newHandoutKey = handout_r2_key !== undefined ? handout_r2_key : lesson.handout_r2_key;
    const newSortOrder = sort_order !== undefined ? Number(sort_order) : lesson.sort_order;
    const assetError = await checkLessonAssets(c,
      newHandoutKey !== lesson.handout_r2_key ? newHandoutKey : null,
      newVideoUid !== lesson.video_stream_uid || newVideoProvider !== lesson.video_provider ? newVideoUid : null,
      newVideoProvider || "cloudflare");
    if (assetError) return c.json({ error: assetError }, 403);

    await db
      .prepare(
        `UPDATE lessons 
         SET title = ?, video_stream_uid = ?, video_provider = ?, handout_r2_key = ?, sort_order = ? 
         WHERE id = ?`
      )
      .bind(newTitle, newVideoUid, newVideoProvider, newHandoutKey, newSortOrder, lessonId)
      .run();

    return c.json({
      message: "อัปเดตบทเรียนเรียบร้อยแล้ว",
      lesson: {
        id: lessonId,
        title: newTitle,
        video_stream_uid: newVideoUid,
        video_provider: newVideoProvider,
        handout_r2_key: newHandoutKey,
        sort_order: newSortOrder
      }
    });
  } catch (error) {
    console.error("Update lesson failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะอัปเดตบทเรียน" }, 500);
  }
});

/**
 * Delete Lesson Module
 * DELETE /api/instructor/lessons/:id
 */
instructorRouter.delete("/instructor/lessons/:id", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const lessonId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const lesson = await db
      .prepare(
        `SELECT c.instructor_id
         FROM lessons l
         INNER JOIN courses c ON l.course_id = c.id
         WHERE l.id = ?`
      )
      .bind(lessonId)
      .first<{ instructor_id: string }>();

    if (!lesson) {
      return c.json({ error: "ไม่พบบทเรียน" }, 404);
    }

    if (!user.roles.includes("admin") && lesson.instructor_id !== user.id) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นผู้สอนคอร์สของบทเรียนนี้" }, 403);
    }

    await db.prepare("DELETE FROM lessons WHERE id = ?").bind(lessonId).run();

    return c.json({ message: "ลบบทเรียนเรียบร้อยแล้ว" });
  } catch (error) {
    console.error("Delete lesson failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะลบบทเรียน" }, 500);
  }
});

/**
 * List Quizzes for a specific Lesson
 * GET /api/instructor/lessons/:id/quizzes
 */
instructorRouter.get("/instructor/lessons/:id/quizzes", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const lessonId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const lesson = await db
      .prepare(
        `SELECT c.instructor_id
         FROM lessons l
         INNER JOIN courses c ON l.course_id = c.id
         WHERE l.id = ?`
      )
      .bind(lessonId)
      .first<{ instructor_id: string }>();

    if (!lesson) {
      return c.json({ error: "ไม่พบบทเรียน" }, 404);
    }

    if (!user.roles.includes("admin") && lesson.instructor_id !== user.id) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นผู้สอนคอร์สของบทเรียนนี้" }, 403);
    }

    const quizzes = await db
      .prepare("SELECT id, lesson_id, question, options_json, correct_option_index FROM quizzes WHERE lesson_id = ? ORDER BY id ASC")
      .bind(lessonId)
      .all();

    return c.json(quizzes.results);
  } catch (error) {
    console.error("Get lesson quizzes failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะดึงรายการแบบทดสอบ" }, 500);
  }
});

/**
 * Add Quiz Question
 * POST /api/instructor/quizzes
 */
instructorRouter.post("/instructor/quizzes", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const user = c.get("user");
  const db = c.env.DB;
  const { lesson_id, question, options_json, correct_option_index } = await c.req.json<{
    lesson_id: string;
    question: string;
    options_json: string | string[];
    correct_option_index: number;
  }>();

  if (!lesson_id || !question || options_json === undefined || correct_option_index === undefined) {
    return c.json({ error: "ต้องระบุ lesson_id, question, options_json และ correct_option_index" }, 400);
  }

  try {
    const lesson = await db
      .prepare(
        `SELECT c.instructor_id
         FROM lessons l
         INNER JOIN courses c ON l.course_id = c.id
         WHERE l.id = ?`
      )
      .bind(lesson_id)
      .first<{ instructor_id: string }>();

    if (!lesson) {
      return c.json({ error: "ไม่พบบทเรียน" }, 404);
    }

    if (!user.roles.includes("admin") && lesson.instructor_id !== user.id) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นผู้สอนคอร์สของบทเรียนนี้" }, 403);
    }

    let optionsStr = "";
    if (typeof options_json === "string") {
      // validate
      JSON.parse(options_json);
      optionsStr = options_json;
    } else if (Array.isArray(options_json)) {
      optionsStr = JSON.stringify(options_json);
    } else {
      return c.json({ error: "options_json ต้องเป็นอาร์เรย์ JSON หรือสตริงอาร์เรย์ JSON ที่ถูกต้อง" }, 400);
    }

    const quizId = "quiz_" + crypto.randomUUID().substring(0, 8);

    await db
      .prepare("INSERT INTO quizzes (id, lesson_id, question, options_json, correct_option_index) VALUES (?, ?, ?, ?, ?)")
      .bind(quizId, lesson_id, question, optionsStr, Number(correct_option_index))
      .run();

    return c.json({
      message: "สร้างคำถามแบบทดสอบเรียบร้อยแล้ว",
      quiz: {
        id: quizId,
        lesson_id,
        question,
        options_json: optionsStr,
        correct_option_index: Number(correct_option_index)
      }
    }, 201);
  } catch (error) {
    console.error("Add quiz question failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะเพิ่มคำถามแบบทดสอบ" }, 500);
  }
});

/**
 * Delete Quiz Question
 * DELETE /api/instructor/quizzes/:id
 */
instructorRouter.delete("/instructor/quizzes/:id", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const quizId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const quiz = await db
      .prepare(
        `SELECT q.lesson_id, c.instructor_id
         FROM quizzes q
         INNER JOIN lessons l ON q.lesson_id = l.id
         INNER JOIN courses c ON l.course_id = c.id
         WHERE q.id = ?`
      )
      .bind(quizId)
      .first<{ lesson_id: string; instructor_id: string }>();

    if (!quiz) {
      return c.json({ error: "ไม่พบคำถามแบบทดสอบ" }, 404);
    }

    if (!user.roles.includes("admin") && quiz.instructor_id !== user.id) {
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นผู้สอนคอร์สของแบบทดสอบนี้" }, 403);
    }

    await db.prepare("DELETE FROM quizzes WHERE id = ?").bind(quizId).run();

    return c.json({ message: "ลบคำถามแบบทดสอบเรียบร้อยแล้ว" });
  } catch (error) {
    console.error("Delete quiz question failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะลบคำถามแบบทดสอบ" }, 500);
  }
});

/**
 * Assign course access to student, B2B partner, or student group
 * POST /api/instructor/courses/:id/assign
 */
instructorRouter.post("/instructor/courses/:id/assign", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const courseId = c.req.param("id");
  const db = c.env.DB;
  const user = c.get("user");
  const { target_type, target_id } = await c.req.json<{
    target_type: "student" | "partner" | "group";
    target_id: string;
  }>();

  if (!target_type || !target_id) {
    return c.json({ error: "ต้องระบุ target_type ('student'|'partner'|'group') และ target_id" }, 400);
  }

  try {
    const course = await db
      .prepare("SELECT id, instructor_id, access_duration_days, status FROM courses WHERE id = ?")
      .bind(courseId)
      .first<{ id: string; instructor_id: string; access_duration_days: number | null; status: string }>();

    if (!course) {
      return c.json({ error: "ไม่พบคอร์ส" }, 404);
    }
    if (!user.roles.includes("admin") && course.instructor_id !== user.id)
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นเจ้าของคอร์สนี้" }, 403);
    if (course.status !== "published")
      return c.json({ error: "ให้สิทธิ์เข้าเรียนได้เฉพาะคอร์สที่เผยแพร่แล้ว" }, 403);

    // Calculate expires_at
    let expiresAt: string | null = null;
    if (course.access_duration_days && course.access_duration_days > 0) {
      expiresAt = new Date(Date.now() + course.access_duration_days * 24 * 60 * 60 * 1000).toISOString();
    }

    let studentIds: string[] = [];

    if (target_type === "student") {
      const student = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'student' AND staff_role IS NULL").bind(target_id).first();
      if (!student) {
        return c.json({ error: "ไม่พบผู้เรียน" }, 404);
      }
      studentIds = [target_id];
    } else if (target_type === "partner") {
      // A whole organization only for a course it sponsors (admins may grant any course)
      const partner = await db.prepare("SELECT id FROM partners WHERE id = ?").bind(target_id).first();
      if (!partner) return c.json({ error: "ไม่พบองค์กรพาร์ตเนอร์" }, 404);
      if (!user.roles.includes("admin")) {
        const sponsored = await db.prepare("SELECT 1 FROM partner_courses WHERE partner_id = ? AND course_id = ?")
          .bind(target_id, courseId).first();
        if (!sponsored) return c.json({ error: "องค์กรนี้ไม่ได้สนับสนุนคอร์สนี้ จึงให้สิทธิ์ทั้งองค์กรไม่ได้" }, 403);
      }
      const students = await db
        .prepare("SELECT id FROM users WHERE partner_id = ? AND role = 'student' AND staff_role IS NULL")
        .bind(target_id)
        .all<{ id: string }>();
      studentIds = students.results.map(s => s.id);
    } else if (target_type === "group") {
      if (!(await findOwnedGroup(c, target_id))) {
        return c.json({ error: "ไม่พบกลุ่มเรียน" }, 404);
      }
      const members = await db
        .prepare("SELECT user_id FROM student_group_members WHERE group_id = ?")
        .bind(target_id)
        .all<{ user_id: string }>();
      studentIds = members.results.map(m => m.user_id);
    }

    if (studentIds.length === 0) {
      return c.json({ message: "ไม่พบผู้เรียนที่จะให้สิทธิ์เข้าถึง" }, 200);
    }

    // New seats assigned to a whole organization are sponsored by it; personal assignments stay NULL.
    // An existing enrollment keeps its sponsor (a personal purchase never becomes the organization's).
    const sponsorId = target_type === "partner" ? target_id : null;

    // Process enrollments sequentially to handle existing progress/creation cleanly
    let enrolledCount = 0;
    for (const userId of studentIds) {
      const existing = await db
        .prepare("SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?")
        .bind(userId, courseId)
        .first<{ id: string }>();

      if (existing) {
        await db
          .prepare("UPDATE enrollments SET status = 'active', expires_at = ? WHERE id = ?")
          .bind(expiresAt, existing.id)
          .run();
      } else {
        const enrollmentId = "enr_" + crypto.randomUUID().substring(0, 8);
        await db
          .prepare("INSERT INTO enrollments (id, user_id, course_id, progress_percent, status, expires_at, partner_id) VALUES (?, ?, ?, 0, 'active', ?, ?) ON CONFLICT(user_id, course_id) DO NOTHING")
          .bind(enrollmentId, userId, courseId, expiresAt, sponsorId)
          .run();
      }
      enrolledCount++;
    }

    return c.json({
      message: `ให้สิทธิ์เข้าถึงสำเร็จ ${enrolledCount} คน`,
      enrolledCount,
      expires_at: expiresAt
    });
  } catch (error) {
    console.error("Assign course access failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะให้สิทธิ์เข้าถึงคอร์ส" }, 500);
  }
});

/**
 * List enrollments for a course
 * GET /api/instructor/courses/:id/enrollments
 */
instructorRouter.get("/instructor/courses/:id/enrollments", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const courseId = c.req.param("id");
  const db = c.env.DB;
  const user = c.get("user");

  try {
    const course = await db.prepare("SELECT instructor_id FROM courses WHERE id = ?")
      .bind(courseId).first<{ instructor_id: string }>();
    if (!course) return c.json({ error: "ไม่พบคอร์ส" }, 404);
    if (!user.roles.includes("admin") && course.instructor_id !== user.id)
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นเจ้าของคอร์สนี้" }, 403);
    const enrollments = await db
      .prepare(`
        SELECT e.id, e.user_id, e.progress_percent, e.status, e.enrolled_at, e.expires_at,
               u.name as student_name, u.email as student_email
        FROM enrollments e
        INNER JOIN users u ON e.user_id = u.id
        WHERE e.course_id = ?
        ORDER BY e.enrolled_at DESC
      `)
      .bind(courseId)
      .all();

    return c.json(enrollments.results);
  } catch (error) {
    console.error("Fetch course enrollments failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะดึงรายการลงทะเบียนเรียน" }, 500);
  }
});

/**
 * Create a voucher. Instructors create codes for their own courses only; admins may also create
 * site-wide codes (no course_id).
 * POST /api/instructor/vouchers
 */
instructorRouter.post("/instructor/vouchers", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const db = c.env.DB;
  const user = c.get("user");
  const isAdmin = user.roles.includes("admin");
  const { code, discount_type, discount_value, course_id, expires_at, max_uses } = await c.req.json<{
    code: string;
    discount_type: "percent" | "fixed";
    discount_value: number;
    course_id?: string | null;
    expires_at?: string | null;
    max_uses?: number | null;
  }>();

  if (!code || !discount_type || discount_value === undefined) {
    return c.json({ error: "ต้องระบุ code, discount_type และ discount_value" }, 400);
  }
  const value = Number(discount_value);
  if (!["percent", "fixed"].includes(discount_type) || !Number.isFinite(value) || value <= 0 || (discount_type === "percent" && value > 100)) {
    return c.json({ error: "ส่วนลดไม่ถูกต้อง: เปอร์เซ็นต์ต้องอยู่ระหว่าง 1–100 และจำนวนเงินต้องมากกว่า 0" }, 400);
  }
  const maxUses = max_uses === undefined || max_uses === null || (max_uses as unknown) === "" ? null : Number(max_uses);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
    return c.json({ error: "จำนวนครั้งที่ใช้ได้ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป" }, 400);
  }
  if (!course_id && !isAdmin) {
    return c.json({ error: "ต้องเลือกคอร์สของคุณสำหรับโค้ดส่วนลด" }, 400);
  }

  try {
    if (course_id) {
      const course = await db.prepare("SELECT instructor_id FROM courses WHERE id = ?").bind(course_id).first<{ instructor_id: string }>();
      if (!course) return c.json({ error: "ไม่พบคอร์สที่ระบุ" }, 404);
      if (!isAdmin && course.instructor_id !== user.id)
        return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: สร้างโค้ดส่วนลดได้เฉพาะคอร์สของคุณ" }, 403);
    }

    const id = "vouch_" + crypto.randomUUID().substring(0, 8);
    const codeUpper = code.toUpperCase().trim();

    const existing = await db.prepare("SELECT id FROM vouchers WHERE code = ?").bind(codeUpper).first();
    if (existing) {
      return c.json({ error: "มีโค้ดส่วนลดนี้อยู่แล้ว" }, 400);
    }

    await db
      .prepare("INSERT INTO vouchers (id, code, discount_type, discount_value, course_id, active, expires_at, created_by, max_uses, used_count) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 0)")
      .bind(id, codeUpper, discount_type, value, course_id || null, expires_at || null, user.id, maxUses)
      .run();

    return c.json({
      message: "สร้างโค้ดส่วนลดเรียบร้อยแล้ว",
      voucher: { id, code: codeUpper, discount_type, discount_value: value, course_id: course_id || null, expires_at: expires_at || null,
        created_by: user.id, max_uses: maxUses, used_count: 0 }
    }, 201);
  } catch (error) {
    console.error("Create voucher failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะสร้างโค้ดส่วนลด" }, 500);
  }
});

/**
 * List vouchers: own vouchers for instructors, every voucher for admins
 * GET /api/instructor/vouchers
 */
instructorRouter.get("/instructor/vouchers", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const db = c.env.DB;
  const user = c.get("user");
  const isAdmin = user.roles.includes("admin");

  try {
    const stmt = db.prepare(`
        SELECT v.*, c.title as course_title, u.name as created_by_name
        FROM vouchers v
        LEFT JOIN courses c ON v.course_id = c.id
        LEFT JOIN users u ON v.created_by = u.id
        ${isAdmin ? "" : "WHERE v.created_by = ?"}
        ORDER BY v.code ASC
      `);
    const vouchers = await (isAdmin ? stmt : stmt.bind(user.id)).all();
    return c.json(vouchers.results);
  } catch (error) {
    console.error("List vouchers failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะดึงรายการโค้ดส่วนลด" }, 500);
  }
});

/**
 * Delete a voucher (own vouchers only; admins any)
 * DELETE /api/instructor/vouchers/:id
 */
instructorRouter.delete("/instructor/vouchers/:id", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const voucherId = c.req.param("id");
  const db = c.env.DB;
  const user = c.get("user");

  try {
    const existing = await db.prepare("SELECT id, created_by FROM vouchers WHERE id = ?").bind(voucherId).first<{ id: string; created_by: string | null }>();
    // Someone else's voucher looks the same as a missing one
    if (!existing || (!user.roles.includes("admin") && existing.created_by !== user.id)) {
      return c.json({ error: "ไม่พบโค้ดส่วนลด" }, 404);
    }

    await db.prepare("DELETE FROM vouchers WHERE id = ?").bind(voucherId).run();
    return c.json({ message: "ลบโค้ดส่วนลดเรียบร้อยแล้ว" });
  } catch (error) {
    console.error("Delete voucher failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะลบโค้ดส่วนลด" }, 500);
  }
});

/**
 * A group the current user may manage: their own, or any group for admins (including legacy
 * groups without an owner). Others' groups are reported as missing.
 */
async function findOwnedGroup(c: Context<Env>, groupId: string | undefined): Promise<{ id: string } | null> {
  const user = c.get("user");
  if (!groupId) return null;
  if (user.roles.includes("admin"))
    return c.env.DB.prepare("SELECT id FROM student_groups WHERE id = ?").bind(groupId).first<{ id: string }>();
  return c.env.DB.prepare("SELECT id FROM student_groups WHERE id = ? AND instructor_id = ?").bind(groupId, user.id).first<{ id: string }>();
}

/**
 * Create a student group
 * POST /api/instructor/groups
 */
instructorRouter.post("/instructor/groups", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const db = c.env.DB;
  const user = c.get("user");
  const { name } = await c.req.json<{ name: string }>();

  if (!name) {
    return c.json({ error: "ต้องระบุชื่อกลุ่ม" }, 400);
  }

  try {
    const id = "group_" + crypto.randomUUID().substring(0, 8);
    await db
      .prepare("INSERT INTO student_groups (id, name, instructor_id) VALUES (?, ?, ?)")
      .bind(id, name.trim(), user.id)
      .run();

    return c.json({
      message: "สร้างกลุ่มเรียนเรียบร้อยแล้ว",
      group: { id, name }
    }, 201);
  } catch (error) {
    console.error("Create group failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะสร้างกลุ่มเรียน" }, 500);
  }
});

/**
 * List all student groups with member counts
 * GET /api/instructor/groups
 */
instructorRouter.get("/instructor/groups", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const db = c.env.DB;
  const user = c.get("user");
  const isAdmin = user.roles.includes("admin");

  try {
    const stmt = db
      .prepare(`
        SELECT g.*, COUNT(m.user_id) as member_count
        FROM student_groups g
        LEFT JOIN student_group_members m ON g.id = m.group_id
        ${isAdmin ? "" : "WHERE g.instructor_id = ?"}
        GROUP BY g.id
        ORDER BY g.name ASC
      `);
    const groups = await (isAdmin ? stmt : stmt.bind(user.id)).all();
    return c.json(groups.results);
  } catch (error) {
    console.error("List groups failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะดึงรายการกลุ่มเรียน" }, 500);
  }
});

/**
 * Delete a student group
 * DELETE /api/instructor/groups/:id
 */
instructorRouter.delete("/instructor/groups/:id", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const groupId = c.req.param("id");
  const db = c.env.DB;

  try {
    if (!(await findOwnedGroup(c, groupId))) {
      return c.json({ error: "ไม่พบกลุ่มเรียน" }, 404);
    }

    await db.prepare("DELETE FROM student_groups WHERE id = ?").bind(groupId).run();
    return c.json({ message: "ลบกลุ่มเรียนเรียบร้อยแล้ว" });
  } catch (error) {
    console.error("Delete group failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะลบกลุ่มเรียน" }, 500);
  }
});

/**
 * Add a student to a group
 * POST /api/instructor/groups/:id/members
 */
instructorRouter.post("/instructor/groups/:id/members", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const groupId = c.req.param("id");
  const db = c.env.DB;
  const { user_id } = await c.req.json<{ user_id: string }>();

  if (!user_id) {
    return c.json({ error: "ต้องระบุ user_id" }, 400);
  }

  try {
    const group = await findOwnedGroup(c, groupId);
    if (!group) {
      return c.json({ error: "ไม่พบกลุ่มเรียน" }, 404);
    }

    const student = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'student' AND staff_role IS NULL").bind(user_id).first();
    if (!student) {
      return c.json({ error: "ไม่พบผู้เรียน" }, 404);
    }

    const existing = await db
      .prepare("SELECT group_id FROM student_group_members WHERE group_id = ? AND user_id = ?")
      .bind(groupId, user_id)
      .first();

    if (existing) {
      return c.json({ error: "ผู้เรียนเป็นสมาชิกของกลุ่มนี้อยู่แล้ว" }, 400);
    }

    await db
      .prepare("INSERT INTO student_group_members (group_id, user_id) VALUES (?, ?)")
      .bind(groupId, user_id)
      .run();

    return c.json({ message: "เพิ่มผู้เรียนเข้ากลุ่มเรียบร้อยแล้ว" }, 201);
  } catch (error) {
    console.error("Add group member failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะเพิ่มสมาชิกกลุ่ม" }, 500);
  }
});

/**
 * Remove a student from a group
 * DELETE /api/instructor/groups/:id/members/:userId
 */
instructorRouter.delete("/instructor/groups/:id/members/:userId", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const groupId = c.req.param("id");
  const userId = c.req.param("userId");
  const db = c.env.DB;

  try {
    if (!(await findOwnedGroup(c, groupId))) {
      return c.json({ error: "ไม่พบกลุ่มเรียน" }, 404);
    }
    const existing = await db
      .prepare("SELECT group_id FROM student_group_members WHERE group_id = ? AND user_id = ?")
      .bind(groupId, userId)
      .first();

    if (!existing) {
      return c.json({ error: "ไม่พบสมาชิกในกลุ่ม" }, 404);
    }

    await db
      .prepare("DELETE FROM student_group_members WHERE group_id = ? AND user_id = ?")
      .bind(groupId, userId)
      .run();

    return c.json({ message: "นำผู้เรียนออกจากกลุ่มเรียบร้อยแล้ว" });
  } catch (error) {
    console.error("Remove group member failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะนำสมาชิกออกจากกลุ่ม" }, 500);
  }
});

/**
 * List all members of a group
 * GET /api/instructor/groups/:id/members
 */
instructorRouter.get("/instructor/groups/:id/members", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const groupId = c.req.param("id");
  const db = c.env.DB;

  try {
    if (!(await findOwnedGroup(c, groupId))) {
      return c.json({ error: "ไม่พบกลุ่มเรียน" }, 404);
    }
    const members = await db
      .prepare(`
        SELECT u.id, u.name, u.email, u.created_at
        FROM student_group_members m
        INNER JOIN users u ON m.user_id = u.id
        WHERE m.group_id = ?
        ORDER BY u.name ASC
      `)
      .bind(groupId)
      .all();
    return c.json(members.results);
  } catch (error) {
    console.error("List group members failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะดึงรายชื่อสมาชิกกลุ่ม" }, 500);
  }
});

/**
 * List students. Admins see everyone; an instructor sees students enrolled in their courses or in
 * their groups. ?email= looks up one student by exact email (to assign someone new) without listing others.
 * GET /api/instructor/students
 */
instructorRouter.get("/instructor/students", rbac(["instructor", "admin"]), async (c: Context<Env>) => {
  const db = c.env.DB;
  const user = c.get("user");
  const email = (c.req.query("email") || "").trim().toLowerCase();

  try {
    if (email) {
      const student = await db
        .prepare("SELECT id, name, email FROM users WHERE lower(email) = ? AND role = 'student' AND staff_role IS NULL")
        .bind(email)
        .first();
      return c.json(student ? [student] : []);
    }
    const students = user.roles.includes("admin")
      ? await db.prepare("SELECT id, name, email FROM users WHERE role = 'student' AND staff_role IS NULL ORDER BY name ASC").all()
      : await db.prepare(`SELECT u.id, u.name, u.email FROM users u
          WHERE u.role = 'student' AND u.staff_role IS NULL
            AND (EXISTS (SELECT 1 FROM enrollments e JOIN courses co ON co.id = e.course_id WHERE e.user_id = u.id AND co.instructor_id = ?1)
              OR EXISTS (SELECT 1 FROM student_group_members m JOIN student_groups g ON g.id = m.group_id WHERE m.user_id = u.id AND g.instructor_id = ?1))
          ORDER BY u.name ASC`).bind(user.id).all();
    return c.json(students.results);
  } catch (error) {
    console.error("List students failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะดึงรายชื่อผู้เรียน" }, 500);
  }
});

// ---------- File uploads ----------

/** Cloudflare Workers reject request bodies above 100 MB; larger videos go to Stream (see /instructor/stream/direct-upload). */
const WORKER_UPLOAD_LIMIT = 100 * 1024 * 1024;
const HANDOUT_LIMIT = 50 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 15 * 60;
const VIDEO_TYPES: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo", mpeg: "video/mpeg" };

interface PendingUpload { user_id: string; key: string; content_type: string; max_bytes: number; expires: number }
const pendingUploadKey = (key: string) => `upload:${key}`;

/**
 * Validates an upload request and returns the server-chosen R2 key and content type,
 * or an error message. Keys always live under the uploader's own prefix.
 */
function planUpload(userId: string, type: unknown, filename: string, size: number, mimeType: string | undefined):
  { key: string; contentType: string } | { error: string } {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  let contentType: string;
  if (type === "video") {
    contentType = mimeType && mimeType.startsWith("video/") ? mimeType : VIDEO_TYPES[ext] || "";
    if (!contentType) return { error: "อนุญาตเฉพาะไฟล์วิดีโอสำหรับการอัปโหลดวิดีโอ (เช่น mp4, mov, webm)" };
    if (size > WORKER_UPLOAD_LIMIT) return { error: "ไฟล์วิดีโอใหญ่เกิน 100MB ให้อัปโหลดผ่าน Cloudflare Stream แทน" };
  } else if (type === "handout") {
    if (mimeType ? mimeType !== "application/pdf" : ext !== "pdf") return { error: "อนุญาตเฉพาะไฟล์ PDF สำหรับการอัปโหลดเอกสารประกอบการเรียน" };
    contentType = "application/pdf";
    if (size > HANDOUT_LIMIT) return { error: "ไฟล์เอกสารประกอบการเรียนมีขนาดเกินกำหนดสูงสุด 50MB" };
  } else {
    return { error: "ประเภทไฟล์ต้องเป็น handout หรือ video" };
  }
  if (!Number.isFinite(size) || size <= 0) return { error: "ขนาดไฟล์ไม่ถูกต้อง" };

  const sanitizedName = filename.replace(/[^a-zA-Z0-9.-]/g, "_").slice(-100);
  const key = `${uploadPrefix(userId)}${type === "video" ? "videos" : "handouts"}/${crypto.randomUUID()}-${sanitizedName}`;
  return { key, contentType };
}

/**
 * Upload Asset File (Handout PDF or Video MP4) directly to Cloudflare R2 bucket (multipart form)
 * POST /api/instructor/upload
 */
instructorRouter.post("/instructor/upload", rbac(["instructor", "admin"]), async (c) => {
  const user = c.get("user");
  const declared = Number(c.req.header("Content-Length"));
  if (!declared || declared > WORKER_UPLOAD_LIMIT) {
    return c.json({ error: "ต้องระบุขนาดไฟล์ และไฟล์ต้องไม่เกิน 100MB" }, 413);
  }
  try {
    const body = await c.req.parseBody();
    const file = body.file;
    const type = body.type || "handout"; // "handout" | "video"

    if (!file || !(file instanceof File)) {
      return c.json({ error: "ไม่พบไฟล์ที่อัปโหลดหรือไฟล์ไม่ถูกต้อง" }, 400);
    }

    const plan = planUpload(user.id, type, file.name, file.size, file.type || undefined);
    if ("error" in plan) return c.json({ error: plan.error }, 400);

    // Stream upload directly to R2 bucket binding ASSETS
    await c.env.ASSETS.put(plan.key, file.stream(), { httpMetadata: { contentType: plan.contentType } });

    return c.json({
      message: "อัปโหลดไฟล์เรียบร้อยแล้ว",
      key: plan.key,
      name: file.name
    });
  } catch (err) {
    console.error("Upload failed:", err);
    return c.json({ error: "อัปโหลดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" }, 500);
  }
});

/**
 * Reserve an upload. The server picks the R2 key (under the user's prefix) and remembers the
 * declared type and size for 15 minutes; PUT /instructor/upload/direct accepts exactly that.
 * POST /api/instructor/upload/presign
 */
instructorRouter.post("/instructor/upload/presign", rbac(["instructor", "admin"]), async (c) => {
  const user = c.get("user");
  const { filename, type, size, mimeType } = await c.req.json<{
    filename: string;
    type: "handout" | "video";
    size: number;
    mimeType?: string;
  }>();

  if (!filename || typeof filename !== "string" || !type || size === undefined) {
    return c.json({ error: "ต้องระบุ filename, type และ size" }, 400);
  }

  const plan = planUpload(user.id, type, filename, Number(size), mimeType || undefined);
  if ("error" in plan) return c.json({ error: plan.error }, 400);

  const record: PendingUpload = {
    user_id: user.id,
    key: plan.key,
    content_type: plan.contentType,
    max_bytes: Number(size),
    expires: Date.now() + UPLOAD_TTL_SECONDS * 1000
  };
  await c.env.SESSIONS.put(pendingUploadKey(plan.key), JSON.stringify(record), { expirationTtl: UPLOAD_TTL_SECONDS });

  return c.json({
    key: plan.key,
    uploadUrl: `/instructor/upload/direct?key=${encodeURIComponent(plan.key)}`,
    contentType: plan.contentType,
    maxBytes: record.max_bytes,
    expiresAt: new Date(record.expires).toISOString(),
    filename
  });
});

/**
 * Direct Stream Upload to R2 Bucket (one upload per reservation)
 * PUT /api/instructor/upload/direct?key=
 */
instructorRouter.put("/instructor/upload/direct", rbac(["instructor", "admin"]), async (c) => {
  const user = c.get("user");
  const key = c.req.query("key");
  if (!key) {
    return c.json({ error: "ไม่พบพารามิเตอร์ key ของที่เก็บไฟล์" }, 400);
  }

  try {
    const raw = await c.env.SESSIONS.get(pendingUploadKey(key));
    const record = raw ? JSON.parse(raw) as PendingUpload : null;
    if (!record || record.user_id !== user.id || record.key !== key || record.expires < Date.now()) {
      return c.json({ error: "ไม่พบสิทธิ์อัปโหลดสำหรับไฟล์นี้หรือหมดอายุแล้ว กรุณาเริ่มอัปโหลดใหม่" }, 403);
    }

    const contentType = (c.req.header("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (contentType !== record.content_type.toLowerCase()) {
      return c.json({ error: "ประเภทไฟล์ไม่ตรงกับที่แจ้งไว้ตอนขออัปโหลด" }, 400);
    }

    const lengthHeader = c.req.header("Content-Length");
    const length = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
    if (!Number.isFinite(length) || length <= 0) {
      return c.json({ error: "ต้องระบุ Content-Length ของไฟล์" }, 411);
    }
    if (length > record.max_bytes || length > WORKER_UPLOAD_LIMIT) {
      return c.json({ error: "ไฟล์ใหญ่กว่าขนาดที่แจ้งไว้หรือเกิน 100MB" }, 413);
    }

    const body = c.req.raw.body; // Raw ReadableStream of the incoming request
    if (!body) {
      return c.json({ error: "เนื้อหาคำขอว่างเปล่า" }, 400);
    }

    // One-shot reservation: remove it before writing so it cannot be replayed
    await c.env.SESSIONS.delete(pendingUploadKey(key));

    // Stream directly into R2 bucket (no memory buffering); R2 rejects bodies that differ from Content-Length
    await c.env.ASSETS.put(key, body, {
      httpMetadata: { contentType: record.content_type }
    });

    return c.json({
      message: "อัปโหลดแบบสตรีมเสร็จสมบูรณ์",
      key
    });
  } catch (err) {
    console.error("Direct upload failed:", err);
    return c.json({ error: "อัปโหลดแบบสตรีมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" }, 500);
  }
});

/**
 * Create a Cloudflare Stream direct creator upload (tus) for videos larger than 100 MB.
 * The browser uploads straight to Stream; the returned uid goes into the lesson's video_stream_uid.
 * POST /api/instructor/stream/direct-upload { size, filename, maxDurationSeconds? }
 */
instructorRouter.post("/instructor/stream/direct-upload", rbac(["instructor", "admin"]), async (c) => {
  const user = c.get("user");
  if (!c.env.STREAM_ACCOUNT_ID || !c.env.STREAM_API_TOKEN) {
    return c.json({ error: "ยังไม่ได้ตั้งค่า Cloudflare Stream สำหรับอัปโหลดวิดีโอขนาดใหญ่ กรุณาติดต่อผู้ดูแลระบบ" }, 503);
  }
  const { size, filename, maxDurationSeconds } = await c.req.json<{ size: number; filename?: string; maxDurationSeconds?: number }>()
    .catch(() => ({ size: 0, filename: undefined, maxDurationSeconds: undefined }));
  const uploadLength = Number(size);
  // Stream accepts files up to 30 GB; the duration cap keeps one upload from using all storage minutes
  if (!Number.isInteger(uploadLength) || uploadLength <= 0 || uploadLength > 30 * 1024 * 1024 * 1024) {
    return c.json({ error: "ขนาดไฟล์วิดีโอไม่ถูกต้อง (สูงสุด 30GB)" }, 400);
  }
  const duration = Math.min(Math.max(Math.round(Number(maxDurationSeconds) || 4 * 3600), 60), 6 * 3600);

  try {
    const { uploadURL, uid } = await createStreamDirectUpload(c.env.STREAM_ACCOUNT_ID, c.env.STREAM_API_TOKEN, {
      uploadLength,
      maxDurationSeconds: duration,
      name: String(filename || "lesson-video").slice(0, 200),
      creatorId: user.id
    });
    await c.env.SESSIONS.put(streamOwnerKey(uid), user.id, { expirationTtl: STREAM_OWNER_TTL_SECONDS });
    return c.json({ uploadURL, uid, maxDurationSeconds: duration });
  } catch (err) {
    console.error("Stream direct upload creation failed:", err);
    return c.json({ error: "สร้างลิงก์อัปโหลดไปยัง Cloudflare Stream ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" }, 502);
  }
});

/**
 * Get Student Quiz Struggles Audit Statistics
 * GET /api/instructor/telemetry/quiz-failures
 */
instructorRouter.get("/instructor/telemetry/quiz-failures", rbac(["instructor", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const isGlobal = user.roles.includes("admin");
  const targetId = user.id;

  try {
    const query = `
      SELECT qa.lesson_id, l.title as lesson_title, c.title as course_title,
             u.name as student_name, u.email as student_email,
             COUNT(qa.id) as attempt_count,
             MIN(qa.score) as min_score,
             MAX(qa.score) as max_score,
             qa.total_questions
      FROM quiz_attempts qa
      INNER JOIN lessons l ON qa.lesson_id = l.id
      INNER JOIN courses c ON l.course_id = c.id
      INNER JOIN users u ON qa.user_id = u.id
      WHERE (?1 = 1 OR c.instructor_id = ?2)
      GROUP BY qa.lesson_id, qa.user_id
      ORDER BY MIN(qa.score) ASC, attempt_count DESC
    `;
    const stmt = db.prepare(query).bind(isGlobal ? 1 : 0, targetId);
    const res = await stmt.all();
    return c.json(res.results);
  } catch (err: any) {
    console.error("Quiz failures telemetry failed:", err);
    return c.json({ error: "ดึงข้อมูลการใช้งานแบบทดสอบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" }, 500);
  }
});

/**
 * Get Video stuck progress tracker (In-progress lectures paused before completion)
 * GET /api/instructor/telemetry/video-stuck
 */
instructorRouter.get("/instructor/telemetry/video-stuck", rbac(["instructor", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const isGlobal = user.roles.includes("admin");
  const targetId = user.id;

  try {
    const query = `
      SELECT lp.user_id, u.name as student_name, u.email as student_email,
             lp.lesson_id, l.title as lesson_title, c.title as course_title,
             lp.resume_seconds, lp.updated_at
      FROM lesson_progress lp
      INNER JOIN lessons l ON lp.lesson_id = l.id
      INNER JOIN courses c ON lp.course_id = c.id
      INNER JOIN users u ON lp.user_id = u.id
      WHERE lp.completed = 0 AND lp.resume_seconds > 0 AND (?1 = 1 OR c.instructor_id = ?2)
      ORDER BY lp.updated_at DESC
    `;
    const stmt = db.prepare(query).bind(isGlobal ? 1 : 0, targetId);
    const res = await stmt.all();
    return c.json(res.results);
  } catch (err: any) {
    console.error("Video stuck telemetry failed:", err);
    return c.json({ error: "ดึงข้อมูลการใช้งานวิดีโอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" }, 500);
  }
});

/**
 * Get central Q&A questions for instructor's courses
 * GET /api/instructor/qa
 */
instructorRouter.get("/instructor/qa", rbac(["instructor", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const isGlobal = user.roles.includes("admin");
  const targetId = user.id;

  try {
    const query = `
      SELECT q.id, q.lesson_id, q.user_id, q.content, q.created_at, q.parent_id,
             u.name as user_name, u.role as user_role,
             l.title as lesson_title, c.title as course_title
      FROM lesson_qa q
      INNER JOIN users u ON q.user_id = u.id
      INNER JOIN lessons l ON q.lesson_id = l.id
      INNER JOIN courses c ON l.course_id = c.id
      WHERE q.parent_id IS NULL AND (?1 = 1 OR c.instructor_id = ?2)
      ORDER BY q.created_at DESC
    `;
    const stmt = db.prepare(query).bind(isGlobal ? 1 : 0, targetId);
    const res = await stmt.all();
    return c.json(res.results);
  } catch (err: any) {
    console.error("Instructor QA query failed:", err);
    return c.json({ error: "ดึงข้อมูลถามตอบของผู้สอนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" }, 500);
  }
});
