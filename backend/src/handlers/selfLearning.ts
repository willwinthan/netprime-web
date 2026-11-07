import { Context, Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { permit } from "../utils/permissions";
import { requireDeleteConfirmation } from "../utils/dangerConfirm";
import { allowedOrigins } from "../utils/origins";

/**
 * Self-learning lessons (migrations/0032_self_learning.sql). Staff upload one self-contained HTML file
 * per lesson; the public site lists published lessons at /self-learning and embeds the file in an iframe.
 *   Public:  /api/public/self-learning, /api/public/self-learning/:slug, /api/public/self-learning/files/:id
 *   Console: /api/self-learning/*   (rbac + site.self_learning)
 *   Learner: /api/me/self-learning    (rbac; progress a lesson reports through the Lesson Kit, per account)
 *
 * The uploaded file runs its own scripts, so it is never served from the site's origin (where the JWT sits
 * in localStorage): files come from SELF_LEARNING_ORIGIN, or this Worker's origin, and may only be framed
 * by FRONTEND_ORIGINS. Drafts and older versions open through a short-lived signed preview link.
 */
export const selfLearningRouter = new Hono<Env>();

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LEVELS = ["beginner", "intermediate", "advanced"] as const;
const MAX_STATE_CHARS = 64 * 1024;
const LESSON_COLUMNS = ["slug", "title", "title_en", "summary", "summary_en", "cover_url", "level"] as const;

type C = Context<Env>;
type Obj = Record<string, unknown>;

interface LessonRow {
  id: string; slug: string; title: string; title_en: string | null; summary: string | null; summary_en: string | null;
  cover_url: string | null; level: string | null; status: "draft" | "published"; sort_order: number;
  current_file_id: string | null; published_at: string | null; created_at: string; updated_at: string;
}
interface FileRow {
  id: string; lesson_id: string; version: number; r2_key: string; filename: string | null; size_bytes: number;
  uses_kit: number; external_hosts: string | null; created_at: string;
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

async function audit(c: C, action: string, entityId: string | null, detail?: unknown) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("log"), c.get("user")?.id ?? null, action, "self_learning", entityId, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000)).run();
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}

// ==========================================
// Validation
// ==========================================

class Invalid extends Error {}

function text(body: Obj, key: string, label: string, max: number, required = false): string | null {
  const raw = body[key];
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    if (required) throw new Invalid(`กรุณากรอก${label}`);
    return null;
  }
  if (typeof raw !== "string") throw new Invalid(`${label}ไม่ถูกต้อง`);
  const value = raw.trim();
  if (value.length > max) throw new Invalid(`${label}ยาวเกิน ${max} ตัวอักษร`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Invalid(`${label}มีอักขระที่ไม่อนุญาต`);
  return value;
}

/** Lesson fields from a JSON body; `partial` keeps only the keys that were sent (PATCH). */
function parseLesson(body: Obj, partial: boolean): Partial<Record<typeof LESSON_COLUMNS[number], string | null>> {
  const values: Partial<Record<typeof LESSON_COLUMNS[number], string | null>> = {};
  const has = (key: string) => !partial || key in body;
  if (has("slug")) {
    const slug = text(body, "slug", "ลิงก์ (slug)", 80, true)!.toLowerCase();
    if (!SLUG_RE.test(slug)) throw new Invalid("ลิงก์ (slug) ใช้ได้เฉพาะ a-z, 0-9 และขีดกลาง เช่น basic-network");
    values.slug = slug;
  }
  if (has("title")) values.title = text(body, "title", "ชื่อบทเรียน", 200, true);
  if (has("title_en")) values.title_en = text(body, "title_en", "ชื่อบทเรียนภาษาอังกฤษ", 200);
  if (has("summary")) values.summary = text(body, "summary", "คำอธิบาย", 500);
  if (has("summary_en")) values.summary_en = text(body, "summary_en", "คำอธิบายภาษาอังกฤษ", 500);
  if (has("cover_url")) {
    const url = text(body, "cover_url", "รูปปก", 500);
    if (url && !/^https:\/\/[^\s"'<>]+$/.test(url) && !/^\/[^\s"'<>]*$/.test(url)) throw new Invalid("รูปปกต้องเป็นลิงก์ https");
    values.cover_url = url;
  }
  if (has("level")) {
    const level = body.level === undefined || body.level === null || body.level === "" ? null : body.level;
    if (level !== null && !LEVELS.includes(level as typeof LEVELS[number])) throw new Invalid("ระดับไม่ถูกต้อง");
    values.level = level as string | null;
  }
  return values;
}

async function readJson(c: C): Promise<Obj> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body as Obj : {};
}

/** Checks an uploaded lesson file and reports what staff should know before publishing it. */
function inspectHtml(bytes: Uint8Array): { error: string } | { usesKit: boolean; hosts: string[] } {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { error: "ไฟล์ต้องเข้ารหัสเป็น UTF-8" };
  }
  const head = html.slice(0, 4096).trimStart().toLowerCase();
  if (!head.startsWith("<!doctype html") && !head.startsWith("<html") && !head.startsWith("<!--")) {
    return { error: "ไฟล์ไม่ใช่หน้า HTML (ต้องขึ้นต้นด้วย <!doctype html> หรือ <html>)" };
  }
  if (!/<html[\s>]/i.test(html.slice(0, 65536))) return { error: "ไฟล์ไม่ใช่หน้า HTML (ไม่พบแท็ก <html>)" };
  const hosts = new Set<string>();
  for (const match of html.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
    const host = match[1].toLowerCase();
    if (host !== "www.w3.org") hosts.add(host);
    if (hosts.size >= 30) break;
  }
  return { usesKit: /netprime-lesson:|protocol-explorer:/.test(html), hosts: [...hosts].sort() };
}

