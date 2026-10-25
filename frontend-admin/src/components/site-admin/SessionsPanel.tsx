import React, { useEffect, useMemo, useState } from "react";
import { CalendarPlus, Copy, Download, Pencil, Trash2, Users, UserPlus, ArrowLeft, RefreshCw, MailPlus, List, CalendarDays } from "lucide-react";
import { SessionCalendar, CalendarEvent } from "../calendar/SessionCalendar";
import { YearMonth, monthOf, todayYmd } from "../calendar/calendarDates";
import { useApi } from "../../hooks/useApi";
import { SessionMeetingCard } from "../settings/SessionMeetingCard";
import {
  AdminSession, Registration, RegistrationStatus, MODE_LABEL, SESSION_STATUS, REG_STATUS,
  Chip, SeatBar, Modal, Field, ErrorBox, Empty, grid2, tableStyle, thStyle, tdStyle,
  formatDateRange, formatBaht, formatDateTime, downloadWithAuth
} from "./ui";

type Api = ReturnType<typeof useApi>;

const EMPTY_SESSION = {
  title: "", vendor: "", description: "", course_id: "", start_date: "", end_date: "", time_text: "09:00–16:00",
  mode: "classroom", location: "", instructor_name: "", price: 0, capacity: 20, registration_deadline: "", status: "draft"
};

// ==========================================
// List / calendar view preference (per browser; storage may be unavailable)
// ==========================================

type SessionsView = "list" | "calendar";
const VIEW_KEY = "netprime.admin.sessions.view";
function readView(): SessionsView {
  try { return localStorage.getItem(VIEW_KEY) === "calendar" ? "calendar" : "list"; } catch { return "list"; }
}
function saveView(view: SessionsView) {
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode / blocked storage */ }
}

const STATUS_FILTERS = [["all", "ทุกสถานะ"], ["draft", SESSION_STATUS.draft.label], ["open", SESSION_STATUS.open.label],
  ["closed", SESSION_STATUS.closed.label], ["cancelled", SESSION_STATUS.cancelled.label]] as const;
type StatusFilter = typeof STATUS_FILTERS[number][0];

/** The calendar needs past and future sessions; the list API pages by 200, so read a few pages. */
async function loadAllSessions(api: Api): Promise<AdminSession[]> {
  const all: AdminSession[] = [];
  for (let page = 0; page < 5; page++) {
    const data = await api.get<{ sessions: AdminSession[] }>(`/admin/site/sessions?scope=all&limit=200&offset=${page * 200}`);
    all.push(...data.sessions);
    if (data.sessions.length < 200) break;
  }
  return all;
}

function toCalendarEvent(s: AdminSession): CalendarEvent {
  const tone = SESSION_STATUS[s.status] ?? SESSION_STATUS.draft;
  const badges: CalendarEvent["badges"] = [{ label: `${s.seats_taken}/${s.capacity}`, fg: "var(--text-secondary)", bg: "rgba(255,255,255,0.75)" }];
  if (s.pending_count > 0) badges.push({ label: `รอตรวจ ${s.pending_count}`, fg: REG_STATUS.pending.color, bg: "#fff" });
  if (s.waitlist_count > 0) badges.push({ label: `รอคิว ${s.waitlist_count}`, fg: REG_STATUS.waitlist.color, bg: "#fff" });
  return {
    id: s.id, start: s.start_date, end: s.end_date || s.start_date, title: s.title,
    color: { fg: tone.color, bg: tone.bg },
    meta: [s.time_text, MODE_LABEL[s.mode], s.instructor_name].filter(Boolean).join(" · "),
    badges, muted: s.status === "cancelled",
    description: `${tone.label} · ที่นั่ง ${s.seats_taken}/${s.capacity}${s.pending_count ? ` · รอตรวจสอบ ${s.pending_count} ราย` : ""}${s.waitlist_count ? ` · รอคิว ${s.waitlist_count} ราย` : ""}`
  };
}

// ==========================================
// Session list
// ==========================================

