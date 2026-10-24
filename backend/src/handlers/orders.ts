import { Context, Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { currentPermissions, permit } from "../utils/permissions";
import { discountedPrice, findUsableVoucher } from "../utils/vouchers";
import { appUrl, escapeHtml, sendEmail } from "../utils/email";
import { createNotification } from "./notifications";

/**
 * Manual bank-transfer orders. Card payments (Omise) are switched off: a learner creates an order,
 * transfers the amount quoting the reference, uploads a slip, and a payments.manage holder confirms it.
 * Mounted under /api through studentRouter.
 */
export const ordersRouter = new Hono<Env>();

const ORDER_DAYS = 3;
const SLIP_MAX_BYTES = 5 * 1024 * 1024;
const SLIP_TYPES: Record<string, { ext: string; magic: number[] }> = {
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/webp": { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
  "application/pdf": { ext: "pdf", magic: [0x25, 0x50, 0x44, 0x46] }
};

export interface BankTransferSettings {
  bank_name: string; account_name: string; account_number: string; promptpay_id: string; note: string;
}
const SETTING_FIELDS: Record<keyof BankTransferSettings, { label: string; max: number }> = {
  bank_name: { label: "ชื่อธนาคาร", max: 100 },
  account_name: { label: "ชื่อบัญชี", max: 150 },
  account_number: { label: "เลขที่บัญชี", max: 40 },
  promptpay_id: { label: "พร้อมเพย์", max: 40 },
  note: { label: "หมายเหตุ", max: 500 }
};

interface OrderRow {
  id: string; reference: string; user_id: string; course_id: string; list_price: number; amount: number;
  voucher_id: string | null; voucher_code: string | null; status: string; expires_at: string;
  slip_r2_key: string | null; slip_content_type: string | null; slip_uploaded_at: string | null;
  amount_received: number | null; paid_at: string | null; confirmed_by: string | null; receipt_no: string | null;
  enrollment_id: string | null; voucher_note: string | null; staff_note: string | null;
  refunded_at: string | null; refunded_by: string | null; created_at: string; updated_at: string;
  course_title?: string; user_name?: string; user_email?: string; confirmed_by_name?: string | null;
}

const ORDER_SELECT = `SELECT o.*, co.title AS course_title, u.name AS user_name, u.email AS user_email, cb.name AS confirmed_by_name
  FROM course_orders o JOIN courses co ON co.id = o.course_id JOIN users u ON u.id = o.user_id
  LEFT JOIN users cb ON cb.id = o.confirmed_by`;

/** Client view of an order; the R2 key of the slip never leaves the server. */
function present(row: OrderRow) {
  const { slip_r2_key, ...rest } = row;
  return { ...rest, has_slip: !!slip_r2_key };
}

const nowIso = () => new Date().toISOString();
/** Business year in Thailand (UTC+7) for reference and receipt numbering. */
const thaiYear = () => new Date(Date.now() + 7 * 3600000).getUTCFullYear();

async function nextNumber(db: D1Database, name: string): Promise<number> {
  const row = await db.prepare(`INSERT INTO order_counters (name, value) VALUES (?, 1)
    ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`).bind(name).first<{ value: number }>();
  if (!row) throw new Error("counter unavailable");
  return row.value;
}

async function nextReference(db: D1Database): Promise<string> {
  const year = thaiYear();
  return `NP-${String(year % 100).padStart(2, "0")}${String(await nextNumber(db, `order_${year}`)).padStart(4, "0")}`;
}

export async function loadBankTransfer(db: D1Database): Promise<BankTransferSettings> {
  const empty: BankTransferSettings = { bank_name: "", account_name: "", account_number: "", promptpay_id: "", note: "" };
  const row = await db.prepare("SELECT value FROM payment_settings WHERE key = 'bank_transfer'").first<{ value: string }>();
  try {
    const parsed = row ? JSON.parse(row.value) : {};
    for (const key of Object.keys(empty) as (keyof BankTransferSettings)[]) {
      if (typeof parsed[key] === "string") empty[key] = parsed[key];
    }
  } catch { /* Broken settings fall back to empty instructions. */ }
  return empty;
}

/** Pending orders past their deadline become expired (checked lazily on read). */
async function expireStale(db: D1Database, userId?: string) {
  await db.prepare(`UPDATE course_orders SET status = 'expired', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'pending' AND expires_at <= ? AND (? IS NULL OR user_id = ?)`)
    .bind(nowIso(), userId ?? null, userId ?? null).run();
}

const ORDER_IS_OPEN = "SELECT 1 FROM course_orders WHERE id = ? AND status = 'paid' AND receipt_no IS NULL";

/**
 * Finishes an order in one D1 batch (a single transaction): optionally claims it (pending/expired → paid),
 * then allocates the receipt number from order_counters, creates or reactivates the personal enrollment
 * (upsert on the unique user/course index) and writes both onto the order. Every step after the claim
 * only runs while the order is paid without a receipt, so a double click, a concurrent request or a
 * repair of a half-finished order never issues a second receipt.
 */
async function completeOrder(db: D1Database, order: { id: string; user_id: string; course_id: string; voucher_id: string | null },
  accessDays: number | null, claim?: { received: number; paidAt: string; staffId: string | null; note: string | null; statuses: string[]; voucher: "required" | "optional" }) {
  const expiresAt = accessDays && accessDays > 0 ? new Date(Date.now() + accessDays * 86400000).toISOString() : null;
  const counter = `receipt_${thaiYear()}`;
  const statements: D1PreparedStatement[] = [];
  const useVoucher = (sql: string, ...binds: unknown[]) => db.prepare(`UPDATE vouchers SET used_count = used_count + 1
    WHERE id = ? AND (max_uses IS NULL OR used_count < max_uses) AND ${sql}`).bind(order.voucher_id, ...binds);
  let voucherIndex = -1;
  if (claim) {
    const placeholders = claim.statuses.map(() => "?").join(", ");
    const requireVoucher = claim.voucher === "required" && !!order.voucher_id;
    if (requireVoucher) {
      // The free-after-voucher path only completes when this request got a voucher use.
      voucherIndex = statements.push(useVoucher(`EXISTS (SELECT 1 FROM course_orders WHERE id = ? AND status IN (${placeholders}))`, order.id, ...claim.statuses)) - 1;
    }
    statements.push(db.prepare(`UPDATE course_orders SET status = 'paid', amount_received = ?, paid_at = ?, confirmed_by = ?,
      staff_note = COALESCE(?, staff_note), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN (${placeholders})${requireVoucher ? " AND changes() > 0" : ""}`)
      .bind(claim.received, claim.paidAt, claim.staffId, claim.note, order.id, ...claim.statuses));
    if (order.voucher_id && !requireVoucher) {
      // Counted only by the request that claimed the order (its paid_at), never again on a repair.
      voucherIndex = statements.push(useVoucher(`EXISTS (${ORDER_IS_OPEN} AND paid_at = ?)`, order.id, claim.paidAt)) - 1;
    }
  }
  statements.push(
    db.prepare(`INSERT INTO order_counters (name, value) SELECT ?, 1 WHERE EXISTS (${ORDER_IS_OPEN})
      ON CONFLICT(name) DO UPDATE SET value = value + 1`).bind(counter, order.id),
    db.prepare(`INSERT INTO enrollments (id, user_id, course_id, progress_percent, status, expires_at, partner_id)
      SELECT ?, ?, ?, 0, 'active', ?, NULL WHERE EXISTS (${ORDER_IS_OPEN})
      ON CONFLICT(user_id, course_id) DO UPDATE SET status = CASE WHEN progress_percent >= 100 THEN 'completed' ELSE 'active' END,
        expires_at = excluded.expires_at, partner_id = NULL`)
      .bind("enr_" + crypto.randomUUID(), order.user_id, order.course_id, expiresAt, order.id)
  );
  const finishIndex = statements.push(db.prepare(`UPDATE course_orders SET
      receipt_no = 'RC-' || ? || '-' || printf('%06d', (SELECT value FROM order_counters WHERE name = ?)),
      enrollment_id = (SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'paid' AND receipt_no IS NULL`)
    .bind(String(thaiYear()), counter, order.user_id, order.course_id, order.id)) - 1;
  // Other open orders for the same course are no longer needed.
  statements.push(db.prepare(`UPDATE course_orders SET status = 'cancelled', staff_note = 'ยกเลิกอัตโนมัติ: ชำระผ่านคำสั่งซื้ออื่นแล้ว', updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND course_id = ? AND status = 'pending' AND id != ? AND EXISTS (SELECT 1 FROM course_orders WHERE id = ? AND status = 'paid')`)
    .bind(order.user_id, order.course_id, order.id, order.id));
  const results = await db.batch(statements);
  return {
    completed: (results[finishIndex].meta.changes ?? 0) > 0,
    voucherUsed: voucherIndex >= 0 ? (results[voucherIndex].meta.changes ?? 0) > 0 : null,
    expires_at: expiresAt
  };
}

async function audit(c: Context<Env>, action: string, entity: string, entityId: string, detail?: unknown) {
  try {
    await c.env.DB.prepare("INSERT INTO admin_audit_log (id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("log_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), c.get("user").id, action, entity, entityId,
        detail === undefined ? null : JSON.stringify(detail).slice(0, 2000)).run();
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}

const baht = (value: number) => `฿${value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function sendReceipt(c: Context<Env>, order: OrderRow) {
  try {
    const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eaeaea; padding: 20px; border-radius: 10px;">
      <h2 style="color: #10b981;">ได้รับชำระเงินแล้ว</h2>
      <p>สวัสดีคุณ ${escapeHtml(order.user_name)} เจ้าหน้าที่ยืนยันการโอนเงินของคุณแล้ว เปิดสิทธิ์เข้าเรียนคอร์สเรียบร้อย</p>
      <table style="width: 100%; border-collapse: collapse; background: #f9fafb; border-radius: 5px; margin: 20px 0;">
        <tr><td style="padding: 6px 10px; font-weight: bold;">เลขที่ใบเสร็จ</td><td style="padding: 6px 10px; text-align: right; font-family: monospace;">${escapeHtml(order.receipt_no)}</td></tr>
        <tr><td style="padding: 6px 10px; font-weight: bold;">เลขที่คำสั่งซื้อ</td><td style="padding: 6px 10px; text-align: right; font-family: monospace;">${escapeHtml(order.reference)}</td></tr>
        <tr><td style="padding: 6px 10px; font-weight: bold;">คอร์ส</td><td style="padding: 6px 10px; text-align: right;">${escapeHtml(order.course_title)}</td></tr>
        <tr><td style="padding: 6px 10px; font-weight: bold;">ยอดชำระ</td><td style="padding: 6px 10px; text-align: right;">${escapeHtml(baht(order.amount_received ?? order.amount))}</td></tr>
      </table>
      <p>ดูและพิมพ์ใบเสร็จได้ที่เมนู "การชำระเงินของฉัน"</p>
      <div style="margin: 20px 0; text-align: center;">
        <a href="${escapeHtml(appUrl(c.env, "/dashboard"))}" style="background-color: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">เริ่มเรียน</a>
      </div>
      <p style="color: #666; font-size: 12px; border-top: 1px solid #eaeaea; padding-top: 10px;">ส่งถึง: ${escapeHtml(order.user_email)} • Netprime LMS</p>
    </div>`;
    await sendEmail(order.user_email!, `ใบเสร็จรับเงิน ${order.receipt_no}: ${order.course_title}`, html, c.env.RESEND_API_KEY);
  } catch (error) {
    console.error("Order receipt email failed:", error);
  }
}

