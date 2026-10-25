import { Context, Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";
import { currentPermissions, permit } from "../utils/permissions";
import { discountedPrice, findUsableVoucher } from "../utils/vouchers";
import { appUrl, escapeHtml, sendEmail } from "../utils/email";
import { createNotification } from "./notifications";
import { trackEvent } from "../utils/events";
import { checkCoursePrerequisites, prerequisiteMessage } from "../utils/courseContent";
import { currentVatRate, loadTaxProfile, parseBuyerTaxDetails, vatBreakdown } from "../utils/tax";
import { recordAffiliateConversion, reverseAffiliateConversion } from "./marketing";

/**
 * Manual bank-transfer orders. Card payments (Omise) are switched off: a learner creates an order,
 * transfers the amount quoting the reference, uploads a slip, and a payments.manage holder confirms it.
 * An order buys a course (course_id), a product (single course / bundle or learning path / membership,
 * see commerce.ts) or an organization quote; product orders may be paid in 2–6 installments, each
 * confirmed with its own receipt. VAT-registered schools issue full tax invoices on request and a
 * credit note when a tax-invoiced order is refunded. Mounted under /api through studentRouter.
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

export interface OrderRow {
  id: string; reference: string; user_id: string; course_id: string | null; product_id: string | null;
  kind: "course" | "bundle" | "membership" | "organization"; item_title: string | null;
  partner_id: string | null; quote_id: string | null; seats: number | null;
  list_price: number; amount: number; voucher_id: string | null; voucher_code: string | null; status: string; expires_at: string;
  installment_count: number; access_granted_at: string | null; suspended_at: string | null;
  slip_r2_key: string | null; slip_content_type: string | null; slip_uploaded_at: string | null;
  amount_received: number | null; paid_at: string | null; confirmed_by: string | null; receipt_no: string | null; vat_rate: number | null;
  enrollment_id: string | null; voucher_note: string | null; staff_note: string | null;
  refunded_at: string | null; refunded_by: string | null;
  tax_invoice_requested: number; buyer_name: string | null; buyer_tax_id: string | null; buyer_branch: string | null; buyer_address: string | null;
  tax_invoice_no: string | null; tax_invoice_at: string | null;
  credit_note_no: string | null; credit_note_at: string | null; credit_note_amount: number | null;
  reminder_sent_at: string | null; created_at: string; updated_at: string;
  grant_snapshot_json?: string | null; granted_days?: number | null;
  course_title?: string; user_name?: string; user_email?: string; confirmed_by_name?: string | null; partner_name?: string | null;
}

export interface InstallmentRow {
  id: string; order_id: string; seq: number; amount: number; due_at: string; status: string;
  slip_r2_key: string | null; slip_content_type: string | null; slip_uploaded_at: string | null;
  amount_received: number | null; paid_at: string | null; confirmed_by: string | null; receipt_no: string | null;
  vat_rate: number | null; tax_invoice_no: string | null; staff_note: string | null; created_at: string;
}

export const ORDER_SELECT = `SELECT o.*, COALESCE(o.item_title, co.title) AS course_title, u.name AS user_name, u.email AS user_email,
    cb.name AS confirmed_by_name, pa.company_name AS partner_name
  FROM course_orders o LEFT JOIN courses co ON co.id = o.course_id JOIN users u ON u.id = o.user_id
  LEFT JOIN users cb ON cb.id = o.confirmed_by LEFT JOIN partners pa ON pa.id = o.partner_id`;

const nowIso = () => new Date().toISOString();

function presentInstallment(row: InstallmentRow) {
  const { slip_r2_key, ...rest } = row;
  return {
    ...rest, has_slip: !!slip_r2_key,
    overdue: row.status === "pending" && row.due_at < nowIso(),
    vat: row.receipt_no ? vatBreakdown(row.amount_received ?? row.amount, row.vat_rate) : null
  };
}

/** Client view of an order; R2 keys of slips never leave the server. */
export function present(row: OrderRow, installments: InstallmentRow[] = []) {
  const { slip_r2_key, ...rest } = row;
  const received = row.installment_count > 1
    ? installments.filter(i => i.status === "paid" || i.status === "refunded").reduce((sum, i) => sum + (i.amount_received ?? i.amount), 0)
    : row.amount_received;
  return {
    ...rest,
    has_slip: !!slip_r2_key || installments.some(i => !!i.slip_r2_key),
    vat: row.receipt_no ? vatBreakdown(row.amount_received ?? row.amount, row.vat_rate) : null,
    total_received: received ?? null,
    installments: installments.map(presentInstallment)
  };
}

/** Orders with their installments (one query per 90 orders, under D1's bound-parameter limit). */
export async function presentMany(db: D1Database, rows: OrderRow[]) {
  const ids = rows.filter(r => r.installment_count > 1).map(r => r.id);
  const byOrder = new Map<string, InstallmentRow[]>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const result = await db.prepare(`SELECT * FROM order_installments WHERE order_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY order_id, seq`)
      .bind(...chunk).all<InstallmentRow>();
    for (const inst of result.results) {
      if (!byOrder.has(inst.order_id)) byOrder.set(inst.order_id, []);
      byOrder.get(inst.order_id)!.push(inst);
    }
  }
  return rows.map(r => present(r, byOrder.get(r.id)));
}

/** Business year in Thailand (UTC+7) for reference and document numbering. */
export const thaiYear = () => new Date(Date.now() + 7 * 3600000).getUTCFullYear();

export async function nextNumber(db: D1Database, name: string): Promise<number> {
  const row = await db.prepare(`INSERT INTO order_counters (name, value) VALUES (?, 1)
    ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`).bind(name).first<{ value: number }>();
  if (!row) throw new Error("counter unavailable");
  return row.value;
}

export async function nextReference(db: D1Database): Promise<string> {
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

/**
 * Affiliate commission bookkeeping (marketing.ts). Recorded once the order is fully paid (installment
 * orders: after the last installment, since commissions follow the full amount); reversed on refund.
 * Never allowed to break the payment flow.
 */
async function affiliatePaid(db: D1Database, orderId: string) {
  try { await recordAffiliateConversion(db, orderId); } catch (error) { console.error("Affiliate conversion failed:", error); }
}
async function affiliateRefunded(db: D1Database, orderId: string) {
  try { await reverseAffiliateConversion(db, orderId); } catch (error) { console.error("Affiliate reversal failed:", error); }
}

const ORDER_IS_OPEN = "SELECT 1 FROM course_orders WHERE id = ? AND status = 'paid' AND receipt_no IS NULL";

// ==========================================
// What a paid order opens
// ==========================================

/** Courses, membership period and organization seats an order opens once it is paid. */
export interface Grants {
  source: { type: "course"; courseId: string } | { type: "product"; productId: string } | { type: "courses"; courseIds: string[] } | { type: "all" } | null;
  /** Fixed enrollment expiry for course and bundle orders (null = lifetime). */
  expiresAt: string | null;
  membership?: { productId: string; days: number };
  partner?: { partnerId: string; seats: number; quoteId: string };
  /** Product settings used by installments. */
  installmentAccess: "first" | "full";
  graceDays: number;
}

interface ProductRow {
  id: string; kind: "course" | "bundle" | "membership"; title: string; price: number; status: string; course_id: string | null;
  access_days: number | null; all_courses: number; max_installments: number; installment_interval_days: number;
  installment_access: "first" | "full"; overdue_grace_days: number;
}

const daysFromNow = (days: number | null | undefined) => days && days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;

/**
 * What the order buys, frozen on the order when it is created (course_orders.grant_snapshot_json), so a later
 * product edit (courses, access days, installment access, grace days) never changes what a confirmation opens
 * or what a refund takes back.
 */
export interface GrantSnapshot {
  v: 1;
  course_ids: string[];          // courses opened (bundle / path / course); empty for "all courses" memberships
  all_courses: boolean;          // membership covering every published course
  access_days: number | null;    // fixed enrollment length for course / bundle orders (null = lifetime)
  membership_days: number | null;
  installment_access: "first" | "full";
  grace_days: number;
}

async function grantSnapshot(db: D1Database, kind: OrderRow["kind"], courseId: string | null, product: ProductRow | null, courseIds: string[]): Promise<GrantSnapshot> {
  const course = !product || product.kind === "course"
    ? courseId ? await db.prepare("SELECT access_duration_days FROM courses WHERE id = ?").bind(courseId).first<{ access_duration_days: number | null }>() : null
    : null;
  const membership = kind === "membership" && !!product;
  return {
    v: 1,
    course_ids: membership && product!.all_courses ? [] : courseIds,
    all_courses: membership && !!product!.all_courses,
    access_days: membership ? null : !product || product.kind === "course" ? product?.access_days ?? course?.access_duration_days ?? null : product.access_days,
    membership_days: membership ? product!.access_days ?? 30 : null,
    installment_access: product?.installment_access ?? "first",
    grace_days: product?.overdue_grace_days ?? 7
  };
}

function parseSnapshot(json: string | null | undefined): GrantSnapshot | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as GrantSnapshot;
    return value && value.v === 1 && Array.isArray(value.course_ids) ? value : null;
  } catch {
    return null;
  }
}

