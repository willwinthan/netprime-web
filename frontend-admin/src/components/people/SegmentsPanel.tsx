import React, { useEffect, useState } from "react";
import { Plus, Trash2, Users } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Empty, ErrorBox, Field, grid2, Modal, tableStyle, tdStyle, thStyle, formatDateTime } from "../site-admin/ui";
import { noticeStyle, PeopleMeta, smallButton } from "./shared";

type Role = "admin" | "coordinator" | "instructor" | "partner" | "student";
export interface SegmentRules {
  roles?: Role[]; tags?: string[]; tags_all?: string[]; exclude_tags?: string[]; partner_ids?: string[];
  enrolled_course_ids?: string[]; completed_course_ids?: string[];
  signed_up_after?: string; signed_up_before?: string; last_active_after?: string; last_active_before?: string;
  has_paid_order?: boolean; status?: "active" | "suspended" | "any";
}
interface Segment { id: string; name: string; description: string | null; rules: SegmentRules; count: number; updated_at: string }
interface Partner { id: string; company_name: string }

const ROLE_LABEL: Record<Role, string> = { admin: "ผู้ดูแลระบบ", coordinator: "เจ้าหน้าที่ประสานงาน", instructor: "ผู้สอน", partner: "พาร์ตเนอร์องค์กร", student: "ผู้เรียน" };

/** Human summary of the rules for the list. */
export function describeRules(rules: SegmentRules, meta?: PeopleMeta | null, partners?: Partner[]): string {
  const course = (id: string) => meta?.courses.find(c => c.id === id)?.title ?? id;
  const parts: string[] = [];
  if (rules.roles?.length) parts.push(`บทบาท ${rules.roles.map(r => ROLE_LABEL[r]).join("/")}`);
  if (rules.tags?.length) parts.push(`แท็ก ${rules.tags.join(" หรือ ")}`);
  if (rules.tags_all?.length) parts.push(`มีทุกแท็ก ${rules.tags_all.join(", ")}`);
  if (rules.exclude_tags?.length) parts.push(`ไม่มีแท็ก ${rules.exclude_tags.join(", ")}`);
  if (rules.partner_ids?.length) parts.push(`องค์กร ${rules.partner_ids.map(id => partners?.find(p => p.id === id)?.company_name ?? id).join("/")}`);
  if (rules.enrolled_course_ids?.length) parts.push(`ลงเรียน ${rules.enrolled_course_ids.map(course).join("/")}`);
  if (rules.completed_course_ids?.length) parts.push(`เรียนจบ ${rules.completed_course_ids.map(course).join("/")}`);
  if (rules.signed_up_after) parts.push(`สมัครตั้งแต่ ${rules.signed_up_after}`);
  if (rules.signed_up_before) parts.push(`สมัครก่อน ${rules.signed_up_before}`);
  if (rules.last_active_after) parts.push(`ใช้งานล่าสุดตั้งแต่ ${rules.last_active_after}`);
  if (rules.last_active_before) parts.push(`ไม่ได้ใช้งานตั้งแต่ ${rules.last_active_before}`);
  if (rules.has_paid_order !== undefined) parts.push(rules.has_paid_order ? "เคยชำระเงิน" : "ยังไม่เคยชำระเงิน");
  if (rules.status === "any") parts.push("รวมบัญชีที่ถูกระงับ");
  if (rules.status === "suspended") parts.push("เฉพาะบัญชีที่ถูกระงับ");
  return parts.length ? parts.join(" · ") : "ผู้ใช้ที่ใช้งานอยู่ทั้งหมด";
}