async function loadOrder(db: D1Database, id: string) {
  return await db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).bind(id).first<OrderRow>();
}

// ==========================================
// Learner
// ==========================================

ordersRouter.get("/student/payment-instructions", rbac(), async (c) => {
  return c.json({ instructions: await loadBankTransfer(c.env.DB), order_days: ORDER_DAYS });
});

/**
 * Create a bank-transfer order (or enroll at once when a voucher makes the course free)
 * POST /api/student/orders
 */
ordersRouter.post("/student/orders", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await c.req.json<{ course_id?: unknown; voucher_code?: unknown }>().catch(() => null);
  const courseId = typeof body?.course_id === "string" ? body.course_id : "";
  const voucherCode = typeof body?.voucher_code === "string" ? body.voucher_code.trim() : "";
  if (!courseId) return c.json({ error: "ต้องระบุ course_id" }, 400);

  try {
    const course = await db.prepare("SELECT id, title, price, access_duration_days, status FROM courses WHERE id = ?")
      .bind(courseId).first<{ id: string; title: string; price: number; access_duration_days: number | null; status: string }>();
    if (!course || course.status !== "published") return c.json({ error: "ไม่พบคอร์สนี้หรือคอร์สยังไม่เปิดขาย" }, 404);
    if (!(course.price > 0)) return c.json({ error: "คอร์สนี้เรียนฟรี กดลงทะเบียนเรียนได้ทันที" }, 400);

    const enrollment = await db.prepare(`SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?
      AND status IN ('active', 'completed') AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(user.id, courseId, nowIso()).first();
    if (enrollment) return c.json({ error: "คุณมีสิทธิ์เข้าเรียนคอร์สนี้อยู่แล้ว" }, 400);

    await expireStale(db, user.id);
    const open = await db.prepare(`${ORDER_SELECT} WHERE o.user_id = ? AND o.course_id = ? AND o.status = 'pending'`)
      .bind(user.id, courseId).first<OrderRow>();
    if (open) return c.json({ error: "มีคำสั่งซื้อคอร์สนี้ที่รอชำระอยู่แล้ว", order: present(open) }, 409);

    const voucher = voucherCode ? await findUsableVoucher(db, voucherCode, courseId) : null;
    if (voucherCode && !voucher) return c.json({ error: "โค้ดส่วนลดใช้ไม่ได้ อาจหมดอายุ ใช้ครบสิทธิ์แล้ว หรือไม่ตรงกับคอร์สนี้" }, 400);
    const amount = discountedPrice(course.price, voucher);
    const id = "ord_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const reference = await nextReference(db);
    const expiresAt = new Date(Date.now() + ORDER_DAYS * 86400000).toISOString();

    try {
      // Free orders are inserted as pending too: the partial unique index on open orders lets only one of
      // two racing requests through, and that one completes it below.
      await db.prepare(`INSERT INTO course_orders (id, reference, user_id, course_id, list_price, amount, voucher_id, voucher_code, status, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .bind(id, reference, user.id, courseId, course.price, amount, voucher?.id ?? null, voucher?.code ?? null, expiresAt).run();
    } catch (error) {
      // Two tabs racing: the partial unique index keeps a single open order.
      if (String(error).includes("UNIQUE")) return c.json({ error: "มีคำสั่งซื้อคอร์สนี้ที่รอชำระอยู่แล้ว" }, 409);
      throw error;
    }

    if (amount === 0) {
      // Free after voucher: count the voucher use and open the course straight away, in one transaction.
      const done = await completeOrder(db, { id, user_id: user.id, course_id: courseId, voucher_id: voucher?.id ?? null }, course.access_duration_days,
        { received: 0, paidAt: nowIso(), staffId: null, note: null, statuses: ["pending"], voucher: "required" });
      if (!done.completed) {
        await db.prepare(`UPDATE course_orders SET status = 'cancelled', staff_note = 'ยกเลิกอัตโนมัติ: โค้ดส่วนลดถูกใช้ครบสิทธิ์แล้ว',
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`).bind(id).run();
        return c.json({ error: "โค้ดส่วนลดนี้ถูกใช้ครบสิทธิ์แล้ว" }, 400);
      }
      const order = (await loadOrder(db, id))!;
      await createNotification(db, user.id, "เปิดสิทธิ์เข้าเรียนแล้ว", `ลงทะเบียนคอร์ส ${course.title} เรียบร้อย (คำสั่งซื้อ ${reference})`);
      return c.json({ order: present(order), enrolled: true, expires_at: done.expires_at }, 201);
    }

    const order = (await loadOrder(db, id))!;
    return c.json({ order: present(order), enrolled: false, instructions: await loadBankTransfer(db) }, 201);
  } catch (error) {
    console.error("Create order failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะสร้างคำสั่งซื้อ" }, 500);
  }
});

