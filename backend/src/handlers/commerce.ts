import { Context, Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { permit } from "../utils/permissions";
import { requireDeleteConfirmation } from "../utils/dangerConfirm";
import { appUrl, escapeHtml, sendEmail } from "../utils/email";
import { createNotification } from "./notifications";
import { toCsv } from "../utils/csv";
import { EMPTY_TAX_PROFILE, isValidThaiTaxId, loadTaxProfile, normalizeBranch, normalizeTaxId, TaxProfile, vatBreakdown } from "../utils/tax";
import { COVERED_ELSEWHERE, ORDER_COURSES, loadBankTransfer, loadOrder, nextNumber, nextReference, presentOne, thaiYear } from "./orders";

/**
 * Commerce beyond single course orders (bank transfer only; orders live in orders.ts):
 * - products (commerce.manage): single course, bundle / learning path, membership; learner catalog,
 *   memberships and learning path progress (+ optional path completion certificate)
 * - tax profile of the school (payments.manage)
 * - organization quotations (commerce.manage) that become organization orders
 * - sales reports + CSV (payments.manage or commerce.manage)
 * - daily jobs: abandoned-order reminder, membership expiry reminder/expiry, all-courses sync,
 *   overdue installment suspension, quote expiry (runCommerceJobs, called from jobs.ts)
 * Mounted under /api.
 */
export const commerceRouter = new Hono<Env>();

const nowIso = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
/** Today in Thailand (UTC+7) as YYYY-MM-DD. */
const thaiDate = (at: Date = new Date()) => new Date(at.getTime() + 7 * 3600000).toISOString().slice(0, 10);
const MAX_PRICE = 10_000_000;

async function audit(c: Context<Env>, action: string, entity: string, entityId: string, detail?: unknown) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("log_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), c.get("user").id, action, entity, entityId,
        detail === undefined ? null : JSON.stringify(detail).slice(0, 2000)).run();
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}

// ==========================================
// Products
// ==========================================

type ProductKind = "course" | "bundle" | "membership";
interface ProductRow {
  id: string; kind: ProductKind; title: string; description: string | null; price: number; status: string; course_id: string | null;
  access_days: number | null; all_courses: number; is_path: number; path_certificate: number; max_installments: number;
  installment_interval_days: number; installment_access: "first" | "full"; overdue_grace_days: number; cover_image_url: string | null;
  created_at: string; updated_at: string;
}
interface ProductCourse { product_id: string; course_id: string; title: string; price: number; status: string; sort_order: number }

async function productCourses(db: D1Database, productIds: string[]): Promise<Map<string, ProductCourse[]>> {
  const map = new Map<string, ProductCourse[]>();
  for (let i = 0; i < productIds.length; i += 90) {
    const chunk = productIds.slice(i, i + 90);
    const rows = await db.prepare(`SELECT pc.product_id, pc.course_id, co.title, co.price, co.status, pc.sort_order FROM product_courses pc
      JOIN courses co ON co.id = pc.course_id WHERE pc.product_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY pc.product_id, pc.sort_order, co.title`)
      .bind(...chunk).all<ProductCourse>();
    for (const row of rows.results) {
      if (!map.has(row.product_id)) map.set(row.product_id, []);
      map.get(row.product_id)!.push(row);
    }
  }
  return map;
}

/** Product with its courses and the saving against buying the courses one by one. */
async function presentProducts(db: D1Database, rows: ProductRow[]) {
  const courses = await productCourses(db, rows.map(r => r.id));
  const singles = rows.filter(r => r.kind === "course" && r.course_id).map(r => r.course_id!);
  const singleTitles = new Map<string, { title: string; price: number }>();
  for (let i = 0; i < singles.length; i += 90) {
    const chunk = singles.slice(i, i + 90);
    const res = await db.prepare(`SELECT id, title, price FROM courses WHERE id IN (${chunk.map(() => "?").join(", ")})`).bind(...chunk)
      .all<{ id: string; title: string; price: number }>();
    for (const r of res.results) singleTitles.set(r.id, r);
  }
  const published = rows.some(r => r.all_courses)
    ? await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS total FROM courses WHERE status = 'published'").first<{ n: number; total: number }>()
    : null;
  return rows.map(r => {
    const list = r.kind === "course" && r.course_id && singleTitles.has(r.course_id)
      ? [{ course_id: r.course_id, title: singleTitles.get(r.course_id)!.title, price: singleTitles.get(r.course_id)!.price, sort_order: 0 }]
      : (courses.get(r.id) ?? []).map(({ course_id, title, price, sort_order }) => ({ course_id, title, price, sort_order }));
    const separate = r.all_courses ? Math.round(published?.total ?? 0) : Math.round(list.reduce((sum, c) => sum + (c.price || 0), 0));
    return {
      ...r, all_courses: !!r.all_courses, is_path: !!r.is_path, path_certificate: !!r.path_certificate,
      courses: list, course_count: r.all_courses ? published?.n ?? 0 : list.length,
      separate_price: separate, savings: r.kind === "bundle" ? Math.max(0, separate - r.price) : 0
    };
  });
}

const PRODUCT_LIST = "SELECT * FROM products";
/** Public / learner listings: explicit columns, never staff fields such as created_by. */
const PUBLIC_PRODUCT_LIST = `SELECT id, kind, title, description, price, status, course_id, access_days, all_courses, is_path, path_certificate,
  max_installments, installment_interval_days, installment_access, overdue_grace_days, cover_image_url, created_at, updated_at FROM products`;

/** Public catalog: published bundles, learning paths, memberships and course packages. GET /api/commerce/products?kind= */
commerceRouter.get("/commerce/products", async (c) => {
  const kind = c.req.query("kind");
  const rows = await c.env.DB.prepare(`${PUBLIC_PRODUCT_LIST} WHERE status = 'published' AND (? IS NULL OR kind = ?) ORDER BY kind, price`)
    .bind(kind ?? null, kind ?? null).all<ProductRow>();
  return c.json({ products: await presentProducts(c.env.DB, rows.results) });
});

commerceRouter.get("/commerce/products/:id", async (c) => {
  const row = await c.env.DB.prepare(`${PUBLIC_PRODUCT_LIST} WHERE id = ? AND status = 'published'`).bind(c.req.param("id")).first<ProductRow>();
  if (!row) return c.json({ error: "ไม่พบแพ็กเกจนี้" }, 404);
  return c.json({ product: (await presentProducts(c.env.DB, [row]))[0] });
});

/** Learner view of the catalog with what they already hold. GET /api/student/products */
commerceRouter.get("/student/products", rbac(), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const rows = await db.prepare(`${PUBLIC_PRODUCT_LIST} WHERE status = 'published' ORDER BY kind, price`).all<ProductRow>();
  const products = await presentProducts(db, rows.results);
  const memberships = await db.prepare("SELECT product_id, status, expires_at FROM memberships WHERE user_id = ?").bind(user.id)
    .all<{ product_id: string; status: string; expires_at: string }>();
  const enrolled = await db.prepare(`SELECT course_id, status, progress_percent, expires_at FROM enrollments WHERE user_id = ?
    AND status IN ('active', 'completed') AND (expires_at IS NULL OR expires_at > ?)`).bind(user.id, nowIso())
    .all<{ course_id: string; status: string; progress_percent: number; expires_at: string | null }>();
  const open = await db.prepare(`SELECT id, product_id, status, reference FROM course_orders WHERE user_id = ? AND product_id IS NOT NULL
    AND status IN ('pending', 'partial')`).bind(user.id).all<{ id: string; product_id: string; status: string; reference: string }>();
  const active = new Set(enrolled.results.map(e => e.course_id));
  return c.json({
    products: products.map(p => ({
      ...p,
      membership: memberships.results.find(m => m.product_id === p.id) ?? null,
      owned_courses: p.courses.filter(course => active.has(course.course_id)).length,
      open_order: open.results.find(o => o.product_id === p.id) ?? null
    }))
  });
});

/** My memberships. GET /api/student/memberships */
commerceRouter.get("/student/memberships", rbac(), async (c) => {
  const rows = await c.env.DB.prepare(`SELECT m.id, m.product_id, p.title, p.all_courses, m.started_at, m.expires_at, m.status, m.last_order_id
    FROM memberships m JOIN products p ON p.id = m.product_id WHERE m.user_id = ? ORDER BY m.expires_at DESC`)
    .bind(c.get("user").id).all<Record<string, unknown>>();
  const now = nowIso();
  return c.json({
    memberships: rows.results.map(m => ({ ...m, all_courses: !!m.all_courses,
      active: m.status === "active" && String(m.expires_at) > now,
      days_left: Math.max(0, Math.ceil((new Date(String(m.expires_at)).getTime() - Date.now()) / 86400000)) }))
  });
});