// ==========================================
// Serving files
// ==========================================

const contentOrigin = (c: C) => (c.env.SELF_LEARNING_ORIGIN || "").trim().replace(/\/+$/, "") || new URL(c.req.url).origin;
const fileUrl = (c: C, fileId: string) => `${contentOrigin(c)}/api/public/self-learning/files/${fileId}`;

async function hmac(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const previewPayload = (fileId: string, exp: number) => new TextEncoder().encode(`self-learning-preview:${fileId}:${exp}`);
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

async function previewUrl(c: C, fileId: string): Promise<string> {
  const exp = Date.now() + PREVIEW_TTL_MS;
  const sig = toHex(await crypto.subtle.sign("HMAC", await hmac(c.env.JWT_SECRET), previewPayload(fileId, exp)));
  return `${fileUrl(c, fileId)}?exp=${exp}&sig=${sig}`;
}

async function validPreview(c: C, fileId: string): Promise<boolean> {
  const exp = Number(c.req.query("exp"));
  const sig = c.req.query("sig") || "";
  if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + PREVIEW_TTL_MS || !/^[a-f0-9]{64}$/.test(sig)) return false;
  const bytes = new Uint8Array(sig.match(/../g)!.map(h => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await hmac(c.env.JWT_SECRET), bytes, previewPayload(fileId, exp));
}

/** GET /api/public/self-learning/files/:id — the current file of a published lesson, or any file with a preview signature. */
selfLearningRouter.get("/public/self-learning/files/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^slf_[a-f0-9]{16}$/.test(id)) return c.text("Not found", 404);
  const file = await c.env.DB.prepare(`SELECT f.r2_key, l.status, l.current_file_id FROM self_learning_files f
    JOIN self_learning_lessons l ON l.id = f.lesson_id WHERE f.id = ?`).bind(id).first<{ r2_key: string; status: string; current_file_id: string | null }>();
  if (!file) return c.text("Not found", 404);
  const live = file.status === "published" && file.current_file_id === id;
  const preview = !live && c.req.query("sig") ? await validPreview(c, id) : false;
  if (!live && !preview) return c.text("Not found", 404);
  const object = await c.env.ASSETS.get(file.r2_key);
  if (!object) return c.text("Not found", 404);
  const ancestors = allowedOrigins(c.env.FRONTEND_ORIGINS).join(" ") || "'none'";
  return new Response(object.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `frame-ancestors ${ancestors}; base-uri 'none'; form-action 'none'`,
      "Cache-Control": live ? "public, max-age=300" : "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }
  });
});

// ==========================================
// Public listing
// ==========================================

const PUBLIC_COLUMNS = "slug, title, title_en, summary, summary_en, cover_url, level, published_at, updated_at";