ordersRouter.get("/student/orders", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  await expireStale(c.env.DB, user.id);
  const rows = await c.env.DB.prepare(`${ORDER_SELECT} WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 100`)
    .bind(user.id).all<OrderRow>();
  return c.json({ orders: rows.results.map(present), instructions: await loadBankTransfer(c.env.DB) });
});

ordersRouter.get("/student/orders/:id", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  await expireStale(c.env.DB, user.id);
  const order = await loadOrder(c.env.DB, c.req.param("id"));
  if (!order || order.user_id !== user.id) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  return c.json({ order: present(order), instructions: await loadBankTransfer(c.env.DB) });
});

/**
 * Upload the transfer slip (PNG/JPG/WEBP/PDF up to 5 MB), stored privately in R2 under slips/
 * POST /api/student/orders/:id/slip  (multipart field "file")
 */
ordersRouter.post("/student/orders/:id/slip", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  await expireStale(db, user.id);
  const order = await db.prepare("SELECT id, user_id, status, slip_r2_key FROM course_orders WHERE id = ?")
    .bind(c.req.param("id")).first<{ id: string; user_id: string; status: string; slip_r2_key: string | null }>();
  if (!order || order.user_id !== user.id) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  if (order.status !== "pending") return c.json({ error: "แนบสลิปได้เฉพาะคำสั่งซื้อที่รอชำระ" }, 400);

  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File)) return c.json({ error: "กรุณาเลือกไฟล์สลิป" }, 400);
  const type = SLIP_TYPES[file.type];
  if (!type) return c.json({ error: "รองรับเฉพาะไฟล์ PNG, JPG, WEBP หรือ PDF" }, 400);
  if (file.size > SLIP_MAX_BYTES) return c.json({ error: "ไฟล์สลิปต้องไม่เกิน 5 MB" }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!type.magic.every((byte, i) => bytes[i] === byte)) return c.json({ error: "ไฟล์ไม่ตรงกับชนิดที่ระบุ" }, 400);

  try {
    const key = `slips/${order.id}/${crypto.randomUUID().replace(/-/g, "")}.${type.ext}`;
    await c.env.ASSETS.put(key, bytes, { httpMetadata: { contentType: file.type } });
    const updated = await db.prepare(`UPDATE course_orders SET slip_r2_key = ?, slip_content_type = ?, slip_uploaded_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`).bind(key, file.type, order.id).run();
    if (!updated.meta.changes) {
      await c.env.ASSETS.delete(key);
      return c.json({ error: "คำสั่งซื้อนี้ไม่ได้รอชำระแล้ว" }, 409);
    }
    if (order.slip_r2_key) await c.env.ASSETS.delete(order.slip_r2_key).catch(() => undefined);
    const fresh = (await loadOrder(db, order.id))!;
    return c.json({ order: present(fresh), message: "แนบสลิปแล้ว เจ้าหน้าที่จะตรวจสอบโดยเร็ว" });
  } catch (error) {
    console.error("Slip upload failed:", error);
    return c.json({ error: "อัปโหลดสลิปไม่สำเร็จ" }, 500);
  }
});

