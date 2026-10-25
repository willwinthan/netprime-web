import { Hono, Context } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { hashPassword } from "../utils/crypto";
import { currentPermissions, isRole, permit, primaryRole, Role, ROLE_INFO, sortRoles, storedRole } from "../utils/permissions";
import { countSegment, normalizeTag, parseSegmentRules, resolveSegmentUserIds, segmentWhere, SegmentRules } from "../utils/segments";
import { parseCsv, toCsv } from "../utils/csv";
import {
  activeAdmins, audit, BEYOND_ACTOR, EMAIL_RE, loadAccount, organizationRule, sendInvite, targetRoles, withinActorPermissions
} from "./accounts";

/**
 * People management (mounted at /api): CSV import, tags, saved segments, custom profile fields,
 * the user 360 page, staff notes and bulk actions. Account CRUD itself lives in accounts.ts.
 */
export const peopleRouter = new Hono<Env>();

peopleRouter.use("/admin/people/*", rbac());
peopleRouter.use("/admin/people-meta", rbac());
peopleRouter.use("/admin/tags", rbac());
peopleRouter.use("/admin/segments", rbac());
peopleRouter.use("/admin/segments/*", rbac());
peopleRouter.use("/admin/profile-fields", rbac());
peopleRouter.use("/admin/profile-fields/*", rbac());
peopleRouter.use("/me/profile-fields", rbac());

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const ADMIN_ONLY_TARGET = "เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการบัญชีผู้ดูแลระบบได้";
const isAdmin = (c: Context<Env>) => c.get("user").roles.includes("admin");

function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}

// ==========================================
// Custom profile fields
// ==========================================

type FieldType = "text" | "number" | "date" | "select" | "checkbox";
type Visibility = "signup" | "profile" | "admin";
interface FieldRow { id: string; key: string; label: string; type: FieldType; options_json: string | null; required: number; visibility: Visibility; sort_order: number }
export interface ProfileField { id: string; key: string; label: string; type: FieldType; options: string[]; required: boolean; visibility: Visibility; sort_order: number }

const FIELD_TYPES: FieldType[] = ["text", "number", "date", "select", "checkbox"];
const VISIBILITIES: Visibility[] = ["signup", "profile", "admin"];
const toField = (r: FieldRow): ProfileField => ({
  id: r.id, key: r.key, label: r.label, type: r.type, options: r.options_json ? JSON.parse(r.options_json) : [],
  required: !!r.required, visibility: r.visibility, sort_order: r.sort_order
});

async function loadFields(db: D1Database): Promise<ProfileField[]> {
  const rows = await db.prepare("SELECT * FROM profile_fields ORDER BY sort_order, created_at").all<FieldRow>();
  return rows.results.map(toField);
}

const TRUE_WORDS = ["1", "true", "yes", "y", "ใช่", "x", "on"];
const FALSE_WORDS = ["0", "false", "no", "n", "ไม่", "ไม่ใช่", "off"];

/**
 * Validates one value for a field. Empty means "no value" (null). Returns the stored string or an error.
 * Checkboxes store "1"/"0"; dates YYYY-MM-DD; numbers their canonical form.
 */
export function fieldValue(field: ProfileField, raw: unknown): { value: string | null } | { error: string } {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return { value: null };
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : null;
  if (text === null) return { error: `${field.label}: รูปแบบไม่ถูกต้อง` };
  switch (field.type) {
    case "text":
      return text.length <= 500 ? { value: text } : { error: `${field.label}: ยาวเกิน 500 ตัวอักษร` };
    case "number": {
      const n = Number(text.replace(/,/g, ""));
      return Number.isFinite(n) ? { value: String(n) } : { error: `${field.label}: ต้องเป็นตัวเลข` };
    }
    case "date": {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text + "T00:00:00Z"))
        && new Date(text + "T00:00:00Z").toISOString().slice(0, 10) === text;
      return ok ? { value: text } : { error: `${field.label}: วันที่ต้องอยู่ในรูปแบบ YYYY-MM-DD` };
    }
    case "select":
      return field.options.includes(text) ? { value: text } : { error: `${field.label}: ต้องเป็นหนึ่งใน ${field.options.join(", ")}` };
    case "checkbox": {
      const lower = text.toLowerCase();
      if (TRUE_WORDS.includes(lower)) return { value: "1" };
      if (FALSE_WORDS.includes(lower)) return { value: "0" };
      return { error: `${field.label}: ต้องเป็น ใช่/ไม่ใช่ (1/0)` };
    }
  }
}

function parseFieldInput(body: Record<string, unknown>, existing?: ProfileField): Omit<ProfileField, "id"> | string {
  const key = body.key === undefined && existing ? existing.key : typeof body.key === "string" ? body.key.trim().toLowerCase() : "";
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) return "รหัสฟิลด์ต้องเป็นภาษาอังกฤษตัวเล็ก ตัวเลข หรือ _ (2–40 ตัว ขึ้นต้นด้วยตัวอักษร)";
  if (["email", "name", "roles", "organization", "tags", "password", "courses"].includes(key)) return "รหัสฟิลด์นี้สงวนไว้สำหรับคอลัมน์มาตรฐาน";
  const label = body.label === undefined && existing ? existing.label : typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 80) return "กรุณากรอกชื่อฟิลด์ (ไม่เกิน 80 ตัวอักษร)";
  const type = (body.type === undefined && existing ? existing.type : body.type) as FieldType;
  if (!FIELD_TYPES.includes(type)) return "ชนิดฟิลด์ไม่ถูกต้อง";
  const visibility = (body.visibility === undefined ? existing?.visibility ?? "profile" : body.visibility) as Visibility;
  if (!VISIBILITIES.includes(visibility)) return "การแสดงผลของฟิลด์ไม่ถูกต้อง";
  const rawOptions = body.options === undefined ? existing?.options ?? [] : body.options;
  if (!Array.isArray(rawOptions) || rawOptions.length > 50 || !rawOptions.every(o => typeof o === "string" && o.trim() && o.length <= 80)) return "ตัวเลือกไม่ถูกต้อง";
  const options = type === "select" ? Array.from(new Set((rawOptions as string[]).map(o => o.trim()))) : [];
  if (type === "select" && options.length < 1) return "ฟิลด์แบบตัวเลือกต้องมีตัวเลือกอย่างน้อย 1 ข้อ";
  const required = body.required === undefined ? existing?.required ?? false : body.required === true;
  const sortRaw = body.sort_order === undefined ? existing?.sort_order ?? 0 : Number(body.sort_order);
  const sort_order = Number.isInteger(sortRaw) ? Math.max(-1000, Math.min(1000, sortRaw)) : 0;
  return { key, label, type, options, required, visibility, sort_order };
}

peopleRouter.get("/admin/profile-fields", permit("users.view", "users.import"), async (c) => c.json({ fields: await loadFields(c.env.DB) }));

