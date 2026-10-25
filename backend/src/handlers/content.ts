import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { currentPermissions } from "../utils/permissions";
import { trackEvent } from "../utils/events";
import { embedSrc, EMBED_PROVIDERS } from "../utils/embeds";
import { audit } from "./accounts";
import { canApproveCourses, verifiedTokenUserId } from "./courses";
import { checkLessonAssets } from "./instructor";
import {
  activeEnrollmentId, completeLesson, isCourseStaff, isLessonType, jsonList, LESSON_ORDER, lessonLockResponse
} from "../utils/courseContent";

/**
 * Course structure & content (v0.5): categories, chapters and ordering, lesson types
 * (text / pdf / embed; SCORM lives in scorm.ts), drip settings, prerequisites and sales-page fields,
 * plus the learner endpoints that serve lesson content behind enrollment and lock checks.
 */
export const contentRouter = new Hono<Env>();

const OWNER_ERROR = "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นเจ้าของคอร์สนี้";
const LEVELS = ["beginner", "intermediate", "advanced", "all"];
const PDF_LIMIT = 50 * 1024 * 1024;

/** Course row for a mutation, or an error response (404 / 403 for courses the user does not own). */
async function ownedCourse(c: Context<Env>, courseId: string): Promise<{ course: { id: string; instructor_id: string } } | { error: Response }> {
  const user = c.get("user");
  const course = await c.env.DB.prepare("SELECT id, instructor_id FROM courses WHERE id = ?").bind(courseId).first<{ id: string; instructor_id: string }>();
  if (!course) return { error: c.json({ error: "ไม่พบคอร์ส" }, 404) };
  if (!user.roles.includes("admin") && course.instructor_id !== user.id) return { error: c.json({ error: OWNER_ERROR }, 403) };
  return { course };
}

async function ownedLesson(c: Context<Env>, lessonId: string) {
  const user = c.get("user");
  const lesson = await c.env.DB.prepare(`SELECT l.*, co.instructor_id FROM lessons l JOIN courses co ON co.id = l.course_id WHERE l.id = ?`)
    .bind(lessonId).first<LessonRow & { instructor_id: string }>();
  if (!lesson) return { error: c.json({ error: "ไม่พบบทเรียน" }, 404) };
  if (!user.roles.includes("admin") && lesson.instructor_id !== user.id)
    return { error: c.json({ error: "ไม่มีสิทธิ์เข้าถึง: คุณไม่ได้เป็นผู้สอนคอร์สของบทเรียนนี้" }, 403) };
  return { lesson };
}

interface LessonRow {
  id: string; course_id: string; title: string; type: string; section_id: string | null; sort_order: number;
  video_stream_uid: string | null; video_provider: string | null; handout_r2_key: string | null;
  content_json: string | null; content_md: string | null; pdf_r2_key: string | null; embed_url: string | null;
  scorm_base: string | null; scorm_launch: string | null; available_after_days: number | null; available_on: string | null;
}

// ==========================================
// Categories
// ==========================================

async function canManageCategories(c: Context<Env>): Promise<boolean> {
  if (c.get("user").roles.includes("admin")) return true;
  const granted = await currentPermissions(c);
  return granted.has("courses.approve") || granted.has("website.design");
}

const slugify = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Categories with the number of published courses in each (catalog filters, public site).
 * GET /api/course-categories
 */
contentRouter.get("/course-categories", async (c) => {
  try {
    const rows = await c.env.DB.prepare(`SELECT cat.id, cat.name, cat.slug, cat.description, cat.sort_order,
        (SELECT COUNT(*) FROM courses co WHERE co.category_id = cat.id AND co.status = 'published') AS course_count
      FROM course_categories cat ORDER BY cat.sort_order, cat.name`).all();
    return c.json({ categories: rows.results });
  } catch (error) {
    console.error("List course categories failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดหมวดหมู่คอร์ส" }, 500);
  }
});

contentRouter.use("/admin/course-categories", rbac());
contentRouter.use("/admin/course-categories/*", rbac());

interface CategoryInput { name?: unknown; slug?: unknown; description?: unknown; sort_order?: unknown }

function categoryValues(body: CategoryInput, partial: boolean): { values: Record<string, unknown> } | { error: string } {
  const values: Record<string, unknown> = {};
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return { error: "ชื่อหมวดหมู่ต้องมี 1–80 ตัวอักษร" };
    values.name = name;
  }
  if (body.slug !== undefined && body.slug !== null && body.slug !== "") {
    const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
    if (!SLUG.test(slug) || slug.length > 60) return { error: "slug ใช้ได้เฉพาะ a-z, 0-9 และขีดกลาง (ไม่เกิน 60 ตัวอักษร)" };
    values.slug = slug;
  } else if (!partial) {
    values.slug = slugify(String(values.name)) || `cat-${crypto.randomUUID().slice(0, 6)}`;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") return { error: "คำอธิบายไม่ถูกต้อง" };
    values.description = typeof body.description === "string" ? body.description.trim().slice(0, 500) || null : null;
  }
  if (body.sort_order !== undefined) {
    const order = Number(body.sort_order);
    if (!Number.isInteger(order) || order < 0 || order > 100000) return { error: "ลำดับต้องเป็นจำนวนเต็ม 0 ขึ้นไป" };
    values.sort_order = order;
  }
  return { values };
}

/**
 * Create a category (courses.approve or website.design)
 * POST /api/admin/course-categories { name, slug?, description?, sort_order? }
 */
