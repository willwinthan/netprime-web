import React, { useEffect, useState } from "react";
import { Plus, Send, Clock, FlaskConical, Users, RefreshCw, Trash2 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, ErrorBox, Empty, Field, Modal, formatDateTime, grid2, tableStyle, thStyle, tdStyle } from "../site-admin/ui";
import { RichTextEditor, SafeHtml } from "./RichTextEditor";

export interface CommMeta {
  access: "manage" | "instructor" | null;
  can_manage: boolean;
  can_moderate: boolean;
  channels: { email: boolean; in_app: boolean; push: boolean; line: boolean };
  courses: Array<{ id: string; title: string }>;
  segments: Array<{ id: string; name: string }>;
  partners: Array<{ id: string; company_name: string }>;
  templates: string[];
}

type Channel = "email" | "in_app" | "push" | "line";
type Counts = Record<string, number>;
interface Broadcast {
  id: string; title: string; subject: string; body: string; body_html: string; category: "marketing" | "course" | "system";
  channels: Channel[]; audience: { segment_id?: string; rules?: Record<string, any> }; course_id: string | null; link: string | null;
  status: "draft" | "scheduled" | "sending" | "sent" | "cancelled" | "failed"; scheduled_at: string | null; recipient_count: number;
  created_at: string; sent_at: string | null;
  delivery: { total: number; by_status: Counts; by_channel: Record<string, Counts> } | null;
}

