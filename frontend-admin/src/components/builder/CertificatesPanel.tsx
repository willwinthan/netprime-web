import React, { useEffect, useState } from "react";
import { Plus, Save, Star, Trash2 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Empty, ErrorBox, Field, Modal, grid2, tableStyle, tdStyle, thStyle } from "../site-admin/ui";
import { ImageInput, ListEditor, Notice, SelectInput, TextInput } from "./adminKit";
import { CERT_FONTS, CertificateConfig, CertificateTemplate, DEFAULT_CERTIFICATE, SLOT_KEYS, SlotKey } from "../certificates/CertificateTemplate";

interface Template { id: string; name: string; is_default: boolean; config: CertificateConfig; course_count: number; updated_at: string }
interface CourseRow { id: string; title: string; status: string; template_id: string | null }

const SLOT_LABEL: Record<SlotKey, string> = {
  logo: "โลโก้/ชื่อผู้ออก", title: "หัวเรื่อง", subtitle: "หัวเรื่องรอง", intro: "ข้อความนำ", name: "ชื่อผู้เรียน",
  body: "ข้อความก่อนชื่อคอร์ส", course: "ชื่อคอร์ส", date: "วันที่ออก", code: "รหัสตรวจสอบ", verify_url: "ลิงก์ตรวจสอบ"
};

const SAMPLE = { certificate_code: "NP-SAMPLE-1A2B-3C4D-5E6F-7A8B", issued_at: new Date().toISOString(), student_name: "สมหญิง ใจดี", course_title: "CCNA 200-301 พื้นฐานเครือข่าย" };

/**
 * Tab "แม่แบบใบประกาศ": certificate designs (layout, background, logo, signatures, text positions, colors, font)
 * plus the per-course override. Rendering is shared with printing and verification (components/certificates).
 */