export const SessionsPanel: React.FC<{ openSessionId?: string | null; onOpened?: () => void }> = ({ openSessionId, onOpened }) => {
  const api = useApi();
  const [scope, setScope] = useState<"upcoming" | "past" | "all">("upcoming");
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<AdminSession> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // Remounts the registrations view after the session is edited.
  const [view, setView] = useState<SessionsView>(readView);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [calendarMonth, setCalendarMonth] = useState<YearMonth>(() => monthOf(todayYmd())!);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      if (view === "calendar") setSessions(await loadAllSessions(api));
      else setSessions((await api.get<{ sessions: AdminSession[] }>(`/admin/site/sessions?scope=${scope}`)).sessions);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [scope, view, api.token]);
  const changeView = (next: SessionsView) => { setView(next); saveView(next); };
  const calendarEvents = useMemo(() => view !== "calendar" ? [] :
    sessions.filter(s => statusFilter === "all" || s.status === statusFilter).map(toCalendarEvent), [sessions, statusFilter, view]);
  const sessionById = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions]);
  useEffect(() => {
    api.get<{ courses: Array<{ id: string; title: string }> }>("/admin/site/course-options").then(d => setCourses(d.courses)).catch(() => setCourses([]));
  }, [api.token]);
  useEffect(() => {
    if (openSessionId) { setSelected(openSessionId); onOpened?.(); }
  }, [openSessionId]);

  const duplicate = async (session: AdminSession) => {
    try {
      const data = await api.post<{ session: AdminSession }>(`/admin/site/sessions/${session.id}/duplicate`, {});
      await load();
      setEditing(data.session);
    } catch (err: any) { setError(err.message); }
  };

  const remove = async (session: AdminSession) => {
    if (!confirm(`ลบรอบ "${session.title}" (${formatDateRange(session.start_date, session.end_date)}) ?`)) return;
    try {
      await api.request(`/admin/site/sessions/${session.id}`, { method: "DELETE" });
      await load();
    } catch (err: any) { setError(err.message); }
  };

  const form = editing && (
    <SessionForm api={api} initial={editing} courses={courses} onClose={() => setEditing(null)}
      onSaved={() => { setEditing(null); setVersion(v => v + 1); load(); }} />
  );

  if (selected) {
    return <>
      <RegistrationsView key={version} api={api} sessionId={selected} onBack={() => { setSelected(null); load(); }} onEdit={s => setEditing(s)} />
      {form}
    </>;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "16px" }}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <div role="group" aria-label="มุมมอง" style={{ display: "flex", gap: "4px", padding: "3px", borderRadius: "12px", background: "rgba(15,23,42,0.05)" }}>
            {([["list", "รายการ", List], ["calendar", "ปฏิทิน", CalendarDays]] as const).map(([key, label, Icon]) => (
              <button key={key} type="button" aria-pressed={view === key} onClick={() => changeView(key)}
                className={view === key ? "tech-button-primary" : "tech-button-outline"}
                style={{ padding: "6px 12px", fontSize: "13px", display: "inline-flex", gap: "6px", alignItems: "center", border: view === key ? undefined : "none", background: view === key ? undefined : "transparent" }}>
                <Icon size={15} />{label}
              </button>
            ))}
          </div>
          {view === "list" ? ([["upcoming", "กำลังจะมาถึง"], ["past", "ที่ผ่านมา"], ["all", "ทั้งหมด"]] as const).map(([key, label]) => (
            <button key={key} onClick={() => setScope(key)} className={scope === key ? "tech-button-primary" : "tech-button-outline"}
              aria-pressed={scope === key} style={{ padding: "6px 14px", fontSize: "13px" }}>{label}</button>
          )) : (
            <label style={{ display: "inline-flex", gap: "6px", alignItems: "center", fontSize: "13px", color: "var(--text-secondary)" }}>
              สถานะ
              <select className="form-input" value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)}
                style={{ padding: "6px 10px", fontSize: "13px", width: "auto" }}>
                {STATUS_FILTERS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="tech-button-outline" onClick={load} style={{ padding: "8px 14px" }} aria-label="รีเฟรช"><RefreshCw size={16} /></button>
          <button className="tech-button-primary" onClick={() => setEditing({ ...EMPTY_SESSION } as any)}><CalendarPlus size={16} />เพิ่มรอบอบรม</button>
        </div>
      </div>

      <ErrorBox message={error} />

      {view === "calendar" ? (
        <div className="glass-card" style={{ padding: "16px" }}>
          <SessionCalendar
            label="ปฏิทินรอบอบรม"
            events={calendarEvents}
            loading={loading}
            initialMonth={calendarMonth}
            onMonthChange={setCalendarMonth}
            onEventClick={id => setSelected(id)}
            onDayClick={date => setEditing({ ...EMPTY_SESSION, start_date: date, end_date: date } as any)}
            dayActionLabel="เพิ่มรอบอบรมวันนี้"
            legend={(["draft", "open", "closed", "cancelled"] as const).map(k => ({ label: SESSION_STATUS[k].label, fg: SESSION_STATUS[k].color, bg: SESSION_STATUS[k].bg }))}
            renderExtra={e => { const s = sessionById.get(e.id); return s ? <SeatBar taken={s.seats_taken} capacity={s.capacity} /> : null; }}
            emptyText={statusFilter === "all" ? "ไม่มีรอบอบรมในเดือนนี้ · คลิกวันที่ในปฏิทินเพื่อเพิ่มรอบอบรม" : "ไม่มีรอบอบรมสถานะนี้ในเดือนนี้"}
          />
          <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "10px" }}>
            คลิกแถบรอบอบรมเพื่อดูผู้สมัคร · คลิกช่องวันที่ว่างเพื่อเพิ่มรอบอบรมโดยตั้งวันเริ่มเป็นวันนั้น · ใช้ปุ่มลูกศรบนแป้นพิมพ์เลื่อนวัน และ PageUp/PageDown เลื่อนเดือน
          </p>
        </div>
      ) : (
      <div className="glass-card" style={{ padding: "8px", overflowX: "auto" }}>
        {loading ? <Empty text="กำลังโหลด…" /> : sessions.length === 0 ? (
          <Empty text={scope === "past" ? "ยังไม่มีรอบที่จบแล้ว" : "ยังไม่มีรอบอบรม กด 'เพิ่มรอบอบรม' เพื่อเริ่ม"} />
        ) : (
          <table style={tableStyle}>
            <thead><tr>
              <th style={thStyle}>หลักสูตร</th><th style={thStyle}>วันที่</th><th style={thStyle}>รูปแบบ</th>
              <th style={thStyle}>ราคา</th><th style={thStyle}>ที่นั่ง</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th>
            </tr></thead>
            <tbody>
              {sessions.map(s => (
                <tr key={s.id}>
                  <td style={tdStyle}>
                    <button onClick={() => setSelected(s.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", fontWeight: 700, color: "var(--text-primary)", fontSize: "14px" }}>
                      {s.title}
                    </button>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{[s.vendor, s.instructor_name].filter(Boolean).join(" · ") || "-"}</div>
                    <div style={{ display: "flex", gap: "6px", marginTop: "6px", flexWrap: "wrap" }}>
                      {s.pending_count > 0 && <Chip {...REG_STATUS.pending} label={`รอตรวจสอบ ${s.pending_count}`} />}
                      {s.waitlist_count > 0 && <Chip {...REG_STATUS.waitlist} label={`รอคิว ${s.waitlist_count}`} />}
                    </div>
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{formatDateRange(s.start_date, s.end_date)}<div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{s.time_text}</div></td>
                  <td style={tdStyle}>{MODE_LABEL[s.mode]}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{formatBaht(s.price)}</td>
                  <td style={tdStyle}><SeatBar taken={s.seats_taken} capacity={s.capacity} /></td>
                  <td style={tdStyle}><Chip {...SESSION_STATUS[s.status]} /></td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    <IconButton title="ผู้สมัคร" onClick={() => setSelected(s.id)}><Users size={16} /></IconButton>
                    <IconButton title="แก้ไข" onClick={() => setEditing(s)}><Pencil size={16} /></IconButton>
                    <IconButton title="ทำสำเนาเป็นรอบใหม่" onClick={() => duplicate(s)}><Copy size={16} /></IconButton>
                    <IconButton title="ลบ" onClick={() => remove(s)} danger><Trash2 size={16} /></IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      )}

      {form}
    </div>
  );
};

export const IconButton: React.FC<{ title: string; onClick: () => void; children: React.ReactNode; danger?: boolean }> = ({ title, onClick, children, danger }) => (
  <button title={title} aria-label={title} onClick={onClick}
    style={{ background: "none", border: "1px solid rgba(0,0,0,0.08)", borderRadius: "10px", padding: "6px", marginLeft: "6px", cursor: "pointer", color: danger ? "var(--danger)" : "var(--text-secondary)" }}>
    {children}
  </button>
);

// ==========================================
// Session create / edit form
// ==========================================

const SessionForm: React.FC<{
  api: Api; initial: Partial<AdminSession>; courses: Array<{ id: string; title: string }>; onClose: () => void; onSaved: () => void;
}> = ({ api, initial, courses, onClose, onSaved }) => {
  const [form, setForm] = useState<Record<string, any>>(() => {
    const values: Record<string, any> = { ...EMPTY_SESSION };
    for (const key of Object.keys(EMPTY_SESSION)) values[key] = (initial as any)[key] ?? (EMPTY_SESSION as any)[key];
    return values;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [key]: e.target.value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);
      const body = { ...form, price: Number(form.price), capacity: Number(form.capacity) };
      if (initial.id) await api.patch(`/admin/site/sessions/${initial.id}`, body);
      else await api.post("/admin/site/sessions", body);
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial.id ? "แก้ไขรอบอบรม" : "เพิ่มรอบอบรม"} onClose={onClose} width={720}>
      <ErrorBox message={error} />
      <form onSubmit={save} style={grid2}>
        <Field label="ชื่อหลักสูตร *" span><input className="form-input" required maxLength={160} value={form.title} onChange={set("title")} placeholder="เช่น CCNA 200-301" /></Field>
        <Field label="แบรนด์ / หมวด" hint="ใช้กรองบนหน้าเว็บ เช่น Cisco, Aruba"><input className="form-input" maxLength={40} value={form.vendor} onChange={set("vendor")} /></Field>
        <Field label="เชื่อมกับคอร์สออนไลน์" hint="ไม่บังคับ · เฉพาะคอร์สที่เผยแพร่แล้ว ผู้สมัครที่ยืนยัน/ชำระแล้วจะได้คอร์สนี้ในบัญชี">
          <select className="form-input" value={form.course_id} onChange={set("course_id")}>
            <option value="">— ไม่เชื่อม —</option>
            {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            {/* A course archived after it was linked stays selectable for this session. */}
            {form.course_id && !courses.some(c => c.id === form.course_id) && <option value={form.course_id}>{form.course_id} (ไม่ได้เผยแพร่แล้ว)</option>}
          </select>
        </Field>
        <Field label="วันเริ่ม *"><input className="form-input" type="date" required value={form.start_date} onChange={set("start_date")} /></Field>
        <Field label="วันสิ้นสุด *"><input className="form-input" type="date" required value={form.end_date} min={form.start_date || undefined} onChange={set("end_date")} /></Field>
        <Field label="เวลาอบรม"><input className="form-input" maxLength={80} value={form.time_text} onChange={set("time_text")} placeholder="09:00–16:00" /></Field>
        <Field label="ปิดรับสมัครวันที่" hint="เว้นว่าง = รับถึงวันเริ่มอบรม"><input className="form-input" type="date" value={form.registration_deadline || ""} max={form.end_date || undefined} onChange={set("registration_deadline")} /></Field>
        <Field label="รูปแบบ *">
          <select className="form-input" value={form.mode} onChange={set("mode")}>
            {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="สถานที่ / ช่องทาง"><input className="form-input" maxLength={200} value={form.location} onChange={set("location")} placeholder="ห้องอบรม ชั้น 5 / Zoom" /></Field>
        <Field label="วิทยากร"><input className="form-input" maxLength={120} value={form.instructor_name} onChange={set("instructor_name")} /></Field>
        <Field label="ราคา (บาท) *" hint="0 = ฟรี"><input className="form-input" type="number" min={0} step={1} required value={form.price} onChange={set("price")} /></Field>
        <Field label="จำนวนที่นั่ง *"><input className="form-input" type="number" min={1} max={1000} required value={form.capacity} onChange={set("capacity")} /></Field>
        <Field label="สถานะ *" hint="ฉบับร่างจะไม่แสดงบนเว็บ">
          <select className="form-input" value={form.status} onChange={set("status")}>
            {Object.entries(SESSION_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="รายละเอียด" span><textarea className="form-input" rows={3} maxLength={2000} value={form.description} onChange={set("description")} /></Field>
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={saving}>{saving ? "กำลังบันทึก…" : "บันทึก"}</button>
        </div>
      </form>
    </Modal>
  );
};

// ==========================================
// Registrations of one session
// ==========================================

const QUICK_ACTIONS: Array<[RegistrationStatus, string]> = [["confirmed", "ยืนยัน"], ["paid", "ชำระแล้ว"], ["attended", "เข้าอบรมแล้ว"], ["cancelled", "ยกเลิก"]];

const RegistrationsView: React.FC<{ api: Api; sessionId: string; onBack: () => void; onEdit: (s: AdminSession) => void }> = ({ api, sessionId, onBack, onEdit }) => {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [rows, setRows] = useState<Registration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<Registration | null>(null);
  const [filter, setFilter] = useState<RegistrationStatus | "all">("all");
  const [info, setInfo] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      const data = await api.get<{ session: AdminSession; registrations: Registration[] }>(`/admin/site/sessions/${sessionId}/registrations`);
      setSession(data.session);
      setRows(data.registrations);
    } catch (err: any) { setError(err.message); }
  };
  useEffect(() => { load(); }, [sessionId, api.token]);

  const update = async (reg: Registration, body: Record<string, unknown>) => {
    try {
      setBusy(reg.id);
      setError(null);
      await api.patch(`/admin/site/registrations/${reg.id}`, { ...body, notify });
      await load();
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    } finally { setBusy(null); }
  };

  const remove = async (reg: Registration) => {
    if (!confirm(`ลบรายการของ ${reg.name}? (ใช้กับข้อมูลสแปมหรือข้อมูลซ้ำ ถ้าลูกค้ายกเลิกให้ใช้สถานะ 'ยกเลิก')`)) return;
    try {
      await api.request(`/admin/site/registrations/${reg.id}`, { method: "DELETE" });
      setDetail(null);
      await load();
    } catch (err: any) { setError(err.message); }
  };

  /** "สร้างบัญชีและส่งคำเชิญ" for one registrant; returns false on error. */
  const invite = async (reg: Registration, quiet = false) => {
    try {
      setBusy(reg.id);
      setError(null);
      const res = await api.post<{ message: string }>(`/admin/site/registrations/${reg.id}/invite`, {});
      if (!quiet) setInfo(`${reg.name}: ${res.message}`);
      return true;
    } catch (err: any) {
      setError(`${reg.name}: ${err.message}`);
      return false;
    } finally { setBusy(null); }
  };
  const withoutAccount = rows.filter(r => !r.account_id && r.status !== "cancelled");
  const inviteAll = async () => {
    if (!confirm(`สร้างบัญชีผู้เรียนและส่งอีเมลเชิญให้ผู้สมัคร ${withoutAccount.length} คนที่ยังไม่มีบัญชี?`)) return;
    let done = 0;
    for (const reg of withoutAccount) if (await invite(reg, true)) done++;
    setInfo(`ส่งคำเชิญแล้ว ${done} จาก ${withoutAccount.length} คน`);
    await load();
  };

  const exportCsv = () => session && downloadWithAuth(`/admin/site/sessions/${session.id}/registrations.csv`, api.token,
    `ผู้สมัคร-${session.title}-${session.start_date}.csv`).catch(err => setError(err.message));

  const visible = filter === "all" ? rows : rows.filter(r => r.status === filter);
  const totals = rows.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] || 0) + r.attendees; return acc; }, {});

  return (
    <div>
      <button className="tech-button-outline" onClick={onBack} style={{ padding: "6px 14px", fontSize: "13px", marginBottom: "16px" }}><ArrowLeft size={14} />กลับไปรายการรอบอบรม</button>
      <ErrorBox message={error} />
      {info && <div role="status" style={{ borderLeft: "4px solid var(--accent)", background: "var(--accent-glow)", padding: "10px 16px", borderRadius: "8px", marginBottom: "16px", fontSize: "14px" }}>{info}</div>}
      {session && (
        <div className="glass-card" style={{ padding: "20px", marginBottom: "16px", display: "flex", justifyContent: "space-between", gap: "16px", flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <h2 style={{ fontSize: "20px" }}>{session.title}</h2><Chip {...SESSION_STATUS[session.status]} />
            </div>
            <div style={{ color: "var(--text-secondary)", fontSize: "14px", marginTop: "4px" }}>
              {formatDateRange(session.start_date, session.end_date)} · {session.time_text || "-"} · {MODE_LABEL[session.mode]} · {formatBaht(session.price)}
            </div>
          </div>
          <SeatBar taken={session.seats_taken} capacity={session.capacity} />
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button className="tech-button-outline" onClick={() => onEdit(session)}><Pencil size={16} />แก้ไขรอบ</button>
            <button className="tech-button-outline" onClick={exportCsv}><Download size={16} />ดาวน์โหลด Excel</button>
            {withoutAccount.length > 0 && <button className="tech-button-outline" disabled={!!busy} onClick={inviteAll}
              title="สร้างบัญชีผู้เรียนให้ผู้สมัครที่ยังไม่มีบัญชี แล้วส่งลิงก์ตั้งรหัสผ่านทางอีเมล"><MailPlus size={16} />เชิญทุกคนที่ยังไม่มีบัญชี ({withoutAccount.length})</button>}
            <button className="tech-button-primary" onClick={() => setAdding(true)}><UserPlus size={16} />เพิ่มผู้สมัคร</button>
          </div>
        </div>
      )}
      {session && <SessionMeetingCard session={session} />}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "12px" }}>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <button onClick={() => setFilter("all")} className={filter === "all" ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "4px 12px", fontSize: "12px" }}>ทั้งหมด ({rows.length})</button>
          {(Object.keys(REG_STATUS) as RegistrationStatus[]).filter(s => rows.some(r => r.status === s)).map(s => (
            <button key={s} onClick={() => setFilter(s)} className={filter === s ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "4px 12px", fontSize: "12px" }}>
              {REG_STATUS[s].label} ({totals[s]} คน)
            </button>
          ))}
        </div>
        <label style={{ fontSize: "13px", display: "flex", gap: "6px", alignItems: "center", color: "var(--text-secondary)" }}>
          <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />
          ส่งอีเมลแจ้งผู้สมัครเมื่อยืนยัน / ชำระแล้ว / ยกเลิก
        </label>
      </div>

      <div className="glass-card" style={{ padding: "8px", overflowX: "auto" }}>
        {visible.length === 0 ? <Empty text="ยังไม่มีผู้สมัครในกลุ่มนี้" /> : (
          <table style={tableStyle}>
            <thead><tr>
              <th style={thStyle}>ผู้สมัคร</th><th style={thStyle}>ติดต่อ</th><th style={thStyle}>คน</th>
              <th style={thStyle}>สถานะ</th><th style={thStyle}>บัญชี LMS</th><th style={thStyle}>ดำเนินการ</th>
            </tr></thead>
            <tbody>
              {visible.map(r => (
                <tr key={r.id} style={{ opacity: busy === r.id ? 0.5 : 1 }}>
                  <td style={tdStyle}>
                    <button onClick={() => setDetail(r)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontWeight: 700, color: "var(--text-primary)", textAlign: "left", fontSize: "14px" }}>{r.name}</button>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{r.company || "บุคคลทั่วไป"}{r.invoice_required ? " · ขอใบกำกับภาษี" : ""}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{formatDateTime(r.created_at)}{r.source === "admin" ? " · เจ้าหน้าที่เพิ่ม" : ""}</div>
                  </td>
                  <td style={tdStyle}><div>{r.phone}</div><div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{r.email}</div></td>
                  <td style={tdStyle}>{r.attendees}</td>
                  <td style={tdStyle}>
                    <Chip {...REG_STATUS[r.status]} />
                    {r.payment_ref && <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>อ้างอิง: {r.payment_ref}</div>}
                    {r.admin_note && <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>📝 {r.admin_note}</div>}
                    {r.reminder_sent_at && <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>ส่งอีเมลเตือนแล้ว {formatDateTime(r.reminder_sent_at)}</div>}
                  </td>
                  <td style={tdStyle}>
                    <AccountCell registration={r} hasCourse={!!session?.course_id} busy={busy === r.id} onInvite={async () => { if (await invite(r)) await load(); }} />
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    {QUICK_ACTIONS.filter(([s]) => s !== r.status).map(([s, label]) => (
                      <button key={s} disabled={busy === r.id}
                        onClick={() => {
                          if (s === "paid") {
                            const ref = prompt("เลขอ้างอิงการชำระเงิน (ไม่บังคับ)", r.payment_ref || "");
                            if (ref === null) return;
                            update(r, { status: s, payment_ref: ref });
                          } else if (s === "cancelled") {
                            if (confirm(`ยกเลิกการลงทะเบียนของ ${r.name}?`)) update(r, { status: s });
                          } else update(r, { status: s });
                        }}
                        className="tech-button-outline"
                        style={{ padding: "4px 10px", fontSize: "12px", marginRight: "6px", borderWidth: "1px", color: s === "cancelled" ? "var(--danger)" : undefined, borderColor: s === "cancelled" ? "var(--danger)" : undefined }}>
                        {label}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {adding && session && <RegistrationForm api={api} session={session} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
      {detail && <RegistrationDetail registration={detail} onClose={() => setDetail(null)} onSave={async body => { if (await update(detail, body)) setDetail(null); }} onDelete={() => remove(detail)} />}
    </div>
  );
};

/** Account status per registrant; registrants without one get "สร้างบัญชีและส่งคำเชิญ". */
const AccountCell: React.FC<{ registration: Registration; hasCourse: boolean; busy: boolean; onInvite: () => void }> = ({ registration: r, hasCourse, busy, onInvite }) => {
  const small: React.CSSProperties = { fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" };
  if (!r.account_id) {
    if (r.status === "cancelled") return <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>ไม่มีบัญชี</span>;
    return (
      <button className="tech-button-outline" disabled={busy} onClick={onInvite}
        style={{ padding: "4px 10px", fontSize: "12px", borderWidth: "1px" }} title="สร้างบัญชีผู้เรียนและส่งลิงก์ตั้งรหัสผ่านทางอีเมล">
        <MailPlus size={14} />สร้างบัญชีและส่งคำเชิญ
      </button>
    );
  }
  const chip = r.account_status === "suspended"
    ? { label: "บัญชีถูกระงับ", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" }
    : r.account_last_login
      ? { label: "มีบัญชีแล้ว", color: "var(--accent)", bg: "var(--accent-glow)" }
      : { label: "รอตั้งรหัสผ่าน", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" };
  return (
    <div>
      <Chip {...chip} />
      {hasCourse && <div style={small}>{r.course_access ? "เข้าคอร์สออนไลน์ได้แล้ว" : "ได้คอร์สออนไลน์เมื่อยืนยัน/ชำระแล้ว"}</div>}
      {!r.account_last_login && r.account_status !== "suspended" && (
        <button onClick={onInvite} disabled={busy} style={{ ...small, background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--primary)", textDecoration: "underline" }}>ส่งคำเชิญอีกครั้ง</button>
      )}
    </div>
  );
};

const RegistrationForm: React.FC<{ api: Api; session: AdminSession; onClose: () => void; onSaved: () => void }> = ({ api, session, onClose, onSaved }) => {
  const full = session.seats_taken >= session.capacity;
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", attendees: 1, status: full ? "waitlist" : "confirmed", invoice_required: false, tax_id: "", billing_address: "", admin_note: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [key]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);
      await api.post(`/admin/site/sessions/${session.id}/registrations`, { ...form, attendees: Number(form.attendees) });
      onSaved();
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };
  return (
    <Modal title={`เพิ่มผู้สมัคร: ${session.title}`} onClose={onClose}>
      <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "12px" }}>สำหรับผู้ที่สมัครทางโทรศัพท์ อีเมล หรือ LINE · เหลือ {Math.max(0, session.capacity - session.seats_taken)} ที่นั่ง</p>
      <ErrorBox message={error} />
      <form onSubmit={save} style={grid2}>
        <Field label="ชื่อ-นามสกุล *"><input className="form-input" required value={form.name} onChange={set("name")} /></Field>
        <Field label="บริษัท / หน่วยงาน"><input className="form-input" value={form.company} onChange={set("company")} /></Field>
        <Field label="อีเมล *"><input className="form-input" type="email" required value={form.email} onChange={set("email")} /></Field>
        <Field label="เบอร์โทร *"><input className="form-input" required value={form.phone} onChange={set("phone")} /></Field>
        <Field label="จำนวนผู้เข้าอบรม *"><input className="form-input" type="number" min={1} max={50} required value={form.attendees} onChange={set("attendees")} /></Field>
        <Field label="สถานะ">
          <select className="form-input" value={form.status} onChange={set("status")}>
            {(["confirmed", "pending", "paid", "waitlist"] as RegistrationStatus[]).map(s => <option key={s} value={s}>{REG_STATUS[s].label}</option>)}
          </select>
        </Field>
        <label style={{ gridColumn: "1 / -1", fontSize: "14px", display: "flex", gap: "8px", alignItems: "center" }}>
          <input type="checkbox" checked={form.invoice_required} onChange={set("invoice_required")} /> ต้องการใบกำกับภาษี
        </label>
        {form.invoice_required && <>
          <Field label="เลขประจำตัวผู้เสียภาษี (13 หลัก) *"><input className="form-input" required value={form.tax_id} onChange={set("tax_id")} /></Field>
          <Field label="ที่อยู่ออกใบกำกับภาษี *" span><textarea className="form-input" rows={2} required value={form.billing_address} onChange={set("billing_address")} /></Field>
        </>}
        <Field label="หมายเหตุเจ้าหน้าที่" span><textarea className="form-input" rows={2} value={form.admin_note} onChange={set("admin_note")} /></Field>
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={saving}>{saving ? "กำลังบันทึก…" : "เพิ่มผู้สมัคร"}</button>
        </div>
      </form>
    </Modal>
  );
};

const RegistrationDetail: React.FC<{ registration: Registration; onClose: () => void; onSave: (body: Record<string, unknown>) => void; onDelete: () => void }> = ({ registration: r, onClose, onSave, onDelete }) => {
  const [form, setForm] = useState({ status: r.status, attendees: r.attendees, payment_ref: r.payment_ref || "", admin_note: r.admin_note || "", phone: r.phone, company: r.company || "" });
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm(prev => ({ ...prev, [key]: e.target.value }));
  const info: Array<[string, React.ReactNode]> = [
    ["อีเมล", r.email], ["หมายเหตุจากผู้สมัคร", r.note || "-"],
    ["ใบกำกับภาษี", r.invoice_required ? `ต้องการ · ${r.tax_id || "-"}` : "ไม่ต้องการ"],
    ["ที่อยู่ออกใบกำกับ", r.billing_address || "-"], ["สมัครเมื่อ", formatDateTime(r.created_at)]
  ];
  return (
    <Modal title={r.name} onClose={onClose}>
      <dl style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "8px 12px", fontSize: "14px", marginBottom: "20px" }}>
        {info.map(([k, v]) => <React.Fragment key={k}><dt style={{ color: "var(--text-muted)" }}>{k}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{v}</dd></React.Fragment>)}
      </dl>
      <form onSubmit={e => { e.preventDefault(); onSave({ ...form, attendees: Number(form.attendees) }); }} style={grid2}>
        <Field label="สถานะ">
          <select className="form-input" value={form.status} onChange={set("status")}>
            {(Object.keys(REG_STATUS) as RegistrationStatus[]).map(s => <option key={s} value={s}>{REG_STATUS[s].label}</option>)}
          </select>
        </Field>
        <Field label="จำนวนผู้เข้าอบรม"><input className="form-input" type="number" min={1} max={50} value={form.attendees} onChange={set("attendees")} /></Field>
        <Field label="เบอร์โทร"><input className="form-input" value={form.phone} onChange={set("phone")} /></Field>
        <Field label="บริษัท"><input className="form-input" value={form.company} onChange={set("company")} /></Field>
        <Field label="เลขอ้างอิงการชำระเงิน" span><input className="form-input" value={form.payment_ref} onChange={set("payment_ref")} placeholder="เลขที่โอน / ใบแจ้งหนี้" /></Field>
        <Field label="หมายเหตุเจ้าหน้าที่" span><textarea className="form-input" rows={3} value={form.admin_note} onChange={set("admin_note")} /></Field>
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "space-between", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onDelete} style={{ color: "var(--danger)", borderColor: "var(--danger)" }}><Trash2 size={14} />ลบรายการ</button>
          <div style={{ display: "flex", gap: "10px" }}>
            <button type="button" className="tech-button-outline" onClick={onClose}>ปิด</button>
            <button type="submit" className="tech-button-primary">บันทึก</button>
          </div>
        </div>
      </form>
    </Modal>
  );
};
