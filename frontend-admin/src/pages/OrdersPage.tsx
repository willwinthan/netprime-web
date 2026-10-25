import React, { useEffect, useState } from "react";
import { Banknote, Check, FileImage, FileText, Landmark, Printer, RefreshCw, Search, Settings, Undo2, X } from "lucide-react";
import { API_BASE_URL, can, useApi } from "../hooks/useApi";
import { Chip, Modal, Field, ErrorBox, Empty, grid2, tableStyle, thStyle, tdStyle, formatDateTime } from "../components/site-admin/ui";
import {
  BankTransfer, BuyerTax, CourseOrder, EMPTY_BUYER, ORDER_KIND, ORDER_STATUS, OrderInstallment, TaxInvoiceFields, baht, buyerReady
} from "../components/learner/CourseOrder";
import { CreditNoteDocument, PrintPortal, ReceiptDocument, SellerProfile } from "../components/learner/PrintView";
import { TaxProfileDialog } from "../components/commerce/TaxProfileDialog";
import { SalesReports } from "../components/commerce/SalesReports";
import { ProductsManager } from "../components/commerce/ProductsManager";
import { QuotesManager } from "../components/commerce/QuotesManager";

type Api = ReturnType<typeof useApi>;
type StaffOrder = CourseOrder & { user_id: string; confirmed_by_name: string | null };
type ActionKind = "confirm" | "reject" | "refund";
type Printing = { kind: "receipt"; order: StaffOrder; installment?: OrderInstallment } | { kind: "credit"; order: StaffOrder };

const TABS = [["pending", "รอตรวจสอบ"], ["partial", "ผ่อนชำระอยู่"], ["paid", "ชำระแล้ว"], ["all", "ทั้งหมด"]] as const;
const SECTIONS = [["orders", "คำสั่งซื้อ", ["payments.manage"]], ["reports", "รายงานยอดขาย", ["payments.manage", "commerce.manage"]],
  ["products", "แพ็กเกจและชุดคอร์ส", ["commerce.manage"]], ["quotes", "ใบเสนอราคาองค์กร", ["commerce.manage"]]] as const;

/**
 * Course orders paid by bank transfer (payments.manage): check slips, confirm, reject, refund,
 * and edit the transfer instructions learners see.
 */
