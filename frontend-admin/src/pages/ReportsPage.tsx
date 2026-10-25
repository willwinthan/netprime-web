import React, { useEffect, useState } from "react";
import { ArrowLeft, Download, FileBarChart, RefreshCw, Search } from "lucide-react";
import { useApi, can, hasRole } from "../hooks/useApi";
import { Chip, ErrorBox, Empty, tableStyle, thStyle, tdStyle, formatDateTime, downloadWithAuth } from "../components/site-admin/ui";
import { LineChart, bucketLabel } from "../components/analytics/LineChart";
import { NavTarget, RANGES, RangeKey, baht, formatDuration, rangeQuery, timeAgo } from "../components/analytics/format";

type ReportTab = "courses" | "learners" | "revenue" | "events" | "assessments";

interface CourseRow { id: string; title: string; status: string; instructor_name: string | null; enrolled: number; completed: number; active: number;
  completion_rate: number; avg_progress: number; avg_seconds: number }
interface CourseDetail {
  course: { id: string; title: string; status: string }; enrolled: number;
  lessons: Array<{ id: string; title: string; reached: number; reached_percent: number; completed: number }>;
  learners: Array<{ id: string; name: string; email: string; progress_percent: number; status: string; enrolled_at: string; completed_at: string | null; seconds: number; last_activity: string | null }>;
}
interface LearnerRow { id: string; name: string; email: string; courses: number; completed: number; avg_progress: number; seconds: number; certificates: number; last_activity: string | null; course_titles: string | null }
interface Revenue {
  from: string; to: string; group: "day" | "month";
  totals: { count: number; revenue: number; refunds_count: number; refunds_amount: number };
  by_period: Array<{ key: string; count: number; revenue: number }>;
  by_course: Array<{ course_id: string; course_title: string | null; count: number; revenue: number }>;
  by_voucher: Array<{ voucher_code: string; count: number; revenue: number; discount: number }>;
  refunds: Array<{ id: string; reference: string; receipt_no: string | null; user_name: string; user_email: string; course_title: string | null; amount: number; refunded_at: string; staff_note: string | null }>;
}
interface EventRow { id: number; type: string; label: string; description: string; user_name: string | null; user_email: string | null; course_title: string | null; created_at: string; link: NavTarget | null }

const COURSE_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  draft: { label: "ฉบับร่าง", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" },
  review: { label: "รอตรวจ", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  published: { label: "เผยแพร่", color: "var(--accent)", bg: "var(--accent-glow)" },
  archived: { label: "เก็บถาวร", color: "var(--text-muted)", bg: "rgba(100,116,139,0.08)" }
};

const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 7 * 3600000 - n * 86400000).toISOString().slice(0, 10);
const small: React.CSSProperties = { padding: "6px 12px", fontSize: "13px" };
const section: React.CSSProperties = { padding: "20px", display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 };
const scroll: React.CSSProperties = { overflowX: "auto" };

const Bar: React.FC<{ percent: number }> = ({ percent }) => (
  <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: "140px" }}>
    <div className="progress-bar-container" style={{ height: "6px", flex: 1 }}>
      <div className="progress-bar-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
    <span style={{ fontSize: "12px", color: "var(--text-secondary)", width: "44px", textAlign: "right" }}>{percent}%</span>
  </div>
);

/** Range buttons shared by the report tabs. */
const RangePicker: React.FC<{ range: RangeKey; from: string; to: string; onChange: (r: RangeKey, from: string, to: string) => void }> = ({ range, from, to, onChange }) => {
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  return (
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
      {RANGES.map(([key, label]) => (
        <button key={key} className={range === key ? "tech-button-primary" : "tech-button-outline"} style={small}
          onClick={() => key === "custom" ? onChange("custom", f, t) : onChange(key, from, to)}>{label}</button>
      ))}
      {range === "custom" && (
        <form onSubmit={e => { e.preventDefault(); if (f && t && f <= t) onChange("custom", f, t); }} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <input type="date" className="form-input" value={f} max={t} onChange={e => setF(e.target.value)} aria-label="ตั้งแต่วันที่" />
          <span>–</span>
          <input type="date" className="form-input" value={t} min={f} onChange={e => setT(e.target.value)} aria-label="ถึงวันที่" />
          <button type="submit" className="tech-button-primary" style={small}>แสดง</button>
        </form>
      )}
    </div>
  );
};

