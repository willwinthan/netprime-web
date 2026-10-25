import { createPortal } from "react-dom";
import React, { useEffect, useState } from "react";
import { AlertCircle, Check, Copy, Tag, Upload, X } from "lucide-react";
import { useApi } from "../../hooks/useApi";

// ==========================================
// Bank-transfer orders for learners (replaces card checkout)
// ==========================================

export interface BankTransfer {
  bank_name: string; account_name: string; account_number: string; promptpay_id: string; note: string;
}

export interface VatSplit { total: number; base: number; vat: number; rate: number }

export interface OrderInstallment {
  id: string; seq: number; amount: number; due_at: string; status: "pending" | "paid" | "cancelled" | "refunded";
  has_slip: boolean; slip_uploaded_at: string | null; amount_received: number | null; paid_at: string | null;
  receipt_no: string | null; tax_invoice_no: string | null; vat_rate: number | null; overdue: boolean; vat: VatSplit | null;
}

export interface CourseOrder {
  id: string; reference: string; course_id: string | null; course_title: string; list_price: number; amount: number;
  voucher_code: string | null; status: "pending" | "partial" | "paid" | "rejected" | "cancelled" | "expired" | "refunded";
  expires_at: string; has_slip: boolean; slip_uploaded_at: string | null; amount_received: number | null;
  paid_at: string | null; receipt_no: string | null; staff_note: string | null; voucher_note: string | null;
  user_name: string; user_email: string; created_at: string; refunded_at: string | null;
  // Commerce (products, installments, tax invoices)
  product_id?: string | null; kind?: "course" | "bundle" | "membership" | "organization"; partner_name?: string | null; seats?: number | null;
  installment_count?: number; installments?: OrderInstallment[]; total_received?: number | null;
  access_granted_at?: string | null; suspended_at?: string | null; vat_rate?: number | null; vat?: VatSplit | null;
  tax_invoice_requested?: number; buyer_name?: string | null; buyer_tax_id?: string | null; buyer_branch?: string | null; buyer_address?: string | null;
  tax_invoice_no?: string | null; tax_invoice_at?: string | null;
  credit_note_no?: string | null; credit_note_at?: string | null; credit_note_amount?: number | null; reminder_sent_at?: string | null;
}

export const ORDER_KIND: Record<string, string> = { course: "คอร์ส", bundle: "ชุดคอร์ส", membership: "สมาชิก", organization: "องค์กร" };

/** Buyer details for a full tax invoice (ใบกำกับภาษีเต็มรูป). */
export interface BuyerTax { buyer_name: string; buyer_tax_id: string; buyer_branch: string; buyer_address: string }
export const EMPTY_BUYER: BuyerTax = { buyer_name: "", buyer_tax_id: "", buyer_branch: "สำนักงานใหญ่", buyer_address: "" };

/** Same 13-digit check digit rule as the server (utils/tax.ts). */
export function isValidThaiTaxId(value: string): boolean {
  const id = value.replace(/[\s-]/g, "");
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}

/** Form fields for a tax invoice request; shows the checksum error inline. */
export const TaxInvoiceFields: React.FC<{ value: BuyerTax; onChange: (next: BuyerTax) => void }> = ({ value, onChange }) => {
  const set = (key: keyof BuyerTax) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...value, [key]: e.target.value });
  const id = value.buyer_tax_id.replace(/[\s-]/g, "");
  return (
    <div style={{ display: "grid", gap: "8px" }}>
      <input className="form-input" placeholder="ชื่อผู้ซื้อหรือชื่อบริษัท" value={value.buyer_name} onChange={set("buyer_name")} maxLength={200} aria-label="ชื่อผู้ซื้อ" />
      <div style={{ display: "flex", gap: "8px" }}>
        <input className="form-input" placeholder="เลขประจำตัวผู้เสียภาษี 13 หลัก" value={value.buyer_tax_id} onChange={set("buyer_tax_id")} inputMode="numeric"
          maxLength={17} aria-label="เลขประจำตัวผู้เสียภาษี" style={{ flex: 2 }} />
        <input className="form-input" placeholder="สำนักงานใหญ่ หรือเลขสาขา 5 หลัก" value={value.buyer_branch} onChange={set("buyer_branch")} maxLength={50}
          aria-label="สาขา" style={{ flex: 1 }} />
      </div>
      {id.length > 0 && !isValidThaiTaxId(id) && (
        <p style={{ color: "var(--danger)", fontSize: "12px" }}>{id.length !== 13 ? "ต้องเป็นตัวเลข 13 หลัก" : "เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (ตรวจสอบหลักสุดท้าย)"}</p>
      )}
      <textarea className="form-input" rows={2} placeholder="ที่อยู่สำหรับออกใบกำกับภาษี" value={value.buyer_address} onChange={set("buyer_address")} maxLength={500} aria-label="ที่อยู่" />
    </div>
  );
};

