/**
 * Thai tax helpers: 13-digit taxpayer ID checksum, VAT-inclusive breakdown (computed in satang so the
 * base and VAT always add up to the paid amount) and the school's tax profile (payment_settings 'tax_profile').
 */

/** Standard VAT rate in Thailand (prices are VAT inclusive). */
export const VAT_RATE = 7;

/** 13-digit Thai taxpayer / citizen ID with the mod-11 check digit. */
export function isValidThaiTaxId(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{13}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(value[12]);
}

/** Digits only: "0-1055-56000-00-1" or "0105556000001" → "0105556000001". */
export const normalizeTaxId = (value: unknown) => typeof value === "string" ? value.replace(/[\s-]/g, "") : "";

/** Branch label: empty/"สำนักงานใหญ่"/"00000" → head office; five digits → that branch number. */
export function normalizeBranch(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text === "สำนักงานใหญ่" || text === "00000" || text.toLowerCase() === "head office") return "สำนักงานใหญ่";
  if (/^\d{5}$/.test(text)) return text;
  const match = /^สาขา(?:ที่)?\s*(\d{5})$/.exec(text);
  return match ? match[1] : null;
}

export interface VatBreakdown { total: number; base: number; vat: number; rate: number }

/** Splits a VAT-inclusive amount (baht) into base + VAT, rounding once in satang. */
export function vatBreakdown(amount: number, rate: number | null | undefined): VatBreakdown {
  const totalSatang = Math.round((Number(amount) || 0) * 100);
  const r = rate && rate > 0 ? rate : 0;
  const vatSatang = r ? Math.round((totalSatang * r) / (100 + r)) : 0;
  return { total: totalSatang / 100, base: (totalSatang - vatSatang) / 100, vat: vatSatang / 100, rate: r };
}

export interface TaxProfile {
  company_name: string; tax_id: string; branch: string; address: string; phone: string; vat_registered: boolean;
}

export const EMPTY_TAX_PROFILE: TaxProfile = { company_name: "", tax_id: "", branch: "สำนักงานใหญ่", address: "", phone: "", vat_registered: false };

export async function loadTaxProfile(db: D1Database): Promise<TaxProfile> {
  const profile = { ...EMPTY_TAX_PROFILE };
  const row = await db.prepare("SELECT value FROM payment_settings WHERE key = 'tax_profile'").first<{ value: string }>();
  try {
    const parsed = row ? JSON.parse(row.value) : {};
    for (const key of ["company_name", "tax_id", "branch", "address", "phone"] as const) {
      if (typeof parsed[key] === "string") profile[key] = parsed[key];
    }
    profile.vat_registered = parsed.vat_registered === true;
  } catch { /* Broken settings fall back to "not VAT registered". */ }
  return profile;
}

/** VAT % that applies to a receipt issued now (0 unless registered with a valid tax ID). */
export const currentVatRate = (profile: TaxProfile) => profile.vat_registered && isValidThaiTaxId(profile.tax_id) ? VAT_RATE : 0;

export interface BuyerTaxDetails { buyer_name: string; buyer_tax_id: string; buyer_branch: string; buyer_address: string }

/** Validates a buyer's full tax invoice request; returns the cleaned details or a Thai error message. */
export function parseBuyerTaxDetails(input: unknown): { ok: true; value: BuyerTaxDetails } | { ok: false; error: string } {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const name = typeof body.buyer_name === "string" ? body.buyer_name.trim() : "";
  const taxId = normalizeTaxId(body.buyer_tax_id);
  const address = typeof body.buyer_address === "string" ? body.buyer_address.trim() : "";
  const branch = normalizeBranch(body.buyer_branch);
  if (!name || name.length > 200) return { ok: false, error: "กรุณากรอกชื่อผู้ซื้อหรือชื่อบริษัท (ไม่เกิน 200 ตัวอักษร)" };
  if (!/^\d{13}$/.test(taxId)) return { ok: false, error: "เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก" };
  if (!isValidThaiTaxId(taxId)) return { ok: false, error: "เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (ตรวจสอบหลักสุดท้าย)" };
  if (!branch) return { ok: false, error: "สาขาต้องเป็น \"สำนักงานใหญ่\" หรือเลขสาขา 5 หลัก" };
  if (!address || address.length > 500) return { ok: false, error: "กรุณากรอกที่อยู่สำหรับออกใบกำกับภาษี (ไม่เกิน 500 ตัวอักษร)" };
  return { ok: true, value: { buyer_name: name, buyer_tax_id: taxId, buyer_branch: branch, buyer_address: address } };
}
