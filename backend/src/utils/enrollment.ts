import { trackEvent } from "./events";

/**
 * Enrolls a learner (by user_id or email) in a published course. Shared by POST /v1/enrollments and
 * the grant_enrollment agent tool. Idempotent: one enrollment per learner and course (UNIQUE index);
 * an existing suspended enrollment is re-activated and a later expiry extends the current one.
 */
export interface EnrollmentInput { course_id: string; user_id: string | null; email: string | null; expires_at: string | null }

export const ENROLLMENT_FIELDS = "e.id, e.user_id, e.course_id, e.status, e.progress_percent, e.enrolled_at, e.completed_at, e.expires_at, e.partner_id";

export function parseEnrollmentInput(body: Record<string, unknown> | null): EnrollmentInput | { error: string } {
  const courseId = typeof body?.course_id === "string" ? body.course_id.trim() : "";
  const userId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!courseId || (!userId && !email) || courseId.length > 100 || userId.length > 100 || email.length > 254) {
    return { error: "ต้องระบุ course_id และ user_id หรือ email" };
  }
  let expiresAt: string | null = null;
  if (body?.expires_at != null) {
    const ms = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (!Number.isFinite(ms) || ms < Date.now()) return { error: "expires_at ต้องเป็นวันเวลา ISO ในอนาคต" };
    expiresAt = new Date(ms).toISOString();
  }
  return { course_id: courseId, user_id: userId || null, email: email || null, expires_at: expiresAt };
}

type Failure = { error: string; code: string; status: 404 | 422 };

/** Checks the course and learner without changing anything (also the dry-run of grant_enrollment). */
export async function checkEnrollment(db: D1Database, input: EnrollmentInput): Promise<Failure | {
  course: { id: string; title: string; access_duration_days: number | null };
  user: { id: string; name: string; email: string };
  existing: { id: string; status: string; expires_at: string | null } | null;
}> {
  const course = await db.prepare("SELECT id, title, status, access_duration_days FROM courses WHERE id = ?").bind(input.course_id)
    .first<{ id: string; title: string; status: string; access_duration_days: number | null }>();
  if (!course) return { error: "ไม่พบคอร์ส", code: "not_found", status: 404 };
  if (course.status !== "published") return { error: "ลงทะเบียนได้เฉพาะคอร์สที่เผยแพร่แล้ว", code: "course_not_published", status: 422 };
  const user = await db.prepare(`SELECT id, name, email, status FROM users WHERE ${input.user_id ? "id" : "email"} = ?`).bind(input.user_id || input.email)
    .first<{ id: string; name: string; email: string; status: string }>();
  if (!user) return { error: "ไม่พบผู้ใช้", code: "not_found", status: 404 };
  if (user.status !== "active") return { error: "บัญชีผู้ใช้นี้ถูกระงับ", code: "user_suspended", status: 422 };
  const existing = await db.prepare("SELECT id, status, expires_at FROM enrollments WHERE user_id = ? AND course_id = ?").bind(user.id, course.id)
    .first<{ id: string; status: string; expires_at: string | null }>();
  return { course, user: { id: user.id, name: user.name, email: user.email }, existing };
}

export async function enrollLearner(db: D1Database, input: EnrollmentInput, source: Record<string, unknown>): Promise<Failure | { enrollment: unknown; created: boolean }> {
  const checked = await checkEnrollment(db, input);
  if ("error" in checked) return checked;
  const { course, user, existing } = checked;
  let expiresAt = input.expires_at;
  if (!expiresAt && course.access_duration_days) expiresAt = new Date(Date.now() + course.access_duration_days * 86_400_000).toISOString();
  await db.prepare(`INSERT INTO enrollments (id, user_id, course_id, progress_percent, status, expires_at, partner_id)
      VALUES (?, ?, ?, 0, 'active', ?, NULL)
      ON CONFLICT(user_id, course_id) DO UPDATE SET
        status = CASE WHEN enrollments.status = 'suspended' THEN 'active' ELSE enrollments.status END,
        expires_at = CASE WHEN excluded.expires_at IS NOT NULL AND (enrollments.expires_at IS NULL OR enrollments.expires_at < excluded.expires_at)
          THEN excluded.expires_at ELSE enrollments.expires_at END`)
    .bind("enr_" + crypto.randomUUID(), user.id, course.id, expiresAt).run();
  if (!existing) await trackEvent(db, user.id, "enroll", { courseId: course.id, data: source });
  const enrollment = await db.prepare(`SELECT ${ENROLLMENT_FIELDS} FROM enrollments e WHERE e.user_id = ? AND e.course_id = ?`).bind(user.id, course.id).first();
  return { enrollment, created: !existing };
}