export async function loadGrants(db: D1Database, order: Pick<OrderRow, "kind" | "course_id" | "product_id" | "partner_id" | "seats" | "quote_id"> & { grant_snapshot_json?: string | null }): Promise<Grants> {
  const base = { installmentAccess: "first" as const, graceDays: 7 };
  if (order.kind === "organization") {
    return { ...base, source: null, expiresAt: null, partner: { partnerId: order.partner_id!, seats: order.seats ?? 0, quoteId: order.quote_id! } };
  }
  const snapshot = parseSnapshot(order.grant_snapshot_json);
  if (snapshot) {
    const settings = { installmentAccess: snapshot.installment_access, graceDays: snapshot.grace_days };
    if (order.kind === "membership" && order.product_id) {
      return { ...settings, source: snapshot.all_courses ? { type: "all" } : { type: "courses", courseIds: snapshot.course_ids }, expiresAt: null,
        membership: { productId: order.product_id, days: snapshot.membership_days ?? 30 } };
    }
    const source: Grants["source"] = order.kind === "course" && order.course_id ? { type: "course", courseId: order.course_id }
      : snapshot.course_ids.length ? { type: "courses", courseIds: snapshot.course_ids } : null;
    return { ...settings, source, expiresAt: daysFromNow(snapshot.access_days) };
  }
  // Orders created before snapshots existed: current product settings.
  const product = order.product_id ? await db.prepare("SELECT * FROM products WHERE id = ?").bind(order.product_id).first<ProductRow>() : null;
  const settings = product ? { installmentAccess: product.installment_access, graceDays: product.overdue_grace_days } : base;
  if (!product || product.kind === "course") {
    const course = order.course_id ? await db.prepare("SELECT access_duration_days FROM courses WHERE id = ?")
      .bind(order.course_id).first<{ access_duration_days: number | null }>() : null;
    return { ...settings, source: order.course_id ? { type: "course", courseId: order.course_id } : null,
      expiresAt: daysFromNow(product?.access_days ?? course?.access_duration_days) };
  }
  if (product.kind === "bundle") return { ...settings, source: { type: "product", productId: product.id }, expiresAt: daysFromNow(product.access_days) };
  return { ...settings, source: product.all_courses ? { type: "all" } : { type: "product", productId: product.id }, expiresAt: null,
    membership: { productId: product.id, days: product.access_days ?? 30 } };
}

/**
 * Statements that open what the order bought, each guarded by `guard` (an EXISTS condition bound with
 * `guardBinds`) so they run once, inside the caller's batch: membership period (extended from the
 * current expiry when still active), enrollments (upsert on the unique user/course index; a longer or
 * lifetime access the learner already has is kept), order_items, and organization seats + sponsorship.
 */
function grantStatements(db: D1Database, order: { id: string; user_id: string }, grants: Grants, guard: string, guardBinds: unknown[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (grants.partner) {
    statements.push(
      db.prepare(`UPDATE partners SET total_seats = total_seats + ? WHERE id = ? AND ${guard}`)
        .bind(grants.partner.seats, grants.partner.partnerId, ...guardBinds),
      db.prepare(`INSERT OR IGNORE INTO partner_courses (partner_id, course_id) SELECT ?, qc.course_id FROM quote_courses qc
        WHERE qc.quote_id = ? AND ${guard}`).bind(grants.partner.partnerId, grants.partner.quoteId, ...guardBinds)
    );
  }
  if (!grants.source) return statements;
  let expiresSql = "?";
  let expiresBinds: unknown[] = [grants.expiresAt];
  if (grants.membership) {
    const { productId, days } = grants.membership;
    const now = nowIso();
    statements.push(db.prepare(`INSERT INTO memberships (id, user_id, product_id, started_at, expires_at, status, last_order_id)
      SELECT ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?), 'active', ? WHERE ${guard}
      ON CONFLICT(user_id, product_id) DO UPDATE SET
        expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN memberships.status = 'active' AND julianday(memberships.expires_at) > julianday('now')
          THEN julianday(memberships.expires_at) ELSE julianday('now') END + ?),
        started_at = CASE WHEN memberships.status = 'active' AND memberships.expires_at > ? THEN memberships.started_at ELSE excluded.started_at END,
        status = 'active', last_order_id = excluded.last_order_id, updated_at = CURRENT_TIMESTAMP`)
      .bind("mbr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), order.user_id, productId, now, `+${days} days`, order.id,
        ...guardBinds, days, now));
    expiresSql = "(SELECT m.expires_at FROM memberships m WHERE m.user_id = ? AND m.product_id = ?)";
    expiresBinds = [order.user_id, productId];
  }
  const source = grants.source;
  const [srcSql, srcBinds] = source.type === "course" ? ["SELECT ? AS course_id", [source.courseId]]
    : source.type === "product" ? ["SELECT pc.course_id FROM product_courses pc WHERE pc.product_id = ?", [source.productId]]
    : source.type === "courses" ? ["SELECT value AS course_id FROM json_each(?)", [JSON.stringify(source.courseIds)]]
    : ["SELECT c.id AS course_id FROM courses c WHERE c.status = 'published'", []];
  statements.push(
    db.prepare(`INSERT INTO enrollments (id, user_id, course_id, progress_percent, status, expires_at, partner_id)
      SELECT 'enr_' || lower(hex(randomblob(12))), ?, src.course_id, 0, 'active', ${expiresSql}, NULL FROM (${srcSql}) src WHERE ${guard}
      ON CONFLICT(user_id, course_id) DO UPDATE SET
        expires_at = CASE
          WHEN enrollments.status IN ('active', 'completed') AND enrollments.expires_at IS NULL THEN NULL
          WHEN excluded.expires_at IS NULL THEN NULL
          WHEN enrollments.status IN ('active', 'completed') AND enrollments.expires_at > excluded.expires_at THEN enrollments.expires_at
          ELSE excluded.expires_at END,
        status = CASE WHEN enrollments.progress_percent >= 100 THEN 'completed' ELSE 'active' END,
        partner_id = NULL`)
      .bind(order.user_id, ...expiresBinds, ...srcBinds, ...guardBinds),
    db.prepare(`INSERT OR IGNORE INTO order_items (order_id, course_id) SELECT ?, src.course_id FROM (${srcSql}) src WHERE ${guard}`)
      .bind(order.id, ...srcBinds, ...guardBinds)
  );
  return statements;
}

/**
 * Allocates full tax invoice numbers (TI-2026-000001) for receipts of an order whose buyer asked for one:
 * the order's own receipt and every paid installment, but only receipts issued while VAT registered.
 */
function taxInvoiceStatements(db: D1Database, orderId: string, installmentCount: number): D1PreparedStatement[] {
  const year = String(thaiYear());
  const counter = `tax_invoice_${year}`;
  const number = `'TI-' || ? || '-' || printf('%06d', (SELECT value FROM order_counters WHERE name = ?))`;
  const statements: D1PreparedStatement[] = [];
  const orderNeeds = `EXISTS (SELECT 1 FROM course_orders WHERE id = ? AND tax_invoice_requested = 1 AND receipt_no IS NOT NULL
    AND tax_invoice_no IS NULL AND vat_rate > 0 AND status = 'paid')`;
  statements.push(
    db.prepare(`INSERT INTO order_counters (name, value) SELECT ?, 1 WHERE ${orderNeeds} ON CONFLICT(name) DO UPDATE SET value = value + 1`)
      .bind(counter, orderId),
    db.prepare(`UPDATE course_orders SET tax_invoice_no = ${number}, tax_invoice_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND ${orderNeeds}`).bind(year, counter, nowIso(), orderId, orderId)
  );
  for (let seq = 1; seq <= installmentCount && installmentCount > 1; seq++) {
    const needs = `EXISTS (SELECT 1 FROM order_installments i JOIN course_orders o ON o.id = i.order_id
      WHERE i.order_id = ? AND i.seq = ? AND i.status = 'paid' AND i.receipt_no IS NOT NULL AND i.tax_invoice_no IS NULL
        AND i.vat_rate > 0 AND o.tax_invoice_requested = 1 AND o.status IN ('partial', 'paid'))`;
    statements.push(
      db.prepare(`INSERT INTO order_counters (name, value) SELECT ?, 1 WHERE ${needs} ON CONFLICT(name) DO UPDATE SET value = value + 1`)
        .bind(counter, orderId, seq),
      db.prepare(`UPDATE order_installments SET tax_invoice_no = ${number} WHERE order_id = ? AND seq = ? AND ${needs}`)
        .bind(year, counter, orderId, seq, orderId, seq)
    );
  }
  return statements;
}

/** Issues missing tax invoice numbers now (after a late request), when the school is VAT registered. */
async function issuePendingTaxInvoices(db: D1Database, order: Pick<OrderRow, "id" | "installment_count">) {
  await db.batch(taxInvoiceStatements(db, order.id, order.installment_count));
}

/**
 * Finishes a single-payment order in one D1 batch (a single transaction): optionally claims it
 * (pending/expired → paid), then allocates the receipt number from order_counters, opens what was bought
 * (see grantStatements), writes the receipt (and the tax invoice number when requested) onto the order.
 * Every step after the claim only runs while the order is paid without a receipt, so a double click,
 * a concurrent request or a repair of a half-finished order never issues a second receipt.
 */
async function completeOrder(db: D1Database, order: { id: string; user_id: string; course_id: string | null; product_id?: string | null; voucher_id: string | null },
  grants: Grants, vatRate: number, claim?: { received: number; paidAt: string; staffId: string | null; note: string | null; statuses: string[]; voucher: "required" | "optional" }) {
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
    ...grantStatements(db, order, grants, `EXISTS (${ORDER_IS_OPEN})`, [order.id])
  );
  const finishIndex = statements.push(db.prepare(`UPDATE course_orders SET
      receipt_no = 'RC-' || ? || '-' || printf('%06d', (SELECT value FROM order_counters WHERE name = ?)),
      vat_rate = ?, access_granted_at = COALESCE(access_granted_at, ?), granted_days = COALESCE(granted_days, ?),
      enrollment_id = CASE WHEN course_id IS NULL THEN NULL
        ELSE (SELECT e.id FROM enrollments e WHERE e.user_id = course_orders.user_id AND e.course_id = course_orders.course_id) END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'paid' AND receipt_no IS NULL`)
    .bind(String(thaiYear()), counter, vatRate, nowIso(), grants.membership?.days ?? null, order.id)) - 1;
  if (vatRate > 0) statements.push(...taxInvoiceStatements(db, order.id, 1));
  // Other open orders for the same course or product are no longer needed.
  statements.push(db.prepare(`UPDATE course_orders SET status = 'cancelled', staff_note = 'ยกเลิกอัตโนมัติ: ชำระผ่านคำสั่งซื้ออื่นแล้ว', updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND ((? IS NOT NULL AND course_id = ?) OR (? IS NOT NULL AND product_id = ?)) AND status = 'pending' AND id != ?
      AND EXISTS (SELECT 1 FROM course_orders WHERE id = ? AND status = 'paid')`)
    .bind(order.user_id, order.course_id, order.course_id, order.product_id ?? null, order.product_id ?? null, order.id, order.id));
  const results = await db.batch(statements);
  if ((results[finishIndex].meta.changes ?? 0) > 0) {
    await trackEvent(db, order.user_id, "order_paid", { courseId: order.course_id, data: { order_id: order.id, amount: claim?.received ?? null } });
  }
  return {
    completed: (results[finishIndex].meta.changes ?? 0) > 0,
    voucherUsed: voucherIndex >= 0 ? (results[voucherIndex].meta.changes ?? 0) > 0 : null,
    expires_at: await accessExpiry(db, order.user_id, grants)
  };
}