export const CHANNEL_LABEL: Record<Channel, string> = { email: "อีเมล", in_app: "ในระบบ", push: "Web Push", line: "LINE" };
const CATEGORY_LABEL = { marketing: "ข่าวสาร/การตลาด", course: "อัปเดตคอร์ส", system: "แจ้งเตือนระบบ (ส่งเสมอ)" };
const STATUS: Record<Broadcast["status"], { label: string; color: string; bg: string }> = {
  draft: { label: "ฉบับร่าง", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" },
  scheduled: { label: "ตั้งเวลาไว้", color: "var(--primary)", bg: "var(--primary-glow)" },
  sending: { label: "กำลังส่ง", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  sent: { label: "ส่งแล้ว", color: "var(--accent)", bg: "var(--accent-glow)" },
  cancelled: { label: "ยกเลิก", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" },
  failed: { label: "ล้มเหลว", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" }
};
const ROLES = [["student", "ผู้เรียน"], ["instructor", "ผู้สอน"], ["partner", "องค์กร"], ["coordinator", "เจ้าหน้าที่"], ["admin", "ผู้ดูแลระบบ"]];
const DETAIL_LABEL: Record<string, string> = {
  unsubscribed: "ผู้รับปิดการรับช่องทางนี้", not_configured: "ระบบยังไม่ได้ตั้งค่าช่องทางนี้", no_subscription: "ไม่มีอุปกรณ์ที่ลงทะเบียน",
  not_linked: "ยังไม่ได้เชื่อม LINE", no_email: "ไม่มีอีเมล", cancelled: "ยกเลิกแล้ว", provider_error: "ผู้ให้บริการอีเมลปฏิเสธ", push_error: "ส่ง push ไม่สำเร็จ", line_error: "ส่ง LINE ไม่สำเร็จ"
};

interface Form {
  title: string; subject: string; body: string; category: Broadcast["category"]; channels: Channel[]; link: string; course_id: string;
  segment_id: string; roles: string[]; enrolled_course_ids: string[]; partner_ids: string[]; tags: string;
}
const EMPTY: Form = { title: "", subject: "", body: "", category: "marketing", channels: ["email", "in_app"], link: "", course_id: "", segment_id: "", roles: [], enrolled_course_ids: [], partner_ids: [], tags: "" };

function toForm(b: Broadcast): Form {
  const r = b.audience.rules ?? {};
  return {
    title: b.title, subject: b.subject === b.title ? "" : b.subject, body: b.body, category: b.category, channels: b.channels, link: b.link ?? "", course_id: b.course_id ?? "",
    segment_id: b.audience.segment_id ?? "", roles: r.roles ?? [], enrolled_course_ids: r.enrolled_course_ids ?? [], partner_ids: r.partner_ids ?? [], tags: (r.tags ?? []).join(", ")
  };
}

function toPayload(f: Form) {
  const rules: Record<string, unknown> = {};
  if (f.roles.length) rules.roles = f.roles;
  if (f.enrolled_course_ids.length) rules.enrolled_course_ids = f.enrolled_course_ids;
  if (f.partner_ids.length) rules.partner_ids = f.partner_ids;
  const tags = f.tags.split(",").map(t => t.trim()).filter(Boolean);
  if (tags.length) rules.tags = tags;
  return {
    title: f.title, subject: f.subject || undefined, body: f.body, category: f.category, channels: f.channels, link: f.link || undefined,
    course_id: f.course_id || undefined, audience: f.segment_id ? { segment_id: f.segment_id } : { rules }
  };
}

const MultiSelect: React.FC<{ label: string; options: Array<[string, string]>; value: string[]; onChange: (v: string[]) => void }> = ({ label, options, value, onChange }) => (
  <Field label={label} hint="กด Ctrl/⌘ เพื่อเลือกหลายรายการ ไม่เลือก = ไม่จำกัด">
    <select multiple className="form-input" value={value} onChange={e => onChange(Array.from(e.target.selectedOptions).map(o => o.value))} style={{ minHeight: "84px" }}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </Field>
);

/** Broadcast history + composer (communication.manage; instructors for their own course learners). */
export const BroadcastsPanel: React.FC<{ meta: CommMeta }> = ({ meta }) => {
  const api = useApi();
  const [items, setItems] = useState<Broadcast[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [scheduleAt, setScheduleAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{ broadcast: Broadcast; issues: Array<{ name: string; email: string; channel: Channel; status: string; detail: string | null }> } | null>(null);
  const instructor = meta.access === "instructor";

  const load = () => api.get<{ broadcasts: Broadcast[] }>("/communication/broadcasts").then(d => setItems(d.broadcasts)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);
  useEffect(() => {
    if (!items.some(b => b.status === "sending")) return;
    const timer = window.setTimeout(load, 4000);
    return () => window.clearTimeout(timer);
  }, [items]);

  const set = (patch: Partial<Form>) => { setEditing(e => e && { ...e, form: { ...e.form, ...patch } }); setAudienceCount(null); };

  const save = async (): Promise<string | null> => {
    if (!editing) return null;
    const payload = toPayload(editing.form);
    const res = editing.id
      ? await api.request<{ broadcast: Broadcast }>(`/communication/broadcasts/${editing.id}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api.post<{ broadcast: Broadcast }>("/communication/broadcasts", payload);
    setEditing(e => e && { ...e, id: res.broadcast.id });
    return res.broadcast.id;
  };

  const run = async (action: () => Promise<void>) => {
    try { setBusy(true); setError(null); setNotice(null); await action(); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const previewAudience = () => run(async () => {
    if (!editing) return;
    const res = await api.post<{ count: number }>("/communication/audience/preview", toPayload(editing.form));
    setAudienceCount(res.count);
  });

  const saveDraft = () => run(async () => { await save(); setNotice("บันทึกฉบับร่างแล้ว"); await load(); });
  const testSend = () => run(async () => {
    const id = await save();
    const res = await api.post<{ message: string }>(`/communication/broadcasts/${id}/test`, {});
    setNotice(res.message);
  });
  const sendNow = (scheduled: boolean) => run(async () => {
    if (scheduled && !scheduleAt) throw new Error("กรุณาเลือกวันเวลาที่จะส่ง");
    const id = await save();
    const body = scheduled ? { scheduled_at: new Date(scheduleAt).toISOString() } : {};
    if (!scheduled && !window.confirm("ยืนยันส่งประกาศนี้ทันที?")) return;
    const res = await api.post<{ message: string }>(`/communication/broadcasts/${id}/send`, body);
    setNotice(res.message);
    setEditing(null);
    await load();
  });

  const cancel = (b: Broadcast) => run(async () => {
    if (!window.confirm(b.status === "draft" ? "ลบฉบับร่างนี้?" : "ยกเลิกการส่งประกาศนี้?")) return;
    const res = await api.request<{ message: string }>(`/communication/broadcasts/${b.id}`, { method: "DELETE" });
    setNotice(res.message);
    await load();
  });

  const openDetail = (b: Broadcast) => run(async () => setDetail(await api.get(`/communication/broadcasts/${b.id}`)));

  const f = editing?.form;
  return (
    <div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "14px", alignItems: "center" }}>
        <p style={{ flex: 1, margin: 0, fontSize: "13px", color: "var(--text-secondary)" }}>
          {instructor ? "ส่งประกาศถึงผู้เรียนในคอร์สของคุณ ทางอีเมล ในระบบ และอุปกรณ์" : "ส่งข่าวสารถึงกลุ่มผู้ใช้ ทางอีเมล ในระบบ Web Push และ LINE ส่งทีละ 100 คน"}
        </p>
        <button type="button" className="tech-button-outline" onClick={load} aria-label="รีเฟรช" style={{ padding: "6px 10px" }}><RefreshCw size={14} /></button>
        <button type="button" className="tech-button-primary" onClick={() => { setEditing({ id: null, form: { ...EMPTY, category: instructor ? "course" : "marketing", course_id: instructor ? meta.courses[0]?.id ?? "" : "" } }); setAudienceCount(null); }}
          style={{ padding: "8px 14px", display: "inline-flex", gap: "6px", alignItems: "center" }}><Plus size={14} />สร้างประกาศ</button>
      </div>
      <ErrorBox message={editing ? null : error} />
      {notice && !editing && <div role="status" style={{ color: "var(--accent)", fontSize: "13px", marginBottom: "10px" }}>{notice}</div>}

      {items.length === 0 ? <Empty text="ยังไม่มีประกาศ" /> : (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>หัวข้อ</th><th style={thStyle}>สถานะ</th><th style={thStyle}>ช่องทาง</th><th style={thStyle}>ผู้รับ</th><th style={thStyle}>ส่งแล้ว / ข้าม / ล้มเหลว</th><th style={thStyle}>วันที่</th><th style={thStyle}></th></tr></thead>
            <tbody>
              {items.map(b => (
                <tr key={b.id}>
                  <td style={tdStyle}><button type="button" onClick={() => openDetail(b)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontWeight: 600, textAlign: "left", color: "var(--text-primary)" }}>{b.title}</button>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{CATEGORY_LABEL[b.category]}</div></td>
                  <td style={tdStyle}><Chip {...STATUS[b.status]} />{b.status === "scheduled" && <div style={{ fontSize: "11px", marginTop: "4px" }}>{formatDateTime(b.scheduled_at)}</div>}</td>
                  <td style={tdStyle}>{b.channels.map(ch => CHANNEL_LABEL[ch]).join(", ")}</td>
                  <td style={tdStyle}>{b.recipient_count || "-"}</td>
                  <td style={tdStyle}>{b.delivery ? `${b.delivery.by_status.sent ?? 0} / ${b.delivery.by_status.skipped ?? 0} / ${b.delivery.by_status.failed ?? 0}` : "-"}
                    {b.status === "sending" && b.delivery && <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>รอส่ง {(b.delivery.by_status.queued ?? 0) + (b.delivery.by_status.sending ?? 0)}</div>}</td>
                  <td style={tdStyle}>{formatDateTime(b.sent_at || b.created_at)}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    {(b.status === "draft" || b.status === "scheduled") && <button type="button" className="tech-button-outline" onClick={() => { setEditing({ id: b.id, form: toForm(b) }); setScheduleAt(""); }} style={{ padding: "4px 10px", fontSize: "12px", marginRight: "6px" }}>แก้ไข</button>}
                    {(b.status === "draft" || b.status === "scheduled" || b.status === "sending") && <button type="button" onClick={() => cancel(b)} aria-label={b.status === "draft" ? "ลบ" : "ยกเลิกการส่ง"} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)" }}><Trash2 size={14} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && f && (
        <Modal title={editing.id ? "แก้ไขประกาศ" : "สร้างประกาศ"} onClose={() => setEditing(null)} width={780}>
          <ErrorBox message={error} />
          {notice && <div role="status" style={{ color: "var(--accent)", fontSize: "13px", marginBottom: "10px" }}>{notice}</div>}
          <div style={grid2}>
            <Field label="หัวข้อ (แสดงในระบบและ push)" span><input className="form-input" maxLength={200} value={f.title} onChange={e => set({ title: e.target.value })} /></Field>
            <Field label="หัวเรื่องอีเมล" hint="เว้นว่าง = ใช้หัวข้อ"><input className="form-input" maxLength={200} value={f.subject} onChange={e => set({ subject: e.target.value })} /></Field>
            {!instructor && (
              <Field label="ประเภท" hint="ผู้รับปิดอีเมลข่าวสาร/อัปเดตคอร์สได้ ส่วนแจ้งเตือนระบบส่งเสมอ">
                <select className="form-input" value={f.category} onChange={e => set({ category: e.target.value as Form["category"] })}>
                  {Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Field>
            )}
            {instructor && (
              <Field label="คอร์ส" hint="ส่งถึงผู้เรียนทุกคนในคอร์สนี้">
                <select className="form-input" value={f.course_id} onChange={e => set({ course_id: e.target.value })}>
                  {meta.courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              </Field>
            )}
            <Field label="ลิงก์ปุ่ม (ไม่บังคับ)" hint="https://… หรือ /path ในเว็บ"><input className="form-input" maxLength={500} value={f.link} onChange={e => set({ link: e.target.value })} /></Field>
          </div>

          <fieldset style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: "10px", padding: "10px 14px", margin: "14px 0" }}>
            <legend style={{ fontSize: "13px", fontWeight: 600, padding: "0 6px" }}>ช่องทาง</legend>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
              {(Object.keys(CHANNEL_LABEL) as Channel[]).map(ch => (
                <label key={ch} style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "14px", opacity: meta.channels[ch] ? 1 : 0.6 }}>
                  <input type="checkbox" checked={f.channels.includes(ch)} onChange={e => set({ channels: e.target.checked ? [...f.channels, ch] : f.channels.filter(x => x !== ch) })} />
                  {CHANNEL_LABEL[ch]}{!meta.channels[ch] && <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>(ยังไม่ตั้งค่า จะข้าม)</span>}
                </label>
              ))}
            </div>
          </fieldset>

          {!instructor && (
            <fieldset style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: "10px", padding: "10px 14px", marginBottom: "14px" }}>
              <legend style={{ fontSize: "13px", fontWeight: 600, padding: "0 6px" }}>กลุ่มผู้รับ</legend>
              {meta.segments.length > 0 && (
                <Field label="กลุ่มที่บันทึกไว้ (segment)" hint="เลือกแล้วจะใช้เงื่อนไขของกลุ่มนี้แทนตัวกรองด้านล่าง">
                  <select className="form-input" value={f.segment_id} onChange={e => set({ segment_id: e.target.value })}>
                    <option value="">— ใช้ตัวกรองด้านล่าง —</option>
                    {meta.segments.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
              )}
              {!f.segment_id && (
                <div style={{ ...grid2, marginTop: "8px" }}>
                  <MultiSelect label="บทบาท" options={ROLES as Array<[string, string]>} value={f.roles} onChange={v => set({ roles: v })} />
                  <MultiSelect label="ลงทะเบียนคอร์ส" options={meta.courses.map(c => [c.id, c.title])} value={f.enrolled_course_ids} onChange={v => set({ enrolled_course_ids: v })} />
                  <MultiSelect label="องค์กร" options={meta.partners.map(p => [p.id, p.company_name])} value={f.partner_ids} onChange={v => set({ partner_ids: v })} />
                  <Field label="แท็ก" hint="คั่นด้วยจุลภาค (มีแท็กใดแท็กหนึ่ง)"><input className="form-input" value={f.tags} onChange={e => set({ tags: e.target.value })} /></Field>
                </div>
              )}
              <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "6px 0 0" }}>ทุกตัวกรองต้องตรงพร้อมกัน ไม่เลือกเลย = ผู้ใช้ทุกคนที่ใช้งานอยู่</p>
            </fieldset>
          )}

          <Field label="เนื้อหา" span>
            <RichTextEditor value={f.body} onChange={v => set({ body: v })} rows={8} placeholder="เขียนประกาศ (รองรับ **ตัวหนา**, *ตัวเอียง*, ## หัวข้อ, รายการ และ [ลิงก์](https://…))" />
          </Field>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginTop: "16px" }}>
            <button type="button" className="tech-button-outline" disabled={busy} onClick={previewAudience} style={{ padding: "6px 12px", display: "inline-flex", gap: "6px", alignItems: "center" }}><Users size={14} />นับผู้รับ</button>
            {audienceCount !== null && <span style={{ fontSize: "13px" }}>{audienceCount} คน</span>}
            <span style={{ flex: 1 }} />
            <button type="button" className="tech-button-outline" disabled={busy} onClick={saveDraft} style={{ padding: "6px 12px" }}>บันทึกร่าง</button>
            <button type="button" className="tech-button-outline" disabled={busy} onClick={testSend} style={{ padding: "6px 12px", display: "inline-flex", gap: "6px", alignItems: "center" }}><FlaskConical size={14} />ส่งทดสอบถึงตัวเอง</button>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginTop: "12px", borderTop: "1px solid rgba(0,0,0,0.06)", paddingTop: "12px" }}>
            <input type="datetime-local" className="form-input" aria-label="วันเวลาที่จะส่ง" value={scheduleAt} onChange={e => setScheduleAt(e.target.value)} style={{ maxWidth: "220px" }} />
            <button type="button" className="tech-button-outline" disabled={busy || !scheduleAt} onClick={() => sendNow(true)} style={{ padding: "6px 12px", display: "inline-flex", gap: "6px", alignItems: "center" }}><Clock size={14} />ตั้งเวลาส่ง</button>
            <span style={{ flex: 1, fontSize: "11px", color: "var(--text-muted)" }}>ประกาศที่ตั้งเวลาจะส่งในรอบงานประจำวัน หรือเมื่อเปิดหน้านี้หลังถึงเวลา</span>
            <button type="button" className="tech-button-primary" disabled={busy || !f.title.trim() || !f.body.trim() || !f.channels.length} onClick={() => sendNow(false)}
              style={{ padding: "8px 16px", display: "inline-flex", gap: "6px", alignItems: "center" }}><Send size={14} />ส่งทันที</button>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal title={detail.broadcast.title} onClose={() => setDetail(null)} width={720}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "12px" }}>
            <Chip {...STATUS[detail.broadcast.status]} />
            <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>ผู้รับ {detail.broadcast.recipient_count} คน • {CATEGORY_LABEL[detail.broadcast.category]}</span>
          </div>
          {detail.broadcast.delivery && (
            <table style={{ ...tableStyle, marginBottom: "16px" }}>
              <thead><tr><th style={thStyle}>ช่องทาง</th><th style={thStyle}>ส่งแล้ว</th><th style={thStyle}>รอส่ง</th><th style={thStyle}>ข้าม</th><th style={thStyle}>ล้มเหลว</th></tr></thead>
              <tbody>{Object.entries(detail.broadcast.delivery.by_channel).map(([ch, c]) => (
                <tr key={ch}><td style={tdStyle}>{CHANNEL_LABEL[ch as Channel] ?? ch}</td><td style={tdStyle}>{c.sent ?? 0}</td><td style={tdStyle}>{(c.queued ?? 0) + (c.sending ?? 0)}</td><td style={tdStyle}>{c.skipped ?? 0}</td><td style={tdStyle}>{c.failed ?? 0}</td></tr>
              ))}</tbody>
            </table>
          )}
          <SafeHtml html={detail.broadcast.body_html} style={{ fontSize: "14px", padding: "12px", background: "rgba(15,23,42,0.03)", borderRadius: "8px" }} />
          {detail.issues.length > 0 && (
            <>
              <h3 style={{ fontSize: "14px", marginTop: "16px" }}>ผู้รับที่ข้ามหรือส่งไม่สำเร็จ (ล่าสุด 100 รายการ)</h3>
              <table style={tableStyle}>
                <tbody>{detail.issues.map((i, n) => (
                  <tr key={n}><td style={tdStyle}>{i.name}<div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{i.email}</div></td><td style={tdStyle}>{CHANNEL_LABEL[i.channel]}</td><td style={tdStyle}>{i.detail ? DETAIL_LABEL[i.detail] ?? i.detail : i.status}</td></tr>
                ))}</tbody>
              </table>
            </>
          )}
        </Modal>
      )}
    </div>
  );
};
