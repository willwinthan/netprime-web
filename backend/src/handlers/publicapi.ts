import { Hono, Context } from "hono";
import { apiKey, ApiEnv, API_SCOPES } from "../middleware/apikey";
import { issueAccountToken } from "../utils/tokens";
import { appUrl, sendInvitationEmail } from "../utils/email";
import { trackEvent } from "../utils/events";

/**
 * Public REST API v1 (/api/v1) for integrations (Zapier, Make, HR systems).
 * Authenticated with school API keys (middleware/apikey.ts); every route names the scope it needs.
 * Lists use cursor pagination: ?limit=1..200 (default 50) and ?cursor=<next_cursor>; responses are
 * { data: [...], next_cursor: string | null }. Errors are { error, code }.
 */
export const publicApiRouter = new Hono<ApiEnv>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function encodeCursor(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeCursor(value: string | undefined): string | null | false {
  if (!value) return null;
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try { return atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)); } catch { return false; }
}

/** Cursor = the last row's id (all v1 lists are ordered by id). */
function page(c: Context<ApiEnv>): { limit: number; after: string } | Response {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);
  const cursor = decodeCursor(c.req.query("cursor"));
  if (cursor === false) return c.json({ error: "cursor ไม่ถูกต้อง", code: "invalid_cursor" }, 400);
  return { limit, after: cursor ?? "" };
}

function listResponse<T extends { id: string }>(c: Context<ApiEnv>, rows: T[], limit: number) {
  const more = rows.length > limit;
  const data = more ? rows.slice(0, limit) : rows;
  return c.json({ data, next_cursor: more ? encodeCursor(data[data.length - 1].id) : null });
}

const USER_FIELDS = `u.id, u.email, u.name, COALESCE(u.staff_role, u.role) AS role,
  (SELECT GROUP_CONCAT(role) FROM user_roles WHERE user_id = u.id) AS roles, u.status, u.partner_id,
  u.created_at, u.last_login_at, CASE WHEN u.email_verified_at IS NULL THEN 0 ELSE 1 END AS email_verified`;

function shapeUser(row: Record<string, any>) {
  return { ...row, roles: row.roles ? String(row.roles).split(",") : [row.role], email_verified: !!row.email_verified };
}

publicApiRouter.get("/openapi.json", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json(openApiDocument(new URL(c.req.url).origin));
});

// ---------- Users ----------

publicApiRouter.get("/users", apiKey("users:read"), async (c) => {
  const p = page(c);
  if (p instanceof Response) return p;
  const email = c.req.query("email")?.trim().toLowerCase();
  const rows = await c.env.DB.prepare(`SELECT ${USER_FIELDS} FROM users u WHERE u.id > ? ${email ? "AND u.email = ?" : ""} ORDER BY u.id LIMIT ?`)
    .bind(...[p.after, ...(email ? [email] : []), p.limit + 1]).all<Record<string, any> & { id: string }>();
  return listResponse(c, rows.results.map(r => shapeUser(r) as any), p.limit);
});

publicApiRouter.get("/users/:id", apiKey("users:read"), async (c) => {
  const row = await c.env.DB.prepare(`SELECT ${USER_FIELDS} FROM users u WHERE u.id = ?`).bind(c.req.param("id")).first<Record<string, any>>();
  if (!row) return c.json({ error: "ไม่พบผู้ใช้", code: "not_found" }, 404);
  return c.json({ data: shapeUser(row) });
});