peopleRouter.post("/admin/profile-fields", permit("users.import"), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const field = parseFieldInput(body);
  if (typeof field === "string") return c.json({ error: field }, 400);
  const id = newId("pf");
  try {
    await c.env.DB.prepare(`INSERT INTO profile_fields (id, key, label, type, options_json, required, visibility, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, field.key, field.label, field.type, field.options.length ? JSON.stringify(field.options) : null, field.required ? 1 : 0, field.visibility, field.sort_order).run();
  } catch (error: any) {
    if (String(error?.message).includes("UNIQUE")) return c.json({ error: "มีฟิลด์รหัสนี้อยู่แล้ว" }, 409);
    throw error;
  }
  await audit(c, "create", "profile_field", id, { key: field.key, type: field.type });
  return c.json({ field: { id, ...field } }, 201);
});

peopleRouter.patch("/admin/profile-fields/:id", permit("users.import"), async (c) => {
  const db = c.env.DB;
  const row = await db.prepare("SELECT * FROM profile_fields WHERE id = ?").bind(c.req.param("id")).first<FieldRow>();
  if (!row) return c.json({ error: "ไม่พบฟิลด์" }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const existing = toField(row);
  // The key and type are fixed once values exist (stored values would no longer match).
  const field = parseFieldInput({ ...body, key: existing.key, type: existing.type }, existing);
  if (typeof field === "string") return c.json({ error: field }, 400);
  await db.prepare("UPDATE profile_fields SET label = ?, options_json = ?, required = ?, visibility = ?, sort_order = ? WHERE id = ?")
    .bind(field.label, field.options.length ? JSON.stringify(field.options) : null, field.required ? 1 : 0, field.visibility, field.sort_order, row.id).run();
  await audit(c, "update", "profile_field", row.id, { key: field.key });
  return c.json({ field: { id: row.id, ...field } });
});

peopleRouter.delete("/admin/profile-fields/:id", permit("users.import"), async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const result = await db.batch([
    db.prepare("DELETE FROM user_profile_values WHERE field_id = ?").bind(id),
    db.prepare("DELETE FROM profile_fields WHERE id = ?").bind(id)
  ]);
  if (!result[1].meta.changes) return c.json({ error: "ไม่พบฟิลด์" }, 404);
  await audit(c, "delete", "profile_field", id);
  return c.json({ message: "ลบฟิลด์และค่าที่บันทึกไว้แล้ว" });
});

/** Fields shown on the public signup form (no sign-in needed). */
peopleRouter.get("/profile-fields/signup", async (c) => {
  const fields = (await loadFields(c.env.DB)).filter(f => f.visibility === "signup");
  return c.json({ fields });
});

async function valuesOf(db: D1Database, userId: string): Promise<Record<string, string>> {
  const rows = await db.prepare("SELECT field_id, value FROM user_profile_values WHERE user_id = ?").bind(userId).all<{ field_id: string; value: string }>();
  return Object.fromEntries(rows.results.map(r => [r.field_id, r.value]));
}

/** Applies { key: value } for the given fields; errors are collected per field. */
function planValues(fields: ProfileField[], input: Record<string, unknown>, current: Record<string, string>, enforceRequired: boolean) {
  const errors: string[] = [];
  const writes: Array<{ field: ProfileField; value: string | null }> = [];
  for (const [key, raw] of Object.entries(input)) {
    const field = fields.find(f => f.key === key || f.id === key);
    if (!field) { errors.push(`ไม่พบฟิลด์ ${key}`); continue; }
    const parsed = fieldValue(field, raw);
    if ("error" in parsed) { errors.push(parsed.error); continue; }
    writes.push({ field, value: parsed.value });
  }
  const after = { ...current };
  for (const w of writes) { if (w.value === null) delete after[w.field.id]; else after[w.field.id] = w.value; }
  for (const f of fields) {
    // A required field cannot be cleared; on self-service forms it must also be filled in.
    const cleared = writes.some(w => w.field.id === f.id && w.value === null);
    if (f.required && !after[f.id] && (enforceRequired || cleared)) errors.push(`${f.label}: จำเป็นต้องกรอก`);
  }
  return { errors, writes };
}

function valueStatements(db: D1Database, userId: string, writes: Array<{ field: ProfileField; value: string | null }>) {
  return writes.map(w => w.value === null
    ? db.prepare("DELETE FROM user_profile_values WHERE user_id = ? AND field_id = ?").bind(userId, w.field.id)
    : db.prepare(`INSERT INTO user_profile_values (user_id, field_id, value) VALUES (?, ?, ?)
        ON CONFLICT(user_id, field_id) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(userId, w.field.id, w.value));
}

/** The signed-in user's own fields (admin-only fields are never shown). */
peopleRouter.get("/me/profile-fields", async (c) => {
  const fields = (await loadFields(c.env.DB)).filter(f => f.visibility !== "admin");
  const values = await valuesOf(c.env.DB, c.get("user").id);
  return c.json({ fields: fields.map(f => ({ ...f, value: values[f.id] ?? null })) });
});

peopleRouter.put("/me/profile-fields", async (c) => {
  const db = c.env.DB;
  const me = c.get("user");
  const body = await c.req.json<{ values?: unknown }>().catch(() => null);
  if (!body?.values || typeof body.values !== "object" || Array.isArray(body.values)) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const fields = (await loadFields(db)).filter(f => f.visibility !== "admin");
  const { errors, writes } = planValues(fields, body.values as Record<string, unknown>, await valuesOf(db, me.id), true);
  if (errors.length) return c.json({ error: errors.join(" · "), errors }, 400);
  if (writes.length) await db.batch(valueStatements(db, me.id, writes));
  return c.json({ message: "บันทึกข้อมูลเพิ่มเติมแล้ว" });
});

/** Staff edit any field of a user (users.manage, same guard as account edits). */
peopleRouter.put("/admin/people/:id/profile-fields", permit("users.manage"), async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const roles = await targetRoles(db, id);
  if (!roles) return c.json({ error: "ไม่พบผู้ใช้" }, 404);
  if (roles.includes("admin") && !isAdmin(c)) return c.json({ error: ADMIN_ONLY_TARGET }, 403);
  if (id !== c.get("user").id && !(await withinActorPermissions(c, roles))) return c.json({ error: BEYOND_ACTOR }, 403);
  const body = await c.req.json<{ values?: unknown }>().catch(() => null);
  if (!body?.values || typeof body.values !== "object" || Array.isArray(body.values)) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const { errors, writes } = planValues(await loadFields(db), body.values as Record<string, unknown>, await valuesOf(db, id), false);
  if (errors.length) return c.json({ error: errors.join(" · "), errors }, 400);
  if (writes.length) await db.batch(valueStatements(db, id, writes));
  await audit(c, "update_profile_fields", "user", id, { fields: writes.map(w => w.field.key) });
  return c.json({ message: "บันทึกฟิลด์โปรไฟล์แล้ว" });
});

// ==========================================
// Tags
// ==========================================

peopleRouter.get("/admin/tags", permit("users.view", "communication.manage"), async (c) => {
  const rows = await c.env.DB.prepare("SELECT tag, COUNT(*) AS users FROM user_tags GROUP BY tag ORDER BY tag").all<{ tag: string; users: number }>();
  return c.json({ tags: rows.results });
});

