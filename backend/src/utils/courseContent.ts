import { Context } from "hono";
import { Env, UserPayload } from "../middleware/rbac";
import { currentPermissions } from "./permissions";
import { trackEvent } from "./events";

/**
 * Shared course-structure rules: lesson order (chapters first), drip/sequential locks, prerequisite
 * courses and lesson completion bookkeeping. Used by courses.ts, content.ts, scorm.ts and student.ts;
 * the commerce stream calls checkCoursePrerequisites before creating orders.
 */

export const LESSON_TYPES = ["video", "text", "pdf", "embed", "scorm"] as const;
export type LessonType = typeof LESSON_TYPES[number];
export const isLessonType = (value: unknown): value is LessonType =>
  typeof value === "string" && (LESSON_TYPES as readonly string[]).includes(value);

/**
 * Learner order of a course's lessons: lessons outside any chapter first, then chapters by their
 * sort order, lessons by sort order inside each. Use as `ORDER BY ${LESSON_ORDER}` with
 * `LEFT JOIN course_sections s ON s.id = l.section_id`.
 */
export const LESSON_ORDER = "CASE WHEN s.id IS NULL THEN 0 ELSE 1 END, s.sort_order, s.id, l.sort_order, l.id";

export type LockReason = "date" | "drip" | "sequence";
export interface LessonGate { locked: boolean; reason: LockReason | null; unlock_at: string | null }
export const OPEN_GATE: LessonGate = { locked: false, reason: null, unlock_at: null };

interface GateLesson { id: string; available_after_days: number | null; available_on: string | null; completed: number }

/** D1 CURRENT_TIMESTAMP values are UTC without a zone marker. */
const parseUtc = (value: string) => Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");

/** "YYYY-MM-DD" unlock dates open at midnight Bangkok time. */
export const unlockDateMs = (date: string) => Date.parse(`${date}T00:00:00+07:00`);

/**
 * Lock state per lesson for one learner. Date and drip locks wait for time; "เรียนตามลำดับ" locks a
 * lesson until the lesson before it is complete (a locked lesson cannot be completed, so the chain holds).
 */
export function computeGates(lessons: GateLesson[], sequential: boolean, enrolledAt: string | null, now = Date.now()): Map<string, LessonGate> {
  const gates = new Map<string, LessonGate>();
  const enrolledMs = enrolledAt ? parseUtc(enrolledAt) : NaN;
  let previousDone = true;
  for (const lesson of lessons) {
    let unlockMs = 0;
    let reason: LockReason | null = null;
    if (lesson.available_on) {
      const at = unlockDateMs(lesson.available_on);
      if (Number.isFinite(at) && at > now) { unlockMs = at; reason = "date"; }
    }
    if (lesson.available_after_days && lesson.available_after_days > 0 && Number.isFinite(enrolledMs)) {
      const at = enrolledMs + lesson.available_after_days * 86_400_000;
      if (at > now && at > unlockMs) { unlockMs = at; reason = "drip"; }
    }
    if (reason) {
      gates.set(lesson.id, { locked: true, reason, unlock_at: new Date(unlockMs).toISOString() });
    } else if (sequential && !previousDone && !lesson.completed) {
      gates.set(lesson.id, { locked: true, reason: "sequence", unlock_at: null });
    } else {
      gates.set(lesson.id, OPEN_GATE);
    }
    previousDone = !!lesson.completed;
  }
  return gates;
}

/** Lock state and completion of every lesson in a course for `userId`, in learner order. */
export async function courseLessonGates(db: D1Database, userId: string, courseId: string): Promise<{ gates: Map<string, LessonGate>; completed: Set<string> }> {
  const course = await db.prepare(`SELECT co.sequential, e.enrolled_at FROM courses co
    LEFT JOIN enrollments e ON e.course_id = co.id AND e.user_id = ? WHERE co.id = ?`)
    .bind(userId, courseId).first<{ sequential: number; enrolled_at: string | null }>();
  const lessons = await db.prepare(`SELECT l.id, l.available_after_days, l.available_on, COALESCE(lp.completed, 0) AS completed
    FROM lessons l LEFT JOIN course_sections s ON s.id = l.section_id
    LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ?
    WHERE l.course_id = ? ORDER BY ${LESSON_ORDER}`).bind(userId, courseId).all<GateLesson>();
  return {
    gates: computeGates(lessons.results, !!course?.sequential, course?.enrolled_at ?? null),
    completed: new Set(lessons.results.filter(l => l.completed).map(l => l.id))
  };
}

/** Course owner (as instructor), admins and course approvers see every lesson without locks. */
export async function isCourseStaff(c: Context<Env>, instructorId: string): Promise<boolean> {
  const user = c.get("user");
  if (user.roles.includes("admin")) return true;
  if (user.roles.includes("instructor") && instructorId === user.id) return true;
  return (await currentPermissions(c)).has("courses.approve");
}