/** Expiry of what the order opened, for the response (membership end, course expiry or null = lifetime). */
async function accessExpiry(db: D1Database, userId: string, grants: Grants): Promise<string | null> {
  if (!grants.membership) return grants.expiresAt;
  const row = await db.prepare("SELECT expires_at FROM memberships WHERE user_id = ? AND product_id = ?")
    .bind(userId, grants.membership.productId).first<{ expires_at: string }>();
  return row?.expires_at ?? null;
}

/** SQL: the enrollment row `enrollments` is still covered by another paid order of the learner (bound: the order to ignore). */
export const COVERED_ELSEWHERE = `EXISTS (SELECT 1 FROM course_orders o2 WHERE o2.user_id = enrollments.user_id AND o2.id != ?
    AND o2.status IN ('paid', 'partial') AND o2.access_granted_at IS NOT NULL AND o2.suspended_at IS NULL
    AND (o2.course_id = enrollments.course_id OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o2.id AND oi.course_id = enrollments.course_id)))`;

/** SQL: courses the order opened (order_items, plus the course of course orders). Bound twice with the order id. */
export const ORDER_COURSES = "(SELECT oi.course_id FROM order_items oi WHERE oi.order_id = ? UNION SELECT o.course_id FROM course_orders o WHERE o.id = ? AND o.course_id IS NOT NULL)";

/**
 * Confirms one installment in one batch: claims it, issues its receipt (and tax invoice), moves the
 * order to partial/paid, opens access once (after the first or the last installment, per product), and
 * reopens access an overdue suspension had closed once nothing is overdue any more.
 */