peopleRouter.post("/admin/people/:id/tags", permit("users.manage", "users.import"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ tag?: unknown; tags?: unknown }>().catch(() => null);
  const raw = Array.isArray(body?.tags) ? body!.tags : [body?.tag];
  const tags = raw.map(normalizeTag);
  if (!tags.length || tags.length > 20 || tags.some(t => !t)) return c.json({ error: "แท็กไม่ถูกต้อง (ไม่เกิน 50 ตัวอักษร ห้ามมี , หรือ |)" }, 400);
  if (!(await c.env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first())) return c.json({ error: "ไม่พบผู้ใช้" }, 404);
  await c.env.DB.batch(tags.map(t => c.env.DB.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, ?)").bind(id, t)));
  await audit(c, "tag", "user", id, { add: tags });
  return c.json({ tags: (await loadAccount(c.env.DB, id))?.tags ?? [] });
});

peopleRouter.delete("/admin/people/:id/tags/:tag", permit("users.manage", "users.import"), async (c) => {
  const id = c.req.param("id");
  const tag = normalizeTag(decodeURIComponent(c.req.param("tag")));
  if (!tag) return c.json({ error: "แท็กไม่ถูกต้อง" }, 400);
  await c.env.DB.prepare("DELETE FROM user_tags WHERE user_id = ? AND tag = ?").bind(id, tag).run();
  await audit(c, "untag", "user", id, { remove: [tag] });
  return c.json({ tags: (await loadAccount(c.env.DB, id))?.tags ?? [] });
});

// ==========================================
// Segments
// ==========================================

interface SegmentRow { id: string; name: string; description: string | null; rules_json: string; created_at: string; updated_at: string }

function readSegmentBody(body: Record<string, unknown> | null): { name: string; description: string | null; rules: SegmentRules } | string {
  if (!body || typeof body !== "object") return "ข้อมูลไม่ถูกต้อง";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) return "กรุณากรอกชื่อกลุ่ม (ไม่เกิน 100 ตัวอักษร)";
  const description = typeof body.description === "string" && body.description.trim() ? body.description.trim().slice(0, 500) : null;
  const rules = parseSegmentRules(body.rules ?? {});
  if (typeof rules === "string") return rules;
  return { name, description, rules };
}

async function segmentOut(db: D1Database, row: SegmentRow) {
  const parsed = parseSegmentRules(JSON.parse(row.rules_json));
  const rules = typeof parsed === "string" ? {} : parsed;
  return { id: row.id, name: row.name, description: row.description, rules, created_at: row.created_at, updated_at: row.updated_at, count: await countSegment(db, rules) };
}

peopleRouter.get("/admin/segments", permit("users.view", "communication.manage"), async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM segments ORDER BY name").all<SegmentRow>();
  return c.json({ segments: await Promise.all(rows.results.map(r => segmentOut(c.env.DB, r))) });
});

/** Live count and a sample for unsaved rules (the segment builder). */
peopleRouter.post("/admin/segments/preview", permit("users.view", "communication.manage"), async (c) => {
  const body = await c.req.json<{ rules?: unknown }>().catch(() => null);
  const rules = parseSegmentRules(body?.rules ?? {});
  if (typeof rules === "string") return c.json({ error: rules }, 400);
  const where = segmentWhere(rules);
  const sample = await c.env.DB.prepare(`SELECT u.id, u.name, u.email FROM users u WHERE ${where.sql} ORDER BY u.created_at DESC LIMIT 10`).bind(...where.params).all();
  return c.json({ count: await countSegment(c.env.DB, rules), sample: sample.results, rules });
});

peopleRouter.post("/admin/segments", permit("users.import", "users.manage"), async (c) => {
  const input = readSegmentBody(await c.req.json<Record<string, unknown>>().catch(() => null));
  if (typeof input === "string") return c.json({ error: input }, 400);
  const id = newId("seg");
  await c.env.DB.prepare("INSERT INTO segments (id, name, description, rules_json, created_by) VALUES (?, ?, ?, ?, ?)")
    .bind(id, input.name, input.description, JSON.stringify(input.rules), c.get("user").id).run();
  await audit(c, "create", "segment", id, { name: input.name });
  const row = await c.env.DB.prepare("SELECT * FROM segments WHERE id = ?").bind(id).first<SegmentRow>();
  return c.json({ segment: await segmentOut(c.env.DB, row!) }, 201);
});

peopleRouter.patch("/admin/segments/:id", permit("users.import", "users.manage"), async (c) => {
  const id = c.req.param("id");
  const input = readSegmentBody(await c.req.json<Record<string, unknown>>().catch(() => null));
  if (typeof input === "string") return c.json({ error: input }, 400);
  const result = await c.env.DB.prepare("UPDATE segments SET name = ?, description = ?, rules_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(input.name, input.description, JSON.stringify(input.rules), id).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบกลุ่มผู้ใช้" }, 404);
  await audit(c, "update", "segment", id, { name: input.name });
  const row = await c.env.DB.prepare("SELECT * FROM segments WHERE id = ?").bind(id).first<SegmentRow>();
  return c.json({ segment: await segmentOut(c.env.DB, row!) });
});

peopleRouter.delete("/admin/segments/:id", permit("users.import", "users.manage"), async (c) => {
  const id = c.req.param("id");
  const result = await c.env.DB.prepare("DELETE FROM segments WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบกลุ่มผู้ใช้" }, 404);
  await audit(c, "delete", "segment", id);
  return c.json({ message: "ลบกลุ่มผู้ใช้แล้ว" });
});

/** Members of a saved segment: { total, user_ids, users (page) }. */
peopleRouter.get("/admin/segments/:id/users", permit("users.view", "communication.manage"), async (c) => {
  const db = c.env.DB;
  const row = await db.prepare("SELECT * FROM segments WHERE id = ?").bind(c.req.param("id")).first<SegmentRow>();
  if (!row) return c.json({ error: "ไม่พบกลุ่มผู้ใช้" }, 404);
  const ids = await resolveSegmentUserIds(db, row.id);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);
  const page = ids.slice(offset, offset + limit);
  const users = page.length
    ? (await db.prepare(`SELECT u.id, u.name, u.email, u.status, u.created_at, u.last_login_at FROM users u
        WHERE u.id IN (SELECT value FROM json_each(?)) ORDER BY u.created_at, u.id`).bind(JSON.stringify(page)).all()).results
    : [];
  return c.json({ segment: { id: row.id, name: row.name }, total: ids.length, user_ids: ids, users });
});

// ==========================================
// User 360
// ==========================================

peopleRouter.get("/admin/people-meta", permit("users.view"), async (c) => {
  const db = c.env.DB;
  const [courses, tags, segments] = await Promise.all([
    db.prepare("SELECT id, title, status FROM courses WHERE status != 'archived' ORDER BY title").all(),
    db.prepare("SELECT tag, COUNT(*) AS users FROM user_tags GROUP BY tag ORDER BY tag").all(),
    db.prepare("SELECT id, name FROM segments ORDER BY name").all()
  ]);
  const permissions = await currentPermissions(c);
  return c.json({
    courses: courses.results, tags: tags.results, segments: segments.results, fields: await loadFields(db),
    canManage: permissions.has("users.manage"), canImport: permissions.has("users.import")
  });
});

async function safeAll(db: D1Database, sql: string, ...params: unknown[]) {
  try {
    return (await db.prepare(sql).bind(...params).all()).results;
  } catch (error) {
    console.error("User 360 query failed:", error);
    return [];
  }
}

