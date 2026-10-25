import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { currentPermissions } from "../utils/permissions";
import { requireVerifiedEmail } from "../utils/school";
import {
  MEETING_PROVIDERS, MeetingEnv, MeetingError, MeetingProvider, bangkokDayEnd, createMeeting, isoInstant, joinWindow, providerStatus,
  validJoinUrl, zoomParticipants
} from "../utils/meetings";

/**
 * Live meetings (mounted at /api/live by handlers/platform.ts).
 *  Training sessions (online/hybrid, permission site.sessions):
 *    GET/PUT/DELETE /sessions/:id/meeting, POST /sessions/:id/meeting/import-attendance (Zoom report)
 *  Course live classes (course instructor, courses.approve or admin manage; enrolled learners view):
 *    GET/POST /courses/:courseId/classes, PATCH/DELETE /classes/:id,
 *    GET/PUT /classes/:id/attendance, POST /classes/:id/import-attendance
 *  Learners: GET /my (calendar items), POST /join/session/:id, POST /join/class/:id
 * The join link is only handed out from 30 minutes before the start (utils/meetings.ts joinWindow)
 * to confirmed/paid/attended registrants and to enrolled learners.
 */
export const liveRouter = new Hono<Env>();
// Mounted only via platformRouter.route("/live", liveRouter), so "*" here means /api/live/* (never all of /api).
liveRouter.use("*", rbac());
liveRouter.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

const meetingEnv = (c: Context<Env>) => c.env as unknown as MeetingEnv;
const nowIso = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const isProvider = (value: unknown): value is MeetingProvider => typeof value === "string" && (MEETING_PROVIDERS as string[]).includes(value);

function meetingFailure(c: Context<Env>, error: unknown) {
  if (error instanceof MeetingError) return c.json({ error: error.message }, error.status);
  console.error("Meeting provider call failed:", error);
  return c.json({ error: "เชื่อมต่อผู้ให้บริการประชุมออนไลน์ไม่สำเร็จ" }, 502);
}

interface MeetingInput { provider: MeetingProvider; starts_at: string; duration_minutes: number; join_url: string | null; passcode: string | null }

function parseMeeting(body: Record<string, unknown> | null, partial = false): { value?: Partial<MeetingInput>; error?: string } {
  if (!body) return { error: "ข้อมูลไม่ถูกต้อง" };
  const value: Partial<MeetingInput> = {};
  if (!partial || body.provider !== undefined) {
    if (!isProvider(body.provider)) return { error: "กรุณาเลือกผู้ให้บริการ (zoom, teams, meet หรือ manual)" };
    value.provider = body.provider;
  }
  if (!partial || body.starts_at !== undefined) {
    const starts = isoInstant(body.starts_at);
    if (!starts) return { error: "เวลาเริ่มต้องเป็นวันเวลา ISO พร้อมเขตเวลา เช่น 2026-11-03T09:00:00+07:00" };
    value.starts_at = starts;
  }
  if (!partial || body.duration_minutes !== undefined) {
    const minutes = body.duration_minutes === undefined ? 120 : Number(body.duration_minutes);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) return { error: "ระยะเวลาต้องเป็น 15–1,440 นาที" };
    value.duration_minutes = minutes;
  }
  if (body.join_url !== undefined && body.join_url !== null && body.join_url !== "") {
    if (!validJoinUrl(body.join_url)) return { error: "ลิงก์เข้าร่วมต้องขึ้นต้นด้วย https://" };
    value.join_url = String(body.join_url);
  } else if (body.join_url !== undefined) value.join_url = null;
  if (body.passcode !== undefined) {
    if (body.passcode !== null && (typeof body.passcode !== "string" || body.passcode.length > 64)) return { error: "รหัสผ่านห้องยาวไม่เกิน 64 ตัวอักษร" };
    value.passcode = body.passcode ? String(body.passcode) : null;
  }
  return { value };
}