// ---------- Learning paths ----------

async function pathProgress(db: D1Database, userId: string, product: ProductRow) {
  const courses = (await productCourses(db, [product.id])).get(product.id) ?? [];
  const now = nowIso();
  const enrollments = courses.length ? await db.prepare(`SELECT course_id, status, progress_percent, completed_at, expires_at FROM enrollments
    WHERE user_id = ? AND course_id IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(courses.map(x => x.course_id)))
    .all<{ course_id: string; status: string; progress_percent: number | null; completed_at: string | null; expires_at: string | null }>() : { results: [] };
  const byCourse = new Map(enrollments.results.map(e => [e.course_id, e]));
  let previousDone = true;
  const steps = courses.map((course, index) => {
    const e = byCourse.get(course.course_id);
    const done = !!e && (e.status === "completed" || !!e.completed_at);
    const access = !!e && ["active", "completed"].includes(e.status) && (!e.expires_at || e.expires_at > now);
    const step = { step: index + 1, course_id: course.course_id, title: course.title, progress_percent: done ? 100 : e?.progress_percent ?? 0,
      completed: done, has_access: access, recommended_next: !done && previousDone };
    previousDone = previousDone && done;
    return step;
  });
  const percent = steps.length ? Math.round(steps.reduce((sum, s) => sum + s.progress_percent, 0) / steps.length) : 0;
  const certificate = await db.prepare("SELECT certificate_code, issued_at FROM path_certificates WHERE product_id = ? AND user_id = ?")
    .bind(product.id, userId).first<{ certificate_code: string; issued_at: string }>();
  return { steps, progress_percent: percent, completed: steps.length > 0 && steps.every(s => s.completed), certificate: certificate ?? null };
}

/** Learning paths (bundles flagged is_path) with my progress. GET /api/student/paths */
commerceRouter.get("/student/paths", rbac(), async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(`${PUBLIC_PRODUCT_LIST} WHERE kind = 'bundle' AND is_path = 1 AND status = 'published' ORDER BY title`).all<ProductRow>();
  const presented = await presentProducts(db, rows.results);
  const paths = [];
  for (let i = 0; i < rows.results.length; i++) {
    const progress = await pathProgress(db, c.get("user").id, rows.results[i]);
    paths.push({ ...presented[i], progress_percent: progress.progress_percent, completed: progress.completed,
      started: progress.steps.some(s => s.has_access), certificate: progress.certificate });
  }
  return c.json({ paths });
});

commerceRouter.get("/student/paths/:id", rbac(), async (c) => {
  const db = c.env.DB;
  const product = await db.prepare(`${PUBLIC_PRODUCT_LIST} WHERE id = ? AND kind = 'bundle' AND is_path = 1 AND status IN ('published', 'archived')`)
    .bind(c.req.param("id")).first<ProductRow>();
  if (!product) return c.json({ error: "ไม่พบเส้นทางการเรียนนี้" }, 404);
  const progress = await pathProgress(db, c.get("user").id, product);
  return c.json({ path: (await presentProducts(db, [product]))[0], ...progress });
});

/** Claims the path completion certificate once every course of the path is completed. POST /api/student/paths/:id/certificate */
commerceRouter.post("/student/paths/:id/certificate", rbac(), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  // Drafts are never claimable; an archived path only for learners who bought it (checked below like every path).
  const product = await db.prepare(`${PUBLIC_PRODUCT_LIST} WHERE id = ? AND kind = 'bundle' AND is_path = 1 AND status IN ('published', 'archived')`)
    .bind(c.req.param("id")).first<ProductRow>();
  if (!product) return c.json({ error: "ไม่พบเส้นทางการเรียนนี้" }, 404);
  if (!product.path_certificate) return c.json({ error: "เส้นทางนี้ไม่มีใบประกาศ" }, 400);
  // Completing the same courses some other way does not earn the path certificate: the path must have been bought.
  const bought = await db.prepare(`SELECT 1 FROM course_orders WHERE user_id = ? AND product_id = ? AND status IN ('paid', 'partial')
    AND access_granted_at IS NOT NULL AND suspended_at IS NULL LIMIT 1`).bind(user.id, product.id).first();
  if (!bought) return c.json({ error: "ต้องซื้อเส้นทางการเรียนนี้ก่อนรับใบประกาศ" }, 403);
  const progress = await pathProgress(db, user.id, product);
  if (!progress.completed) return c.json({ error: "ต้องเรียนจบทุกคอร์สในเส้นทางก่อนรับใบประกาศ" }, 400);
  const code = "NPP-" + crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  await db.prepare("INSERT OR IGNORE INTO path_certificates (id, product_id, user_id, certificate_code) VALUES (?, ?, ?, ?)")
    .bind(newId("pcert"), product.id, user.id, code).run();
  const cert = await db.prepare(`SELECT pc.certificate_code, pc.issued_at, u.name AS student_name FROM path_certificates pc JOIN users u ON u.id = pc.user_id
    WHERE pc.product_id = ? AND pc.user_id = ?`).bind(product.id, user.id).first<{ certificate_code: string; issued_at: string; student_name: string }>();
  return c.json({ certificate: { ...cert, path_title: product.title } });
});

/** Public verification of a path certificate. GET /api/commerce/path-certificates/:code */
commerceRouter.get("/commerce/path-certificates/:code", async (c) => {
  const row = await c.env.DB.prepare(`SELECT pc.certificate_code, pc.issued_at, u.name AS student_name, p.title AS path_title
    FROM path_certificates pc JOIN users u ON u.id = pc.user_id JOIN products p ON p.id = pc.product_id WHERE pc.certificate_code = ?`)
    .bind(c.req.param("code").trim().toUpperCase()).first();
  if (!row) return c.json({ error: "ไม่พบใบประกาศนี้" }, 404);
  return c.json({ certificate: row });
});

// ---------- Manage products (commerce.manage) ----------

commerceRouter.use("/manage/products", rbac(), permit("commerce.manage"));
commerceRouter.use("/manage/products/*", rbac(), permit("commerce.manage"));
commerceRouter.use("/manage/memberships", rbac(), permit("commerce.manage", "payments.manage"));

commerceRouter.get("/manage/products", async (c) => {
  const rows = await c.env.DB.prepare(`${PRODUCT_LIST} ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, kind, title`).all<ProductRow>();
  const sold = await c.env.DB.prepare(`SELECT product_id, COUNT(*) AS n FROM course_orders WHERE product_id IS NOT NULL AND status IN ('paid', 'partial')
    GROUP BY product_id`).all<{ product_id: string; n: number }>();
  const soldBy = new Map(sold.results.map(r => [r.product_id, r.n]));
  return c.json({ products: (await presentProducts(c.env.DB, rows.results)).map(p => ({ ...p, sold: soldBy.get(p.id) ?? 0 })) });
});

const intIn = (value: unknown, min: number, max: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Validates a product body (merged over `current` on update); returns the row values or a Thai error. */
async function parseProduct(db: D1Database, body: Record<string, unknown>, current?: ProductRow & { course_ids: string[] }):
  Promise<{ ok: true; value: Omit<ProductRow, "id" | "created_at" | "updated_at">; courseIds: string[] } | { ok: false; error: string }> {
  const get = <K extends string>(key: K, fallback: unknown) => body[key] === undefined ? fallback : body[key];
  const kind = get("kind", current?.kind);
  if (kind !== "course" && kind !== "bundle" && kind !== "membership") return { ok: false, error: "ประเภทต้องเป็นคอร์สเดี่ยว ชุดคอร์ส หรือสมาชิก" };
  if (current && kind !== current.kind) return { ok: false, error: "เปลี่ยนประเภทของแพ็กเกจที่สร้างแล้วไม่ได้" };
  const title = String(get("title", current?.title) ?? "").trim();
  if (!title || title.length > 200) return { ok: false, error: "กรุณากรอกชื่อแพ็กเกจ (ไม่เกิน 200 ตัวอักษร)" };
  const descriptionRaw = get("description", current?.description);
  const description = typeof descriptionRaw === "string" ? descriptionRaw.trim().slice(0, 5000) : null;
  const price = intIn(get("price", current?.price), 0, MAX_PRICE);
  if (price === null) return { ok: false, error: "ราคาต้องเป็นจำนวนเต็มบาท 0–10,000,000" };
  const status = get("status", current?.status ?? "draft");
  if (status !== "draft" && status !== "published" && status !== "archived") return { ok: false, error: "สถานะไม่ถูกต้อง" };
  const accessRaw = get("access_days", current?.access_days ?? null);
  const accessDays = accessRaw === null || accessRaw === "" ? null : intIn(accessRaw, 1, 3650);
  if (accessRaw !== null && accessRaw !== "" && accessDays === null) return { ok: false, error: "ระยะเวลาเข้าเรียนต้องเป็น 1–3650 วัน" };
  if (kind === "membership" && !accessDays) return { ok: false, error: "สมาชิกต้องกำหนดจำนวนวัน (1–3650)" };
  const allCourses = kind === "membership" && !!get("all_courses", !!current?.all_courses);
  const isPath = kind === "bundle" && !!get("is_path", !!current?.is_path);
  const pathCertificate = isPath && !!get("path_certificate", !!current?.path_certificate);
  const maxInstallments = intIn(get("max_installments", current?.max_installments ?? 1), 1, 6);
  if (maxInstallments === null) return { ok: false, error: "จำนวนงวดสูงสุดต้องเป็น 1–6" };
  const interval = intIn(get("installment_interval_days", current?.installment_interval_days ?? 30), 7, 90);
  if (interval === null) return { ok: false, error: "ระยะห่างแต่ละงวดต้องเป็น 7–90 วัน" };
  const access = get("installment_access", current?.installment_access ?? "first");
  if (access !== "first" && access !== "full") return { ok: false, error: "เงื่อนไขเปิดสิทธิ์ผ่อนชำระไม่ถูกต้อง" };
  const grace = intIn(get("overdue_grace_days", current?.overdue_grace_days ?? 7), 0, 60);
  if (grace === null) return { ok: false, error: "ระยะผ่อนผันต้องเป็น 0–60 วัน" };
  const coverRaw = get("cover_image_url", current?.cover_image_url ?? null);
  const cover = typeof coverRaw === "string" && coverRaw.trim() ? coverRaw.trim() : null;
  if (cover && (cover.length > 500 || !/^(https:\/\/|\/)/.test(cover))) return { ok: false, error: "ลิงก์รูปปกต้องขึ้นต้นด้วย https:// หรือ /" };

  let courseId: string | null = null;
  let courseIds: string[] = [];
  if (kind === "course") {
    courseId = String(get("course_id", current?.course_id) ?? "");
    const course = courseId ? await db.prepare("SELECT id FROM courses WHERE id = ?").bind(courseId).first() : null;
    if (!course) return { ok: false, error: "กรุณาเลือกคอร์ส" };
  } else if (!allCourses) {
    const raw = get("course_ids", current?.course_ids ?? []);
    if (!Array.isArray(raw) || raw.some(v => typeof v !== "string")) return { ok: false, error: "รายการคอร์สไม่ถูกต้อง" };
    courseIds = [...new Set(raw as string[])];
    if (courseIds.length < (kind === "bundle" ? 2 : 1) || courseIds.length > 50) {
      return { ok: false, error: kind === "bundle" ? "ชุดคอร์สต้องมี 2–50 คอร์ส" : "สมาชิกต้องเลือกอย่างน้อย 1 คอร์ส หรือเลือกทุกคอร์ส" };
    }
    const found = await db.prepare(`SELECT COUNT(*) AS n FROM courses WHERE id IN (${courseIds.map(() => "?").join(", ")})`).bind(...courseIds).first<{ n: number }>();
    if ((found?.n ?? 0) !== courseIds.length) return { ok: false, error: "พบคอร์สที่ไม่มีอยู่ในระบบ" };
  }
  return {
    ok: true, courseIds,
    value: { kind, title, description, price, status, course_id: courseId, access_days: accessDays, all_courses: allCourses ? 1 : 0,
      is_path: isPath ? 1 : 0, path_certificate: pathCertificate ? 1 : 0, max_installments: maxInstallments, installment_interval_days: interval,
      installment_access: access, overdue_grace_days: grace, cover_image_url: cover }
  };
}

function productCourseStatements(db: D1Database, productId: string, courseIds: string[]) {
  return [
    db.prepare("DELETE FROM product_courses WHERE product_id = ?").bind(productId),
    ...courseIds.map((courseId, index) => db.prepare("INSERT INTO product_courses (product_id, course_id, sort_order) VALUES (?, ?, ?)")
      .bind(productId, courseId, index))
  ];
}

const PRODUCT_COLUMNS = ["kind", "title", "description", "price", "status", "course_id", "access_days", "all_courses", "is_path", "path_certificate",
  "max_installments", "installment_interval_days", "installment_access", "overdue_grace_days", "cover_image_url"] as const;

commerceRouter.post("/manage/products", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const parsed = await parseProduct(db, body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const id = newId("prod");
  const v = parsed.value;
  await db.batch([
    db.prepare(`INSERT INTO products (id, ${PRODUCT_COLUMNS.join(", ")}, created_by) VALUES (?, ${PRODUCT_COLUMNS.map(() => "?").join(", ")}, ?)`)
      .bind(id, ...PRODUCT_COLUMNS.map(k => v[k]), c.get("user").id),
    ...productCourseStatements(db, id, parsed.courseIds)
  ]);
  await audit(c, "create", "product", id, { title: v.title, kind: v.kind, price: v.price });
  const row = (await db.prepare(`${PRODUCT_LIST} WHERE id = ?`).bind(id).first<ProductRow>())!;
  return c.json({ product: (await presentProducts(db, [row]))[0] }, 201);
});

commerceRouter.put("/manage/products/:id", async (c) => {
  const db = c.env.DB;
  const current = await db.prepare(`${PRODUCT_LIST} WHERE id = ?`).bind(c.req.param("id")).first<ProductRow>();
  if (!current) return c.json({ error: "ไม่พบแพ็กเกจ" }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const courseIds = ((await productCourses(db, [current.id])).get(current.id) ?? []).map(x => x.course_id);
  const parsed = await parseProduct(db, body, { ...current, course_ids: courseIds });
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const v = parsed.value;
  await db.batch([
    db.prepare(`UPDATE products SET ${PRODUCT_COLUMNS.map(k => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(...PRODUCT_COLUMNS.map(k => v[k]), current.id),
    ...(v.kind === "course" || v.all_courses ? [db.prepare("DELETE FROM product_courses WHERE product_id = ?").bind(current.id)]
      : productCourseStatements(db, current.id, parsed.courseIds))
  ]);
  await audit(c, "update", "product", current.id, { title: v.title, price: v.price, status: v.status });
  const row = (await db.prepare(`${PRODUCT_LIST} WHERE id = ?`).bind(current.id).first<ProductRow>())!;
  return c.json({ product: (await presentProducts(db, [row]))[0] });
});