/** Creates a student account and emails an invitation link to set a password. */
publicApiRouter.post("/users", apiKey("users:write"), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!EMAIL_RE.test(email) || email.length > 254 || !name || name.length > 120) {
    return c.json({ error: "ต้องระบุ email ที่ถูกต้องและ name (ไม่เกิน 120 ตัวอักษร)", code: "invalid_request" }, 400);
  }
  const tags = Array.isArray(body?.tags) ? body!.tags.map(t => String(t).trim()).filter(Boolean) : [];
  if (tags.length > 20 || tags.some(t => t.length > 40)) return c.json({ error: "tags สูงสุด 20 รายการ ยาวไม่เกิน 40 ตัวอักษร", code: "invalid_request" }, 400);
  const sendInvite = body?.send_invite !== false;
  const db = c.env.DB;
  const id = "usr_" + crypto.randomUUID();
  try {
    await db.batch([
      // Unusable hash: the account can only sign in after setting a password from the invitation.
      db.prepare("INSERT INTO users (id, email, password_hash, name, role, partner_id) VALUES (?, ?, ?, ?, 'student', NULL)")
        .bind(id, email, `pbkdf2-sha256$unusable$${crypto.randomUUID().replace(/-/g, "")}`, name),
      ...tags.map(tag => db.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, ?)").bind(id, tag))
    ]);
  } catch (error: any) {
    if (String(error?.message || "").includes("UNIQUE constraint failed")) return c.json({ error: "อีเมลนี้มีบัญชีอยู่แล้ว", code: "conflict" }, 409);
    throw error;
  }
  let inviteUrl: string | null = null;
  if (sendInvite) {
    inviteUrl = appUrl(c.env, `/reset-password?token=${await issueAccountToken(db, id, "invite")}&invite=1`);
    const task = sendInvitationEmail(email, name, c.get("apiKey").name, inviteUrl, c.env.RESEND_API_KEY, db).catch(err => console.error("API invite email failed", err));
    try { c.executionCtx.waitUntil(task); } catch { await task; }
  }
  await trackEvent(db, id, "signup", { data: { method: "api", api_key_id: c.get("apiKey").id } });
  const row = await db.prepare(`SELECT ${USER_FIELDS} FROM users u WHERE u.id = ?`).bind(id).first<Record<string, any>>();
  return c.json({
    data: shapeUser(row!), invited: sendInvite,
    ...(inviteUrl && c.env.ALLOW_LOCAL_SEED_PASSWORDS === "true" ? { debug_url: inviteUrl } : {})
  }, 201);
});

// ---------- Courses ----------

publicApiRouter.get("/courses", apiKey("courses:read"), async (c) => {
  const p = page(c);
  if (p instanceof Response) return p;
  const rows = await c.env.DB.prepare(`SELECT c.id, c.title, c.description, c.price, c.category_id, c.cover_image_url, c.access_duration_days,
      c.published_at, c.created_at, u.name AS instructor_name,
      (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count
    FROM courses c LEFT JOIN users u ON u.id = c.instructor_id
    WHERE c.status = 'published' AND c.id > ? ORDER BY c.id LIMIT ?`).bind(p.after, p.limit + 1).all<{ id: string }>();
  return listResponse(c, rows.results, p.limit);
});

// ---------- Enrollments ----------

const ENROLLMENT_FIELDS = "e.id, e.user_id, e.course_id, e.status, e.progress_percent, e.enrolled_at, e.completed_at, e.expires_at, e.partner_id";

publicApiRouter.get("/enrollments", apiKey("enrollments:read"), async (c) => {
  const p = page(c);
  if (p instanceof Response) return p;
  const filters: string[] = ["e.id > ?"];
  const binds: unknown[] = [p.after];
  for (const key of ["user_id", "course_id", "status"] as const) {
    const value = c.req.query(key);
    if (value) { filters.push(`e.${key} = ?`); binds.push(value.slice(0, 100)); }
  }
  const rows = await c.env.DB.prepare(`SELECT ${ENROLLMENT_FIELDS} FROM enrollments e WHERE ${filters.join(" AND ")} ORDER BY e.id LIMIT ?`)
    .bind(...binds, p.limit + 1).all<{ id: string }>();
  return listResponse(c, rows.results, p.limit);
});

/**
 * Enrolls a user (by user_id or email) in a published course. Idempotent: one enrollment per
 * learner and course (UNIQUE index); an existing suspended enrollment is re-activated.
 * 201 when created, 200 when it already existed.
 */