ordersRouter.post("/student/orders/:id/cancel", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const result = await c.env.DB.prepare(`UPDATE course_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND status = 'pending'`).bind(c.req.param("id"), user.id).run();
  if (!result.meta.changes) return c.json({ error: "ยกเลิกได้เฉพาะคำสั่งซื้อของคุณที่รอชำระ" }, 400);
  return c.json({ message: "ยกเลิกคำสั่งซื้อแล้ว" });
});

/**
 * Slip file: readable only by the order owner and payments.manage holders
 * GET /api/orders/:id/slip
 */
ordersRouter.get("/orders/:id/slip", rbac(), async (c) => {
  const user = c.get("user");
  const order = await c.env.DB.prepare("SELECT user_id, slip_r2_key, slip_content_type, reference FROM course_orders WHERE id = ?")
    .bind(c.req.param("id")).first<{ user_id: string; slip_r2_key: string | null; slip_content_type: string | null; reference: string }>();
  if (!order) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  if (order.user_id !== user.id && !(await currentPermissions(c)).has("payments.manage")) {
    return c.json({ error: "ไม่มีสิทธิ์ดูสลิปนี้" }, 403);
  }
  if (!order.slip_r2_key) return c.json({ error: "คำสั่งซื้อนี้ยังไม่มีสลิป" }, 404);
  const object = await c.env.ASSETS.get(order.slip_r2_key);
  if (!object) return c.json({ error: "ไม่พบไฟล์สลิป" }, 404);
  const ext = order.slip_r2_key.split(".").pop();
  c.header("Content-Type", order.slip_content_type || object.httpMetadata?.contentType || "application/octet-stream");
  c.header("Content-Disposition", `inline; filename="slip-${order.reference}.${ext}"`);
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(object.body);
});