peopleRouter.get("/admin/people/:id", permit("users.view"), async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const user = await loadAccount(db, id);
  if (!user) return c.json({ error: "ไม่พบผู้ใช้" }, 404);
  const canManage = (await currentPermissions(c)).has("users.manage");
  const [fields, values, enrollments, orders, payments, certificates, events, notes] = await Promise.all([
    loadFields(db),
    valuesOf(db, id),
    safeAll(db, `SELECT e.id, e.course_id, co.title AS course_title, e.progress_percent, e.status, e.enrolled_at, e.completed_at, e.expires_at,
        e.partner_id, (SELECT MAX(lp.updated_at) FROM lesson_progress lp WHERE lp.user_id = e.user_id AND lp.course_id = e.course_id) AS last_lesson_at
      FROM enrollments e LEFT JOIN courses co ON co.id = e.course_id WHERE e.user_id = ? ORDER BY e.enrolled_at DESC`, id),
    safeAll(db, `SELECT o.id, o.reference, o.course_id, co.title AS course_title, o.amount, o.status, o.receipt_no, o.paid_at, o.created_at
      FROM course_orders o LEFT JOIN courses co ON co.id = o.course_id WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 100`, id),
    safeAll(db, `SELECT p.id, p.course_id, co.title AS course_title, p.amount, p.currency, p.status, p.created_at
      FROM payments p LEFT JOIN courses co ON co.id = p.course_id WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 100`, id),
    safeAll(db, `SELECT ce.id, ce.course_id, co.title AS course_title, ce.certificate_code, ce.issued_at, ce.revoked_at
      FROM certificates ce LEFT JOIN courses co ON co.id = ce.course_id WHERE ce.user_id = ? ORDER BY ce.issued_at DESC`, id),
    safeAll(db, `SELECT ev.id, ev.type, ev.course_id, co.title AS course_title, ev.lesson_id, ev.created_at
      FROM user_events ev LEFT JOIN courses co ON co.id = ev.course_id WHERE ev.user_id = ? AND ev.type != 'heartbeat'
      ORDER BY ev.created_at DESC LIMIT 50`, id),
    canManage
      ? safeAll(db, `SELECT n.id, n.body, n.created_at, n.author_id, a.name AS author_name FROM staff_notes n
          LEFT JOIN users a ON a.id = n.author_id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100`, id)
      : Promise.resolve(null)
  ]);
  return c.json({
    user,
    profile_fields: fields.map(f => ({ ...f, value: values[f.id] ?? null })),
    enrollments, orders, payments, certificates, events,
    notes, canManage
  });
});

peopleRouter.post("/admin/people/:id/notes", permit("users.manage"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ body?: unknown }>().catch(() => null);
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!text || text.length > 4000) return c.json({ error: "กรุณาเขียนบันทึก (ไม่เกิน 4,000 ตัวอักษร)" }, 400);
  if (!(await c.env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first())) return c.json({ error: "ไม่พบผู้ใช้" }, 404);
  const noteId = newId("note");
  await c.env.DB.prepare("INSERT INTO staff_notes (id, user_id, author_id, body) VALUES (?, ?, ?, ?)").bind(noteId, id, c.get("user").id, text).run();
  return c.json({ note: { id: noteId, body: text, author_id: c.get("user").id, author_name: c.get("user").name, created_at: new Date().toISOString() } }, 201);
});

peopleRouter.delete("/admin/people/:id/notes/:noteId", permit("users.manage"), async (c) => {
  const note = await c.env.DB.prepare("SELECT author_id FROM staff_notes WHERE id = ? AND user_id = ?").bind(c.req.param("noteId"), c.req.param("id")).first<{ author_id: string | null }>();
  if (!note) return c.json({ error: "ไม่พบบันทึก" }, 404);
  if (note.author_id !== c.get("user").id && !isAdmin(c)) return c.json({ error: "ลบได้เฉพาะบันทึกของตัวเอง" }, 403);
  await c.env.DB.prepare("DELETE FROM staff_notes WHERE id = ?").bind(c.req.param("noteId")).run();
  return c.json({ message: "ลบบันทึกแล้ว" });
});

// ==========================================
// Enrollment helper (staff assignment, no organization sponsor)
// ==========================================

interface CourseLite { id: string; title: string; status: string; access_duration_days: number | null }

function enrollStatement(db: D1Database, userId: string, course: CourseLite) {
  const expiresAt = course.access_duration_days ? new Date(Date.now() + course.access_duration_days * 86400000).toISOString() : null;
  // Existing enrollments keep their progress; a suspended one is opened again.
  return db.prepare(`INSERT INTO enrollments (id, user_id, course_id, progress_percent, status, expires_at, partner_id)
      VALUES (?, ?, ?, 0, 'active', ?, NULL)
      ON CONFLICT(user_id, course_id) DO UPDATE SET status = 'active' WHERE enrollments.status = 'suspended'`)
    .bind("enr_" + crypto.randomUUID(), userId, course.id, expiresAt);
}

async function loadCourses(db: D1Database): Promise<Map<string, CourseLite>> {
  const rows = await db.prepare("SELECT id, title, status, access_duration_days FROM courses WHERE status != 'archived'").all<CourseLite>();
  return new Map(rows.results.map(r => [r.id, r]));
}

// ==========================================
// Bulk actions
// ==========================================

const BULK_ACTIONS = ["add_tag", "remove_tag", "enroll", "suspend", "activate"] as const;
type BulkAction = typeof BULK_ACTIONS[number];

