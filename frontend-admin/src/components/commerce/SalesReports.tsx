import React, { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Empty, ErrorBox, downloadWithAuth, formatDateTime, tableStyle, tdStyle, thStyle } from "../site-admin/ui";
import { ORDER_KIND, baht } from "../learner/CourseOrder";

interface Report {
  range: { from: string; to: string };
  totals: { receipts: number; revenue: number; vat: number; net_of_vat: number; refunds: number; refunded_amount: number; net_revenue: number;
    outstanding_installments: number; outstanding_amount: number; overdue_installments: number };
  by_day: { date: string; receipts: number; revenue: number; vat: number }[];
  by_month: { month: string; receipts: number; revenue: number; vat: number }[];
  by_product: { item_id: string | null; title: string; kind: string; orders: number; revenue: number }[];
  by_voucher: { code: string; orders: number; revenue: number; discount: number }[];
  refunds: { id: string; reference: string; title: string; user_name: string; refunded_at: string; credit_note_no: string | null; amount: number }[];
  outstanding: { order_id: string; reference: string; title: string; user_name: string; seq: number; installment_count: number; amount: number; due_at: string; overdue: boolean; has_slip: boolean; suspended_at: string | null }[];
}

const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const Stat: React.FC<{ label: string; value: string; hint?: string }> = ({ label, value, hint }) => (
  <div className="glass-card" style={{ padding: "14px 16px" }}>
    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{label}</div>
    <div style={{ fontSize: "20px", fontWeight: 800 }}>{value}</div>
    {hint && <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{hint}</div>}
  </div>
);