// ==========================================
// Staff (payments.manage)
// ==========================================

ordersRouter.use("/manage/orders", rbac(), permit("payments.manage"));
ordersRouter.use("/manage/orders/*", rbac(), permit("payments.manage"));
ordersRouter.use("/manage/payment-settings", rbac(), permit("payments.manage"));

/**
 * GET /api/manage/orders?status=pending|paid|all|…&q=reference/email/name
 */
ordersRouter.get("/manage/orders", async (c) => {
  const db = c.env.DB;
  await expireStale(db);
  const status = c.req.query("status") || "all";
  const statuses = ["pending", "paid", "rejected", "cancelled", "expired", "refunded"];
  if (status !== "all" && !statuses.includes(status)) return c.json({ error: "สถานะไม่ถูกต้อง" }, 400);
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  const like = q ? `%${q.replace(/[\\%_]/g, ch => "\\" + ch)}%` : null;
  const rows = await db.prepare(`${ORDER_SELECT}
    WHERE (? = 'all' OR o.status = ?)
      AND (? IS NULL OR o.reference LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR o.receipt_no LIKE ? ESCAPE '\\')
    ORDER BY CASE WHEN o.status = 'pending' THEN 0 ELSE 1 END, o.created_at DESC LIMIT 200`)
    .bind(status, status, like, like, like, like, like).all<OrderRow>();
  const counts = await db.prepare("SELECT status, COUNT(*) AS n FROM course_orders GROUP BY status").all<{ status: string; n: number }>();
  return c.json({
    orders: rows.results.map(present),
    counts: Object.fromEntries(counts.results.map(r => [r.status, r.n]))
  });
});

