import { Context, Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { currentPermissions, permit, rolesColumn, parseRoles } from "../utils/permissions";

/**
 * Analytics (v0.5): presence heartbeats and learning time, the school dashboard (KPIs, charts,
 * activity widgets, online users), reports (courses, learners, revenue, events log) with CSV
 * export, and the global search palette.
 *
 * Days are Asia/Bangkok dates (UTC+7, no DST). Timestamps in D1 are UTC: either
 * CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS") or ISO with milliseconds; date(x, '+7 hours') reads both.
 */
export const analyticsRouter = new Hono<Env>();

const DAY_MS = 86400000;
const BKK_OFFSET_MS = 7 * 3600000;
/** Most a single heartbeat can add; the client beats every 60 s while the tab is visible. */
export const HEARTBEAT_MAX_SECONDS = 60;
export const ONLINE_WINDOW_MS = 5 * 60000;
const LEARNING_EVENTS = ["course_view", "lesson_view", "lesson_complete", "course_complete", "quiz_submit", "exam_submit", "assignment_submit"];

const bkkDay = (ms: number) => new Date(ms + BKK_OFFSET_MS).toISOString().slice(0, 10);
const validDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + "T00:00:00Z"));
const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 100 && /^[\w.:-]+$/.test(v);
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, ch => "\\" + ch)}%`;
const int = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
/** D1 CURRENT_TIMESTAMP values carry no zone; normalise to ISO UTC for comparisons and output. */
const isoOf = (v: string | null | undefined) => !v ? null : v.includes("T") ? v : v.replace(" ", "T") + "Z";

// ---------- Ranges and buckets ----------

type Bucket = "day" | "month";
interface Range { from: string; to: string; bucket: Bucket; key: string }

/** ?range=7d|30d|90d|12m|custom&from=YYYY-MM-DD&to=YYYY-MM-DD; null when invalid. */
function parseRange(c: Context<Env>, fallback = "30d"): Range | null {
  const key = c.req.query("range") || fallback;
  const now = Date.now();
  const to = bkkDay(now);
  if (key === "7d") return { from: bkkDay(now - 6 * DAY_MS), to, bucket: "day", key };
  if (key === "30d") return { from: bkkDay(now - 29 * DAY_MS), to, bucket: "day", key };
  if (key === "90d") return { from: bkkDay(now - 89 * DAY_MS), to, bucket: "day", key };
  if (key === "12m") {
    const d = new Date(now + BKK_OFFSET_MS);
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1));
    return { from: start.toISOString().slice(0, 10), to, bucket: "month", key };
  }
  if (key === "custom") {
    const from = c.req.query("from"), end = c.req.query("to");
    if (!validDay(from) || !validDay(end) || from > end) return null;
    const span = (Date.parse(end) - Date.parse(from)) / DAY_MS;
    if (span > 1100) return null;
    return { from, to: end, bucket: span > 92 ? "month" : "day", key };
  }
  return null;
}

/** Optional explicit range for reports: from/to when given, otherwise the last 30 days. */
function reportRange(c: Context<Env>): Range | null {
  if (c.req.query("from") || c.req.query("to")) {
    const from = c.req.query("from"), to = c.req.query("to");
    if (!validDay(from) || !validDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / DAY_MS > 1100) return null;
    return { from, to, bucket: (Date.parse(to) - Date.parse(from)) / DAY_MS > 92 ? "month" : "day", key: "custom" };
  }
  return parseRange(c, "30d");
}

function bucketKeys(range: Range): string[] {
  const keys: string[] = [];
  if (range.bucket === "day") {
    for (let t = Date.parse(range.from + "T00:00:00Z"); t <= Date.parse(range.to + "T00:00:00Z"); t += DAY_MS) keys.push(new Date(t).toISOString().slice(0, 10));
  } else {
    const d = new Date(range.from.slice(0, 7) + "-01T00:00:00Z");
    while (d.toISOString().slice(0, 7) <= range.to.slice(0, 7)) {
      keys.push(d.toISOString().slice(0, 7));
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }
  return keys;
}

/** Bangkok-local bucket expression for a UTC timestamp column. */
const bucketOf = (bucket: Bucket, column: string) => bucket === "day" ? `date(${column}, '+7 hours')` : `strftime('%Y-%m', ${column}, '+7 hours')`;
const dayOf = (column: string) => `date(${column}, '+7 hours')`;

// ---------- Access ----------

/** Reports scope: everything (reports.view) or only the instructor's own courses; null = no access. */
type Scope = { all: true; instructorId: null } | { all: false; instructorId: string };
async function reportScope(c: Context<Env>): Promise<Scope | null> {
  if ((await currentPermissions(c)).has("reports.view")) return { all: true, instructorId: null };
  const user = c.get("user");
  if (user.roles.includes("instructor")) return { all: false, instructorId: user.id };
  return null;
}
const denied = (c: Context<Env>) => c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ดูรายงาน" }, 403);
/** SQL fragment limiting a course id column to the scope; binds go in `binds`. */
function courseScope(scope: Scope, column: string, binds: unknown[]): string {
  if (scope.all) return "1 = 1";
  binds.push(scope.instructorId);
  return `${column} IN (SELECT id FROM courses WHERE instructor_id = ?)`;
}

// ---------- CSV ----------

/** Excel-friendly CSV (UTF-8 BOM), every cell quoted and spreadsheet formulas neutralised (as in site.ts). */
export function toCsv(header: string[], rows: unknown[][]): string {
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return "﻿" + [header.map(cell).join(","), ...rows.map(r => r.map(cell).join(","))].join("\r\n");
}
function csvResponse(csv: string, filename: string) {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}
const wantsCsv = (c: Context<Env>) => c.req.query("format") === "csv";
const hours = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;

// ---------- Event descriptions ----------

export const EVENT_LABELS: Record<string, string> = {
  login: "เข้าสู่ระบบ",
  signup: "สมัครสมาชิก",
  course_view: "เปิดดูคอร์ส",
  lesson_view: "เปิดบทเรียน",
  lesson_complete: "เรียนจบบทเรียน",
  course_complete: "เรียนจบคอร์ส",
  enroll: "ลงทะเบียนเรียน",
  order_created: "สร้างคำสั่งซื้อ",
  order_paid: "ชำระเงินสำเร็จ",
  quiz_submit: "ส่งแบบทดสอบ",
  exam_submit: "ส่งข้อสอบ",
  assignment_submit: "ส่งงาน",
  certificate_issued: "ได้รับใบประกาศนียบัตร",
  post_created: "โพสต์ในชุมชน"
};

interface EventRow {
  id: number; user_id: string | null; type: string; course_id: string | null; lesson_id: string | null; data_json: string | null; created_at: string;
  user_name: string | null; user_email: string | null; course_title: string | null; lesson_title: string | null;
}

function describeEvent(e: EventRow): string {
  const who = e.user_name || "ผู้ใช้ที่ถูกลบ";
  let text = `${who} ${EVENT_LABELS[e.type] || e.type}`;
  if (e.lesson_title) text += ` บทเรียน “${e.lesson_title}”`;
  if (e.course_title) text += ` คอร์ส “${e.course_title}”`;
  if (e.type === "login" || e.type === "signup") {
    try {
      const method = JSON.parse(e.data_json || "{}").method;
      if (method && method !== "password") text += ` ผ่าน ${String(method).slice(0, 20)}`;
    } catch { /* Ignore malformed data. */ }
  }
  return text;
}

/** Console navigation target for an event (see GlobalSearch onNavigate). */
function eventLink(e: EventRow): { tab: string; id?: string } | null {
  if (e.type === "order_paid" || e.type === "order_created") {
    try {
      const orderId = JSON.parse(e.data_json || "{}").order_id;
      if (typeof orderId === "string") return { tab: "orders", id: orderId };
    } catch { /* Ignore malformed data. */ }
  }
  if (e.course_id) return { tab: "reports", id: e.course_id };
  if (e.user_id) return { tab: "users", id: e.user_id };
  return null;
}

const presentEvent = (e: EventRow) => ({
  id: e.id, type: e.type, label: EVENT_LABELS[e.type] || e.type, description: describeEvent(e),
  user_id: e.user_id, user_name: e.user_name, user_email: e.user_email,
  course_id: e.course_id, course_title: e.course_title, lesson_id: e.lesson_id, lesson_title: e.lesson_title,
  created_at: e.created_at, link: eventLink(e)
});

const EVENT_SELECT = `SELECT ev.id, ev.user_id, ev.type, ev.course_id, ev.lesson_id, ev.data_json, ev.created_at,
    u.name AS user_name, u.email AS user_email, co.title AS course_title, l.title AS lesson_title
  FROM user_events ev
  LEFT JOIN users u ON u.id = ev.user_id
  LEFT JOIN courses co ON co.id = ev.course_id
  LEFT JOIN lessons l ON l.id = ev.lesson_id`;

// ==========================================
// 1. Presence & learning time
// ==========================================

/**
 * POST /api/me/heartbeat { course_id?, lesson_id?, seconds? }
 * Sent every 60 s while the console tab is visible. Credits at most 60 s, and never more than the time
 * since the previous heartbeat, so extra or parallel calls cannot inflate learning time.
 */
analyticsRouter.post("/me/heartbeat", rbac(), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const claimedRaw = body && typeof body === "object" && body.seconds !== undefined ? Number(body.seconds) : HEARTBEAT_MAX_SECONDS;
  if (!Number.isFinite(claimedRaw) || claimedRaw < 0) return c.json({ error: "ข้อมูลเวลาไม่ถูกต้อง" }, 400);
  let courseId: string | null = validId(body?.course_id) ? body.course_id as string : null;
  let lessonId: string | null = courseId && validId(body?.lesson_id) ? body.lesson_id as string : null;
  if (body?.course_id != null && !courseId) return c.json({ error: "รหัสคอร์สไม่ถูกต้อง" }, 400);

  // Time only counts toward a course the user may study (enrolled) or teaches.
  if (courseId) {
    const ok = await db.prepare(`SELECT 1 AS ok FROM courses co WHERE co.id = ? AND (co.instructor_id = ? OR EXISTS
        (SELECT 1 FROM enrollments e WHERE e.course_id = co.id AND e.user_id = ? AND e.status IN ('active', 'completed')))`)
      .bind(courseId, user.id, user.id).first();
    if (!ok) { courseId = null; lessonId = null; }
  }
  if (lessonId) {
    const ok = await db.prepare("SELECT 1 AS ok FROM lessons WHERE id = ? AND course_id = ?").bind(lessonId, courseId).first();
    if (!ok) lessonId = null;
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const prev = await db.prepare("SELECT last_seen_at FROM user_presence WHERE user_id = ?").bind(user.id).first<{ last_seen_at: string }>();
  const elapsed = prev ? Math.max(0, (now - Date.parse(prev.last_seen_at)) / 1000) : Infinity;
  let credited = Math.floor(Math.min(claimedRaw, HEARTBEAT_MAX_SECONDS, elapsed));

  // Claim the previous heartbeat atomically: of two parallel calls only one gets the elapsed time.
  const claim = prev
    ? await db.prepare("UPDATE user_presence SET last_seen_at = ?, course_id = ?, lesson_id = ? WHERE user_id = ? AND last_seen_at = ?")
      .bind(nowIso, courseId, lessonId, user.id, prev.last_seen_at).run()
    : await db.prepare("INSERT INTO user_presence (user_id, last_seen_at, course_id, lesson_id) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING")
      .bind(user.id, nowIso, courseId, lessonId).run();
  if (!claim.meta.changes) {
    credited = 0;
    await db.prepare("UPDATE user_presence SET last_seen_at = MAX(last_seen_at, ?), course_id = ?, lesson_id = ? WHERE user_id = ?")
      .bind(nowIso, courseId, lessonId, user.id).run();
  }
  if (credited > 0) {
    await db.prepare(`INSERT INTO learning_time (user_id, course_id, day, seconds, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, course_id, day) DO UPDATE SET seconds = seconds + excluded.seconds, updated_at = CURRENT_TIMESTAMP`)
      .bind(user.id, courseId ?? "", bkkDay(now), credited).run();
  }
  return c.json({ ok: true, credited_seconds: credited, course_id: courseId, lesson_id: lessonId });
});

/** GET /api/me/learning-time?range=… — the signed-in user's own time per day and course. */
analyticsRouter.get("/me/learning-time", rbac(), async (c) => {
  const range = parseRange(c);
  if (!range) return c.json({ error: "ช่วงเวลาไม่ถูกต้อง" }, 400);
  const rows = await c.env.DB.prepare(`SELECT lt.day, lt.course_id, co.title AS course_title, lt.seconds FROM learning_time lt
    LEFT JOIN courses co ON co.id = lt.course_id WHERE lt.user_id = ? AND lt.day BETWEEN ? AND ? ORDER BY lt.day`)
    .bind(c.get("user").id, range.from, range.to).all<{ day: string; course_id: string; course_title: string | null; seconds: number }>();
  const total = rows.results.reduce((s, r) => s + r.seconds, 0);
  return c.json({ from: range.from, to: range.to, total_seconds: total, rows: rows.results });
});

// ==========================================
// 2. School dashboard (reports.view)
// ==========================================

async function onlineUsers(db: D1Database) {
  const since = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
  const rows = await db.prepare(`SELECT p.user_id AS id, u.name, u.email, COALESCE(u.staff_role, u.role) AS role, ${rolesColumn("u")} AS role_list,
      p.last_seen_at, p.course_id, co.title AS course_title, p.lesson_id, l.title AS lesson_title
    FROM user_presence p JOIN users u ON u.id = p.user_id
    LEFT JOIN courses co ON co.id = p.course_id LEFT JOIN lessons l ON l.id = p.lesson_id
    WHERE p.last_seen_at >= ? ORDER BY p.last_seen_at DESC LIMIT 100`)
    .bind(since).all<{ id: string; name: string; email: string; role: string; role_list: string | null; last_seen_at: string; course_id: string | null; course_title: string | null; lesson_id: string | null; lesson_title: string | null }>();
  return rows.results.map(({ role_list, role, ...r }) => ({ ...r, roles: parseRoles(role_list, role) }));
}

/** Distinct (user, Bangkok day) pairs with learning activity — the basis of "active learners". */
const ACTIVE_CTE = `act AS (
    SELECT user_id, day AS d FROM learning_time WHERE seconds > 0
    UNION SELECT user_id, ${dayOf("created_at")} FROM user_events WHERE user_id IS NOT NULL AND type IN (${LEARNING_EVENTS.map(t => `'${t}'`).join(", ")})
    UNION SELECT user_id, ${dayOf("updated_at")} FROM lesson_progress WHERE updated_at IS NOT NULL
  )`;

/** Paid course orders (amount received; refunded orders are no longer 'paid') + legacy completed card payments. */
const SALES_UNION = (bucket: Bucket) => `
    SELECT ${bucketOf(bucket, "paid_at")} AS k, COALESCE(amount_received, amount) AS amt FROM course_orders
      WHERE status = 'paid' AND paid_at IS NOT NULL AND ${dayOf("paid_at")} BETWEEN ? AND ?
    UNION ALL
    SELECT ${bucketOf(bucket, "created_at")} AS k, amount AS amt FROM payments
      WHERE status = 'completed' AND ${dayOf("created_at")} BETWEEN ? AND ?`;

async function salesTotals(db: D1Database, from: string, to: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amt), 0) AS revenue FROM (${SALES_UNION("day")})`)
    .bind(from, to, from, to).first<{ count: number; revenue: number }>();
  return { count: row?.count ?? 0, revenue: row?.revenue ?? 0 };
}