commerceRouter.delete("/manage/products/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const used = await db.prepare("SELECT (SELECT COUNT(*) FROM course_orders WHERE product_id = ?) + (SELECT COUNT(*) FROM memberships WHERE product_id = ?) AS n")
    .bind(id, id).first<{ n: number }>();
  if ((used?.n ?? 0) > 0) return c.json({ error: "แพ็กเกจนี้มีคำสั่งซื้อหรือสมาชิกแล้ว ให้เปลี่ยนสถานะเป็นเลิกขายแทน" }, 409);
  // A product on sale needs an emailed code from its creator or an admin.
  const denied = await requireDeleteConfirmation(c, "product.delete", id);
  if (denied) return denied;
  const result = await db.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return c.json({ error: "ไม่พบแพ็กเกจ" }, 404);
  await audit(c, "delete", "product", id);
  return c.json({ message: "ลบแพ็กเกจแล้ว" });
});

/** Memberships across learners. GET /api/manage/memberships?status=active|expired|… */
commerceRouter.get("/manage/memberships", async (c) => {
  const status = c.req.query("status");
  const rows = await c.env.DB.prepare(`SELECT m.*, p.title, u.name AS user_name, u.email AS user_email FROM memberships m
    JOIN products p ON p.id = m.product_id JOIN users u ON u.id = m.user_id WHERE (? IS NULL OR m.status = ?) ORDER BY m.expires_at LIMIT 500`)
    .bind(status ?? null, status ?? null).all();
  return c.json({ memberships: rows.results });
});

