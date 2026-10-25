import React, { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Download, Save, Copy } from "lucide-react";
import { hasRole, useApi } from "../../hooks/useApi";
import { Chip, Modal, Field, ErrorBox, Empty, grid2, tableStyle, thStyle, tdStyle, formatDateTime, downloadWithAuth } from "../site-admin/ui";
import type { LeadFormField, PopupConfig } from "./runtime";

// ==========================================
// Lead forms (builder + popup settings)
// ==========================================

interface AdminForm {
  id: string; name: string; title: string; description: string | null; fields: LeadFormField[]; submit_label: string; success_message: string;
  consent_text: string; popup: PopupConfig | null; auto_tag: string | null; notify_emails: string | null; active: boolean; lead_count: number; updated_at: string;
}

const BUILTIN: Array<{ key: string; label: string; type: LeadFormField["type"] }> = [
  { key: "name", label: "ชื่อ-นามสกุล", type: "text" },
  { key: "email", label: "อีเมล", type: "email" },
  { key: "phone", label: "เบอร์โทร", type: "tel" },
  { key: "company", label: "บริษัท / หน่วยงาน", type: "text" }
];
const TYPE_LABEL: Record<LeadFormField["type"], string> = { text: "ข้อความสั้น", email: "อีเมล", tel: "เบอร์โทร", textarea: "ข้อความยาว", select: "ตัวเลือก", checkbox: "ช่องติ๊ก" };
const TRIGGER_LABEL: Record<PopupConfig["trigger"], string> = { delay: "หลังเปิดหน้า (วินาที)", scroll: "เมื่อเลื่อนหน้าถึง (%)", exit: "เมื่อกำลังออกจากหน้า (exit intent)" };
const DEFAULT_POPUP: PopupConfig = { enabled: false, trigger: "delay", delay_seconds: 8, scroll_percent: 50, frequency_days: 7, pages: [] };

interface Draft {
  name: string; title: string; description: string; submit_label: string; success_message: string; consent_text: string;
  auto_tag: string; notify_emails: string; active: boolean; fields: Array<LeadFormField & { optionsText?: string }>; popup: PopupConfig; pagesText: string;
}

const emptyDraft = (): Draft => ({
  name: "", title: "", description: "", submit_label: "", success_message: "", consent_text: "", auto_tag: "", notify_emails: "", active: true,
  fields: [{ key: "name", label: "ชื่อ-นามสกุล", type: "text", required: true }, { key: "email", label: "อีเมล", type: "email", required: true }, { key: "phone", label: "เบอร์โทร", type: "tel", required: false }],
  popup: { ...DEFAULT_POPUP }, pagesText: ""
});

