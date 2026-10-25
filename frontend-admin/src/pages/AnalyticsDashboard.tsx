import React, { useEffect, useState } from "react";
import { Activity, BarChart3, MessageCircle, MessageSquare, RefreshCw, UserPlus, Wifi } from "lucide-react";
import { useApi, can } from "../hooks/useApi";
import { MetricsCard } from "../components/MetricsCard";
import { ErrorBox, Empty } from "../components/site-admin/ui";
import { LineChart } from "../components/analytics/LineChart";
import { NavTarget, RANGES, RangeKey, baht, formatDuration, rangeQuery, timeAgo } from "../components/analytics/format";

interface Kpis {
  total_users: number; new_signups: number; active_learners: number; converted_users: number; conversion_percent: number;
  sales_count: number; revenue: number; sales_30d_count: number; revenue_30d: number;
  learning_seconds: number; avg_learning_seconds: number; published_courses: number; categories: number;
}
interface SeriesPoint { key: string; signups: number; revenue: number; sales: number; active_learners: number }
interface DashboardData { range: { key: string; from: string; to: string; bucket: "day" | "month" }; kpis: Kpis; series: SeriesPoint[] }
interface EventItem { id: number; type: string; label: string; description: string; user_id: string | null; created_at: string; link: NavTarget | null }
interface OnlineUser { id: string; name: string; email: string; roles: string[]; last_seen_at: string; course_title: string | null; lesson_title: string | null }
interface Activity {
  new_users: Array<{ id: string; name: string; email: string; created_at: string; role: string }>;
  posts: Array<{ id: string; source: string; title: string; excerpt: string; is_reply: boolean; user_name: string | null; course_id: string | null; course_title: string | null; created_at: string }>;
  events: EventItem[];
  online: OnlineUser[];
}

type ChartTab = "signups" | "revenue" | "sales" | "active_learners";
const CHART_TABS: Array<[ChartTab, string]> = [["signups", "สมัครใหม่"], ["revenue", "รายได้"], ["sales", "ยอดขายสินค้า"], ["active_learners", "ผู้เรียนที่ใช้งาน"]];

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
  const [chart, setChart] = useState<ChartTab>("signups");
  const [data, setData] = useState<DashboardData | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (range === "custom" && (!from || !to || from > to)) { setError("กรุณาเลือกช่วงวันที่ให้ถูกต้อง"); return; }
    setLoading(true);
    setError(null);
    try {
      const [d, a] = await Promise.all([
        api.get<DashboardData>(`/analytics/dashboard?${rangeQuery(range, from, to)}`),
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

  const k = data?.kpis;
  const series = data?.series || [];
  const fmt = chart === "revenue" ? baht : (v: number) => Math.round(v).toLocaleString("th-TH");
  const rangeLabel = data ? `${data.range.from} ถึง ${data.range.to}` : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "10px" }}><BarChart3 size={24} color="var(--primary)" />แดชบอร์ดโรงเรียน</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>ภาพรวมผู้ใช้ ยอดขาย และการเรียน {rangeLabel && `(${rangeLabel})`}</p>
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

      {k && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
          <MetricsCard title="ผู้ใช้ทั้งหมด" value={k.total_users.toLocaleString("th-TH")} subValue={`สมัครใหม่ ${k.new_signups.toLocaleString("th-TH")} คนในช่วงนี้`} icon="Users" color="blue" />
          <MetricsCard title="ผู้เรียนที่ใช้งาน" value={k.active_learners.toLocaleString("th-TH")} subValue={`เวลาเรียนเฉลี่ย ${formatDuration(k.avg_learning_seconds)} ต่อคน`} icon="Activity" color="accent" />
          <MetricsCard title="อัตราการซื้อ/ลงทะเบียน" value={`${k.conversion_percent}%`} subValue={`${k.converted_users.toLocaleString("th-TH")} คนมีคำสั่งซื้อหรือคอร์ส`} icon="TrendingUp" color="purple" />
          <MetricsCard title="ยอดขาย 30 วัน" value={baht(k.revenue_30d)} subValue={`${k.sales_30d_count.toLocaleString("th-TH")} รายการ · ช่วงที่เลือก ${baht(k.revenue)}`} icon="Banknote" color="accent" />
          <MetricsCard title="คอร์สที่เผยแพร่" value={k.published_courses.toLocaleString("th-TH")} subValue={`${k.categories.toLocaleString("th-TH")} หมวดหมู่`} icon="BookOpen" color="blue" />
        </div>
      )}

      {data && (
        <div className="glass-card" style={card}>
          <div role="tablist" aria-label="กราฟ" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {CHART_TABS.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={chart === key} onClick={() => setChart(key)}
                className={chart === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "6px 14px", fontSize: "13px" }}>{label}</button>
            ))}
          </div>
          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            รวม {fmt(series.reduce((s, p) => s + p[chart], 0))}{chart === "active_learners" ? " (ผลรวมรายช่วง)" : ""} · แสดงเป็นราย{data.range.bucket === "day" ? "วัน" : "เดือน"}
          </div>
          <LineChart data={series.map(p => ({ key: p.key, value: p[chart] }))} format={fmt} label={CHART_TABS.find(t => t[0] === chart)![1]} />
        </div>
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

          <section className="glass-card" style={card} aria-label="บันทึกกิจกรรม">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ fontSize: "16px", display: "flex", gap: "8px", alignItems: "center" }}><Activity size={18} color="var(--primary)" />กิจกรรมล่าสุด</h3>
              {onNavigate && <button style={linkBtn} onClick={() => onNavigate({ tab: "reports", id: "events" })}>ดูทั้งหมด</button>}
            </div>
            {activity.events.length === 0 ? <Empty text="ยังไม่มีกิจกรรม" /> : (
              <div>{activity.events.map(e => (
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