// ==========================================
// School tax profile (payments.manage)
// ==========================================

commerceRouter.use("/manage/tax-profile", rbac(), permit("payments.manage"));

commerceRouter.get("/manage/tax-profile", async (c) => c.json({ profile: await loadTaxProfile(c.env.DB) }));

commerceRouter.put("/manage/tax-profile", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const current = await loadTaxProfile(c.env.DB);
  const next: TaxProfile = { ...EMPTY_TAX_PROFILE, ...current };
  const text = (key: "company_name" | "address" | "phone", max: number, label: string) => {
    if (body[key] === undefined) return null;
    if (typeof body[key] !== "string" || (body[key] as string).trim().length > max) return `${label}ไม่ถูกต้อง (ไม่เกิน ${max} ตัวอักษร)`;
    next[key] = (body[key] as string).trim();
    return null;
  };
  const error = text("company_name", 200, "ชื่อผู้ประกอบการ") || text("address", 500, "ที่อยู่") || text("phone", 50, "เบอร์โทรศัพท์");
  if (error) return c.json({ error }, 400);
  if (body.tax_id !== undefined) next.tax_id = normalizeTaxId(body.tax_id);
  if (body.branch !== undefined) {
    const branch = normalizeBranch(body.branch);
    if (!branch) return c.json({ error: "สาขาต้องเป็น \"สำนักงานใหญ่\" หรือเลขสาขา 5 หลัก" }, 400);
    next.branch = branch;
  }
  if (body.vat_registered !== undefined) next.vat_registered = body.vat_registered === true;
  if (next.tax_id && !isValidThaiTaxId(next.tax_id)) return c.json({ error: "เลขประจำตัวผู้เสียภาษีของโรงเรียนไม่ถูกต้อง (13 หลัก ตรวจสอบหลักสุดท้าย)" }, 400);
  if (next.vat_registered && (!next.tax_id || !next.company_name || !next.address)) {
    return c.json({ error: "จดทะเบียนภาษีมูลค่าเพิ่มต้องกรอกชื่อผู้ประกอบการ เลขประจำตัวผู้เสียภาษี และที่อยู่ให้ครบ" }, 400);
  }
  await c.env.DB.prepare(`INSERT INTO payment_settings (key, value, updated_by, updated_at) VALUES ('tax_profile', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
    .bind(JSON.stringify(next), c.get("user").id).run();
  await audit(c, "update", "payment_settings", "tax_profile", next);
  return c.json({ profile: next });
});

// ==========================================
// Organization quotes (commerce.manage)
// ==========================================

commerceRouter.use("/manage/quotes", rbac(), permit("commerce.manage"));
commerceRouter.use("/manage/quotes/*", rbac(), permit("commerce.manage"));

interface QuoteRow {
  id: string; quote_no: string; partner_id: string; title: string; contact_name: string | null; contact_email: string | null;
  buyer_address: string | null; buyer_branch: string | null; seats: number; price: number; valid_until: string; status: string;
  note: string | null; order_id: string | null; created_by: string | null; sent_at: string | null; accepted_at: string | null;
  created_at: string; updated_at: string; company_name?: string; tax_id?: string | null; order_status?: string | null;
  order_reference?: string | null; created_by_name?: string | null;
}

const QUOTE_SELECT = `SELECT q.*, p.company_name, p.tax_id, o.status AS order_status, o.reference AS order_reference, u.name AS created_by_name
  FROM quotes q JOIN partners p ON p.id = q.partner_id LEFT JOIN course_orders o ON o.id = q.order_id LEFT JOIN users u ON u.id = q.created_by`;

async function expireQuotes(db: D1Database, today = thaiDate()) {
  const result = await db.prepare(`UPDATE quotes SET status = 'expired', updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('draft', 'sent') AND valid_until < ?`).bind(today).run();
  return result.meta.changes ?? 0;
}

async function presentQuotes(db: D1Database, rows: QuoteRow[]) {
  const map = new Map<string, { course_id: string; title: string; price: number }[]>();
  for (let i = 0; i < rows.length; i += 90) {
    const chunk = rows.slice(i, i + 90).map(r => r.id);
    if (!chunk.length) break;
    const res = await db.prepare(`SELECT qc.quote_id, qc.course_id, co.title, co.price FROM quote_courses qc JOIN courses co ON co.id = qc.course_id
      WHERE qc.quote_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY co.title`).bind(...chunk)
      .all<{ quote_id: string; course_id: string; title: string; price: number }>();
    for (const r of res.results) {
      if (!map.has(r.quote_id)) map.set(r.quote_id, []);
      map.get(r.quote_id)!.push({ course_id: r.course_id, title: r.title, price: r.price });
    }
  }
  return rows.map(r => ({ ...r, courses: map.get(r.id) ?? [], vat: vatBreakdown(r.price, 0) }));
}

async function parseQuote(db: D1Database, body: Record<string, unknown>, current?: QuoteRow & { course_ids: string[] }):
  Promise<{ ok: true; value: Pick<QuoteRow, "partner_id" | "title" | "contact_name" | "contact_email" | "buyer_address" | "buyer_branch" | "seats" | "price" | "valid_until" | "note">; courseIds: string[] } | { ok: false; error: string }> {
  const get = (key: string, fallback: unknown) => body[key] === undefined ? fallback : body[key];
  const partnerId = String(get("partner_id", current?.partner_id) ?? "");
  const partner = partnerId ? await db.prepare("SELECT id FROM partners WHERE id = ?").bind(partnerId).first() : null;
  if (!partner) return { ok: false, error: "กรุณาเลือกองค์กร" };
  const title = String(get("title", current?.title) ?? "").trim();
  if (!title || title.length > 200) return { ok: false, error: "กรุณากรอกหัวข้อใบเสนอราคา (ไม่เกิน 200 ตัวอักษร)" };
  const optional = (key: string, max: number) => {
    const raw = get(key, (current as any)?.[key] ?? null);
    return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : null;
  };
  const contactEmail = optional("contact_email", 200);
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return { ok: false, error: "อีเมลผู้ติดต่อไม่ถูกต้อง" };
  const branchRaw = optional("buyer_branch", 50);
  const branch = branchRaw ? normalizeBranch(branchRaw) : null;
  if (branchRaw && !branch) return { ok: false, error: "สาขาต้องเป็น \"สำนักงานใหญ่\" หรือเลขสาขา 5 หลัก" };
  const seats = intIn(get("seats", current?.seats ?? 0), 0, 100000);
  if (seats === null) return { ok: false, error: "จำนวนที่นั่งต้องเป็นจำนวนเต็ม 0–100,000" };
  const price = intIn(get("price", current?.price), 0, 100_000_000);
  if (price === null) return { ok: false, error: "ราคาต้องเป็นจำนวนเต็มบาท" };
  const validUntil = String(get("valid_until", current?.valid_until) ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil) || isNaN(Date.parse(validUntil))) return { ok: false, error: "กรุณาระบุวันที่ยืนราคา (YYYY-MM-DD)" };
  if (!current && validUntil < thaiDate()) return { ok: false, error: "วันที่ยืนราคาต้องไม่ก่อนวันนี้" };
  const raw = get("course_ids", current?.course_ids ?? []);
  if (!Array.isArray(raw) || raw.some(v => typeof v !== "string")) return { ok: false, error: "รายการคอร์สไม่ถูกต้อง" };
  const courseIds = [...new Set(raw as string[])];
  if (courseIds.length > 50) return { ok: false, error: "เลือกคอร์สได้ไม่เกิน 50 คอร์ส" };
  if (courseIds.length) {
    const found = await db.prepare(`SELECT COUNT(*) AS n FROM courses WHERE id IN (${courseIds.map(() => "?").join(", ")})`).bind(...courseIds).first<{ n: number }>();
    if ((found?.n ?? 0) !== courseIds.length) return { ok: false, error: "พบคอร์สที่ไม่มีอยู่ในระบบ" };
  }
  if (!seats && !courseIds.length) return { ok: false, error: "ใบเสนอราคาต้องมีที่นั่งหรือคอร์สอย่างน้อยหนึ่งรายการ" };
  return { ok: true, courseIds, value: { partner_id: partnerId, title, contact_name: optional("contact_name", 200), contact_email: contactEmail,
    buyer_address: optional("buyer_address", 500), buyer_branch: branch, seats, price, valid_until: validUntil, note: optional("note", 2000) } };
}

const QUOTE_COLUMNS = ["partner_id", "title", "contact_name", "contact_email", "buyer_address", "buyer_branch", "seats", "price", "valid_until", "note"] as const;

/** Replaces a quote's courses; only while the quote is still draft/sent, so an accepted quote's courses never change. */
const QUOTE_EDITABLE = "EXISTS (SELECT 1 FROM quotes WHERE id = ? AND status IN ('draft', 'sent'))";
const quoteCourseStatements = (db: D1Database, quoteId: string, courseIds: string[]) => [
  db.prepare(`DELETE FROM quote_courses WHERE quote_id = ? AND ${QUOTE_EDITABLE}`).bind(quoteId, quoteId),
  ...courseIds.map(courseId => db.prepare(`INSERT INTO quote_courses (quote_id, course_id) SELECT ?, ? WHERE ${QUOTE_EDITABLE}`).bind(quoteId, courseId, quoteId))
];

async function loadQuote(db: D1Database, id: string) {
  return await db.prepare(`${QUOTE_SELECT} WHERE q.id = ?`).bind(id).first<QuoteRow>();
}

commerceRouter.get("/manage/quotes", async (c) => {
  const db = c.env.DB;
  await expireQuotes(db);
  const status = c.req.query("status");
  const rows = await db.prepare(`${QUOTE_SELECT} WHERE (? IS NULL OR q.status = ?) ORDER BY q.created_at DESC LIMIT 200`)
    .bind(status ?? null, status ?? null).all<QuoteRow>();
  return c.json({ quotes: await presentQuotes(db, rows.results) });
});

commerceRouter.get("/manage/quotes/:id", async (c) => {
  const db = c.env.DB;
  await expireQuotes(db);
  const quote = await loadQuote(db, c.req.param("id"));
  if (!quote) return c.json({ error: "ไม่พบใบเสนอราคา" }, 404);
  return c.json({ quote: (await presentQuotes(db, [quote]))[0], seller: await loadTaxProfile(db) });
});

commerceRouter.post("/manage/quotes", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const parsed = await parseQuote(db, body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const id = newId("quote");
  const year = thaiYear();
  const quoteNo = `QT-${year}-${String(await nextNumber(db, `quote_${year}`)).padStart(4, "0")}`;
  const v = parsed.value;
  await db.batch([
    db.prepare(`INSERT INTO quotes (id, quote_no, ${QUOTE_COLUMNS.join(", ")}, status, created_by) VALUES (?, ?, ${QUOTE_COLUMNS.map(() => "?").join(", ")}, 'draft', ?)`)
      .bind(id, quoteNo, ...QUOTE_COLUMNS.map(k => v[k]), c.get("user").id),
    ...quoteCourseStatements(db, id, parsed.courseIds)
  ]);
  await audit(c, "create", "quote", id, { quote_no: quoteNo, partner_id: v.partner_id, price: v.price, seats: v.seats });
  return c.json({ quote: (await presentQuotes(db, [(await loadQuote(db, id))!]))[0] }, 201);
});

commerceRouter.put("/manage/quotes/:id", async (c) => {
  const db = c.env.DB;
  const quote = await loadQuote(db, c.req.param("id"));
  if (!quote) return c.json({ error: "ไม่พบใบเสนอราคา" }, 404);
  if (!["draft", "sent"].includes(quote.status)) return c.json({ error: "แก้ไขได้เฉพาะใบเสนอราคาที่ยังไม่ตอบรับ" }, 400);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const courseIds = (await db.prepare("SELECT course_id FROM quote_courses WHERE quote_id = ?").bind(quote.id).all<{ course_id: string }>()).results.map(r => r.course_id);
  const parsed = await parseQuote(db, body, { ...quote, course_ids: courseIds });
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const v = parsed.value;
  const results = await db.batch([
    db.prepare(`UPDATE quotes SET ${QUOTE_COLUMNS.map(k => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('draft', 'sent')`)
      .bind(...QUOTE_COLUMNS.map(k => v[k]), quote.id),
    ...quoteCourseStatements(db, quote.id, parsed.courseIds)
  ]);
  if (!results[0].meta.changes) return c.json({ error: "ใบเสนอราคานี้ถูกดำเนินการไปแล้ว" }, 409);
  await audit(c, "update", "quote", quote.id, { quote_no: quote.quote_no, price: v.price, seats: v.seats });
  return c.json({ quote: (await presentQuotes(db, [(await loadQuote(db, quote.id))!]))[0] });
});

/** Marks the quote as sent; emails the contact a summary when an address is on file. POST /api/manage/quotes/:id/send */
commerceRouter.post("/manage/quotes/:id/send", async (c) => {
  const db = c.env.DB;
  await expireQuotes(db);
  const quote = await loadQuote(db, c.req.param("id"));
  if (!quote) return c.json({ error: "ไม่พบใบเสนอราคา" }, 404);
  const result = await db.prepare(`UPDATE quotes SET status = 'sent', sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('draft', 'sent')`).bind(quote.id).run();
  if (!result.meta.changes) return c.json({ error: "ส่งได้เฉพาะใบเสนอราคาที่ยังไม่ตอบรับหรือหมดอายุ" }, 400);
  if (quote.contact_email) {
    try {
      const seller = await loadTaxProfile(db);
      await sendEmail(quote.contact_email, `ใบเสนอราคา ${quote.quote_no}: ${quote.title}`, `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eaeaea; padding: 20px; border-radius: 10px;">
          <h2 style="color: #e56b25;">ใบเสนอราคา ${escapeHtml(quote.quote_no)}</h2>
          <p>เรียน ${escapeHtml(quote.contact_name || quote.company_name)}</p>
          <p>${escapeHtml(seller.company_name || "NetPrime")} ขอเสนอราคา "${escapeHtml(quote.title)}" สำหรับ ${escapeHtml(quote.company_name)}</p>
          <p>ที่นั่งเพิ่ม ${escapeHtml(quote.seats)} ที่นั่ง · ราคารวม ${escapeHtml(quote.price.toLocaleString("th-TH"))} บาท (รวมภาษีมูลค่าเพิ่มแล้ว ถ้ามี)</p>
          <p>ยืนราคาถึงวันที่ ${escapeHtml(quote.valid_until)} กรุณาติดต่อเจ้าหน้าที่เพื่อยืนยันและรับเอกสารฉบับเต็ม</p>
        </div>`, c.env.RESEND_API_KEY);
    } catch (error) {
      console.error("Quote email failed:", error);
    }
  }
  await audit(c, "send", "quote", quote.id, { quote_no: quote.quote_no });
  return c.json({ quote: (await presentQuotes(db, [(await loadQuote(db, quote.id))!]))[0] });
});

commerceRouter.post("/manage/quotes/:id/cancel", async (c) => {
  const db = c.env.DB;
  const result = await db.prepare(`UPDATE quotes SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('draft', 'sent')`)
    .bind(c.req.param("id")).run();
  if (!result.meta.changes) return c.json({ error: "ยกเลิกได้เฉพาะใบเสนอราคาที่ยังไม่ตอบรับ" }, 400);
  await audit(c, "cancel", "quote", c.req.param("id"));
  return c.json({ quote: (await presentQuotes(db, [(await loadQuote(db, c.req.param("id")))!]))[0] });
});

/**
 * The organization accepted: create its bank-transfer order (organization kind). Confirming that order
 * (payments.manage, /manage/orders/:id/confirm) adds the seats to the partner and sponsors the courses.
 * POST /api/manage/quotes/:id/accept
 */
commerceRouter.post("/manage/quotes/:id/accept", async (c) => {
  const db = c.env.DB;
  await expireQuotes(db);
  const quote = await loadQuote(db, c.req.param("id"));
  if (!quote) return c.json({ error: "ไม่พบใบเสนอราคา" }, 404);
  if (!["draft", "sent"].includes(quote.status)) {
    return c.json({ error: quote.status === "expired" ? "ใบเสนอราคาหมดอายุแล้ว แก้วันที่ยืนราคาโดยสร้างใบใหม่" : "ใบเสนอราคานี้ถูกดำเนินการไปแล้ว" }, 400);
  }
  try {
    // The order belongs to the organization's HR account when there is one, otherwise to the staff member.
    const owner = await db.prepare("SELECT id FROM users WHERE partner_id = ? AND role = 'partner' ORDER BY created_at LIMIT 1")
      .bind(quote.partner_id).first<{ id: string }>();
    const orderId = newId("ord");
    const reference = await nextReference(db);
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    const taxId = normalizeTaxId(quote.tax_id ?? "");
    const canInvoice = isValidThaiTaxId(taxId) && !!quote.buyer_address;
    const results = await db.batch([
      db.prepare(`UPDATE quotes SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP, order_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('draft', 'sent')`).bind(orderId, quote.id),
      db.prepare(`INSERT INTO course_orders (id, reference, user_id, kind, item_title, partner_id, quote_id, seats, list_price, amount, status, expires_at,
          tax_invoice_requested, buyer_name, buyer_tax_id, buyer_branch, buyer_address)
        SELECT ?, ?, ?, 'organization', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM quotes WHERE id = ? AND order_id = ?)`)
        .bind(orderId, reference, owner?.id ?? c.get("user").id, `${quote.title} (${quote.quote_no})`, quote.partner_id, quote.id, quote.seats,
          quote.price, quote.price, expiresAt, canInvoice ? 1 : 0, canInvoice ? quote.company_name : null, canInvoice ? taxId : null,
          canInvoice ? quote.buyer_branch ?? "สำนักงานใหญ่" : null, canInvoice ? quote.buyer_address : null, quote.id, orderId)
    ]);
    if (!results[0].meta.changes) return c.json({ error: "ใบเสนอราคานี้ถูกดำเนินการไปแล้ว" }, 409);
    await audit(c, "accept", "quote", quote.id, { quote_no: quote.quote_no, order_id: orderId, reference });
    const order = (await loadOrder(db, orderId))!;
    return c.json({ quote: (await presentQuotes(db, [(await loadQuote(db, quote.id))!]))[0], order: await presentOne(db, order),
      instructions: await loadBankTransfer(db) }, 201);
  } catch (error) {
    console.error("Accept quote failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะสร้างคำสั่งซื้อจากใบเสนอราคา" }, 500);
  }
});

// ==========================================
// Sales reports (payments.manage or commerce.manage)
// ==========================================

commerceRouter.use("/manage/commerce/*", rbac(), permit("payments.manage", "commerce.manage"));

interface PaymentLine {
  order_id: string; reference: string; kind: string; title: string; item_id: string | null; voucher_code: string | null;
  list_price: number; order_amount: number; user_name: string; user_email: string; receipt_no: string; tax_invoice_no: string | null;
  paid_at: string; amount: number; vat_rate: number | null; seq: number; installment_count: number; status: string;
}

/** Thai calendar day → UTC ISO bounds [from 00:00, to+1 00:00) at UTC+7. */
function rangeOf(c: Context<Env>): { from: string; to: string; start: string; end: string } | null {
  const today = thaiDate();
  const from = c.req.query("from") || `${today.slice(0, 8)}01`;
  const to = c.req.query("to") || today;
  if (![from, to].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d))) || from > to) return null;
  const start = new Date(`${from}T00:00:00+07:00`).toISOString();
  const end = new Date(new Date(`${to}T00:00:00+07:00`).getTime() + 86400000).toISOString();
  return { from, to, start, end };
}

async function paymentLines(db: D1Database, start: string, end: string): Promise<PaymentLine[]> {
  const columns = `o.id AS order_id, o.reference, o.kind, COALESCE(o.item_title, co.title) AS title, COALESCE(o.product_id, o.course_id, o.quote_id) AS item_id,
    o.voucher_code, o.list_price, o.amount AS order_amount, u.name AS user_name, u.email AS user_email, o.installment_count, o.status`;
  const rows = await db.prepare(`SELECT ${columns}, o.receipt_no, o.tax_invoice_no, o.paid_at, COALESCE(o.amount_received, o.amount) AS amount, o.vat_rate, 0 AS seq
      FROM course_orders o LEFT JOIN courses co ON co.id = o.course_id JOIN users u ON u.id = o.user_id
      WHERE o.installment_count = 1 AND o.receipt_no IS NOT NULL AND o.paid_at >= ?1 AND o.paid_at < ?2
    UNION ALL
    SELECT ${columns}, i.receipt_no, i.tax_invoice_no, i.paid_at, COALESCE(i.amount_received, i.amount) AS amount, i.vat_rate, i.seq
      FROM order_installments i JOIN course_orders o ON o.id = i.order_id LEFT JOIN courses co ON co.id = o.course_id JOIN users u ON u.id = o.user_id
      WHERE i.receipt_no IS NOT NULL AND i.paid_at >= ?1 AND i.paid_at < ?2
    ORDER BY paid_at LIMIT 20000`).bind(start, end).all<PaymentLine>();
  return rows.results;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const KIND_TH: Record<string, string> = { course: "คอร์ส", bundle: "ชุดคอร์ส", membership: "สมาชิก", organization: "องค์กร" };

/**
 * GET /api/manage/commerce/report?from=YYYY-MM-DD&to=YYYY-MM-DD (Thai dates, default: this month)
 * Revenue (receipts issued in the range, installments included) by day, month, product and voucher;
 * refunds in the range; installments still outstanding.
 */
commerceRouter.get("/manage/commerce/report", async (c) => {
  const db = c.env.DB;
  const range = rangeOf(c);
  if (!range) return c.json({ error: "ช่วงวันที่ไม่ถูกต้อง (YYYY-MM-DD)" }, 400);
  const lines = await paymentLines(db, range.start, range.end);
  const byDay = new Map<string, { date: string; receipts: number; revenue: number; vat: number }>();
  const byMonth = new Map<string, { month: string; receipts: number; revenue: number; vat: number }>();
  const byProduct = new Map<string, { item_id: string | null; title: string; kind: string; orders: Set<string>; revenue: number }>();
  const byVoucher = new Map<string, { code: string; orders: Set<string>; revenue: number; discount: number }>();
  let revenue = 0, vat = 0;
  for (const line of lines) {
    const day = thaiDate(new Date(line.paid_at));
    const breakdown = vatBreakdown(line.amount, line.vat_rate);
    revenue += breakdown.total;
    vat += breakdown.vat;
    const d = byDay.get(day) ?? { date: day, receipts: 0, revenue: 0, vat: 0 };
    d.receipts++; d.revenue += breakdown.total; d.vat += breakdown.vat; byDay.set(day, d);
    const month = day.slice(0, 7);
    const m = byMonth.get(month) ?? { month, receipts: 0, revenue: 0, vat: 0 };
    m.receipts++; m.revenue += breakdown.total; m.vat += breakdown.vat; byMonth.set(month, m);
    const key = `${line.kind}:${line.item_id}`;
    const p = byProduct.get(key) ?? { item_id: line.item_id, title: line.title, kind: line.kind, orders: new Set<string>(), revenue: 0 };
    p.orders.add(line.order_id); p.revenue += breakdown.total; byProduct.set(key, p);
    if (line.voucher_code) {
      const v = byVoucher.get(line.voucher_code) ?? { code: line.voucher_code, orders: new Set<string>(), revenue: 0, discount: 0 };
      if (!v.orders.has(line.order_id)) v.discount += Math.max(0, line.list_price - line.order_amount);
      v.orders.add(line.order_id); v.revenue += breakdown.total; byVoucher.set(line.voucher_code, v);
    }
  }
  const refunds = await db.prepare(`SELECT o.id, o.reference, COALESCE(o.item_title, co.title) AS title, u.name AS user_name, o.refunded_at, o.credit_note_no,
      CASE WHEN o.installment_count > 1 THEN (SELECT COALESCE(SUM(amount_received), 0) FROM order_installments WHERE order_id = o.id AND status = 'refunded')
        ELSE COALESCE(o.amount_received, 0) END AS amount
    FROM course_orders o LEFT JOIN courses co ON co.id = o.course_id JOIN users u ON u.id = o.user_id
    WHERE o.status = 'refunded' AND o.refunded_at >= ? AND o.refunded_at < ? ORDER BY o.refunded_at`).bind(range.start, range.end)
    .all<{ id: string; reference: string; title: string; user_name: string; refunded_at: string; credit_note_no: string | null; amount: number }>();
  const now = nowIso();
  const outstanding = await db.prepare(`SELECT o.id AS order_id, o.reference, COALESCE(o.item_title, co.title) AS title, u.name AS user_name, u.email AS user_email,
      i.seq, o.installment_count, i.amount, i.due_at, o.status AS order_status, o.suspended_at, (i.slip_r2_key IS NOT NULL) AS has_slip
    FROM order_installments i JOIN course_orders o ON o.id = i.order_id LEFT JOIN courses co ON co.id = o.course_id JOIN users u ON u.id = o.user_id
    WHERE i.status = 'pending' AND o.status IN ('pending', 'partial', 'expired') ORDER BY i.due_at LIMIT 1000`)
    .all<{ order_id: string; reference: string; title: string; user_name: string; user_email: string; seq: number; installment_count: number;
      amount: number; due_at: string; order_status: string; suspended_at: string | null; has_slip: number }>();
  const refundTotal = refunds.results.reduce((sum, r) => sum + r.amount, 0);
  return c.json({
    range: { from: range.from, to: range.to },
    totals: {
      receipts: lines.length, revenue: round2(revenue), vat: round2(vat), net_of_vat: round2(revenue - vat),
      refunds: refunds.results.length, refunded_amount: round2(refundTotal), net_revenue: round2(revenue - refundTotal),
      outstanding_installments: outstanding.results.length, outstanding_amount: round2(outstanding.results.reduce((s, r) => s + r.amount, 0)),
      overdue_installments: outstanding.results.filter(r => r.due_at < now).length
    },
    by_day: [...byDay.values()].map(d => ({ ...d, revenue: round2(d.revenue), vat: round2(d.vat) })),
    by_month: [...byMonth.values()].map(m => ({ ...m, revenue: round2(m.revenue), vat: round2(m.vat) })),
    by_product: [...byProduct.values()].map(p => ({ item_id: p.item_id, title: p.title, kind: p.kind, orders: p.orders.size, revenue: round2(p.revenue) }))
      .sort((a, b) => b.revenue - a.revenue),
    by_voucher: [...byVoucher.values()].map(v => ({ code: v.code, orders: v.orders.size, revenue: round2(v.revenue), discount: round2(v.discount) }))
      .sort((a, b) => b.orders - a.orders),
    refunds: refunds.results,
    outstanding: outstanding.results.map(r => ({ ...r, has_slip: !!r.has_slip, overdue: r.due_at < now }))
  });
});

/** Receipt lines of the range as Excel-friendly CSV (UTF-8 BOM, formulas neutralised). GET /api/manage/commerce/report.csv */
commerceRouter.get("/manage/commerce/report.csv", async (c) => {
  const range = rangeOf(c);
  if (!range) return c.json({ error: "ช่วงวันที่ไม่ถูกต้อง (YYYY-MM-DD)" }, 400);
  try {
    const lines = await paymentLines(c.env.DB, range.start, range.end);
    const header = ["วันที่ชำระ", "เลขที่ใบเสร็จ", "เลขที่ใบกำกับภาษี", "เลขที่คำสั่งซื้อ", "ประเภท", "รายการ", "งวด", "ผู้ซื้อ", "อีเมล",
      "โค้ดส่วนลด", "ยอดรับ (บาท)", "มูลค่าก่อนภาษี", "ภาษีมูลค่าเพิ่ม", "สถานะคำสั่งซื้อ"];
    const rows = lines.map(l => {
      const v = vatBreakdown(l.amount, l.vat_rate);
      return [thaiDate(new Date(l.paid_at)), l.receipt_no, l.tax_invoice_no ?? "", l.reference, KIND_TH[l.kind] ?? l.kind, l.title,
        l.seq ? `${l.seq}/${l.installment_count}` : "", l.user_name, l.user_email, l.voucher_code ?? "",
        v.total.toFixed(2), v.base.toFixed(2), v.vat.toFixed(2), l.status];
    });
    return new Response(toCsv(header, rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="sales-${range.from}-${range.to}.csv"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    console.error("Sales CSV export failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะส่งออกรายงาน" }, 500);
  }
});

/**
 * Runs the commerce jobs now (admins). `as_of` (ISO time) simulates a later run and is accepted only by
 * the local test Worker (ALLOW_LOCAL_SEED_PASSWORDS=true). POST /api/manage/commerce/jobs/run { as_of? }
 */
commerceRouter.post("/manage/commerce/jobs/run", async (c) => {
  if (!c.get("user").roles.includes("admin")) return c.json({ error: "เฉพาะผู้ดูแลระบบเท่านั้น" }, 403);
  const body = await c.req.json<{ as_of?: unknown }>().catch(() => ({} as { as_of?: unknown }));
  let at = new Date();
  if (body?.as_of !== undefined) {
    if (c.env.ALLOW_LOCAL_SEED_PASSWORDS !== "true") return c.json({ error: "ใช้ as_of ได้เฉพาะสภาพแวดล้อมทดสอบ" }, 400);
    at = new Date(String(body.as_of));
    if (isNaN(at.getTime())) return c.json({ error: "as_of ไม่ถูกต้อง" }, 400);
  }
  const result = await runCommerceJobs(c.env, at);
  await audit(c, "run", "commerce_jobs", "daily", result);
  return c.json(result);
});

// ==========================================
// Daily jobs
// ==========================================

export interface CommerceJobResult {
  abandoned_reminders: number; membership_reminders: number; memberships_expired: number; memberships_synced: number;
  installments_suspended: number; quotes_expired: number;
}

const sqlTimestamp = (at: Date) => at.toISOString().replace("T", " ").slice(0, 19);

function mailBox(heading: string, rows: [string, unknown][], footer: string) {
  return `<div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eaeaea; padding: 20px; border-radius: 10px;">
    <h2 style="color: #e56b25;">${escapeHtml(heading)}</h2>
    <table style="width: 100%; border-collapse: collapse; background: #f9fafb; border-radius: 5px; margin: 16px 0;">
      ${rows.map(([k, v]) => `<tr><td style="padding: 6px 10px; font-weight: bold;">${escapeHtml(k)}</td><td style="padding: 6px 10px; text-align: right;">${escapeHtml(v)}</td></tr>`).join("")}
    </table>${footer}</div>`;
}

/** Pending orders (no slip yet) older than 24 h get one reminder with the transfer details. */
async function remindAbandoned(env: Env["Bindings"], at: Date): Promise<number> {
  const db = env.DB;
  const due = await db.prepare(`SELECT o.id FROM course_orders o WHERE o.status = 'pending' AND o.kind != 'organization' AND o.amount > 0
      AND o.reminder_sent_at IS NULL AND o.slip_r2_key IS NULL AND o.created_at <= ? AND o.expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM order_installments i WHERE i.order_id = o.id AND i.slip_r2_key IS NOT NULL)
    LIMIT 200`).bind(sqlTimestamp(new Date(at.getTime() - 86400000)), at.toISOString()).all<{ id: string }>();
  if (!due.results.length) return 0;
  const bank = await loadBankTransfer(db);
  let sent = 0;
  for (const { id } of due.results) {
    const claimed = await db.prepare(`UPDATE course_orders SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL AND status = 'pending' RETURNING id`)
      .bind(at.toISOString(), id).first<{ id: string }>();
    if (!claimed) continue;
    const order = await loadOrder(db, id);
    if (!order) continue;
    try {
      const firstDue = order.installment_count > 1
        ? (await db.prepare("SELECT amount FROM order_installments WHERE order_id = ? AND seq = 1").bind(id).first<{ amount: number }>())?.amount ?? order.amount
        : order.amount;
      await sendEmail(order.user_email!, `เตือนการชำระเงิน: ${order.course_title} (${order.reference})`, mailBox("คำสั่งซื้อของคุณยังรอการชำระเงิน", [
        ["เลขที่คำสั่งซื้อ", order.reference], ["รายการ", order.course_title], ["ยอดที่ต้องโอน", `${firstDue.toLocaleString("th-TH")} บาท`],
        ["ธนาคาร", bank.bank_name], ["เลขที่บัญชี", bank.account_number], ["ชื่อบัญชี", bank.account_name], ["พร้อมเพย์", bank.promptpay_id],
        ["ชำระภายใน", new Date(order.expires_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })]
      ], `<p>โอนแล้วแนบสลิปได้ที่ <a href="${escapeHtml(appUrl(env, "/dashboard"))}">การชำระเงินของฉัน</a> หากไม่ต้องการแล้ว ยกเลิกคำสั่งซื้อได้ในหน้าเดียวกัน</p>`),
        env.RESEND_API_KEY);
      await createNotification(db, order.user_id, "คำสั่งซื้อยังรอการชำระเงิน", `คำสั่งซื้อ ${order.reference} ${order.course_title} ยังไม่ได้แนบสลิป`);
      sent++;
    } catch (error) {
      console.error("Abandoned order reminder failed:", error);
      await db.prepare("UPDATE course_orders SET reminder_sent_at = NULL WHERE id = ?").bind(id).run();
    }
  }
  return sent;
}

/** Memberships ending within 7 days get one reminder per expiry date; ended memberships are marked expired. */
async function membershipJobs(env: Env["Bindings"], at: Date) {
  const db = env.DB;
  const now = at.toISOString();
  const soon = new Date(at.getTime() + 7 * 86400000).toISOString();
  const due = await db.prepare(`SELECT id FROM memberships WHERE status = 'active' AND expires_at > ? AND expires_at <= ?
    AND (reminder_sent_for IS NULL OR reminder_sent_for != expires_at) LIMIT 500`).bind(now, soon).all<{ id: string }>();
  let reminded = 0;
  for (const { id } of due.results) {
    const m = await db.prepare(`UPDATE memberships SET reminder_sent_for = expires_at WHERE id = ? AND status = 'active'
      AND (reminder_sent_for IS NULL OR reminder_sent_for != expires_at) RETURNING user_id, product_id, expires_at`).bind(id)
      .first<{ user_id: string; product_id: string; expires_at: string }>();
    if (!m) continue;
    try {
      const info = await db.prepare("SELECT u.email, u.name, p.title, p.price FROM users u, products p WHERE u.id = ? AND p.id = ?")
        .bind(m.user_id, m.product_id).first<{ email: string; name: string; title: string; price: number }>();
      if (!info) continue;
      const until = new Date(m.expires_at).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "long" });
      await sendEmail(info.email, `สมาชิก ${info.title} จะหมดอายุ ${until}`, mailBox("สมาชิกของคุณใกล้หมดอายุ", [
        ["สมาชิก", info.title], ["หมดอายุ", until], ["ค่าต่ออายุ", `${Math.round(info.price).toLocaleString("th-TH")} บาท`]
      ], `<p>ต่ออายุได้ที่ <a href="${escapeHtml(appUrl(env, "/dashboard"))}">แพ็กเกจและสมาชิก</a> ระยะเวลาใหม่จะต่อจากวันหมดอายุเดิม</p>`), env.RESEND_API_KEY);
      await createNotification(db, m.user_id, "สมาชิกใกล้หมดอายุ", `${info.title} จะหมดอายุ ${until} ต่ออายุได้ที่เมนูแพ็กเกจและสมาชิก`);
      reminded++;
    } catch (error) {
      console.error("Membership reminder failed:", error);
      await db.prepare("UPDATE memberships SET reminder_sent_for = NULL WHERE id = ?").bind(id).run();
    }
  }
  const expired = await db.prepare(`UPDATE memberships SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'active' AND expires_at <= ?`)
    .bind(now).run();
  // "All courses" memberships also cover courses published after the purchase.
  const covered = `FROM memberships m JOIN products p ON p.id = m.product_id AND p.all_courses = 1 JOIN courses c ON c.status = 'published'
    WHERE m.status = 'active' AND m.expires_at > ? AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = m.user_id AND e.course_id = c.id)`;
  const synced = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO order_items (order_id, course_id) SELECT m.last_order_id, c.id ${covered} AND m.last_order_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM course_orders o WHERE o.id = m.last_order_id)`).bind(now),
    db.prepare(`INSERT INTO enrollments (id, user_id, course_id, progress_percent, status, expires_at, partner_id)
      SELECT 'enr_' || lower(hex(randomblob(12))), m.user_id, c.id, 0, 'active', m.expires_at, NULL ${covered}
      ON CONFLICT(user_id, course_id) DO NOTHING`).bind(now)
  ]);
  return { reminded, expired: expired.meta.changes ?? 0, synced: synced[1].meta.changes ?? 0 };
}

