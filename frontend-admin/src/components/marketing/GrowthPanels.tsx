import React, { useEffect, useState } from "react";
import { Plus, Save, Download, Check, EyeOff, RefreshCw, Banknote } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Modal, Field, ErrorBox, Empty, grid2, tableStyle, thStyle, tdStyle, formatDateTime, formatDate, downloadWithAuth } from "../site-admin/ui";
import { Stars } from "./Ratings";

const baht = (n: number) => `฿${(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const tabButton = (active: boolean): React.CSSProperties => ({ padding: "6px 14px", fontSize: "13px" });

// ==========================================
// Analytics (UTM first touch, referrals, leads)
// ==========================================

interface Analytics {
  range: { from: string; to: string }; signups: number;
  sources: Array<{ source: string; medium: string; campaign: string; signups: number; paid_orders: number; revenue: number }>;
  leads: { by_form: Array<{ form: string; leads: number; converted: number }>; by_source: Array<{ source: string; leads: number }> };
  referrals: { clicks: number; signups: number; blocked_self: number; conversions: number; commission: number };
}

const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: string }> = ({ label, value, tone = "var(--primary)" }) => (
  <div className="glass-card" style={{ padding: 18 }}>
    <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 800, color: tone, marginTop: 4 }}>{value}</div>
  </div>
);

export const MarketingAnalyticsPanel: React.FC = () => {
  const api = useApi();
  const today = new Date().toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10), to: today });
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<Analytics>(`/marketing/admin/analytics?from=${range.from}&to=${range.to}`).then(d => { setData(d); setError(null); }).catch(err => setError(err.message));
  }, [range.from, range.to, api.token]);
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 14 }}>ตั้งแต่ <input className="form-input" type="date" style={{ width: "auto" }} value={range.from} max={range.to} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} /></label>
        <label style={{ fontSize: 14 }}>ถึง <input className="form-input" type="date" style={{ width: "auto" }} value={range.to} min={range.from} max={today} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} /></label>
      </div>
      <ErrorBox message={error} />
      {!data ? <Empty text="กำลังโหลด…" /> : <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14 }}>
          <Stat label="สมัครสมาชิกใหม่" value={data.signups} />
          <Stat label="คลิกลิงก์แนะนำ" value={data.referrals.clicks} tone="var(--secondary)" />
          <Stat label="สมัครผ่านการแนะนำ" value={data.referrals.signups} tone="var(--secondary)" />
          <Stat label="ยอดขายจากการแนะนำ" value={data.referrals.conversions} tone="var(--accent)" />
          <Stat label="ค่าคอมมิชชัน" value={baht(data.referrals.commission)} tone="var(--accent)" />
          <Stat label="lead ใหม่" value={data.leads.by_form.reduce((s, f) => s + f.leads, 0)} tone="var(--warning)" />
        </div>
        <div className="glass-card" style={{ padding: 20, overflowX: "auto" }}>
          <h3 style={{ fontSize: 16, marginTop: 0 }}>แหล่งที่มาของผู้สมัคร (first touch: utm_source / medium / campaign)</h3>
          {data.sources.length === 0 ? <Empty text="ยังไม่มีข้อมูลแหล่งที่มาในช่วงนี้" /> : (
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>Source</th><th style={thStyle}>Medium</th><th style={thStyle}>Campaign</th><th style={thStyle}>สมัคร</th><th style={thStyle}>คำสั่งซื้อที่ชำระ</th><th style={thStyle}>รายได้</th></tr></thead>
              <tbody>{data.sources.map((s, i) => (
                <tr key={i}><td style={tdStyle}>{s.source}</td><td style={tdStyle}>{s.medium || "-"}</td><td style={tdStyle}>{s.campaign || "-"}</td>
                  <td style={tdStyle}>{s.signups}</td><td style={tdStyle}>{s.paid_orders}</td><td style={tdStyle}>{baht(s.revenue)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
        <div className="dashboard-grid">
          <div className="glass-card" style={{ padding: 20 }}>
            <h3 style={{ fontSize: 16, marginTop: 0 }}>lead ตามฟอร์ม</h3>
            {data.leads.by_form.length === 0 ? <Empty text="ยังไม่มี lead" /> : data.leads.by_form.map((f, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(0,0,0,0.05)", fontSize: 14 }}>
                <span>{f.form}</span><span>{f.leads} (ปิดการขาย {f.converted})</span>
              </div>
            ))}
          </div>
          <div className="glass-card" style={{ padding: 20 }}>
            <h3 style={{ fontSize: 16, marginTop: 0 }}>lead ตามแหล่งที่มา</h3>
            {data.leads.by_source.length === 0 ? <Empty text="ยังไม่มี lead" /> : data.leads.by_source.map((s, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(0,0,0,0.05)", fontSize: 14 }}>
                <span>{s.source}</span><span>{s.leads}</span>
              </div>
            ))}
          </div>
        </div>
      </>}
    </div>
  );
};

// ==========================================
// Affiliates: programs, affiliates, commissions, payouts
// ==========================================

interface Program { id: string; name: string; commission_percent: number; auto_approve: number; window_days: number; active: number; is_default: number; affiliate_count: number }
interface AffiliateRow {
  id: string; code: string; status: "pending" | "approved" | "suspended"; user_name: string; user_email: string; program_id: string; program_name: string;
  commission_percent: number; clicks: number; signups: number; conversions: number; commission_pending: number; commission_approved: number; commission_paid: number; created_at: string;
}
interface Conversion {
  id: string; affiliate_id: string; affiliate_name: string; affiliate_code: string; order_reference: string | null; course_title: string | null; buyer_name: string | null;
  order_amount: number; commission_percent: number; commission_amount: number; status: "pending" | "approved" | "paid" | "rejected"; note: string | null; created_at: string;
}
const AFF_STATUS = {
  pending: { label: "รออนุมัติ", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  approved: { label: "ใช้งาน", color: "var(--accent)", bg: "var(--accent-glow)" },
  suspended: { label: "ระงับ", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" }
};
const CONV_STATUS = {
  pending: { label: "รอตรวจ", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  approved: { label: "อนุมัติแล้ว รอจ่าย", color: "var(--secondary)", bg: "var(--secondary-glow)" },
  paid: { label: "จ่ายแล้ว", color: "var(--accent)", bg: "var(--accent-glow)" },
  rejected: { label: "ไม่อนุมัติ", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" }
};

const ProgramEditor: React.FC<{ program: Program | null; onClose: () => void; onSaved: () => void }> = ({ program, onClose, onSaved }) => {
  const api = useApi();
  const [form, setForm] = useState({
    name: program?.name ?? "", commission_percent: program?.commission_percent ?? 10, window_days: program?.window_days ?? 90,
    auto_approve: program ? !!program.auto_approve : true, active: program ? !!program.active : true, is_default: program ? !!program.is_default : false
  });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      if (program) await api.patch(`/marketing/admin/programs/${program.id}`, form);
      else await api.post("/marketing/admin/programs", form);
      onSaved();
    } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title={program ? "แก้ไขโปรแกรม" : "สร้างโปรแกรม affiliate"} onClose={onClose}>
      <ErrorBox message={error} />
      <div style={grid2}>
        <Field label="ชื่อโปรแกรม" span><input className="form-input" value={form.name} maxLength={120} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
        <Field label="ค่าคอมมิชชัน (%)"><input className="form-input" type="number" min={0} max={100} step={0.5} value={form.commission_percent} onChange={e => setForm(f => ({ ...f, commission_percent: Number(e.target.value) }))} /></Field>
        <Field label="นับยอดซื้อภายใน (วันหลังสมัคร)"><input className="form-input" type="number" min={1} max={3650} value={form.window_days} onChange={e => setForm(f => ({ ...f, window_days: Number(e.target.value) }))} /></Field>
      </div>
      {([["auto_approve", "อนุมัติผู้สมัครเข้าโปรแกรมอัตโนมัติ (ผู้เรียนทุกคนรับลิงก์ได้ทันที)"], ["is_default", "เป็นโปรแกรมหลักที่ผู้เรียนเข้าร่วมได้เอง"], ["active", "เปิดใช้งาน"]] as const).map(([key, label]) => (
        <label key={key} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginTop: 12 }}>
          <input type="checkbox" checked={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.checked }))} />{label}
        </label>
      ))}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
        <button className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
        <button className="tech-button-primary" onClick={save}><Save size={16} />บันทึก</button>
      </div>
    </Modal>
  );
};

export const AffiliatesAdminPanel: React.FC = () => {
  const api = useApi();
  const [view, setView] = useState<"affiliates" | "conversions" | "programs">("affiliates");
  const [programs, setPrograms] = useState<Program[]>([]);
  const [affiliates, setAffiliates] = useState<AffiliateRow[]>([]);
  const [conversions, setConversions] = useState<Conversion[]>([]);
  const [convStatus, setConvStatus] = useState<string>("pending");
  const [editing, setEditing] = useState<Program | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      const [p, a, c] = await Promise.all([
        api.get<{ programs: Program[] }>("/marketing/admin/programs"),
        api.get<{ affiliates: AffiliateRow[] }>("/marketing/admin/affiliates"),
        api.get<{ conversions: Conversion[] }>(`/marketing/admin/conversions${convStatus ? `?status=${convStatus}` : ""}`)
      ]);
      setPrograms(p.programs); setAffiliates(a.affiliates); setConversions(c.conversions);
    } catch (err: any) { setError(err.message); }
  };
  useEffect(() => { load(); }, [convStatus, api.token]);

  const act = async (fn: () => Promise<unknown>, message?: string) => {
    try { await fn(); if (message) setNotice(message); await load(); } catch (err: any) { setError(err.message); }
  };
  const payout = (a: AffiliateRow) => {
    const reference = prompt(`บันทึกการจ่าย ${baht(a.commission_approved)} ให้ ${a.user_name}\nเลขอ้างอิงการโอน (ไม่บังคับ):`, "");
    if (reference === null) return;
    act(() => api.post(`/marketing/admin/affiliates/${a.id}/payouts`, { reference }), "บันทึกการจ่ายค่าคอมมิชชันแล้ว");
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        {([["affiliates", "ผู้แนะนำ (affiliate)"], ["conversions", "ค่าคอมมิชชัน"], ["programs", "โปรแกรม"]] as const).map(([key, label]) => (
          <button key={key} onClick={() => setView(key)} className={view === key ? "tech-button-primary" : "tech-button-outline"} style={tabButton(view === key)}>{label}</button>
        ))}
        <button className="tech-button-outline" style={{ marginLeft: "auto", padding: "6px 14px", fontSize: 13 }}
          onClick={() => act(async () => { const r = await api.post<{ recorded: number; reversed: number }>("/marketing/admin/conversions/sync", {}); setNotice(`ตรวจยอดซื้อย้อนหลัง: เพิ่ม ${r.recorded} รายการ ยกเลิก (คืนเงิน) ${r.reversed} รายการ`); })}>
          <RefreshCw size={14} />ตรวจยอดซื้อย้อนหลัง
        </button>
      </div>
      <ErrorBox message={error} />
      {notice && <div role="status" style={{ background: "var(--accent-glow)", color: "var(--accent)", padding: "10px 14px", borderRadius: 8, marginBottom: 12, fontSize: 14 }}>{notice}</div>}

      {view === "programs" && (
        <div>
          <button className="tech-button-primary" style={{ marginBottom: 12 }} onClick={() => setEditing("new")}><Plus size={16} />สร้างโปรแกรม</button>
          <div className="glass-card" style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>โปรแกรม</th><th style={thStyle}>คอมมิชชัน</th><th style={thStyle}>ระยะนับยอด</th><th style={thStyle}>อนุมัติ</th><th style={thStyle}>ผู้แนะนำ</th><th style={thStyle}></th></tr></thead>
              <tbody>{programs.map(p => (
                <tr key={p.id}>
                  <td style={tdStyle}><strong>{p.name}</strong> {p.is_default ? <Chip label="หลัก" color="var(--primary)" bg="var(--primary-glow)" /> : null} {!p.active && <Chip label="ปิด" color="var(--text-secondary)" bg="rgba(100,116,139,0.12)" />}</td>
                  <td style={tdStyle}>{p.commission_percent}%</td><td style={tdStyle}>{p.window_days} วัน</td>
                  <td style={tdStyle}>{p.auto_approve ? "อัตโนมัติ" : "เจ้าหน้าที่อนุมัติ"}</td><td style={tdStyle}>{p.affiliate_count}</td>
                  <td style={tdStyle}><button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => setEditing(p)}>แก้ไข</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {view === "affiliates" && (affiliates.length === 0 ? <div className="glass-card"><Empty text="ยังไม่มีผู้เข้าร่วมโปรแกรมแนะนำ" /></div> : (
        <div className="glass-card" style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>ผู้แนะนำ</th><th style={thStyle}>รหัส</th><th style={thStyle}>คลิก / สมัคร / ซื้อ</th><th style={thStyle}>รอตรวจ</th><th style={thStyle}>รอจ่าย</th><th style={thStyle}>จ่ายแล้ว</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th></tr></thead>
            <tbody>{affiliates.map(a => (
              <tr key={a.id}>
                <td style={tdStyle}><strong>{a.user_name}</strong><div style={{ fontSize: 12, color: "var(--text-muted)" }}>{a.user_email} · {a.program_name} ({a.commission_percent}%)</div></td>
                <td style={{ ...tdStyle, fontFamily: "monospace" }}>{a.code}</td>
                <td style={tdStyle}>{a.clicks} / {a.signups} / {a.conversions}</td>
                <td style={tdStyle}>{baht(a.commission_pending)}</td><td style={tdStyle}>{baht(a.commission_approved)}</td><td style={tdStyle}>{baht(a.commission_paid)}</td>
                <td style={tdStyle}>
                  <select className="form-input" style={{ width: "auto", padding: "4px 8px" }} value={a.status}
                    onChange={e => act(() => api.patch(`/marketing/admin/affiliates/${a.id}`, { status: e.target.value }))}>
                    {Object.entries(AFF_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                </td>
                <td style={tdStyle}>{a.commission_approved > 0 && <button className="tech-button-primary" style={{ padding: "6px 10px", fontSize: 13 }} onClick={() => payout(a)}><Banknote size={14} />บันทึกการจ่าย</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}

      {view === "conversions" && (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            {([["pending", "รอตรวจ"], ["approved", "รอจ่าย"], ["paid", "จ่ายแล้ว"], ["rejected", "ไม่อนุมัติ"], ["", "ทั้งหมด"]] as const).map(([key, label]) => (
              <button key={key} onClick={() => setConvStatus(key)} className={convStatus === key ? "tech-button-primary" : "tech-button-outline"} style={tabButton(convStatus === key)}>{label}</button>
            ))}
          </div>
          {conversions.length === 0 ? <div className="glass-card"><Empty text="ไม่มีรายการในกลุ่มนี้" /></div> : (
            <div className="glass-card" style={{ overflowX: "auto" }}>
              <table style={tableStyle}>
                <thead><tr><th style={thStyle}>วันที่</th><th style={thStyle}>ผู้แนะนำ</th><th style={thStyle}>คำสั่งซื้อ</th><th style={thStyle}>ยอดซื้อ</th><th style={thStyle}>คอมมิชชัน</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th></tr></thead>
                <tbody>{conversions.map(cv => (
                  <tr key={cv.id}>
                    <td style={tdStyle}>{formatDateTime(cv.created_at)}</td>
                    <td style={tdStyle}>{cv.affiliate_name}<div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "monospace" }}>{cv.affiliate_code}</div></td>
                    <td style={tdStyle}>{cv.order_reference || "-"}<div style={{ fontSize: 12, color: "var(--text-muted)" }}>{cv.course_title} · {cv.buyer_name}</div></td>
                    <td style={tdStyle}>{baht(cv.order_amount)}</td>
                    <td style={tdStyle}>{baht(cv.commission_amount)} <span style={{ fontSize: 12, color: "var(--text-muted)" }}>({cv.commission_percent}%)</span></td>
                    <td style={tdStyle}><Chip {...CONV_STATUS[cv.status]} />{cv.note && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{cv.note}</div>}</td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      {cv.status === "pending" && <>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => act(() => api.post(`/marketing/admin/conversions/${cv.id}/status`, { status: "approved" }))}><Check size={14} />อนุมัติ</button>{" "}
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => act(() => api.post(`/marketing/admin/conversions/${cv.id}/status`, { status: "rejected" }))}>ไม่อนุมัติ</button>
                      </>}
                      {(cv.status === "approved" || cv.status === "rejected") && (
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => act(() => api.post(`/marketing/admin/conversions/${cv.id}/status`, { status: "pending" }))}>กลับไปรอตรวจ</button>
                      )}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {editing && <ProgramEditor program={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
};

// ==========================================
// Reviews moderation
// ==========================================

interface AdminReview {
  id: string; course_id: string; course_title: string; user_name: string; user_email: string; rating: number; body: string | null;
  status: "pending" | "approved" | "hidden"; moderated_by_name: string | null; updated_at: string;
}
const REVIEW_STATUS = {
  pending: { label: "รอตรวจ", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  approved: { label: "แสดงแล้ว", color: "var(--accent)", bg: "var(--accent-glow)" },
  hidden: { label: "ซ่อน", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" }
};

export const ReviewsModerationPanel: React.FC = () => {
  const api = useApi();
  const [status, setStatus] = useState<string>("pending");
  const [reviews, setReviews] = useState<AdminReview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.get<{ reviews: AdminReview[] }>(`/marketing/admin/reviews${status ? `?status=${status}` : ""}`).then(d => setReviews(d.reviews)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [status, api.token]);
  const moderate = async (r: AdminReview, next: AdminReview["status"]) => {
    try { await api.patch(`/marketing/admin/reviews/${r.id}`, { status: next }); load(); } catch (err: any) { setError(err.message); }
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {([["pending", "รอตรวจ"], ["approved", "แสดงแล้ว"], ["hidden", "ซ่อน"], ["", "ทั้งหมด"]] as const).map(([key, label]) => (
          <button key={key} onClick={() => setStatus(key)} className={status === key ? "tech-button-primary" : "tech-button-outline"} style={tabButton(status === key)}>{label}</button>
        ))}
      </div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>ผู้เรียนรีวิวได้เมื่อเรียนไปแล้วอย่างน้อย 30% หรือเรียนจบ คะแนนเฉลี่ยบนหน้าคอร์สนับเฉพาะรีวิวที่แสดงแล้ว</p>
      <ErrorBox message={error} />
      {reviews.length === 0 ? <div className="glass-card"><Empty text="ไม่มีรีวิวในกลุ่มนี้" /></div> : (
        <div style={{ display: "grid", gap: 12 }}>
          {reviews.map(r => (
            <div key={r.id} className="glass-card" style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><Stars value={r.rating} showCount={false} /><strong>{r.course_title}</strong><Chip {...REVIEW_STATUS[r.status]} /></div>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>{r.user_name} · {r.user_email} · {formatDateTime(r.updated_at)}{r.moderated_by_name ? ` · ตรวจโดย ${r.moderated_by_name}` : ""}</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {r.status !== "approved" && <button className="tech-button-primary" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => moderate(r, "approved")}><Check size={14} />แสดง</button>}
                  {r.status !== "hidden" && <button className="tech-button-outline" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => moderate(r, "hidden")}><EyeOff size={14} />ซ่อน</button>}
                </div>
              </div>
              {r.body && <p style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", fontSize: 14 }}>{r.body}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ==========================================
// Coupon campaigns (bulk single-use codes)
// ==========================================

interface Campaign {
  id: string; name: string; prefix: string; discount_type: "percent" | "fixed"; discount_value: number; course_id: string | null; course_title: string | null;
  expires_at: string; quantity: number; code_count: number; used_count: number; active_count: number; created_by_name: string | null; created_at: string;
}

export const CampaignsPanel: React.FC = () => {
  const api = useApi();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", prefix: "NP", discount_type: "percent", discount_value: 10, quantity: 50, expires_on: "", course_id: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<{ campaigns: Campaign[] }>("/marketing/admin/campaigns").then(d => setCampaigns(d.campaigns)).catch(err => setError(err.message));
  useEffect(() => {
    load();
    api.get<Array<{ id: string; title: string }>>("/courses").then(list => setCourses(list)).catch(() => undefined);
  }, [api.token]);

  const create = async () => {
    try {
      setBusy(true); setError(null);
      await api.post("/marketing/admin/campaigns", { ...form, course_id: form.course_id || null });
      setCreating(false); load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  const toggle = async (c: Campaign, active: boolean) => {
    if (!active && !confirm(`ปิดใช้โค้ดที่ยังไม่ถูกใช้ทั้งหมดของ "${c.name}"?`)) return;
    try { await api.patch(`/marketing/admin/campaigns/${c.id}`, { active }); load(); } catch (err: any) { setError(err.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)" }}>สร้างโค้ดส่วนลดแบบใช้ได้ครั้งเดียวทีละหลายโค้ด สำหรับแจกในงานสัมมนา พาร์ตเนอร์ หรือแคมเปญโฆษณา</p>
        <button className="tech-button-primary" onClick={() => setCreating(true)}><Plus size={16} />สร้างแคมเปญ</button>
      </div>
      <ErrorBox message={error} />
      {campaigns.length === 0 ? <div className="glass-card"><Empty text="ยังไม่มีแคมเปญ" /></div> : (
        <div className="glass-card" style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>แคมเปญ</th><th style={thStyle}>ส่วนลด</th><th style={thStyle}>ใช้แล้ว / ทั้งหมด</th><th style={thStyle}>หมดอายุ</th><th style={thStyle}></th></tr></thead>
            <tbody>{campaigns.map(c => (
              <tr key={c.id}>
                <td style={tdStyle}><strong>{c.name}</strong><div style={{ fontSize: 12, color: "var(--text-muted)" }}>{c.prefix}-XXXXXXXX · {c.course_title || "ทุกคอร์ส"} · {c.created_by_name || "-"}</div></td>
                <td style={tdStyle}>{c.discount_type === "percent" ? `${c.discount_value}%` : baht(c.discount_value)}</td>
                <td style={tdStyle}>{c.used_count} / {c.code_count}{c.active_count < c.code_count - c.used_count ? <div style={{ fontSize: 12, color: "var(--text-muted)" }}>ปิดใช้งานแล้วบางส่วน</div> : null}</td>
                <td style={tdStyle}>{formatDate(c.expires_at.slice(0, 10))}</td>
                <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                  <button className="tech-button-outline" style={{ padding: "6px 10px", fontSize: 13 }}
                    onClick={() => downloadWithAuth(`/marketing/admin/campaigns/${c.id}/codes.csv`, api.token, `vouchers-${c.prefix}.csv`).catch(err => setError(err.message))}>
                    <Download size={14} />CSV
                  </button>{" "}
                  {c.active_count > 0
                    ? <button className="tech-button-outline" style={{ padding: "6px 10px", fontSize: 13 }} onClick={() => toggle(c, false)}>ปิดโค้ด</button>
                    : <button className="tech-button-outline" style={{ padding: "6px 10px", fontSize: 13 }} onClick={() => toggle(c, true)}>เปิดโค้ด</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {creating && (
        <Modal title="สร้างแคมเปญโค้ดส่วนลด" onClose={() => setCreating(false)}>
          <ErrorBox message={error} />
          <div style={grid2}>
            <Field label="ชื่อแคมเปญ" span><input className="form-input" maxLength={120} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="คำนำหน้าโค้ด" hint="A–Z, 0–9 ไม่เกิน 12 ตัว"><input className="form-input" maxLength={12} value={form.prefix} onChange={e => setForm(f => ({ ...f, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))} /></Field>
            <Field label="จำนวนโค้ด (สูงสุด 1,000)"><input className="form-input" type="number" min={1} max={1000} value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: Number(e.target.value) }))} /></Field>
            <Field label="ประเภทส่วนลด">
              <select className="form-input" value={form.discount_type} onChange={e => setForm(f => ({ ...f, discount_type: e.target.value }))}>
                <option value="percent">เปอร์เซ็นต์</option><option value="fixed">จำนวนเงิน (บาท)</option>
              </select>
            </Field>
            <Field label={form.discount_type === "percent" ? "ส่วนลด (%)" : "ส่วนลด (บาท)"}><input className="form-input" type="number" min={1} value={form.discount_value} onChange={e => setForm(f => ({ ...f, discount_value: Number(e.target.value) }))} /></Field>
            <Field label="ใช้ได้ถึงวันที่"><input className="form-input" type="date" value={form.expires_on} onChange={e => setForm(f => ({ ...f, expires_on: e.target.value }))} /></Field>
            <Field label="ใช้กับคอร์ส">
              <select className="form-input" value={form.course_id} onChange={e => setForm(f => ({ ...f, course_id: e.target.value }))}>
                <option value="">ทุกคอร์ส</option>{courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </Field>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>ทุกโค้ดใช้ได้ 1 ครั้ง ดาวน์โหลดรายชื่อโค้ดเป็น CSV ได้หลังสร้าง</p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="tech-button-outline" onClick={() => setCreating(false)}>ยกเลิก</button>
            <button className="tech-button-primary" disabled={busy} onClick={create}><Save size={16} />{busy ? "กำลังสร้าง…" : "สร้างโค้ด"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
};