async function confirmInstallment(db: D1Database, order: OrderRow, inst: InstallmentRow, grants: Grants, vatRate: number,
  claim: { received: number; paidAt: string; staffId: string; note: string | null }) {
  const year = String(thaiYear());
  const counter = `receipt_${year}`;
  const now = nowIso();
  const cutoff = new Date(Date.now() - grants.graceDays * 86400000).toISOString();
  const statements: D1PreparedStatement[] = [];
  statements.push(db.prepare(`UPDATE order_installments SET status = 'paid', amount_received = ?, paid_at = ?, confirmed_by = ?, staff_note = COALESCE(?, staff_note)
    WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM course_orders WHERE id = ? AND status IN ('pending', 'partial', 'expired'))`)
    .bind(claim.received, claim.paidAt, claim.staffId, claim.note, inst.id, order.id));
  const claimed = "EXISTS (SELECT 1 FROM order_installments WHERE id = ? AND status = 'paid' AND paid_at = ? AND receipt_no IS NULL)";
  let voucherIndex = -1;
  if (order.voucher_id) {
    voucherIndex = statements.push(db.prepare(`UPDATE vouchers SET used_count = used_count + 1
      WHERE id = ? AND (max_uses IS NULL OR used_count < max_uses) AND ${claimed}
        AND NOT EXISTS (SELECT 1 FROM order_installments WHERE order_id = ? AND status = 'paid' AND id != ?)`)
      .bind(order.voucher_id, inst.id, claim.paidAt, order.id, inst.id)) - 1;
  }
  statements.push(db.prepare(`INSERT INTO order_counters (name, value) SELECT ?, 1 WHERE ${claimed} ON CONFLICT(name) DO UPDATE SET value = value + 1`)
    .bind(counter, inst.id, claim.paidAt));
  const finishIndex = statements.push(db.prepare(`UPDATE order_installments SET
      receipt_no = 'RC-' || ? || '-' || printf('%06d', (SELECT value FROM order_counters WHERE name = ?)), vat_rate = ?
    WHERE id = ? AND status = 'paid' AND paid_at = ? AND receipt_no IS NULL`)
    .bind(year, counter, vatRate, inst.id, claim.paidAt)) - 1;
  statements.push(db.prepare(`UPDATE course_orders SET
      status = CASE WHEN NOT EXISTS (SELECT 1 FROM order_installments WHERE order_id = ?1 AND status != 'paid') THEN 'paid' ELSE 'partial' END,
      paid_at = COALESCE(paid_at, ?2), confirmed_by = ?3, vat_rate = ?4, updated_at = CURRENT_TIMESTAMP,
      amount_received = (SELECT COALESCE(SUM(amount_received), 0) FROM order_installments WHERE order_id = ?1 AND status = 'paid')
    WHERE id = ?1 AND status IN ('pending', 'partial', 'expired')
      AND EXISTS (SELECT 1 FROM order_installments WHERE id = ?5 AND paid_at = ?2 AND receipt_no IS NOT NULL)`)
    .bind(order.id, claim.paidAt, claim.staffId, vatRate, inst.id));
  const ready = "EXISTS (SELECT 1 FROM course_orders WHERE id = ? AND access_granted_at IS NULL AND status IN ('partial', 'paid') AND (? = 'first' OR status = 'paid'))";
  statements.push(...grantStatements(db, order, grants, ready, [order.id, grants.installmentAccess]));
  statements.push(db.prepare(`UPDATE course_orders SET access_granted_at = ?, granted_days = ?,
      enrollment_id = CASE WHEN course_id IS NULL THEN NULL
        ELSE (SELECT e.id FROM enrollments e WHERE e.user_id = course_orders.user_id AND e.course_id = course_orders.course_id) END
    WHERE id = ? AND access_granted_at IS NULL AND status IN ('partial', 'paid') AND (? = 'first' OR status = 'paid')`)
    .bind(now, grants.membership?.days ?? null, order.id, grants.installmentAccess));
  // Back in good standing: reopen what an overdue installment suspended.
  const overdue = "EXISTS (SELECT 1 FROM order_installments WHERE order_id = ? AND status = 'pending' AND due_at < ?)";
  const suspended = "EXISTS (SELECT 1 FROM course_orders WHERE id = ? AND suspended_at IS NOT NULL AND status IN ('partial', 'paid'))";
  statements.push(db.prepare(`UPDATE enrollments SET status = CASE WHEN progress_percent >= 100 THEN 'completed' ELSE 'active' END
    WHERE user_id = ? AND status = 'suspended' AND course_id IN ${ORDER_COURSES} AND ${suspended} AND NOT ${overdue}`)
    .bind(order.user_id, order.id, order.id, order.id, order.id, cutoff));
  if (grants.membership) {
    statements.push(db.prepare(`UPDATE memberships SET status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND product_id = ? AND status = 'suspended' AND ${suspended} AND NOT ${overdue}`)
      .bind(order.user_id, grants.membership.productId, order.id, order.id, cutoff));
  }
  statements.push(db.prepare(`UPDATE course_orders SET suspended_at = NULL WHERE id = ? AND suspended_at IS NOT NULL AND NOT ${overdue}`)
    .bind(order.id, order.id, cutoff));
  if (vatRate > 0) statements.push(...taxInvoiceStatements(db, order.id, order.installment_count));
  const results = await db.batch(statements);
  const completed = (results[finishIndex].meta.changes ?? 0) > 0;
  if (completed) {
    await trackEvent(db, order.user_id, "order_paid", { courseId: order.course_id, data: { order_id: order.id, amount: claim.received, installment: inst.seq } });
  }
  return { completed, voucherUsed: voucherIndex >= 0 ? (results[voucherIndex].meta.changes ?? 0) > 0 : null };
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

async function sendReceipt(c: Context<Env>, order: OrderRow, doc: { receipt_no: string; amount: number; label?: string; tax_invoice_no?: string | null }) {
  try {
    const rows: [string, string][] = [
      ["เลขที่ใบเสร็จ", doc.receipt_no], ...(doc.tax_invoice_no ? [["เลขที่ใบกำกับภาษี", doc.tax_invoice_no] as [string, string]] : []),
      ["เลขที่คำสั่งซื้อ", order.reference], ["รายการ", `${order.course_title ?? ""}${doc.label ? ` (${doc.label})` : ""}`],
      ["ยอดชำระ", baht(doc.amount)]
    ];
    const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eaeaea; padding: 20px; border-radius: 10px;">
      <h2 style="color: #10b981;">ได้รับชำระเงินแล้ว</h2>
      <p>สวัสดีคุณ ${escapeHtml(order.user_name)} เจ้าหน้าที่ยืนยันการโอนเงินของคุณแล้ว${order.kind === "organization" ? "" : " เปิดสิทธิ์เข้าเรียนเรียบร้อย"}</p>
      <table style="width: 100%; border-collapse: collapse; background: #f9fafb; border-radius: 5px; margin: 20px 0;">
        ${rows.map(([k, v]) => `<tr><td style="padding: 6px 10px; font-weight: bold;">${escapeHtml(k)}</td><td style="padding: 6px 10px; text-align: right;">${escapeHtml(v)}</td></tr>`).join("")}
      </table>
      <p>ดูและพิมพ์ใบเสร็จได้ที่เมนู "การชำระเงินของฉัน"</p>
      <div style="margin: 20px 0; text-align: center;">
        <a href="${escapeHtml(appUrl(c.env, "/dashboard"))}" style="background-color: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">เริ่มเรียน</a>
      </div>
      <p style="color: #666; font-size: 12px; border-top: 1px solid #eaeaea; padding-top: 10px;">ส่งถึง: ${escapeHtml(order.user_email)} • Netprime LMS</p>
    </div>`;
    await sendEmail(order.user_email!, `ใบเสร็จรับเงิน ${doc.receipt_no}: ${order.course_title}`, html, c.env.RESEND_API_KEY);
  } catch (error) {
    console.error("Order receipt email failed:", error);
  }
}

export async function loadOrder(db: D1Database, id: string) {
  return await db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).bind(id).first<OrderRow>();
}

async function loadInstallments(db: D1Database, orderId: string) {
  return (await db.prepare("SELECT * FROM order_installments WHERE order_id = ? ORDER BY seq").bind(orderId).all<InstallmentRow>()).results;
}

export async function presentOne(db: D1Database, order: OrderRow) {
  return present(order, order.installment_count > 1 ? await loadInstallments(db, order.id) : []);
}

/** Installment amounts in whole baht (the remainder goes to the first) and due dates. */
function installmentPlan(amount: number, count: number, intervalDays: number, firstDue: string) {
  const each = Math.floor(amount / count);
  const created = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    amount: i === 0 ? amount - each * (count - 1) : each,
    due_at: i === 0 ? firstDue : new Date(created + i * intervalDays * 86400000).toISOString()
  }));
}

/** Prerequisite message for the courses a learner is about to buy (courses inside the same bundle count as planned). */
async function prerequisiteBlock(db: D1Database, userId: string, courseIds: string[]): Promise<string | null> {
  for (const courseId of courseIds) {
    const check = await checkCoursePrerequisites(db, userId, courseId);
    const missing = check.missing.filter(m => !courseIds.includes(m.id));
    if (missing.length) return prerequisiteMessage(missing);
  }
  return null;
}

/** Validates and stores an uploaded slip in R2 under slips/; returns the key or an error message. */
async function storeSlip(c: Context<Env>, prefix: string): Promise<{ key: string; type: string } | { error: string }> {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File)) return { error: "กรุณาเลือกไฟล์สลิป" };
  const type = SLIP_TYPES[file.type];
  if (!type) return { error: "รองรับเฉพาะไฟล์ PNG, JPG, WEBP หรือ PDF" };
  if (file.size > SLIP_MAX_BYTES) return { error: "ไฟล์สลิปต้องไม่เกิน 5 MB" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!type.magic.every((byte, i) => bytes[i] === byte)) return { error: "ไฟล์ไม่ตรงกับชนิดที่ระบุ" };
  const key = `slips/${prefix}/${crypto.randomUUID().replace(/-/g, "")}.${type.ext}`;
  await c.env.ASSETS.put(key, bytes, { httpMetadata: { contentType: file.type } });
  return { key, type: file.type };
}

async function serveSlip(c: Context<Env>, key: string | null, contentType: string | null, filename: string) {
  if (!key) return c.json({ error: "คำสั่งซื้อนี้ยังไม่มีสลิป" }, 404);
  const object = await c.env.ASSETS.get(key);
  if (!object) return c.json({ error: "ไม่พบไฟล์สลิป" }, 404);
  const ext = key.split(".").pop();
  c.header("Content-Type", contentType || object.httpMetadata?.contentType || "application/octet-stream");
  c.header("Content-Disposition", `inline; filename="${filename}.${ext}"`);
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(object.body);
}

// ==========================================
// Learner
// ==========================================

ordersRouter.get("/student/payment-instructions", rbac(), async (c) => {
  return c.json({ instructions: await loadBankTransfer(c.env.DB), order_days: ORDER_DAYS, seller: await loadTaxProfile(c.env.DB) });
});

/**
 * Create a bank-transfer order (or enroll at once when a voucher makes it free)
 * POST /api/student/orders { course_id | product_id, voucher_code?, installments?, tax_invoice? }
 */
ordersRouter.post("/student/orders", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await c.req.json<{ course_id?: unknown; product_id?: unknown; voucher_code?: unknown; installments?: unknown; tax_invoice?: unknown }>().catch(() => null);
  const courseIdInput = typeof body?.course_id === "string" ? body.course_id : "";
  const productId = typeof body?.product_id === "string" ? body.product_id : "";
  const voucherCode = typeof body?.voucher_code === "string" ? body.voucher_code.trim() : "";
  if (!courseIdInput && !productId) return c.json({ error: "ต้องระบุ course_id หรือ product_id" }, 400);
  const installments = body?.installments === undefined || body?.installments === null ? 1 : Number(body.installments);
  if (!Number.isInteger(installments) || installments < 1 || installments > 6) return c.json({ error: "จำนวนงวดต้องเป็น 1–6 งวด" }, 400);
  let buyer = null;
  if (body?.tax_invoice) {
    const parsed = parseBuyerTaxDetails(body.tax_invoice);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    buyer = parsed.value;
  }

  try {
    const now = nowIso();
    let title: string, price: number, courseId: string | null = null, kind: OrderRow["kind"] = "course";
    let product: ProductRow | null = null;
    let courseIds: string[] = [];
    if (productId) {
      product = await db.prepare("SELECT * FROM products WHERE id = ?").bind(productId).first<ProductRow>();
      if (!product || product.status !== "published") return c.json({ error: "ไม่พบแพ็กเกจนี้หรือยังไม่เปิดขาย" }, 404);
      title = product.title;
      price = Math.round(product.price);
      kind = product.kind;
      if (product.kind === "course") {
        if (!product.course_id) return c.json({ error: "แพ็กเกจนี้ยังไม่ได้ผูกกับคอร์ส" }, 400);
        courseId = product.course_id;
        courseIds = [courseId];
      } else {
        courseIds = (await db.prepare("SELECT course_id FROM product_courses WHERE product_id = ? ORDER BY sort_order")
          .bind(product.id).all<{ course_id: string }>()).results.map(r => r.course_id);
        if (!product.all_courses && courseIds.length === 0) return c.json({ error: "แพ็กเกจนี้ยังไม่มีคอร์ส" }, 400);
      }
      if (installments > product.max_installments) return c.json({ error: `แพ็กเกจนี้ผ่อนได้ไม่เกิน ${product.max_installments} งวด` }, 400);
      if (product.kind === "bundle") {
        // Nothing new to open: every course is already active for life.
        const owned = await db.prepare(`SELECT COUNT(*) AS n FROM enrollments WHERE user_id = ? AND status IN ('active', 'completed')
          AND expires_at IS NULL AND course_id IN (SELECT course_id FROM product_courses WHERE product_id = ?)`).bind(user.id, product.id).first<{ n: number }>();
        if ((owned?.n ?? 0) >= courseIds.length) return c.json({ error: "คุณมีสิทธิ์เข้าเรียนทุกคอร์สในชุดนี้อยู่แล้ว" }, 400);
      }
    } else {
      const course = await db.prepare("SELECT id, title, price, status FROM courses WHERE id = ?")
        .bind(courseIdInput).first<{ id: string; title: string; price: number; status: string }>();
      if (!course || course.status !== "published") return c.json({ error: "ไม่พบคอร์สนี้หรือคอร์สยังไม่เปิดขาย" }, 404);
      if (!(course.price > 0)) return c.json({ error: "คอร์สนี้เรียนฟรี กดลงทะเบียนเรียนได้ทันที" }, 400);
      if (installments > 1) return c.json({ error: "ผ่อนชำระได้เฉพาะแพ็กเกจที่เปิดให้ผ่อน" }, 400);
      title = course.title;
      price = course.price;
      courseId = course.id;
      courseIds = [course.id];
    }

    if (courseId) {
      const enrollment = await db.prepare(`SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?
        AND status IN ('active', 'completed') AND (expires_at IS NULL OR expires_at > ?)`)
        .bind(user.id, courseId, now).first();
      if (enrollment) return c.json({ error: "คุณมีสิทธิ์เข้าเรียนคอร์สนี้อยู่แล้ว" }, 400);
    }
    if (kind !== "membership") {
      const blocked = await prerequisiteBlock(db, user.id, courseIds);
      if (blocked) return c.json({ error: blocked }, 400);
    }

    await expireStale(db, user.id);
    const open = await db.prepare(`${ORDER_SELECT} WHERE o.user_id = ? AND o.status IN ('pending', 'partial')
        AND ((? != '' AND o.product_id = ?) OR (? IS NOT NULL AND o.course_id = ?))
      ORDER BY o.created_at DESC LIMIT 1`)
      .bind(user.id, productId, productId, courseId, courseId).first<OrderRow>();
    if (open) {
      const error = open.status === "partial" ? "มีคำสั่งซื้อแบบผ่อนชำระที่ยังชำระไม่ครบ" : productId ? "มีคำสั่งซื้อแพ็กเกจนี้ที่รอชำระอยู่แล้ว" : "มีคำสั่งซื้อคอร์สนี้ที่รอชำระอยู่แล้ว";
      return c.json({ error, order: await presentOne(db, open) }, 409);
    }

    // Course vouchers apply to that course; bundles and memberships take only store-wide vouchers.
    const voucher = voucherCode ? await findUsableVoucher(db, voucherCode, courseId ?? "") : null;
    if (voucherCode && !voucher) return c.json({ error: "โค้ดส่วนลดใช้ไม่ได้ อาจหมดอายุ ใช้ครบสิทธิ์แล้ว หรือไม่ตรงกับรายการนี้" }, 400);
    const amount = discountedPrice(price, voucher);
    const count = amount === 0 ? 1 : installments;
    if (count > 1 && count > amount) return c.json({ error: "ยอดชำระน้อยเกินไปสำหรับจำนวนงวดที่เลือก" }, 400);
    const id = "ord_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const snapshot = await grantSnapshot(db, kind, courseId, product, courseIds);
    const reference = await nextReference(db);
    const expiresAt = new Date(Date.now() + ORDER_DAYS * 86400000).toISOString();

    try {
      // Free orders are inserted as pending too: the partial unique indexes on open orders let only one
      // of two racing requests through, and that one completes it below.
      const statements = [db.prepare(`INSERT INTO course_orders (id, reference, user_id, course_id, product_id, kind, item_title, list_price, amount,
          voucher_id, voucher_code, status, expires_at, installment_count, tax_invoice_requested, buyer_name, buyer_tax_id, buyer_branch, buyer_address,
          grant_snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, reference, user.id, courseId, product?.id ?? null, kind, product ? title : null, price, amount, voucher?.id ?? null, voucher?.code ?? null,
          expiresAt, count, buyer ? 1 : 0, buyer?.buyer_name ?? null, buyer?.buyer_tax_id ?? null, buyer?.buyer_branch ?? null, buyer?.buyer_address ?? null,
          JSON.stringify(snapshot))];
      if (count > 1) {
        for (const step of installmentPlan(amount, count, product!.installment_interval_days, expiresAt)) {
          statements.push(db.prepare("INSERT INTO order_installments (id, order_id, seq, amount, due_at) VALUES (?, ?, ?, ?, ?)")
            .bind("ins_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), id, step.seq, step.amount, step.due_at));
        }
      }
      await db.batch(statements);
    } catch (error) {
      // Two tabs racing: the partial unique index keeps a single open order.
      if (String(error).includes("UNIQUE")) return c.json({ error: "มีคำสั่งซื้อรายการนี้ที่รอชำระอยู่แล้ว" }, 409);
      throw error;
    }
    await trackEvent(db, user.id, "order_created", { courseId, data: { order_id: id, product_id: product?.id ?? null, kind, amount, installments: count } });

    if (amount === 0) {
      // Free after voucher: count the voucher use and open the course straight away, in one transaction.
      const grants = await loadGrants(db, { kind, course_id: courseId, product_id: product?.id ?? null, partner_id: null, seats: null, quote_id: null,
        grant_snapshot_json: JSON.stringify(snapshot) });
      const done = await completeOrder(db, { id, user_id: user.id, course_id: courseId, product_id: product?.id ?? null, voucher_id: voucher?.id ?? null }, grants, 0,
        { received: 0, paidAt: nowIso(), staffId: null, note: null, statuses: ["pending"], voucher: "required" });
      if (!done.completed) {
        await db.prepare(`UPDATE course_orders SET status = 'cancelled', staff_note = 'ยกเลิกอัตโนมัติ: โค้ดส่วนลดถูกใช้ครบสิทธิ์แล้ว',
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`).bind(id).run();
        return c.json({ error: "โค้ดส่วนลดนี้ถูกใช้ครบสิทธิ์แล้ว" }, 400);
      }
      await affiliatePaid(db, id);
      const order = (await loadOrder(db, id))!;
      await createNotification(db, user.id, "เปิดสิทธิ์เข้าเรียนแล้ว", `ลงทะเบียน ${title} เรียบร้อย (คำสั่งซื้อ ${reference})`);
      return c.json({ order: present(order), enrolled: true, expires_at: done.expires_at }, 201);
    }

    const order = (await loadOrder(db, id))!;
    return c.json({ order: await presentOne(db, order), enrolled: false, instructions: await loadBankTransfer(db) }, 201);
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
  return c.json({ orders: await presentMany(c.env.DB, rows.results), instructions: await loadBankTransfer(c.env.DB), seller: await loadTaxProfile(c.env.DB) });
});

ordersRouter.get("/student/orders/:id", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  await expireStale(c.env.DB, user.id);
  const order = await loadOrder(c.env.DB, c.req.param("id"));
  if (!order || order.user_id !== user.id) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  return c.json({ order: await presentOne(c.env.DB, order), instructions: await loadBankTransfer(c.env.DB), seller: await loadTaxProfile(c.env.DB) });
});

