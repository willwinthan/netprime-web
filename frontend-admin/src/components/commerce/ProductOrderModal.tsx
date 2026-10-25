import { createPortal } from "react-dom";
import React, { useEffect, useState } from "react";
import { Check, Layers, Tag, X } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import {
  BankTransfer, BuyerTax, CourseOrder, EMPTY_BUYER, SlipUpload, TaxInvoiceFields, TransferInstructions, baht, buyerReady, formatThaiDateTime
} from "../learner/CourseOrder";
import { Product } from "./types";

const box: React.CSSProperties = { border: "1px solid var(--border-subtle)", borderRadius: "12px", padding: "14px 16px", fontSize: "13px" };

/**
 * Buy a product (bundle / learning path / membership / course package): optional installments,
 * store-wide voucher and full tax invoice; then transfer details and slip upload (first installment).
 */
export const ProductOrderModal: React.FC<{ product: Product; onClose: () => void; onDone?: () => void; onShowPayments?: () => void }> = ({ product, onClose, onDone, onShowPayments }) => {
  const api = useApi();
  const [installments, setInstallments] = useState(1);
  const [code, setCode] = useState("");
  const [wantTax, setWantTax] = useState(false);
  const [buyer, setBuyer] = useState<BuyerTax>(EMPTY_BUYER);
  const [order, setOrder] = useState<CourseOrder | null>(null);
  const [instructions, setInstructions] = useState<BankTransfer | null>(null);
  // A full tax invoice only exists when the school is VAT-registered (tax profile in OrdersPage).
  const [vatRegistered, setVatRegistered] = useState(false);
  useEffect(() => {
    api.get<{ seller?: { vat_registered?: boolean } }>("/student/payment-instructions")
      .then(res => setVatRegistered(!!res.seller?.vat_registered)).catch(() => undefined);
  }, []);
  const [enrolled, setEnrolled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ orders: CourseOrder[]; instructions: BankTransfer }>("/student/orders").then(res => {
      setInstructions(res.instructions);
      const open = res.orders.find(o => o.product_id === product.id && (o.status === "pending" || o.status === "partial"));
      if (open) setOrder(open);
    }).catch(() => undefined);
  }, [product.id]);

  const create = async () => {
    try {
      setBusy(true);
      setError(null);
      const res = await api.post<{ order: CourseOrder; enrolled: boolean; instructions?: BankTransfer }>("/student/orders", {
        product_id: product.id, installments, voucher_code: code.trim() || undefined, tax_invoice: wantTax ? buyer : undefined
      });
      setOrder(res.order);
      if (res.instructions) setInstructions(res.instructions);
      if (res.enrolled) { setEnrolled(true); onDone?.(); }
    } catch (err: any) {
      setError(err.message || "สร้างคำสั่งซื้อไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const nextInstallment = order?.installments?.find(i => i.status === "pending");
  const per = Math.floor(product.price / installments);
  const isRenewal = product.kind === "membership" && product.membership?.status === "active";

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`ซื้อ ${product.title}`} onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.6)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "40px 16px", overflowY: "auto" }}>
      <div className="glass-card" onClick={e => e.stopPropagation()}
        style={{ width: "100%", maxWidth: "560px", background: "#fff", padding: "24px", position: "relative", display: "flex", flexDirection: "column", gap: "14px" }}>
        <button type="button" onClick={onClose} aria-label="ปิด" style={{ position: "absolute", top: 14, right: 14, background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}>
          <X size={20} />
        </button>
        <div style={{ paddingRight: "28px" }}>
          <h3 style={{ fontSize: "18px", color: "var(--text-primary)", display: "flex", gap: "8px", alignItems: "center" }}><Layers size={18} color="var(--primary)" />{isRenewal ? "ต่ออายุสมาชิก" : "ซื้อแพ็กเกจ"}</h3>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{product.title}</p>
          <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            {product.kind === "membership"
              ? `เข้าเรียน${product.all_courses ? "ทุกคอร์สที่เปิดสอน" : ` ${product.course_count} คอร์ส`} นาน ${product.access_days} วัน${isRenewal ? ` ต่อจากวันหมดอายุเดิม (${formatThaiDateTime(product.membership!.expires_at)})` : ""}`
              : product.access_days ? `เข้าเรียนได้ ${product.access_days} วันนับจากวันที่ยืนยันการชำระเงิน` : "เข้าเรียนได้ตลอดชีพ"}
          </p>
        </div>

        {product.courses.length > 0 && (
          <div style={box}>
            {product.courses.map((c, i) => (
              <div key={c.course_id} style={{ display: "flex", justifyContent: "space-between", gap: "8px", padding: "3px 0" }}>
                <span>{product.is_path ? `${i + 1}. ` : "• "}{c.title}</span><span style={{ color: "var(--text-muted)" }}>{baht(c.price)}</span>
              </div>
            ))}
            {product.savings > 0 && <p style={{ color: "var(--accent)", fontWeight: 700, marginTop: "6px" }}>ประหยัด {baht(product.savings)} จากการซื้อแยก ({baht(product.separate_price)})</p>}
          </div>
        )}

        {enrolled ? (
          <div style={{ ...box, borderColor: "var(--accent)", color: "var(--accent)", textAlign: "center" }}>
            <Check size={28} style={{ margin: "0 auto 6px" }} />
            <strong>เปิดสิทธิ์เข้าเรียนแล้ว</strong>
            <button type="button" className="tech-button-primary" onClick={onClose} style={{ width: "100%", marginTop: "12px" }}>เริ่มเรียน</button>
          </div>
        ) : order ? (
          <>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
              คำสั่งซื้อ {order.reference}{order.installment_count && order.installment_count > 1 ? ` ผ่อน ${order.installment_count} งวด` : ""} โอนเงินแล้วแนบสลิป เจ้าหน้าที่จะตรวจสอบและเปิดสิทธิ์ให้
            </p>
            {instructions && (nextInstallment
              ? <TransferInstructions order={order} instructions={instructions} amount={nextInstallment.amount} label={`งวดที่ ${nextInstallment.seq}`} dueAt={nextInstallment.due_at} />
              : <TransferInstructions order={order} instructions={instructions} />)}
            {nextInstallment ? <SlipUpload order={order} installment={nextInstallment} onUploaded={setOrder} />
              : order.status === "pending" ? <SlipUpload order={order} onUploaded={setOrder} /> : null}
            {onShowPayments && (
              <button type="button" className="tech-button-outline" onClick={() => { onClose(); onShowPayments(); }}>ดูทุกงวดและใบเสร็จในการชำระเงินของฉัน</button>
            )}
          </>
        ) : (
          <>
            {product.max_installments > 1 && (
              <div className="form-group">
                <label className="form-label">วิธีชำระ</label>
                <select className="form-input" value={installments} onChange={e => setInstallments(Number(e.target.value))}>
                  <option value={1}>ชำระเต็มจำนวน {baht(product.price)}</option>
                  {Array.from({ length: product.max_installments - 1 }, (_, i) => i + 2).map(n => (
                    <option key={n} value={n}>ผ่อน {n} งวด ทุก {product.installment_interval_days} วัน (งวดละประมาณ {baht(Math.floor(product.price / n))})</option>
                  ))}
                </select>
                {installments > 1 && (
                  <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "6px" }}>
                    {product.installment_access === "first" ? "เข้าเรียนได้หลังยืนยันงวดแรก" : "เข้าเรียนได้เมื่อชำระครบทุกงวด"}
                    {` · ค้างชำระเกิน ${product.overdue_grace_days} วันหลังครบกำหนด ระบบจะระงับสิทธิ์ชั่วคราวจนกว่าจะชำระ`}
                    {` · งวดแรก ${baht(product.price - per * (installments - 1))}`}
                  </p>
                )}
              </div>
            )}
            <div className="form-group">
              <label className="form-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}><Tag size={12} /> โค้ดส่วนลด (ถ้ามี)</label>
              <input type="text" className="form-input" placeholder="โค้ดที่ใช้ได้ทุกรายการ" value={code} onChange={e => setCode(e.target.value)} style={{ textTransform: "uppercase" }} />
            </div>
            {vatRegistered && product.price > 0 && (
              <div style={box}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontWeight: 600 }}>
                  <input type="checkbox" checked={wantTax} onChange={e => setWantTax(e.target.checked)} /> ต้องการใบกำกับภาษีเต็มรูป
                </label>
                {wantTax && <div style={{ marginTop: "10px" }}><TaxInvoiceFields value={buyer} onChange={setBuyer} /></div>}
              </div>
            )}
            <div style={{ ...box, display: "flex", justifyContent: "space-between", fontWeight: 800 }}>
              <span>ราคา (รวมภาษีมูลค่าเพิ่มแล้ว ถ้ามี)</span><span style={{ color: "var(--primary)" }}>{baht(product.price)}</span>
            </div>
            {error && <p role="alert" style={{ color: "var(--danger)", fontSize: "12px" }}>{error}</p>}
            <button type="button" className="tech-button-primary" onClick={create} disabled={busy || (wantTax && !buyerReady(buyer))} style={{ width: "100%" }}>
              {busy ? "กำลังสร้างคำสั่งซื้อ..." : "สร้างคำสั่งซื้อและดูวิธีโอนเงิน"}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};

export default ProductOrderModal;
