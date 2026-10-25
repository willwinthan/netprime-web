import React, { useEffect, useState } from "react";
import { Video, Trash2, Download, ExternalLink } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox, Field, grid2 } from "../site-admin/ui";
import { Notice, del, formatInstant, fromLocalInput, put, toLocalInput } from "./shared";

export type MeetingProvider = "zoom" | "teams" | "meet" | "manual";
export type ProviderStatus = Record<MeetingProvider, { configured: boolean; automatic: boolean; label: string }>;
interface Meeting {
  provider: MeetingProvider; join_url: string; external_id: string | null; passcode: string | null; starts_at: string;
  duration_minutes: number; attendance_imported_at: string | null;
}

/** First "HH:MM" of the session's free-text time (e.g. "09:00–16:00"), as a Bangkok date-time. */
export function defaultStart(date: string, timeText?: string | null): string {
  const hhmm = timeText?.match(/(\d{1,2})[:.](\d{2})/);
  const time = hhmm ? `${hhmm[1].padStart(2, "0")}:${hhmm[2]}` : "09:00";
  return new Date(`${date}T${time}:00+07:00`).toISOString();
}

export const ProviderSelect: React.FC<{ value: MeetingProvider; providers: ProviderStatus | null; onChange: (p: MeetingProvider) => void }> = ({ value, providers, onChange }) => (
  <select className="form-input" value={value} onChange={e => onChange(e.target.value as MeetingProvider)}>
    {(["zoom", "teams", "meet", "manual"] as MeetingProvider[]).map(p => (
      <option key={p} value={p} disabled={!!providers && !providers[p].configured}>
        {providers?.[p].label ?? p}{providers && !providers[p].configured ? " (ยังไม่ได้ตั้งค่า)" : providers?.[p].automatic ? " – สร้างห้องอัตโนมัติ" : ""}
      </option>
    ))}
  </select>
);

/**
 * Online meeting of an online/hybrid training session (mounted in SessionsPanel's registrations view).
 * Registrants with status confirmed/paid see the join button 30 minutes before the start.
 */