function formatUnlock(iso: string): string {
  try {
    return new Date(iso).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export function lockMessage(gate: LessonGate): string {
  if (gate.reason === "sequence") return "บทเรียนนี้ยังล็อกอยู่ ต้องเรียนบทเรียนก่อนหน้าให้จบก่อน";
  return `บทเรียนนี้ยังไม่เปิดให้เรียน จะเปิดเมื่อ ${formatUnlock(gate.unlock_at!)}`;
}

/**
 * Server-side lock check for lesson content endpoints. Returns a 403 response for a locked lesson,
 * or null when the user may open it (staff always may). Enrollment is checked by the caller.
 */
export async function lessonLockResponse(c: Context<Env>, lessonId: string): Promise<Response | null> {
  const user = c.get("user");
  const lesson = await c.env.DB.prepare(`SELECT l.course_id, co.instructor_id FROM lessons l
    JOIN courses co ON co.id = l.course_id WHERE l.id = ?`).bind(lessonId).first<{ course_id: string; instructor_id: string }>();
  if (!lesson || await isCourseStaff(c, lesson.instructor_id)) return null;
  const gate = await lessonGateFor(c.env.DB, user, lessonId, lesson.course_id);
  return gate.locked ? c.json({ error: lockMessage(gate), locked: true, lock_reason: gate.reason, unlock_at: gate.unlock_at }, 403) : null;
}

export async function lessonGateFor(db: D1Database, user: Pick<UserPayload, "id">, lessonId: string, courseId: string): Promise<LessonGate> {
  const { gates } = await courseLessonGates(db, user.id, courseId);
  return gates.get(lessonId) ?? OPEN_GATE;
}

// ---------- Prerequisite courses ----------

export interface PrerequisiteCheck { ok: boolean; missing: { id: string; title: string }[] }

/**
 * Courses the learner must complete before enrolling in or ordering `courseId`. A prerequisite counts
 * as done when its enrollment is completed. Call before every self-service enrollment or order.
 */
export async function checkCoursePrerequisites(db: D1Database, userId: string, courseId: string): Promise<PrerequisiteCheck> {
  const rows = await db.prepare(`SELECT p.prerequisite_id AS id, co.title FROM course_prerequisites p
    JOIN courses co ON co.id = p.prerequisite_id
    WHERE p.course_id = ? AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = ? AND e.course_id = p.prerequisite_id
      AND (e.status = 'completed' OR e.completed_at IS NOT NULL))
    ORDER BY co.title`).bind(courseId, userId).all<{ id: string; title: string }>();
  return { ok: rows.results.length === 0, missing: rows.results };
}

export function prerequisiteMessage(missing: { title: string }[]): string {
  return `ต้องเรียนคอร์ส ${missing.map(m => `"${m.title}"`).join(", ")} ให้จบก่อนจึงจะลงทะเบียนคอร์สนี้ได้`;
}

// ---------- Completion bookkeeping ----------

export interface CompletionState { lesson: boolean; course: boolean }

export async function completionState(db: D1Database, userId: string, lessonId: string, courseId: string): Promise<CompletionState> {
  const row = await db.prepare(`SELECT
      (SELECT completed FROM lesson_progress WHERE user_id = ? AND lesson_id = ?) AS lesson_done,
      (SELECT status FROM enrollments WHERE user_id = ? AND course_id = ?) AS status`)
    .bind(userId, lessonId, userId, courseId).first<{ lesson_done: number | null; status: string | null }>();
  return { lesson: !!row?.lesson_done, course: row?.status === "completed" };
}

/** lesson_complete / course_complete events for a progress save that changed completion. */
export async function trackCompletionChange(db: D1Database, userId: string, courseId: string, lessonId: string,
  before: CompletionState, lessonCompleted: boolean, progressPercent: number): Promise<void> {
  if (lessonCompleted && !before.lesson) await trackEvent(db, userId, "lesson_complete", { courseId, lessonId });
  if (progressPercent === 100 && !before.course) await trackEvent(db, userId, "course_complete", { courseId });
}

/** Recomputes enrollments.progress_percent from completed lessons (same rule as student.ts). */
export async function syncEnrollmentProgress(db: D1Database, userId: string, courseId: string): Promise<number> {
  const counts = await db.prepare(`SELECT COUNT(*) AS total, COUNT(lp.lesson_id) AS completed
    FROM lessons l LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ? AND lp.completed = 1
    WHERE l.course_id = ?`).bind(userId, courseId).first<{ total: number; completed: number }>();
  const percent = counts?.total ? Math.floor((counts.completed / counts.total) * 100) : 0;
  await db.prepare(`UPDATE enrollments SET progress_percent = ?,
      completed_at = CASE WHEN ? = 100 THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END,
      status = CASE WHEN ? = 100 THEN 'completed' ELSE 'active' END
    WHERE user_id = ? AND course_id = ? AND status IN ('active', 'completed')`)
    .bind(percent, percent, percent, userId, courseId).run();
  return percent;
}

/** Marks a lesson complete for an enrolled learner (keeps the video resume position). */
export async function completeLesson(db: D1Database, userId: string, lessonId: string, courseId: string): Promise<{ progress_percent: number; newly_completed: boolean }> {
  const before = await completionState(db, userId, lessonId, courseId);
  await db.prepare(`INSERT INTO lesson_progress (user_id, lesson_id, course_id, resume_seconds, completed) VALUES (?, ?, ?, 0, 1)
    ON CONFLICT(user_id, lesson_id) DO UPDATE SET completed = 1, updated_at = CURRENT_TIMESTAMP`)
    .bind(userId, lessonId, courseId).run();
  const percent = await syncEnrollmentProgress(db, userId, courseId);
  await trackCompletionChange(db, userId, courseId, lessonId, before, true, percent);
  return { progress_percent: percent, newly_completed: !before.lesson };
}

/** Active, unexpired enrollment id for a learner, or null. */
export async function activeEnrollmentId(db: D1Database, userId: string, courseId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT id FROM enrollments WHERE user_id = ? AND course_id = ? AND status IN ('active', 'completed')
    AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`).bind(userId, courseId).first<{ id: string }>();
  return row?.id ?? null;
}

// ---------- JSON list fields (sales page) ----------

/** Parses a stored JSON array, returning [] for anything else. */
export function jsonList<T = unknown>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
