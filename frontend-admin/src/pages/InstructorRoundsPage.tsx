import React, { useEffect, useState } from "react";
import { CalendarPlus, Pencil, Trash2, Users } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { pickedDays, shiftDays } from "../components/calendar/calendarDates";
import { DaysField, IconButton } from "../components/site-admin/SessionsPanel";
import {
  AdminSession, Chip, Empty, ErrorBox, Field, MODE_LABEL, Modal, REG_STATUS, RegistrationStatus, SESSION_STATUS, SeatBar,
  formatBaht, formatSessionDates, grid2, sessionDays, tableStyle, tdStyle, thStyle
} from "../components/site-admin/ui";

type Api = ReturnType<typeof useApi>;
interface Attendee { id: string; name: string; company: string | null; attendees: number; status: RegistrationStatus }
interface CourseOption { id: string; title: string }

const EMPTY = { course_id: "", title: "", start_date: "", end_date: "", time_text: "09:00–16:00", mode: "classroom", location: "", price: 0, capacity: 20, registration_deadline: "", description: "" };

/** Instructors schedule rounds of their own courses; staff check each draft and open it for registration. */
export const InstructorRoundsPage: React.FC = () => {
  const api = useApi();
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<AdminSession> | null>(null);
  const [viewing, setViewing] = useState<AdminSession | null>(null);

  const load = () => api.get<{ sessions: AdminSession[] }>("/instructor/sessions").then(d => setSessions(d.sessions)).catch(err => setError(err.message));
  useEffect(() => {
    load();
    api.get<{ courses: CourseOption[] }>("/instructor/sessions/course-options").then(d => setCourses(d.courses)).catch(() => setCourses([]));
  }, [api.token]);

  const remove = async (session: AdminSession) => {
    if (!confirm(`ลบรอบ "${session.title}"?`)) return;
    try {
      await api.request(`/instructor/sessions/${session.id}`, { method: "DELETE" });
      await load();
    } catch (err: any) { setError(err.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "16px" }}>
        <div>
          <h1 style={{ fontSize: "22px" }}>รอบอบรมของฉัน</h1>
          <p style={{ fontSize: "14px", color: "var(--text-secondary)" }}>ลงรอบเป็นฉบับร่างได้เอง เจ้าหน้าที่จะตรวจและเปิดรับสมัครให้</p>
        </div>
        <button className="tech-button-primary" disabled={courses.length === 0} title={courses.length === 0 ? "ต้องมีคอร์สที่เผยแพร่แล้วก่อน" : undefined}
          onClick={() => setEditing({})}><CalendarPlus size={16} />ลงรอบอบรม</button>
      </div>
      <ErrorBox message={error} />
      <div className="glass-card" style={{ padding: "8px", overflowX: "auto" }}>
        {!sessions ? <Empty text="กำลังโหลด…" /> : sessions.length === 0 ? <Empty text="ยังไม่มีรอบอบรม กด 'ลงรอบอบรม' เพื่อเริ่ม" /> : (
          <table style={tableStyle}>
            <thead><tr>
              <th style={thStyle}>หลักสูตร</th><th style={thStyle}>วันที่</th><th style={thStyle}>ที่นั่ง</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th>
            </tr></thead>
            <tbody>
              {sessions.map(s => (
                <tr key={s.id}>
                  <td style={tdStyle}><strong>{s.title}</strong><div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{MODE_LABEL[s.mode]} · {formatBaht(s.price)}</div></td>
                  <td style={tdStyle}>{formatSessionDates(s)}<div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{s.time_text}</div></td>
                  <td style={tdStyle}><SeatBar taken={s.seats_taken} capacity={s.capacity} /></td>
                  <td style={tdStyle}><Chip {...SESSION_STATUS[s.status]} label={s.status === "draft" ? "รอเจ้าหน้าที่เปิดรับสมัคร" : SESSION_STATUS[s.status].label} /></td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    <IconButton title="ผู้สมัคร" onClick={() => setViewing(s)}><Users size={16} /></IconButton>
                    {s.status === "draft" && <>
                      <IconButton title="แก้ไข" onClick={() => setEditing(s)}><Pencil size={16} /></IconButton>
                      <IconButton title="ลบ" danger onClick={() => remove(s)}><Trash2 size={16} /></IconButton>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <RoundForm api={api} initial={editing} courses={courses} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {viewing && <Attendees api={api} session={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
};

const RoundForm: React.FC<{ api: Api; initial: Partial<AdminSession>; courses: CourseOption[]; onClose: () => void; onSaved: () => void }> = ({ api, initial, courses, onClose, onSaved }) => {
  const [form, setForm] = useState<Record<string, any>>(() => {
    const values: Record<string, any> = { ...EMPTY };
    for (const key of Object.keys(EMPTY)) values[key] = (initial as any)[key] ?? (EMPTY as any)[key];
    return values;
  });
  const [days, setDays] = useState<string[] | null>(() => sessionDays(initial.session_dates));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm(prev => ({ ...prev, [key]: e.target.value }));
  const moveStart = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDays(current => shiftDays(current, form.start_date, e.target.value));
    set("start_date")(e);
  };
  const pickCourse = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const course = courses.find(c => c.id === e.target.value);
    setForm(prev => ({ ...prev, course_id: e.target.value, title: prev.title || course?.title || "" }));
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);
      const body = { ...form, price: Number(form.price), capacity: Number(form.capacity), session_dates: pickedDays(form.start_date, form.end_date, days) };
      if (initial.id) await api.patch(`/instructor/sessions/${initial.id}`, body);
      else await api.post("/instructor/sessions", body);
      onSaved();
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };
  return (
    <Modal title={initial.id ? "แก้ไขรอบอบรม" : "ลงรอบอบรม"} onClose={onClose} width={720}>
      <ErrorBox message={error} />
      <form onSubmit={save} style={grid2}>
        <Field label="คอร์สของคุณ *" span>
          <select className="form-input" required value={form.course_id} onChange={pickCourse}>
            <option value="">— เลือกคอร์ส —</option>
            {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </Field>
        <Field label="ชื่อรอบ *" span><input className="form-input" required maxLength={160} value={form.title} onChange={set("title")} /></Field>
        <Field label="วันเริ่ม *"><input className="form-input" type="date" required value={form.start_date} onChange={moveStart} /></Field>
        <Field label="วันสิ้นสุด *"><input className="form-input" type="date" required min={form.start_date || undefined} value={form.end_date} onChange={set("end_date")} /></Field>
        <DaysField start={form.start_date} end={form.end_date} value={days} onChange={setDays} />
        <Field label="เวลาอบรม"><input className="form-input" maxLength={80} value={form.time_text} onChange={set("time_text")} /></Field>
        <Field label="ปิดรับสมัครวันที่" hint="เว้นว่าง = รับถึงวันเริ่มอบรม"><input className="form-input" type="date" max={form.end_date || undefined} value={form.registration_deadline || ""} onChange={set("registration_deadline")} /></Field>
        <Field label="รูปแบบ *">
          <select className="form-input" value={form.mode} onChange={set("mode")}>
            {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="สถานที่ / ช่องทาง"><input className="form-input" maxLength={200} value={form.location} onChange={set("location")} /></Field>
        <Field label="ราคา (บาท) *" hint="0 = ฟรี"><input className="form-input" type="number" min={0} step={1} required value={form.price} onChange={set("price")} /></Field>
        <Field label="จำนวนที่นั่ง *"><input className="form-input" type="number" min={1} max={1000} required value={form.capacity} onChange={set("capacity")} /></Field>
        <Field label="รายละเอียด" span><textarea className="form-input" rows={3} maxLength={2000} value={form.description} onChange={set("description")} /></Field>
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={saving}>{saving ? "กำลังบันทึก…" : "บันทึกฉบับร่าง"}</button>
        </div>
      </form>
    </Modal>
  );
};

const Attendees: React.FC<{ api: Api; session: AdminSession; onClose: () => void }> = ({ api, session, onClose }) => {
  const [rows, setRows] = useState<Attendee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ registrations: Attendee[] }>(`/instructor/sessions/${session.id}/registrations`).then(d => setRows(d.registrations)).catch(err => setError(err.message));
  }, [session.id, api.token]);
  return (
    <Modal title={`ผู้สมัคร: ${session.title}`} onClose={onClose}>
      <ErrorBox message={error} />
      {!rows ? !error && <Empty text="กำลังโหลด…" /> : rows.length === 0 ? <Empty text="ยังไม่มีผู้สมัคร" /> : (
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>ชื่อ</th><th style={thStyle}>บริษัท</th><th style={thStyle}>คน</th><th style={thStyle}>สถานะ</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td style={tdStyle}>{r.name}</td><td style={tdStyle}>{r.company || "-"}</td><td style={tdStyle}>{r.attendees}</td>
                <td style={tdStyle}><Chip {...REG_STATUS[r.status]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
};