/**
 * GET /api/analytics/dashboard?range=7d|30d|90d|12m|custom&from&to
 * KPI cards and chart series (signups, revenue, product sales, active learners).
 */
analyticsRouter.get("/analytics/dashboard", rbac(), permit("reports.view"), async (c) => {
  const db = c.env.DB;
  const range = parseRange(c);
  if (!range) return c.json({ error: "ช่วงเวลาไม่ถูกต้อง" }, 400);
  const { from, to, bucket } = range;
  const now = Date.now();
  const from30 = bkkDay(now - 29 * DAY_MS), today = bkkDay(now);

  const [users, signups, converted, active, learning, courses, categories, sales, sales30, signupSeries, salesSeries, activeSeries] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${dayOf("created_at")} BETWEEN ? AND ?`).bind(from, to).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM (SELECT user_id FROM enrollments UNION SELECT user_id FROM course_orders WHERE status = 'paid'
      UNION SELECT user_id FROM payments WHERE status = 'completed') x JOIN users u ON u.id = x.user_id`).first<{ n: number }>(),
    db.prepare(`WITH ${ACTIVE_CTE} SELECT COUNT(DISTINCT user_id) AS n FROM act WHERE d BETWEEN ? AND ?`).bind(from, to).first<{ n: number }>(),
    db.prepare("SELECT COALESCE(SUM(seconds), 0) AS seconds FROM learning_time WHERE day BETWEEN ? AND ?").bind(from, to).first<{ seconds: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM courses WHERE status = 'published'").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM course_categories").first<{ n: number }>(),
    salesTotals(db, from, to),
    salesTotals(db, from30, today),
    db.prepare(`SELECT ${bucketOf(bucket, "created_at")} AS k, COUNT(*) AS n FROM users WHERE ${dayOf("created_at")} BETWEEN ? AND ? GROUP BY k`)
      .bind(from, to).all<{ k: string; n: number }>(),
    db.prepare(`SELECT k, COUNT(*) AS n, COALESCE(SUM(amt), 0) AS revenue FROM (${SALES_UNION(bucket)}) GROUP BY k`)
      .bind(from, to, from, to).all<{ k: string; n: number; revenue: number }>(),
    db.prepare(`WITH ${ACTIVE_CTE} SELECT ${bucket === "day" ? "d" : "substr(d, 1, 7)"} AS k, COUNT(DISTINCT user_id) AS n FROM act WHERE d BETWEEN ? AND ? GROUP BY k`)
      .bind(from, to).all<{ k: string; n: number }>()
  ]);

  const map = <T extends { k: string }>(rows: T[]) => new Map(rows.map(r => [r.k, r]));
  const s = map(signupSeries.results), sa = map(salesSeries.results), a = map(activeSeries.results);
  const series = bucketKeys(range).map(k => ({
    key: k,
    signups: s.get(k)?.n ?? 0,
    revenue: sa.get(k)?.revenue ?? 0,
    sales: sa.get(k)?.n ?? 0,
    active_learners: a.get(k)?.n ?? 0
  }));
  const totalUsers = users?.n ?? 0;
  const activeLearners = active?.n ?? 0;
  return c.json({
    range: { key: range.key, from, to, bucket },
    kpis: {
      total_users: totalUsers,
      new_signups: signups?.n ?? 0,
      active_learners: activeLearners,
      converted_users: converted?.n ?? 0,
      conversion_percent: totalUsers ? Math.round(((converted?.n ?? 0) / totalUsers) * 1000) / 10 : 0,
      sales_count: sales.count,
      revenue: sales.revenue,
      sales_30d_count: sales30.count,
      revenue_30d: sales30.revenue,
      learning_seconds: learning?.seconds ?? 0,
      avg_learning_seconds: activeLearners ? Math.round((learning?.seconds ?? 0) / activeLearners) : 0,
      published_courses: courses?.n ?? 0,
      categories: categories?.n ?? 0
    },
    series
  });
});