export const OrdersPage: React.FC = () => {
  const api = useApi();
  const sections = SECTIONS.filter(([, , perms]) => can(api.user, ...perms));
  const [section, setSection] = useState<typeof SECTIONS[number][0]>("orders");
  const [kind, setKind] = useState("all");
  const [seller, setSeller] = useState<SellerProfile | null>(null);
  const [printing, setPrinting] = useState<Printing | null>(null);
  const [taxOf, setTaxOf] = useState<StaffOrder | null>(null);
  const [showTax, setShowTax] = useState(false);
  const [installmentAction, setInstallmentAction] = useState<{ order: StaffOrder; installment: OrderInstallment } | null>(null);
  const [slipSeq, setSlipSeq] = useState<number | undefined>(undefined);
  const [tab, setTab] = useState<typeof TABS[number][0]>("pending");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slipOf, setSlipOf] = useState<StaffOrder | null>(null);
  const [action, setAction] = useState<{ kind: ActionKind; order: StaffOrder } | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.get<{ orders: StaffOrder[]; counts: Record<string, number> }>(
        `/manage/orders?status=${tab}&kind=${kind}${search ? `&q=${encodeURIComponent(search)}` : ""}`);
      setOrders(data.orders);
      setCounts(data.counts);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (section === "orders") load(); }, [tab, kind, search, api.token, section]);
  useEffect(() => { api.get<{ profile: SellerProfile }>("/manage/tax-profile").then(d => setSeller(d.profile)).catch(() => undefined); }, [api.token, showTax]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <h1 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "10px" }}><Banknote size={24} color="var(--primary)" />คำสั่งซื้อคอร์ส</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>ตรวจสลิปโอนเงิน ยืนยันการชำระ (ทั้งก้อนหรือทีละงวด) เพื่อเปิดสิทธิ์เข้าเรียน ออกใบเสร็จ/ใบกำกับภาษี และดูรายงานยอดขาย</p>
      </div>
      {sections.length > 1 && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "10px" }}>
          {sections.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setSection(key)} className={section === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "6px 14px", fontSize: "13px" }}>{label}</button>
          ))}
        </div>
      )}
      {section === "reports" && <SalesReports />}
      {section === "products" && <ProductsManager />}
      {section === "quotes" && <QuotesManager />}
      {section === "orders" && (<>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {TABS.map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} className={tab === key ? "tech-button-primary" : "tech-button-outline"}
              style={{ padding: "6px 14px", fontSize: "13px" }}>
              {label}{(key === "pending" || key === "partial") && counts[key] ? ` (${counts[key]})` : ""}
            </button>
          ))}
          <select className="form-input" value={kind} onChange={e => setKind(e.target.value)} style={{ width: "auto", padding: "6px 10px", fontSize: "13px" }} aria-label="ประเภทคำสั่งซื้อ">
            <option value="all">ทุกประเภท</option>
            {Object.entries(ORDER_KIND).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
        <form onSubmit={e => { e.preventDefault(); setSearch(query.trim()); }} style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <input className="form-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="เลขคำสั่งซื้อ / ใบเสร็จ / อีเมล / ชื่อ"
            style={{ minWidth: "240px" }} aria-label="ค้นหาคำสั่งซื้อ" />
          <button type="submit" className="tech-button-outline" style={{ padding: "8px 14px" }} aria-label="ค้นหา"><Search size={16} /></button>
          <button type="button" className="tech-button-outline" onClick={load} style={{ padding: "8px 14px" }} aria-label="รีเฟรช"><RefreshCw size={16} /></button>
          <button type="button" className="tech-button-outline" onClick={() => setShowSettings(true)}><Settings size={16} />บัญชีรับโอน</button>
          <button type="button" className="tech-button-outline" onClick={() => setShowTax(true)}><Landmark size={16} />ข้อมูลภาษี{seller?.vat_registered ? " (VAT 7%)" : ""}</button>
        </form>
      </div>

      <ErrorBox message={error} />

      <div className="glass-card" style={{ padding: "8px", overflowX: "auto" }}>
        {loading ? <Empty text="กำลังโหลด…" /> : orders.length === 0 ? (
          <Empty text={tab === "pending" ? "ไม่มีคำสั่งซื้อที่รอตรวจสอบ" : "ไม่พบคำสั่งซื้อ"} />
        ) : (
          <table style={tableStyle}>
            <thead><tr>
              <th style={thStyle}>คำสั่งซื้อ</th><th style={thStyle}>ผู้เรียน</th><th style={thStyle}>คอร์ส</th>
              <th style={thStyle}>ยอด</th><th style={thStyle}>สลิป</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th>
            </tr></thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.id}>
                  <td style={tdStyle}>
                    <div style={{ fontFamily: "monospace", fontWeight: 700 }}>{o.reference}</div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{formatDateTime(o.created_at)}</div>
                    {o.receipt_no && <div style={{ fontSize: "12px", fontFamily: "monospace" }}>{o.receipt_no}</div>}
                  </td>
                  <td style={tdStyle}>{o.user_name}<div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{o.user_email}</div></td>
                  <td style={tdStyle}>
                    {o.course_title}
                    {o.kind && o.kind !== "course" && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{ORDER_KIND[o.kind]}{o.partner_name ? ` · ${o.partner_name}` : ""}{o.seats ? ` · ${o.seats} ที่นั่ง` : ""}</div>}
                    {o.tax_invoice_requested ? <div style={{ fontSize: "12px", color: "var(--primary)" }}>ขอใบกำกับภาษี: {o.buyer_name}{o.tax_invoice_no ? ` · ${o.tax_invoice_no}` : ""}</div> : null}
                    {o.credit_note_no && <div style={{ fontSize: "12px", color: "var(--danger)" }}>ใบลดหนี้ {o.credit_note_no}</div>}
                    {(o.installments ?? []).length > 0 && (
                      <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "4px" }}>
                        {o.installments!.map(inst => (
                          <div key={inst.id} style={{ fontSize: "12px", display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", color: inst.overdue ? "var(--danger)" : undefined }}>
                            <span>งวด {inst.seq}: {baht(inst.amount)} · {formatDateTime(inst.due_at)}</span>
                            {inst.status === "paid" ? <span style={{ color: "var(--accent)" }}>✓ {inst.receipt_no}</span> : inst.status !== "pending" ? <span>{inst.status === "refunded" ? "คืนเงิน" : "ยกเลิก"}</span> : (<>
                              {inst.has_slip && <button type="button" className="tech-button-outline" onClick={() => { setSlipSeq(inst.seq); setSlipOf(o); }} style={{ padding: "2px 6px", fontSize: "11px" }}>สลิป</button>}
                              {["pending", "partial", "expired"].includes(o.status) && <button type="button" className="tech-button-primary" onClick={() => setInstallmentAction({ order: o, installment: inst })} style={{ padding: "2px 6px", fontSize: "11px" }}>ยืนยันงวด</button>}
                            </>)}
                            {inst.receipt_no && <button type="button" className="tech-button-outline" onClick={() => setPrinting({ kind: "receipt", order: o, installment: inst })} style={{ padding: "2px 6px", fontSize: "11px" }} aria-label="พิมพ์ใบเสร็จงวด"><Printer size={11} /></button>}
                          </div>
                        ))}
                        {o.suspended_at && <span style={{ fontSize: "12px", color: "var(--danger)" }}>ระงับสิทธิ์ (ค้างชำระ)</span>}
                      </div>
                    )}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    {baht(o.amount)}
                    {o.voucher_code && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>โค้ด {o.voucher_code} (ปกติ {baht(o.list_price)})</div>}
                    {o.amount_received !== null && o.status !== "pending" && <div style={{ fontSize: "12px", color: "var(--accent)" }}>รับจริง {baht(o.amount_received)}</div>}
                  </td>
                  <td style={tdStyle}>
                    {o.has_slip && !(o.installments ?? []).length ? (
                      <button className="tech-button-outline" onClick={() => { setSlipSeq(undefined); setSlipOf(o); }} style={{ padding: "4px 10px", fontSize: "12px" }}>
                        <FileImage size={14} />ดูสลิป
                      </button>
                    ) : <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{(o.installments ?? []).length ? "ดูที่งวด" : "ยังไม่แนบ"}</span>}
                  </td>
                  <td style={tdStyle}>
                    <Chip {...ORDER_STATUS[o.status]} />
                    {o.status === "pending" && <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>ภายใน {formatDateTime(o.expires_at)}</div>}
                    {o.voucher_note && <div style={{ fontSize: "12px", color: "var(--warning)", marginTop: "4px" }}>{o.voucher_note}</div>}
                    {o.staff_note && <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>{o.staff_note}</div>}
                    {o.confirmed_by_name && o.status === "paid" && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>โดย {o.confirmed_by_name}</div>}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    {(o.status === "pending" || o.status === "expired") && (
                      <div style={{ display: "flex", gap: "6px" }}>
                        {!(o.installments ?? []).length && <button className="tech-button-primary" onClick={() => setAction({ kind: "confirm", order: o })} style={{ padding: "4px 10px", fontSize: "12px" }}><Check size={14} />ยืนยัน</button>}
                        <button className="tech-button-outline" onClick={() => setAction({ kind: "reject", order: o })} style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }}><X size={14} />ปฏิเสธ</button>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px" }}>
                      {(o.status === "paid" || o.status === "partial") && (
                        <button className="tech-button-outline" onClick={() => setAction({ kind: "refund", order: o })} style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }}><Undo2 size={14} />คืนเงิน/ยกเลิก</button>
                      )}
                      {o.receipt_no && <button className="tech-button-outline" onClick={() => setPrinting({ kind: "receipt", order: o })} style={{ padding: "4px 10px", fontSize: "12px" }} aria-label="พิมพ์ใบเสร็จ"><Printer size={14} /></button>}
                      {o.credit_note_no && <button className="tech-button-outline" onClick={() => setPrinting({ kind: "credit", order: o })} style={{ padding: "4px 10px", fontSize: "12px" }} aria-label="พิมพ์ใบลดหนี้"><FileText size={14} />ลดหนี้</button>}
                      {o.amount > 0 && !o.tax_invoice_no && ["pending", "partial", "paid", "expired"].includes(o.status) && (
                        <button className="tech-button-outline" onClick={() => setTaxOf(o)} style={{ padding: "4px 10px", fontSize: "12px" }}>ใบกำกับภาษี</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      </>)}
      {slipOf && <SlipPreview api={api} order={slipOf} seq={slipSeq} onClose={() => setSlipOf(null)} />}
      {installmentAction && <InstallmentConfirmDialog api={api} {...installmentAction} onClose={() => setInstallmentAction(null)} onDone={() => { setInstallmentAction(null); load(); }} />}
      {taxOf && <StaffTaxDialog api={api} order={taxOf} onClose={() => setTaxOf(null)} onDone={() => { setTaxOf(null); load(); }} />}
      {showTax && <TaxProfileDialog onClose={() => setShowTax(false)} />}
      {printing?.kind === "receipt" && (
        <PrintPortal orientation="portrait" onDone={() => setPrinting(null)}>
          <ReceiptDocument seller={seller} order={{ ...printing.order, receipt_no: printing.order.receipt_no ?? "" }}
            installment={printing.installment ? { ...printing.installment, receipt_no: printing.installment.receipt_no ?? "" } : null} />
        </PrintPortal>
      )}
      {printing?.kind === "credit" && printing.order.credit_note_no && (
        <PrintPortal orientation="portrait" onDone={() => setPrinting(null)}>
          <CreditNoteDocument seller={seller} order={{ ...printing.order, receipt_no: printing.order.receipt_no ?? "", credit_note_no: printing.order.credit_note_no,
            credit_note_at: printing.order.credit_note_at ?? null, credit_note_amount: printing.order.credit_note_amount ?? null,
            installments: (printing.order.installments ?? []).filter(i => i.receipt_no).map(i => ({ ...i, receipt_no: i.receipt_no! })) }} />
        </PrintPortal>
      )}
      {action && <OrderActionDialog api={api} kind={action.kind} order={action.order} onClose={() => setAction(null)} onDone={() => { setAction(null); load(); }} />}
      {showSettings && <PaymentSettingsDialog api={api} onClose={() => setShowSettings(false)} />}
    </div>
  );
};

