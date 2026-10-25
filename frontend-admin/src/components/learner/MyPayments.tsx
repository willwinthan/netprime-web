import React, { useEffect, useState } from "react";
import { FileText, Layers, Printer, Receipt, Route } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import {
  BankTransfer, BuyerTax, CourseOrder, EMPTY_BUYER, ORDER_KIND, ORDER_STATUS, OrderInstallment, SlipUpload, TaxInvoiceFields,
  TransferInstructions, baht, buyerReady, formatThaiDateTime
} from "./CourseOrder";
import { CreditNoteDocument, PrintPortal, ReceiptDocument, SellerProfile } from "./PrintView";
import { trackPaidOrders } from "../marketing/runtime";
import { ProductShelf } from "../commerce/ProductShelf";
import { LearningPaths } from "../commerce/LearningPaths";

type Printing = { kind: "receipt"; order: CourseOrder; installment?: OrderInstallment } | { kind: "credit"; order: CourseOrder };

const small: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", padding: "4px 10px" };

/**
 * "การชำระเงินของฉัน": order history (installments, slips, receipts / tax invoices / credit notes, tax
 * invoice requests), the package shelf (bundles, memberships, installment packages) and learning paths.
 */
export const MyPayments: React.FC<{ onOpenCourse?: (courseId: string) => void }> = ({ onOpenCourse }) => {
  const api = useApi();
  const [tab, setTab] = useState<"orders" | "packages" | "paths">("orders");
  const [pathId, setPathId] = useState<string | null>(null);
  const [orders, setOrders] = useState<CourseOrder[]>([]);
  const [instructions, setInstructions] = useState<BankTransfer | null>(null);
  const [seller, setSeller] = useState<SellerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState<Printing | null>(null);
  const [taxFor, setTaxFor] = useState<CourseOrder | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const res = await api.get<{ orders: CourseOrder[]; instructions: BankTransfer; seller?: SellerProfile }>("/student/orders");
      setOrders(res.orders);
      setInstructions(res.instructions);
      setSeller(res.seller ?? null);
      setError(null);
      trackPaidOrders(res.orders.map(o => ({ id: o.id, status: o.status, amount: o.amount, course_id: o.course_id ?? o.product_id ?? undefined,
        course_title: o.course_title, reference: o.reference }))).catch(() => undefined);
    } catch (err: any) {
      setError(err.message || "โหลดประวัติการชำระเงินไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (tab === "orders") load(); }, [api.token, tab]);

  const cancel = async (order: CourseOrder) => {
    if (!window.confirm(`ยกเลิกคำสั่งซื้อ ${order.reference}?`)) return;
    try {
      await api.post(`/student/orders/${order.id}/cancel`, {});
      await load();
    } catch (err: any) {
      setError(err.message || "ยกเลิกไม่สำเร็จ");
    }
  };

  const replace = (next: CourseOrder) => setOrders(list => list.map(o => (o.id === next.id ? next : o)));
  const tabs: [typeof tab, string, React.ReactNode][] = [["orders", "คำสั่งซื้อ", <Receipt size={14} />], ["packages", "แพ็กเกจและสมาชิก", <Layers size={14} />], ["paths", "เส้นทางการเรียน", <Route size={14} />]];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
        <Receipt size={20} color="var(--primary)" />
        <h2 style={{ fontSize: "20px", color: "var(--text-primary)", marginRight: "auto" }}>การชำระเงินของฉัน</h2>
        {tabs.map(([key, label, icon]) => (
          <button key={key} type="button" onClick={() => setTab(key)} className={tab === key ? "tech-button-primary" : "tech-button-outline"} style={{ ...small, fontSize: "13px", padding: "6px 12px" }}>
            {icon}{label}
          </button>
        ))}
      </div>
      {tab === "packages" && <ProductShelf onShowPayments={() => setTab("orders")} onOpenPath={id => { setPathId(id); setTab("paths"); }} />}
      {tab === "paths" && <LearningPaths initialPathId={pathId} onOpenCourse={onOpenCourse} onBuy={() => setTab("packages")} />}
      {tab === "orders" && (<>
      {error && <div className="glass-card" role="alert" style={{ color: "var(--danger)", marginBottom: "16px" }}>{error}</div>}
      {loading && orders.length === 0 ? (
        <div className="glass-card" style={{ textAlign: "center", color: "var(--text-secondary)" }}>กำลังโหลด...</div>
      ) : orders.length === 0 ? (
        <div className="glass-card" style={{ textAlign: "center", color: "var(--text-secondary)", padding: "40px" }}>
          ยังไม่มีคำสั่งซื้อ กดปุ่ม "ซื้อคอร์ส" ในหน้ารายละเอียดคอร์ส หรือเลือกแพ็กเกจในแท็บ "แพ็กเกจและสมาชิก"
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {orders.map(order => {
            const status = ORDER_STATUS[order.status];
            const installments = order.installments ?? [];
            const next = installments.find(i => i.status === "pending");
            const open = order.status === "pending" || order.status === "partial";
            return (
              <div key={order.id} className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
                  <div>
                    <h3 style={{ fontSize: "16px", color: "var(--text-primary)" }}>{order.course_title}</h3>
                    <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "monospace" }}>
                      {order.kind && order.kind !== "course" ? `${ORDER_KIND[order.kind]} · ` : ""}{order.reference}
                      {order.receipt_no ? ` · ใบเสร็จ ${order.receipt_no}` : ""}{order.tax_invoice_no ? ` · ใบกำกับภาษี ${order.tax_invoice_no}` : ""} · สั่งซื้อ {formatThaiDateTime(order.created_at)}
                    </p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ display: "inline-block", fontSize: "12px", fontWeight: 600, padding: "3px 10px", borderRadius: "99px", color: status.color, background: status.bg }}>
                      {status.label}
                    </span>
                    <div style={{ fontWeight: 800, marginTop: "4px" }}>{order.amount === 0 ? "ฟรี" : baht(order.amount)}</div>
                    {installments.length > 0 && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>ผ่อน {installments.length} งวด · ชำระแล้ว {baht(order.total_received ?? 0)}</div>}
                  </div>
                </div>
                {order.suspended_at && <p style={{ fontSize: "13px", color: "var(--danger)" }}>ระงับสิทธิ์เข้าเรียนชั่วคราวเพราะมีงวดเลยกำหนด สิทธิ์จะกลับมาเมื่อเจ้าหน้าที่ยืนยันการชำระ</p>}
                {order.staff_note && order.status !== "paid" && (
                  <p style={{ fontSize: "13px", color: "var(--danger)" }}>หมายเหตุจากเจ้าหน้าที่: {order.staff_note}</p>
                )}

                {installments.length > 0 && (
                  <div style={{ border: "1px solid var(--border-subtle)", borderRadius: "10px", overflow: "hidden" }}>
                    {installments.map(inst => (
                      <div key={inst.id} style={{ display: "flex", justifyContent: "space-between", gap: "10px", padding: "8px 12px", fontSize: "13px", flexWrap: "wrap",
                        borderTop: inst.seq > 1 ? "1px solid var(--border-subtle)" : undefined, background: inst.overdue ? "rgba(239,68,68,0.05)" : undefined }}>
                        <span>งวดที่ {inst.seq} · {baht(inst.amount)} · ครบกำหนด {formatThaiDateTime(inst.due_at)}{inst.overdue ? " (เลยกำหนด)" : ""}</span>
                        <span style={{ display: "inline-flex", gap: "8px", alignItems: "center" }}>
                          {inst.status === "paid" || inst.status === "refunded" ? (
                            <>
                              <span style={{ color: "var(--accent)" }}>{inst.status === "paid" ? "ชำระแล้ว" : "คืนเงินแล้ว"}</span>
                              {inst.receipt_no && <button type="button" className="tech-button-outline" style={small} onClick={() => setPrinting({ kind: "receipt", order, installment: inst })}><Printer size={12} />ใบเสร็จ</button>}
                            </>
                          ) : inst.status === "cancelled" ? <span style={{ color: "var(--text-muted)" }}>ยกเลิก</span>
                            : <span style={{ color: inst.has_slip ? "var(--primary)" : "var(--text-muted)" }}>{inst.has_slip ? "รอตรวจสลิป" : "รอชำระ"}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {open && instructions && (installments.length > 0 ? next && (
                  <>
                    <TransferInstructions order={order} instructions={instructions} amount={next.amount} label={`งวดที่ ${next.seq}`} dueAt={next.due_at} />
                    <SlipUpload order={order} installment={next} onUploaded={replace} />
                  </>
                ) : order.status === "pending" && (
                  <>
                    <TransferInstructions order={order} instructions={instructions} />
                    <SlipUpload order={order} onUploaded={replace} />
                  </>
                ))}
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  {order.status === "pending" && (
                    <button type="button" className="tech-button-outline" onClick={() => cancel(order)} style={{ color: "var(--danger)" }}>ยกเลิกคำสั่งซื้อ</button>
                  )}
                  {(order.status === "paid" || order.status === "refunded") && order.receipt_no && (
                    <button type="button" className="tech-button-outline" onClick={() => setPrinting({ kind: "receipt", order })} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <Printer size={14} /> {order.tax_invoice_no ? "พิมพ์ใบเสร็จ/ใบกำกับภาษี" : "พิมพ์ใบเสร็จ / บันทึกเป็น PDF"}
                    </button>
                  )}
                  {order.credit_note_no && (
                    <button type="button" className="tech-button-outline" onClick={() => setPrinting({ kind: "credit", order })} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <FileText size={14} /> ใบลดหนี้ {order.credit_note_no}
                    </button>
                  )}
                  {order.amount > 0 && !order.tax_invoice_no && ["pending", "partial", "paid"].includes(order.status) && (
                    <button type="button" className="tech-button-outline" onClick={() => setTaxFor(order)} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <FileText size={14} /> {order.tax_invoice_requested ? "แก้ข้อมูลใบกำกับภาษี" : "ขอใบกำกับภาษีเต็มรูป"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      </>)}
      {taxFor && <TaxRequestDialog order={taxFor} vatRegistered={!!seller?.vat_registered} onClose={() => setTaxFor(null)} onSaved={o => { replace(o); setTaxFor(null); }} />}
      {printing?.kind === "receipt" && (printing.installment?.receipt_no || printing.order.receipt_no) && (
        <PrintPortal orientation="portrait" onDone={() => setPrinting(null)}>
          <ReceiptDocument seller={seller} order={{ ...printing.order, receipt_no: printing.order.receipt_no ?? "" }}
            installment={printing.installment ? { ...printing.installment, receipt_no: printing.installment.receipt_no! } : null} />
        </PrintPortal>
      )}
      {printing?.kind === "credit" && printing.order.credit_note_no && (
        <PrintPortal orientation="portrait" onDone={() => setPrinting(null)}>
          <CreditNoteDocument seller={seller} order={{ ...printing.order, receipt_no: printing.order.receipt_no ?? "", credit_note_no: printing.order.credit_note_no,
            credit_note_at: printing.order.credit_note_at ?? null, credit_note_amount: printing.order.credit_note_amount ?? null,
            installments: (printing.order.installments ?? []).filter(i => i.receipt_no).map(i => ({ ...i, receipt_no: i.receipt_no! })) }} />
        </PrintPortal>
      )}
    </div>
  );
};

const TaxRequestDialog: React.FC<{ order: CourseOrder; vatRegistered: boolean; onClose: () => void; onSaved: (o: CourseOrder) => void }> = ({ order, vatRegistered, onClose, onSaved }) => {
  const api = useApi();
  const [buyer, setBuyer] = useState<BuyerTax>(order.tax_invoice_requested
    ? { buyer_name: order.buyer_name ?? "", buyer_tax_id: order.buyer_tax_id ?? "", buyer_branch: order.buyer_branch ?? "สำนักงานใหญ่", buyer_address: order.buyer_address ?? "" }
    : EMPTY_BUYER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (request: boolean) => {
    try {
      setBusy(true);
      setError(null);
      const res = await api.request<{ order: CourseOrder }>(`/student/orders/${order.id}/tax-invoice`, { method: "PUT", body: JSON.stringify(request ? buyer : { request: false }) });
      onSaved(res.order);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="ขอใบกำกับภาษี" onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.6)", zIndex: 9999, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "60px 16px" }}>
      <div className="glass-card" onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: "520px", background: "#fff", display: "flex", flexDirection: "column", gap: "12px" }}>
        <h3 style={{ fontSize: "17px" }}>ใบกำกับภาษีเต็มรูป · {order.reference}</h3>
        {!vatRegistered && <p style={{ fontSize: "13px", color: "var(--warning)" }}>ขณะนี้โรงเรียนยังไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม ระบบจะบันทึกคำขอไว้และออกใบกำกับภาษีเมื่อเปิดใช้</p>}
        <TaxInvoiceFields value={buyer} onChange={setBuyer} />
        <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>{order.status === "paid" ? "ออกเลขใบกำกับภาษีทันทีเมื่อบันทึก และแก้ไขภายหลังไม่ได้" : "ออกใบกำกับภาษีพร้อมใบเสร็จเมื่อเจ้าหน้าที่ยืนยันการชำระ"}</p>
        {error && <p role="alert" style={{ color: "var(--danger)", fontSize: "13px" }}>{error}</p>}
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" }}>
          {!!order.tax_invoice_requested && <button type="button" className="tech-button-outline" onClick={() => save(false)} disabled={busy}>ไม่ต้องการแล้ว</button>}
          <button type="button" className="tech-button-outline" onClick={onClose}>ปิด</button>
          <button type="button" className="tech-button-primary" onClick={() => save(true)} disabled={busy || !buyerReady(buyer)}>{busy ? "กำลังบันทึก…" : "บันทึก"}</button>
        </div>
      </div>
    </div>
  );
};
