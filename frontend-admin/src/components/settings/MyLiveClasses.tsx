import React, { useEffect, useState } from "react";
import { Video, List, CalendarDays } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { SessionCalendar, CalendarEvent } from "../calendar/SessionCalendar";
import { ErrorBox, Empty } from "../site-admin/ui";
import { formatInstant, toLocalInput } from "./shared";

export interface LiveItem {
  kind: "session" | "class"; id: string; title: string; subtitle?: string | null; course_title?: string;
  start_date?: string; end_date?: string; starts_at: string; ends_at: string; provider: string;
  join_available: boolean; join_opens_at: string;
}

const PROVIDER_LABEL: Record<string, string> = { zoom: "Zoom", teams: "Microsoft Teams", meet: "Google Meet", manual: "ออนไลน์" };
const localDate = (iso: string) => toLocalInput(iso).slice(0, 10);

/**
 * Learner dashboard widget: upcoming live training sessions (confirmed/paid registrations) and course
 * live classes (enrolled courses), as a list or month calendar. The join button appears 30 minutes before start.
 */
export const MyLiveClasses: React.FC<{ title?: string }> = ({ title = "เรียนสดที่กำลังจะมาถึง" }) => {
  const api = useApi();
  const [items, setItems] = useState<LiveItem[] | null>(null);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const load = () => api.get<{ items: LiveItem[] }>("/live/my").then(d => setItems(d.items)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);
  // Re-check once a minute so the join button appears without a reload.
  useEffect(() => {
    const timer = setInterval(() => { setTick(t => t + 1); load(); }, 60_000);
    return () => clearInterval(timer);
  }, [api.token]);

  const join = async (item: LiveItem) => {
    try {
      setError(null);
      const res = await api.post<{ join_url: string; passcode: string | null }>(`/live/join/${item.kind}/${item.id}`, {});
      if (res.passcode) alert(`รหัสผ่านห้อง: ${res.passcode}`);
      window.open(res.join_url, "_blank", "noopener,noreferrer");
    } catch (err: any) { setError(err.message); }
  };

  if (items && items.length === 0 && !error) return null;
  const events: CalendarEvent[] = (items || []).map(i => ({
    id: `${i.kind}:${i.id}`, start: i.start_date || localDate(i.starts_at), end: i.end_date || localDate(i.ends_at), title: i.title,
    color: i.join_available ? { fg: "var(--accent)", bg: "var(--accent-glow)" } : { fg: "var(--primary)", bg: "var(--primary-glow)" },
    meta: [new Date(i.starts_at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }), PROVIDER_LABEL[i.provider] || i.provider, i.subtitle].filter(Boolean).join(" · ")
  }));
  const byEvent = (id: string) => items?.find(i => `${i.kind}:${i.id}` === id);

  return (
    <section className="glass-card" style={{ padding: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "12px" }}>
        <h3 style={{ fontSize: "16px", display: "flex", gap: "8px", alignItems: "center" }}><Video size={18} />{title}</h3>
        <div style={{ display: "flex", gap: "6px" }}>
          <button className={view === "list" ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => setView("list")}><List size={14} />รายการ</button>
          <button className={view === "calendar" ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => setView("calendar")}><CalendarDays size={14} />ปฏิทิน</button>
        </div>
      </div>
      <ErrorBox message={error} />
      {!items ? <Empty text="กำลังโหลด…" /> : view === "calendar" ? (
        <SessionCalendar events={events} label="ปฏิทินเรียนสด" emptyText="ไม่มีคลาสสดในเดือนนี้"
          onEventClick={id => { const item = byEvent(id); if (item?.join_available) join(item); }}
          renderExtra={ev => { const item = byEvent(ev.id); return item ? <JoinButton item={item} onJoin={join} /> : null; }} />
      ) : (
        <div style={{ display: "grid", gap: "10px" }}>
          {items.map(item => (
            <div key={`${item.kind}:${item.id}`} style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", flexWrap: "wrap", padding: "12px 14px", border: "1px solid rgba(0,0,0,0.06)", borderRadius: "10px" }}>
              <div>
                <strong>{item.title}</strong>
                <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                  {formatInstant(item.starts_at)} · {PROVIDER_LABEL[item.provider] || item.provider}{item.subtitle ? ` · ${item.subtitle}` : ""}
                  {item.kind === "session" && " · รอบอบรม"}
                </div>
              </div>
              <JoinButton item={item} onJoin={join} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

const JoinButton: React.FC<{ item: LiveItem; onJoin: (item: LiveItem) => void }> = ({ item, onJoin }) => item.join_available
  ? <button className="tech-button-primary" onClick={() => onJoin(item)}><Video size={16} />เข้าห้องเรียนสด</button>
  : <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>เข้าห้องได้ตั้งแต่ {formatInstant(item.join_opens_at)}</span>;