/** GET /api/analytics/online — users whose last heartbeat is within 5 minutes. */
analyticsRouter.get("/analytics/online", rbac(), permit("reports.view"), async (c) => {
  return c.json({ window_minutes: ONLINE_WINDOW_MS / 60000, users: await onlineUsers(c.env.DB) });
});

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first());
}

/**
 * GET /api/analytics/activity — dashboard widgets: newest users, latest Q&A / community posts,
 * latest events and online users.
 */
analyticsRouter.get("/analytics/activity", rbac(), permit("reports.view"), async (c) => {
  const db = c.env.DB;
  const [newUsers, qa, events, online] = await Promise.all([
    db.prepare(`SELECT u.id, u.name, u.email, u.created_at, COALESCE(u.staff_role, u.role) AS role FROM users u ORDER BY u.created_at DESC, u.rowid DESC LIMIT 8`)
      .all<{ id: string; name: string; email: string; created_at: string; role: string }>(),
    db.prepare(`SELECT q.id, q.content, q.created_at, q.parent_id, u.id AS user_id, u.name AS user_name, l.id AS lesson_id, l.title AS lesson_title,
        co.id AS course_id, co.title AS course_title
      FROM lesson_qa q JOIN users u ON u.id = q.user_id JOIN lessons l ON l.id = q.lesson_id JOIN courses co ON co.id = l.course_id
      ORDER BY q.created_at DESC LIMIT 8`).all<Record<string, any>>(),
    db.prepare(`${EVENT_SELECT} ORDER BY ev.id DESC LIMIT 15`).all<EventRow>(),
    onlineUsers(db)
  ]);
  const posts = qa.results.map(r => ({
    id: r.id, source: "qa", title: r.lesson_title, excerpt: String(r.content || "").slice(0, 160), is_reply: !!r.parent_id,
    user_id: r.user_id, user_name: r.user_name, course_id: r.course_id, course_title: r.course_title, created_at: r.created_at
  }));
  // Community posts are built by another module; read them only when that table exists.
  try {
    if (await tableExists(db, "community_posts")) {
      const cp = await db.prepare(`SELECT p.*, u.name AS user_name FROM community_posts p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 8`)
        .all<Record<string, any>>();
      for (const r of cp.results) {
        posts.push({
          id: r.id, source: "community", title: r.title || "โพสต์ในชุมชน", excerpt: String(r.body ?? r.content ?? "").slice(0, 160), is_reply: !!r.parent_id,
          user_id: r.user_id ?? null, user_name: r.user_name ?? null, course_id: r.course_id ?? null, course_title: null, created_at: r.created_at
        });
      }
    }
  } catch (error) { console.error("Community posts widget failed:", error); }
  posts.sort((x, y) => String(isoOf(y.created_at)).localeCompare(String(isoOf(x.created_at))));
  return c.json({ new_users: newUsers.results, posts: posts.slice(0, 8), events: events.results.map(presentEvent), online });
});