export const SessionMeetingCard: React.FC<{ session: { id: string; mode: string; start_date: string; time_text: string | null } }> = ({ session }) => {
  const api = useApi();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [form, setForm] = useState({ provider: "manual" as MeetingProvider, join_url: "", passcode: "", starts_at: "", duration_minutes: 180 });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const data = await api.get<{ meeting: Meeting | null; providers: ProviderStatus }>(`/live/sessions/${session.id}/meeting`);
      setMeeting(data.meeting);
      setProviders(data.providers);
    } catch (err: any) { setError(err.message); }
  };
  useEffect(() => { if (session.mode !== "classroom") load(); }, [session.id, session.mode, api.token]);
  if (session.mode === "classroom") return null;

  const startEdit = () => {
    setForm({
      provider: meeting?.provider ?? (providers?.zoom.configured ? "zoom" : "manual"), join_url: meeting?.join_url ?? "", passcode: meeting?.passcode ?? "",
      starts_at: toLocalInput(meeting?.starts_at ?? defaultStart(session.start_date, session.time_text)), duration_minutes: meeting?.duration_minutes ?? 180
    });
    setEditing(true);
  };
  const automatic = form.provider === "zoom" || form.provider === "teams";
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      const res = await put<{ meeting: Meeting; message: string }>(api, `/live/sessions/${session.id}/meeting`, {
        provider: form.provider, join_url: automatic ? undefined : form.join_url, passcode: form.passcode || null,
        starts_at: fromLocalInput(form.starts_at), duration_minutes: Number(form.duration_minutes)
      });
      setMeeting(res.meeting);
      setNotice(res.message);
      setEditing(false);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm("ลบห้องประชุมออนไลน์ของรอบนี้?")) return;
    try { await del(api, `/live/sessions/${session.id}/meeting`); setMeeting(null); } catch (err: any) { setError(err.message); }
  };
  const importAttendance = async () => {
    try { setBusy(true); setNotice((await api.post<{ message: string }>(`/live/sessions/${session.id}/meeting/import-attendance`, {})).message); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="glass-card" style={{ padding: "18px 20px", marginBottom: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <h3 style={{ fontSize: "15px", display: "flex", gap: "8px", alignItems: "center" }}><Video size={16} />ห้องเรียนออนไลน์</h3>
          {meeting ? (
            <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>
              {providers?.[meeting.provider].label ?? meeting.provider} · เริ่ม {formatInstant(meeting.starts_at)} · {meeting.duration_minutes} นาที
              {meeting.passcode && <> · รหัส <code>{meeting.passcode}</code></>}
              <div style={{ wordBreak: "break-all" }}><a href={meeting.join_url} target="_blank" rel="noreferrer">{meeting.join_url} <ExternalLink size={12} /></a></div>
              <div style={{ color: "var(--text-muted)" }}>ผู้สมัครที่ยืนยัน/ชำระแล้วเห็นปุ่มเข้าร่วมตั้งแต่ 30 นาทีก่อนเริ่ม · บันทึกการเข้าอบรมด้วยปุ่ม “เข้าอบรมแล้ว” ในรายชื่อด้านล่าง</div>
              {meeting.attendance_imported_at && <div style={{ color: "var(--text-muted)" }}>นำเข้าการเข้าร่วมจาก Zoom ล่าสุด {formatInstant(meeting.attendance_imported_at)}</div>}
            </div>
          ) : <div style={{ fontSize: "13px", color: "var(--text-muted)", marginTop: "4px" }}>ยังไม่ได้สร้างห้อง Zoom / Teams / Google Meet สำหรับรอบนี้</div>}
        </div>
        {!editing && <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {meeting?.provider === "zoom" && meeting.external_id && <button className="tech-button-outline" disabled={busy} onClick={importAttendance} title="ทำเครื่องหมาย “เข้าอบรมแล้ว” ให้ผู้สมัครที่อีเมลตรงกับรายงานผู้เข้าร่วม Zoom"><Download size={16} />นำเข้าการเข้าร่วมจาก Zoom</button>}
          <button className="tech-button-outline" onClick={startEdit}>{meeting ? "แก้ไขห้อง" : "สร้างห้องออนไลน์"}</button>
          {meeting && <button className="tech-button-outline" style={{ color: "var(--danger)" }} onClick={remove} aria-label="ลบห้อง"><Trash2 size={16} /></button>}
        </div>}
      </div>
      <div style={{ marginTop: error || notice || editing ? "14px" : 0 }}>
        <ErrorBox message={error} />
        <Notice message={notice} />
        {editing && (
          <form onSubmit={save} style={grid2}>
            <Field label="ผู้ให้บริการ"><ProviderSelect value={form.provider} providers={providers} onChange={p => setForm(f => ({ ...f, provider: p }))} /></Field>
            <Field label="เวลาเริ่ม (ตามเครื่องของคุณ)"><input className="form-input" type="datetime-local" required value={form.starts_at} onChange={e => setForm(f => ({ ...f, starts_at: e.target.value }))} /></Field>
            <Field label="ระยะเวลา (นาที)"><input className="form-input" type="number" min={15} max={1440} value={form.duration_minutes} onChange={e => setForm(f => ({ ...f, duration_minutes: Number(e.target.value) }))} /></Field>
            {!automatic && <Field label="ลิงก์เข้าร่วม *" hint={form.provider === "meet" ? "https://meet.google.com/…" : "https://…"} span>
              <input className="form-input" type="url" required value={form.join_url} onChange={e => setForm(f => ({ ...f, join_url: e.target.value }))} />
            </Field>}
            {!automatic && <Field label="รหัสผ่านห้อง (ถ้ามี)"><input className="form-input" maxLength={64} value={form.passcode} onChange={e => setForm(f => ({ ...f, passcode: e.target.value }))} /></Field>}
            {automatic && <p style={{ gridColumn: "1 / -1", fontSize: "13px", color: "var(--text-secondary)", margin: 0 }}>ระบบจะสร้างห้องใหม่ใน {providers?.[form.provider].label} ให้อัตโนมัติ (บันทึกซ้ำ = สร้างห้องใหม่)</p>}
            <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button type="button" className="tech-button-outline" onClick={() => setEditing(false)}>ยกเลิก</button>
              <button type="submit" className="tech-button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : "บันทึกห้อง"}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
