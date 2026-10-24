/** Voucher rules shared by checkout and order confirmation. */
export interface UsableVoucher {
  id: string; code: string; discount_type: "percent" | "fixed"; discount_value: number; course_id: string | null;
}

/** Returns the voucher when it is active, not expired, matches the course and still has uses left. */
export async function findUsableVoucher(db: D1Database, code: string, courseId: string): Promise<UsableVoucher | null> {
  if (typeof code !== "string" || !code.trim()) return null;
  return await db.prepare(`SELECT id, code, discount_type, discount_value, course_id FROM vouchers
    WHERE code = ? AND active = 1 AND (course_id IS NULL OR course_id = ?)
      AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR used_count < max_uses)`)
    .bind(code.trim().toUpperCase(), courseId, new Date().toISOString()).first<UsableVoucher>() ?? null;
}

/** Price after discount in whole baht, never below zero. */
export function discountedPrice(price: number, voucher: UsableVoucher | null): number {
  if (!voucher) return Math.round(price);
  const discount = voucher.discount_type === "percent" ? price * (voucher.discount_value / 100) : voucher.discount_value;
  return Math.max(0, Math.round(price - discount));
}

/** Counts one use atomically; false when the voucher ran out in the meantime. */
export async function consumeVoucher(db: D1Database, voucherId: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE vouchers SET used_count = used_count + 1
    WHERE id = ? AND (max_uses IS NULL OR used_count < max_uses)`).bind(voucherId).run();
  return result.meta.changes > 0;
}
