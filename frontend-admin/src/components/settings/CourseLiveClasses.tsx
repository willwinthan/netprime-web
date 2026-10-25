import React, { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Users, Download, Video, ExternalLink } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, ErrorBox, Empty, Field, Modal, grid2, tableStyle, thStyle, tdStyle } from "../site-admin/ui";
import { Card, Notice, del, formatInstant, fromLocalInput, put, toLocalInput } from "./shared";
import { MeetingProvider, ProviderSelect, ProviderStatus } from "./SessionMeetingCard";

interface LiveClass {
  id: string; course_id: string; title: string; description: string | null; starts_at: string; ends_at: string; duration_minutes: number;
  provider: MeetingProvider; join_url?: string; external_id?: string | null; passcode?: string | null; status: "scheduled" | "cancelled";
  attendance_count?: number; join_available?: boolean; join_opens_at?: string; attendance_imported_at?: string | null;
}

/**
 * Live classes of one online course, for the course instructor / approvers (InstructorConsole course page).
 * Learners see these in MyLiveClasses (calendar) with a join button from 30 minutes before the start.
 */
export const CourseLiveClassesPanel: React.FC<{ courseId: string }> = ({ courseId }) => {
  const api = useApi();
  const [classes, setClasses] = useState<LiveClass[]>([]);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [editing, setEditing] = useState<Partial<LiveClass> | null>(null);
  const [attendanceFor, setAttendanceFor] = useState<LiveClass | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => api.get<{ classes: LiveClass[]; providers: ProviderStatus }>(`/live/courses/${courseId}/classes`)
    .then(d => { setClasses(d.classes); setProviders(d.providers); }).catch(err => setError(err.message));
  useEffect(() => { load(); }, [courseId, api.token]);

  const remove = async (cls: LiveClass) => {
    if (!confirm(`ลบคลาสสด “${cls.title}”?`)) return;
    try { await del(api, `/live/classes/${cls.id}`); await load(); } catch (err: any) { setError(err.message); }
  };
  const cancel = async (cls: LiveClass) => {
    try { await api.patch(`/live/classes/${cls.id}`, { status: cls.status === "cancelled" ? "scheduled" : "cancelled" }); await load(); } catch (err: any) { setError(err.message); }
  };

  return (
    <div style={{ display: "grid", gap: "16px" }}>
      <ErrorBox message={error} />
      <Notice message={notice} />
      <Card title="คลาสเรียนสด" description="นัดเรียนสดผ่าน Zoom, Microsoft Teams หรือ Google Meet ผู้เรียนที่ลงทะเบียนคอร์สจะเห็นในปฏิทินและกดเข้าห้องได้ก่อนเริ่ม 30 นาที"
        actions={<button className="tech-button-primary" onClick={() => setEditing({ provider: providers?.zoom.configured ? "zoom" : "manual", duration_minutes: 60 })}><Plus size={16} />นัดคลาสสด</button>}>
        {classes.length === 0 ? <Empty text="ยังไม่มีคลาสสด" /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>คลาส</th><th style={thStyle}>เวลา</th><th style={thStyle}>ห้อง</th><th style={thStyle}>เข้าร่วม</th><th style={thStyle}></th></tr></thead>
              <tbody>
                {classes.map(cls => (
                  <tr key={cls.id} style={{ opacity: cls.status === "cancelled" ? 0.55 : 1 }}>
                    <td style={tdStyle}><strong>{cls.title}</strong> {cls.status === "cancelled" && <Chip label="ยกเลิก" color="var(--danger)" bg="rgba(239,68,68,0.1)" />}
                      {cls.description && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{cls.description}</div>}</td>
                    <td style={{ ...tdStyle, fontSize: "13px" }}>{formatInstant(cls.starts_at)}<div style={{ color: "var(--text-muted)" }}>{cls.duration_minutes} นาที</div></td>
                    <td style={{ ...tdStyle, fontSize: "13px" }}>{providers?.[cls.provider].label ?? cls.provider}
                      {cls.join_url && <div><a href={cls.join_url} target="_blank" rel="noreferrer">เปิดห้อง <ExternalLink size={12} /></a></div>}</td>
                    <td style={tdStyle}>{cls.attendance_count ?? 0} คน</td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => setAttendanceFor(cls)}><Users size={14} />การเข้าร่วม</button>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => setEditing(cls)} aria-label="แก้ไข"><Pencil size={14} /></button>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => cancel(cls)}>{cls.status === "cancelled" ? "เปิดอีกครั้ง" : "ยกเลิกคลาส"}</button>
                        <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }} onClick={() => remove(cls)} aria-label="ลบ"><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <ClassForm courseId={courseId} initial={editing} providers={providers} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {attendanceFor && <AttendanceModal cls={attendanceFor} onClose={() => { setAttendanceFor(null); load(); }} onNotice={setNotice} />}
    </div>
  );
};