// ==========================================
// 3. Reports (reports.view, or instructors for their own courses)
// ==========================================

interface EventFilters { where: string; binds: unknown[] }
function eventFilters(c: Context<Env>, scope: Scope): EventFilters | { error: string } {
  const parts: string[] = [];
  const binds: unknown[] = [];
  const user = (c.req.query("user") || "").trim().slice(0, 100);
  const type = (c.req.query("type") || "").trim();
  const course = (c.req.query("course") || c.req.query("course_id") || "").trim();
  const from = c.req.query("from"), to = c.req.query("to");
  if (user) {
    if (user.startsWith("usr_")) { parts.push("ev.user_id = ?"); binds.push(user); }
    else { const like = likePattern(user); parts.push("(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')"); binds.push(like, like); }
  }
  if (type) {
    if (!/^[a-z_]{2,40}$/.test(type)) return { error: "ประเภทกิจกรรมไม่ถูกต้อง" };
    parts.push("ev.type = ?"); binds.push(type);
  }
  if (course) {
    if (!validId(course)) return { error: "รหัสคอร์สไม่ถูกต้อง" };
    parts.push("ev.course_id = ?"); binds.push(course);
  }
  if (from) { if (!validDay(from)) return { error: "วันที่เริ่มต้นไม่ถูกต้อง" }; parts.push(`${dayOf("ev.created_at")} >= ?`); binds.push(from); }
  if (to) { if (!validDay(to)) return { error: "วันที่สิ้นสุดไม่ถูกต้อง" }; parts.push(`${dayOf("ev.created_at")} <= ?`); binds.push(to); }
  if (!scope.all) parts.push(courseScope(scope, "ev.course_id", binds));
  return { where: parts.length ? "WHERE " + parts.join(" AND ") : "", binds };
}

/**
 * GET /api/analytics/events?user=&type=&course=&from=&to=&page=&limit=&format=csv
 * Instructors only see events of their own courses.
 */
