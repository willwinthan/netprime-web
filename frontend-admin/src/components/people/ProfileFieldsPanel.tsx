import React, { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, grid2, Modal, tableStyle, tdStyle, thStyle } from "../site-admin/ui";
import { FIELD_TYPE_LABEL, FieldType, noticeStyle, ProfileField, smallButton, Visibility, VISIBILITY_LABEL } from "./shared";

/** Admin definition of custom profile fields (users.import). */
export const ProfileFieldsPanel: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const api = useApi();
  const [fields, setFields] = useState<ProfileField[] | null>(null);
  const [editing, setEditing] = useState<ProfileField | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = () => api.get<{ fields: ProfileField[] }>("/admin/profile-fields").then(d => setFields(d.fields)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const remove = async (field: ProfileField) => {
    if (!window.confirm(`ลบฟิลด์ "${field.label}" และค่าที่ผู้ใช้กรอกไว้ทั้งหมด?`)) return;
    try {
      setError(null);
      const res = await api.request<{ message: string }>(`/admin/profile-fields/${field.id}`, { method: "DELETE" });
      setNotice(res.message);
      load();
    } catch (err: any) { setError(err.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)", flex: "1 1 320px" }}>
          ฟิลด์เพิ่มเติมในโปรไฟล์ผู้ใช้ เช่น รหัสพนักงาน แผนก หรือวันเริ่มงาน ใช้ในการนำเข้า/ส่งออก CSV ได้ด้วยชื่อคอลัมน์ตาม "รหัสฟิลด์"
        </p>
        {canEdit && <button className="tech-button-primary" onClick={() => setEditing("new")}><Plus size={16} />เพิ่มฟิลด์</button>}
      </div>
      <ErrorBox message={error} />
      {notice && <div role="status" style={noticeStyle}>{notice}</div>}
      <div className="glass-card" style={{ padding: 8, overflowX: "auto" }}>
        {!fields ? <Empty text="กำลังโหลด…" /> : fields.length === 0 ? <Empty text="ยังไม่มีฟิลด์เพิ่มเติม" /> : (
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>ชื่อฟิลด์</th><th style={thStyle}>รหัสฟิลด์ (คอลัมน์ CSV)</th><th style={thStyle}>ชนิด</th><th style={thStyle}>แสดงที่</th><th style={thStyle}></th></tr></thead>
            <tbody>
              {fields.map(f => (
                <tr key={f.id}>
                  <td style={tdStyle}><strong>{f.label}</strong>{f.required && <span style={{ color: "#b42318" }}> *</span>}
                    {f.type === "select" && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{f.options.join(" · ")}</div>}</td>
                  <td style={tdStyle}><code>{f.key}</code></td>
                  <td style={tdStyle}>{FIELD_TYPE_LABEL[f.type]}</td>
                  <td style={tdStyle}><Chip label={VISIBILITY_LABEL[f.visibility]} color={f.visibility === "admin" ? "#9a5b00" : "var(--primary)"} bg={f.visibility === "admin" ? "rgba(245,158,11,0.14)" : "var(--primary-glow)"} /></td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{canEdit && <>
                    <button className="tech-button-outline" style={smallButton} onClick={() => setEditing(f)}>แก้ไข</button>{" "}
                    <button className="tech-button-outline" style={smallButton} aria-label={`ลบ ${f.label}`} onClick={() => remove(f)}><Trash2 size={14} /></button>
                  </>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <FieldDialog field={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice("บันทึกฟิลด์แล้ว"); load(); }} />}
    </div>
  );
};

const FieldDialog: React.FC<{ field: ProfileField | null; onClose: () => void; onSaved: () => void }> = ({ field, onClose, onSaved }) => {
  const api = useApi();
  const [form, setForm] = useState({
    key: field?.key ?? "", label: field?.label ?? "", type: (field?.type ?? "text") as FieldType,
    options: (field?.options ?? []).join("\n"), required: field?.required ?? false,
    visibility: (field?.visibility ?? "profile") as Visibility, sort_order: field?.sort_order ?? 0
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      const body = { ...form, options: form.options.split("\n").map(o => o.trim()).filter(Boolean) };
      if (field) await api.patch(`/admin/profile-fields/${field.id}`, body);
      else await api.post("/admin/profile-fields", body);
      onSaved();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Modal title={field ? `แก้ไขฟิลด์ ${field.label}` : "เพิ่มฟิลด์โปรไฟล์"} onClose={onClose}>
      <ErrorBox message={error} />
      <form onSubmit={save} style={grid2}>
        <Field label="ชื่อฟิลด์ (แสดงต่อผู้ใช้)"><input className="form-input" required maxLength={80} value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} /></Field>
        <Field label="รหัสฟิลด์" hint={field ? "เปลี่ยนไม่ได้หลังสร้าง" : "ภาษาอังกฤษตัวเล็ก ตัวเลข หรือ _ เช่น employee_no"}>
          <input className="form-input" required pattern="[a-z][a-z0-9_]{1,39}" disabled={!!field} value={form.key} onChange={e => setForm(f => ({ ...f, key: e.target.value.toLowerCase() }))} />
        </Field>
        <Field label="ชนิด" hint={field ? "เปลี่ยนไม่ได้หลังสร้าง" : undefined}>
          <select className="form-input" disabled={!!field} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as FieldType }))}>
            {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map(t => <option key={t} value={t}>{FIELD_TYPE_LABEL[t]}</option>)}
          </select>
        </Field>
        <Field label="แสดงที่">
          <select className="form-input" value={form.visibility} onChange={e => setForm(f => ({ ...f, visibility: e.target.value as Visibility }))}>
            {(Object.keys(VISIBILITY_LABEL) as Visibility[]).map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}
          </select>
        </Field>
        {form.type === "select" && (
          <Field label="ตัวเลือก (บรรทัดละ 1 ตัวเลือก)" span>
            <textarea className="form-input" rows={4} required value={form.options} onChange={e => setForm(f => ({ ...f, options: e.target.value }))} />
          </Field>
        )}
        <Field label="ลำดับการแสดง"><input className="form-input" type="number" value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: Number(e.target.value) || 0 }))} /></Field>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <input type="checkbox" checked={form.required} onChange={e => setForm(f => ({ ...f, required: e.target.checked }))} style={{ width: 18, height: 18 }} />
          จำเป็นต้องกรอก (ผู้ใช้ต้องกรอกเมื่อบันทึกโปรไฟล์)
        </label>
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : "บันทึก"}</button>
        </div>
      </form>
    </Modal>
  );
};