publicApiRouter.post("/enrollments", apiKey("enrollments:write"), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const courseId = typeof body?.course_id === "string" ? body.course_id.trim() : "";
  const userId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!courseId || (!userId && !email)) return c.json({ error: "ต้องระบุ course_id และ user_id หรือ email", code: "invalid_request" }, 400);
  let expiresAt: string | null = null;
  if (body?.expires_at != null) {
    const ms = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (!Number.isFinite(ms) || ms < Date.now()) return c.json({ error: "expires_at ต้องเป็นวันเวลา ISO ในอนาคต", code: "invalid_request" }, 400);
    expiresAt = new Date(ms).toISOString();
  }
  const db = c.env.DB;
  const course = await db.prepare("SELECT id, status, access_duration_days FROM courses WHERE id = ?").bind(courseId).first<{ id: string; status: string; access_duration_days: number | null }>();
  if (!course) return c.json({ error: "ไม่พบคอร์ส", code: "not_found" }, 404);
  if (course.status !== "published") return c.json({ error: "ลงทะเบียนได้เฉพาะคอร์สที่เผยแพร่แล้ว", code: "course_not_published" }, 422);
  const user = await db.prepare(`SELECT id, status, partner_id FROM users WHERE ${userId ? "id" : "email"} = ?`).bind(userId || email)
    .first<{ id: string; status: string; partner_id: string | null }>();
  if (!user) return c.json({ error: "ไม่พบผู้ใช้", code: "not_found" }, 404);
  if (user.status !== "active") return c.json({ error: "บัญชีผู้ใช้นี้ถูกระงับ", code: "user_suspended" }, 422);
  if (!expiresAt && course.access_duration_days) expiresAt = new Date(Date.now() + course.access_duration_days * 86_400_000).toISOString();
  const existing = await db.prepare("SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?").bind(user.id, course.id).first<{ id: string }>();
  await db.prepare(`INSERT INTO enrollments (id, user_id, course_id, progress_percent, status, expires_at, partner_id)
      VALUES (?, ?, ?, 0, 'active', ?, NULL)
      ON CONFLICT(user_id, course_id) DO UPDATE SET
        status = CASE WHEN enrollments.status = 'suspended' THEN 'active' ELSE enrollments.status END,
        expires_at = CASE WHEN excluded.expires_at IS NOT NULL AND (enrollments.expires_at IS NULL OR enrollments.expires_at < excluded.expires_at)
          THEN excluded.expires_at ELSE enrollments.expires_at END`)
    .bind("enr_" + crypto.randomUUID(), user.id, course.id, expiresAt).run();
  if (!existing) await trackEvent(db, user.id, "enroll", { courseId: course.id, data: { method: "api", api_key_id: c.get("apiKey").id } });
  const row = await db.prepare(`SELECT ${ENROLLMENT_FIELDS} FROM enrollments e WHERE e.user_id = ? AND e.course_id = ?`).bind(user.id, course.id).first();
  return c.json({ data: row, created: !existing }, existing ? 200 : 201);
});

// ---------- Orders ----------

publicApiRouter.get("/orders", apiKey("orders:read"), async (c) => {
  const p = page(c);
  if (p instanceof Response) return p;
  const status = c.req.query("status");
  const rows = await c.env.DB.prepare(`SELECT o.id, o.reference, o.user_id, o.course_id, o.list_price, o.amount, o.voucher_code, o.status,
      o.paid_at, o.receipt_no, o.refunded_at, o.created_at, o.updated_at
    FROM course_orders o WHERE o.id > ? ${status ? "AND o.status = ?" : ""} ORDER BY o.id LIMIT ?`)
    .bind(...[p.after, ...(status ? [status.slice(0, 20)] : []), p.limit + 1]).all<{ id: string }>();
  return listResponse(c, rows.results, p.limit);
});

publicApiRouter.notFound(c => c.json({ error: "ไม่พบ endpoint นี้ใน API v1", code: "not_found" }, 404));

// ---------- OpenAPI ----------