analyticsRouter.get("/analytics/events", rbac(), async (c) => {
  const scope = await reportScope(c);
  if (!scope) return denied(c);
  const filters = eventFilters(c, scope);
  if ("error" in filters) return c.json({ error: filters.error }, 400);
  const db = c.env.DB;
  if (wantsCsv(c)) {
    const rows = await db.prepare(`${EVENT_SELECT} ${filters.where} ORDER BY ev.id DESC LIMIT 5000`).bind(...filters.binds).all<EventRow>();
    const csv = toCsv(["เวลา", "ผู้ใช้", "อีเมล", "กิจกรรม", "คอร์ส", "บทเรียน", "รายละเอียด"],
      rows.results.map(e => [isoOf(e.created_at), e.user_name, e.user_email, EVENT_LABELS[e.type] || e.type, e.course_title, e.lesson_title, describeEvent(e)]));
    return csvResponse(csv, `events-${bkkDay(Date.now())}.csv`);
  }
  const limit = int(c.req.query("limit"), 50, 1, 100);
  const page = int(c.req.query("page"), 1, 1, 100000);
  const [rows, total] = await Promise.all([
    db.prepare(`${EVENT_SELECT} ${filters.where} ORDER BY ev.id DESC LIMIT ? OFFSET ?`).bind(...filters.binds, limit, (page - 1) * limit).all<EventRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM user_events ev LEFT JOIN users u ON u.id = ev.user_id ${filters.where}`).bind(...filters.binds).first<{ n: number }>()
  ]);
  return c.json({ events: rows.results.map(presentEvent), total: total?.n ?? 0, page, limit, types: EVENT_LABELS });
});

/**
 * GET /api/reports/courses?from&to&format=csv — enrolled, active (in range), completion rate,
 * average progress and learning time per course.
 */
analyticsRouter.get("/reports/courses", rbac(), async (c) => {
  const scope = await reportScope(c);
  if (!scope) return denied(c);
  const range = reportRange(c);
  if (!range) return c.json({ error: "ช่วงเวลาไม่ถูกต้อง" }, 400);
  const { from, to } = range;
  const binds: unknown[] = [from, to, from, to, from, to];
  const where = courseScope(scope, "co.id", binds);
  const rows = await c.env.DB.prepare(`SELECT co.id, co.title, co.status, iu.name AS instructor_name,
      (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = co.id) AS enrolled,
      (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = co.id AND (e.status = 'completed' OR e.progress_percent >= 100)) AS completed,
      (SELECT ROUND(AVG(e.progress_percent), 1) FROM enrollments e WHERE e.course_id = co.id) AS avg_progress,
      (SELECT COUNT(DISTINCT x.user_id) FROM (
          SELECT user_id FROM learning_time WHERE course_id = co.id AND seconds > 0 AND day BETWEEN ? AND ?
          UNION SELECT user_id FROM lesson_progress WHERE course_id = co.id AND ${dayOf("updated_at")} BETWEEN ? AND ?
          UNION SELECT user_id FROM user_events WHERE course_id = co.id AND user_id IS NOT NULL AND ${dayOf("created_at")} BETWEEN ? AND ?) x) AS active,
      (SELECT COALESCE(SUM(seconds), 0) FROM learning_time WHERE course_id = co.id) AS total_seconds
    FROM courses co LEFT JOIN users iu ON iu.id = co.instructor_id
    WHERE ${where} ORDER BY enrolled DESC, co.title LIMIT 500`).bind(...binds)
    .all<{ id: string; title: string; status: string; instructor_name: string | null; enrolled: number; completed: number; avg_progress: number | null; active: number; total_seconds: number }>();
  const courses = rows.results.map(r => ({
    ...r,
    avg_progress: r.avg_progress ?? 0,
    completion_rate: r.enrolled ? Math.round((r.completed / r.enrolled) * 1000) / 10 : 0,
    avg_seconds: r.enrolled ? Math.round(r.total_seconds / r.enrolled) : 0
  }));
  if (wantsCsv(c)) {
    return csvResponse(toCsv(["คอร์ส", "ผู้สอน", "สถานะ", "ผู้ลงทะเบียน", `ผู้เรียนที่ใช้งาน (${from} ถึง ${to})`, "เรียนจบ", "อัตราเรียนจบ (%)", "ความคืบหน้าเฉลี่ย (%)", "เวลาเรียนเฉลี่ย (ชั่วโมง)"],
      courses.map(r => [r.title, r.instructor_name, r.status, r.enrolled, r.active, r.completed, r.completion_rate, r.avg_progress, hours(r.avg_seconds)])),
      `course-report-${to}.csv`);
  }
  return c.json({ from, to, scope: scope.all ? "all" : "own", courses });
});

/** GET /api/reports/courses/:id — lesson drop-off and the learner list of one course. */
analyticsRouter.get("/reports/courses/:id", rbac(), async (c) => {
  const scope = await reportScope(c);
  if (!scope) return denied(c);
  const db = c.env.DB;
  const courseId = c.req.param("id");
  if (!validId(courseId)) return c.json({ error: "ไม่พบคอร์ส" }, 404);
  const course = await db.prepare("SELECT id, title, status, instructor_id FROM courses WHERE id = ?").bind(courseId)
    .first<{ id: string; title: string; status: string; instructor_id: string }>();
  if (!course) return c.json({ error: "ไม่พบคอร์ส" }, 404);
  if (!scope.all && course.instructor_id !== scope.instructorId) return c.json({ error: "ดูรายงานได้เฉพาะคอร์สของคุณ" }, 403);

  const [enrolled, lessons, learners] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?").bind(courseId).first<{ n: number }>(),
    db.prepare(`SELECT l.id, l.title, l.sort_order,
        (SELECT COUNT(DISTINCT x.user_id) FROM (SELECT user_id FROM lesson_progress WHERE lesson_id = l.id
           UNION SELECT user_id FROM user_events WHERE lesson_id = l.id AND user_id IS NOT NULL AND type IN ('lesson_view', 'lesson_complete')) x) AS reached,
        (SELECT COUNT(*) FROM lesson_progress lp WHERE lp.lesson_id = l.id AND lp.completed = 1) AS completed
      FROM lessons l WHERE l.course_id = ? ORDER BY l.sort_order, l.id`).bind(courseId)
      .all<{ id: string; title: string; sort_order: number; reached: number; completed: number }>(),
    db.prepare(`SELECT u.id, u.name, u.email, e.progress_percent, e.status, e.enrolled_at, e.completed_at,
        (SELECT COALESCE(SUM(seconds), 0) FROM learning_time lt WHERE lt.user_id = u.id AND lt.course_id = e.course_id) AS seconds,
        (SELECT MAX(lp.updated_at) FROM lesson_progress lp WHERE lp.user_id = u.id AND lp.course_id = e.course_id) AS last_progress,
        (SELECT MAX(ev.created_at) FROM user_events ev WHERE ev.user_id = u.id AND ev.course_id = e.course_id) AS last_event
      FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.course_id = ? ORDER BY e.enrolled_at DESC LIMIT 1000`).bind(courseId)
      .all<{ id: string; name: string; email: string; progress_percent: number; status: string; enrolled_at: string; completed_at: string | null; seconds: number; last_progress: string | null; last_event: string | null }>()
  ]);
  const total = enrolled?.n ?? 0;
  const dropoff = lessons.results.map(l => ({ ...l, reached_percent: total ? Math.round((l.reached / total) * 1000) / 10 : 0 }));
  const rows = learners.results.map(({ last_progress, last_event, ...r }) => ({
    ...r, last_activity: [isoOf(last_progress), isoOf(last_event)].filter(Boolean).sort().pop() ?? null
  }));
  if (wantsCsv(c)) {
    const section = c.req.query("section") === "learners" ? "learners" : "lessons";
    const csv = section === "lessons"
      ? toCsv(["ลำดับ", "บทเรียน", "ผู้เรียนที่มาถึง", "ร้อยละของผู้ลงทะเบียน", "เรียนจบบทนี้"], dropoff.map((l, i) => [i + 1, l.title, l.reached, l.reached_percent, l.completed]))
      : toCsv(["ชื่อ", "อีเมล", "ความคืบหน้า (%)", "สถานะ", "ลงทะเบียนเมื่อ", "เรียนจบเมื่อ", "เวลาเรียน (ชั่วโมง)", "ใช้งานล่าสุด"],
        rows.map(r => [r.name, r.email, r.progress_percent, r.status, isoOf(r.enrolled_at), isoOf(r.completed_at), hours(r.seconds), r.last_activity]));
    return csvResponse(csv, `course-${course.id}-${section}.csv`);
  }
  return c.json({ course: { id: course.id, title: course.title, status: course.status }, enrolled: total, lessons: dropoff, learners: rows });
});

/**
 * GET /api/reports/learners?q=&course_id=&page=&limit=&format=csv — per learner: courses, progress,
 * time, last activity, certificates. Instructors see only learners and figures of their own courses.
 */
analyticsRouter.get("/reports/learners", rbac(), async (c) => {
  const scope = await reportScope(c);
  if (!scope) return denied(c);
  const db = c.env.DB;
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  const courseId = (c.req.query("course_id") || "").trim();
  if (courseId && !validId(courseId)) return c.json({ error: "รหัสคอร์สไม่ถูกต้อง" }, 400);

  const whereBinds: unknown[] = [];
  const where: string[] = [courseScope(scope, "e.course_id", whereBinds)];
  if (q) { const like = likePattern(q); where.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')"); whereBinds.push(like, like); }
  if (courseId) { where.push("e.course_id = ?"); whereBinds.push(courseId); }
  const whereSql = where.join(" AND ");

  const selBinds: unknown[] = [];
  const ltScope = courseScope(scope, "lt.course_id", selBinds);
  const ceScope = courseScope(scope, "ce.course_id", selBinds);
  // Instructors only see activity inside their own courses, never platform-wide sign-ins or presence.
  const evScope = courseScope(scope, "ev.course_id", selBinds);
  const select = `SELECT u.id, u.name, u.email, u.created_at, ${scope.all ? "u.last_login_at" : "NULL AS last_login_at"},
      COUNT(e.id) AS courses,
      SUM(CASE WHEN e.status = 'completed' OR e.progress_percent >= 100 THEN 1 ELSE 0 END) AS completed,
      ROUND(AVG(e.progress_percent), 1) AS avg_progress,
      (SELECT COALESCE(SUM(lt.seconds), 0) FROM learning_time lt WHERE lt.user_id = u.id AND ${ltScope}) AS seconds,
      (SELECT COUNT(*) FROM certificates ce WHERE ce.user_id = u.id AND ce.revoked_at IS NULL AND ${ceScope}) AS certificates,
      ${scope.all ? "(SELECT p.last_seen_at FROM user_presence p WHERE p.user_id = u.id)" : "NULL"} AS last_seen_at,
      (SELECT MAX(ev.created_at) FROM user_events ev WHERE ev.user_id = u.id AND ${evScope}) AS last_event_at,
      GROUP_CONCAT(co.title, ' | ') AS course_titles
    FROM enrollments e JOIN users u ON u.id = e.user_id JOIN courses co ON co.id = e.course_id
    WHERE ${whereSql} GROUP BY u.id ORDER BY MAX(e.enrolled_at) DESC, u.name`;
  type Row = { id: string; name: string; email: string; created_at: string; last_login_at: string | null; courses: number; completed: number; avg_progress: number | null;
    seconds: number; certificates: number; last_seen_at: string | null; last_event_at: string | null; course_titles: string | null };
  const present = ({ last_seen_at, last_event_at, last_login_at, ...r }: Row) => ({
    ...r, avg_progress: r.avg_progress ?? 0,
    last_activity: [isoOf(last_seen_at), isoOf(last_event_at), isoOf(last_login_at)].filter(Boolean).sort().pop() ?? null
  });
  if (wantsCsv(c)) {
    const rows = await db.prepare(`${select} LIMIT 5000`).bind(...selBinds, ...whereBinds).all<Row>();
    return csvResponse(toCsv(["ชื่อ", "อีเมล", "จำนวนคอร์ส", "เรียนจบ", "ความคืบหน้าเฉลี่ย (%)", "เวลาเรียน (ชั่วโมง)", "ใบประกาศ", "ใช้งานล่าสุด", "คอร์ส"],
      rows.results.map(present).map(r => [r.name, r.email, r.courses, r.completed, r.avg_progress, hours(r.seconds), r.certificates, r.last_activity, r.course_titles])),
      `learner-report-${bkkDay(Date.now())}.csv`);
  }
  const limit = int(c.req.query("limit"), 50, 1, 100);
  const page = int(c.req.query("page"), 1, 1, 100000);
  const [rows, total] = await Promise.all([
    db.prepare(`${select} LIMIT ? OFFSET ?`).bind(...selBinds, ...whereBinds, limit, (page - 1) * limit).all<Row>(),
    db.prepare(`SELECT COUNT(DISTINCT u.id) AS n FROM enrollments e JOIN users u ON u.id = e.user_id WHERE ${whereSql}`).bind(...whereBinds).first<{ n: number }>()
  ]);
  return c.json({ learners: rows.results.map(present), total: total?.n ?? 0, page, limit, scope: scope.all ? "all" : "own" });
});

/**
 * GET /api/reports/revenue?from&to|range&group=day|month&format=csv&section=period|course|voucher|refunds
 * Paid course orders (amount received) and legacy completed payments; refunded orders are excluded
 * from revenue and listed separately. Instructors see only their own courses.
 */
analyticsRouter.get("/reports/revenue", rbac(), async (c) => {
  const scope = await reportScope(c);
  if (!scope) return denied(c);
  const range = reportRange(c);
  if (!range) return c.json({ error: "ช่วงเวลาไม่ถูกต้อง" }, 400);
  const group = c.req.query("group") === "month" ? "month" : c.req.query("group") === "day" ? "day" : range.bucket;
  const { from, to } = range;
  const db = c.env.DB;

  const sBinds: unknown[] = [from, to];
  const oScope = courseScope(scope, "o.course_id", sBinds);
  sBinds.push(from, to);
  const pScope = courseScope(scope, "p.course_id", sBinds);
  const sales = `
    SELECT 'order' AS source, o.id, o.reference, o.course_id, o.voucher_code, o.list_price, COALESCE(o.amount_received, o.amount) AS amt, o.paid_at AS at
      FROM course_orders o WHERE o.status = 'paid' AND o.paid_at IS NOT NULL AND ${dayOf("o.paid_at")} BETWEEN ? AND ? AND ${oScope}
    UNION ALL
    SELECT 'payment', p.id, p.provider_charge_id, p.course_id, p.voucher_code, NULL, p.amount, p.created_at
      FROM payments p WHERE p.status = 'completed' AND ${dayOf("p.created_at")} BETWEEN ? AND ? AND ${pScope}`;
  const rBinds: unknown[] = [from, to];
  const rScope = courseScope(scope, "o.course_id", rBinds);

  const [totals, byPeriod, byCourse, byVoucher, refunds] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amt), 0) AS revenue FROM (${sales})`).bind(...sBinds).first<{ count: number; revenue: number }>(),
    db.prepare(`SELECT ${bucketOf(group, "at")} AS k, COUNT(*) AS count, COALESCE(SUM(amt), 0) AS revenue FROM (${sales}) GROUP BY k ORDER BY k`).bind(...sBinds)
      .all<{ k: string; count: number; revenue: number }>(),
    db.prepare(`SELECT s.course_id, co.title AS course_title, COUNT(*) AS count, COALESCE(SUM(s.amt), 0) AS revenue FROM (${sales}) s
      LEFT JOIN courses co ON co.id = s.course_id GROUP BY s.course_id ORDER BY revenue DESC`).bind(...sBinds)
      .all<{ course_id: string; course_title: string | null; count: number; revenue: number }>(),
    db.prepare(`SELECT UPPER(voucher_code) AS voucher_code, COUNT(*) AS count, COALESCE(SUM(amt), 0) AS revenue,
        COALESCE(SUM(CASE WHEN list_price IS NOT NULL THEN list_price - amt ELSE 0 END), 0) AS discount
      FROM (${sales}) WHERE voucher_code IS NOT NULL AND voucher_code != '' GROUP BY UPPER(voucher_code) ORDER BY count DESC`).bind(...sBinds)
      .all<{ voucher_code: string; count: number; revenue: number; discount: number }>(),
    db.prepare(`SELECT o.id, o.reference, o.receipt_no, u.name AS user_name, u.email AS user_email, co.title AS course_title,
        COALESCE(o.amount_received, o.amount) AS amount, o.refunded_at, o.staff_note
      FROM course_orders o JOIN users u ON u.id = o.user_id LEFT JOIN courses co ON co.id = o.course_id
      WHERE o.status = 'refunded' AND o.refunded_at IS NOT NULL AND ${dayOf("o.refunded_at")} BETWEEN ? AND ? AND ${rScope}
      ORDER BY o.refunded_at DESC LIMIT 500`).bind(...rBinds).all<Record<string, any>>()
  ]);
  const periodMap = new Map(byPeriod.results.map(r => [r.k, r]));
  const periods = bucketKeys({ ...range, bucket: group }).map(k => ({ key: k, count: periodMap.get(k)?.count ?? 0, revenue: periodMap.get(k)?.revenue ?? 0 }));
  const refundTotal = refunds.results.reduce((s, r) => s + Number(r.amount || 0), 0);

  if (wantsCsv(c)) {
    const section = c.req.query("section") || "period";
    if (section === "course") return csvResponse(toCsv(["คอร์ส", "จำนวนขาย", "รายได้ (บาท)"], byCourse.results.map(r => [r.course_title || r.course_id, r.count, r.revenue])), `revenue-by-course-${from}-${to}.csv`);
    if (section === "voucher") return csvResponse(toCsv(["โค้ดส่วนลด", "จำนวนใช้", "รายได้ (บาท)", "ส่วนลดรวม (บาท)"], byVoucher.results.map(r => [r.voucher_code, r.count, r.revenue, r.discount])), `revenue-by-voucher-${from}-${to}.csv`);
    if (section === "refunds") return csvResponse(toCsv(["เลขอ้างอิง", "ใบเสร็จ", "ผู้ซื้อ", "อีเมล", "คอร์ส", "ยอด (บาท)", "คืนเงินเมื่อ", "หมายเหตุ"],
      refunds.results.map(r => [r.reference, r.receipt_no, r.user_name, r.user_email, r.course_title, r.amount, r.refunded_at, r.staff_note])), `refunds-${from}-${to}.csv`);
    return csvResponse(toCsv([group === "month" ? "เดือน" : "วันที่", "จำนวนขาย", "รายได้ (บาท)"], periods.map(p => [p.key, p.count, p.revenue])), `revenue-${from}-${to}.csv`);
  }
  return c.json({
    from, to, group, scope: scope.all ? "all" : "own",
    totals: { count: totals?.count ?? 0, revenue: totals?.revenue ?? 0, refunds_count: refunds.results.length, refunds_amount: refundTotal },
    by_period: periods, by_course: byCourse.results, by_voucher: byVoucher.results, refunds: refunds.results
  });
});