/**
 * Confirm a transfer: records the amount, activates the enrollment, issues a receipt.
 * Also repairs a paid order that has no receipt yet (amount_received optional then).
 * POST /api/manage/orders/:id/confirm { amount_received, note? }
 */
ordersRouter.post("/manage/orders/:id/confirm", async (c) => {
  const db = c.env.DB;
  const staff = c.get("user");
  const body = await c.req.json<{ amount_received?: unknown; note?: unknown }>().catch(() => null);
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";

  try {
    const order = await loadOrder(db, c.req.param("id"));
    if (!order) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
    const repair = order.status === "paid" && !order.receipt_no;
    if (!repair && !["pending", "expired"].includes(order.status)) return c.json({ error: "ยืนยันได้เฉพาะคำสั่งซื้อที่รอตรวจสอบหรือหมดเวลา" }, 400);
    const received = repair && body?.amount_received === undefined ? null : Number(body?.amount_received);
    if (received !== null && (!Number.isFinite(received) || received < 0 || received > 10_000_000)) return c.json({ error: "กรุณาระบุยอดเงินที่ได้รับ" }, 400);
    if (!repair && received === null) return c.json({ error: "กรุณาระบุยอดเงินที่ได้รับ" }, 400);
    const course = await db.prepare("SELECT access_duration_days FROM courses WHERE id = ?")
      .bind(order.course_id).first<{ access_duration_days: number | null }>();

    // Claim, receipt and enrollment commit together; a double click finds nothing left to do.
    const done = await completeOrder(db, order, course?.access_duration_days ?? null, repair ? undefined
      : { received: received!, paidAt: nowIso(), staffId: staff.id, note: note || null, statuses: ["pending", "expired"], voucher: "optional" });
    if (!done.completed) return c.json({ error: "คำสั่งซื้อนี้ถูกดำเนินการไปแล้ว" }, 409);

    let voucherNote: string | null = null;
    if (done.voucherUsed === false) {
      voucherNote = `โค้ด ${order.voucher_code} ถูกใช้ครบสิทธิ์ก่อนยืนยัน ยืนยันตามยอดที่ได้รับ`;
      await db.prepare("UPDATE course_orders SET voucher_note = ? WHERE id = ?").bind(voucherNote, order.id).run();
    }
    if (repair && (received !== null || note)) {
      await db.prepare("UPDATE course_orders SET amount_received = COALESCE(?, amount_received), staff_note = COALESCE(?, staff_note) WHERE id = ?")
        .bind(received, note || null, order.id).run();
    }
    const fresh = (await loadOrder(db, order.id))!;
    await audit(c, repair ? "complete" : "confirm", "course_order", order.id,
      { reference: order.reference, amount: order.amount, received: fresh.amount_received, receipt_no: fresh.receipt_no, voucher_note: voucherNote });
    await createNotification(db, order.user_id, "ยืนยันการชำระเงินแล้ว",
      `คำสั่งซื้อ ${order.reference} คอร์ส ${order.course_title} เปิดสิทธิ์เข้าเรียนแล้ว ใบเสร็จเลขที่ ${fresh.receipt_no}`);
    await sendReceipt(c, fresh);
    return c.json({ order: present(fresh), enrollment: { id: fresh.enrollment_id, expires_at: done.expires_at }, voucher_note: voucherNote, repaired: repair });
  } catch (error) {
    console.error("Confirm order failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะยืนยันการชำระเงิน" }, 500);
  }
});