selfLearningRouter.get("/public/self-learning", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT ${PUBLIC_COLUMNS} FROM self_learning_lessons
    WHERE status = 'published' AND current_file_id IS NOT NULL ORDER BY sort_order, published_at LIMIT 200`).all();
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ lessons: rows.results });
});

selfLearningRouter.get("/public/self-learning/:slug", async (c) => {
  const slug = c.req.param("slug").toLowerCase();
  if (!SLUG_RE.test(slug)) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
  const row = await c.env.DB.prepare(`SELECT ${PUBLIC_COLUMNS}, current_file_id FROM self_learning_lessons
    WHERE slug = ? AND status = 'published' AND current_file_id IS NOT NULL`).bind(slug).first<Obj & { current_file_id: string }>();
  if (!row) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
  const { current_file_id, ...lesson } = row;
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ lesson: { ...lesson, content_url: fileUrl(c, current_file_id) } });
});

// ==========================================
// Console  (/api/self-learning/*, site.self_learning)
// ==========================================

selfLearningRouter.use("/self-learning/*", rbac(), permit("site.self_learning"));
selfLearningRouter.use("/self-learning/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

const CONSOLE_SELECT = `SELECT l.*, f.version AS file_version, f.size_bytes AS file_size, f.uses_kit, f.created_at AS file_uploaded_at,
    (SELECT COUNT(*) FROM self_learning_progress p WHERE p.lesson_id = l.id) AS learners,
    (SELECT COUNT(*) FROM self_learning_progress p WHERE p.lesson_id = l.id AND p.completed_at IS NOT NULL) AS completed
  FROM self_learning_lessons l LEFT JOIN self_learning_files f ON f.id = l.current_file_id`;

async function loadLesson(c: C, id: string) {
  return c.env.DB.prepare(`${CONSOLE_SELECT} WHERE l.id = ?`).bind(id).first<LessonRow & Obj>();
}

const fileView = (f: FileRow) => ({
  id: f.id, version: f.version, filename: f.filename, size_bytes: f.size_bytes, uses_kit: !!f.uses_kit,
  external_hosts: f.external_hosts ? JSON.parse(f.external_hosts) as string[] : [], created_at: f.created_at
});

async function slugTaken(c: C, slug: string, exceptId?: string): Promise<boolean> {
  return !!await c.env.DB.prepare("SELECT 1 FROM self_learning_lessons WHERE slug = ? AND id != ?").bind(slug, exceptId ?? "").first();
}

selfLearningRouter.get("/self-learning/lessons", async (c) => {
  const rows = await c.env.DB.prepare(`${CONSOLE_SELECT} ORDER BY l.sort_order, l.created_at LIMIT 500`).all();
  return c.json({ lessons: rows.results });
});

selfLearningRouter.get("/self-learning/lessons/:id", async (c) => {
  const lesson = await loadLesson(c, c.req.param("id"));
  if (!lesson) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
  const files = await c.env.DB.prepare("SELECT * FROM self_learning_files WHERE lesson_id = ? ORDER BY version DESC LIMIT 50")
    .bind(lesson.id).all<FileRow>();
  return c.json({ lesson, files: files.results.map(fileView) });
});

selfLearningRouter.post("/self-learning/lessons", async (c) => {
  let values;
  try { values = parseLesson(await readJson(c), false); } catch (e) { if (e instanceof Invalid) return c.json({ error: e.message }, 400); throw e; }
  if (await slugTaken(c, values.slug!)) return c.json({ error: "ลิงก์ (slug) นี้มีบทเรียนอื่นใช้แล้ว" }, 409);
  const id = newId("sll");
  const next = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM self_learning_lessons").first<{ n: number }>();
  await c.env.DB.prepare(`INSERT INTO self_learning_lessons (id, ${LESSON_COLUMNS.join(", ")}, sort_order, created_by)
    VALUES (?, ${LESSON_COLUMNS.map(() => "?").join(", ")}, ?, ?)`)
    .bind(id, ...LESSON_COLUMNS.map(k => values[k] ?? null), next?.n ?? 0, c.get("user").id).run();
  await audit(c, "create", id, { title: values.title, slug: values.slug });
  return c.json({ lesson: await loadLesson(c, id) }, 201);
});

selfLearningRouter.patch("/self-learning/lessons/:id", async (c) => {
  const id = c.req.param("id");
  let values;
  try { values = parseLesson(await readJson(c), true); } catch (e) { if (e instanceof Invalid) return c.json({ error: e.message }, 400); throw e; }
  const keys = Object.keys(values) as Array<keyof typeof values>;
  if (!keys.length) return c.json({ error: "ไม่มีข้อมูลที่ต้องแก้ไข" }, 400);
  if (values.slug && await slugTaken(c, values.slug, id)) return c.json({ error: "ลิงก์ (slug) นี้มีบทเรียนอื่นใช้แล้ว" }, 409);
  const result = await c.env.DB.prepare(`UPDATE self_learning_lessons SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(...keys.map(k => values[k] ?? null), id).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
  await audit(c, "update", id, values);
  return c.json({ lesson: await loadLesson(c, id) });
});

