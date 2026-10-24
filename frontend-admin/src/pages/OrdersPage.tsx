import React, { useEffect, useState } from "react";
import { Banknote, Check, FileImage, RefreshCw, Search, Settings, Undo2, X } from "lucide-react";
import { API_BASE_URL, useApi } from "../hooks/useApi";
import { Chip, Modal, Field, ErrorBox, Empty, grid2, tableStyle, thStyle, tdStyle, formatDateTime } from "../components/site-admin/ui";
import { BankTransfer, CourseOrder, ORDER_STATUS, baht } from "../components/learner/CourseOrder";

type Api = ReturnType<typeof useApi>;
type StaffOrder = CourseOrder & { user_id: string; confirmed_by_name: string | null };

const TABS = [["pending", "รอตรวจสอบ"], ["paid", "ชำระแล้ว"], ["all", "ทั้งหมด"]] as const;

/**
 * Course orders paid by bank transfer (payments.manage): check slips, confirm, reject, refund,
 * and edit the transfer instructions learners see.
 */
export const OrdersPage: React.FC = () => {
  const api = useApi();
  const [tab, setTab] = useState<typeof TABS[number][0]>("pending");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slipOf, setSlipOf] = useState<StaffOrder | null>(null);
  const [action, setAction] = useState<{ kind: "confirm" | "reject" | "refund"; order: StaffOrder } | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.get<{ orders: StaffOrder[]; counts: Record<string, number> }>(
        `/manage/orders?status=${tab}${search ? `&q=${encodeURIComponent(search)}` : ""}`);
      setOrders(data.orders);
      setCounts(data.counts);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [tab, search, api.token]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <h1 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "10px" }}><Banknote size={24} color="var(--primary)" />คำสั่งซื้อคอร์ส</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>ตรวจสลิปโอนเงิน ยืนยันการชำระเพื่อเปิดสิทธิ์เข้าเรียนและออกใบเสร็จ</p>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {TABS.map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} className={tab === key ? "tech-button-primary" : "tech-button-outline"}
              style={{ padding: "6px 14px", fontSize: "13px" }}>
              {label}{key === "pending" && counts.pending ? ` (${counts.pending})` : ""}
            </button>
          ))}
        </div>
        <form onSubmit={e => { e.preventDefault(); setSearch(query.trim()); }} style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <input className="form-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="เลขคำสั่งซื้อ / ใบเสร็จ / อีเมล / ชื่อ"
            style={{ minWidth: "240px" }} aria-label="ค้นหาคำสั่งซื้อ" />
          <button type="submit" className="tech-button-outline" style={{ padding: "8px 14px" }} aria-label="ค้นหา"><Search size={16} /></button>
          <button type="button" className="tech-button-outline" onClick={load} style={{ padding: "8px 14px" }} aria-label="รีเฟรช"><RefreshCw size={16} /></button>
          <button type="button" className="tech-button-outline" onClick={() => setShowSettings(true)}><Settings size={16} />บัญชีรับโอน</button>
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
                  <td style={tdStyle}>{o.course_title}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    {baht(o.amount)}
                    {o.voucher_code && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>โค้ด {o.voucher_code} (ปกติ {baht(o.list_price)})</div>}
                    {o.amount_received !== null && o.status !== "pending" && <div style={{ fontSize: "12px", color: "var(--accent)" }}>รับจริง {baht(o.amount_received)}</div>}
                  </td>
                  <td style={tdStyle}>
                    {o.has_slip ? (
                      <button className="tech-button-outline" onClick={() => setSlipOf(o)} style={{ padding: "4px 10px", fontSize: "12px" }}>
                        <FileImage size={14} />ดูสลิป
                      </button>
                    ) : <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>ยังไม่แนบ</span>}
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
                        <button className="tech-button-primary" onClick={() => setAction({ kind: "confirm", order: o })} style={{ padding: "4px 10px", fontSize: "12px" }}><Check size={14} />ยืนยัน</button>
                        <button className="tech-button-outline" onClick={() => setAction({ kind: "reject", order: o })} style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }}><X size={14} />ปฏิเสธ</button>
                      </div>
                    )}
                    {o.status === "paid" && (
                      <button className="tech-button-outline" onClick={() => setAction({ kind: "refund", order: o })} style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }}><Undo2 size={14} />คืนเงิน/ยกเลิก</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {slipOf && <SlipPreview api={api} order={slipOf} onClose={() => setSlipOf(null)} />}
      {action && <OrderActionDialog api={api} kind={action.kind} order={action.order} onClose={() => setAction(null)} onDone={() => { setAction(null); load(); }} />}
      {showSettings && <PaymentSettingsDialog api={api} onClose={() => setShowSettings(false)} />}
    </div>
  );
};

// ==========================================
// Slip preview (fetched with the token; never a public URL)
// ==========================================

const SlipPreview: React.FC<{ api: Api; order: StaffOrder; onClose: () => void }> = ({ api, order, onClose }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    fetch(`${API_BASE_URL}/orders/${order.id}/slip`, { headers: api.token ? { Authorization: `Bearer ${api.token}` } : {} })
      .then(async res => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "โหลดสลิปไม่สำเร็จ");
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        setType(blob.type);
        setUrl(objectUrl);
      })
      .catch(err => setError(err.message));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [order.id]);

  return (
    <Modal title={`สลิป ${order.reference}`} onClose={onClose} width={720}>
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
          <p style={{ color: "var(--danger)", fontSize: "13px" }}>สิทธิ์เข้าเรียนคอร์สนี้ของผู้เรียนจะถูกระงับทันที การโอนเงินคืนต้องทำนอกระบบ</p>
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