/** Resolves the join link: provider API for zoom/teams, the pasted link for meet/manual. */
async function resolveLink(c: Context<Env>, input: MeetingInput, topic: string) {
  if (input.provider === "meet" || input.provider === "manual") {
    if (!input.join_url) throw new MeetingError("กรุณาวางลิงก์เข้าร่วม (https://)", 400);
    if (input.provider === "meet" && !/^https:\/\/meet\.google\.com\//.test(input.join_url)) throw new MeetingError("ลิงก์ Google Meet ต้องขึ้นต้นด้วย https://meet.google.com/", 400);
    return { join_url: input.join_url, external_id: null, passcode: input.passcode ?? null };
  }
  const created = await createMeeting(meetingEnv(c), input.provider, { topic, startsAt: input.starts_at, durationMinutes: input.duration_minutes });
  return { ...created, passcode: created.passcode ?? input.passcode ?? null };
}

liveRouter.get("/providers", (c) => c.json({ providers: providerStatus(meetingEnv(c)) }));

// ==========================================
// Training sessions
// ==========================================

async function requireSessions(c: Context<Env>): Promise<Response | null> {
  return (await currentPermissions(c)).has("site.sessions") ? null : c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
}

const MEETING_FIELDS = "provider, join_url, external_id, passcode, starts_at, duration_minutes, attendance_imported_at, updated_at";

liveRouter.get("/sessions/:id/meeting", async (c) => {
  const denied = await requireSessions(c);
  if (denied) return denied;
  const meeting = await c.env.DB.prepare(`SELECT ${MEETING_FIELDS} FROM session_meetings WHERE session_id = ?`).bind(c.req.param("id")).first();
  return c.json({ meeting: meeting ?? null, providers: providerStatus(meetingEnv(c)) });
});

liveRouter.put("/sessions/:id/meeting", async (c) => {
  const denied = await requireSessions(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const session = await c.env.DB.prepare("SELECT id, title, mode, start_date, end_date FROM training_sessions WHERE id = ?").bind(id)
    .first<{ id: string; title: string; mode: string; start_date: string; end_date: string }>();
  if (!session) return c.json({ error: "ไม่พบรอบอบรม" }, 404);
  if (session.mode === "classroom") return c.json({ error: "รอบอบรมแบบห้องเรียนไม่มีห้องประชุมออนไลน์ เปลี่ยนรูปแบบเป็นออนไลน์หรือ Hybrid ก่อน" }, 400);
  const { value, error } = parseMeeting(await c.req.json<Record<string, unknown>>().catch(() => null));
  if (error || !value) return c.json({ error }, 400);
  let link;
  try { link = await resolveLink(c, value as MeetingInput, session.title); } catch (err) { return meetingFailure(c, err); }
  await c.env.DB.prepare(`INSERT INTO session_meetings (session_id, provider, join_url, external_id, passcode, starts_at, duration_minutes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET provider = excluded.provider, join_url = excluded.join_url, external_id = excluded.external_id,
      passcode = excluded.passcode, starts_at = excluded.starts_at, duration_minutes = excluded.duration_minutes, updated_at = CURRENT_TIMESTAMP`)
    .bind(id, value.provider, link.join_url, link.external_id, link.passcode, value.starts_at, value.duration_minutes, c.get("user").id).run();
  const meeting = await c.env.DB.prepare(`SELECT ${MEETING_FIELDS} FROM session_meetings WHERE session_id = ?`).bind(id).first();
  return c.json({ meeting, message: "บันทึกห้องประชุมออนไลน์แล้ว ผู้สมัครที่ยืนยันแล้วจะเห็นปุ่มเข้าร่วมก่อนเริ่ม 30 นาที" });
});

liveRouter.delete("/sessions/:id/meeting", async (c) => {
  const denied = await requireSessions(c);
  if (denied) return denied;
  const res = await c.env.DB.prepare("DELETE FROM session_meetings WHERE session_id = ?").bind(c.req.param("id")).run();
  if (!res.meta.changes) return c.json({ error: "รอบนี้ยังไม่มีห้องประชุมออนไลน์" }, 404);
  return c.json({ message: "ลบห้องประชุมออนไลน์แล้ว (ห้องใน Zoom/Teams ไม่ถูกลบ)" });
});

async function updateInChunks(db: D1Database, sql: (marks: string) => string, fixed: unknown[], values: string[]): Promise<number> {
  let changes = 0;
  for (let i = 0; i < values.length; i += 50) {
    const chunk = values.slice(i, i + 50);
    const res = await db.prepare(sql(chunk.map(() => "?").join(", "))).bind(...fixed, ...chunk).run();
    changes += res.meta.changes || 0;
  }
  return changes;
}

/** Marks confirmed/paid registrants whose email appears in the Zoom participant report as attended. */
liveRouter.post("/sessions/:id/meeting/import-attendance", async (c) => {
  const denied = await requireSessions(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const meeting = await c.env.DB.prepare("SELECT provider, external_id FROM session_meetings WHERE session_id = ?").bind(id).first<{ provider: string; external_id: string | null }>();
  if (!meeting) return c.json({ error: "รอบนี้ยังไม่มีห้องประชุมออนไลน์" }, 404);
  if (meeting.provider !== "zoom" || !meeting.external_id) return c.json({ error: "นำเข้าการเข้าร่วมอัตโนมัติได้เฉพาะห้อง Zoom ที่สร้างจากระบบ" }, 400);
  let participants;
  try { participants = await zoomParticipants(meetingEnv(c), meeting.external_id); } catch (err) { return meetingFailure(c, err); }
  const emails = participants.map(p => p.email);
  const marked = await updateInChunks(c.env.DB, marks => `UPDATE session_registrations SET status = 'attended', updated_at = CURRENT_TIMESTAMP
    WHERE session_id = ? AND status IN ('confirmed', 'paid') AND lower(email) IN (${marks})`, [id], emails);
  await c.env.DB.prepare("UPDATE session_meetings SET attendance_imported_at = ? WHERE session_id = ?").bind(nowIso(), id).run();
  return c.json({ participants: participants.length, marked, message: `พบผู้เข้าร่วม ${participants.length} คน บันทึกว่าเข้าอบรมแล้ว ${marked} รายการ` });
});

// ==========================================
// Course live classes
// ==========================================

async function courseAccess(c: Context<Env>, courseId: string) {
  const user = c.get("user");
  const course = await c.env.DB.prepare("SELECT id, title, instructor_id, status FROM courses WHERE id = ?").bind(courseId)
    .first<{ id: string; title: string; instructor_id: string; status: string }>();
  if (!course) return { course: null, manager: false, enrolled: false };
  const manager = user.roles.includes("admin") || course.instructor_id === user.id || (await currentPermissions(c)).has("courses.approve");
  const enrollment = manager ? null : await c.env.DB.prepare(`SELECT id FROM enrollments WHERE user_id = ? AND course_id = ? AND status IN ('active', 'completed')
    AND (expires_at IS NULL OR expires_at > ?)`).bind(user.id, courseId, nowIso()).first();
  return { course, manager, enrolled: !!enrollment };
}

const CLASS_FIELDS = "id, course_id, title, description, starts_at, duration_minutes, provider, join_url, external_id, passcode, status, attendance_imported_at, created_at, updated_at";
const endOf = (row: { starts_at: string; duration_minutes: number }) => new Date(Date.parse(row.starts_at) + row.duration_minutes * 60_000).toISOString();

/** Learner view of a class: no link; only whether and when the join button opens. */
function learnerClass(row: Record<string, any>, now = Date.now()) {
  const window = joinWindow(row.starts_at, endOf(row as any), now);
  return {
    id: row.id, course_id: row.course_id, title: row.title, description: row.description, starts_at: row.starts_at, ends_at: endOf(row as any),
    duration_minutes: row.duration_minutes, provider: row.provider, status: row.status,
    join_available: row.status === "scheduled" && window.open, join_opens_at: window.opens_at, ended: window.ended
  };
}

liveRouter.get("/courses/:courseId/classes", async (c) => {
  const access = await courseAccess(c, c.req.param("courseId"));
  if (!access.course) return c.json({ error: "ไม่พบคอร์ส" }, 404);
  if (!access.manager && !access.enrolled) return c.json({ error: "ต้องลงทะเบียนเรียนคอร์สนี้ก่อน" }, 403);
  const rows = await c.env.DB.prepare(`SELECT ${CLASS_FIELDS},
      (SELECT COUNT(*) FROM live_attendance a WHERE a.live_session_id = l.id) AS attendance_count
    FROM course_live_sessions l WHERE l.course_id = ? ORDER BY l.starts_at`).bind(access.course.id).all<Record<string, any>>();
  return c.json({
    course: { id: access.course.id, title: access.course.title }, manager: access.manager,
    classes: access.manager ? rows.results.map(r => ({ ...r, ends_at: endOf(r as any) })) : rows.results.filter(r => r.status === "scheduled").map(r => learnerClass(r)),
    providers: access.manager ? providerStatus(meetingEnv(c)) : undefined
  });
});

function classText(body: Record<string, unknown> | null, partial: boolean): { title?: string; description?: string | null; error?: string } {
  const out: { title?: string; description?: string | null } = {};
  if (!partial || body?.title !== undefined) {
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 160) return { error: "กรุณาตั้งชื่อคลาสสด (ไม่เกิน 160 ตัวอักษร)" };
    out.title = title;
  }
  if (body?.description !== undefined) {
    if (body.description !== null && (typeof body.description !== "string" || body.description.length > 2000)) return { error: "รายละเอียดยาวไม่เกิน 2,000 ตัวอักษร" };
    out.description = body.description ? String(body.description).trim() : null;
  }
  return out;
}

liveRouter.post("/courses/:courseId/classes", async (c) => {
  const access = await courseAccess(c, c.req.param("courseId"));
  if (!access.course) return c.json({ error: "ไม่พบคอร์ส" }, 404);
  if (!access.manager) return c.json({ error: "เฉพาะผู้สอนของคอร์สหรือผู้ดูแลเท่านั้น" }, 403);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const text = classText(body, false);
  if (text.error) return c.json({ error: text.error }, 400);
  const { value, error } = parseMeeting(body);
  if (error || !value) return c.json({ error }, 400);
  let link;
  try { link = await resolveLink(c, value as MeetingInput, `${access.course.title}: ${text.title}`); } catch (err) { return meetingFailure(c, err); }
  const id = newId("live");
  await c.env.DB.prepare(`INSERT INTO course_live_sessions (id, course_id, title, description, starts_at, duration_minutes, provider, join_url, external_id, passcode, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, access.course.id, text.title, text.description ?? null, value.starts_at, value.duration_minutes, value.provider, link.join_url, link.external_id, link.passcode, c.get("user").id).run();
  const row = await c.env.DB.prepare(`SELECT ${CLASS_FIELDS} FROM course_live_sessions WHERE id = ?`).bind(id).first();
  return c.json({ class: row }, 201);
});

async function loadClass(c: Context<Env>, id: string) {
  const row = await c.env.DB.prepare(`SELECT ${CLASS_FIELDS} FROM course_live_sessions WHERE id = ?`).bind(id).first<Record<string, any>>();
  if (!row) return { row: null, access: null };
  return { row, access: await courseAccess(c, row.course_id) };
}

/** Edits title/time/link; switching to zoom/teams (or a new time on them) creates a new meeting. */
liveRouter.patch("/classes/:id", async (c) => {
  const { row, access } = await loadClass(c, c.req.param("id"));
  if (!row || !access) return c.json({ error: "ไม่พบคลาสสด" }, 404);
  if (!access.manager) return c.json({ error: "เฉพาะผู้สอนของคอร์สหรือผู้ดูแลเท่านั้น" }, 403);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const text = classText(body, true);
  if (text.error) return c.json({ error: text.error }, 400);
  const { value, error } = parseMeeting(body, true);
  if (error || !value) return c.json({ error }, 400);
  if (body?.status !== undefined && !["scheduled", "cancelled"].includes(body.status as string)) return c.json({ error: "สถานะไม่ถูกต้อง" }, 400);
  const merged: MeetingInput = {
    provider: value.provider ?? row.provider, starts_at: value.starts_at ?? row.starts_at, duration_minutes: value.duration_minutes ?? row.duration_minutes,
    join_url: value.join_url !== undefined ? value.join_url : row.join_url, passcode: value.passcode !== undefined ? value.passcode : row.passcode
  };
  let link = { join_url: merged.join_url, external_id: row.external_id as string | null, passcode: merged.passcode };
  const automatic = merged.provider === "zoom" || merged.provider === "teams";
  const needsNew = automatic && (value.provider !== undefined && value.provider !== row.provider || value.starts_at !== undefined || value.duration_minutes !== undefined);
  if (!automatic || needsNew) {
    try { link = await resolveLink(c, merged, `${access.course!.title}: ${text.title ?? row.title}`); } catch (err) { return meetingFailure(c, err); }
  }
  await c.env.DB.prepare(`UPDATE course_live_sessions SET title = ?, description = ?, starts_at = ?, duration_minutes = ?, provider = ?, join_url = ?, external_id = ?,
      passcode = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(text.title ?? row.title, text.description !== undefined ? text.description : row.description, merged.starts_at, merged.duration_minutes, merged.provider,
      link.join_url, link.external_id, link.passcode, (body?.status as string) ?? row.status, row.id).run();
  const updated = await c.env.DB.prepare(`SELECT ${CLASS_FIELDS} FROM course_live_sessions WHERE id = ?`).bind(row.id).first();
  return c.json({ class: updated });
});

liveRouter.delete("/classes/:id", async (c) => {
  const { row, access } = await loadClass(c, c.req.param("id"));
  if (!row || !access) return c.json({ error: "ไม่พบคลาสสด" }, 404);
  if (!access.manager) return c.json({ error: "เฉพาะผู้สอนของคอร์สหรือผู้ดูแลเท่านั้น" }, 403);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM live_attendance WHERE live_session_id = ?").bind(row.id),
    c.env.DB.prepare("DELETE FROM course_live_sessions WHERE id = ?").bind(row.id)
  ]);
  return c.json({ message: "ลบคลาสสดแล้ว" });
});

liveRouter.get("/classes/:id/attendance", async (c) => {
  const { row, access } = await loadClass(c, c.req.param("id"));
  if (!row || !access) return c.json({ error: "ไม่พบคลาสสด" }, 404);
  if (!access.manager) return c.json({ error: "เฉพาะผู้สอนของคอร์สหรือผู้ดูแลเท่านั้น" }, 403);
  const rows = await c.env.DB.prepare(`SELECT u.id AS user_id, u.name, u.email, a.source, a.minutes, a.created_at AS attended_at
    FROM enrollments e JOIN users u ON u.id = e.user_id
    LEFT JOIN live_attendance a ON a.live_session_id = ? AND a.user_id = e.user_id
    WHERE e.course_id = ? AND e.status IN ('active', 'completed') ORDER BY u.name LIMIT 1000`).bind(row.id, row.course_id).all();
  return c.json({ learners: rows.results });
});

liveRouter.put("/classes/:id/attendance", async (c) => {
  const { row, access } = await loadClass(c, c.req.param("id"));
  if (!row || !access) return c.json({ error: "ไม่พบคลาสสด" }, 404);
  if (!access.manager) return c.json({ error: "เฉพาะผู้สอนของคอร์สหรือผู้ดูแลเท่านั้น" }, 403);
  const body = await c.req.json<{ user_id?: unknown; attended?: unknown }>().catch(() => null);
  if (typeof body?.user_id !== "string" || typeof body.attended !== "boolean") return c.json({ error: "ต้องระบุ user_id และ attended" }, 400);
  const enrolled = await c.env.DB.prepare("SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?").bind(body.user_id, row.course_id).first();
  if (!enrolled) return c.json({ error: "ผู้ใช้นี้ไม่ได้ลงทะเบียนเรียนคอร์สนี้" }, 400);
  if (body.attended) {
    await c.env.DB.prepare(`INSERT INTO live_attendance (live_session_id, user_id, source, marked_by) VALUES (?, ?, 'manual', ?)
      ON CONFLICT(live_session_id, user_id) DO UPDATE SET source = 'manual', marked_by = excluded.marked_by`).bind(row.id, body.user_id, c.get("user").id).run();
  } else {
    await c.env.DB.prepare("DELETE FROM live_attendance WHERE live_session_id = ? AND user_id = ?").bind(row.id, body.user_id).run();
  }
  return c.json({ message: body.attended ? "บันทึกการเข้าร่วมแล้ว" : "ยกเลิกการเข้าร่วมแล้ว" });
});

liveRouter.post("/classes/:id/import-attendance", async (c) => {
  const { row, access } = await loadClass(c, c.req.param("id"));
  if (!row || !access) return c.json({ error: "ไม่พบคลาสสด" }, 404);
  if (!access.manager) return c.json({ error: "เฉพาะผู้สอนของคอร์สหรือผู้ดูแลเท่านั้น" }, 403);
  if (row.provider !== "zoom" || !row.external_id) return c.json({ error: "นำเข้าการเข้าร่วมอัตโนมัติได้เฉพาะห้อง Zoom ที่สร้างจากระบบ" }, 400);
  let participants;
  try { participants = await zoomParticipants(meetingEnv(c), row.external_id); } catch (err) { return meetingFailure(c, err); }
  let marked = 0;
  for (const p of participants) {
    const res = await c.env.DB.prepare(`INSERT INTO live_attendance (live_session_id, user_id, source, minutes)
      SELECT ?, e.user_id, 'zoom', ? FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.course_id = ? AND u.email = ?
      ON CONFLICT(live_session_id, user_id) DO UPDATE SET minutes = excluded.minutes`).bind(row.id, p.minutes, row.course_id, p.email).run();
    marked += res.meta.changes || 0;
  }
  await c.env.DB.prepare("UPDATE course_live_sessions SET attendance_imported_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
  return c.json({ participants: participants.length, marked, message: `พบผู้เข้าร่วม ${participants.length} คน บันทึกแล้ว ${marked} คน` });
});

// ==========================================
// Learners
// ==========================================

const JOINABLE_REG = "('confirmed', 'paid', 'attended')";

/** Upcoming and recent live items for the signed-in learner (training sessions + course classes). */
liveRouter.get("/my", async (c) => {
  const user = c.get("user");
  const now = Date.now();
  const since = new Date(now - 86_400_000).toISOString();
  const [sessions, classes] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT s.id, s.title, s.start_date, s.end_date, s.time_text, s.mode, s.location, m.provider, m.starts_at, m.duration_minutes, r.status AS registration_status
      FROM session_registrations r JOIN training_sessions s ON s.id = r.session_id JOIN session_meetings m ON m.session_id = s.id
      WHERE (r.user_id = ? OR r.email = ?) AND r.status IN ${JOINABLE_REG} AND s.status <> 'cancelled' AND s.end_date >= ?
      ORDER BY m.starts_at LIMIT 100`).bind(user.id, user.email.toLowerCase(), since.slice(0, 10)),
    c.env.DB.prepare(`SELECT l.id, l.course_id, l.title, l.description, l.starts_at, l.duration_minutes, l.provider, l.status, c.title AS course_title
      FROM course_live_sessions l JOIN courses c ON c.id = l.course_id
      JOIN enrollments e ON e.course_id = l.course_id AND e.user_id = ? AND e.status IN ('active', 'completed') AND (e.expires_at IS NULL OR e.expires_at > ?)
      WHERE l.status = 'scheduled' AND l.starts_at >= ? ORDER BY l.starts_at LIMIT 200`).bind(user.id, new Date(now).toISOString(), since)
  ]);
  const items = [
    ...(sessions.results as Record<string, any>[]).map(s => {
      const endsAt = new Date(Math.max(Date.parse(s.starts_at) + s.duration_minutes * 60_000, Date.parse(bangkokDayEnd(s.end_date)))).toISOString();
      const window = joinWindow(s.starts_at, endsAt, now);
      return {
        kind: "session" as const, id: s.id, title: s.title, subtitle: s.time_text, start_date: s.start_date, end_date: s.end_date,
        starts_at: s.starts_at, ends_at: endsAt, provider: s.provider, join_available: window.open, join_opens_at: window.opens_at, ended: window.ended
      };
    }),
    ...(classes.results as Record<string, any>[]).map(r => ({ kind: "class" as const, ...learnerClass(r, now), subtitle: r.course_title, course_title: r.course_title }))
  ].filter(i => !i.ended).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return c.json({ items });
});

liveRouter.post("/join/session/:id", requireVerifiedEmail(), async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare(`SELECT s.end_date, s.status AS session_status, m.join_url, m.passcode, m.starts_at, m.duration_minutes,
      (SELECT r.status FROM session_registrations r WHERE r.session_id = s.id AND (r.user_id = ? OR r.email = ?) ORDER BY r.status IN ${JOINABLE_REG} DESC LIMIT 1) AS registration_status
    FROM training_sessions s JOIN session_meetings m ON m.session_id = s.id WHERE s.id = ?`).bind(user.id, user.email.toLowerCase(), c.req.param("id"))
    .first<{ end_date: string; session_status: string; join_url: string; passcode: string | null; starts_at: string; duration_minutes: number; registration_status: string | null }>();
  if (!row) return c.json({ error: "ไม่พบห้องประชุมของรอบอบรมนี้" }, 404);
  if (!row.registration_status || !["confirmed", "paid", "attended"].includes(row.registration_status)) {
    return c.json({ error: "ปุ่มเข้าร่วมใช้ได้เมื่อการสมัครได้รับการยืนยันหรือชำระเงินแล้ว", code: "not_confirmed" }, 403);
  }
  if (row.session_status === "cancelled") return c.json({ error: "รอบอบรมนี้ถูกยกเลิก" }, 403);
  const endsAt = new Date(Math.max(Date.parse(row.starts_at) + row.duration_minutes * 60_000, Date.parse(bangkokDayEnd(row.end_date)))).toISOString();
  const window = joinWindow(row.starts_at, endsAt);
  if (!window.open) return c.json({ error: window.ended ? "การอบรมรอบนี้จบแล้ว" : "เข้าห้องได้ตั้งแต่ 30 นาทีก่อนเริ่ม", code: window.ended ? "ended" : "too_early", join_opens_at: window.opens_at }, 403);
  return c.json({ join_url: row.join_url, passcode: row.passcode });
});

liveRouter.post("/join/class/:id", requireVerifiedEmail(), async (c) => {
  const { row, access } = await loadClass(c, c.req.param("id"));
  if (!row || !access) return c.json({ error: "ไม่พบคลาสสด" }, 404);
  if (!access.manager && !access.enrolled) return c.json({ error: "ต้องลงทะเบียนเรียนคอร์สนี้ก่อน", code: "not_enrolled" }, 403);
  if (row.status !== "scheduled") return c.json({ error: "คลาสนี้ถูกยกเลิก" }, 403);
  const window = joinWindow(row.starts_at, endOf(row as any));
  if (!access.manager && !window.open) return c.json({ error: window.ended ? "คลาสนี้จบแล้ว" : "เข้าห้องได้ตั้งแต่ 30 นาทีก่อนเริ่ม", code: window.ended ? "ended" : "too_early", join_opens_at: window.opens_at }, 403);
  if (!access.manager) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO live_attendance (live_session_id, user_id, source) VALUES (?, ?, 'join')").bind(row.id, c.get("user").id).run();
  }
  return c.json({ join_url: row.join_url, passcode: row.passcode });
});