/** Sales reports (payments.manage / commerce.manage): revenue by day/month, product, voucher; refunds; outstanding installments; CSV. */
export const SalesReports: React.FC = () => {
  const api = useApi();
  const [from, setFrom] = useState(`${today().slice(0, 8)}01`);
  const [to, setTo] = useState(today());
  const [group, setGroup] = useState<"day" | "month">("day");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      setReport(await api.get<Report>(`/manage/commerce/report?from=${from}&to=${to}`));
    } catch (err: any) {
      setError(err.message);
    }
  };
  useEffect(() => { load(); }, [api.token]);

  const exportCsv = async () => {
    try {
      await downloadWithAuth(`/manage/commerce/report.csv?from=${from}&to=${to}`, api.token, `sales-${from}-${to}.csv`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const t = report?.totals;
  const periods = group === "day" ? report?.by_day.map(d => ({ key: d.date, ...d })) : report?.by_month.map(m => ({ key: m.month, ...m }));
  const max = Math.max(1, ...(periods ?? []).map(p => p.revenue));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <form onSubmit={e => { e.preventDefault(); load(); }} style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: "13px" }}>จาก <input className="form-input" type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ width: "auto" }} /></label>
        <label style={{ fontSize: "13px" }}>ถึง <input className="form-input" type="date" value={to} onChange={e => setTo(e.target.value)} style={{ width: "auto" }} /></label>
        <select className="form-input" value={group} onChange={e => setGroup(e.target.value as "day" | "month")} style={{ width: "auto" }} aria-label="จัดกลุ่ม">
          <option value="day">รายวัน</option><option value="month">รายเดือน</option>
        </select>
        <button type="submit" className="tech-button-outline"><RefreshCw size={14} />แสดงรายงาน</button>
        <button type="button" className="tech-button-outline" onClick={exportCsv}><Download size={14} />ส่งออก CSV</button>
      </form>
      <ErrorBox message={error} />
      {!report || !t ? <Empty text="กำลังโหลด…" /> : (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px" }}>
          <Stat label="รายรับ (ตามใบเสร็จ)" value={baht(t.revenue)} hint={`${t.receipts} ใบเสร็จ`} />
          <Stat label="ภาษีมูลค่าเพิ่ม" value={baht(t.vat)} hint={`ก่อนภาษี ${baht(t.net_of_vat)}`} />
          <Stat label="คืนเงิน" value={baht(t.refunded_amount)} hint={`${t.refunds} รายการ`} />
          <Stat label="รายรับสุทธิ" value={baht(t.net_revenue)} />
          <Stat label="ค้างชำระ (ผ่อน)" value={baht(t.outstanding_amount)} hint={`${t.outstanding_installments} งวด · เลยกำหนด ${t.overdue_installments}`} />
        </div>

        <div className="glass-card" style={{ overflowX: "auto" }}>
          <h3 style={{ fontSize: "15px", marginBottom: "8px" }}>รายรับ{group === "day" ? "รายวัน" : "รายเดือน"}</h3>
          {!periods?.length ? <Empty text="ไม่มีรายรับในช่วงนี้" /> : (
            <table style={tableStyle}><tbody>
              {periods.map(p => (
                <tr key={p.key}>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap", width: "110px" }}>{p.key}</td>
                  <td style={tdStyle}><div style={{ height: "10px", width: `${(p.revenue / max) * 100}%`, minWidth: "2px", background: "var(--primary)", borderRadius: "4px" }} /></td>
                  <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }}>{baht(p.revenue)}</td>
                  <td style={{ ...tdStyle, textAlign: "right", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{p.receipts} ใบ</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "12px" }}>
          <div className="glass-card" style={{ overflowX: "auto" }}>
            <h3 style={{ fontSize: "15px", marginBottom: "8px" }}>ตามสินค้า</h3>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>รายการ</th><th style={thStyle}>คำสั่งซื้อ</th><th style={{ ...thStyle, textAlign: "right" }}>รายรับ</th></tr></thead>
              <tbody>{report.by_product.map(p => (
                <tr key={`${p.kind}:${p.item_id}`}><td style={tdStyle}>{p.title}<div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{ORDER_KIND[p.kind] ?? p.kind}</div></td>
                  <td style={tdStyle}>{p.orders}</td><td style={{ ...tdStyle, textAlign: "right" }}>{baht(p.revenue)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className="glass-card" style={{ overflowX: "auto" }}>
            <h3 style={{ fontSize: "15px", marginBottom: "8px" }}>ตามโค้ดส่วนลด</h3>
            {!report.by_voucher.length ? <Empty text="ไม่มีการใช้โค้ด" /> : (
              <table style={tableStyle}>
                <thead><tr><th style={thStyle}>โค้ด</th><th style={thStyle}>คำสั่งซื้อ</th><th style={thStyle}>ส่วนลดรวม</th><th style={{ ...thStyle, textAlign: "right" }}>รายรับ</th></tr></thead>
                <tbody>{report.by_voucher.map(v => (
                  <tr key={v.code}><td style={{ ...tdStyle, fontFamily: "monospace" }}>{v.code}</td><td style={tdStyle}>{v.orders}</td><td style={tdStyle}>{baht(v.discount)}</td><td style={{ ...tdStyle, textAlign: "right" }}>{baht(v.revenue)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </div>

        <div className="glass-card" style={{ overflowX: "auto" }}>
          <h3 style={{ fontSize: "15px", marginBottom: "8px" }}>งวดผ่อนที่ค้างชำระ</h3>
          {!report.outstanding.length ? <Empty text="ไม่มีงวดค้างชำระ" /> : (
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>คำสั่งซื้อ</th><th style={thStyle}>ผู้ซื้อ</th><th style={thStyle}>งวด</th><th style={thStyle}>ครบกำหนด</th><th style={{ ...thStyle, textAlign: "right" }}>ยอด</th></tr></thead>
              <tbody>{report.outstanding.map(r => (
                <tr key={`${r.order_id}-${r.seq}`} style={{ background: r.overdue ? "rgba(239,68,68,0.05)" : undefined }}>
                  <td style={tdStyle}><span style={{ fontFamily: "monospace" }}>{r.reference}</span><div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{r.title}</div></td>
                  <td style={tdStyle}>{r.user_name}</td>
                  <td style={tdStyle}>{r.seq}/{r.installment_count}{r.has_slip ? " · มีสลิป" : ""}</td>
                  <td style={{ ...tdStyle, color: r.overdue ? "var(--danger)" : undefined }}>{formatDateTime(r.due_at)}{r.overdue ? " (เลยกำหนด)" : ""}{r.suspended_at ? " · ระงับสิทธิ์" : ""}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{baht(r.amount)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>

        <div className="glass-card" style={{ overflowX: "auto" }}>
          <h3 style={{ fontSize: "15px", marginBottom: "8px" }}>คืนเงินในช่วงนี้</h3>
          {!report.refunds.length ? <Empty text="ไม่มีการคืนเงิน" /> : (
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>คำสั่งซื้อ</th><th style={thStyle}>ผู้ซื้อ</th><th style={thStyle}>วันที่</th><th style={thStyle}>ใบลดหนี้</th><th style={{ ...thStyle, textAlign: "right" }}>ยอด</th></tr></thead>
              <tbody>{report.refunds.map(r => (
                <tr key={r.id}><td style={tdStyle}><span style={{ fontFamily: "monospace" }}>{r.reference}</span><div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{r.title}</div></td>
                  <td style={tdStyle}>{r.user_name}</td><td style={tdStyle}>{formatDateTime(r.refunded_at)}</td><td style={{ ...tdStyle, fontFamily: "monospace" }}>{r.credit_note_no ?? "-"}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{baht(r.amount)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </>)}
    </div>
  );
};

export default SalesReports;