export const buyerReady = (b: BuyerTax) => !!b.buyer_name.trim() && isValidThaiTaxId(b.buyer_tax_id) && !!b.buyer_address.trim();

export const ORDER_STATUS: Record<CourseOrder["status"], { label: string; color: string; bg: string }> = {
  pending: { label: "รอชำระ/รอตรวจสอบ", color: "var(--primary)", bg: "var(--primary-glow)" },
  partial: { label: "ผ่อนชำระอยู่", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  paid: { label: "ชำระแล้ว", color: "var(--accent)", bg: "var(--accent-glow)" },
  rejected: { label: "ไม่ผ่านการตรวจสอบ", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" },
  cancelled: { label: "ยกเลิก", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" },
  expired: { label: "หมดเวลาชำระ", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  refunded: { label: "คืนเงิน/ยกเลิกแล้ว", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" }
};

export const baht = (value: number) => `฿${value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatThaiDateTime = (value: string | null | undefined) => {
  if (!value) return "-";
  const date = new Date(value.includes("T") || value.includes("Z") ? value : value.replace(" ", "T") + "Z");
  return isNaN(date.getTime()) ? value : date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
};

const box: React.CSSProperties = { border: "1px solid var(--border-subtle)", borderRadius: "12px", padding: "14px 16px", fontSize: "13px" };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: "12px", padding: "4px 0" };

const CopyValue: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--primary)", display: "inline-flex", alignItems: "center", gap: "4px", fontFamily: "monospace", fontWeight: 700, fontSize: "13px" }}
      aria-label={`คัดลอก ${value}`}>
      {value} {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
};

/** Where and how much to transfer for one order. */
export const TransferInstructions: React.FC<{ order: CourseOrder; instructions: BankTransfer; amount?: number; label?: string; dueAt?: string }> = ({ order, instructions, amount, label, dueAt }) => (
  <div style={{ ...box, background: "rgba(229,107,37,0.04)" }}>
    <div style={row}><span>ยอดที่ต้องโอน{label ? ` (${label})` : ""}</span><strong style={{ fontSize: "16px", color: "var(--primary)" }}>{baht(amount ?? order.amount)}</strong></div>
    <div style={row}><span>เลขที่คำสั่งซื้อ (ใส่ในบันทึกการโอน)</span><CopyValue value={order.reference} /></div>
    {instructions.bank_name && <div style={row}><span>ธนาคาร</span><span>{instructions.bank_name}</span></div>}
    {instructions.account_name && <div style={row}><span>ชื่อบัญชี</span><span>{instructions.account_name}</span></div>}
    {instructions.account_number && <div style={row}><span>เลขที่บัญชี</span><CopyValue value={instructions.account_number} /></div>}
    {instructions.promptpay_id && <div style={row}><span>พร้อมเพย์</span><CopyValue value={instructions.promptpay_id} /></div>}
    <div style={row}><span>โอนภายใน</span><span>{formatThaiDateTime(dueAt ?? order.expires_at)}</span></div>
    {!instructions.account_number && !instructions.promptpay_id && (
      <p style={{ color: "var(--warning)", marginTop: "6px" }}>ยังไม่ได้ตั้งค่าบัญชีรับโอน กรุณาติดต่อเจ้าหน้าที่</p>
    )}
    {instructions.note && <p style={{ color: "var(--text-secondary)", marginTop: "8px", lineHeight: 1.5 }}>{instructions.note}</p>}
  </div>
);

/** Slip upload for a pending order (PNG/JPG/WEBP/PDF ≤ 5 MB). */
export const SlipUpload: React.FC<{ order: CourseOrder; onUploaded: (order: CourseOrder) => void; installment?: OrderInstallment }> = ({ order, onUploaded, installment }) => {
  const target = installment ?? order;
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(file.type)) return setError("รองรับเฉพาะไฟล์ PNG, JPG, WEBP หรือ PDF");
    if (file.size > 5 * 1024 * 1024) return setError("ไฟล์สลิปต้องไม่เกิน 5 MB");
    const form = new FormData();
    form.append("file", file);
    try {
      setBusy(true);
      const res = await api.request<{ order: CourseOrder }>(installment ? `/student/orders/${order.id}/installments/${installment.seq}/slip` : `/student/orders/${order.id}/slip`, { method: "POST", body: form });
      onUploaded(res.order);
    } catch (err: any) {
      setError(err.message || "อัปโหลดสลิปไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...box, borderStyle: "dashed" }}>
      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: busy ? "wait" : "pointer", fontWeight: 600 }}>
        <Upload size={16} color="var(--primary)" />
        {busy ? "กำลังอัปโหลด..." : target.has_slip ? "แนบสลิปแล้ว — เปลี่ยนไฟล์" : installment ? `แนบสลิปงวดที่ ${installment.seq}` : "แนบสลิปการโอน"}
        <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" disabled={busy}
          onChange={e => { upload(e.target.files?.[0]); e.target.value = ""; }} style={{ display: "none" }} />
      </label>
      <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
        {target.has_slip ? `ส่งเมื่อ ${formatThaiDateTime(target.slip_uploaded_at)} เจ้าหน้าที่จะตรวจสอบและเปิดสิทธิ์ให้` : "PNG, JPG, WEBP หรือ PDF ไม่เกิน 5 MB"}
      </p>
      {error && <p style={{ color: "var(--danger)", fontSize: "12px", marginTop: "6px" }}>{error}</p>}
    </div>
  );
};

interface OrderCourse { id: string; title: string; price?: number; access_duration_days?: number | null }

/**
 * "ซื้อคอร์ส": optional voucher, create the order, then show transfer instructions and slip upload.
 */
export const CourseOrderModal: React.FC<{ course: OrderCourse; onClose: () => void; onEnrolled: () => void; onShowPayments?: () => void }> = ({ course, onClose, onEnrolled, onShowPayments }) => {
  const api = useApi();
  const [code, setCode] = useState("");
  const [voucher, setVoucher] = useState<{ code: string; discount_amount: number; final_price: number } | null>(null);
  const [voucherError, setVoucherError] = useState<string | null>(null);
  const [order, setOrder] = useState<CourseOrder | null>(null);
  const [instructions, setInstructions] = useState<BankTransfer | null>(null);
  // A full tax invoice only exists when the school is VAT-registered (tax profile in OrdersPage).
  const [vatRegistered, setVatRegistered] = useState(false);
  useEffect(() => {
    api.get<{ seller?: { vat_registered?: boolean } }>("/student/payment-instructions")
      .then(res => setVatRegistered(!!res.seller?.vat_registered)).catch(() => undefined);
  }, []);
  const [enrolled, setEnrolled] = useState(false);
  const [wantTax, setWantTax] = useState(false);
  const [buyer, setBuyer] = useState<BuyerTax>(EMPTY_BUYER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reopen an existing open order instead of asking for a second one.
  useEffect(() => {
    api.get<{ orders: CourseOrder[]; instructions: BankTransfer }>("/student/orders").then(res => {
      setInstructions(res.instructions);
      const open = res.orders.find(o => o.course_id === course.id && o.status === "pending");
      if (open) setOrder(open);
    }).catch(() => undefined);
  }, [course.id]);

  const applyVoucher = async () => {
    if (!code.trim()) return;
    try {
      setVoucherError(null);
      setVoucher(await api.post<any>("/student/vouchers/apply", { code: code.trim(), course_id: course.id }));
    } catch (err: any) {
      setVoucher(null);
      setVoucherError(err.message || "โค้ดส่วนลดใช้ไม่ได้");
    }
  };

  const createOrder = async () => {
    try {
      setBusy(true);
      setError(null);
      const res = await api.post<{ order: CourseOrder; enrolled: boolean; instructions?: BankTransfer }>("/student/orders",
        { course_id: course.id, voucher_code: voucher?.code || undefined, tax_invoice: wantTax ? buyer : undefined });
      setOrder(res.order);
      if (res.instructions) setInstructions(res.instructions);
      if (res.enrolled) { setEnrolled(true); onEnrolled(); }
    } catch (err: any) {
      setError(err.message || "สร้างคำสั่งซื้อไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const cancelOrder = async () => {
    if (!order || !window.confirm(`ยกเลิกคำสั่งซื้อ ${order.reference}?`)) return;
    try {
      await api.post(`/student/orders/${order.id}/cancel`, {});
      setOrder(null);
    } catch (err: any) {
      setError(err.message || "ยกเลิกไม่สำเร็จ");
    }
  };

  const price = Math.round(course.price || 0);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="ซื้อคอร์ส" onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.6)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "40px 16px", overflowY: "auto" }}>
      <div className="glass-card" onClick={e => e.stopPropagation()}
        style={{ width: "100%", maxWidth: "540px", background: "#fff", padding: "24px", position: "relative", display: "flex", flexDirection: "column", gap: "14px" }}>
        <button type="button" onClick={onClose} aria-label="ปิด" style={{ position: "absolute", top: 14, right: 14, background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}>
          <X size={20} />
        </button>
        <div style={{ paddingRight: "28px" }}>
          <h3 style={{ fontSize: "18px", color: "var(--text-primary)" }}>ซื้อคอร์ส</h3>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{course.title}</p>
          <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            {course.access_duration_days ? `เข้าเรียนได้ ${course.access_duration_days} วันนับจากวันที่ยืนยันการชำระเงิน` : "เข้าเรียนได้ตลอดชีพ"}
          </p>
        </div>

        {enrolled ? (
          <div style={{ ...box, borderColor: "var(--accent)", color: "var(--accent)", textAlign: "center" }}>
            <Check size={28} style={{ margin: "0 auto 6px" }} />
            <strong>เปิดสิทธิ์เข้าเรียนแล้ว</strong>
            <p style={{ color: "var(--text-secondary)", marginTop: "4px" }}>ใบเสร็จเลขที่ {order?.receipt_no}</p>
            <button type="button" className="tech-button-primary" onClick={onClose} style={{ width: "100%", marginTop: "12px" }}>เริ่มเรียน</button>
          </div>
        ) : order ? (
          <>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
              โอนเงินตามยอดด้านล่างแล้วแนบสลิป เจ้าหน้าที่จะตรวจสอบและเปิดสิทธิ์เข้าเรียน พร้อมส่งใบเสร็จทางอีเมล
            </p>
            {instructions && <TransferInstructions order={order} instructions={instructions} />}
            <SlipUpload order={order} onUploaded={setOrder} />
            {error && <p role="alert" style={{ color: "var(--danger)", fontSize: "12px" }}>{error}</p>}
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              {onShowPayments && (
                <button type="button" className="tech-button-outline" onClick={() => { onClose(); onShowPayments(); }} style={{ flex: 1 }}>การชำระเงินของฉัน</button>
              )}
              <button type="button" className="tech-button-outline" onClick={cancelOrder} style={{ flex: 1, color: "var(--danger)" }}>ยกเลิกคำสั่งซื้อ</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ ...box, display: "flex", justifyContent: "space-between" }}>
              <span>ราคาคอร์ส</span><strong>{baht(price)}</strong>
            </div>
            <div className="form-group">
              <label className="form-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}><Tag size={12} /> โค้ดส่วนลด</label>
              <div style={{ display: "flex", gap: "10px" }}>
                <input type="text" className="form-input" placeholder="เช่น EARLY10" value={code}
                  onChange={e => { setCode(e.target.value); setVoucher(null); }} style={{ textTransform: "uppercase" }} />
                <button type="button" onClick={applyVoucher} className="tech-button-outline" style={{ flexShrink: 0 }}>ใช้โค้ด</button>
              </div>
              {voucherError && <p style={{ color: "var(--danger)", fontSize: "12px", marginTop: "6px", display: "flex", gap: "4px", alignItems: "center" }}><AlertCircle size={12} /> {voucherError}</p>}
              {voucher && <p style={{ color: "var(--accent)", fontSize: "12px", marginTop: "6px", fontWeight: 600 }}>ใช้โค้ด {voucher.code} ลด {baht(voucher.discount_amount)}</p>}
            </div>
            <div style={{ ...box, display: "flex", justifyContent: "space-between", fontWeight: 800 }}>
              <span>ยอดที่ต้องชำระ</span><span style={{ color: "var(--primary)" }}>{baht(voucher ? voucher.final_price : price)}</span>
            </div>
            {vatRegistered && (voucher ? voucher.final_price : price) > 0 && (
              <div style={{ ...box }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontWeight: 600 }}>
                  <input type="checkbox" checked={wantTax} onChange={e => setWantTax(e.target.checked)} /> ต้องการใบกำกับภาษีเต็มรูป
                </label>
                {wantTax && <div style={{ marginTop: "10px" }}><TaxInvoiceFields value={buyer} onChange={setBuyer} /></div>}
              </div>
            )}
            <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>ชำระด้วยการโอนเงินผ่านธนาคารหรือพร้อมเพย์ ไม่มีการเก็บข้อมูลบัตร</p>
            {error && <p role="alert" style={{ color: "var(--danger)", fontSize: "12px" }}>{error}</p>}
            <button type="button" className="tech-button-primary" onClick={createOrder} disabled={busy || (wantTax && !buyerReady(buyer))} style={{ width: "100%" }}>
              {busy ? "กำลังสร้างคำสั่งซื้อ..." : voucher?.final_price === 0 ? "ลงทะเบียนเรียน" : "สร้างคำสั่งซื้อและดูวิธีโอนเงิน"}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};