// ==========================================
// Slip preview (fetched with the token; never a public URL)
// ==========================================

const SlipPreview: React.FC<{ api: Api; order: StaffOrder; seq?: number; onClose: () => void }> = ({ api, order, seq, onClose }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    fetch(`${API_BASE_URL}/orders/${order.id}${seq ? `/installments/${seq}` : ""}/slip`, { headers: api.token ? { Authorization: `Bearer ${api.token}` } : {} })
      .then(async res => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "โหลดสลิปไม่สำเร็จ");
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        setType(blob.type);
        setUrl(objectUrl);
      })
      .catch(err => setError(err.message));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [order.id, seq]);

  return (
    <Modal title={`สลิป ${order.reference}${seq ? ` งวดที่ ${seq}` : ""}`} onClose={onClose} width={720}>
      <ErrorBox message={error} />
      <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "12px" }}>
        {order.user_name} · ยอดที่ต้องโอน {baht(order.amount)} · แนบเมื่อ {formatDateTime(order.slip_uploaded_at)}
      </p>
      {!url && !error && <Empty text="กำลังโหลด…" />}
      {url && (type === "application/pdf"
        ? <iframe title="สลิป PDF" src={url} style={{ width: "100%", height: "70vh", border: "1px solid var(--border-subtle)", borderRadius: "8px" }} />
        : <img src={url} alt={`สลิปของ ${order.reference}`} style={{ maxWidth: "100%", maxHeight: "70vh", display: "block", margin: "0 auto", borderRadius: "8px" }} />)}
    </Modal>
  );
};