peopleRouter.post("/admin/people/bulk", async (c) => {
  const db = c.env.DB;
  const actor = c.get("user");
  const body = await c.req.json<{ action?: unknown; user_ids?: unknown; tag?: unknown; course_id?: unknown }>().catch(() => null);
  const action = body?.action as BulkAction;
  if (!BULK_ACTIONS.includes(action)) return c.json({ error: "คำสั่งไม่ถูกต้อง" }, 400);
  const ids = Array.isArray(body?.user_ids) ? Array.from(new Set(body!.user_ids.filter((v): v is string => typeof v === "string"))) : [];
  if (!ids.length || ids.length > 500) return c.json({ error: "เลือกผู้ใช้ 1–500 คน" }, 400);
  const permissions = await currentPermissions(c);
  const tagAction = action === "add_tag" || action === "remove_tag";
  if (tagAction ? !permissions.has("users.manage") && !permissions.has("users.import") : !permissions.has("users.manage")) {
    return c.json({ error: "บัญชีของคุณไม่มีสิทธิ์ใช้งานส่วนนี้" }, 403);
  }
  const tag = tagAction ? normalizeTag(body?.tag) : null;
  if (tagAction && !tag) return c.json({ error: "แท็กไม่ถูกต้อง (ไม่เกิน 50 ตัวอักษร ห้ามมี , หรือ |)" }, 400);
  let course: CourseLite | undefined;
  if (action === "enroll") {
    course = (await loadCourses(db)).get(typeof body?.course_id === "string" ? body.course_id : "");
    if (!course) return c.json({ error: "ไม่พบคอร์สที่เลือก" }, 400);
  }
  const existing = await db.prepare(`SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<{ id: string }>();
  const found = new Set(existing.results.map(r => r.id));
  const failed: Array<{ user_id: string; error: string }> = ids.filter(id => !found.has(id)).map(id => ({ user_id: id, error: "ไม่พบผู้ใช้" }));
  const targets = ids.filter(id => found.has(id));
  let done = 0;

  if (tagAction) {
    const statements = targets.map(id => action === "add_tag"
      ? db.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, ?)").bind(id, tag)
      : db.prepare("DELETE FROM user_tags WHERE user_id = ? AND tag = ?").bind(id, tag));
    for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
    done = targets.length;
  } else if (action === "enroll") {
    const statements = targets.map(id => enrollStatement(db, id, course!));
    for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
    done = targets.length;
  } else {
    const next = action === "suspend" ? "suspended" : "active";
    for (const id of targets) {
      const roles = (await targetRoles(db, id))!;
      if (id === actor.id) { failed.push({ user_id: id, error: "เปลี่ยนสถานะบัญชีของตัวเองไม่ได้" }); continue; }
      if (roles.includes("admin") && !isAdmin(c)) { failed.push({ user_id: id, error: ADMIN_ONLY_TARGET }); continue; }
      if (!(await withinActorPermissions(c, roles))) { failed.push({ user_id: id, error: BEYOND_ACTOR }); continue; }
      if (next === "suspended" && roles.includes("admin") && (await activeAdmins(db, id)) === 0) {
        failed.push({ user_id: id, error: "ต้องมีผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน" }); continue;
      }
      await db.prepare("UPDATE users SET status = ? WHERE id = ?").bind(next, id).run();
      done++;
    }
  }
  await audit(c, "bulk_" + action, "user", "bulk", { users: targets.length, done, tag, course_id: course?.id });
  return c.json({ done, failed, message: `ดำเนินการสำเร็จ ${done} คน${failed.length ? ` ไม่สำเร็จ ${failed.length} คน` : ""}` });
});

// ==========================================
// CSV export (selected users, or everyone matching the list filters)
// ==========================================

peopleRouter.post("/admin/people/export", permit("users.view"), async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ user_ids?: unknown; segment_id?: unknown; tag?: unknown }>().catch(() => null);
  let ids: string[];
  if (Array.isArray(body?.user_ids)) ids = body!.user_ids.filter((v): v is string => typeof v === "string").slice(0, 5000);
  else if (typeof body?.segment_id === "string") ids = await resolveSegmentUserIds(db, body.segment_id);
  else {
    const tag = normalizeTag(body?.tag);
    ids = (await db.prepare(`SELECT u.id FROM users u WHERE (? IS NULL OR EXISTS (SELECT 1 FROM user_tags t WHERE t.user_id = u.id AND t.tag = ?))
      ORDER BY u.created_at LIMIT 5000`).bind(tag, tag).all<{ id: string }>()).results.map(r => r.id);
  }
  const fields = await loadFields(db);
  const rows: unknown[][] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = JSON.stringify(ids.slice(i, i + 200));
    const users = await db.prepare(`SELECT u.id, u.email, u.name, u.status, u.created_at, u.last_login_at, p.company_name,
        (SELECT GROUP_CONCAT(role, '|') FROM user_roles r WHERE r.user_id = u.id) AS roles,
        (SELECT GROUP_CONCAT(tag, '|') FROM user_tags t WHERE t.user_id = u.id) AS tags,
        (SELECT GROUP_CONCAT(course_id, '|') FROM enrollments e WHERE e.user_id = u.id) AS courses
      FROM users u LEFT JOIN partners p ON p.id = u.partner_id WHERE u.id IN (SELECT value FROM json_each(?)) ORDER BY u.created_at`)
      .bind(chunk).all<Record<string, string | null>>();
    const values = await db.prepare("SELECT user_id, field_id, value FROM user_profile_values WHERE user_id IN (SELECT value FROM json_each(?))")
      .bind(chunk).all<{ user_id: string; field_id: string; value: string }>();
    const byUser = new Map<string, Record<string, string>>();
    for (const v of values.results) byUser.set(v.user_id, { ...(byUser.get(v.user_id) || {}), [v.field_id]: v.value });
    for (const u of users.results) {
      rows.push([u.email, u.name, sortRoles((u.roles || "").split("|")).join("|"), u.company_name ?? "", u.tags ?? "", u.courses ?? "",
        u.status, u.created_at, u.last_login_at ?? "", ...fields.map(f => byUser.get(u.id!)?.[f.id] ?? "")]);
    }
  }
  await audit(c, "export", "user", "bulk", { users: rows.length });
  return csvResponse(toCsv(["email", "name", "roles", "organization", "tags", "courses", "status", "created_at", "last_login_at", ...fields.map(f => f.key)], rows),
    `netprime-users-${new Date().toISOString().slice(0, 10)}.csv`);
});

// ==========================================
// CSV import
// ==========================================

const MAX_ROWS = 2000;
const MAX_BATCH = 100;
type Mode = "skip" | "update";
type Setup = "invite" | "password";
interface ImportOptions { mode: Mode; setup: Setup }
type Cells = Record<string, string>;

const COLUMN_ALIASES: Record<string, string> = {
  email: "email", "อีเมล": "email", name: "name", "ชื่อ": "name", roles: "roles", role: "roles", "บทบาท": "roles",
  organization: "organization", organization_id: "organization", partner_id: "organization", "องค์กร": "organization",
  tags: "tags", tag: "tags", "แท็ก": "tags", password: "password", temporary_password: "password", "รหัสผ่าน": "password",
  courses: "courses", course_ids: "courses", enroll: "courses", enroll_course_ids: "courses", "คอร์ส": "courses"
};
const ROLE_ALIASES: Record<string, Role> = Object.fromEntries(Object.entries(ROLE_INFO).map(([key, info]) => [info.label, key as Role]));

interface PlannedRow {
  row_no: number; email: string; name: string;
  action: "create" | "update" | "skip" | "error";
  errors: string[]; warnings: string[];
  roles: Role[]; partner_id: string | null; tags: string[]; course_ids: string[];
  values: Array<{ field: ProfileField; value: string | null }>;
  password: string | null;
  existing?: { id: string; roles: Role[]; partner_id: string | null; primary: string };
}

interface PlanContext {
  fields: ProfileField[];
  partners: Array<{ id: string; company_name: string; total_seats: number; used: number }>;
  courses: Map<string, CourseLite>;
  existing: Map<string, { id: string; role_list: string | null; primary_role: string; partner_id: string | null }>;
  roleCheck: Map<string, boolean>;
}

const splitList = (value: string | undefined) => (value || "").split(/[|;]/).map(v => v.trim()).filter(Boolean);

async function planContext(db: D1Database, emails: string[]): Promise<PlanContext> {
  const [fields, partners, courses, existing] = await Promise.all([
    loadFields(db),
    db.prepare(`SELECT p.id, p.company_name, p.total_seats,
        (SELECT COUNT(*) FROM users x WHERE x.partner_id = p.id AND x.role = 'student' AND x.staff_role IS NULL) AS used FROM partners p`).all<PlanContext["partners"][number]>(),
    loadCourses(db),
    db.prepare(`SELECT u.id, u.email, u.partner_id, COALESCE(u.staff_role, u.role) AS primary_role,
        (SELECT GROUP_CONCAT(role) FROM user_roles WHERE user_id = u.id) AS role_list
      FROM users u WHERE u.email IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(emails)).all<{ id: string; email: string; role_list: string | null; primary_role: string; partner_id: string | null }>()
  ]);
  return { fields, partners: partners.results, courses, existing: new Map(existing.results.map(r => [r.email, r])), roleCheck: new Map() };
}

