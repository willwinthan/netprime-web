import React, { useEffect, useState } from "react";
import { API_BASE_URL, useApi } from "../../hooks/useApi";
import { ErrorBox, Field, grid2 } from "../site-admin/ui";
import type { InstructorCourse } from "./types";
import { CoverPicker } from "./CoverPicker";

/** Picture field: upload a file (stored by POST /instructor/images) or paste a link. */
export const ImageField: React.FC<{ label: string; hint: string; value: string; onChange: (url: string) => void; wide?: boolean }> = ({ label, hint, value, onChange, wide }) => {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLink, setShowLink] = useState(false);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { setError("รองรับไฟล์ PNG, JPG, WEBP หรือ GIF"); return; }
    if (file.size > 5 * 1024 * 1024) { setError("ไฟล์รูปต้องไม่เกิน 5 MB"); return; }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_BASE_URL}/instructor/images`, { method: "POST", body: form, headers: api.token ? { Authorization: `Bearer ${api.token}` } : {} });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "อัปโหลดรูปไม่สำเร็จ");
      onChange(data.url);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form-group" style={{ display: "grid", gap: 8 }}>
      <span className="form-label">{label}</span>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ width: wide ? 240 : 160, height: wide ? 90 : 90, borderRadius: "0.75rem", border: "1px dashed var(--border-subtle)", background: "rgba(0,0,0,0.03)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
          {value ? <img src={value} alt={label} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "ยังไม่มีรูป"}
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          <label className="tech-button-outline" style={{ borderRadius: "1rem", cursor: busy ? "wait" : "pointer", padding: "8px 16px", fontSize: 13, width: "fit-content" }}>
            {busy ? "กำลังอัปโหลด..." : value ? "เปลี่ยนรูป" : "อัปโหลดรูป"}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }} disabled={busy}
              onChange={e => { upload(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{hint}</span>
          <span style={{ display: "flex", gap: 10 }}>
            <button type="button" className="np-cb-btn" onClick={() => setShowLink(v => !v)}>{showLink ? "ซ่อนลิงก์" : "ใช้ลิงก์รูปแทน"}</button>
            {value && <button type="button" className="np-cb-btn danger" onClick={() => onChange("")}>เอารูปออก</button>}
          </span>
        </div>
      </div>
      {showLink && <input className="form-input" type="url" value={value} onChange={e => onChange(e.target.value)} placeholder="https://..." aria-label={`ลิงก์${label}`} />}
      {error && <span role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>{error}</span>}
    </div>
  );
};

/** Name, description, cover picture, price and access period of a course (workspace tab "ข้อมูลคอร์ส"). */
export const CourseBasicsForm: React.FC<{ course: InstructorCourse; onSaved: () => void }> = ({ course, onSaved }) => {
  const api = useApi();
  const initial = () => ({
    title: course.title,
    description: course.description ?? "",
    cover_image_url: course.cover_image_url ?? "",
    price: String(course.price ?? 0),
    access_duration_days: course.access_duration_days ? String(course.access_duration_days) : ""
  });
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { setForm(initial()); }, [course.id]);

  const set = (key: keyof ReturnType<typeof initial>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.description.trim()) { setError("กรุณากรอกชื่อคอร์สและคำอธิบาย"); return; }
    try {
      setSaving(true);
      setError(null);
      await api.patch(`/instructor/courses/${course.id}`, {
        title: form.title.trim(),
        description: form.description,
        // null clears the picture; the card then falls back to a stock image
        cover_image_url: form.cover_image_url || null,
        price: Number(form.price) || 0,
        access_duration_days: form.access_duration_days ? Number(form.access_duration_days) : null
      });
      setNotice("บันทึกข้อมูลคอร์สแล้ว");
      window.setTimeout(() => setNotice(null), 2500);
      onSaved();
    } catch (err: any) {
      setError(err.message || "บันทึกข้อมูลคอร์สไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} style={{ display: "grid", gap: 16 }}>
      <ErrorBox message={error} />
      <Field label="ชื่อคอร์ส">
        <input className="form-input" value={form.title} onChange={set("title")} maxLength={200} required />
      </Field>
      <Field label="คำอธิบาย" hint="อธิบายว่าคอร์สนี้สอนอะไร เหมาะกับใคร">
        <textarea className="form-input" rows={5} value={form.description} onChange={set("description")} required
          style={{ resize: "vertical", fontFamily: "inherit", borderRadius: "1rem" }} />
      </Field>
      <CoverPicker value={form.cover_image_url} courseTitle={form.title} onChange={url => setForm(f => ({ ...f, cover_image_url: url }))} />
      <div style={grid2}>
        <Field label="ราคา (บาท)" hint="ใส่ 0 ถ้าเป็นคอร์สฟรี">
          <input className="form-input" type="number" min={0} step="0.01" value={form.price} onChange={set("price")} />
        </Field>
        <Field label="ระยะเวลาเข้าเรียน (วัน)" hint="เว้นว่างไว้ถ้าเรียนได้ตลอดชีพ">
          <input className="form-input" type="number" min={1} value={form.access_duration_days} onChange={set("access_duration_days")} placeholder="ตลอดชีพ" />
        </Field>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="submit" className="tech-button-primary" disabled={saving} style={{ borderRadius: "1rem" }}>{saving ? "กำลังบันทึก..." : "บันทึกข้อมูลคอร์ส"}</button>
        {notice && <span role="status" style={{ fontSize: 13, color: "var(--accent)" }}>{notice}</span>}
      </div>
    </form>
  );
};