const FormEditor: React.FC<{ form: AdminForm | null; onClose: () => void; onSaved: () => void }> = ({ form, onClose, onSaved }) => {
  const api = useApi();
  const [draft, setDraft] = useState<Draft>(() => form ? {
    name: form.name, title: form.title, description: form.description || "", submit_label: form.submit_label, success_message: form.success_message,
    consent_text: form.consent_text, auto_tag: form.auto_tag || "", notify_emails: form.notify_emails || "", active: form.active,
    fields: form.fields.map(f => ({ ...f, optionsText: (f.options || []).join("\n") })), popup: form.popup ?? { ...DEFAULT_POPUP }, pagesText: (form.popup?.pages || []).join("\n")
  } : emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(prev => ({ ...prev, [key]: value }));
  const setField = (i: number, patch: Partial<Draft["fields"][number]>) => set("fields", draft.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const setPopup = (patch: Partial<PopupConfig>) => set("popup", { ...draft.popup, ...patch });
  const unusedBuiltins = BUILTIN.filter(b => !draft.fields.some(f => f.key === b.key));

  const save = async () => {
    try {
      setSaving(true);
      setError(null);
      const body = {
        name: draft.name, title: draft.title, description: draft.description, submit_label: draft.submit_label, success_message: draft.success_message,
        consent_text: draft.consent_text, auto_tag: draft.auto_tag, notify_emails: draft.notify_emails, active: draft.active,
        fields: draft.fields.map(({ optionsText, ...f }) => ({ ...f, options: f.type === "select" ? (optionsText || "").split("\n").map(o => o.trim()).filter(Boolean) : undefined })),
        popup: { ...draft.popup, pages: draft.pagesText.split("\n").map(p => p.trim()).filter(Boolean) }
      };
      if (form) await api.patch(`/marketing/admin/forms/${form.id}`, body);
      else await api.post("/marketing/admin/forms", body);
      onSaved();
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <Modal title={form ? `แก้ไขฟอร์ม: ${form.name}` : "สร้างฟอร์มเก็บ lead"} onClose={onClose} width={820}>
      <ErrorBox message={error} />
      <div style={grid2}>
        <Field label="ชื่อฟอร์ม (ภายใน) *"><input className="form-input" maxLength={120} value={draft.name} onChange={e => set("name", e.target.value)} placeholder="เช่น โบรชัวร์ CCNA" /></Field>
        <Field label="หัวข้อที่ผู้เข้าชมเห็น"><input className="form-input" maxLength={160} value={draft.title} onChange={e => set("title", e.target.value)} placeholder="รับโบรชัวร์และส่วนลด" /></Field>
        <Field label="คำอธิบาย" span><textarea className="form-input" rows={2} maxLength={1000} value={draft.description} onChange={e => set("description", e.target.value)} /></Field>
      </div>

      <h3 style={{ fontSize: 15, margin: "20px 0 10px" }}>ช่องในฟอร์ม</h3>
      <div style={{ display: "grid", gap: 10 }}>
        {draft.fields.map((field, i) => {
          const builtin = BUILTIN.some(b => b.key === field.key);
          return (
            <div key={i} className="glass-card" style={{ padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, alignItems: "end" }}>
              <Field label="ชื่อช่อง"><input className="form-input" maxLength={120} value={field.label} onChange={e => setField(i, { label: e.target.value })} /></Field>
              <Field label="รหัส (a-z, 0-9, _)"><input className="form-input" maxLength={32} value={field.key} disabled={builtin} onChange={e => setField(i, { key: e.target.value.toLowerCase() })} /></Field>
              <Field label="ประเภท">
                <select className="form-input" value={field.type} disabled={builtin} onChange={e => setField(i, { type: e.target.value as LeadFormField["type"] })}>
                  {(Object.keys(TYPE_LABEL) as LeadFormField["type"][]).filter(t => builtin || !["email", "tel"].includes(t) || t === field.type).map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
              </Field>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, paddingBottom: 10 }}>
                <input type="checkbox" checked={field.required || field.key === "email"} disabled={field.key === "email"} onChange={e => setField(i, { required: e.target.checked })} />ต้องกรอก
              </label>
              {field.key !== "email" && (
                <button type="button" className="tech-button-outline" onClick={() => set("fields", draft.fields.filter((_, j) => j !== i))} style={{ padding: "8px 12px" }}>
                  <Trash2 size={14} />ลบช่อง
                </button>
              )}
              {field.type === "select" && (
                <Field label="ตัวเลือก (บรรทัดละ 1 รายการ)" span>
                  <textarea className="form-input" rows={3} value={field.optionsText || ""} onChange={e => setField(i, { optionsText: e.target.value })} />
                </Field>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        {unusedBuiltins.map(b => (
          <button key={b.key} type="button" className="tech-button-outline" style={{ padding: "6px 12px", fontSize: 13 }}
            onClick={() => set("fields", [...draft.fields, { ...b, required: false }])}><Plus size={14} />{b.label}</button>
        ))}
        <button type="button" className="tech-button-outline" style={{ padding: "6px 12px", fontSize: 13 }} disabled={draft.fields.length >= 12}
          onClick={() => set("fields", [...draft.fields, { key: `custom_${draft.fields.length + 1}`, label: "คำถามเพิ่มเติม", type: "text", required: false }])}>
          <Plus size={14} />ช่องกำหนดเอง
        </button>
      </div>

      <h3 style={{ fontSize: 15, margin: "20px 0 10px" }}>หลังส่งฟอร์ม</h3>
      <div style={grid2}>
        <Field label="ข้อความบนปุ่ม"><input className="form-input" maxLength={60} value={draft.submit_label} onChange={e => set("submit_label", e.target.value)} placeholder="ส่งข้อมูล" /></Field>
        <Field label="ข้อความขอบคุณ"><input className="form-input" maxLength={300} value={draft.success_message} onChange={e => set("success_message", e.target.value)} /></Field>
        <Field label="ข้อความขอความยินยอม (PDPA)" span hint="เว้นว่างเพื่อใช้ข้อความมาตรฐาน ระบบบันทึกข้อความที่ผู้กรอกยินยอมไว้กับ lead ทุกรายการ">
          <textarea className="form-input" rows={2} maxLength={500} value={draft.consent_text} onChange={e => set("consent_text", e.target.value)} />
        </Field>
        <Field label="แท็กอัตโนมัติ" hint="ถ้าอีเมลตรงกับบัญชีผู้ใช้ ระบบติดแท็กนี้ให้ (ใช้แบ่งกลุ่มส่งประกาศ)"><input className="form-input" maxLength={40} value={draft.auto_tag} onChange={e => set("auto_tag", e.target.value)} /></Field>
        <Field label="อีเมลแจ้งเจ้าหน้าที่" hint="คั่นด้วย , เว้นว่าง = ผู้รับแจ้งเตือนในตั้งค่าเว็บไซต์"><input className="form-input" maxLength={500} value={draft.notify_emails} onChange={e => set("notify_emails", e.target.value)} /></Field>
      </div>

      <h3 style={{ fontSize: 15, margin: "20px 0 10px" }}>แสดงเป็น popup</h3>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginBottom: 10 }}>
        <input type="checkbox" checked={draft.popup.enabled} onChange={e => setPopup({ enabled: e.target.checked })} />เปิด popup บนเว็บไซต์
      </label>
      {draft.popup.enabled && (
        <div style={grid2}>
          <Field label="แสดงเมื่อ">
            <select className="form-input" value={draft.popup.trigger} onChange={e => setPopup({ trigger: e.target.value as PopupConfig["trigger"] })}>
              {(Object.keys(TRIGGER_LABEL) as PopupConfig["trigger"][]).map(t => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
            </select>
          </Field>
          {draft.popup.trigger === "delay" && <Field label="หน่วงเวลา (วินาที)"><input className="form-input" type="number" min={0} max={600} value={draft.popup.delay_seconds} onChange={e => setPopup({ delay_seconds: Number(e.target.value) })} /></Field>}
          {draft.popup.trigger === "scroll" && <Field label="เลื่อนหน้าถึง (%)"><input className="form-input" type="number" min={1} max={100} value={draft.popup.scroll_percent} onChange={e => setPopup({ scroll_percent: Number(e.target.value) })} /></Field>}
          <Field label="แสดงซ้ำทุก (วัน)" hint="0 = ครั้งเดียวต่อการเข้าชม ส่งฟอร์มแล้วจะไม่แสดงอีก">
            <input className="form-input" type="number" min={0} max={365} value={draft.popup.frequency_days} onChange={e => setPopup({ frequency_days: Number(e.target.value) })} />
          </Field>
          <Field label="แสดงเฉพาะหน้า (บรรทัดละ 1 หน้า)" span hint="เช่น /courses หรือ /blog/* (ทุกบทความ) เว้นว่าง = ทุกหน้า">
            <textarea className="form-input" rows={3} value={draft.pagesText} onChange={e => set("pagesText", e.target.value)} />
          </Field>
        </div>
      )}
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, margin: "16px 0" }}>
        <input type="checkbox" checked={draft.active} onChange={e => set("active", e.target.checked)} />เปิดรับข้อมูล
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
        <button className="tech-button-primary" onClick={save} disabled={saving}><Save size={16} />{saving ? "กำลังบันทึก…" : "บันทึก"}</button>
      </div>
    </Modal>
  );
};

export const LeadFormsPanel: React.FC<{ onShowLeads?: (formId: string) => void }> = ({ onShowLeads }) => {
  const api = useApi();
  const [forms, setForms] = useState<AdminForm[]>([]);
  const [editing, setEditing] = useState<AdminForm | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const load = () => api.get<{ forms: AdminForm[] }>("/marketing/admin/forms").then(d => setForms(d.forms)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const remove = async (form: AdminForm) => {
    if (!confirm(`ลบฟอร์ม "${form.name}"? ข้อมูล lead ที่ได้รับแล้วจะยังอยู่`)) return;
    try { await api.request(`/marketing/admin/forms/${form.id}`, { method: "DELETE" }); load(); } catch (err: any) { setError(err.message); }
  };
  const copyId = (id: string) => { navigator.clipboard?.writeText(id); setCopied(id); setTimeout(() => setCopied(null), 1500); };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)" }}>ฟอร์มใช้ได้ทั้งเป็นบล็อกในหน้าเว็บ (ใส่รหัสฟอร์ม) และเป็น popup ตามเงื่อนไขที่ตั้ง</p>
        <button className="tech-button-primary" onClick={() => setEditing("new")}><Plus size={16} />สร้างฟอร์ม</button>
      </div>
      <ErrorBox message={error} />
      {forms.length === 0 ? <div className="glass-card"><Empty text="ยังไม่มีฟอร์ม" /></div> : (
        <div className="glass-card" style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>ฟอร์ม</th><th style={thStyle}>Popup</th><th style={thStyle}>Lead</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th></tr></thead>
            <tbody>
              {forms.map(f => (
                <tr key={f.id}>
                  <td style={tdStyle}>
                    <strong>{f.name}</strong><div style={{ fontSize: 12, color: "var(--text-muted)" }}>{f.title} · {f.fields.length} ช่อง</div>
                    <button type="button" onClick={() => copyId(f.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, color: "var(--primary)", fontFamily: "monospace" }}>
                      <Copy size={11} /> {copied === f.id ? "คัดลอกแล้ว" : f.id}
                    </button>
                  </td>
                  <td style={tdStyle}>{f.popup?.enabled ? `${TRIGGER_LABEL[f.popup.trigger]}${f.popup.pages.length ? ` · ${f.popup.pages.join(", ")}` : " · ทุกหน้า"}` : "-"}</td>
                  <td style={tdStyle}><button type="button" className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => onShowLeads?.(f.id)}>{f.lead_count} รายการ</button></td>
                  <td style={tdStyle}>{f.active ? <Chip label="เปิดรับ" color="var(--accent)" bg="var(--accent-glow)" /> : <Chip label="ปิด" color="var(--text-secondary)" bg="rgba(100,116,139,0.12)" />}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    <button className="tech-button-outline" style={{ padding: "6px 10px" }} onClick={() => setEditing(f)} aria-label="แก้ไข"><Pencil size={14} /></button>{" "}
                    <button className="tech-button-outline" style={{ padding: "6px 10px" }} onClick={() => remove(f)} aria-label="ลบ"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <FormEditor form={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
};

// ==========================================
// Leads
// ==========================================

interface Lead {
  id: string; form_id: string | null; form_title: string | null; name: string | null; email: string; phone: string | null; company: string | null;
  data: Record<string, unknown>; status: LeadStatus; notes: string | null; page_path: string | null; utm_source: string | null; utm_campaign: string | null;
  user_id: string | null; created_at: string;
}
type LeadStatus = "new" | "contacted" | "qualified" | "converted" | "lost";
export const LEAD_STATUS: Record<LeadStatus, { label: string; color: string; bg: string }> = {
  new: { label: "ใหม่", color: "var(--primary)", bg: "var(--primary-glow)" },
  contacted: { label: "ติดต่อแล้ว", color: "var(--secondary)", bg: "var(--secondary-glow)" },
  qualified: { label: "มีโอกาส", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  converted: { label: "ปิดการขายได้", color: "var(--accent)", bg: "var(--accent-glow)" },
  lost: { label: "ไม่สนใจ", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" }
};

export const LeadsPanel: React.FC<{ formId?: string | null }> = ({ formId }) => {
  const api = useApi();
  const [forms, setForms] = useState<Array<{ id: string; name: string }>>([]);
  const [filter, setFilter] = useState({ form_id: formId || "", status: "", q: "" });
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const query = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();

  useEffect(() => { api.get<{ forms: Array<{ id: string; name: string }> }>("/marketing/admin/forms").then(d => setForms(d.forms)).catch(() => undefined); }, [api.token]);
  useEffect(() => { if (formId !== undefined) setFilter(prev => ({ ...prev, form_id: formId || "" })); }, [formId]);
  const load = () => api.get<{ leads: Lead[]; total: number }>(`/marketing/admin/leads?${query}`).then(d => {
    setLeads(d.leads); setTotal(d.total); setNotes(Object.fromEntries(d.leads.map(l => [l.id, l.notes || ""])));
  }).catch(err => setError(err.message));
  useEffect(() => { const timer = setTimeout(load, 250); return () => clearTimeout(timer); }, [query, api.token]);

  const update = async (lead: Lead, body: Record<string, unknown>) => {
    try { await api.patch(`/marketing/admin/leads/${lead.id}`, body); load(); } catch (err: any) { setError(err.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        <select className="form-input" style={{ width: "auto" }} value={filter.form_id} onChange={e => setFilter(f => ({ ...f, form_id: e.target.value }))}>
          <option value="">ทุกฟอร์ม</option>{forms.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <select className="form-input" style={{ width: "auto" }} value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
          <option value="">ทุกสถานะ</option>{Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <input className="form-input" style={{ maxWidth: 260 }} placeholder="ค้นหาชื่อ อีเมล บริษัท" value={filter.q} onChange={e => setFilter(f => ({ ...f, q: e.target.value }))} />
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{total} รายการ</span>
        <button className="tech-button-outline" style={{ marginLeft: "auto" }}
          onClick={() => downloadWithAuth(`/marketing/admin/leads.csv?${query}`, api.token, "leads.csv").catch(err => setError(err.message))}>
          <Download size={16} />ส่งออก CSV
        </button>
      </div>
      <ErrorBox message={error} />
      {leads.length === 0 ? <div className="glass-card"><Empty text="ยังไม่มี lead ในกลุ่มนี้" /></div> : (
        <div style={{ display: "grid", gap: 12 }}>
          {leads.map(lead => (
            <div key={lead.id} className="glass-card" style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{lead.name || lead.email}</strong><Chip {...LEAD_STATUS[lead.status]} />
                    {lead.user_id && <Chip label="มีบัญชีผู้ใช้" color="var(--secondary)" bg="var(--secondary-glow)" />}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <a href={`mailto:${lead.email}`} style={{ color: "inherit" }}>{lead.email}</a>
                    {lead.phone && <a href={`tel:${lead.phone}`} style={{ color: "inherit" }}>{lead.phone}</a>}
                    {lead.company && <span>{lead.company}</span>}
                    <span>{lead.form_title || "-"} · {formatDateTime(lead.created_at)}</span>
                    {(lead.utm_source || lead.page_path) && <span>{[lead.utm_source, lead.utm_campaign, lead.page_path].filter(Boolean).join(" · ")}</span>}
                  </div>
                  {Object.keys(lead.data || {}).length > 0 && (
                    <div style={{ fontSize: 13, marginTop: 6 }}>{Object.entries(lead.data).map(([k, v]) => <span key={k} style={{ marginRight: 12 }}><strong>{k}:</strong> {String(v)}</span>)}</div>
                  )}
                </div>
                <select className="form-input" style={{ width: "auto", height: "fit-content" }} value={lead.status} onChange={e => update(lead, { status: e.target.value })}>
                  {Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <input className="form-input" placeholder="บันทึกการติดตาม" value={notes[lead.id] ?? ""} maxLength={3000}
                  onChange={e => setNotes(prev => ({ ...prev, [lead.id]: e.target.value }))} />
                <button className="tech-button-outline" disabled={(notes[lead.id] ?? "") === (lead.notes || "")}
                  onClick={() => update(lead, { notes: notes[lead.id], ...(lead.status === "new" ? { status: "contacted" } : {}) })}><Save size={14} />บันทึก</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ==========================================
// Tracking pixels
// ==========================================

const TRACKING_FIELDS = [
  { key: "ga4_id", label: "Google Analytics 4 — Measurement ID", placeholder: "G-XXXXXXXXXX" },
  { key: "gtm_id", label: "Google Tag Manager — Container ID", placeholder: "GTM-XXXXXXX" },
  { key: "meta_pixel_id", label: "Meta (Facebook) Pixel ID", placeholder: "123456789012345" },
  { key: "tiktok_pixel_id", label: "TikTok Pixel ID", placeholder: "C4ABCDEFGHIJKLMNOP12" }
] as const;

export const TrackingPanel: React.FC = () => {
  const api = useApi();
  const isAdmin = hasRole(api.user, "admin");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.get<{ tracking: Record<string, string | null> }>("/marketing/admin/tracking")
      .then(d => setValues(Object.fromEntries(TRACKING_FIELDS.map(f => [f.key, d.tracking[f.key] || ""])))).catch(err => setError(err.message));
  }, [api.token]);
  const save = async () => {
    try {
      setError(null);
      const res = await api.request<{ tracking: Record<string, string | null> }>("/marketing/admin/tracking", { method: "PUT", body: JSON.stringify(values) });
      setValues(Object.fromEntries(TRACKING_FIELDS.map(f => [f.key, res.tracking[f.key] || ""])));
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (err: any) { setError(err.message); }
  };
  return (
    <div className="glass-card" style={{ padding: 24, maxWidth: 720 }}>
      <p style={{ marginTop: 0, fontSize: 14, color: "var(--text-secondary)" }}>
        ใส่เฉพาะรหัส (ID) ระบบจะติดตั้งสคริปต์บนเว็บไซต์สาธารณะให้เอง และโหลดหลังผู้เข้าชมกด "ยอมรับ" ในแถบคุกกี้ (PDPA) เท่านั้น
        เหตุการณ์ที่ส่ง: page_view, sign_up, begin_checkout และ purchase (ส่งจากหน้าเว็บไซต์สาธารณะถัดไปหลังผู้เรียนเปิดหน้าคำสั่งซื้อที่ชำระแล้ว) สคริปต์ไม่ถูกโหลดในหน้าระบบหลังเข้าสู่ระบบ
      </p>
      <ErrorBox message={error} />
      <div style={{ display: "grid", gap: 14 }}>
        {TRACKING_FIELDS.map(f => (
          <Field key={f.key} label={f.label} hint={f.key === "gtm_id" && !isAdmin ? "Tag Manager รันสคริปต์ใดก็ได้บนเว็บไซต์ จึงตั้งค่าได้เฉพาะผู้ดูแลระบบ" : undefined}>
            <input className="form-input" value={values[f.key] ?? ""} placeholder={f.placeholder} maxLength={30} disabled={f.key === "gtm_id" && !isAdmin}
              onChange={e => setValues(prev => ({ ...prev, [f.key]: e.target.value.trim() }))} />
          </Field>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16 }}>
        <button className="tech-button-primary" onClick={save}><Save size={16} />บันทึก</button>
        {saved && <span role="status" style={{ color: "var(--accent)", fontSize: 14 }}>บันทึกแล้ว</span>}
      </div>
    </div>
  );
};
