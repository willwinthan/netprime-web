/**
 * Learner/user activity log (table user_events): powers the events log, online users, reports and
 * outgoing webhooks. Never throws — tracking must not break the request that triggered it.
 */
export type EventType =
  | "login" | "signup" | "course_view" | "lesson_view" | "lesson_complete" | "course_complete"
  | "enroll" | "order_created" | "order_paid" | "quiz_submit" | "exam_submit" | "assignment_submit"
  | "certificate_issued" | "post_created" | "heartbeat" | (string & {});

export interface TrackOptions { courseId?: string | null; lessonId?: string | null; data?: unknown }

type EventListener = (db: D1Database, userId: string | null, type: EventType, options: TrackOptions) => Promise<void>;
const listeners: EventListener[] = [];

/** Lets other modules (e.g. webhooks) react to tracked events. */
export function onEvent(listener: EventListener) {
  listeners.push(listener);
}

export async function trackEvent(db: D1Database, userId: string | null, type: EventType, options: TrackOptions = {}): Promise<void> {
  try {
    await db.prepare("INSERT INTO user_events (user_id, type, course_id, lesson_id, data_json) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, type, options.courseId ?? null, options.lessonId ?? null,
        options.data === undefined ? null : JSON.stringify(options.data).slice(0, 4000)).run();
    await Promise.all(listeners.map(l => l(db, userId, type, options).catch(err => console.error("Event listener failed:", err))));
  } catch (error) {
    console.error("trackEvent failed:", error);
  }
}
