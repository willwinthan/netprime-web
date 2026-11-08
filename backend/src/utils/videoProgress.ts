import { allowedOrigins } from "./origins";

/**
 * Verified video progress: a video lesson completes only after the server has credited enough real playback.
 *
 * The player sends a heartbeat with its position every few seconds while playing. Each heartbeat at least
 * MIN_BEAT_MS after the last credited one adds the forward distance played, but never more than the wall time
 * since that heartbeat allows at MAX_PLAYBACK_RATE (+ BEAT_SLACK_SECONDS), and never more than
 * MAX_BEAT_CREDIT_SECONDS (so a long pause followed by a seek to the end earns little). The lesson completes
 * once the credited time reaches WATCHED_FRACTION of the video length.
 */
export const MIN_BEAT_MS = 2000;
export const MAX_PLAYBACK_RATE = 2;
export const BEAT_SLACK_SECONDS = 1;
export const MAX_BEAT_CREDIT_SECONDS = 25;
export const WATCHED_FRACTION = 0.9;
/** Longest video length accepted from a player (12 hours). */
export const MAX_DURATION_SECONDS = 12 * 3600;

export function validDuration(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= MAX_DURATION_SECONDS ? n : null;
}

/**
 * Length of a Vimeo video from its oEmbed data. Our videos are "Embed only", so oEmbed only returns the
 * duration when the request carries a Referer from an allowed domain: try each site origin in turn.
 * Returns null when Vimeo does not answer (for example from localhost).
 */
export async function vimeoDuration(videoUid: string, frontendOrigins?: string): Promise<number | null> {
  const [id, hash] = videoUid.split(":");
  if (!/^\d+$/.test(id || "")) return null;
  const videoUrl = `https://vimeo.com/${id}${hash && /^[\w]+$/.test(hash) ? `/${hash}` : ""}`;
  const endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(videoUrl)}`;
  for (const origin of allowedOrigins(frontendOrigins).filter(o => o.startsWith("https://")).slice(0, 3)) {
    try {
      const res = await fetch(endpoint, { headers: { Referer: `${origin}/` }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const data = await res.json<{ duration?: unknown }>();
      const duration = validDuration(data.duration);
      if (duration) return duration;
    } catch { /* try the next origin */ }
  }
  return null;
}

/**
 * Credits one heartbeat in a single statement, so two tabs reporting at once cannot double-count.
 * The first heartbeat only sets the baseline; one sent sooner than MIN_BEAT_MS after the last credited
 * heartbeat updates the resume position only.
 */
export function creditHeartbeat(db: D1Database, userId: string, lessonId: string, courseId: string, position: number, nowMs: number) {
  return db.prepare(`
    INSERT INTO lesson_progress (user_id, lesson_id, course_id, resume_seconds, completed, watched_seconds, last_position, last_beat_ms)
    VALUES (?1, ?2, ?3, ?4, 0, 0, ?4, ?5)
    ON CONFLICT(user_id, lesson_id) DO UPDATE SET
      watched_seconds = lesson_progress.watched_seconds + CASE
        WHEN lesson_progress.last_beat_ms IS NULL OR lesson_progress.last_position IS NULL THEN 0
        WHEN ?5 - lesson_progress.last_beat_ms < ${MIN_BEAT_MS} THEN 0
        ELSE MAX(0, MIN(?4 - lesson_progress.last_position,
          (?5 - lesson_progress.last_beat_ms) / 1000.0 * ${MAX_PLAYBACK_RATE} + ${BEAT_SLACK_SECONDS},
          ${MAX_BEAT_CREDIT_SECONDS}))
      END,
      last_position = CASE WHEN lesson_progress.last_beat_ms IS NOT NULL AND ?5 - lesson_progress.last_beat_ms < ${MIN_BEAT_MS}
        THEN lesson_progress.last_position ELSE ?4 END,
      last_beat_ms = CASE WHEN lesson_progress.last_beat_ms IS NOT NULL AND ?5 - lesson_progress.last_beat_ms < ${MIN_BEAT_MS}
        THEN lesson_progress.last_beat_ms ELSE ?5 END,
      resume_seconds = ?4,
      updated_at = CURRENT_TIMESTAMP`)
    .bind(userId, lessonId, courseId, position, nowMs).run();
}