/** Installment orders with an installment overdue beyond the product's grace days: access is suspended until paid. */
async function suspendOverdue(env: Env["Bindings"], at: Date): Promise<number> {
  const db = env.DB;
  const now = at.toISOString();
  const due = await db.prepare(`SELECT o.id, o.user_id, o.kind, o.product_id FROM course_orders o LEFT JOIN products p ON p.id = o.product_id
    WHERE o.status = 'partial' AND o.suspended_at IS NULL AND o.access_granted_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM order_installments i WHERE i.order_id = o.id AND i.status = 'pending'
        AND julianday(i.due_at) + COALESCE(json_extract(o.grant_snapshot_json, '$.grace_days'), p.overdue_grace_days, 7) < julianday(?))
    LIMIT 200`).bind(now).all<{ id: string; user_id: string; kind: string; product_id: string | null }>();
  let count = 0;
  for (const o of due.results) {
    const mark = "EXISTS (SELECT 1 FROM course_orders WHERE id = ? AND suspended_at = ?)";
    const statements = [
      db.prepare("UPDATE course_orders SET suspended_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND suspended_at IS NULL AND status = 'partial'")
        .bind(now, o.id),
      db.prepare(`UPDATE enrollments SET status = 'suspended' WHERE user_id = ? AND status IN ('active', 'completed')
        AND course_id IN ${ORDER_COURSES} AND NOT ${COVERED_ELSEWHERE} AND ${mark}`).bind(o.user_id, o.id, o.id, o.id, o.id, now)
    ];
    if (o.kind === "membership" && o.product_id) {
      statements.push(db.prepare(`UPDATE memberships SET status = 'suspended', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND product_id = ? AND status = 'active' AND ${mark}`).bind(o.user_id, o.product_id, o.id, now));
    }
    const results = await db.batch(statements);
    if (!results[0].meta.changes) continue;
    count++;
    const order = await loadOrder(db, o.id);
    if (!order) continue;
    try {
      await createNotification(db, order.user_id, "ระงับสิทธิ์ชั่วคราว: ค้างชำระงวด",
        `คำสั่งซื้อ ${order.reference} ${order.course_title} มีงวดที่เลยกำหนดชำระ สิทธิ์เข้าเรียนจะกลับมาเมื่อเจ้าหน้าที่ยืนยันการชำระ`);
      await sendEmail(order.user_email!, `ค้างชำระงวด: ${order.course_title} (${order.reference})`, mailBox("สิทธิ์เข้าเรียนถูกระงับชั่วคราว", [
        ["เลขที่คำสั่งซื้อ", order.reference], ["รายการ", order.course_title]
      ], `<p>กรุณาโอนงวดที่ค้างและแนบสลิปที่ <a href="${escapeHtml(appUrl(env, "/dashboard"))}">การชำระเงินของฉัน</a> สิทธิ์จะกลับมาทันทีที่เจ้าหน้าที่ยืนยัน</p>`),
        env.RESEND_API_KEY);
    } catch (error) {
      console.error("Overdue notice failed:", error);
    }
  }
  return count;
}

/** Daily commerce work; each part is isolated and safe to repeat (claims make reminders send once). */
export async function runCommerceJobs(env: Env["Bindings"], at: Date = new Date()): Promise<CommerceJobResult> {
  const result: CommerceJobResult = { abandoned_reminders: 0, membership_reminders: 0, memberships_expired: 0, memberships_synced: 0,
    installments_suspended: 0, quotes_expired: 0 };
  try { result.abandoned_reminders = await remindAbandoned(env, at); } catch (error) { console.error("Abandoned order reminders failed:", error); }
  try {
    const m = await membershipJobs(env, at);
    result.membership_reminders = m.reminded; result.memberships_expired = m.expired; result.memberships_synced = m.synced;
  } catch (error) { console.error("Membership jobs failed:", error); }
  try { result.installments_suspended = await suspendOverdue(env, at); } catch (error) { console.error("Overdue installments failed:", error); }
  try { result.quotes_expired = await expireQuotes(env.DB, thaiDate(at)); } catch (error) { console.error("Quote expiry failed:", error); }
  return result;
}