async function allowedRoles(c: Context<Env>, ctx: PlanContext, roles: Role[]): Promise<boolean> {
  const key = roles.join(",");
  if (!ctx.roleCheck.has(key)) ctx.roleCheck.set(key, await withinActorPermissions(c, roles));
  return ctx.roleCheck.get(key)!;
}

/** Validates rows in file order; `seatUse` tracks seats taken by earlier rows of the same plan. */
async function planRows(c: Context<Env>, records: Array<{ row_no: number; cells: Cells }>, options: ImportOptions, ctx: PlanContext): Promise<PlannedRow[]> {
  const actorIsAdmin = isAdmin(c);
  // users.import alone may create learners; granting instructor/partner roles or enrolling via the
  // "courses" column needs the broader users.manage permission (or admin).
  const canManage = actorIsAdmin || (await currentPermissions(c)).has("users.manage");
  const seen = new Set<string>();
  const seatUse = new Map<string, number>();
  const out: PlannedRow[] = [];
  for (const { row_no, cells } of records) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const email = (cells.email || "").trim().toLowerCase();
    const name = (cells.name || "").trim();
    const plan: PlannedRow = { row_no, email, name, action: "create", errors, warnings, roles: [], partner_id: null, tags: [], course_ids: [], values: [], password: null };
    out.push(plan);
    if (!EMAIL_RE.test(email) || email.length > 254) { errors.push("อีเมลไม่ถูกต้อง"); plan.action = "error"; continue; }
    if (seen.has(email)) { errors.push("อีเมลซ้ำกับแถวก่อนหน้าในไฟล์"); plan.action = "error"; continue; }
    seen.add(email);
    const found = ctx.existing.get(email);
    if (found) {
      const roles = sortRoles((found.role_list || "").split(","), found.primary_role);
      plan.existing = { id: found.id, roles, partner_id: found.partner_id, primary: found.primary_role };
      plan.action = options.mode === "skip" ? "skip" : "update";
      if (plan.action === "skip") { warnings.push("มีบัญชีอยู่แล้ว ข้ามแถวนี้"); continue; }
    }

    // Roles
    const rawRoles = splitList(cells.roles).map(r => ROLE_ALIASES[r] ?? r.toLowerCase());
    const badRoles = rawRoles.filter(r => !isRole(r));
    if (badRoles.length) errors.push(`บทบาทไม่ถูกต้อง: ${badRoles.join(", ")}`);
    const requested = sortRoles(rawRoles.filter(isRole));
    const roles = plan.existing ? sortRoles([...plan.existing.roles, ...requested]) : requested.length ? requested : ["student" as Role];
    plan.roles = roles;
    if (roles.includes("admin") && !actorIsAdmin) errors.push("เฉพาะผู้ดูแลระบบเท่านั้นที่ให้บทบาทผู้ดูแลระบบได้");
    else if (plan.existing?.roles.includes("admin") && !actorIsAdmin) errors.push(ADMIN_ONLY_TARGET);
    else if (!(await allowedRoles(c, ctx, roles))) errors.push(BEYOND_ACTOR);
    const elevated = roles.filter(r => (r === "instructor" || r === "partner") && !plan.existing?.roles.includes(r));
    if (elevated.length && !canManage) errors.push(`การให้บทบาท ${elevated.join(", ")} ต้องมีสิทธิ์จัดการผู้ใช้ (users.manage)`);

    // Organization (id or exact name)
    const orgRaw = (cells.organization || "").trim();
    let partnerId: string | null = plan.existing?.partner_id ?? null;
    if (orgRaw) {
      const partner = ctx.partners.find(p => p.id === orgRaw) ?? ctx.partners.find(p => p.company_name.trim().toLowerCase() === orgRaw.toLowerCase());
      if (!partner) errors.push(`ไม่พบองค์กร "${orgRaw}"`);
      else if (plan.existing?.partner_id && plan.existing.partner_id !== partner.id) warnings.push("บัญชีเดิมอยู่องค์กรอื่น ระบบไม่ย้ายองค์กรให้");
      else partnerId = partner.id;
    }
    plan.partner_id = partnerId;
    const orgProblem = organizationRule(roles, partnerId);
    if (orgProblem) errors.push(orgProblem);
    // Seats: only accounts whose primary role becomes "student" in an organization take a seat.
    const takesSeat = primaryRole(roles) === "student" && !!partnerId;
    const heldSeat = plan.existing && plan.existing.primary === "student" && plan.existing.partner_id === partnerId;
    if (takesSeat && !heldSeat && !errors.length) {
      const partner = ctx.partners.find(p => p.id === partnerId)!;
      const used = partner.used + (seatUse.get(partner.id) ?? 0);
      if (used >= partner.total_seats) errors.push(`องค์กร ${partner.company_name} ที่นั่งเต็ม (${partner.total_seats})`);
      else seatUse.set(partner.id, (seatUse.get(partner.id) ?? 0) + 1);
    }

    // Name and password (new accounts only)
    if (!plan.existing) {
      if (!name || name.length > 120) errors.push("กรุณากรอกชื่อ (ไม่เกิน 120 ตัวอักษร)");
      if (options.setup === "password") {
        const password = cells.password || "";
        if (password.length < 12 || password.length > 256) errors.push("รหัสผ่านชั่วคราวต้องยาว 12–256 ตัวอักษร");
        else plan.password = password;
      }
    } else if (cells.password) {
      warnings.push("ไม่เปลี่ยนรหัสผ่านของบัญชีเดิม");
    }

    // Tags
    for (const raw of splitList(cells.tags)) {
      const tag = normalizeTag(raw);
      if (!tag) errors.push(`แท็กไม่ถูกต้อง: ${raw}`);
      else if (!plan.tags.includes(tag)) plan.tags.push(tag);
    }
    // Courses
    const courseIds = splitList(cells.courses);
    if (courseIds.length && !canManage) errors.push("การลงทะเบียนคอร์สจากไฟล์ (คอลัมน์ courses) ต้องมีสิทธิ์จัดการผู้ใช้ (users.manage)");
    else for (const id of courseIds) {
      const course = ctx.courses.get(id);
      if (!course) errors.push(`ไม่พบคอร์ส ${id}`);
      else if (course.status !== "published") errors.push(`คอร์ส ${id} ยังไม่เผยแพร่ จึงลงทะเบียนจากไฟล์ไม่ได้`);
      else if (!plan.course_ids.includes(id)) plan.course_ids.push(id);
    }
    // Custom profile fields: column "<key>" or "field:<key>"
    for (const field of ctx.fields) {
      const raw = cells[field.key] ?? cells["field:" + field.key];
      if (raw === undefined || raw.trim() === "") continue;
      const parsed = fieldValue(field, raw);
      if ("error" in parsed) errors.push(parsed.error);
      else plan.values.push({ field, value: parsed.value });
    }
    if (errors.length) plan.action = "error";
  }
  return out;
}