const ClassForm: React.FC<{ courseId: string; initial: Partial<LiveClass>; providers: ProviderStatus | null; onClose: () => void; onSaved: () => void }> = ({ courseId, initial, providers, onClose, onSaved }) => {
  const api = useApi();
  const [form, setForm] = useState({
    title: initial.title || "", description: initial.description || "", provider: (initial.provider || "manual") as MeetingProvider,
    starts_at: toLocalInput(initial.starts_at), duration_minutes: initial.duration_minutes || 60, join_url: initial.join_url || "", passcode: initial.passcode || ""
  });
  const [error, setError] = useState<string | null>(null);
  const automatic = form.provider === "zoom" || form.provider === "teams";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError(null);
      const body = { title: form.title, description: form.description || null, provider: form.provider, starts_at: fromLocalInput(form.starts_at),
        duration_minutes: Number(form.duration_minutes), ...(automatic ? {} : { join_url: form.join_url, passcode: form.passcode || null }) };
      if (initial.id) await api.patch(`/live/classes/${initial.id}`, body);
      else await api.post(`/live/courses/${courseId}/classes`, body);
      onSaved();
    } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title={initial.id ? "แก้ไขคลาสสด" : "นัดคลาสสด"} onClose={onClose}>
      <form onSubmit={submit} style={grid2}>
        <div style={{ gridColumn: "1 / -1" }}><ErrorBox message={error} /></div>
        <Field label="ชื่อคลาส *" span><input className="form-input" required maxLength={160} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Live Q&A สัปดาห์ที่ 1" /></Field>
        <Field label="ผู้ให้บริการ"><ProviderSelect value={form.provider} providers={providers} onChange={p => setForm(f => ({ ...f, provider: p }))} /></Field>
        <Field label="เวลาเริ่ม *"><input className="form-input" type="datetime-local" required value={form.starts_at} onChange={e => setForm(f => ({ ...f, starts_at: e.target.value }))} /></Field>
        <Field label="ระยะเวลา (นาที)"><input className="form-input" type="number" min={15} max={1440} value={form.duration_minutes} onChange={e => setForm(f => ({ ...f, duration_minutes: Number(e.target.value) }))} /></Field>
        {!automatic && <Field label="ลิงก์เข้าร่วม *" span><input className="form-input" type="url" required value={form.join_url} onChange={e => setForm(f => ({ ...f, join_url: e.target.value }))} /></Field>}
        {!automatic && <Field label="รหัสผ่านห้อง"><input className="form-input" maxLength={64} value={form.passcode} onChange={e => setForm(f => ({ ...f, passcode: e.target.value }))} /></Field>}
        <Field label="รายละเอียด" span><textarea className="form-input" rows={2} maxLength={2000} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></Field>
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary">บันทึก</button>
        </div>
      </form>
    </Modal>
  );
};

interface AttendanceRow { user_id: string; name: string; email: string; source: string | null; minutes: number | null; attended_at: string | null }
const SOURCE_LABEL: Record<string, string> = { manual: "บันทึกเอง", zoom: "รายงาน Zoom", join: "กดเข้าห้อง" };

const AttendanceModal: React.FC<{ cls: LiveClass; onClose: () => void; onNotice: (m: string) => void }> = ({ cls, onClose, onNotice }) => {
  const api = useApi();
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.get<{ learners: AttendanceRow[] }>(`/live/classes/${cls.id}/attendance`).then(d => setRows(d.learners)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [cls.id]);
  const mark = async (row: AttendanceRow, attended: boolean) => {
    try { await put(api, `/live/classes/${cls.id}/attendance`, { user_id: row.user_id, attended }); await load(); } catch (err: any) { setError(err.message); }
  };
  const importZoom = async () => {
    try { onNotice((await api.post<{ message: string }>(`/live/classes/${cls.id}/import-attendance`, {})).message); await load(); } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title={`การเข้าร่วม: ${cls.title}`} onClose={onClose} width={760}>
      <ErrorBox message={error} />
      {cls.provider === "zoom" && cls.external_id && <button className="tech-button-outline" style={{ marginBottom: "12px" }} onClick={importZoom}><Download size={16} />นำเข้าจากรายงาน Zoom</button>}
      {rows.length === 0 ? <Empty text="ยังไม่มีผู้เรียนในคอร์สนี้" /> : (
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>ผู้เรียน</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.user_id}>
              <td style={tdStyle}>{r.name}<div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{r.email}</div></td>
              <td style={{ ...tdStyle, fontSize: "13px" }}>{r.source ? <><Video size={12} /> เข้าร่วม ({SOURCE_LABEL[r.source] || r.source}{r.minutes ? ` · ${r.minutes} นาที` : ""})</> : <span style={{ color: "var(--text-muted)" }}>ยังไม่บันทึก</span>}</td>
              <td style={tdStyle}><button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => mark(r, !r.source)}>{r.source ? "ยกเลิก" : "บันทึกว่าเข้าร่วม"}</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Modal>
  );
};
