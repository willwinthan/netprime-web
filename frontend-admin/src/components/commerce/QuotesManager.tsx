import React, { useEffect, useState } from "react";
import { Check, Edit3, Plus, Printer, Send, X } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, Modal, formatDate, grid2, tableStyle, tdStyle, thStyle } from "../site-admin/ui";
import { baht } from "../learner/CourseOrder";
import { PrintPortal, QuoteDocument, SellerProfile } from "../learner/PrintView";
import { CourseOption, QUOTE_STATUS, Quote } from "./types";

interface Organization { id: string; company_name: string; total_seats: number; allocated_seats: number }

/**
 * Quotations for organizations (commerce.manage): seats + courses + price, print/PDF, draft → sent →
 * accepted (creates the organization's bank-transfer order) / expired / cancelled. Confirming that order
 * in "คำสั่งซื้อ" adds the seats and sponsors the courses.
 */
export const QuotesManager: React.FC = () => {
  const api = useApi();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [editing, setEditing] = useState<Quote | "new" | null>(null);
  const [printing, setPrinting] = useState<{ quote: Quote; seller: SellerProfile | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setLoading(true);
      setQuotes((await api.get<{ quotes: Quote[] }>("/manage/quotes")).quotes);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    api.get<{ organizations: Organization[] }>("/admin/organizations").then(d => setOrgs(d.organizations)).catch(() => undefined);
    api.get<CourseOption[]>("/courses").then(list => setCourses(list.map(c => ({ id: c.id, title: c.title, price: Math.round(c.price || 0) })))).catch(() => undefined);
  }, [api.token]);

  const act = async (q: Quote, action: "send" | "accept" | "cancel") => {
    const ask = { send: `ส่งใบเสนอราคา ${q.quote_no}?`, accept: `องค์กรตอบรับ ${q.quote_no}? ระบบจะสร้างคำสั่งซื้อรอโอนเงิน`, cancel: `ยกเลิก ${q.quote_no}?` }[action];
    if (!window.confirm(ask)) return;
    try {
      setError(null);
      const res = await api.post<{ order?: { reference: string } }>(`/manage/quotes/${q.id}/${action}`, {});
      if (res.order) setNotice(`สร้างคำสั่งซื้อ ${res.order.reference} แล้ว ยืนยันการโอนได้ที่แท็บคำสั่งซื้อ`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const print = async (q: Quote) => {
    try {
      const d = await api.get<{ quote: Quote; seller: SellerProfile }>(`/manage/quotes/${q.id}`);
      setPrinting({ quote: d.quote, seller: d.seller });
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>ใบเสนอราคาสำหรับองค์กร เมื่อองค์กรตอบรับระบบจะสร้างคำสั่งซื้อ และเมื่อยืนยันการโอนจะเพิ่มที่นั่งและเปิดคอร์สให้องค์กร</p>
        <button type="button" className="tech-button-primary" onClick={() => setEditing("new")}><Plus size={16} />สร้างใบเสนอราคา</button>
      </div>
      <ErrorBox message={error} />
      {notice && <div className="glass-card" style={{ color: "var(--accent)", fontSize: "14px" }}>{notice}</div>}
      <div className="glass-card" style={{ padding: "8px", overflowX: "auto" }}>
        {loading ? <Empty text="กำลังโหลด…" /> : quotes.length === 0 ? <Empty text="ยังไม่มีใบเสนอราคา" /> : (
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>เลขที่</th><th style={thStyle}>องค์กร</th><th style={thStyle}>รายการ</th><th style={thStyle}>ราคา</th><th style={thStyle}>ยืนราคาถึง</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th></tr></thead>
            <tbody>
              {quotes.map(q => (
                <tr key={q.id}>
                  <td style={tdStyle}><span style={{ fontFamily: "monospace", fontWeight: 700 }}>{q.quote_no}</span><div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{q.title}</div></td>
                  <td style={tdStyle}>{q.company_name}{q.contact_name && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{q.contact_name}</div>}</td>
                  <td style={tdStyle}>{q.seats > 0 ? `${q.seats} ที่นั่ง` : ""}{q.seats > 0 && q.courses.length ? " · " : ""}{q.courses.map(c => c.title).join(", ")}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{baht(q.price)}</td>
                  <td style={tdStyle}>{formatDate(q.valid_until)}</td>
                  <td style={tdStyle}>
                    <Chip {...QUOTE_STATUS[q.status]} />
                    {q.order_reference && <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>คำสั่งซื้อ {q.order_reference} ({q.order_status === "paid" ? "ชำระแล้ว" : q.order_status})</div>}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button type="button" className="tech-button-outline" onClick={() => print(q)} style={{ padding: "4px 8px" }} aria-label="พิมพ์"><Printer size={14} /></button>
                      {(q.status === "draft" || q.status === "sent") && (<>
                        <button type="button" className="tech-button-outline" onClick={() => setEditing(q)} style={{ padding: "4px 8px" }} aria-label="แก้ไข"><Edit3 size={14} /></button>
                        <button type="button" className="tech-button-outline" onClick={() => act(q, "send")} style={{ padding: "4px 8px" }} aria-label="ส่ง"><Send size={14} /></button>
                        <button type="button" className="tech-button-primary" onClick={() => act(q, "accept")} style={{ padding: "4px 8px", fontSize: "12px" }}><Check size={14} />ตอบรับ</button>
                        <button type="button" className="tech-button-outline" onClick={() => act(q, "cancel")} style={{ padding: "4px 8px", color: "var(--danger)" }} aria-label="ยกเลิก"><X size={14} /></button>
                      </>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <QuoteDialog quote={editing === "new" ? null : editing} orgs={orgs} courses={courses} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {printing && (
        <PrintPortal orientation="portrait" onDone={() => setPrinting(null)}>
          <QuoteDocument quote={printing.quote} seller={printing.seller} />
        </PrintPortal>
      )}
    </div>
  );
};

const QuoteDialog: React.FC<{ quote: Quote | null; orgs: Organization[]; courses: CourseOption[]; onClose: () => void; onSaved: () => void }> = ({ quote, orgs, courses, onClose, onSaved }) => {
  const api = useApi();
  const inTwoWeeks = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const [v, setV] = useState({
    partner_id: quote?.partner_id ?? "", title: quote?.title ?? "", seats: String(quote?.seats ?? 0), price: String(quote?.price ?? ""),
    valid_until: quote?.valid_until ?? inTwoWeeks, contact_name: quote?.contact_name ?? "", contact_email: quote?.contact_email ?? "",
    buyer_address: quote?.buyer_address ?? "", buyer_branch: quote?.buyer_branch ?? "สำนักงานใหญ่", note: quote?.note ?? "",
    course_ids: quote?.courses.map(c => c.course_id) ?? [] as string[]
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV(prev => ({ ...prev, [key]: e.target.value }));
  const toggle = (id: string) => setV(prev => ({ ...prev, course_ids: prev.course_ids.includes(id) ? prev.course_ids.filter(x => x !== id) : [...prev.course_ids, id] }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      const body = { ...v, seats: Number(v.seats), price: Number(v.price) };
      if (quote) await api.request(`/manage/quotes/${quote.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api.post("/manage/quotes", body);
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={quote ? `แก้ไข ${quote.quote_no}` : "สร้างใบเสนอราคา"} onClose={onClose} width={720}>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <ErrorBox message={error} />
        <div style={grid2}>
          <Field label="องค์กร">
            <select className="form-input" required value={v.partner_id} onChange={set("partner_id")}>
              <option value="">เลือกองค์กร</option>
              {orgs.map(o => <option key={o.id} value={o.id}>{o.company_name} (ใช้ {o.allocated_seats}/{o.total_seats} ที่นั่ง)</option>)}
            </select>
          </Field>
          <Field label="หัวข้อ"><input className="form-input" required value={v.title} onChange={set("title")} maxLength={200} /></Field>
          <Field label="ที่นั่งเพิ่ม"><input className="form-input" type="number" min={0} value={v.seats} onChange={set("seats")} /></Field>
          <Field label="ราคารวม (บาท รวม VAT แล้ว ถ้ามี)"><input className="form-input" type="number" min={0} required value={v.price} onChange={set("price")} /></Field>
          <Field label="ยืนราคาถึง"><input className="form-input" type="date" required value={v.valid_until} onChange={set("valid_until")} /></Field>
          <Field label="สาขาผู้ซื้อ"><input className="form-input" value={v.buyer_branch} onChange={set("buyer_branch")} maxLength={50} /></Field>
          <Field label="ผู้ติดต่อ"><input className="form-input" value={v.contact_name} onChange={set("contact_name")} maxLength={200} /></Field>
          <Field label="อีเมลผู้ติดต่อ"><input className="form-input" type="email" value={v.contact_email} onChange={set("contact_email")} maxLength={200} /></Field>
          <Field label="ที่อยู่สำหรับใบกำกับภาษี" span><textarea className="form-input" rows={2} value={v.buyer_address} onChange={set("buyer_address")} maxLength={500} /></Field>
          <Field label="หมายเหตุในใบเสนอราคา" span><textarea className="form-input" rows={2} value={v.note} onChange={set("note")} maxLength={2000} /></Field>
        </div>
        <div className="glass-card" style={{ padding: "12px", maxHeight: "220px", overflowY: "auto" }}>
          <strong style={{ fontSize: "14px" }}>คอร์สที่องค์กรจะได้รับ ({v.course_ids.length})</strong>
          {courses.map(c => (
            <label key={c.id} style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px", padding: "2px 0" }}>
              <input type="checkbox" checked={v.course_ids.includes(c.id)} onChange={() => toggle(c.id)} /> {c.title}
            </label>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : "บันทึก"}</button>
        </div>
      </form>
    </Modal>
  );
};

export default QuotesManager;