contentRouter.post("/admin/course-categories", async (c) => {
  if (!(await canManageCategories(c))) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const parsed = categoryValues(await c.req.json<CategoryInput>().catch(() => ({})), false);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const v = parsed.values;
  const id = "cat_" + crypto.randomUUID().slice(0, 8);
  try {
    const order = v.sort_order ?? ((await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM course_categories").first<{ next: number }>())?.next ?? 1);
    const inserted = await c.env.DB.prepare(`INSERT INTO course_categories (id, name, slug, description, sort_order) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO NOTHING`).bind(id, v.name, v.slug, v.description ?? null, order).run();
    if (!inserted.meta.changes) return c.json({ error: "slug นี้ถูกใช้แล้ว" }, 409);
    await audit(c, "course_category.create", "course_category", id, { name: v.name, slug: v.slug });
    return c.json({ message: "เพิ่มหมวดหมู่แล้ว", category: { id, name: v.name, slug: v.slug, description: v.description ?? null, sort_order: order } }, 201);
  } catch (error) {
    console.error("Create course category failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะเพิ่มหมวดหมู่" }, 500);
  }
});

/**
 * PATCH /api/admin/course-categories/:id
 */
contentRouter.patch("/admin/course-categories/:id", async (c) => {
  if (!(await canManageCategories(c))) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const id = c.req.param("id");
  const parsed = categoryValues(await c.req.json<CategoryInput>().catch(() => ({})), true);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const entries = Object.entries(parsed.values);
  if (!entries.length) return c.json({ error: "ไม่มีข้อมูลที่ต้องแก้ไข" }, 400);
  try {
    const exists = await c.env.DB.prepare("SELECT id FROM course_categories WHERE id = ?").bind(id).first();
    if (!exists) return c.json({ error: "ไม่พบหมวดหมู่" }, 404);
    if (parsed.values.slug) {
      const taken = await c.env.DB.prepare("SELECT id FROM course_categories WHERE slug = ? AND id != ?").bind(parsed.values.slug, id).first();
      if (taken) return c.json({ error: "slug นี้ถูกใช้แล้ว" }, 409);
    }
    await c.env.DB.prepare(`UPDATE course_categories SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .bind(...entries.map(([, v]) => v), id).run();
    await audit(c, "course_category.update", "course_category", id, parsed.values);
    return c.json({ message: "บันทึกหมวดหมู่แล้ว" });
  } catch (error) {
    console.error("Update course category failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะบันทึกหมวดหมู่" }, 500);
  }
});

/**
 * Delete a category; its courses become uncategorized.
 * DELETE /api/admin/course-categories/:id
 */
contentRouter.delete("/admin/course-categories/:id", async (c) => {
  if (!(await canManageCategories(c))) return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  const id = c.req.param("id");
  try {
    const [, removed] = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE courses SET category_id = NULL WHERE category_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM course_categories WHERE id = ?").bind(id)
    ]);
    if (!removed.meta.changes) return c.json({ error: "ไม่พบหมวดหมู่" }, 404);
    await audit(c, "course_category.delete", "course_category", id);
    return c.json({ message: "ลบหมวดหมู่แล้ว คอร์สในหมวดนี้จะไม่มีหมวดหมู่" });
  } catch (error) {
    console.error("Delete course category failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะลบหมวดหมู่" }, 500);
  }
});

// ==========================================
// Course details: sales page, category, sequential, prerequisites
// ==========================================

/** Sales-page fields of a course row, parsed for API responses. */
export function salesFields(row: Record<string, any>) {
  return {
    subtitle: row.subtitle ?? null,
    learning_outcomes: jsonList<string>(row.learning_outcomes_json),
    requirements: jsonList<string>(row.requirements_json),
    target_audience: jsonList<string>(row.target_audience_json),
    level: row.level ?? null,
    language: row.language ?? null,
    duration_hours: row.duration_hours ?? null,
    promo_video_url: row.promo_video_url ?? null,
    promo_video_embed: row.promo_video_url ? embedSrc(row.promo_video_url) : null,
    faq: jsonList<{ question: string; answer: string }>(row.faq_json),
    sequential: !!row.sequential
  };
}

function stringList(value: unknown, label: string, maxItems = 20, maxLength = 300): { list: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: `${label}ต้องเป็นรายการข้อความ` };
  const list = value.map(v => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
  if (list.length !== value.filter(v => typeof v === "string" && v.trim()).length || value.some(v => typeof v !== "string"))
    return { error: `${label}ต้องเป็นรายการข้อความ` };
  if (list.length > maxItems) return { error: `${label}ใส่ได้ไม่เกิน ${maxItems} ข้อ` };
  if (list.some(v => v.length > maxLength)) return { error: `${label}แต่ละข้อยาวได้ไม่เกิน ${maxLength} ตัวอักษร` };
  return { list };
}

/** True when `target` is reachable from `start` through prerequisite links (would form a cycle). */
async function reachesCourse(db: D1Database, start: string, target: string): Promise<boolean> {
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; depth < 20 && frontier.length; depth++) {
    // The frontier can exceed D1's 100 bound parameters, so it is passed as one JSON array.
    const rows = await db.prepare(`SELECT prerequisite_id FROM course_prerequisites WHERE course_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(frontier)).all<{ prerequisite_id: string }>();
    frontier = [];
    for (const { prerequisite_id } of rows.results) {
      if (prerequisite_id === target) return true;
      if (!seen.has(prerequisite_id)) { seen.add(prerequisite_id); frontier.push(prerequisite_id); }
    }
  }
  return false;
}

interface DetailsInput {
  subtitle?: unknown; learning_outcomes?: unknown; requirements?: unknown; target_audience?: unknown; level?: unknown;
  language?: unknown; duration_hours?: unknown; promo_video_url?: unknown; faq?: unknown; category_id?: unknown;
  sequential?: unknown; prerequisite_ids?: unknown;
}

/**
 * Update sales-page fields, category, "เรียนตามลำดับ" and prerequisite courses (partial).
 * PUT /api/instructor/courses/:id/details
 */
contentRouter.put("/instructor/courses/:id/details", rbac(["instructor", "admin"]), async (c) => {
  const courseId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;
  const owned = await ownedCourse(c, courseId);
  if ("error" in owned) return owned.error;
  const body = await c.req.json<DetailsInput>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);

  const set: Record<string, unknown> = {};
  const bad = (message: string) => c.json({ error: message }, 400);
  if (body.subtitle !== undefined) {
    if (body.subtitle !== null && typeof body.subtitle !== "string") return bad("คำโปรยไม่ถูกต้อง");
    const subtitle = (body.subtitle || "").trim();
    if (subtitle.length > 200) return bad("คำโปรยยาวได้ไม่เกิน 200 ตัวอักษร");
    set.subtitle = subtitle || null;
  }
  for (const [key, column, label] of [["learning_outcomes", "learning_outcomes_json", "สิ่งที่จะได้เรียนรู้"],
    ["requirements", "requirements_json", "ความรู้พื้นฐานที่ต้องมี"], ["target_audience", "target_audience_json", "กลุ่มเป้าหมาย"]] as const) {
    if (body[key] === undefined) continue;
    const parsed = stringList(body[key] ?? [], label);
    if ("error" in parsed) return bad(parsed.error);
    set[column] = parsed.list.length ? JSON.stringify(parsed.list) : null;
  }
  if (body.level !== undefined) {
    if (body.level !== null && body.level !== "" && !LEVELS.includes(body.level as string)) return bad("ระดับคอร์สไม่ถูกต้อง");
    set.level = body.level || null;
  }
  if (body.language !== undefined) {
    if (body.language !== null && typeof body.language !== "string") return bad("ภาษาไม่ถูกต้อง");
    const language = (body.language || "").trim();
    if (language.length > 40) return bad("ภาษายาวได้ไม่เกิน 40 ตัวอักษร");
    set.language = language || null;
  }
  if (body.duration_hours !== undefined) {
    if (body.duration_hours === null || body.duration_hours === "") set.duration_hours = null;
    else {
      const hours = Number(body.duration_hours);
      if (!Number.isFinite(hours) || hours < 0 || hours > 10000) return bad("ระยะเวลาเรียนต้องเป็นตัวเลข 0–10000 ชั่วโมง");
      set.duration_hours = Math.round(hours * 10) / 10;
    }
  }
  if (body.promo_video_url !== undefined) {
    const url = typeof body.promo_video_url === "string" ? body.promo_video_url.trim() : "";
    if (url && !embedSrc(url)) return bad("วิดีโอแนะนำคอร์สต้องเป็นลิงก์ YouTube, Vimeo หรือ Loom");
    set.promo_video_url = url || null;
  }
  if (body.faq !== undefined) {
    const faq = body.faq ?? [];
    if (!Array.isArray(faq) || faq.length > 30) return bad("คำถามที่พบบ่อยใส่ได้ไม่เกิน 30 ข้อ");
    const items: { question: string; answer: string }[] = [];
    for (const item of faq) {
      const question = typeof item?.question === "string" ? item.question.trim() : "";
      const answer = typeof item?.answer === "string" ? item.answer.trim() : "";
      if (!question && !answer) continue;
      if (!question || !answer || question.length > 300 || answer.length > 3000) return bad("คำถามที่พบบ่อยต้องมีทั้งคำถาม (≤300) และคำตอบ (≤3000 ตัวอักษร)");
      items.push({ question, answer });
    }
    set.faq_json = items.length ? JSON.stringify(items) : null;
  }
  if (body.category_id !== undefined) {
    if (body.category_id === null || body.category_id === "") set.category_id = null;
    else {
      const category = typeof body.category_id === "string"
        ? await db.prepare("SELECT id FROM course_categories WHERE id = ?").bind(body.category_id).first() : null;
      if (!category) return bad("ไม่พบหมวดหมู่ที่เลือก");
      set.category_id = body.category_id;
    }
  }
  if (body.sequential !== undefined) {
    if (typeof body.sequential !== "boolean") return bad("ค่าการเรียนตามลำดับไม่ถูกต้อง");
    set.sequential = body.sequential ? 1 : 0;
  }

  let prerequisites: string[] | null = null;
  if (body.prerequisite_ids !== undefined) {
    const ids = body.prerequisite_ids ?? [];
    if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== "string")) return bad("เลือกคอร์สที่ต้องเรียนก่อนได้ไม่เกิน 10 คอร์ส");
    prerequisites = [...new Set(ids as string[])];
    if (prerequisites.includes(courseId)) return bad("คอร์สเป็นเงื่อนไขของตัวเองไม่ได้");
    if (prerequisites.length) {
      const found = await db.prepare(`SELECT id, status, instructor_id FROM courses WHERE id IN (${prerequisites.map(() => "?").join(", ")})`)
        .bind(...prerequisites).all<{ id: string; status: string; instructor_id: string }>();
      if (found.results.length !== prerequisites.length) return bad("ไม่พบคอร์สที่ต้องเรียนก่อนบางคอร์ส");
      // Instructors may require published courses or their own; admins any course.
      if (!user.roles.includes("admin") && found.results.some(r => r.status !== "published" && r.instructor_id !== user.id))
        return bad("เลือกได้เฉพาะคอร์สที่เผยแพร่แล้วหรือคอร์สของคุณเอง");
      for (const id of prerequisites) {
        if (await reachesCourse(db, id, courseId)) return bad("เงื่อนไขคอร์สที่ต้องเรียนก่อนวนกลับมาที่คอร์สนี้");
      }
    }
  }
  if (!Object.keys(set).length && prerequisites === null) return bad("ไม่มีข้อมูลที่ต้องแก้ไข");

  try {
    const statements: D1PreparedStatement[] = [];
    const entries = Object.entries(set);
    if (entries.length) statements.push(db.prepare(`UPDATE courses SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .bind(...entries.map(([, v]) => v), courseId));
    if (prerequisites !== null) {
      statements.push(db.prepare("DELETE FROM course_prerequisites WHERE course_id = ?").bind(courseId));
      for (const id of prerequisites) statements.push(db.prepare("INSERT INTO course_prerequisites (course_id, prerequisite_id) VALUES (?, ?)").bind(courseId, id));
    }
    await db.batch(statements);
    return c.json({ message: "บันทึกรายละเอียดคอร์สแล้ว" });
  } catch (error) {
    console.error("Update course details failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะบันทึกรายละเอียดคอร์ส" }, 500);
  }
});

/** Instructor-facing lesson fields (no content bodies). */
function builderLesson(l: LessonRow) {
  return {
    id: l.id, title: l.title, type: l.type, section_id: l.section_id, sort_order: l.sort_order,
    video_stream_uid: l.video_stream_uid, video_provider: l.video_provider, handout_r2_key: l.handout_r2_key,
    pdf_r2_key: l.pdf_r2_key, embed_url: l.embed_url, scorm_launch: l.scorm_launch,
    has_text: !!(l.content_json || l.content_md),
    available_after_days: l.available_after_days, available_on: l.available_on
  };
}

/**
 * Everything the course builder edits: details, chapters, lessons in learner order, prerequisites,
 * category and prerequisite pickers.
 * GET /api/instructor/courses/:id/outline
 */
contentRouter.get("/instructor/courses/:id/outline", rbac(["instructor", "admin"]), async (c) => {
  const courseId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;
  try {
    const course = await db.prepare("SELECT * FROM courses WHERE id = ?").bind(courseId).first<Record<string, any>>();
    if (!course) return c.json({ error: "ไม่พบคอร์ส" }, 404);
    if (!user.roles.includes("admin") && course.instructor_id !== user.id && !(await canApproveCourses(c)))
      return c.json({ error: OWNER_ERROR }, 403);
    const [sections, lessons, prerequisites, categories, options] = await db.batch([
      db.prepare("SELECT id, title, sort_order FROM course_sections WHERE course_id = ? ORDER BY sort_order, id").bind(courseId),
      db.prepare(`SELECT l.* FROM lessons l LEFT JOIN course_sections s ON s.id = l.section_id WHERE l.course_id = ? ORDER BY ${LESSON_ORDER}`).bind(courseId),
      db.prepare(`SELECT co.id, co.title FROM course_prerequisites p JOIN courses co ON co.id = p.prerequisite_id
        WHERE p.course_id = ? ORDER BY co.title`).bind(courseId),
      db.prepare("SELECT id, name, slug FROM course_categories ORDER BY sort_order, name"),
      db.prepare(`SELECT id, title, status FROM courses WHERE id != ? AND (status = 'published' OR instructor_id = ?) ORDER BY title LIMIT 500`)
        .bind(courseId, course.instructor_id)
    ]);
    return c.json({
      course: {
        id: course.id, title: course.title, description: course.description, status: course.status, price: course.price,
        category_id: course.category_id ?? null, ...salesFields(course)
      },
      sections: sections.results,
      lessons: (lessons.results as unknown as LessonRow[]).map(builderLesson),
      prerequisites: prerequisites.results,
      categories: categories.results,
      prerequisite_options: options.results,
      embed_providers: EMBED_PROVIDERS
    });
  } catch (error) {
    console.error("Load course outline failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดโครงสร้างคอร์ส" }, 500);
  }
});

// ==========================================
// Chapters and ordering
// ==========================================

const sectionTitle = (value: unknown) => {
  const title = typeof value === "string" ? value.trim() : "";
  return title && title.length <= 200 ? title : null;
};

/**
 * POST /api/instructor/courses/:id/sections { title }
 */
contentRouter.post("/instructor/courses/:id/sections", rbac(["instructor", "admin"]), async (c) => {
  const courseId = c.req.param("id");
  const owned = await ownedCourse(c, courseId);
  if ("error" in owned) return owned.error;
  const { title } = await c.req.json<{ title?: unknown }>().catch(() => ({ title: undefined }));
  const clean = sectionTitle(title);
  if (!clean) return c.json({ error: "ชื่อบทต้องมี 1–200 ตัวอักษร" }, 400);
  try {
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), 0) AS max FROM course_sections WHERE course_id = ?")
      .bind(courseId).first<{ n: number; max: number }>();
    if ((count?.n ?? 0) >= 100) return c.json({ error: "คอร์สหนึ่งมีได้ไม่เกิน 100 บท" }, 400);
    const id = "sec_" + crypto.randomUUID().slice(0, 8);
    const order = (count?.max ?? 0) + 1;
    await c.env.DB.prepare("INSERT INTO course_sections (id, course_id, title, sort_order) VALUES (?, ?, ?, ?)").bind(id, courseId, clean, order).run();
    return c.json({ message: "เพิ่มบทแล้ว", section: { id, title: clean, sort_order: order } }, 201);
  } catch (error) {
    console.error("Create section failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะเพิ่มบท" }, 500);
  }
});

async function ownedSection(c: Context<Env>, sectionId: string) {
  const section = await c.env.DB.prepare(`SELECT s.id, s.course_id, co.instructor_id FROM course_sections s
    JOIN courses co ON co.id = s.course_id WHERE s.id = ?`).bind(sectionId).first<{ id: string; course_id: string; instructor_id: string }>();
  if (!section) return { error: c.json({ error: "ไม่พบบทนี้" }, 404) };
  const user = c.get("user");
  if (!user.roles.includes("admin") && section.instructor_id !== user.id) return { error: c.json({ error: OWNER_ERROR }, 403) };
  return { section };
}

/**
 * PATCH /api/instructor/sections/:id { title }
 */
contentRouter.patch("/instructor/sections/:id", rbac(["instructor", "admin"]), async (c) => {
  const owned = await ownedSection(c, c.req.param("id"));
  if ("error" in owned) return owned.error;
  const { title } = await c.req.json<{ title?: unknown }>().catch(() => ({ title: undefined }));
  const clean = sectionTitle(title);
  if (!clean) return c.json({ error: "ชื่อบทต้องมี 1–200 ตัวอักษร" }, 400);
  await c.env.DB.prepare("UPDATE course_sections SET title = ? WHERE id = ?").bind(clean, owned.section.id).run();
  return c.json({ message: "บันทึกชื่อบทแล้ว" });
});

/**
 * Delete a chapter; its lessons move out of the chapter (they are not deleted).
 * DELETE /api/instructor/sections/:id
 */
contentRouter.delete("/instructor/sections/:id", rbac(["instructor", "admin"]), async (c) => {
  const owned = await ownedSection(c, c.req.param("id"));
  if ("error" in owned) return owned.error;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE lessons SET section_id = NULL WHERE section_id = ?").bind(owned.section.id),
    c.env.DB.prepare("DELETE FROM course_sections WHERE id = ?").bind(owned.section.id)
  ]);
  return c.json({ message: "ลบบทแล้ว บทเรียนในบทนี้ย้ายไปอยู่นอกบท" });
});

/**
 * Save the whole order after drag & drop. Every chapter and lesson of the course must be listed once.
 * PUT /api/instructor/courses/:id/structure { unsectioned: [lessonId], sections: [{ id, lesson_ids: [lessonId] }] }
 */
contentRouter.put("/instructor/courses/:id/structure", rbac(["instructor", "admin"]), async (c) => {
  const courseId = c.req.param("id");
  const db = c.env.DB;
  const owned = await ownedCourse(c, courseId);
  if ("error" in owned) return owned.error;
  const body = await c.req.json<{ unsectioned?: unknown; sections?: unknown }>().catch(() => null);
  const unsectioned = Array.isArray(body?.unsectioned) ? body!.unsectioned as unknown[] : [];
  const sections = Array.isArray(body?.sections) ? body!.sections as { id?: unknown; lesson_ids?: unknown }[] : null;
  if (!sections || sections.some(s => typeof s?.id !== "string" || !Array.isArray(s.lesson_ids)))
    return c.json({ error: "รูปแบบโครงสร้างคอร์สไม่ถูกต้อง" }, 400);

  const [existingSections, existingLessons] = await db.batch([
    db.prepare("SELECT id FROM course_sections WHERE course_id = ?").bind(courseId),
    db.prepare("SELECT id FROM lessons WHERE course_id = ?").bind(courseId)
  ]);
  const sectionIds = new Set((existingSections.results as { id: string }[]).map(r => r.id));
  const lessonIds = new Set((existingLessons.results as { id: string }[]).map(r => r.id));
  const listedSections = sections.map(s => s.id as string);
  const listedLessons = [...unsectioned, ...sections.flatMap(s => s.lesson_ids as unknown[])];
  const sameSet = (listed: unknown[], actual: Set<string>) =>
    listed.length === actual.size && new Set(listed).size === listed.length && listed.every(id => typeof id === "string" && actual.has(id));
  if (!sameSet(listedSections, sectionIds) || !sameSet(listedLessons, lessonIds))
    return c.json({ error: "โครงสร้างไม่ตรงกับบทและบทเรียนของคอร์สนี้ กรุณารีเฟรชหน้าแล้วลองใหม่" }, 409);

  try {
    const statements: D1PreparedStatement[] = [];
    sections.forEach((s, i) => statements.push(db.prepare("UPDATE course_sections SET sort_order = ? WHERE id = ?").bind(i + 1, s.id)));
    let order = 1;
    for (const id of unsectioned) statements.push(db.prepare("UPDATE lessons SET section_id = NULL, sort_order = ? WHERE id = ?").bind(order++, id));
    for (const s of sections) {
      for (const id of s.lesson_ids as string[]) statements.push(db.prepare("UPDATE lessons SET section_id = ?, sort_order = ? WHERE id = ?").bind(s.id, order++, id));
    }
    if (statements.length) await db.batch(statements);
    return c.json({ message: "บันทึกลำดับบทเรียนแล้ว" });
  } catch (error) {
    console.error("Save course structure failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะบันทึกลำดับบทเรียน" }, 500);
  }
});

// ==========================================
// Lessons: types, content and drip
// ==========================================

interface LessonInput {
  title?: unknown; type?: unknown; section_id?: unknown; content_json?: unknown; content_md?: unknown; pdf_r2_key?: unknown;
  embed_url?: unknown; video_stream_uid?: unknown; video_provider?: unknown; handout_r2_key?: unknown;
  available_after_days?: unknown; available_on?: unknown;
}

/** A PDF key the user may attach: their own upload (or one already used in their own lessons); admins any. */
async function checkPdfKey(c: Context<Env>, key: string): Promise<string | null> {
  const user = c.get("user");
  if (!user.roles.includes("admin") && !key.startsWith(`uploads/${user.id}/`)) {
    const reused = await c.env.DB.prepare(`SELECT 1 FROM lessons l JOIN courses co ON co.id = l.course_id
      WHERE (l.pdf_r2_key = ? OR l.handout_r2_key = ?) AND co.instructor_id = ? LIMIT 1`).bind(key, key, user.id).first();
    if (!reused) return "ไฟล์ PDF ต้องอัปโหลดผ่านระบบด้วยบัญชีของคุณ";
  }
  const head = await c.env.ASSETS.head(key);
  if (!head) return "ไม่พบไฟล์ PDF ที่อัปโหลด กรุณาอัปโหลดใหม่";
  if (head.size > PDF_LIMIT) return "ไฟล์ PDF ต้องมีขนาดไม่เกิน 50MB";
  if ((head.httpMetadata?.contentType || "application/pdf") !== "application/pdf") return "ไฟล์ต้องเป็น PDF";
  return null;
}

/**
 * Validates lesson fields into column values. `current` is the lesson being edited (null on create).
 * Type-specific content is only required once the lesson is learner-visible content of that type.
 */
async function lessonValues(c: Context<Env>, body: LessonInput, courseId: string, current: LessonRow | null):
  Promise<{ values: Record<string, unknown> } | { error: string; status?: 400 | 403 }> {
  const values: Record<string, unknown> = {};
  if (body.title !== undefined || !current) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) return { error: "ชื่อบทเรียนต้องมี 1–200 ตัวอักษร" };
    values.title = title;
  }
  const type = body.type !== undefined ? body.type : current?.type ?? "video";
  if (!isLessonType(type)) return { error: "ประเภทบทเรียนต้องเป็น video, text, pdf, embed หรือ scorm" };
  if (body.type !== undefined || !current) values.type = type;

  if (body.section_id !== undefined) {
    if (body.section_id === null || body.section_id === "") values.section_id = null;
    else {
      const section = typeof body.section_id === "string"
        ? await c.env.DB.prepare("SELECT id FROM course_sections WHERE id = ? AND course_id = ?").bind(body.section_id, courseId).first() : null;
      if (!section) return { error: "ไม่พบบทที่เลือกในคอร์สนี้" };
      values.section_id = body.section_id;
    }
  }

  if (body.content_json !== undefined) {
    if (body.content_json === null || body.content_json === "") values.content_json = null;
    else {
      const raw = typeof body.content_json === "string" ? body.content_json : JSON.stringify(body.content_json);
      if (raw.length > 500_000) return { error: "เนื้อหาบทเรียนยาวเกิน 500KB" };
      let doc: unknown;
      try { doc = JSON.parse(raw); } catch { return { error: "รูปแบบเนื้อหาบทเรียนไม่ถูกต้อง" }; }
      if (!Array.isArray(doc)) return { error: "รูปแบบเนื้อหาบทเรียนไม่ถูกต้อง" };
      values.content_json = raw;
    }
  }
  if (body.content_md !== undefined) {
    if (body.content_md !== null && typeof body.content_md !== "string") return { error: "เนื้อหา Markdown ไม่ถูกต้อง" };
    if ((body.content_md || "").length > 200_000) return { error: "เนื้อหาบทเรียนยาวเกิน 200KB" };
    values.content_md = body.content_md || null;
  }
  if (body.embed_url !== undefined) {
    const url = typeof body.embed_url === "string" ? body.embed_url.trim() : "";
    if (url && !embedSrc(url)) return { error: `ฝังได้เฉพาะลิงก์ https จาก ${EMBED_PROVIDERS}` };
    values.embed_url = url || null;
  }
  if (body.pdf_r2_key !== undefined) {
    const key = typeof body.pdf_r2_key === "string" ? body.pdf_r2_key.trim() : "";
    if (key && key !== current?.pdf_r2_key) {
      const problem = await checkPdfKey(c, key);
      if (problem) return { error: problem, status: 403 };
    }
    values.pdf_r2_key = key || null;
  }
  if (body.video_stream_uid !== undefined || body.video_provider !== undefined || body.handout_r2_key !== undefined) {
    const provider = body.video_provider !== undefined ? body.video_provider : current?.video_provider ?? "cloudflare";
    if (!["cloudflare", "youtube", "vimeo"].includes(provider as string)) return { error: "แหล่งวิดีโอไม่ถูกต้อง" };
    const uid = body.video_stream_uid !== undefined ? (typeof body.video_stream_uid === "string" ? body.video_stream_uid.trim() : "") : current?.video_stream_uid ?? "";
    const handout = body.handout_r2_key !== undefined ? (typeof body.handout_r2_key === "string" ? body.handout_r2_key.trim() : "") : current?.handout_r2_key ?? "";
    const problem = await checkLessonAssets(c,
      handout && handout !== current?.handout_r2_key ? handout : null,
      uid && (uid !== current?.video_stream_uid || provider !== current?.video_provider) ? uid : null, provider as string);
    if (problem) return { error: problem, status: 403 };
    values.video_stream_uid = uid || null;
    values.video_provider = provider;
    values.handout_r2_key = handout || null;
  }

  if (body.available_after_days !== undefined) {
    if (body.available_after_days === null || body.available_after_days === "" || body.available_after_days === 0) values.available_after_days = null;
    else {
      const days = Number(body.available_after_days);
      if (!Number.isInteger(days) || days < 0 || days > 3650) return { error: "จำนวนวันหลังลงทะเบียนต้องเป็นจำนวนเต็ม 0–3650" };
      values.available_after_days = days;
    }
  }
  if (body.available_on !== undefined) {
    if (body.available_on === null || body.available_on === "") values.available_on = null;
    else {
      const date = typeof body.available_on === "string" ? body.available_on.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { error: "วันที่เปิดบทเรียนต้องอยู่ในรูปแบบ YYYY-MM-DD" };
      values.available_on = date;
    }
  }

  // Content each type needs (checked against the merged result)
  const merged = { ...(current ?? {}), ...values } as Partial<LessonRow>;
  if (type === "video" && !merged.video_stream_uid) return { error: "บทเรียนวิดีโอต้องระบุวิดีโอ" };
  if (type === "embed" && !merged.embed_url) return { error: "บทเรียนแบบฝังเนื้อหาต้องระบุลิงก์" };
  if (type === "pdf" && !merged.pdf_r2_key) return { error: "บทเรียน PDF ต้องอัปโหลดไฟล์ PDF" };
  return { values };
}

/**
 * Add a lesson of any type to a course (SCORM: create, then PUT /instructor/lessons/:id/scorm).
 * POST /api/instructor/courses/:id/lessons { title, type, section_id?, ...content, available_after_days?, available_on? }
 */
contentRouter.post("/instructor/courses/:id/lessons", rbac(["instructor", "admin"]), async (c) => {
  const courseId = c.req.param("id");
  const db = c.env.DB;
  const owned = await ownedCourse(c, courseId);
  if ("error" in owned) return owned.error;
  const body = await c.req.json<LessonInput>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  try {
    const parsed = await lessonValues(c, body, courseId, null);
    if ("error" in parsed) return c.json({ error: parsed.error }, parsed.status ?? 400);
    const count = await db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), 0) AS max FROM lessons WHERE course_id = ?")
      .bind(courseId).first<{ n: number; max: number }>();
    if ((count?.n ?? 0) >= 500) return c.json({ error: "คอร์สหนึ่งมีบทเรียนได้ไม่เกิน 500 บท" }, 400);
    const id = "lesson_" + crypto.randomUUID().substring(0, 8);
    const values = { id, course_id: courseId, sort_order: (count?.max ?? 0) + 1, ...parsed.values };
    const entries = Object.entries(values);
    await db.prepare(`INSERT INTO lessons (${entries.map(([k]) => k).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`)
      .bind(...entries.map(([, v]) => v)).run();
    const lesson = await db.prepare("SELECT * FROM lessons WHERE id = ?").bind(id).first<LessonRow>();
    return c.json({ message: "เพิ่มบทเรียนเรียบร้อยแล้ว", lesson: builderLesson(lesson!) }, 201);
  } catch (error) {
    console.error("Create typed lesson failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะเพิ่มบทเรียน" }, 500);
  }
});

/**
 * Lesson content for the builder editor (text body, PDF/embed/SCORM settings).
 * GET /api/instructor/lessons/:id/content
 */
contentRouter.get("/instructor/lessons/:id/content", rbac(["instructor", "admin"]), async (c) => {
  const owned = await ownedLesson(c, c.req.param("id"));
  if ("error" in owned) return owned.error;
  const l = owned.lesson;
  return c.json({ lesson: { ...builderLesson(l), content_json: l.content_json, content_md: l.content_md, embed_src: l.embed_url ? embedSrc(l.embed_url) : null } });
});

/**
 * Update lesson type, chapter, content and drip settings (partial).
 * PATCH /api/instructor/lessons/:id/settings
 */
contentRouter.patch("/instructor/lessons/:id/settings", rbac(["instructor", "admin"]), async (c) => {
  const owned = await ownedLesson(c, c.req.param("id"));
  if ("error" in owned) return owned.error;
  const body = await c.req.json<LessonInput>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  try {
    const parsed = await lessonValues(c, body, owned.lesson.course_id, owned.lesson);
    if ("error" in parsed) return c.json({ error: parsed.error }, parsed.status ?? 400);
    const entries = Object.entries(parsed.values);
    if (!entries.length) return c.json({ error: "ไม่มีข้อมูลที่ต้องแก้ไข" }, 400);
    await c.env.DB.prepare(`UPDATE lessons SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .bind(...entries.map(([, v]) => v), owned.lesson.id).run();
    const lesson = await c.env.DB.prepare("SELECT * FROM lessons WHERE id = ?").bind(owned.lesson.id).first<LessonRow>();
    return c.json({ message: "บันทึกบทเรียนแล้ว", lesson: builderLesson(lesson!) });
  } catch (error) {
    console.error("Update lesson settings failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ขณะบันทึกบทเรียน" }, 500);
  }
});

// ==========================================
// Learner: lesson content, mark complete, PDF viewer
// ==========================================

/** Lesson + access decision for learner endpoints: staff, or enrolled with an unlocked lesson. */
async function learnerLesson(c: Context<Env>, lessonId: string): Promise<{ lesson: LessonRow & { instructor_id: string }; staff: boolean; enrolled: boolean } | { error: Response }> {
  const user = c.get("user");
  const db = c.env.DB;
  const lesson = await db.prepare("SELECT l.*, co.instructor_id FROM lessons l JOIN courses co ON co.id = l.course_id WHERE l.id = ?")
    .bind(lessonId).first<LessonRow & { instructor_id: string }>();
  if (!lesson) return { error: c.json({ error: "ไม่พบบทเรียนนี้" }, 404) };
  const staff = await isCourseStaff(c, lesson.instructor_id);
  const enrolled = !!(await activeEnrollmentId(db, user.id, lesson.course_id));
  if (!staff && !enrolled) return { error: c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ต้องลงทะเบียนเรียนคอร์สนี้ก่อน หรือสิทธิ์เข้าถึงหมดอายุแล้ว" }, 403) };
  const locked = await lessonLockResponse(c, lessonId);
  if (locked) return { error: locked };
  return { lesson, staff, enrolled };
}

/**
 * Lesson content for the player (text body, embed src, PDF/SCORM availability).
 * GET /api/student/lessons/:id/content
 */
contentRouter.get("/student/lessons/:id/content", rbac(), async (c) => {
  const user = c.get("user");
  try {
    const found = await learnerLesson(c, c.req.param("id"));
    if ("error" in found) return found.error;
    const l = found.lesson;
    const progress = await c.env.DB.prepare("SELECT completed FROM lesson_progress WHERE user_id = ? AND lesson_id = ?")
      .bind(user.id, l.id).first<{ completed: number }>();
    if (found.enrolled) await trackEvent(c.env.DB, user.id, "lesson_view", { courseId: l.course_id, lessonId: l.id, data: { type: l.type } });
    return c.json({
      lesson: { id: l.id, course_id: l.course_id, title: l.title, type: l.type, section_id: l.section_id },
      completed: !!progress?.completed,
      content_json: l.type === "text" ? l.content_json : null,
      content_md: l.type === "text" ? l.content_md : null,
      embed_src: l.type === "embed" && l.embed_url ? embedSrc(l.embed_url) : null,
      has_pdf: l.type === "pdf" && !!l.pdf_r2_key,
      has_scorm: l.type === "scorm" && !!l.scorm_base,
      has_handout: !!l.handout_r2_key,
      preview: found.staff && !found.enrolled
    });
  } catch (error) {
    console.error("Load lesson content failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดบทเรียน" }, 500);
  }
});

/**
 * "ทำเครื่องหมายว่าเรียนแล้ว" for text, PDF and embed lessons (video uses playback progress,
 * SCORM completes from the package).
 * POST /api/student/lessons/:id/complete
 */
contentRouter.post("/student/lessons/:id/complete", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  try {
    const found = await learnerLesson(c, c.req.param("id"));
    if ("error" in found) return found.error;
    if (!found.enrolled) return c.json({ error: "ต้องมีการลงทะเบียนเรียนที่ใช้งานอยู่" }, 403);
    const l = found.lesson;
    if (!["text", "pdf", "embed"].includes(l.type))
      return c.json({ error: l.type === "scorm" ? "บทเรียน SCORM จะบันทึกว่าเรียนจบเมื่อทำแบบฝึกในบทเรียนเสร็จ" : "บทเรียนวิดีโอบันทึกว่าเรียนจบเมื่อดูวิดีโอจนจบ" }, 400);
    const result = await completeLesson(c.env.DB, user.id, l.id, l.course_id);
    return c.json({ message: "บันทึกว่าเรียนบทนี้แล้ว", completed: 1, progress_percent: result.progress_percent });
  } catch (error) {
    console.error("Complete lesson failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะบันทึกความคืบหน้า" }, 500);
  }
});