/**
 * POST /api/manage/orders/:id/reject { note }
 */
ordersRouter.post("/manage/orders/:id/reject", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ note?: unknown }>().catch(() => null);
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (!note) return c.json({ error: "กรุณาระบุเหตุผลที่ปฏิเสธ" }, 400);
  const order = await loadOrder(db, c.req.param("id"));
  if (!order) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  const result = await db.prepare(`UPDATE course_orders SET status = 'rejected', staff_note = ?, confirmed_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('pending', 'expired')`).bind(note, c.get("user").id, order.id).run();
  if (!result.meta.changes) return c.json({ error: "ปฏิเสธได้เฉพาะคำสั่งซื้อที่รอตรวจสอบ" }, 400);
  await audit(c, "reject", "course_order", order.id, { reference: order.reference, note });
  await createNotification(db, order.user_id, "การชำระเงินไม่ผ่านการตรวจสอบ", `คำสั่งซื้อ ${order.reference}: ${note}`);
  return c.json({ order: present((await loadOrder(db, order.id))!) });
});

/**
 * Refund or cancel a paid order: the enrollment is suspended
 * POST /api/manage/orders/:id/refund { note }
 */
ordersRouter.post("/manage/orders/:id/refund", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ note?: unknown }>().catch(() => null);
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (!note) return c.json({ error: "กรุณาระบุเหตุผลการคืนเงิน/ยกเลิก" }, 400);
  const order = await loadOrder(db, c.req.param("id"));
  if (!order) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  const result = await db.prepare(`UPDATE course_orders SET status = 'refunded', staff_note = ?, refunded_at = ?, refunded_by = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'paid'`).bind(note, nowIso(), c.get("user").id, order.id).run();
  if (!result.meta.changes) return c.json({ error: "คืนเงินได้เฉพาะคำสั่งซื้อที่ชำระแล้ว" }, 400);
  if (order.enrollment_id) {
    await db.prepare("UPDATE enrollments SET status = 'suspended' WHERE id = ?").bind(order.enrollment_id).run();
  } else {
    await db.prepare("UPDATE enrollments SET status = 'suspended' WHERE user_id = ? AND course_id = ?").bind(order.user_id, order.course_id).run();
  }
  await audit(c, "refund", "course_order", order.id, { reference: order.reference, receipt_no: order.receipt_no, note });
  await createNotification(db, order.user_id, "คำสั่งซื้อถูกยกเลิก/คืนเงิน",
    `คำสั่งซื้อ ${order.reference} คอร์ส ${order.course_title} ถูกยกเลิกและระงับสิทธิ์เข้าเรียน: ${note}`);
  return c.json({ order: present((await loadOrder(db, order.id))!) });
});

ordersRouter.get("/manage/payment-settings", async (c) => {
  return c.json({ instructions: await loadBankTransfer(c.env.DB) });
});

ordersRouter.put("/manage/payment-settings", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  const current = await loadBankTransfer(c.env.DB);
  for (const [key, spec] of Object.entries(SETTING_FIELDS) as [keyof BankTransferSettings, { label: string; max: number }][]) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") return c.json({ error: `${spec.label}ไม่ถูกต้อง` }, 400);
    const value = (body[key] as string).trim();
    if (value.length > spec.max) return c.json({ error: `${spec.label}ยาวเกิน ${spec.max} ตัวอักษร` }, 400);
    current[key] = value;
  }
  await c.env.DB.prepare(`INSERT INTO payment_settings (key, value, updated_by, updated_at) VALUES ('bank_transfer', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
    .bind(JSON.stringify(current), c.get("user").id).run();
  await audit(c, "update", "payment_settings", "bank_transfer", current);
  return c.json({ instructions: current });
});