// ==========================================
// 4. Global search
// ==========================================

interface SearchHit { kind: string; id: string; title: string; subtitle?: string; target: { tab: string; id?: string } }

/** Menu shortcuts and help pages: [label, keywords, tab, permissions (any) | roles]. */
const SHORTCUTS: Array<{ label: string; keywords: string; tab: string; perms?: string[]; roles?: string[] }> = [
  { label: "แดชบอร์ดโรงเรียน", keywords: "dashboard analytics kpi ภาพรวม สถิติ แดชบอร์ด", tab: "analytics", perms: ["reports.view"] },
  { label: "รายงาน", keywords: "reports report รายงาน คอร์ส ผู้เรียน รายได้ csv", tab: "reports", perms: ["reports.view"], roles: ["instructor"] },
  { label: "บันทึกกิจกรรม", keywords: "events log กิจกรรม ประวัติ", tab: "reports", perms: ["reports.view"], roles: ["instructor"] },
  { label: "ผู้ใช้และสิทธิ์", keywords: "users accounts ผู้ใช้ บัญชี สิทธิ์ บทบาท", tab: "users", perms: ["users.view", "users.manage"] },
  { label: "คำสั่งซื้อและการชำระเงิน", keywords: "orders payments คำสั่งซื้อ ชำระเงิน ใบเสร็จ คืนเงิน", tab: "orders", perms: ["payments.manage"] },
  { label: "ตรวจและเผยแพร่คอร์ส", keywords: "courses approve review คอร์ส อนุมัติ เผยแพร่", tab: "courses", perms: ["courses.approve"] },
  { label: "ใบประกาศ", keywords: "certificates ใบประกาศ เพิกถอน", tab: "certificates", perms: ["certificates.manage"] },
  { label: "บทความ", keywords: "articles blog บทความ notion", tab: "articles", perms: ["articles.write", "articles.publish", "articles.manage"] },
  { label: "เว็บไซต์และรอบอบรม", keywords: "site sessions training เว็บไซต์ รอบอบรม ผู้สมัคร โปรโมชั่น", tab: "site", perms: ["site.dashboard", "site.sessions", "site.settings"] },
  { label: "คำขอข้อมูลส่วนบุคคล", keywords: "privacy pdpa ข้อมูลส่วนบุคคล ลบบัญชี", tab: "privacy", perms: ["privacy.manage"] },
  { label: "คอนโซลผู้สอน", keywords: "instructor teach ผู้สอน สอน บทเรียน", tab: "instructor", roles: ["instructor", "admin"] },
  { label: "คอร์สของฉัน", keywords: "my courses learn เรียน คอร์สของฉัน", tab: "dashboard", roles: ["student"] },
  { label: "โปรไฟล์และรหัสผ่าน", keywords: "profile password โปรไฟล์ รหัสผ่าน บัญชีของฉัน", tab: "profile" }
];

