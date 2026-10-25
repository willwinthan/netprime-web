import React, { useEffect, useState } from "react";
import { LayoutDashboard, CalendarDays, MessageSquare, ExternalLink } from "lucide-react";
import { can, useApi } from "../hooks/useApi";
import { SessionsPanel } from "../components/site-admin/SessionsPanel";
import { InquiriesPanel } from "../components/site-admin/ContentPanels";
import { AdminSession, Chip, REG_STATUS, SeatBar, ErrorBox, Empty, formatDateRange, formatDateTime } from "../components/site-admin/ui";

type Tab = "overview" | "sessions" | "inquiries";

const TAB_PERMISSION: Record<Tab, string> = {
  overview: "site.dashboard", sessions: "site.sessions", inquiries: "site.inquiries"
};
/** Any of these opens the training desk. Website content lives in WebsiteBuilderPage; audit in AuditPage. */
export const TRAINING_PERMISSIONS = Object.values(TAB_PERMISSION);

interface Summary {
  counts: { new_inquiries: number; pending_registrations: number; waitlist_registrations: number; open_sessions: number; published_articles: number };
  upcoming: AdminSession[];
  recentRegistrations: Array<{ id: string; name: string; company: string | null; attendees: number; status: keyof typeof REG_STATUS; created_at: string; session_id: string; session_title: string }>;
}

/**
 * Training desk for coordinators: today's work, training rounds with registrants (list or calendar)
 * and contact inquiries. Everything shown on the public website is edited in "เว็บไซต์" instead.
 * Each tab follows a permission so admins can hand out only what a role needs.
 */
export const SiteManager: React.FC = () => {
  const api = useApi();
  const allowed = (Object.keys(TAB_PERMISSION) as Tab[]).filter(t => can(api.user, TAB_PERMISSION[t]));
  const [tab, setTab] = useState<Tab>(allowed[0] ?? "overview");
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = () => api.get<Summary>("/admin/site/summary").then(setSummary).catch(err => setError(err.message));
  useEffect(() => { if (tab === "overview" && allowed.includes("overview")) loadSummary(); }, [tab, api.token]);

  const goToSession = (id: string) => { setOpenSession(id); setTab("sessions"); };

  if (allowed.length === 0) {
    return <div className="glass-card" style={{ padding: "40px", textAlign: "center" }}><h2>บัญชีของคุณไม่มีสิทธิ์จัดการงานอบรม</h2></div>;
  }

  const tabs = ([
    ["overview", "ภาพรวม", <LayoutDashboard size={16} />],
    ["sessions", "รอบอบรม & ผู้สมัคร", <CalendarDays size={16} />, summary?.counts.pending_registrations],
    ["inquiries", "ข้อความติดต่อ", <MessageSquare size={16} />, summary?.counts.new_inquiries]
  ] as Array<[Tab, string, React.ReactNode, number?]>).filter(([key]) => allowed.includes(key));

  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">รอบอบรมและผู้สมัคร</h1>
          <p className="header-desc">เปิดรอบอบรม ดูแลผู้สมัคร และตอบข้อความติดต่อ ตารางอบรมขึ้นหน้าเว็บภายใน 1 นาที</p>
        </div>
        <a href="/" target="_blank" rel="noreferrer" className="tech-button-outline"><ExternalLink size={16} />เปิดหน้าเว็บ</a>
      </div>

      <nav role="tablist" style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "24px", borderBottom: "1px solid rgba(0,0,0,0.06)", paddingBottom: "12px" }}>
        {tabs.map(([key, label, icon, badge]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={tab === key ? "tech-button-primary" : "tech-button-outline"}
            style={{ padding: "8px 14px", fontSize: "13px", borderWidth: tab === key ? undefined : "1px" }}>
            {icon}{label}
            {!!badge && <span style={{ background: tab === key ? "#fff" : "var(--primary)", color: tab === key ? "var(--primary)" : "#fff", borderRadius: "99px", fontSize: "11px", padding: "0 7px", marginLeft: "2px" }}>{badge}</span>}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <div style={{ display: "grid", gap: "24px" }}>
          <ErrorBox message={error} />
          {!summary ? <Empty text="กำลังโหลด…" /> : <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "16px" }}>
              <StatCard label="ใบสมัครรอตรวจสอบ" value={summary.counts.pending_registrations} tone="var(--primary)" onClick={() => setTab("sessions")} />
              <StatCard label="ข้อความติดต่อใหม่" value={summary.counts.new_inquiries} tone="var(--secondary)" onClick={() => setTab("inquiries")} />
              <StatCard label="อยู่ในรายชื่อรอคิว" value={summary.counts.waitlist_registrations} tone="var(--warning)" onClick={() => setTab("sessions")} />
              <StatCard label="รอบที่เปิดรับสมัคร" value={summary.counts.open_sessions} tone="var(--accent)" onClick={() => setTab("sessions")} />
            </div>
            <div className="dashboard-grid">
              <div className="glass-card" style={{ padding: "20px" }}>
                <h3 style={{ fontSize: "16px", marginBottom: "12px" }}>รอบอบรมที่กำลังจะมาถึง</h3>
                {summary.upcoming.length === 0 ? <Empty text="ยังไม่มีรอบอบรมที่เปิด" /> : summary.upcoming.map(s => (
                  <button key={s.id} onClick={() => goToSession(s.id)}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", width: "100%", background: "none", border: "none", borderBottom: "1px solid rgba(0,0,0,0.05)", padding: "12px 0", cursor: "pointer", textAlign: "left" }}>
                    <div>
                      <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{s.title}</div>
                      <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{formatDateRange(s.start_date, s.end_date)}{s.pending_count ? ` · รอตรวจสอบ ${s.pending_count}` : ""}</div>
                    </div>
                    <SeatBar taken={s.seats_taken} capacity={s.capacity} />
                  </button>
                ))}
              </div>
              <div className="glass-card" style={{ padding: "20px" }}>
                <h3 style={{ fontSize: "16px", marginBottom: "12px" }}>ผู้สมัครล่าสุด</h3>
                {summary.recentRegistrations.length === 0 ? <Empty text="ยังไม่มีผู้สมัคร" /> : summary.recentRegistrations.map(r => (
                  <button key={r.id} onClick={() => goToSession(r.session_id)}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", width: "100%", background: "none", border: "none", borderBottom: "1px solid rgba(0,0,0,0.05)", padding: "10px 0", cursor: "pointer", textAlign: "left" }}>
                    <div>
                      <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{r.name} <span style={{ fontWeight: 400, color: "var(--text-muted)", fontSize: "12px" }}>{r.company ? `· ${r.company}` : ""} · {r.attendees} คน</span></div>
                      <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{r.session_title} · {formatDateTime(r.created_at)}</div>
                    </div>
                    <Chip {...REG_STATUS[r.status]} />
                  </button>
                ))}
              </div>
            </div>
          </>}
        </div>
      )}
      {tab === "sessions" && <SessionsPanel openSessionId={openSession} onOpened={() => setOpenSession(null)} />}
      {tab === "inquiries" && <InquiriesPanel />}
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: number; tone: string; onClick: () => void }> = ({ label, value, tone, onClick }) => (
  <button onClick={onClick} className="glass-card" style={{ padding: "20px", textAlign: "left", cursor: "pointer", border: "none", borderLeft: `4px solid ${tone}` }}>
    <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{label}</div>
    <div style={{ fontSize: "32px", fontWeight: 800, color: tone, marginTop: "4px" }}>{value}</div>
  </button>
);
