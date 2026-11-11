import React, { useEffect, useState } from "react";
import { Activity, BarChart3, MessageCircle, MessageSquare, RefreshCw, Table2, LineChart as LineIcon, UserPlus, Wifi } from "lucide-react";
import { useApi, can } from "../hooks/useApi";
import { ErrorBox, Empty } from "../components/site-admin/ui";
import { CapacityBars, Delta, Funnel, HBarList, Heatmap, LegendSwatch, MultiSeries, MultiTrendChart, SERIES_COLORS, TrendPoint, VIZ, bucketLabel } from "../components/analytics/charts";
import { NavTarget, RANGES, RangeKey, baht, formatDuration, rangeQuery, timeAgo } from "../components/analytics/format";

interface Metric { total: number; previous_total: number; series: TrendPoint[] }
type MetricKey = "signups" | "active_learners" | "revenue" | "orders" | "enrollments" | "completions" | "registrations" | "leads";
interface Insights {
  range: { key: string; from: string; to: string; bucket: "day" | "month" };
  previous: { from: string; to: string };
  metrics: Record<MetricKey, Metric>;
  funnel: Array<{ stage: string; label: string; count: number }>;
  paid_from_cohort: number;
  heatmap: Array<{ dow: number; hour: number; events: number; users: number }>;
  top_courses: Array<{ id: string; title: string; enrollments: number; learners: number; revenue: number; completion_percent: number; avg_progress: number }>;
  revenue_by_kind: Array<{ kind: string; orders: number; revenue: number }>;
  lead_sources: Array<{ source: string; count: number }>;
  upcoming_sessions: Array<{ id: string; title: string; start_date: string; capacity: number; taken: number; confirmed: number; waitlist: number }>;
}
interface EventItem { id: number; type: string; label: string; description: string; user_id: string | null; created_at: string; link: NavTarget | null }
interface OnlineUser { id: string; name: string; email: string; roles: string[]; last_seen_at: string; course_title: string | null; lesson_title: string | null }
interface Activity {
  new_users: Array<{ id: string; name: string; email: string; created_at: string; role: string }>;
  posts: Array<{ id: string; source: string; title: string; excerpt: string; is_reply: boolean; user_name: string | null; course_id: string | null; course_title: string | null; created_at: string }>;
  events: EventItem[];
  online: OnlineUser[];
}

/** The eight comparable metrics, in tile order; `money` formats in baht. */
const METRICS: Array<{ key: MetricKey; label: string; hint: string; money?: boolean }> = [
  { key: "signups", label: "ผู้เรียนสมัครใหม่", hint: "บัญชีผู้เรียนที่สร้างในช่วงนี้" },
  { key: "active_learners", label: "ผู้เรียนที่ใช้งาน", hint: "ผู้เรียนที่มีกิจกรรมการเรียน (ไม่นับซ้ำ)" },
  { key: "revenue", label: "รายได้", hint: "ยอดรับจริงของคำสั่งซื้อที่ชำระแล้ว", money: true },
  { key: "orders", label: "คำสั่งซื้อที่ชำระ", hint: "จำนวนคำสั่งซื้อที่ยืนยันการชำระแล้ว" },
  { key: "enrollments", label: "ลงทะเบียนเรียน", hint: "การลงทะเบียนเรียนคอร์สออนไลน์" },
  { key: "completions", label: "เรียนจบคอร์ส", hint: "การลงทะเบียนที่เรียนจบในช่วงนี้" },
  { key: "registrations", label: "ผู้สมัครรอบอบรม", hint: "จำนวนที่นั่งที่สมัคร (ไม่รวมที่ยกเลิก)" },
  { key: "leads", label: "Lead และข้อความติดต่อ", hint: "ฟอร์มเก็บ lead และฟอร์มติดต่อรวมกัน" }
];
const KIND_LABEL: Record<string, string> = { course: "คอร์สเดี่ยว", bundle: "ชุดคอร์ส", membership: "สมาชิกรายช่วง", organization: "องค์กร (ที่นั่ง)" };
const count = (v: number) => Math.round(v).toLocaleString("th-TH");

const todayBkk = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const daysAgoBkk = (n: number) => new Date(Date.now() + 7 * 3600000 - n * 86400000).toISOString().slice(0, 10);