/**
 * PDF lesson file, streamed inline for the in-browser viewer (fetch with the Bearer token; no R2 URL).
 * GET /api/student/lessons/:id/pdf
 */
contentRouter.get("/student/lessons/:id/pdf", rbac(), async (c) => {
  try {
    const found = await learnerLesson(c, c.req.param("id"));
    if ("error" in found) return found.error;
    const l = found.lesson;
    if (l.type !== "pdf" || !l.pdf_r2_key) return c.json({ error: "บทเรียนนี้ไม่มีไฟล์ PDF" }, 404);
    const object = await c.env.ASSETS.get(l.pdf_r2_key);
    if (!object) return c.json({ error: "ไม่พบไฟล์ PDF ในที่เก็บข้อมูล" }, 404);
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", 'inline; filename="lesson.pdf"');
    c.header("Content-Length", String(object.size));
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(object.body);
  } catch (error) {
    console.error("Stream lesson PDF failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดไฟล์ PDF" }, 500);
  }
});

// ==========================================
// Public course overview (sales page data)
// ==========================================

/**
 * Published course with sales-page fields and the curriculum outline (titles only). Sign-in optional.
 * GET /api/courses/:id/overview
 */
contentRouter.get("/courses/:id/overview", async (c) => {
  const courseId = c.req.param("id");
  const db = c.env.DB;
  const auth = c.req.header("Authorization");
  let userId: string | null = null;
  if (auth?.startsWith("Bearer ")) {
    try { userId = await verifiedTokenUserId(c.env, auth.substring(7).trim()); } catch { userId = null; }
  }
  try {
    const course = await db.prepare(`SELECT co.*, u.name AS instructor_name, cat.name AS category_name, cat.slug AS category_slug,
        (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = co.id) AS enrollment_count
      FROM courses co LEFT JOIN users u ON u.id = co.instructor_id LEFT JOIN course_categories cat ON cat.id = co.category_id
      WHERE co.id = ? AND co.status = 'published'`).bind(courseId).first<Record<string, any>>();
    if (!course) return c.json({ error: "ไม่พบคอร์สนี้" }, 404);
    const [sections, lessons, prerequisites] = await db.batch([
      db.prepare("SELECT id, title FROM course_sections WHERE course_id = ? ORDER BY sort_order, id").bind(courseId),
      db.prepare(`SELECT l.id, l.title, l.type, l.section_id, l.available_after_days, l.available_on FROM lessons l
        LEFT JOIN course_sections s ON s.id = l.section_id WHERE l.course_id = ? ORDER BY ${LESSON_ORDER}`).bind(courseId),
      db.prepare(`SELECT co.id, co.title FROM course_prerequisites p JOIN courses co ON co.id = p.prerequisite_id
        WHERE p.course_id = ? ORDER BY co.title`).bind(courseId)
    ]);
    const lessonRows = lessons.results as { id: string; title: string; type: string; section_id: string | null; available_after_days: number | null; available_on: string | null }[];
    const pick = ({ id, title, type, available_after_days, available_on }: typeof lessonRows[number]) => ({ id, title, type, available_after_days, available_on });
    const loose = lessonRows.filter(l => !l.section_id);
    const curriculum = [
      ...(loose.length ? [{ id: null, title: null, lessons: loose.map(pick) }] : []),
      ...(sections.results as { id: string; title: string }[]).map(s => ({ id: s.id, title: s.title, lessons: lessonRows.filter(l => l.section_id === s.id).map(pick) }))
    ];
    await trackEvent(db, userId, "course_view", { courseId, data: { source: "overview" } });
    return c.json({
      course: {
        id: course.id, title: course.title, description: course.description, price: course.price,
        cover_image_url: course.cover_image_url, access_duration_days: course.access_duration_days, published_at: course.published_at,
        ...salesFields(course),
        category: course.category_id ? { id: course.category_id, name: course.category_name, slug: course.category_slug } : null,
        instructor: { id: course.instructor_id, name: course.instructor_name },
        lesson_count: lessonRows.length, section_count: sections.results.length, enrollment_count: course.enrollment_count
      },
      curriculum,
      prerequisites: prerequisites.results
    });
  } catch (error) {
    console.error("Course overview failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะโหลดข้อมูลคอร์ส" }, 500);
  }
});