function openApiDocument(origin: string) {
  const list = (ref: string) => ({
    type: "object",
    properties: { data: { type: "array", items: { $ref: `#/components/schemas/${ref}` } }, next_cursor: { type: "string", nullable: true } }
  });
  const paging = [
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
    { name: "cursor", in: "query", schema: { type: "string" }, description: "next_cursor จากหน้าก่อนหน้า" }
  ];
  const errors = {
    "401": { description: "ไม่มีหรือ API key ไม่ถูกต้อง", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    "403": { description: "key ไม่มี scope ที่ต้องใช้", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    "429": { description: "เกินอัตราที่กำหนดต่อนาทีของ key" }
  };
  const op = (summary: string, scope: string, extra: Record<string, unknown>) => ({ summary, security: [{ apiKey: [] }], "x-required-scope": scope, ...extra, responses: { ...(extra.responses as object), ...errors } });
  return {
    openapi: "3.0.3",
    info: { title: "NetPrime LMS API", version: "1.0.0", description: "REST API สำหรับเชื่อมต่อระบบภายนอก ใช้ API key ที่สร้างในหน้า ตั้งค่า → API keys" },
    servers: [{ url: `${origin}/api/v1` }],
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "Authorization: Bearer npk_…" } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" }, code: { type: "string" } } },
        User: { type: "object", properties: { id: { type: "string" }, email: { type: "string" }, name: { type: "string" }, role: { type: "string" }, roles: { type: "array", items: { type: "string" } }, status: { type: "string" }, partner_id: { type: "string", nullable: true }, email_verified: { type: "boolean" }, created_at: { type: "string" }, last_login_at: { type: "string", nullable: true } } },
        Course: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, description: { type: "string", nullable: true }, price: { type: "number" }, category_id: { type: "string", nullable: true }, instructor_name: { type: "string", nullable: true }, lesson_count: { type: "integer" }, published_at: { type: "string", nullable: true } } },
        Enrollment: { type: "object", properties: { id: { type: "string" }, user_id: { type: "string" }, course_id: { type: "string" }, status: { type: "string", enum: ["active", "suspended", "completed"] }, progress_percent: { type: "integer" }, enrolled_at: { type: "string" }, completed_at: { type: "string", nullable: true }, expires_at: { type: "string", nullable: true } } },
        Order: { type: "object", properties: { id: { type: "string" }, reference: { type: "string" }, user_id: { type: "string" }, course_id: { type: "string" }, amount: { type: "number" }, status: { type: "string" }, paid_at: { type: "string", nullable: true }, receipt_no: { type: "string", nullable: true }, created_at: { type: "string" } } }
      }
    },
    "x-scopes": API_SCOPES,
    paths: {
      "/users": {
        get: op("รายชื่อผู้ใช้", "users:read", { parameters: [...paging, { name: "email", in: "query", schema: { type: "string" } }], responses: { "200": { description: "OK", content: { "application/json": { schema: list("User") } } } } }),
        post: op("สร้างผู้ใช้และส่งคำเชิญ", "users:write", {
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email", "name"], properties: { email: { type: "string" }, name: { type: "string" }, tags: { type: "array", items: { type: "string" } }, send_invite: { type: "boolean", default: true } } } } } },
          responses: { "201": { description: "สร้างแล้ว" }, "409": { description: "อีเมลซ้ำ" } }
        })
      },
      "/users/{id}": { get: op("ข้อมูลผู้ใช้", "users:read", { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" }, "404": { description: "ไม่พบ" } } }) },
      "/courses": { get: op("คอร์สที่เผยแพร่แล้ว", "courses:read", { parameters: paging, responses: { "200": { description: "OK", content: { "application/json": { schema: list("Course") } } } } }) },
      "/enrollments": {
        get: op("การลงทะเบียนเรียน", "enrollments:read", { parameters: [...paging, ...["user_id", "course_id", "status"].map(name => ({ name, in: "query", schema: { type: "string" } }))], responses: { "200": { description: "OK", content: { "application/json": { schema: list("Enrollment") } } } } }),
        post: op("ลงทะเบียนผู้เรียนเข้าคอร์ส (idempotent)", "enrollments:write", {
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["course_id"], properties: { course_id: { type: "string" }, user_id: { type: "string" }, email: { type: "string" }, expires_at: { type: "string", format: "date-time" } } } } } },
          responses: { "201": { description: "ลงทะเบียนใหม่" }, "200": { description: "มีอยู่แล้ว" }, "422": { description: "คอร์สยังไม่เผยแพร่" } }
        })
      },
      "/orders": { get: op("คำสั่งซื้อคอร์ส", "orders:read", { parameters: [...paging, { name: "status", in: "query", schema: { type: "string" } }], responses: { "200": { description: "OK", content: { "application/json": { schema: list("Order") } } } } }) }
    }
  };
}