export const CertificatesPanel: React.FC = () => {
  const api = useApi();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [courses, setCourses] = useState<CourseRow[] | null>(null);
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.get<{ templates: Template[] }>("/website/certificate-templates").then(d => setTemplates(d.templates)).catch(err => setError(err.message));
    api.get<{ courses: CourseRow[] }>("/website/certificate-templates/courses").then(d => setCourses(d.courses)).catch(err => setError(err.message));
  };
  useEffect(load, [api.token]);

  const assign = async (courseId: string, templateId: string) => {
    setError(null);
    try {
      await api.request(`/website/certificate-templates/courses/${courseId}`, { method: "PUT", body: JSON.stringify({ template_id: templateId || null }) });
      load();
    } catch (err: any) { setError(err.message); }
  };
  const makeDefault = async (t: Template) => {
    try { await api.patch(`/website/certificate-templates/${t.id}`, { is_default: true }); load(); } catch (err: any) { setError(err.message); }
  };
  const remove = async (t: Template) => {
    if (!window.confirm(`ลบแม่แบบ "${t.name}"? คอร์สที่ใช้แม่แบบนี้จะกลับไปใช้แม่แบบเริ่มต้น`)) return;
    try { await api.request(`/website/certificate-templates/${t.id}`, { method: "DELETE" }); load(); } catch (err: any) { setError(err.message); }
  };

  if (editing) return <TemplateDesigner api={api} template={editing === "new" ? null : editing} onClose={() => { setEditing(null); load(); }} />;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <ErrorBox message={error} />
      <div className="glass-card" style={{ padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <div>
            <h3 style={{ fontSize: 15, margin: 0 }}>แม่แบบใบประกาศ</h3>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>ใบประกาศทุกคอร์สใช้แม่แบบเริ่มต้น เว้นแต่กำหนดแม่แบบเฉพาะคอร์สด้านล่าง ยังไม่มีแม่แบบ = ใช้แบบมาตรฐานของระบบ</p>
          </div>
          <button type="button" className="tech-button-primary" onClick={() => setEditing("new")}><Plus size={16} />สร้างแม่แบบ</button>
        </div>
        {!templates ? <Empty text="กำลังโหลด…" /> : templates.length === 0 ? <Empty text="ยังไม่มีแม่แบบ ระบบใช้แบบมาตรฐาน" /> : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
            {templates.map(t => (
              <div key={t.id} style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: 12, padding: 12, background: "#fff", display: "grid", gap: 8 }}>
                <button type="button" onClick={() => setEditing(t)} style={{ border: 0, padding: 0, background: "#f8fafc", cursor: "pointer", borderRadius: 8, overflow: "hidden", display: "flex", justifyContent: "center" }} aria-label={`แก้ไขแม่แบบ ${t.name}`}>
                  <CertificateTemplate config={t.config} data={SAMPLE} verifyUrl={`${window.location.origin}/verify-certificates?code=${SAMPLE.certificate_code}`} scale={t.config.orientation === "portrait" ? 0.22 : 0.27} />
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <strong style={{ fontSize: 14, flex: 1 }}>{t.name}</strong>
                  {t.is_default && <span style={{ fontSize: 11, fontWeight: 700, color: "#1f6b45", background: "#dff3e8", borderRadius: 99, padding: "2px 8px" }}>เริ่มต้น</span>}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>ใช้เฉพาะ {t.course_count} คอร์ส</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button type="button" className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setEditing(t)}>แก้ไข</button>
                  {!t.is_default && <button type="button" className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => makeDefault(t)}><Star size={13} />ตั้งเป็นค่าเริ่มต้น</button>}
                  {(!t.is_default || templates.length === 1) && <button type="button" className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 12, color: "var(--danger)" }} onClick={() => remove(t)}><Trash2 size={13} />ลบ</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="glass-card" style={{ padding: 20 }}>
        <h3 style={{ fontSize: 15, margin: "0 0 12px" }}>แม่แบบเฉพาะคอร์ส</h3>
        {!courses ? <Empty text="กำลังโหลด…" /> : courses.length === 0 ? <Empty text="ยังไม่มีคอร์ส" /> : (
          <div style={{ overflowX: "auto", maxHeight: 420 }}>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>คอร์ส</th><th style={thStyle}>แม่แบบ</th></tr></thead>
              <tbody>
                {courses.map(c => (
                  <tr key={c.id}>
                    <td style={tdStyle}>{c.title}{c.status !== "published" && <span style={{ fontSize: 12, color: "var(--text-muted)" }}> · {c.status}</span>}</td>
                    <td style={tdStyle}>
                      <select className="form-input" value={c.template_id ?? ""} onChange={e => assign(c.id, e.target.value)} aria-label={`แม่แบบของ ${c.title}`} style={{ minWidth: 220 }}>
                        <option value="">ใช้แม่แบบเริ่มต้น</option>
                        {(templates ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// ==========================================
// Designer
// ==========================================

const TemplateDesigner: React.FC<{ api: ReturnType<typeof useApi>; template: Template | null; onClose: () => void }> = ({ api, template, onClose }) => {
  const [name, setName] = useState(template?.name ?? "แม่แบบใหม่");
  const [config, setConfig] = useState<CertificateConfig>(template?.config ?? DEFAULT_CERTIFICATE);
  const [makeDefault, setMakeDefault] = useState(false);
  const [slotKey, setSlotKey] = useState<SlotKey>("name");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fullPreview, setFullPreview] = useState(false);

  const set = (patch: Partial<CertificateConfig>) => { setConfig(c => ({ ...c, ...patch })); setNotice(null); };
  const slot = config.slots[slotKey];
  const setSlot = (patch: Partial<typeof slot>) => set({ slots: { ...config.slots, [slotKey]: { ...slot, ...patch } } });

  const save = async () => {
    setSaving(true); setError(null);
    try {
      if (template) await api.patch(`/website/certificate-templates/${template.id}`, { name, config, ...(makeDefault ? { is_default: true } : {}) });
      else await api.post("/website/certificate-templates", { name, config, is_default: makeDefault });
      setNotice("บันทึกแม่แบบแล้ว");
      if (!template) onClose();
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  };

  const verifyUrl = `${window.location.origin}/verify-certificates?code=${SAMPLE.certificate_code}`;
  const num = (label: string, value: number, min: number, max: number, onChange: (v: number) => void, step = 0.5) => (
    <Field label={`${label}: ${value}`}>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
    </Field>
  );

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="tech-button-outline" onClick={onClose} style={{ padding: "6px 12px" }}>← แม่แบบทั้งหมด</button>
        <strong>{template ? `แก้ไข: ${template.name}` : "แม่แบบใหม่"}</strong>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button type="button" className="tech-button-outline" onClick={() => setFullPreview(true)}>ดูขนาดจริง</button>
          <button type="button" className="tech-button-primary" onClick={save} disabled={saving || !name.trim()}><Save size={16} />{saving ? "กำลังบันทึก…" : "บันทึกแม่แบบ"}</button>
        </span>
      </div>
      <ErrorBox message={error} />
      {notice && <Notice>{notice}</Notice>}
      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "minmax(320px, 420px) minmax(0, 1fr)", alignItems: "start" }} className="np-cert-designer">
        <div className="glass-card" style={{ padding: 16, display: "grid", gap: 14, maxHeight: "calc(100vh - 160px)", overflowY: "auto" }}>
          <div style={grid2}>
            <TextInput label="ชื่อแม่แบบ" required value={name} max={120} onChange={setName} span />
            <SelectInput label="แนวกระดาษ A4" value={config.orientation} options={[["landscape", "แนวนอน"], ["portrait", "แนวตั้ง"]]} onChange={v => set({ orientation: v })} />
            <SelectInput label="ฟอนต์" value={config.font} options={CERT_FONTS.map(f => [f, f] as [typeof f, string])} onChange={v => set({ font: v })} />
            <ImageInput label="ภาพพื้นหลัง" value={config.background_url} token={api.token} hint="A4 300 dpi: 3508×2480 (แนวนอน)" onChange={v => set({ background_url: v || null })} span />
            <ImageInput label="โลโก้" value={config.logo_url} token={api.token} onChange={v => set({ logo_url: v || null })} span />
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="checkbox" checked={config.show_border} onChange={e => set({ show_border: e.target.checked })} />แสดงกรอบ</label>
            {!template?.is_default && <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} />ใช้เป็นแม่แบบเริ่มต้น</label>}
          </div>
          <details open>
            <summary style={{ fontWeight: 700, cursor: "pointer" }}>สี</summary>
            <div style={{ ...grid2, marginTop: 10 }}>
              {([["primary", "สีหลัก"], ["text", "ตัวอักษร"], ["muted", "ตัวอักษรรอง"], ["border", "กรอบ"]] as const).map(([key, label]) => (
                <Field key={key} label={label}>
                  <input type="color" value={config.colors[key]} onChange={e => set({ colors: { ...config.colors, [key]: e.target.value } })} style={{ width: "100%", height: 36, border: 0, padding: 0, background: "none" }} />
                </Field>
              ))}
            </div>
          </details>
          <details open>
            <summary style={{ fontWeight: 700, cursor: "pointer" }}>ข้อความ</summary>
            <div style={{ ...grid2, marginTop: 10 }}>
              <TextInput label="หัวเรื่อง" value={config.texts.title} max={120} onChange={v => set({ texts: { ...config.texts, title: v } })} />
              <TextInput label="หัวเรื่องรอง" value={config.texts.subtitle} max={120} onChange={v => set({ texts: { ...config.texts, subtitle: v } })} />
              <TextInput label="ข้อความนำ" value={config.texts.intro} max={300} onChange={v => set({ texts: { ...config.texts, intro: v } })} span />
              <TextInput label="ข้อความก่อนชื่อคอร์ส" value={config.texts.body} max={300} onChange={v => set({ texts: { ...config.texts, body: v } })} span />
              <TextInput label="ชื่อผู้ออก (แสดงเมื่อไม่มีโลโก้)" value={config.texts.issuer} max={120} onChange={v => set({ texts: { ...config.texts, issuer: v } })} span />
            </div>
          </details>
          <details open>
            <summary style={{ fontWeight: 700, cursor: "pointer" }}>ตำแหน่งองค์ประกอบ</summary>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              <SelectInput label="องค์ประกอบ" value={slotKey} options={SLOT_KEYS.map(k => [k, SLOT_LABEL[k]] as [SlotKey, string])} onChange={setSlotKey} />
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="checkbox" checked={slot.visible} onChange={e => setSlot({ visible: e.target.checked })} />แสดง</label>
              {num("แนวนอน (%)", slot.x, 0, 100, v => setSlot({ x: v }))}
              {num("แนวตั้ง (%)", slot.y, 0, 100, v => setSlot({ y: v }))}
              {num(slotKey === "logo" ? "ความสูง (มม.)" : "ขนาดตัวอักษร (pt)", slot.size, 6, 96, v => setSlot({ size: v }), 1)}
              <SelectInput label="จัดชิด" value={slot.align} options={[["left", "ซ้าย"], ["center", "กลาง"], ["right", "ขวา"]]} onChange={v => setSlot({ align: v })} />
            </div>
          </details>
          <details>
            <summary style={{ fontWeight: 700, cursor: "pointer" }}>QR ตรวจสอบ</summary>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="checkbox" checked={config.qr.visible} onChange={e => set({ qr: { ...config.qr, visible: e.target.checked } })} />แสดง QR (ลิงก์ไปหน้าตรวจสอบใบประกาศ)</label>
              {num("แนวนอน (%)", config.qr.x, 0, 100, v => set({ qr: { ...config.qr, x: v } }))}
              {num("แนวตั้ง (%)", config.qr.y, 0, 100, v => set({ qr: { ...config.qr, y: v } }))}
              {num("ขนาด (มม.)", config.qr.size, 12, 60, v => set({ qr: { ...config.qr, size: v } }), 1)}
            </div>
          </details>
          <details>
            <summary style={{ fontWeight: 700, cursor: "pointer" }}>ผู้ลงนาม (สูงสุด 3)</summary>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              {num("ตำแหน่งแนวตั้ง (%)", config.signatures_y, 0, 100, v => set({ signatures_y: v }))}
              <ListEditor items={config.signatures} max={3} addLabel="เพิ่มผู้ลงนาม" itemLabel={i => `ผู้ลงนามที่ ${i + 1}`} blank={() => ({ image_url: null, name: "", title: null })}
                onChange={signatures => set({ signatures })} render={(s, update) => <>
                  <TextInput label="ชื่อ" required value={s.name} max={120} onChange={v => update({ name: v })} />
                  <TextInput label="ตำแหน่ง" value={s.title} max={120} onChange={v => update({ title: v || null })} />
                  <ImageInput label="ภาพลายเซ็น (PNG พื้นใส)" value={s.image_url} token={api.token} onChange={v => update({ image_url: v || null })} span />
                </>} />
            </div>
          </details>
        </div>
        <div style={{ display: "flex", justifyContent: "center", background: "#eef2f6", borderRadius: 12, padding: 16, overflow: "auto" }}>
          <CertificateTemplate config={config} data={SAMPLE} verifyUrl={verifyUrl} scale={config.orientation === "portrait" ? 0.5 : 0.62} />
        </div>
      </div>
      {fullPreview && (
        <Modal title="ขนาดจริง (A4)" onClose={() => setFullPreview(false)} width={1180}>
          <div style={{ overflow: "auto" }}><CertificateTemplate config={config} data={SAMPLE} verifyUrl={verifyUrl} /></div>
        </Modal>
      )}
    </div>
  );
};

export default CertificatesPanel;
