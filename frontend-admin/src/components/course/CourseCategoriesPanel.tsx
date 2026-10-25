import React, { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { can, hasRole, useApi } from "../../hooks/useApi";
import { Empty, ErrorBox, Field, Modal, grid2, tableStyle, tdStyle, thStyle } from "../site-admin/ui";
import { CourseCategory, loadCourseCategories } from "./CategoryFilter";

/**
 * Course categories (catalog filters, sales pages). Admins and holders of courses.approve or
 * website.design. Console page; wire it in App.tsx.
 */
export const CourseCategoriesPanel: React.FC = () => {
  const api = useApi();
  const allowed = hasRole(api.user, "admin") || can(api.user, "courses.approve", "website.design");
  const [rows, setRows] = useState<CourseCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<CourseCategory> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setRows(await loadCourseCategories(true));
  };
  useEffect(() => { load(); }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    setError(null);
    const body = { name: editing.name, slug: editing.slug || undefined, description: editing.description ?? null, sort_order: Number(editing.sort_order ?? 0) };
    try {
      if (editing.id) await api.patch(`/admin/course-categories/${editing.id}`, body);
      else await api.post("/admin/course-categories", body);
      setEditing(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (category: CourseCategory) => {
    if (!confirm(`ลบหมวดหมู่ "${category.name}"? คอร์สในหมวดนี้จะไม่มีหมวดหมู่`)) return;
    try {
      await api.request(`/admin/course-categories/${category.id}`, { method: "DELETE" });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (!allowed) return <Empty text="บัญชีของคุณไม่มีสิทธิ์จัดการหมวดหมู่คอร์ส" />;

  return (
    <div className="glass-card" style={{ padding: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 22 }}>หมวดหมู่คอร์ส</h2>
          <p style={{ fontSize: 14, color: "var(--text-secondary)", marginTop: 4 }}>ใช้กรองคอร์สในแคตตาล็อกและแสดงบนหน้าขายคอร์ส ผู้สอนเลือกหมวดหมู่ให้คอร์สได้ในหน้าจัดการเนื้อหาหลักสูตร</p>
        </div>
        <button type="button" className="tech-button-primary" style={{ borderRadius: "1rem" }} onClick={() => setEditing({ name: "", slug: "", description: "", sort_order: (rows?.length ?? 0) + 1 })}>
          <Plus size={14} /> เพิ่มหมวดหมู่
        </button>
      </div>
      <ErrorBox message={editing ? null : error} />
      {!rows ? <Empty text="กำลังโหลด..." /> : rows.length === 0 ? <Empty text="ยังไม่มีหมวดหมู่" /> : (
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>ลำดับ</th><th style={thStyle}>ชื่อ</th><th style={thStyle}>slug</th><th style={thStyle}>คอร์สที่เผยแพร่</th><th style={thStyle} /></tr></thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id}>
                <td style={tdStyle}>{row.sort_order}</td>
                <td style={tdStyle}><strong>{row.name}</strong>{row.description && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{row.description}</div>}</td>
                <td style={tdStyle}><code>{row.slug}</code></td>
                <td style={tdStyle}>{row.course_count}</td>
                <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                  <button type="button" className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 12, borderRadius: "0.6rem" }} onClick={() => setEditing(row)}>แก้ไข</button>{" "}
                  <button type="button" className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 12, borderRadius: "0.6rem", color: "var(--danger)" }} onClick={() => remove(row)}>ลบ</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <Modal title={editing.id ? "แก้ไขหมวดหมู่" : "เพิ่มหมวดหมู่"} onClose={() => setEditing(null)} width={520}>
          <ErrorBox message={error} />
          <form onSubmit={save} style={{ display: "grid", gap: 14 }}>
            <div style={grid2}>
              <Field label="ชื่อหมวดหมู่"><input className="form-input" value={editing.name ?? ""} maxLength={80} required onChange={e => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="slug (ในลิงก์)" hint="a-z, 0-9 และ - เว้นว่างเพื่อสร้างอัตโนมัติ">
                <input className="form-input" value={editing.slug ?? ""} maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" onChange={e => setEditing({ ...editing, slug: e.target.value.toLowerCase() })} />
              </Field>
              <Field label="ลำดับการแสดง"><input className="form-input" type="number" min={0} value={editing.sort_order ?? 0} onChange={e => setEditing({ ...editing, sort_order: Number(e.target.value) })} /></Field>
              <Field label="คำอธิบาย" span><textarea className="form-input" rows={2} maxLength={500} value={editing.description ?? ""} onChange={e => setEditing({ ...editing, description: e.target.value })} /></Field>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" className="tech-button-outline" style={{ borderRadius: "1rem" }} onClick={() => setEditing(null)}>ยกเลิก</button>
              <button type="submit" className="tech-button-primary" style={{ borderRadius: "1rem" }} disabled={saving}>{saving ? "กำลังบันทึก..." : "บันทึก"}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default CourseCategoriesPanel;