function recordsFromCsv(text: string): { records: Array<{ row_no: number; cells: Cells }>; columns: string[]; unknown: string[] } | string {
  const rows = parseCsv(text);
  if (rows.length < 2) return "ไฟล์ต้องมีแถวหัวตารางและข้อมูลอย่างน้อย 1 แถว";
  if (rows.length - 1 > MAX_ROWS) return `นำเข้าได้ไม่เกิน ${MAX_ROWS.toLocaleString("th-TH")} แถวต่อไฟล์`;
  const columns = rows[0].map(h => {
    const key = h.trim().replace(/^\ufeff/, "");
    return COLUMN_ALIASES[key] ?? COLUMN_ALIASES[key.toLowerCase()] ?? key.toLowerCase();
  });
  if (!columns.includes("email")) return "ไม่พบคอลัมน์ email";
  const records = rows.slice(1).map((r, i) => ({
    row_no: i + 2,
    cells: Object.fromEntries(columns.map((col, j) => [col, (r[j] ?? "").trim()])) as Cells
  }));
  return { records, columns, unknown: [] };
}

const publicRow = (p: PlannedRow) => ({
  row_no: p.row_no, email: p.email, name: p.name, action: p.action, errors: p.errors, warnings: p.warnings,
  roles: p.roles, partner_id: p.partner_id, tags: p.tags, course_ids: p.course_ids
});

/**
 * POST /api/admin/people/import/preview { csv, filename?, mode: skip|update, setup: invite|password }
 * Validates every row and opens an import (import_id); commit then sends the returned `records` back in batches.
 */
peopleRouter.post("/admin/people/import/preview", permit("users.import"), async (c) => {
  const body = await c.req.json<{ csv?: unknown; filename?: unknown; mode?: unknown; setup?: unknown }>().catch(() => null);
  if (typeof body?.csv !== "string" || !body.csv.trim()) return c.json({ error: "กรุณาเลือกไฟล์ CSV" }, 400);
  if (body.csv.length > 3_000_000) return c.json({ error: "ไฟล์ใหญ่เกินไป (ไม่เกิน 3 MB)" }, 400);
  const options: ImportOptions = { mode: body.mode === "update" ? "update" : "skip", setup: body.setup === "password" ? "password" : "invite" };
  const parsed = recordsFromCsv(body.csv);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  const ctx = await planContext(c.env.DB, parsed.records.map(r => (r.cells.email || "").trim().toLowerCase()));
  const known = new Set(["email", "name", "roles", "organization", "tags", "password", "courses", ...ctx.fields.flatMap(f => [f.key, "field:" + f.key])]);
  const unknownColumns = parsed.columns.filter(col => !known.has(col));
  const plan = await planRows(c, parsed.records, options, ctx);
  const id = newId("imp");
  await c.env.DB.prepare("INSERT INTO user_imports (id, actor_id, filename, options_json, total_rows) VALUES (?, ?, ?, ?, ?)")
    .bind(id, c.get("user").id, typeof body.filename === "string" ? body.filename.slice(0, 200) : null, JSON.stringify(options), plan.length).run();
  const summary = { total: plan.length, create: 0, update: 0, skip: 0, error: 0 };
  for (const p of plan) summary[p.action]++;
  // `records` are the parsed rows (known columns only) that the browser sends back to commit.
  return c.json({
    import_id: id, options, summary, unknown_columns: unknownColumns, batch_size: MAX_BATCH,
    rows: plan.map(publicRow),
    records: parsed.records.map(r => ({ row_no: r.row_no, cells: Object.fromEntries(Object.entries(r.cells).filter(([k]) => known.has(k))) }))
  });
});

interface RowResult { row_no: number; email: string; result: "created" | "updated" | "skipped" | "failed"; user_id: string | null; message: string | null; debug_url?: string }

/**
 * POST /api/admin/people/import/:id/commit { records: [{ row_no, cells }] } (≤100 per call).
 * Each row is one D1 batch (all-or-nothing) that also records its result, so a retried batch
 * returns the stored result instead of applying a row twice. Failed rows are attempted again.
 */