/**
 * Reports (reports.view; instructors see their own courses): courses with lesson drop-off, learners,
 * revenue (period, course, voucher, refunds) and the events log, each with CSV export.
 * `assessmentsSlot` renders the exam/assignment reports built by the assessments module.
 */
export const ReportsPage: React.FC<{
  onNavigate?: (target: NavTarget) => void;
  initialTab?: ReportTab;
  /** Opens a course's detail report (e.g. from an event link {tab: "reports", id: courseId}). */
  initialCourseId?: string;
  assessmentsSlot?: React.ReactNode;
}> = ({ onNavigate, initialTab, initialCourseId, assessmentsSlot }) => {
  const api = useApi();
  const allowed = can(api.user, "reports.view") || hasRole(api.user, "instructor");
  const [tab, setTab] = useState<ReportTab>(initialTab || (initialCourseId === "events" ? "events" : "courses"));
  const [range, setRange] = useState<RangeKey>("30d");
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [courseId, setCourseId] = useState<string | null>(initialCourseId && initialCourseId !== "events" ? initialCourseId : null);
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [learners, setLearners] = useState<{ rows: LearnerRow[]; total: number; page: number }>({ rows: [], total: 0, page: 1 });
  const [learnerQuery, setLearnerQuery] = useState("");
  const [learnerSearch, setLearnerSearch] = useState("");
  const [revenue, setRevenue] = useState<Revenue | null>(null);
  const [events, setEvents] = useState<{ rows: EventRow[]; total: number; page: number; types: Record<string, string> }>({ rows: [], total: 0, page: 1, types: {} });
  const [eventFilter, setEventFilter] = useState({ user: "", type: "", course: "", from: "", to: "" });
  const [eventApplied, setEventApplied] = useState(eventFilter);
  const [reloadKey, setReloadKey] = useState(0);

  const rq = rangeQuery(range, from, to);
  const run = async (task: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    try { await task(); } catch (err: any) { setError(err.message || "โหลดรายงานไม่สำเร็จ"); } finally { setLoading(false); }
  };

  const loadCourses = () => run(async () => setCourses((await api.get<{ courses: CourseRow[] }>(`/reports/courses?${rq}`)).courses));
  const loadDetail = (id: string) => run(async () => setDetail(await api.get<CourseDetail>(`/reports/courses/${encodeURIComponent(id)}`)));
  const loadLearners = (page = 1) => run(async () => {
    const r = await api.get<{ learners: LearnerRow[]; total: number; page: number }>(`/reports/learners?page=${page}&limit=50${learnerSearch ? `&q=${encodeURIComponent(learnerSearch)}` : ""}`);
    setLearners({ rows: r.learners, total: r.total, page: r.page });
  });
  const loadRevenue = () => run(async () => setRevenue(await api.get<Revenue>(`/reports/revenue?${rq}`)));
  const eventQuery = (f: typeof eventFilter) => Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const loadEvents = (page = 1) => run(async () => {
    const r = await api.get<{ events: EventRow[]; total: number; page: number; types: Record<string, string> }>(`/analytics/events?page=${page}&limit=50&${eventQuery(eventApplied)}`);
    setEvents({ rows: r.events, total: r.total, page: r.page, types: r.types });
  });

  useEffect(() => {
    if (!allowed) return;
    if (tab === "courses") { if (courseId) loadDetail(courseId); else loadCourses(); }
    if (tab === "learners") loadLearners(1);
    if (tab === "revenue") loadRevenue();
    if (tab === "events") loadEvents(1);
  }, [tab, rq, courseId, learnerSearch, eventApplied, reloadKey, api.token]);

  const exportCsv = async (path: string, filename: string) => {
    try { await downloadWithAuth(path, api.token, filename); } catch (err: any) { setError(err.message || "ดาวน์โหลดไม่สำเร็จ"); }
  };

  if (!allowed) {
    return <div className="glass-card" style={{ padding: "40px", textAlign: "center" }}><h2 style={{ color: "var(--danger)" }}>ต้องมีสิทธิ์ดูรายงาน</h2></div>;
  }
  const ownOnly = !can(api.user, "reports.view");
  const tabs: Array<[ReportTab, string]> = [["courses", "คอร์ส"], ["learners", "ผู้เรียน"], ["revenue", "รายได้"], ["events", "บันทึกกิจกรรม"]];
  if (assessmentsSlot) tabs.push(["assessments", "ข้อสอบและงาน"]);
  const pager = (page: number, total: number, onPage: (p: number) => void) => total > 50 && (
    <div style={{ display: "flex", gap: "8px", alignItems: "center", justifyContent: "flex-end", fontSize: "13px" }}>
      <button className="tech-button-outline" style={small} disabled={page <= 1} onClick={() => onPage(page - 1)}>ก่อนหน้า</button>
      <span>หน้า {page} / {Math.ceil(total / 50)} ({total.toLocaleString("th-TH")} รายการ)</span>
      <button className="tech-button-outline" style={small} disabled={page * 50 >= total} onClick={() => onPage(page + 1)}>ถัดไป</button>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <h1 style={{ fontSize: "24px", display: "flex", alignItems: "center", gap: "10px" }}><FileBarChart size={24} color="var(--primary)" />รายงาน</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
          {ownOnly ? "รายงานเฉพาะคอร์สที่คุณสอน" : "รายงานคอร์ส ผู้เรียน รายได้ และบันทึกกิจกรรม"} · ส่งออก CSV เปิดด้วย Excel ได้
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }} role="tablist">
        {tabs.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={tab === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "6px 14px", fontSize: "13px" }}>{label}</button>
        ))}
        <button className="tech-button-outline" style={{ padding: "6px 10px" }} aria-label="รีเฟรช" onClick={() => setReloadKey(k => k + 1)}><RefreshCw size={16} /></button>
      </div>

      <ErrorBox message={error} />
      {loading && <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>กำลังโหลด…</div>}

      {tab === "courses" && !courseId && (
        <section className="glass-card" style={section}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
            <RangePicker range={range} from={from} to={to} onChange={(r, f, t) => { setRange(r); setFrom(f); setTo(t); }} />
            <button className="tech-button-outline" style={small} onClick={() => exportCsv(`/reports/courses?format=csv&${rq}`, `course-report.csv`)}><Download size={14} />CSV</button>
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>"ใช้งาน" คือผู้เรียนที่มีกิจกรรมหรือเวลาเรียนในช่วงที่เลือก</p>
          {courses.length === 0 ? <Empty text="ยังไม่มีคอร์ส" /> : (
            <div style={scroll}><table style={tableStyle}>
              <thead><tr>
                <th style={thStyle}>คอร์ส</th><th style={thStyle}>ลงทะเบียน</th><th style={thStyle}>ใช้งาน</th><th style={thStyle}>อัตราเรียนจบ</th>
                <th style={thStyle}>ความคืบหน้าเฉลี่ย</th><th style={thStyle}>เวลาเฉลี่ย/คน</th>
              </tr></thead>
              <tbody>{courses.map(c => (
                <tr key={c.id}>
                  <td style={tdStyle}>
                    <button onClick={() => setCourseId(c.id)} style={{ background: "none", border: "none", padding: 0, color: "var(--primary)", cursor: "pointer", fontWeight: 600, textAlign: "left" }}>{c.title}</button>
                    <div style={{ display: "flex", gap: "6px", marginTop: "4px", alignItems: "center" }}>
                      {COURSE_STATUS[c.status] && <Chip {...COURSE_STATUS[c.status]} />}
                      {!ownOnly && c.instructor_name && <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{c.instructor_name}</span>}
                    </div>
                  </td>
                  <td style={tdStyle}>{c.enrolled.toLocaleString("th-TH")}</td>
                  <td style={tdStyle}>{c.active.toLocaleString("th-TH")}</td>
                  <td style={tdStyle}><Bar percent={c.completion_rate} /></td>
                  <td style={tdStyle}><Bar percent={c.avg_progress} /></td>
                  <td style={tdStyle}>{formatDuration(c.avg_seconds)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}

      {tab === "courses" && courseId && (
        <section className="glass-card" style={section}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
            <button className="tech-button-outline" style={small} onClick={() => { setCourseId(null); setDetail(null); }}><ArrowLeft size={14} />ทุกคอร์ส</button>
            <div style={{ display: "flex", gap: "8px" }}>
              <button className="tech-button-outline" style={small} onClick={() => exportCsv(`/reports/courses/${encodeURIComponent(courseId)}?format=csv&section=lessons`, `course-${courseId}-lessons.csv`)}><Download size={14} />CSV บทเรียน</button>
              <button className="tech-button-outline" style={small} onClick={() => exportCsv(`/reports/courses/${encodeURIComponent(courseId)}?format=csv&section=learners`, `course-${courseId}-learners.csv`)}><Download size={14} />CSV ผู้เรียน</button>
            </div>
          </div>
          {detail && detail.course.id === courseId && (
            <>
              <h2 style={{ fontSize: "18px" }}>{detail.course.title}</h2>
              <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>ผู้ลงทะเบียน {detail.enrolled.toLocaleString("th-TH")} คน · การลดลงระหว่างบทเรียน (ผู้เรียนที่มาถึงแต่ละบท)</p>
              {detail.lessons.length === 0 ? <Empty text="คอร์สนี้ยังไม่มีบทเรียน" /> : (
                <div style={scroll}><table style={tableStyle}>
                  <thead><tr><th style={thStyle}>#</th><th style={thStyle}>บทเรียน</th><th style={thStyle}>มาถึง</th><th style={thStyle}>ร้อยละของผู้ลงทะเบียน</th><th style={thStyle}>เรียนจบบทนี้</th></tr></thead>
                  <tbody>{detail.lessons.map((l, i) => (
                    <tr key={l.id}><td style={tdStyle}>{i + 1}</td><td style={tdStyle}>{l.title}</td><td style={tdStyle}>{l.reached}</td><td style={tdStyle}><Bar percent={l.reached_percent} /></td><td style={tdStyle}>{l.completed}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
              <h3 style={{ fontSize: "16px", marginTop: "8px" }}>ผู้เรียน</h3>
              {detail.learners.length === 0 ? <Empty text="ยังไม่มีผู้ลงทะเบียน" /> : (
                <div style={scroll}><table style={tableStyle}>
                  <thead><tr><th style={thStyle}>ผู้เรียน</th><th style={thStyle}>ความคืบหน้า</th><th style={thStyle}>เวลาเรียน</th><th style={thStyle}>ใช้งานล่าสุด</th><th style={thStyle}>ลงทะเบียนเมื่อ</th></tr></thead>
                  <tbody>{detail.learners.map(l => (
                    <tr key={l.id}>
                      <td style={tdStyle}><strong>{l.name}</strong><div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{l.email}</div></td>
                      <td style={tdStyle}><Bar percent={l.progress_percent} /></td>
                      <td style={tdStyle}>{formatDuration(l.seconds)}</td>
                      <td style={tdStyle}>{timeAgo(l.last_activity)}</td>
                      <td style={tdStyle}>{formatDateTime(l.enrolled_at)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </>
          )}
        </section>
      )}

      {tab === "learners" && (
        <section className="glass-card" style={section}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
            <form onSubmit={e => { e.preventDefault(); setLearnerSearch(learnerQuery.trim()); }} style={{ display: "flex", gap: "8px" }}>
              <input className="form-input" value={learnerQuery} onChange={e => setLearnerQuery(e.target.value)} placeholder="ชื่อหรืออีเมล" aria-label="ค้นหาผู้เรียน" style={{ minWidth: "220px" }} />
              <button type="submit" className="tech-button-outline" style={{ padding: "8px 12px" }} aria-label="ค้นหา"><Search size={16} /></button>
            </form>
            <button className="tech-button-outline" style={small} onClick={() => exportCsv(`/reports/learners?format=csv${learnerSearch ? `&q=${encodeURIComponent(learnerSearch)}` : ""}`, "learner-report.csv")}><Download size={14} />CSV</button>
          </div>
          {learners.rows.length === 0 ? <Empty text="ไม่พบผู้เรียน" /> : (
            <div style={scroll}><table style={tableStyle}>
              <thead><tr><th style={thStyle}>ผู้เรียน</th><th style={thStyle}>คอร์ส</th><th style={thStyle}>ความคืบหน้าเฉลี่ย</th><th style={thStyle}>เวลาเรียน</th><th style={thStyle}>ใบประกาศ</th><th style={thStyle}>ใช้งานล่าสุด</th></tr></thead>
              <tbody>{learners.rows.map(l => (
                <tr key={l.id}>
                  <td style={tdStyle}>
                    {onNavigate && !ownOnly ? <button onClick={() => onNavigate({ tab: "users", id: l.id })} style={{ background: "none", border: "none", padding: 0, color: "var(--primary)", cursor: "pointer", fontWeight: 600 }}>{l.name}</button> : <strong>{l.name}</strong>}
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{l.email}</div>
                  </td>
                  <td style={tdStyle} title={l.course_titles || ""}>{l.courses} (จบ {l.completed})</td>
                  <td style={tdStyle}><Bar percent={l.avg_progress} /></td>
                  <td style={tdStyle}>{formatDuration(l.seconds)}</td>
                  <td style={tdStyle}>{l.certificates}</td>
                  <td style={tdStyle}>{timeAgo(l.last_activity)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {pager(learners.page, learners.total, p => loadLearners(p))}
        </section>
      )}

      {tab === "revenue" && (
        <>
          <section className="glass-card" style={section}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
              <RangePicker range={range} from={from} to={to} onChange={(r, f, t) => { setRange(r); setFrom(f); setTo(t); }} />
              <button className="tech-button-outline" style={small} onClick={() => exportCsv(`/reports/revenue?format=csv&section=period&${rq}`, "revenue.csv")}><Download size={14} />CSV</button>
            </div>
            {revenue && (
              <>
                <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", fontSize: "14px" }}>
                  <div><div style={{ color: "var(--text-muted)", fontSize: "12px" }}>รายได้</div><strong style={{ fontSize: "22px" }}>{baht(revenue.totals.revenue)}</strong></div>
                  <div><div style={{ color: "var(--text-muted)", fontSize: "12px" }}>รายการขาย</div><strong style={{ fontSize: "22px" }}>{revenue.totals.count.toLocaleString("th-TH")}</strong></div>
                  <div><div style={{ color: "var(--text-muted)", fontSize: "12px" }}>คืนเงิน (ไม่รวมในรายได้)</div><strong style={{ fontSize: "22px", color: "var(--danger)" }}>{baht(revenue.totals.refunds_amount)}</strong> <span style={{ color: "var(--text-muted)" }}>({revenue.totals.refunds_count})</span></div>
                </div>
                <LineChart data={revenue.by_period.map(p => ({ key: p.key, value: p.revenue }))} format={baht} label="รายได้" color="var(--accent)" height={220} />
              </>
            )}
          </section>
          {revenue && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "16px" }}>
              <section className="glass-card" style={section}>
                <div style={{ display: "flex", justifyContent: "space-between" }}><h3 style={{ fontSize: "16px" }}>ตามคอร์ส</h3>
                  <button className="tech-button-outline" style={small} onClick={() => exportCsv(`/reports/revenue?format=csv&section=course&${rq}`, "revenue-by-course.csv")}><Download size={14} />CSV</button></div>
                {revenue.by_course.length === 0 ? <Empty text="ไม่มียอดขายในช่วงนี้" /> : (
                  <table style={tableStyle}><thead><tr><th style={thStyle}>คอร์ส</th><th style={thStyle}>ขาย</th><th style={thStyle}>รายได้</th></tr></thead>
                    <tbody>{revenue.by_course.map(r => <tr key={r.course_id}><td style={tdStyle}>{r.course_title || r.course_id}</td><td style={tdStyle}>{r.count}</td><td style={tdStyle}>{baht(r.revenue)}</td></tr>)}</tbody></table>
                )}
              </section>
              <section className="glass-card" style={section}>
                <div style={{ display: "flex", justifyContent: "space-between" }}><h3 style={{ fontSize: "16px" }}>ตามโค้ดส่วนลด</h3>
                  <button className="tech-button-outline" style={small} onClick={() => exportCsv(`/reports/revenue?format=csv&section=voucher&${rq}`, "revenue-by-voucher.csv")}><Download size={14} />CSV</button></div>
                {revenue.by_voucher.length === 0 ? <Empty text="ไม่มีการใช้โค้ดส่วนลด" /> : (
                  <table style={tableStyle}><thead><tr><th style={thStyle}>โค้ด</th><th style={thStyle}>ใช้</th><th style={thStyle}>รายได้</th><th style={thStyle}>ส่วนลดรวม</th></tr></thead>
                    <tbody>{revenue.by_voucher.map(r => <tr key={r.voucher_code}><td style={tdStyle}>{r.voucher_code}</td><td style={tdStyle}>{r.count}</td><td style={tdStyle}>{baht(r.revenue)}</td><td style={tdStyle}>{baht(r.discount)}</td></tr>)}</tbody></table>
                )}
              </section>
              <section className="glass-card" style={{ ...section, gridColumn: "1 / -1" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}><h3 style={{ fontSize: "16px" }}>การคืนเงิน</h3>
                  <button className="tech-button-outline" style={small} onClick={() => exportCsv(`/reports/revenue?format=csv&section=refunds&${rq}`, "refunds.csv")}><Download size={14} />CSV</button></div>
                {revenue.refunds.length === 0 ? <Empty text="ไม่มีการคืนเงินในช่วงนี้" /> : (
                  <div style={scroll}><table style={tableStyle}><thead><tr><th style={thStyle}>คำสั่งซื้อ</th><th style={thStyle}>ผู้ซื้อ</th><th style={thStyle}>คอร์ส</th><th style={thStyle}>ยอด</th><th style={thStyle}>คืนเงินเมื่อ</th><th style={thStyle}>เหตุผล</th></tr></thead>
                    <tbody>{revenue.refunds.map(r => (
                      <tr key={r.id}>
                        <td style={tdStyle}>{onNavigate && !ownOnly ? <button onClick={() => onNavigate({ tab: "orders", id: r.id })} style={{ background: "none", border: "none", padding: 0, color: "var(--primary)", cursor: "pointer" }}>{r.reference}</button> : r.reference}</td>
                        <td style={tdStyle}>{r.user_name}<div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{r.user_email}</div></td>
                        <td style={tdStyle}>{r.course_title}</td><td style={tdStyle}>{baht(r.amount)}</td><td style={tdStyle}>{formatDateTime(r.refunded_at)}</td><td style={tdStyle}>{r.staff_note}</td>
                      </tr>
                    ))}</tbody></table></div>
                )}
              </section>
            </div>
          )}
          {revenue && revenue.by_period.length > 0 && (
            <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>ช่วง {bucketLabel(revenue.by_period[0].key)} – {bucketLabel(revenue.by_period[revenue.by_period.length - 1].key)} · รายได้นับจากยอดที่ได้รับจริงของคำสั่งซื้อที่ชำระแล้ว</p>
          )}
        </>
      )}

      {tab === "events" && (
        <section className="glass-card" style={section}>
          <form onSubmit={e => { e.preventDefault(); setEventApplied({ ...eventFilter }); }} style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <input className="form-input" value={eventFilter.user} onChange={e => setEventFilter(f => ({ ...f, user: e.target.value }))} placeholder="ผู้ใช้ (ชื่อหรืออีเมล)" aria-label="กรองตามผู้ใช้" />
            <select className="form-input" value={eventFilter.type} onChange={e => setEventFilter(f => ({ ...f, type: e.target.value }))} aria-label="ประเภทกิจกรรม">
              <option value="">ทุกกิจกรรม</option>
              {Object.entries(events.types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="form-input" value={eventFilter.course} onChange={e => setEventFilter(f => ({ ...f, course: e.target.value }))} placeholder="รหัสคอร์ส" aria-label="รหัสคอร์ส" style={{ width: "160px" }} />
            <input type="date" className="form-input" value={eventFilter.from} onChange={e => setEventFilter(f => ({ ...f, from: e.target.value }))} aria-label="ตั้งแต่วันที่" />
            <input type="date" className="form-input" value={eventFilter.to} onChange={e => setEventFilter(f => ({ ...f, to: e.target.value }))} aria-label="ถึงวันที่" />
            <button type="submit" className="tech-button-primary" style={small}>กรอง</button>
            <button type="button" className="tech-button-outline" style={small} onClick={() => exportCsv(`/analytics/events?format=csv&${eventQuery(eventApplied)}`, "events.csv")}><Download size={14} />CSV</button>
          </form>
          {events.rows.length === 0 ? <Empty text="ไม่พบกิจกรรม" /> : (
            <div style={scroll}><table style={tableStyle}>
              <thead><tr><th style={thStyle}>เวลา</th><th style={thStyle}>กิจกรรม</th><th style={thStyle}>รายละเอียด</th></tr></thead>
              <tbody>{events.rows.map(e => (
                <tr key={e.id}>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{formatDateTime(e.created_at)}</td>
                  <td style={tdStyle}><Chip label={e.label} color="var(--primary)" bg="var(--primary-glow)" /></td>
                  <td style={tdStyle}>
                    {e.link && e.link.tab === "reports" && e.link.id ? (
                      <button onClick={() => { setTab("courses"); setCourseId(e.link!.id!); }} style={{ background: "none", border: "none", padding: 0, color: "var(--text-primary)", cursor: "pointer", textAlign: "left" }}>{e.description}</button>
                    ) : onNavigate && e.link && !ownOnly ? (
                      <button onClick={() => onNavigate(e.link!)} style={{ background: "none", border: "none", padding: 0, color: "var(--text-primary)", cursor: "pointer", textAlign: "left" }}>{e.description}</button>
                    ) : e.description}
                    {e.user_email && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{e.user_email}</div>}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {pager(events.page, events.total, p => loadEvents(p))}
        </section>
      )}

      {tab === "assessments" && assessmentsSlot}
    </div>
  );
};

export default ReportsPage;