/** Saved segments with a rule builder and live member count. */
export const SegmentsPanel: React.FC<{ meta: PeopleMeta | null; partners: Partner[]; canEdit: boolean; onOpenSegment?: (segmentId: string) => void }> = ({ meta, partners, canEdit, onOpenSegment }) => {
  const api = useApi();
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [editing, setEditing] = useState<Segment | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = () => api.get<{ segments: Segment[] }>("/admin/segments").then(d => setSegments(d.segments)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const remove = async (s: Segment) => {
    if (!window.confirm(`ลบกลุ่ม "${s.name}"?`)) return;
    try { await api.request(`/admin/segments/${s.id}`, { method: "DELETE" }); setNotice("ลบกลุ่มแล้ว"); load(); }
    catch (err: any) { setError(err.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)", flex: "1 1 320px" }}>
          กลุ่มผู้ใช้ (segment) คำนวณสมาชิกใหม่ทุกครั้งตามเงื่อนไข ใช้กรองรายชื่อผู้ใช้ ส่งประกาศ และทำรายงาน
        </p>
        {canEdit && <button className="tech-button-primary" onClick={() => setEditing("new")}><Plus size={16} />สร้างกลุ่ม</button>}
      </div>
      <ErrorBox message={error} />
      {notice && <div role="status" style={noticeStyle}>{notice}</div>}
      <div className="glass-card" style={{ padding: 8, overflowX: "auto" }}>
        {!segments ? <Empty text="กำลังโหลด…" /> : segments.length === 0 ? <Empty text="ยังไม่มีกลุ่มผู้ใช้" /> : (
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>กลุ่ม</th><th style={thStyle}>เงื่อนไข</th><th style={thStyle}>สมาชิก</th><th style={thStyle}>แก้ไขล่าสุด</th><th style={thStyle}></th></tr></thead>
            <tbody>
              {segments.map(s => (
                <tr key={s.id}>
                  <td style={tdStyle}><strong>{s.name}</strong>{s.description && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{s.description}</div>}</td>
                  <td style={{ ...tdStyle, fontSize: 13 }}>{describeRules(s.rules, meta, partners)}</td>
                  <td style={tdStyle}><strong>{s.count.toLocaleString("th-TH")}</strong> คน</td>
                  <td style={{ ...tdStyle, fontSize: 13, whiteSpace: "nowrap" }}>{formatDateTime(s.updated_at)}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    {onOpenSegment && <button className="tech-button-outline" style={smallButton} onClick={() => onOpenSegment(s.id)}><Users size={14} />ดูรายชื่อ</button>}{" "}
                    {canEdit && <><button className="tech-button-outline" style={smallButton} onClick={() => setEditing(s)}>แก้ไข</button>{" "}
                      <button className="tech-button-outline" style={smallButton} aria-label={`ลบ ${s.name}`} onClick={() => remove(s)}><Trash2 size={14} /></button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <SegmentDialog meta={meta} partners={partners} segment={editing === "new" ? null : editing}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice("บันทึกกลุ่มแล้ว"); load(); }} />}
    </div>
  );
};

const MultiSelect: React.FC<{ label: string; options: Array<{ value: string; label: string }>; value: string[]; onChange: (v: string[]) => void }> = ({ label, options, value, onChange }) => (
  <Field label={label} hint="กด Ctrl/⌘ เพื่อเลือกหลายรายการ">
    <select className="form-input" multiple size={Math.min(5, Math.max(3, options.length))} value={value}
      onChange={e => onChange(Array.from(e.target.selectedOptions).map(o => o.value))}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </Field>
);

const splitTags = (text: string) => text.split(/[,|]/).map(t => t.trim().toLowerCase()).filter(Boolean);

const SegmentDialog: React.FC<{ meta: PeopleMeta | null; partners: Partner[]; segment: Segment | null; onClose: () => void; onSaved: () => void }> = ({ meta, partners, segment, onClose, onSaved }) => {
  const api = useApi();
  const [name, setName] = useState(segment?.name ?? "");
  const [description, setDescription] = useState(segment?.description ?? "");
  const [rules, setRules] = useState<SegmentRules>(segment?.rules ?? {});
  const [tagText, setTagText] = useState({ tags: (segment?.rules.tags ?? []).join(", "), tags_all: (segment?.rules.tags_all ?? []).join(", "), exclude_tags: (segment?.rules.exclude_tags ?? []).join(", ") });
  const [live, setLive] = useState<{ count: number; sample: Array<{ id: string; name: string; email: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const full: SegmentRules = { ...rules, tags: splitTags(tagText.tags), tags_all: splitTags(tagText.tags_all), exclude_tags: splitTags(tagText.exclude_tags) };
  const key = JSON.stringify(full);
  useEffect(() => {
    const t = window.setTimeout(() => {
      api.post<typeof live>("/admin/segments/preview", { rules: full }).then(d => { setLive(d); setError(null); }).catch(err => setError(err.message));
    }, 400);
    return () => window.clearTimeout(t);
  }, [key]);

  const set = <K extends keyof SegmentRules>(k: K, v: SegmentRules[K] | undefined) =>
    setRules(r => { const next = { ...r }; if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete next[k]; else next[k] = v; return next; });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      const body = { name, description, rules: full };
      if (segment) await api.patch(`/admin/segments/${segment.id}`, body);
      else await api.post("/admin/segments", body);
      onSaved();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  const courses = (meta?.courses ?? []).map(c => ({ value: c.id, label: c.title }));

  return (
    <Modal title={segment ? `แก้ไขกลุ่ม ${segment.name}` : "สร้างกลุ่มผู้ใช้"} onClose={onClose} width={760}>
      <ErrorBox message={error} />
      <form onSubmit={save} style={grid2}>
        <Field label="ชื่อกลุ่ม"><input className="form-input" required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="คำอธิบาย"><input className="form-input" maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></Field>
        <MultiSelect label="บทบาท (ข้อใดข้อหนึ่ง)" options={(Object.keys(ROLE_LABEL) as Role[]).map(r => ({ value: r, label: ROLE_LABEL[r] }))} value={rules.roles ?? []} onChange={v => set("roles", v as Role[])} />
        <MultiSelect label="องค์กร (ข้อใดข้อหนึ่ง)" options={partners.map(p => ({ value: p.id, label: p.company_name }))} value={rules.partner_ids ?? []} onChange={v => set("partner_ids", v)} />
        <Field label="มีแท็กใดแท็กหนึ่ง" hint={`คั่นด้วย , เช่น ${meta?.tags.slice(0, 2).map(t => t.tag).join(", ") || "vip, รุ่น1"}`}>
          <input className="form-input" list="segment-tags" value={tagText.tags} onChange={e => setTagText(t => ({ ...t, tags: e.target.value }))} />
        </Field>
        <Field label="มีครบทุกแท็ก"><input className="form-input" value={tagText.tags_all} onChange={e => setTagText(t => ({ ...t, tags_all: e.target.value }))} /></Field>
        <Field label="ไม่มีแท็ก"><input className="form-input" value={tagText.exclude_tags} onChange={e => setTagText(t => ({ ...t, exclude_tags: e.target.value }))} /></Field>
        <datalist id="segment-tags">{meta?.tags.map(t => <option key={t.tag} value={t.tag} />)}</datalist>
        <Field label="การชำระเงิน">
          <select className="form-input" value={rules.has_paid_order === undefined ? "" : String(rules.has_paid_order)} onChange={e => set("has_paid_order", e.target.value === "" ? undefined : e.target.value === "true")}>
            <option value="">ไม่กำหนด</option><option value="true">เคยชำระเงินแล้ว</option><option value="false">ยังไม่เคยชำระเงิน</option>
          </select>
        </Field>
        <MultiSelect label="ลงเรียนคอร์ส (ข้อใดข้อหนึ่ง)" options={courses} value={rules.enrolled_course_ids ?? []} onChange={v => set("enrolled_course_ids", v)} />
        <MultiSelect label="เรียนจบคอร์ส (ข้อใดข้อหนึ่ง)" options={courses} value={rules.completed_course_ids ?? []} onChange={v => set("completed_course_ids", v)} />
        <Field label="สมัครตั้งแต่วันที่"><input className="form-input" type="date" value={rules.signed_up_after ?? ""} onChange={e => set("signed_up_after", e.target.value)} /></Field>
        <Field label="สมัครก่อนวันที่"><input className="form-input" type="date" value={rules.signed_up_before ?? ""} onChange={e => set("signed_up_before", e.target.value)} /></Field>
        <Field label="ใช้งานล่าสุดตั้งแต่วันที่"><input className="form-input" type="date" value={rules.last_active_after ?? ""} onChange={e => set("last_active_after", e.target.value)} /></Field>
        <Field label="ไม่ได้ใช้งานตั้งแต่วันที่" hint="รวมผู้ที่ยังไม่เคยเข้าใช้งาน"><input className="form-input" type="date" value={rules.last_active_before ?? ""} onChange={e => set("last_active_before", e.target.value)} /></Field>
        <Field label="สถานะบัญชี">
          <select className="form-input" value={rules.status ?? "active"} onChange={e => set("status", e.target.value === "active" ? undefined : e.target.value as SegmentRules["status"])}>
            <option value="active">ใช้งานอยู่</option><option value="suspended">ถูกระงับ</option><option value="any">ทุกสถานะ</option>
          </select>
        </Field>
        <div role="status" style={{ gridColumn: "1 / -1", padding: "12px 14px", borderRadius: 12, background: "rgba(15,23,42,0.04)", fontSize: 14 }}>
          {live ? <>ตรงเงื่อนไขตอนนี้ <strong>{live.count.toLocaleString("th-TH")}</strong> คน
            {live.sample.length > 0 && <span style={{ color: "var(--text-secondary)" }}> · เช่น {live.sample.slice(0, 5).map(u => u.name).join(", ")}</span>}</> : "กำลังนับ…"}
        </div>
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : "บันทึกกลุ่ม"}</button>
        </div>
      </form>
    </Modal>
  );
};