// ==========================================
// Confirm / reject / refund
// ==========================================

const OrderActionDialog: React.FC<{ api: Api; kind: "confirm" | "reject" | "refund"; order: StaffOrder; onClose: () => void; onDone: () => void }> = ({ api, kind, order, onClose, onDone }) => {
  const [amount, setAmount] = useState(String(order.amount));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titles = { confirm: "ยืนยันการชำระเงิน", reject: "ปฏิเสธคำสั่งซื้อ", refund: "คืนเงิน/ยกเลิกคำสั่งซื้อ" };
  const received = Number(amount);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      await api.post(`/manage/orders/${order.id}/${kind}`, kind === "confirm" ? { amount_received: received, note } : { note });
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${titles[kind]} ${order.reference}`} onClose={onClose} width={520}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <ErrorBox message={error} />
        <p style={{ fontSize: "14px", color: "var(--text-secondary)" }}>
          {order.user_name} ({order.user_email}) · {order.course_title} · ยอด {baht(order.amount)}
        </p>
        {kind === "confirm" && (
          <>
            <Field label="ยอดเงินที่ได้รับจริง (บาท)" hint="ตรวจกับรายการเงินเข้าในบัญชีก่อนยืนยัน">
              <input className="form-input" type="number" min={0} step="0.01" required value={amount} onChange={e => setAmount(e.target.value)} />
            </Field>
            {Number.isFinite(received) && received !== order.amount && (
              <p style={{ color: "var(--warning)", fontSize: "13px" }}>ยอดที่ได้รับไม่ตรงกับยอดคำสั่งซื้อ ({baht(order.amount)})</p>
            )}
            {!order.has_slip && <p style={{ color: "var(--warning)", fontSize: "13px" }}>คำสั่งซื้อนี้ยังไม่มีสลิป</p>}
            <Field label="หมายเหตุ (ไม่บังคับ)">
              <input className="form-input" value={note} onChange={e => setNote(e.target.value)} maxLength={500} />
            </Field>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>เมื่อยืนยัน ระบบจะเปิดสิทธิ์เข้าเรียน ออกเลขใบเสร็จ และส่งอีเมลใบเสร็จให้ผู้เรียน</p>
          </>
        )}
        {kind !== "confirm" && (
          <Field label={kind === "reject" ? "เหตุผล (ผู้เรียนจะเห็นข้อความนี้)" : "เหตุผลการคืนเงิน/ยกเลิก"}>
            <textarea className="form-input" rows={3} required value={note} onChange={e => setNote(e.target.value)} maxLength={500} />
          </Field>
        )}
        {kind === "refund" && (
          <p style={{ color: "var(--danger)", fontSize: "13px" }}>
            {order.kind === "organization"
              ? "คำสั่งซื้อองค์กร: ระบบไม่ลดที่นั่งหรือยกเลิกคอร์สที่สนับสนุนให้อัตโนมัติ กรุณาปรับในหน้าองค์กร "
              : order.kind === "membership" ? "ระยะเวลาสมาชิกจะถูกหักออกตามคำสั่งซื้อนี้ หากไม่เหลือสิทธิ์จะระงับการเข้าเรียน "
              : "สิทธิ์เข้าเรียนจากคำสั่งซื้อนี้จะถูกระงับทันที (ยกเว้นคอร์สที่ผู้เรียนซื้อไว้จากคำสั่งซื้ออื่น) "}
            {order.tax_invoice_no || (order.installments ?? []).some(i => i.tax_invoice_no) ? "ระบบจะออกใบลดหนี้ให้อัตโนมัติ " : ""}การโอนเงินคืนต้องทำนอกระบบ
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : titles[kind]}</button>
        </div>
      </form>
    </Modal>
  );
};

// ==========================================
// Installment confirmation and staff tax invoice details
// ==========================================

const InstallmentConfirmDialog: React.FC<{ api: Api; order: StaffOrder; installment: OrderInstallment; onClose: () => void; onDone: () => void }> = ({ api, order, installment, onClose, onDone }) => {
  const [amount, setAmount] = useState(String(installment.amount));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      await api.post(`/manage/orders/${order.id}/installments/${installment.seq}/confirm`, { amount_received: Number(amount), note });
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`ยืนยันงวดที่ ${installment.seq}/${order.installment_count} · ${order.reference}`} onClose={onClose} width={520}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <ErrorBox message={error} />
        <p style={{ fontSize: "14px", color: "var(--text-secondary)" }}>{order.user_name} · {order.course_title} · งวดนี้ {baht(installment.amount)}</p>
        <Field label="ยอดเงินที่ได้รับจริง (บาท)"><input className="form-input" type="number" min={0} step="0.01" required value={amount} onChange={e => setAmount(e.target.value)} /></Field>
        {!installment.has_slip && <p style={{ color: "var(--warning)", fontSize: "13px" }}>งวดนี้ยังไม่มีสลิป</p>}
        <Field label="หมายเหตุ (ไม่บังคับ)"><input className="form-input" value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></Field>
        <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>ระบบจะออกใบเสร็จของงวดนี้ และเปิดสิทธิ์เข้าเรียนตามเงื่อนไขของแพ็กเกจ (หลังงวดแรกหรือเมื่อครบทุกงวด) หากถูกระงับเพราะค้างชำระจะเปิดสิทธิ์คืนให้</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : "ยืนยันงวดนี้"}</button>
        </div>
      </form>
    </Modal>
  );
};

const StaffTaxDialog: React.FC<{ api: Api; order: StaffOrder; onClose: () => void; onDone: () => void }> = ({ api, order, onClose, onDone }) => {
  const [buyer, setBuyer] = useState<BuyerTax>(order.tax_invoice_requested
    ? { buyer_name: order.buyer_name ?? "", buyer_tax_id: order.buyer_tax_id ?? "", buyer_branch: order.buyer_branch ?? "สำนักงานใหญ่", buyer_address: order.buyer_address ?? "" }
    : { ...EMPTY_BUYER, buyer_name: order.partner_name ?? order.user_name });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      setBusy(true);
      setError(null);
      await api.request(`/manage/orders/${order.id}/tax-invoice`, { method: "PUT", body: JSON.stringify(buyer) });
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`ข้อมูลใบกำกับภาษี · ${order.reference}`} onClose={onClose} width={560}>
      <ErrorBox message={error} />
      <TaxInvoiceFields value={buyer} onChange={setBuyer} />
      <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: "12px 0" }}>
        {order.status === "paid" || order.status === "partial" ? "คำสั่งซื้อที่ชำระแล้วจะได้เลขที่ใบกำกับภาษีทันทีเมื่อบันทึก (ถ้าโรงเรียนจดทะเบียน VAT)" : "ออกใบกำกับภาษีพร้อมใบเสร็จเมื่อยืนยันการชำระ"}
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="tech-button-primary" onClick={save} disabled={busy || !buyerReady(buyer)}>{busy ? "กำลังบันทึก…" : "บันทึก"}</button>
      </div>
    </Modal>
  );
};

// ==========================================
// Bank-transfer instructions
// ==========================================

const PaymentSettingsDialog: React.FC<{ api: Api; onClose: () => void }> = ({ api, onClose }) => {
  const [values, setValues] = useState<BankTransfer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<{ instructions: BankTransfer }>("/manage/payment-settings").then(d => setValues(d.instructions)).catch(err => setError(err.message));
  }, []);

  const set = (key: keyof BankTransfer) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setSaved(false);
    setValues(v => v && { ...v, [key]: e.target.value });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!values) return;
    try {
      setBusy(true);
      setError(null);
      await api.request("/manage/payment-settings", { method: "PUT", body: JSON.stringify(values) });
      setSaved(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="บัญชีรับโอนและวิธีชำระเงิน" onClose={onClose}>
      <ErrorBox message={error} />
      {!values ? <Empty text="กำลังโหลด…" /> : (
        <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={grid2}>
            <Field label="ธนาคาร"><input className="form-input" value={values.bank_name} onChange={set("bank_name")} maxLength={100} /></Field>
            <Field label="ชื่อบัญชี"><input className="form-input" value={values.account_name} onChange={set("account_name")} maxLength={150} /></Field>
            <Field label="เลขที่บัญชี"><input className="form-input" value={values.account_number} onChange={set("account_number")} maxLength={40} /></Field>
            <Field label="พร้อมเพย์ (เบอร์หรือเลขผู้เสียภาษี)"><input className="form-input" value={values.promptpay_id} onChange={set("promptpay_id")} maxLength={40} /></Field>
            <Field label="หมายเหตุถึงผู้เรียน" span>
              <textarea className="form-input" rows={3} value={values.note} onChange={set("note")} maxLength={500} />
            </Field>
          </div>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>ผู้เรียนเห็นข้อมูลนี้หลังกด "ซื้อคอร์ส" และในหน้าการชำระเงินของฉัน</p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", alignItems: "center" }}>
            {saved && <span style={{ color: "var(--accent)", fontSize: "13px" }}>บันทึกแล้ว</span>}
            <button type="button" className="tech-button-outline" onClick={onClose}>ปิด</button>
            <button type="submit" className="tech-button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : "บันทึก"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
};

export default OrdersPage;