/**
 * GET /api/search?q= — returns only what the caller may see: users (users.view), courses (all for
 * approvers/admins, own for instructors, published or enrolled for learners), articles (articles.*),
 * orders (payments.manage), training sessions (site.sessions) and menu shortcuts.
 */
analyticsRouter.get("/search", rbac(), async (c) => {
  const q = (c.req.query("q") || "").trim();
  if (q.length < 2) return c.json({ q, results: [] });
  if (q.length > 100) return c.json({ error: "คำค้นยาวเกินไป" }, 400);
  const db = c.env.DB;
  const user = c.get("user");
  const perms = await currentPermissions(c);
  const roles = user.roles as string[];
  const isAdmin = roles.includes("admin");
  const like = likePattern(q);
  const results: SearchHit[] = [];
  const tasks: Promise<void>[] = [];

  if (perms.has("users.view") || perms.has("users.manage")) {
    tasks.push(db.prepare(`SELECT id, name, email FROM users WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' ORDER BY name LIMIT 6`)
      .bind(like, like).all<{ id: string; name: string; email: string }>()
      .then(r => { for (const u of r.results) results.push({ kind: "user", id: u.id, title: u.name, subtitle: u.email, target: { tab: "users", id: u.id } }); }));
  }

  // Courses: union of every scope the account holds; the target tab follows the strongest scope.
  const approver = isAdmin || perms.has("courses.approve");
  const instructor = roles.includes("instructor");
  tasks.push(db.prepare(`SELECT co.id, co.title, co.status, co.instructor_id,
        EXISTS (SELECT 1 FROM enrollments e WHERE e.course_id = co.id AND e.user_id = ?) AS enrolled
      FROM courses co WHERE co.title LIKE ? ESCAPE '\\'
        AND (? = 1 OR (? = 1 AND co.instructor_id = ?) OR co.status = 'published'
             OR EXISTS (SELECT 1 FROM enrollments e WHERE e.course_id = co.id AND e.user_id = ?))
      ORDER BY co.title LIMIT 8`)
    .bind(user.id, like, approver ? 1 : 0, instructor ? 1 : 0, user.id, user.id)
    .all<{ id: string; title: string; status: string; instructor_id: string; enrolled: number }>()
    .then(r => {
      for (const co of r.results) {
        const tab = approver ? "courses" : instructor && co.instructor_id === user.id ? "instructor" : "dashboard";
        results.push({ kind: "course", id: co.id, title: co.title, subtitle: co.enrolled ? "ลงทะเบียนแล้ว" : co.status === "published" ? "เผยแพร่แล้ว" : "ยังไม่เผยแพร่", target: { tab, id: co.id } });
      }
    }));

  if (perms.has("articles.manage") || perms.has("articles.publish") || perms.has("articles.write")) {
    const all = perms.has("articles.manage") || perms.has("articles.publish");
    tasks.push(db.prepare(`SELECT id, title, status FROM articles WHERE (title LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\') AND (? = 1 OR author_id = ?)
        ORDER BY updated_at DESC LIMIT 6`).bind(like, like, all ? 1 : 0, user.id).all<{ id: string; title: string; status: string }>()
      .then(r => { for (const a of r.results) results.push({ kind: "article", id: a.id, title: a.title, subtitle: a.status === "published" ? "เผยแพร่แล้ว" : a.status === "review" ? "รอตรวจ" : "ฉบับร่าง", target: { tab: "articles", id: a.id } }); }));
  }

  if (perms.has("payments.manage")) {
    tasks.push(db.prepare(`SELECT o.id, o.reference, o.status, o.amount, u.name AS user_name, u.email AS user_email FROM course_orders o JOIN users u ON u.id = o.user_id
        WHERE o.reference LIKE ? ESCAPE '\\' OR o.receipt_no LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\'
        ORDER BY o.created_at DESC LIMIT 6`).bind(like, like, like, like)
      .all<{ id: string; reference: string; status: string; amount: number; user_name: string; user_email: string }>()
      .then(r => { for (const o of r.results) results.push({ kind: "order", id: o.id, title: `${o.reference} · ${o.user_name}`, subtitle: `${o.user_email} · ฿${o.amount.toLocaleString("en-US")}`, target: { tab: "orders", id: o.id } }); }));
  }

  if (perms.has("site.sessions")) {
    tasks.push(db.prepare(`SELECT id, title, start_date, status FROM training_sessions WHERE title LIKE ? ESCAPE '\\' OR vendor LIKE ? ESCAPE '\\'
        ORDER BY start_date DESC LIMIT 6`).bind(like, like).all<{ id: string; title: string; start_date: string; status: string }>()
      .then(r => { for (const s of r.results) results.push({ kind: "session", id: s.id, title: s.title, subtitle: `รอบอบรม ${s.start_date}`, target: { tab: "site", id: s.id } }); }));
  }

  await Promise.all(tasks);
  const needle = q.toLowerCase();
  for (const s of SHORTCUTS) {
    const allowed = isAdmin || (!s.perms && !s.roles) || s.perms?.some(p => perms.has(p as any)) || s.roles?.some(r => roles.includes(r));
    if (allowed && (s.label.toLowerCase().includes(needle) || s.keywords.toLowerCase().includes(needle))) {
      results.push({ kind: "page", id: `page:${s.tab}:${s.label}`, title: s.label, subtitle: "เมนู", target: { tab: s.tab } });
    }
  }
  const order = ["page", "course", "user", "order", "article", "session"];
  results.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return c.json({ q, results });
});