const card: React.CSSProperties = { padding: "20px", display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 };
const listItem: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: "12px", padding: "10px 0", borderBottom: "1px solid rgba(0,0,0,0.05)", fontSize: "14px" };
const linkBtn: React.CSSProperties = { background: "none", border: "none", padding: 0, color: "var(--primary)", cursor: "pointer", fontSize: "13px", textAlign: "left" };

/**
 * School dashboard (reports.view): KPI cards, chart tabs with a range selector, and widgets for new users,
 * latest posts/Q&A, the events log and online users.
 * `onContact(userId)` opens a direct message (built by the communication module);
 * `onNavigate(target)` opens a console tab (e.g. {tab: "reports"}).
 */
export const AnalyticsDashboard: React.FC<{ onContact?: (userId: string) => void; onNavigate?: (target: NavTarget) => void }> = ({ onContact, onNavigate }) => {
  const api = useApi();
  const [range, setRange] = useState<RangeKey>("30d");
  const [from, setFrom] = useState(daysAgoBkk(29));
  const [to, setTo] = useState(todayBkk());
  const [selected, setSelected] = useState<MetricKey[]>(["signups"]);
  const [mode, setMode] = useState<"index" | "actual" | "multiples">("index");
  const [compare, setCompare] = useState(true);
  const [asTable, setAsTable] = useState(false);
  const [data, setData] = useState<Insights | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (range === "custom" && (!from || !to || from > to)) { setError("กรุณาเลือกช่วงวันที่ให้ถูกต้อง"); return; }
    setLoading(true);
    setError(null);
    try {
      const [d, a] = await Promise.all([
        api.get<Insights>(`/analytics/insights?${rangeQuery(range, from, to)}`),
        api.get<Activity>("/analytics/activity")
      ]);
      setData(d);
      setActivity(a);
    } catch (err: any) {
      setError(err.message || "โหลดแดชบอร์ดไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (range !== "custom") load(); }, [range, api.token]);
  // Online users refresh every minute.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      api.get<{ users: OnlineUser[] }>("/analytics/online").then(r => setActivity(a => a ? { ...a, online: r.users } : a)).catch(() => undefined);
    }, 60000);
    return () => window.clearInterval(timer);
  }, [api.token]);

  if (!can(api.user, "reports.view")) {
    return <div className="glass-card" style={{ padding: "40px", textAlign: "center" }}><h2 style={{ color: "var(--danger)" }}>ต้องมีสิทธิ์ดูรายงาน</h2></div>;
  }

  const unit = data?.range.bucket === "day" ? "วัน" : "เดือน";
  const rangeLabel = data ? `${bucketLabel(data.range.from, true)} – ${bucketLabel(data.range.to, true)}` : "";
  const prevLabel = data ? `${bucketLabel(data.previous.from, true)} – ${bucketLabel(data.previous.to, true)}` : "";
  const picked = METRICS.filter(m => selected.includes(m.key));
  // Real values share one axis only when every picked metric has the same unit (no baht mixed with counts).
  const actualAllowed = picked.length === 1 || picked.every(m => !m.money);
  const chartMode = picked.length === 1 ? "actual" : mode === "actual" && !actualAllowed ? "index" : mode;
  const lines: MultiSeries[] = data ? picked.map(m => ({
    id: m.key, label: m.label, color: SERIES_COLORS[METRICS.indexOf(m)], points: data.metrics[m.key].series, format: m.money ? baht : count
  })) : [];
  const toggle = (key: MetricKey) => setSelected(prev => prev.includes(key) ? (prev.length > 1 ? prev.filter(k => k !== key) : prev) : [...prev, key]);
  const one = picked.length === 1 ? picked[0] : null;
  const oneMetric = one && data ? data.metrics[one.key] : null;
  const peakPoint = oneMetric?.series.reduce<TrendPoint | null>((best, p) => !best || p.value > best.value ? p : best, null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "10px" }}><BarChart3 size={24} color="var(--primary)" />แดชบอร์ดโรงเรียน</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>วิเคราะห์ผู้เรียน ยอดขาย และงานอบรม {rangeLabel && `(${rangeLabel} เทียบ ${prevLabel})`} · เลือกหัวข้อทางซ้ายเพื่อดูและเทียบแนวโน้ม</p>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          {RANGES.map(([key, label]) => (
            <button key={key} onClick={() => setRange(key)} className={range === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "6px 12px", fontSize: "13px" }}>{label}</button>
          ))}
          {range === "custom" && (
            <form onSubmit={e => { e.preventDefault(); load(); }} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input type="date" className="form-input" value={from} max={to} onChange={e => setFrom(e.target.value)} aria-label="ตั้งแต่วันที่" />
              <span>–</span>
              <input type="date" className="form-input" value={to} min={from} onChange={e => setTo(e.target.value)} aria-label="ถึงวันที่" />
              <button type="submit" className="tech-button-primary" style={{ padding: "6px 12px", fontSize: "13px" }}>แสดง</button>
            </form>
          )}
          <button className="tech-button-outline" onClick={load} aria-label="รีเฟรช" style={{ padding: "6px 10px" }}><RefreshCw size={16} /></button>
          {onNavigate && <button className="tech-button-outline" onClick={() => onNavigate({ tab: "reports" })} style={{ padding: "6px 12px", fontSize: "13px" }}>รายงานทั้งหมด</button>}
        </div>
      </div>

      <ErrorBox message={error} />
      {loading && !data && <Empty text="กำลังโหลดข้อมูล…" />}

      {data && (
        <>
          <section className="glass-card" style={{ ...card, padding: 0, gap: 0 }} aria-label="ตัวชี้วัดและแนวโน้ม">
            <div className="np-analysis-grid">
              <div style={{ borderRight: "1px solid rgba(15,23,42,0.06)", padding: "16px 12px 16px 16px", display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 4px 6px" }}>
                  <h3 style={{ fontSize: 15 }}>หัวข้อ</h3>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>เลือกได้หลายหัวข้อ</span>
                </div>
                {METRICS.map((m, i) => {
                  const value = data.metrics[m.key];
                  const on = selected.includes(m.key);
                  return (
                    <button key={m.key} onClick={() => toggle(m.key)} aria-pressed={on} title={m.hint}
                      style={{ display: "grid", gridTemplateColumns: "14px minmax(0, 1fr) auto", gap: "2px 10px", alignItems: "center", textAlign: "left", font: "inherit", color: "inherit",
                        cursor: "pointer", padding: "8px 10px", borderRadius: 10, border: "1px solid", borderColor: on ? "rgba(15,23,42,0.12)" : "transparent",
                        background: on ? "#fff" : "transparent", boxShadow: on ? "0 1px 3px rgba(15,23,42,0.06)" : "none" }}>
                      <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, border: `2px solid ${SERIES_COLORS[i]}`, background: on ? SERIES_COLORS[i] : "transparent", gridRow: "1 / 3" }} />
                      <span style={{ fontSize: 13, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.label}</span>
                      <span style={{ fontSize: 15, fontWeight: 700, textAlign: "right" }}>{m.money ? baht(value.total) : count(value.total)}</span>
                      <span style={{ gridColumn: "2 / 4" }}><Delta current={value.total} previous={value.previous_total} compact /></span>
                    </button>
                  );
                })}
              </div>

              <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <h3 style={{ fontSize: 16 }}>{one ? `${one.label} ราย${unit}` : `เทียบแนวโน้ม ${picked.length} หัวข้อ ราย${unit}`}</h3>
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 2 }}>
                      {one && oneMetric ? <>
                        รวม <strong>{(one.money ? baht : count)(oneMetric.total)}</strong>{compare && <> · ช่วงก่อน {(one.money ? baht : count)(oneMetric.previous_total)}</>}
                        {peakPoint && peakPoint.value > 0 && <> · สูงสุด {(one.money ? baht : count)(peakPoint.value)} ({bucketLabel(peakPoint.key)})</>}
                        {one.key === "active_learners" && " · ยอดรวมนับคนไม่ซ้ำทั้งช่วง"}
                      </> : chartMode === "index" ? "แต่ละเส้นเทียบกับค่าสูงสุดของตัวเองในช่วงนี้ (100% = สูงสุด) จึงเทียบจังหวะขึ้นลงได้แม้หน่วยต่างกัน · ชี้เพื่อดูค่าจริง"
                        : chartMode === "actual" ? "ค่าจริงบนแกนเดียวกัน (จำนวนนับ)" : "แยกกราฟต่อหัวข้อ แต่ละกราฟมีแกนของตัวเอง"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {picked.length > 1 && (
                      <div role="radiogroup" aria-label="รูปแบบกราฟ" style={{ display: "inline-flex", border: "1px solid rgba(15,23,42,0.12)", borderRadius: 999, padding: 2 }}>
                        {([["index", "เทียบสัดส่วน"], ["actual", "ค่าจริง"], ["multiples", "แยกกราฟ"]] as const).map(([key, label]) => {
                          const disabled = key === "actual" && !actualAllowed;
                          return (
                            <button key={key} role="radio" aria-checked={chartMode === key} disabled={disabled} onClick={() => setMode(key)}
                              title={disabled ? "รายได้ (บาท) กับจำนวนนับใช้แกนเดียวกันไม่ได้ เลือก “เทียบสัดส่วน” หรือ “แยกกราฟ”" : undefined}
                              style={{ border: 0, borderRadius: 999, padding: "5px 12px", fontSize: 12, font: "inherit", cursor: disabled ? "not-allowed" : "pointer",
                                background: chartMode === key ? VIZ.current : "transparent", color: chartMode === key ? "#fff" : disabled ? "var(--text-muted)" : "var(--text-primary)" }}>{label}</button>
                          );
                        })}
                      </div>
                    )}
                    {one && (
                      <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                        <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} />เทียบช่วงก่อนหน้า
                      </label>
                    )}
                    <button className="tech-button-outline" onClick={() => setAsTable(v => !v)} style={{ padding: "6px 10px", fontSize: 13 }}>
                      {asTable ? <><LineIcon size={14} />ดูเป็นกราฟ</> : <><Table2 size={14} />ดูเป็นตาราง</>}
                    </button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  {lines.map(l => <LegendSwatch key={l.id} color={l.color} label={l.label} />)}
                  {one && compare && <LegendSwatch color={lines[0].color} dashed label={`ช่วงก่อนหน้า (${prevLabel})`} />}
                </div>
                {asTable ? (
                  <div style={{ overflowX: "auto", maxHeight: 340 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead><tr>{["ช่วง", ...picked.map(m => m.label), ...(one && compare ? ["ช่วงก่อนหน้า", "เปลี่ยนแปลง"] : [])].map(h => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: "var(--text-muted)", fontWeight: 600, borderBottom: "1px solid rgba(0,0,0,0.08)", position: "sticky", top: 0, background: "#fff", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
                      <tbody>{(lines[0]?.points ?? []).map((p, i) => (
                        <tr key={p.key}>
                          <td style={{ padding: "6px 8px", borderBottom: "1px solid rgba(0,0,0,0.04)", whiteSpace: "nowrap" }}>{bucketLabel(p.key, true)}</td>
                          {lines.map(l => <td key={l.id} style={{ padding: "6px 8px", borderBottom: "1px solid rgba(0,0,0,0.04)", fontWeight: 600 }}>{l.format(l.points[i].value)}</td>)}
                          {one && compare && <>
                            <td style={{ padding: "6px 8px", borderBottom: "1px solid rgba(0,0,0,0.04)" }}>{p.previous === null ? "-" : `${lines[0].format(p.previous)} (${p.previous_key ? bucketLabel(p.previous_key) : ""})`}</td>
                            <td style={{ padding: "6px 8px", borderBottom: "1px solid rgba(0,0,0,0.04)" }}>{p.previous === null ? "-" : <Delta current={p.value} previous={p.previous} compact />}</td>
                          </>}
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                ) : chartMode === "multiples" ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
                    {lines.map(l => (
                      <div key={l.id}>
                        <div style={{ fontSize: 13, fontWeight: 600, display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <LegendSwatch color={l.color} label={l.label} />
                          <span>{l.format(data.metrics[l.id as MetricKey].total)}</span>
                        </div>
                        <MultiTrendChart series={[l]} mode="actual" showPrevious={false} height={170} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <MultiTrendChart series={lines} mode={chartMode} showPrevious={!!one && compare} height={420} />
                )}
              </div>
            </div>
          </section>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "16px" }}>
            <section className="glass-card" style={card} aria-label="เส้นทางผู้เรียน">
              <div>
                <h3 style={{ fontSize: 16 }}>เส้นทางผู้เรียนใหม่</h3>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>ผู้เรียนที่สมัครในช่วงนี้ ไปถึงแต่ละขั้นแล้วกี่คน · ซื้อคอร์สแล้ว {count(data.paid_from_cohort)} คน</div>
              </div>
              <Funnel stages={data.funnel} />
            </section>
            <section className="glass-card" style={card} aria-label="ช่วงเวลาที่เรียน">
              <div>
                <h3 style={{ fontSize: 16 }}>ช่วงเวลาที่ผู้เรียนเข้าเรียน</h3>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>จำนวนกิจกรรมการเรียนตามวันและชั่วโมง (เวลาไทย) ใช้วางแผนเวลาประกาศหรือ live</div>
              </div>
              <Heatmap cells={data.heatmap} />
            </section>
          </div>

          <section className="glass-card" style={card} aria-label="คอร์สเด่น">
            <div>
              <h3 style={{ fontSize: 16 }}>คอร์สเด่นในช่วงนี้</h3>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>เรียงตามการลงทะเบียนในช่วงนี้ · อัตราเรียนจบและความคืบหน้าเฉลี่ยนับจากผู้เรียนทั้งหมดของคอร์ส</div>
            </div>
            {data.top_courses.length === 0 ? <Empty text="ยังไม่มีคอร์สที่เผยแพร่" /> : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr>{["คอร์ส", "ลงทะเบียนช่วงนี้", "ผู้เรียนทั้งหมด", "เรียนจบ", "ความคืบหน้าเฉลี่ย", "รายได้ช่วงนี้"].map((h, i) => <th key={h} style={{ textAlign: i ? "right" : "left", padding: "8px", color: "var(--text-muted)", fontWeight: 600, borderBottom: "1px solid rgba(0,0,0,0.08)", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
                  <tbody>{(() => {
                    const maxEnroll = Math.max(...data.top_courses.map(c => c.enrollments), 1);
                    return data.top_courses.map(co => (
                      <tr key={co.id}>
                        <td style={{ padding: "8px", borderBottom: "1px solid rgba(0,0,0,0.04)", maxWidth: 320 }}>
                          {onNavigate ? <button style={{ ...linkBtn, color: "var(--text-primary)", fontSize: 13 }} onClick={() => onNavigate({ tab: "reports", id: co.id })}>{co.title}</button> : co.title}
                        </td>
                        <td style={{ padding: "8px", borderBottom: "1px solid rgba(0,0,0,0.04)", textAlign: "right", minWidth: 140 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                            <div style={{ flex: 1, maxWidth: 80, height: 6, background: VIZ.track, borderRadius: 3 }}><div style={{ width: `${(co.enrollments / maxEnroll) * 100}%`, height: "100%", background: VIZ.current, borderRadius: 3 }} /></div>
                            <strong>{count(co.enrollments)}</strong>
                          </div>
                        </td>
                        <td style={{ padding: "8px", borderBottom: "1px solid rgba(0,0,0,0.04)", textAlign: "right" }}>{count(co.learners)}</td>
                        <td style={{ padding: "8px", borderBottom: "1px solid rgba(0,0,0,0.04)", textAlign: "right" }}>{co.completion_percent}%</td>
                        <td style={{ padding: "8px", borderBottom: "1px solid rgba(0,0,0,0.04)", textAlign: "right" }}>{co.avg_progress}%</td>
                        <td style={{ padding: "8px", borderBottom: "1px solid rgba(0,0,0,0.04)", textAlign: "right" }}>{baht(co.revenue)}</td>
                      </tr>
                    ));
                  })()}</tbody>
                </table>
              </div>
            )}
          </section>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
            <section className="glass-card" style={card} aria-label="รายได้ตามประเภท">
              <h3 style={{ fontSize: 16 }}>รายได้ตามประเภทสินค้า</h3>
              <HBarList items={data.revenue_by_kind.map(r => ({ label: `${KIND_LABEL[r.kind] ?? r.kind} (${count(r.orders)} รายการ)`, value: r.revenue }))} format={baht} empty="ยังไม่มีคำสั่งซื้อที่ชำระในช่วงนี้" />
            </section>
            <section className="glass-card" style={card} aria-label="ที่มาของ lead">
              <h3 style={{ fontSize: 16 }}>ที่มาของ lead และข้อความติดต่อ</h3>
              <HBarList items={data.lead_sources.map(r => ({ label: r.source, value: r.count }))} format={count} color={VIZ.previous} empty="ยังไม่มี lead ในช่วงนี้" />
            </section>
            <section className="glass-card" style={card} aria-label="รอบอบรมที่กำลังจะมาถึง">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: 16 }}>ที่นั่งรอบอบรมที่กำลังจะมาถึง</h3>
                {onNavigate && <button style={linkBtn} onClick={() => onNavigate({ tab: "site" })}>จัดการรอบ</button>}
              </div>
              <CapacityBars rows={data.upcoming_sessions} />
            </section>
          </div>
        </>
      )}

      {activity && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "16px" }}>
          <section className="glass-card" style={card} aria-label="ผู้ใช้ใหม่">
            <h3 style={{ fontSize: "16px", display: "flex", gap: "8px", alignItems: "center" }}><UserPlus size={18} color="var(--primary)" />ผู้ใช้ใหม่</h3>
            {activity.new_users.length === 0 ? <Empty text="ยังไม่มีผู้ใช้ใหม่" /> : (
              <div>{activity.new_users.map(u => (
                <div key={u.id} style={listItem}>
                  <div style={{ minWidth: 0 }}>
                    {onNavigate ? <button style={{ ...linkBtn, fontSize: "14px", fontWeight: 600 }} onClick={() => onNavigate({ tab: "users", id: u.id })}>{u.name}</button> : <strong>{u.name}</strong>}
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</div>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{timeAgo(u.created_at)}</span>
                </div>
              ))}</div>
            )}
          </section>

          <section className="glass-card" style={card} aria-label="ผู้ใช้ออนไลน์">
            <h3 style={{ fontSize: "16px", display: "flex", gap: "8px", alignItems: "center" }}><Wifi size={18} color="var(--accent)" />ออนไลน์ตอนนี้ ({activity.online.length})</h3>
            {activity.online.length === 0 ? <Empty text="ไม่มีผู้ใช้ออนไลน์ใน 5 นาทีที่ผ่านมา" /> : (
              <div>{activity.online.map(u => (
                <div key={u.id} style={listItem}>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 99, background: "var(--accent)", display: "inline-block" }} />{u.name}
                    </strong>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {u.course_title ? `กำลังเรียน ${u.course_title}${u.lesson_title ? ` · ${u.lesson_title}` : ""}` : u.email}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
                    <span style={{ fontSize: "12px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{timeAgo(u.last_seen_at)}</span>
                    {onContact && u.id !== api.user?.id && (
                      <button style={{ ...linkBtn, display: "flex", gap: "4px", alignItems: "center" }} onClick={() => onContact(u.id)}><MessageCircle size={14} />ส่งข้อความ</button>
                    )}
                  </div>
                </div>
              ))}</div>
            )}
          </section>

          <section className="glass-card" style={card} aria-label="โพสต์และคำถามล่าสุด">
            <h3 style={{ fontSize: "16px", display: "flex", gap: "8px", alignItems: "center" }}><MessageSquare size={18} color="var(--secondary)" />โพสต์และคำถามล่าสุด</h3>
            {activity.posts.length === 0 ? <Empty text="ยังไม่มีโพสต์หรือคำถาม" /> : (
              <div>{activity.posts.map(p => (
                <div key={`${p.source}-${p.id}`} style={{ ...listItem, flexDirection: "column", gap: "4px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                    <strong style={{ fontSize: "13px" }}>{p.user_name || "ผู้ใช้"} · {p.source === "qa" ? (p.is_reply ? "ตอบคำถาม" : "ถามคำถาม") : "โพสต์"}</strong>
                    <span style={{ fontSize: "12px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{timeAgo(p.created_at)}</span>
                  </div>
                  <div style={{ color: "var(--text-secondary)" }}>{p.excerpt}</div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{[p.course_title, p.title].filter(Boolean).join(" · ")}</div>
                </div>
              ))}</div>
            )}
          </section>

          <section className="glass-card" style={{ ...card, gridColumn: "1 / -1" }} aria-label="บันทึกกิจกรรม">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ fontSize: "16px", display: "flex", gap: "8px", alignItems: "center" }}><Activity size={18} color="var(--primary)" />กิจกรรมล่าสุด</h3>
              {onNavigate && <button style={linkBtn} onClick={() => onNavigate({ tab: "reports", id: "events" })}>ดูทั้งหมด</button>}
            </div>
            {activity.events.length === 0 ? <Empty text="ยังไม่มีกิจกรรม" /> : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(420px, 100%), 1fr))", columnGap: 32 }}>{activity.events.map(e => (
                <div key={e.id} style={listItem}>
                  {onNavigate && e.link ? <button style={{ ...linkBtn, color: "var(--text-primary)", fontSize: "14px" }} onClick={() => onNavigate(e.link!)}>{e.description}</button> : <span>{e.description}</span>}
                  <span style={{ fontSize: "12px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{timeAgo(e.created_at)}</span>
                </div>
              ))}</div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};

export default AnalyticsDashboard;