/** POST /api/self-learning/lessons/:id/file (multipart "file") — stores a new version and makes it current. */
selfLearningRouter.post("/self-learning/lessons/:id/file", async (c) => {
  const db = c.env.DB;
  const lesson = await loadLesson(c, c.req.param("id"));
  if (!lesson) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File)) return c.json({ error: "กรุณาเลือกไฟล์ .html" }, 400);
  if (!/\.html?$/i.test(file.name) && file.type !== "text/html") return c.json({ error: "รองรับเฉพาะไฟล์ .html" }, 400);
  if (file.size > MAX_FILE_BYTES) return c.json({ error: `ไฟล์ต้องไม่เกิน ${MAX_FILE_BYTES / 1024 / 1024} MB` }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const report = inspectHtml(bytes);
  if ("error" in report) return c.json({ error: report.error }, 400);
  const last = await db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM self_learning_files WHERE lesson_id = ?").bind(lesson.id).first<{ v: number }>();
  const version = (last?.v ?? 0) + 1;
  const fileId = newId("slf");
  const key = `self-learning/${lesson.id}/${fileId}.html`;
  await c.env.ASSETS.put(key, bytes, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await db.batch([
    db.prepare(`INSERT INTO self_learning_files (id, lesson_id, version, r2_key, filename, size_bytes, uses_kit, external_hosts, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(fileId, lesson.id, version, key, file.name.slice(0, 200), bytes.length, report.usesKit ? 1 : 0, JSON.stringify(report.hosts), c.get("user").id),
    db.prepare("UPDATE self_learning_lessons SET current_file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(fileId, lesson.id)
  ]);
  await audit(c, "upload", lesson.id, { version, size: bytes.length });
  const row = await db.prepare("SELECT * FROM self_learning_files WHERE id = ?").bind(fileId).first<FileRow>();
  return c.json({ lesson: await loadLesson(c, lesson.id), file: fileView(row!) }, 201);
});

/** Rolls the lesson back (or forward) to one of its stored versions. */
selfLearningRouter.post("/self-learning/lessons/:id/files/:fileId/restore", async (c) => {
  const { id, fileId } = c.req.param();
  const file = await c.env.DB.prepare("SELECT version FROM self_learning_files WHERE id = ? AND lesson_id = ?").bind(fileId, id).first<{ version: number }>();
  if (!file) return c.json({ error: "ไม่พบไฟล์เวอร์ชันนี้" }, 404);
  await c.env.DB.prepare("UPDATE self_learning_lessons SET current_file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(fileId, id).run();
  await audit(c, "restore", id, { version: file.version });
  return c.json({ lesson: await loadLesson(c, id) });
});

/** Signed link that opens a draft or an older version for 30 minutes. */
selfLearningRouter.get("/self-learning/lessons/:id/preview", async (c) => {
  const id = c.req.param("id");
  const fileId = c.req.query("file_id")
    || (await c.env.DB.prepare("SELECT current_file_id FROM self_learning_lessons WHERE id = ?").bind(id).first<{ current_file_id: string | null }>())?.current_file_id;
  if (!fileId) return c.json({ error: "บทเรียนนี้ยังไม่มีไฟล์" }, 404);
  const file = await c.env.DB.prepare("SELECT 1 FROM self_learning_files WHERE id = ? AND lesson_id = ?").bind(fileId, id).first();
  if (!file) return c.json({ error: "ไม่พบไฟล์เวอร์ชันนี้" }, 404);
  return c.json({ url: await previewUrl(c, fileId), expires_minutes: PREVIEW_TTL_MS / 60000 });
});

selfLearningRouter.post("/self-learning/lessons/:id/publish", async (c) => {
  const id = c.req.param("id");
  const lesson = await loadLesson(c, id);
  if (!lesson) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
  if (!lesson.current_file_id) return c.json({ error: "อัปโหลดไฟล์บทเรียนก่อนเผยแพร่" }, 400);
  await c.env.DB.prepare(`UPDATE self_learning_lessons SET status = 'published', published_at = COALESCE(published_at, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();
  await audit(c, "publish", id);
  return c.json({ lesson: await loadLesson(c, id) });
});

selfLearningRouter.post("/self-learning/lessons/:id/unpublish", async (c) => {
  const id = c.req.param("id");
  const result = await c.env.DB.prepare("UPDATE self_learning_lessons SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
  await audit(c, "unpublish", id);
  return c.json({ lesson: await loadLesson(c, id) });
});

/** POST /api/self-learning/reorder { ids: [...] } — the given order becomes sort_order 0..n. */
selfLearningRouter.post("/self-learning/reorder", async (c) => {
  const body = await readJson(c);
  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string").slice(0, 500) : [];
  if (!ids.length) return c.json({ error: "กรุณาระบุลำดับบทเรียน" }, 400);
  await c.env.DB.batch(ids.map((id, i) => c.env.DB.prepare("UPDATE self_learning_lessons SET sort_order = ? WHERE id = ?").bind(i, id)));
  await audit(c, "reorder", null, { count: ids.length });
  return c.json({ message: "บันทึกลำดับแล้ว" });
});

selfLearningRouter.delete("/self-learning/lessons/:id", async (c) => {
  const id = c.req.param("id");
  // A published lesson, or one with learner progress, needs an emailed code from its creator or an admin.
  const denied = await requireDeleteConfirmation(c, "self_learning.delete", id);
  if (denied) return denied;
  const files = await c.env.DB.prepare("SELECT r2_key FROM self_learning_files WHERE lesson_id = ?").bind(id).all<{ r2_key: string }>();
  const [, , result] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM self_learning_progress WHERE lesson_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM self_learning_files WHERE lesson_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM self_learning_lessons WHERE id = ?").bind(id)
  ]);
  if (!result.meta.changes) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
  // R2 objects are removed best effort after the rows.
  for (const { r2_key } of files.results) await c.env.ASSETS.delete(r2_key).catch(() => undefined);
  await audit(c, "delete", id);
  return c.json({ message: "ลบบทเรียนแล้ว" });
});

// ==========================================
// Learner progress  (/api/me/self-learning, any signed-in account)
// ==========================================

selfLearningRouter.use("/me/self-learning", rbac());
selfLearningRouter.use("/me/self-learning/*", rbac());
selfLearningRouter.use("/me/self-learning/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

/** Progress on every published lesson, for the lesson cards. */
selfLearningRouter.get("/me/self-learning", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT l.slug, p.percent, p.completed_at, p.updated_at FROM self_learning_progress p
    JOIN self_learning_lessons l ON l.id = p.lesson_id WHERE p.user_id = ? AND l.status = 'published'`).bind(c.get("user").id).all();
  c.header("Cache-Control", "no-store");
  return c.json({ progress: rows.results });
});

const publishedLesson = (c: C, slug: string) => SLUG_RE.test(slug)
  ? c.env.DB.prepare("SELECT id FROM self_learning_lessons WHERE slug = ? AND status = 'published'").bind(slug).first<{ id: string }>()
  : Promise.resolve(null);

selfLearningRouter.get("/me/self-learning/:slug", async (c) => {
  const lesson = await publishedLesson(c, c.req.param("slug").toLowerCase());
  if (!lesson) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
  const row = await c.env.DB.prepare("SELECT percent, state, completed_at, updated_at FROM self_learning_progress WHERE user_id = ? AND lesson_id = ?")
    .bind(c.get("user").id, lesson.id).first<{ percent: number; state: string | null; completed_at: string | null; updated_at: string }>();
  if (!row) return c.json({ progress: null });
  let state: unknown = null;
  try { state = row.state ? JSON.parse(row.state) : null; } catch { state = null; }
  return c.json({ progress: { ...row, state } });
});

/** PUT /api/me/self-learning/:slug { percent, completed?, state? } — what the lesson last reported. */
selfLearningRouter.put("/me/self-learning/:slug", async (c) => {
  const lesson = await publishedLesson(c, c.req.param("slug").toLowerCase());
  if (!lesson) return c.json({ error: "ไม่พบบทเรียนนี้" }, 404);
  const body = await readJson(c);
  const percent = Number(body.percent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return c.json({ error: "ความคืบหน้าต้องอยู่ระหว่าง 0–100" }, 400);
  const state = body.state === undefined || body.state === null ? null : JSON.stringify(body.state);
  if (state && state.length > MAX_STATE_CHARS) return c.json({ error: "ข้อมูลความคืบหน้ายาวเกิน 64 KB" }, 400);
  const completed = body.completed === true;
  await c.env.DB.prepare(`INSERT INTO self_learning_progress (user_id, lesson_id, percent, state, completed_at, updated_at)
      VALUES (?, ?, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP END, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id, lesson_id) DO UPDATE SET percent = excluded.percent, state = excluded.state,
      completed_at = COALESCE(self_learning_progress.completed_at, excluded.completed_at), updated_at = CURRENT_TIMESTAMP`)
    .bind(c.get("user").id, lesson.id, Math.round(percent), state, completed ? 1 : 0).run();
  return c.json({ message: "บันทึกความคืบหน้าแล้ว" });
});