/**
 * Upload the transfer slip (PNG/JPG/WEBP/PDF up to 5 MB), stored privately in R2 under slips/
 * POST /api/student/orders/:id/slip  (multipart field "file")
 */
ordersRouter.post("/student/orders/:id/slip", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  await expireStale(db, user.id);
  const order = await db.prepare("SELECT id, user_id, status, slip_r2_key, installment_count FROM course_orders WHERE id = ?")
    .bind(c.req.param("id")).first<{ id: string; user_id: string; status: string; slip_r2_key: string | null; installment_count: number }>();
  if (!order || order.user_id !== user.id) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  if (order.installment_count > 1) return c.json({ error: "คำสั่งซื้อแบบผ่อนชำระ ให้แนบสลิปที่แต่ละงวด" }, 400);
  if (order.status !== "pending") return c.json({ error: "แนบสลิปได้เฉพาะคำสั่งซื้อที่รอชำระ" }, 400);

  try {
    const stored = await storeSlip(c, order.id);
    if ("error" in stored) return c.json({ error: stored.error }, 400);
    const updated = await db.prepare(`UPDATE course_orders SET slip_r2_key = ?, slip_content_type = ?, slip_uploaded_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`).bind(stored.key, stored.type, order.id).run();
    if (!updated.meta.changes) {
      await c.env.ASSETS.delete(stored.key);
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

/**
 * Slip for one installment
 * POST /api/student/orders/:id/installments/:seq/slip  (multipart field "file")
 */
ordersRouter.post("/student/orders/:id/installments/:seq/slip", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  await expireStale(db, user.id);
  const order = await loadOrder(db, c.req.param("id"));
  if (!order || order.user_id !== user.id) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  if (!["pending", "partial"].includes(order.status)) return c.json({ error: "คำสั่งซื้อนี้ไม่ได้รอชำระแล้ว" }, 400);
  const inst = await db.prepare("SELECT * FROM order_installments WHERE order_id = ? AND seq = ?")
    .bind(order.id, Number(c.req.param("seq"))).first<InstallmentRow>();
  if (!inst) return c.json({ error: "ไม่พบงวดชำระนี้" }, 404);
  if (inst.status !== "pending") return c.json({ error: "งวดนี้ชำระแล้วหรือถูกยกเลิก" }, 400);
  try {
    const stored = await storeSlip(c, `${order.id}/${inst.seq}`);
    if ("error" in stored) return c.json({ error: stored.error }, 400);
    const updated = await db.prepare(`UPDATE order_installments SET slip_r2_key = ?, slip_content_type = ?, slip_uploaded_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'`).bind(stored.key, stored.type, inst.id).run();
    if (!updated.meta.changes) {
      await c.env.ASSETS.delete(stored.key);
      return c.json({ error: "งวดนี้ไม่ได้รอชำระแล้ว" }, 409);
    }
    if (inst.slip_r2_key) await c.env.ASSETS.delete(inst.slip_r2_key).catch(() => undefined);
    return c.json({ order: await presentOne(db, (await loadOrder(db, order.id))!), message: "แนบสลิปแล้ว เจ้าหน้าที่จะตรวจสอบโดยเร็ว" });
  } catch (error) {
    console.error("Installment slip upload failed:", error);
    return c.json({ error: "อัปโหลดสลิปไม่สำเร็จ" }, 500);
  }
});

ordersRouter.post("/student/orders/:id/cancel", rbac(["student", "admin"]), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE course_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status = 'pending'`).bind(id, user.id),
    c.env.DB.prepare(`UPDATE order_installments SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'
      AND EXISTS (SELECT 1 FROM course_orders WHERE id = ? AND user_id = ? AND status = 'cancelled')`).bind(id, id, user.id)
  ]);
  if (!results[0].meta.changes) return c.json({ error: "ยกเลิกได้เฉพาะคำสั่งซื้อของคุณที่รอชำระ" }, 400);
  return c.json({ message: "ยกเลิกคำสั่งซื้อแล้ว" });
});

/**
 * Ask for (or withdraw) a full tax invoice: buyer name/company, 13-digit tax ID, branch, address.
 * Allowed until the tax invoice is issued; on a paid order it is issued right away.
 * PUT /api/student/orders/:id/tax-invoice { request: boolean, buyer_name, buyer_tax_id, buyer_branch, buyer_address }
 */
ordersRouter.put("/student/orders/:id/tax-invoice", rbac(["student", "admin"]), async (c) => {
  const order = await loadOrder(c.env.DB, c.req.param("id"));
  if (!order || order.user_id !== c.get("user").id) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  return await updateTaxRequest(c, order);
});

async function updateTaxRequest(c: Context<Env>, order: OrderRow) {
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
  if (!["pending", "partial", "paid", "expired"].includes(order.status)) return c.json({ error: "คำสั่งซื้อนี้ขอใบกำกับภาษีไม่ได้" }, 400);
  if (order.tax_invoice_no) return c.json({ error: "ออกใบกำกับภาษีแล้ว แก้ไขข้อมูลไม่ได้" }, 409);
  if (body.request === false) {
    await db.prepare(`UPDATE course_orders SET tax_invoice_requested = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tax_invoice_no IS NULL`).bind(order.id).run();
  } else {
    const parsed = parseBuyerTaxDetails(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const v = parsed.value;
    await db.prepare(`UPDATE course_orders SET tax_invoice_requested = 1, buyer_name = ?, buyer_tax_id = ?, buyer_branch = ?, buyer_address = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tax_invoice_no IS NULL`)
      .bind(v.buyer_name, v.buyer_tax_id, v.buyer_branch, v.buyer_address, order.id).run();
    if (currentVatRate(await loadTaxProfile(db)) > 0) await issuePendingTaxInvoices(db, order);
  }
  return c.json({ order: await presentOne(db, (await loadOrder(db, order.id))!) });
}

/**
 * Slip file: readable only by the order owner and payments.manage holders
 * GET /api/orders/:id/slip   GET /api/orders/:id/installments/:seq/slip
 */
ordersRouter.get("/orders/:id/slip", rbac(), async (c) => {
  const user = c.get("user");
  const order = await c.env.DB.prepare("SELECT user_id, slip_r2_key, slip_content_type, reference FROM course_orders WHERE id = ?")
    .bind(c.req.param("id")).first<{ user_id: string; slip_r2_key: string | null; slip_content_type: string | null; reference: string }>();
  if (!order) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  if (order.user_id !== user.id && !(await currentPermissions(c)).has("payments.manage")) {
    return c.json({ error: "ไม่มีสิทธิ์ดูสลิปนี้" }, 403);
  }
  return serveSlip(c, order.slip_r2_key, order.slip_content_type, `slip-${order.reference}`);
});

ordersRouter.get("/orders/:id/installments/:seq/slip", rbac(), async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare(`SELECT o.user_id, o.reference, i.seq, i.slip_r2_key, i.slip_content_type FROM order_installments i
    JOIN course_orders o ON o.id = i.order_id WHERE i.order_id = ? AND i.seq = ?`).bind(c.req.param("id"), Number(c.req.param("seq")))
    .first<{ user_id: string; reference: string; seq: number; slip_r2_key: string | null; slip_content_type: string | null }>();
  if (!row) return c.json({ error: "ไม่พบงวดชำระ" }, 404);
  if (row.user_id !== user.id && !(await currentPermissions(c)).has("payments.manage")) {
    return c.json({ error: "ไม่มีสิทธิ์ดูสลิปนี้" }, 403);
  }
  return serveSlip(c, row.slip_r2_key, row.slip_content_type, `slip-${row.reference}-${row.seq}`);
});

// ==========================================
// Staff (payments.manage)
// ==========================================

ordersRouter.use("/manage/orders", rbac(), permit("payments.manage"));
ordersRouter.use("/manage/orders/*", rbac(), permit("payments.manage"));
ordersRouter.use("/manage/payment-settings", rbac(), permit("payments.manage"));

const ORDER_STATUSES = ["pending", "partial", "paid", "rejected", "cancelled", "expired", "refunded"];

/**
 * GET /api/manage/orders?status=pending|partial|paid|all|…&kind=course|bundle|membership|organization&q=reference/email/name
 */
ordersRouter.get("/manage/orders", async (c) => {
  const db = c.env.DB;
  await expireStale(db);
  const status = c.req.query("status") || "all";
  if (status !== "all" && !ORDER_STATUSES.includes(status)) return c.json({ error: "สถานะไม่ถูกต้อง" }, 400);
  const kind = c.req.query("kind") || "all";
  if (!["all", "course", "bundle", "membership", "organization"].includes(kind)) return c.json({ error: "ประเภทไม่ถูกต้อง" }, 400);
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  const like = q ? `%${q.replace(/[\\%_]/g, ch => "\\" + ch)}%` : null;
  const rows = await db.prepare(`${ORDER_SELECT}
    WHERE (?1 = 'all' OR o.status = ?1) AND (?2 = 'all' OR o.kind = ?2)
      AND (?3 IS NULL OR o.reference LIKE ?3 ESCAPE '\\' OR u.email LIKE ?3 ESCAPE '\\' OR u.name LIKE ?3 ESCAPE '\\'
        OR o.receipt_no LIKE ?3 ESCAPE '\\' OR o.tax_invoice_no LIKE ?3 ESCAPE '\\' OR pa.company_name LIKE ?3 ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM order_installments i WHERE i.order_id = o.id AND (i.receipt_no LIKE ?3 ESCAPE '\\' OR i.tax_invoice_no LIKE ?3 ESCAPE '\\')))
    ORDER BY CASE WHEN o.status = 'pending' THEN 0 WHEN o.status = 'partial' THEN 1 ELSE 2 END, o.created_at DESC LIMIT 200`)
    .bind(status, kind, like).all<OrderRow>();
  const counts = await db.prepare("SELECT status, COUNT(*) AS n FROM course_orders GROUP BY status").all<{ status: string; n: number }>();
  const waiting = await db.prepare(`SELECT COUNT(*) AS n FROM order_installments i JOIN course_orders o ON o.id = i.order_id
    WHERE i.status = 'pending' AND i.slip_r2_key IS NOT NULL AND o.status IN ('pending', 'partial', 'expired')`).first<{ n: number }>();
  return c.json({
    orders: await presentMany(db, rows.results),
    counts: Object.fromEntries(counts.results.map(r => [r.status, r.n])),
    installment_slips_waiting: waiting?.n ?? 0
  });
});

ordersRouter.get("/manage/orders/:id", async (c) => {
  const order = await loadOrder(c.env.DB, c.req.param("id"));
  if (!order) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  return c.json({ order: await presentOne(c.env.DB, order), seller: await loadTaxProfile(c.env.DB) });
});

const parseReceived = (value: unknown) => {
  const n = Number(value);
  return value !== null && value !== "" && Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.round(n * 100) / 100 : null;
};

/**
 * Confirm a transfer: records the amount, opens what was bought, issues a receipt (and a tax invoice
 * when requested and VAT registered). Also repairs a paid order that has no receipt yet.
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
    if (order.installment_count > 1) return c.json({ error: "คำสั่งซื้อแบบผ่อนชำระ ให้ยืนยันทีละงวด" }, 400);
    const repair = order.status === "paid" && !order.receipt_no;
    if (!repair && !["pending", "expired"].includes(order.status)) return c.json({ error: "ยืนยันได้เฉพาะคำสั่งซื้อที่รอตรวจสอบหรือหมดเวลา" }, 400);
    const received = repair && body?.amount_received === undefined ? null : parseReceived(body?.amount_received);
    if (!repair && received === null) return c.json({ error: "กรุณาระบุยอดเงินที่ได้รับ" }, 400);
    if (repair && body?.amount_received !== undefined && received === null) return c.json({ error: "กรุณาระบุยอดเงินที่ได้รับ" }, 400);
    const grants = await loadGrants(db, order);
    const vatRate = currentVatRate(await loadTaxProfile(db));

    // Claim, receipt and access commit together; a double click finds nothing left to do.
    const done = await completeOrder(db, order, grants, vatRate, repair ? undefined
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
    await affiliatePaid(db, order.id);
    const fresh = (await loadOrder(db, order.id))!;
    await audit(c, repair ? "complete" : "confirm", "course_order", order.id,
      { reference: order.reference, amount: order.amount, received: fresh.amount_received, receipt_no: fresh.receipt_no, tax_invoice_no: fresh.tax_invoice_no, voucher_note: voucherNote });
    await createNotification(db, order.user_id, "ยืนยันการชำระเงินแล้ว",
      `คำสั่งซื้อ ${order.reference} ${order.course_title} ${order.kind === "organization" ? "เพิ่มที่นั่งให้องค์กรแล้ว" : "เปิดสิทธิ์เข้าเรียนแล้ว"} ใบเสร็จเลขที่ ${fresh.receipt_no}`);
    await sendReceipt(c, fresh, { receipt_no: fresh.receipt_no!, amount: fresh.amount_received ?? fresh.amount, tax_invoice_no: fresh.tax_invoice_no });
    return c.json({ order: present(fresh), enrollment: { id: fresh.enrollment_id, expires_at: done.expires_at }, voucher_note: voucherNote, repaired: repair });
  } catch (error) {
    console.error("Confirm order failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะยืนยันการชำระเงิน" }, 500);
  }
});

/**
 * Confirm one installment (in order: an earlier unpaid installment must be confirmed first)
 * POST /api/manage/orders/:id/installments/:seq/confirm { amount_received, note? }
 */
ordersRouter.post("/manage/orders/:id/installments/:seq/confirm", async (c) => {
  const db = c.env.DB;
  const staff = c.get("user");
  const body = await c.req.json<{ amount_received?: unknown; note?: unknown }>().catch(() => null);
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
  const received = parseReceived(body?.amount_received);
  if (received === null) return c.json({ error: "กรุณาระบุยอดเงินที่ได้รับ" }, 400);
  try {
    const order = await loadOrder(db, c.req.param("id"));
    if (!order) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
    if (order.installment_count < 2) return c.json({ error: "คำสั่งซื้อนี้ไม่ได้ผ่อนชำระ" }, 400);
    if (!["pending", "partial", "expired"].includes(order.status)) return c.json({ error: "คำสั่งซื้อนี้ไม่ได้รอชำระแล้ว" }, 400);
    const inst = await db.prepare("SELECT * FROM order_installments WHERE order_id = ? AND seq = ?")
      .bind(order.id, Number(c.req.param("seq"))).first<InstallmentRow>();
    if (!inst) return c.json({ error: "ไม่พบงวดชำระนี้" }, 404);
    if (inst.status !== "pending") return c.json({ error: "งวดนี้ถูกดำเนินการไปแล้ว" }, 409);
    const unpaidBefore = await db.prepare("SELECT COUNT(*) AS n FROM order_installments WHERE order_id = ? AND status = 'pending' AND seq < ?")
      .bind(order.id, inst.seq).first<{ n: number }>();
    if ((unpaidBefore?.n ?? 0) > 0) return c.json({ error: "กรุณายืนยันงวดก่อนหน้าก่อน" }, 400);
    const grants = await loadGrants(db, order);
    const vatRate = currentVatRate(await loadTaxProfile(db));
    const done = await confirmInstallment(db, order, inst, grants, vatRate, { received, paidAt: nowIso(), staffId: staff.id, note: note || null });
    if (!done.completed) return c.json({ error: "งวดนี้ถูกดำเนินการไปแล้ว" }, 409);
    if (done.voucherUsed === false) {
      await db.prepare("UPDATE course_orders SET voucher_note = ? WHERE id = ?")
        .bind(`โค้ด ${order.voucher_code} ถูกใช้ครบสิทธิ์ก่อนยืนยัน ยืนยันตามยอดที่ได้รับ`, order.id).run();
    }
    const fresh = (await loadOrder(db, order.id))!;
    if (fresh.status === "paid") await affiliatePaid(db, order.id);
    const paidInst = (await db.prepare("SELECT * FROM order_installments WHERE id = ?").bind(inst.id).first<InstallmentRow>())!;
    await audit(c, "confirm_installment", "course_order", order.id, { reference: order.reference, seq: inst.seq, received, receipt_no: paidInst.receipt_no });
    await createNotification(db, order.user_id, "ยืนยันการชำระงวดแล้ว",
      `คำสั่งซื้อ ${order.reference} งวดที่ ${inst.seq}/${order.installment_count} ใบเสร็จเลขที่ ${paidInst.receipt_no}${fresh.access_granted_at ? " เข้าเรียนได้แล้ว" : ""}`);
    await sendReceipt(c, fresh, { receipt_no: paidInst.receipt_no!, amount: received, label: `งวดที่ ${inst.seq}/${order.installment_count}`, tax_invoice_no: paidInst.tax_invoice_no });
    return c.json({ order: await presentOne(db, fresh), installment: presentInstallment(paidInst), access_open: !!fresh.access_granted_at && !fresh.suspended_at });
  } catch (error) {
    console.error("Confirm installment failed:", error);
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
  const results = await db.batch([
    db.prepare(`UPDATE course_orders SET status = 'rejected', staff_note = ?, confirmed_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('pending', 'expired')`).bind(note, c.get("user").id, order.id),
    db.prepare(`UPDATE order_installments SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'
      AND EXISTS (SELECT 1 FROM course_orders WHERE id = ? AND status = 'rejected')`).bind(order.id, order.id)
  ]);
  if (!results[0].meta.changes) return c.json({ error: "ปฏิเสธได้เฉพาะคำสั่งซื้อที่รอตรวจสอบ" }, 400);
  await audit(c, "reject", "course_order", order.id, { reference: order.reference, note });
  await createNotification(db, order.user_id, "การชำระเงินไม่ผ่านการตรวจสอบ", `คำสั่งซื้อ ${order.reference}: ${note}`);
  return c.json({ order: await presentOne(db, (await loadOrder(db, order.id))!) });
});

/**
 * Refund or cancel a paid (or partly paid) order: what it opened is suspended unless another paid
 * order still covers it, a membership is shortened by the refunded period, and a credit note
 * (CN-2026-000001) is issued when the order had a tax invoice. Organization seats are adjusted by hand.
 * POST /api/manage/orders/:id/refund { note }
 */
ordersRouter.post("/manage/orders/:id/refund", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ note?: unknown }>().catch(() => null);
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (!note) return c.json({ error: "กรุณาระบุเหตุผลการคืนเงิน/ยกเลิก" }, 400);
  const order = await loadOrder(db, c.req.param("id"));
  if (!order) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  try {
    const refundedAt = nowIso();
    const year = String(thaiYear());
    const counter = `credit_note_${year}`;
    const grants = order.kind === "membership" ? await loadGrants(db, order) : null;
    const done = `EXISTS (SELECT 1 FROM course_orders WHERE id = ? AND status = 'refunded' AND refunded_at = ?)`;
    const statements: D1PreparedStatement[] = [
      db.prepare(`UPDATE course_orders SET status = 'refunded', staff_note = ?, refunded_at = ?, refunded_by = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('paid', 'partial')`).bind(note, refundedAt, c.get("user").id, order.id),
      db.prepare(`UPDATE order_installments SET status = CASE WHEN status = 'paid' THEN 'refunded' ELSE 'cancelled' END
        WHERE order_id = ? AND status IN ('paid', 'pending') AND ${done}`).bind(order.id, order.id, refundedAt)
    ];
    if (grants?.membership && order.access_granted_at) {
      // Take off the days this order actually added (stored at confirmation); nothing left means the membership ends now.
      const { productId } = grants.membership;
      const days = order.granted_days ?? grants.membership.days;
      statements.push(
        db.prepare(`UPDATE memberships SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(expires_at) - ?),
          status = CASE WHEN julianday(expires_at) - ? <= julianday('now') THEN 'cancelled' ELSE status END, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND product_id = ? AND ${done}`).bind(days, days, order.user_id, productId, order.id, refundedAt),
        db.prepare(`UPDATE enrollments SET
            expires_at = (SELECT m.expires_at FROM memberships m WHERE m.user_id = enrollments.user_id AND m.product_id = ?),
            status = CASE WHEN (SELECT m.status FROM memberships m WHERE m.user_id = enrollments.user_id AND m.product_id = ?) = 'active' THEN status ELSE 'suspended' END
          WHERE user_id = ? AND expires_at IS NOT NULL AND course_id IN ${ORDER_COURSES} AND NOT ${COVERED_ELSEWHERE} AND ${done}`)
          .bind(productId, productId, order.user_id, order.id, order.id, order.id, order.id, refundedAt)
      );
    } else if (order.kind !== "organization") {
      statements.push(db.prepare(`UPDATE enrollments SET status = 'suspended'
        WHERE user_id = ? AND (course_id IN ${ORDER_COURSES} OR id = ?) AND NOT ${COVERED_ELSEWHERE} AND ${done}`)
        .bind(order.user_id, order.id, order.id, order.enrollment_id, order.id, order.id, refundedAt));
    }
    const creditNeeded = `EXISTS (SELECT 1 FROM course_orders o WHERE o.id = ? AND o.status = 'refunded' AND o.refunded_at = ? AND o.credit_note_no IS NULL
      AND (o.tax_invoice_no IS NOT NULL OR EXISTS (SELECT 1 FROM order_installments i WHERE i.order_id = o.id AND i.tax_invoice_no IS NOT NULL)))`;
    statements.push(
      db.prepare(`INSERT INTO order_counters (name, value) SELECT ?, 1 WHERE ${creditNeeded} ON CONFLICT(name) DO UPDATE SET value = value + 1`)
        .bind(counter, order.id, refundedAt),
      db.prepare(`UPDATE course_orders SET credit_note_no = 'CN-' || ? || '-' || printf('%06d', (SELECT value FROM order_counters WHERE name = ?)),
          credit_note_at = ?, credit_note_amount = CASE WHEN installment_count > 1
            THEN (SELECT COALESCE(SUM(amount_received), 0) FROM order_installments WHERE order_id = course_orders.id AND status = 'refunded')
            ELSE COALESCE(amount_received, amount) END
        WHERE id = ? AND ${creditNeeded}`).bind(year, counter, refundedAt, order.id, order.id, refundedAt)
    );
    const results = await db.batch(statements);
    if (!results[0].meta.changes) return c.json({ error: "คืนเงินได้เฉพาะคำสั่งซื้อที่ชำระแล้ว" }, 400);
    await affiliateRefunded(db, order.id);
    const fresh = (await loadOrder(db, order.id))!;
    await audit(c, "refund", "course_order", order.id, { reference: order.reference, receipt_no: order.receipt_no, credit_note_no: fresh.credit_note_no, note });
    await createNotification(db, order.user_id, "คำสั่งซื้อถูกยกเลิก/คืนเงิน",
      `คำสั่งซื้อ ${order.reference} ${order.course_title} ถูกยกเลิก${order.kind === "organization" ? "" : "และระงับสิทธิ์เข้าเรียน"}: ${note}`);
    return c.json({ order: await presentOne(db, fresh) });
  } catch (error) {
    console.error("Refund order failed:", error);
    return c.json({ error: "เกิดข้อผิดพลาดภายในระบบขณะคืนเงิน" }, 500);
  }
});

/**
 * Staff enter or correct the buyer's tax invoice details (e.g. an organization order)
 * PUT /api/manage/orders/:id/tax-invoice { request?, buyer_name, buyer_tax_id, buyer_branch, buyer_address }
 */
ordersRouter.put("/manage/orders/:id/tax-invoice", async (c) => {
  const order = await loadOrder(c.env.DB, c.req.param("id"));
  if (!order) return c.json({ error: "ไม่พบคำสั่งซื้อ" }, 404);
  const response = await updateTaxRequest(c, order);
  if (response.status === 200) await audit(c, "tax_invoice", "course_order", order.id, { reference: order.reference });
  return response;
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
