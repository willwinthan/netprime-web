import React, { useEffect, useState } from "react";
import { Copy, Check, Gift } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, ErrorBox, Empty, tableStyle, thStyle, tdStyle, formatDateTime } from "../site-admin/ui";

interface MyAffiliate {
  affiliate: null | {
    id: string; code: string; status: "pending" | "approved" | "suspended"; link: string;
    program: { name: string; commission_percent: number; window_days: number; active: boolean };
  };
  program: { name: string; commission_percent: number; window_days: number } | null;
  stats?: { clicks: number; signups: number; conversions: number; commission: { pending: number; approved: number; paid: number } };
  conversions?: Array<{ id: string; course_title: string | null; order_amount: number; commission_amount: number; status: string; created_at: string }>;
  payouts?: Array<{ id: string; amount: number; reference: string | null; paid_at: string }>;
}

const baht = (n: number) => `฿${(n || 0).toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;
const STATUS_TEXT: Record<string, string> = { pending: "รอตรวจ", approved: "อนุมัติแล้ว รอจ่าย", paid: "จ่ายแล้ว", rejected: "ไม่อนุมัติ" };

/**
 * Learner referral dashboard ("แนะนำเพื่อน"): join, copy the ?ref link, and follow clicks,
 * sign-ups, purchases and commission (pending / approved / paid).
 */
export const AffiliateDashboard: React.FC = () => {
  const api = useApi();
  const [data, setData] = useState<MyAffiliate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [joining, setJoining] = useState(false);
  const load = () => api.get<MyAffiliate>("/marketing/me/affiliate").then(setData).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const join = async () => {
    try { setJoining(true); await api.post("/marketing/me/affiliate", {}); await load(); }
    catch (err: any) { setError(err.message); } finally { setJoining(false); }
  };
  const copy = (value: string) => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  if (!data) return <div className="glass-card"><ErrorBox message={error} /><Empty text={error ? "" : "กำลังโหลด…"} /></div>;
  const a = data.affiliate;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div className="header-row">
        <div>
          <h1 className="header-title">แนะนำเพื่อน</h1>
          <p className="header-desc">แชร์ลิงก์ของคุณ เมื่อเพื่อนสมัครและซื้อคอร์ส คุณได้รับค่าคอมมิชชัน</p>
        </div>
      </div>
      <ErrorBox message={error} />
      {!a ? (
        <div className="glass-card" style={{ padding: 28, textAlign: "center" }}>
          <Gift size={40} color="var(--primary)" />
          {data.program ? <>
            <h2 style={{ fontSize: 20, margin: "12px 0 6px" }}>{data.program.name}</h2>
            <p style={{ color: "var(--text-secondary)" }}>รับ {data.program.commission_percent}% ของยอดซื้อคอร์สจากเพื่อนที่สมัครผ่านลิงก์ของคุณ ภายใน {data.program.window_days} วันหลังสมัคร</p>
            <button className="tech-button-primary" onClick={join} disabled={joining}>{joining ? "กำลังสมัคร…" : "รับลิงก์แนะนำของฉัน"}</button>
          </> : <p style={{ color: "var(--text-secondary)" }}>ยังไม่เปิดโปรแกรมแนะนำเพื่อนในขณะนี้</p>}
        </div>
      ) : <>
        <div className="glass-card" style={{ padding: 22 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <strong>{a.program.name} · {a.program.commission_percent}%</strong>
            {a.status === "approved" ? <Chip label="ใช้งานได้" color="var(--accent)" bg="var(--accent-glow)" />
              : a.status === "pending" ? <Chip label="รอเจ้าหน้าที่อนุมัติ" color="var(--warning)" bg="rgba(245,158,11,0.12)" />
              : <Chip label="ถูกระงับ" color="var(--danger)" bg="rgba(239,68,68,0.1)" />}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input className="form-input" readOnly value={a.link} aria-label="ลิงก์แนะนำของคุณ" style={{ flex: "1 1 280px", fontFamily: "monospace" }} onFocus={e => e.target.select()} />
            <button className="tech-button-primary" onClick={() => copy(a.link)}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "คัดลอกแล้ว" : "คัดลอกลิงก์"}</button>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "10px 0 0" }}>
            รหัสแนะนำ <strong style={{ fontFamily: "monospace" }}>{a.code}</strong> · ใส่ ?ref={a.code} ต่อท้ายลิงก์หน้าใดก็ได้ของเว็บไซต์ ระบบจำไว้ 30 วัน
            · ใช้ลิงก์ของตัวเองสมัครหรือซื้อไม่นับค่าคอมมิชชัน
          </p>
        </div>
        {data.stats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
            {([["คลิก", data.stats.clicks], ["สมัครสมาชิก", data.stats.signups], ["ซื้อคอร์ส", data.stats.conversions],
              ["รอตรวจ", baht(data.stats.commission.pending)], ["รอจ่าย", baht(data.stats.commission.approved)], ["ได้รับแล้ว", baht(data.stats.commission.paid)]] as Array<[string, React.ReactNode]>).map(([label, value]) => (
              <div key={label} className="glass-card" style={{ padding: 16 }}>
                <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "var(--primary)" }}>{value}</div>
              </div>
            ))}
          </div>
        )}
        <div className="glass-card" style={{ padding: 20, overflowX: "auto" }}>
          <h3 style={{ fontSize: 16, marginTop: 0 }}>ยอดซื้อจากการแนะนำ</h3>
          {!data.conversions?.length ? <Empty text="ยังไม่มียอดซื้อ" /> : (
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>วันที่</th><th style={thStyle}>คอร์ส</th><th style={thStyle}>ยอดซื้อ</th><th style={thStyle}>ค่าคอมมิชชัน</th><th style={thStyle}>สถานะ</th></tr></thead>
              <tbody>{data.conversions.map(c => (
                <tr key={c.id}><td style={tdStyle}>{formatDateTime(c.created_at)}</td><td style={tdStyle}>{c.course_title || "-"}</td>
                  <td style={tdStyle}>{baht(c.order_amount)}</td><td style={tdStyle}>{baht(c.commission_amount)}</td><td style={tdStyle}>{STATUS_TEXT[c.status] || c.status}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
        {!!data.payouts?.length && (
          <div className="glass-card" style={{ padding: 20 }}>
            <h3 style={{ fontSize: 16, marginTop: 0 }}>ประวัติการจ่าย</h3>
            {data.payouts.map(p => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(0,0,0,0.05)", fontSize: 14 }}>
                <span>{formatDateTime(p.paid_at)}{p.reference ? ` · ${p.reference}` : ""}</span><strong>{baht(p.amount)}</strong>
              </div>
            ))}
          </div>
        )}
      </>}
    </div>
  );
};