peopleRouter.post("/admin/people/import/:id/commit", permit("users.import"), async (c) => {
  const db = c.env.DB;
  const actor = c.get("user");
  const imp = await db.prepare("SELECT id, actor_id, options_json FROM user_imports WHERE id = ?").bind(c.req.param("id")).first<{ id: string; actor_id: string | null; options_json: string }>();
  if (!imp) return c.json({ error: "ไม่พบรายการนำเข้า" }, 404);
  if (imp.actor_id !== actor.id) return c.json({ error: "รายการนำเข้านี้เป็นของผู้ใช้อื่น" }, 403);
  const options = JSON.parse(imp.options_json) as ImportOptions;
  const body = await c.req.json<{ records?: unknown }>().catch(() => null);
  const records = Array.isArray(body?.records) ? body!.records : null;
  if (!records || !records.length || records.length > MAX_BATCH) return c.json({ error: `ส่งข้อมูลครั้งละ 1–${MAX_BATCH} แถว` }, 400);
  const clean: Array<{ row_no: number; cells: Cells }> = [];
  for (const r of records as Array<Record<string, unknown>>) {
    if (!r || !Number.isInteger(r.row_no) || (r.row_no as number) < 2 || (r.row_no as number) > MAX_ROWS + 1 || !r.cells || typeof r.cells !== "object") {
      return c.json({ error: "ข้อมูลแถวไม่ถูกต้อง" }, 400);
    }
    const cells = Object.fromEntries(Object.entries(r.cells as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 2000) : ""]));
    clean.push({ row_no: r.row_no as number, cells });
  }

  const stored = await db.prepare(`SELECT row_no, email, result, user_id, message FROM user_import_rows
    WHERE import_id = ? AND row_no IN (SELECT value FROM json_each(?))`).bind(imp.id, JSON.stringify(clean.map(r => r.row_no))).all<RowResult>();
  const done = new Map(stored.results.filter(r => r.result !== "failed").map(r => [r.row_no, r]));
  const pending = clean.filter(r => !done.has(r.row_no));
  const ctx = await planContext(db, pending.map(r => (r.cells.email || "").trim().toLowerCase()));
  const plans = await planRows(c, pending, options, ctx);
  // The same email in an earlier batch of this import: the later row is a duplicate, not an update.
  const earlier = await db.prepare(`SELECT email, row_no FROM user_import_rows WHERE import_id = ? AND result IN ('created', 'updated')
    AND email IN (SELECT value FROM json_each(?))`).bind(imp.id, JSON.stringify(plans.map(p => p.email))).all<{ email: string; row_no: number }>();
  for (const p of plans) {
    const first = earlier.results.find(e => e.email === p.email && e.row_no !== p.row_no);
    if (first && p.action !== "error") { p.action = "error"; p.errors.push(`อีเมลซ้ำกับแถว ${first.row_no}`); }
  }
  const results: RowResult[] = [];
  const record = (p: PlannedRow, result: RowResult["result"], userId: string | null, message: string | null) =>
    db.prepare(`INSERT INTO user_import_rows (import_id, row_no, email, result, user_id, message) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(import_id, row_no) DO UPDATE SET email = excluded.email, result = excluded.result, user_id = excluded.user_id,
        message = excluded.message, created_at = CURRENT_TIMESTAMP`).bind(imp.id, p.row_no, p.email, result, userId, message);

  for (const p of plans) {
    if (p.action === "error") {
      const message = p.errors.join(" · ");
      await record(p, "failed", p.existing?.id ?? null, message).run();
      results.push({ row_no: p.row_no, email: p.email, result: "failed", user_id: p.existing?.id ?? null, message });
      continue;
    }
    if (p.action === "skip") {
      await record(p, "skipped", p.existing!.id, "มีบัญชีอยู่แล้ว").run();
      results.push({ row_no: p.row_no, email: p.email, result: "skipped", user_id: p.existing!.id, message: "มีบัญชีอยู่แล้ว" });
      continue;
    }
    const userId = p.existing?.id ?? "usr_" + crypto.randomUUID();
    const statements: D1PreparedStatement[] = [];
    const primary = primaryRole(p.roles);
    const stored = storedRole(primary);
    const takesSeat = primary === "student" && !!p.partner_id;
    if (!p.existing) {
      const hash = await hashPassword(p.password ?? crypto.randomUUID() + crypto.randomUUID());
      // Organization students take a seat: the capacity check is part of the insert. When it inserts
      // nothing, the role rows below fail their foreign key and the whole row is rolled back.
      statements.push(takesSeat
        ? db.prepare(`INSERT INTO users (id, email, password_hash, name, role, staff_role, partner_id)
            SELECT ?, ?, ?, ?, 'student', NULL, p.id FROM partners p WHERE p.id = ?
            AND (SELECT COUNT(*) FROM users x WHERE x.partner_id = p.id AND x.role = 'student' AND x.staff_role IS NULL) < p.total_seats`)
            .bind(userId, p.email, hash, p.name, p.partner_id)
        : db.prepare("INSERT INTO users (id, email, password_hash, name, role, staff_role, partner_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(userId, p.email, hash, p.name, stored.role, stored.staff_role, p.partner_id));
    } else {
      // Update = additive: roles, organization (only when none), tags, field values, enrollments. Nothing is removed.
      const primaryChanged = primary !== p.existing.primary;
      const orgChanged = p.partner_id !== p.existing.partner_id;
      if (primaryChanged || orgChanged) {
        const seatGuard = takesSeat && !(p.existing.primary === "student" && !orgChanged)
          ? ` AND (SELECT COUNT(*) FROM users x WHERE x.partner_id = ? AND x.role = 'student' AND x.staff_role IS NULL AND x.id != ?)
              < (SELECT total_seats FROM partners WHERE id = ?)` : "";
        const update = db.prepare(`UPDATE users SET role = ?, staff_role = ?, partner_id = ? WHERE id = ?${seatGuard}`);
        statements.push(seatGuard
          ? update.bind(stored.role, stored.staff_role, p.partner_id, userId, p.partner_id, userId, p.partner_id)
          : update.bind(stored.role, stored.staff_role, p.partner_id, userId));
      }
    }
    // Guard: user_id is NULL (NOT NULL violation → the whole row rolls back) when the seat-guarded
    // insert/update above changed nothing, i.e. the organization had no free seat.
    statements.push(db.prepare(`INSERT INTO user_roles (user_id, role)
      VALUES ((SELECT id FROM users WHERE id = ? AND (? = 0 OR (partner_id IS ? AND role = 'student' AND staff_role IS NULL))), ?)
      ON CONFLICT DO NOTHING`).bind(userId, takesSeat ? 1 : 0, p.partner_id, p.roles[0]));
    for (const r of p.roles.slice(1)) statements.push(db.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(userId, r));
    for (const t of p.tags) statements.push(db.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, ?)").bind(userId, t));
    statements.push(...valueStatements(db, userId, p.values));
    for (const id of p.course_ids) statements.push(enrollStatement(db, userId, ctx.courses.get(id)!));
    for (const partner of new Set([p.partner_id, p.existing?.partner_id].filter((v): v is string => !!v))) {
      statements.push(db.prepare(`UPDATE partners SET allocated_seats =
        (SELECT COUNT(*) FROM users WHERE partner_id = ? AND role = 'student' AND staff_role IS NULL) WHERE id = ?`).bind(partner, partner));
    }
    const result: RowResult["result"] = p.existing ? "updated" : "created";
    statements.push(record(p, result, userId, null));
    try {
      await db.batch(statements);
    } catch (error: any) {
      const text = String(error?.message || "");
      const message = text.includes("UNIQUE constraint failed: users.email") ? "อีเมลนี้มีบัญชีอยู่แล้ว"
        : takesSeat && text.includes("NOT NULL") ? "องค์กรนี้ใช้ที่นั่งครบแล้ว"
        : "บันทึกแถวนี้ไม่สำเร็จ";
      if (message === "บันทึกแถวนี้ไม่สำเร็จ") console.error("Import row failed:", error);
      await record(p, "failed", p.existing?.id ?? null, message).run();
      results.push({ row_no: p.row_no, email: p.email, result: "failed", user_id: p.existing?.id ?? null, message });
      continue;
    }
    const row: RowResult = { row_no: p.row_no, email: p.email, result, user_id: userId, message: null };
    if (!p.existing && options.setup === "invite") {
      const debug = await sendInvite(c, { id: userId, email: p.email, name: p.name });
      if (debug.debug_url) row.debug_url = debug.debug_url;
    }
    results.push(row);
  }
  await db.prepare("UPDATE user_imports SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(imp.id).run();
  const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  for (const r of results) counts[r.result]++;
  if (results.length) await audit(c, "import", "user", imp.id, counts);
  const all = [...done.values(), ...results].sort((a, b) => a.row_no - b.row_no);
  return c.json({ results: all, counts, repeated: done.size });
});

/** Result report for an import as CSV (row, email, result, message). */
peopleRouter.get("/admin/people/import/:id/report", permit("users.import"), async (c) => {
  const db = c.env.DB;
  const imp = await db.prepare("SELECT id, actor_id FROM user_imports WHERE id = ?").bind(c.req.param("id")).first<{ id: string; actor_id: string | null }>();
  if (!imp) return c.json({ error: "ไม่พบรายการนำเข้า" }, 404);
  if (imp.actor_id !== c.get("user").id && !isAdmin(c)) return c.json({ error: "รายการนำเข้านี้เป็นของผู้ใช้อื่น" }, 403);
  const rows = await db.prepare("SELECT row_no, email, result, user_id, message FROM user_import_rows WHERE import_id = ? ORDER BY row_no").bind(imp.id).all<RowResult>();
  const label: Record<string, string> = { created: "สร้างใหม่", updated: "อัปเดต", skipped: "ข้าม", failed: "ไม่สำเร็จ" };
  return csvResponse(toCsv(["row", "email", "result", "result_th", "user_id", "message"],
    rows.results.map(r => [r.row_no, r.email, r.result, label[r.result], r.user_id ?? "", r.message ?? ""])), `import-report-${imp.id}.csv`);
});
