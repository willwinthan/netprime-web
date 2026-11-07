import React, { useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox, Field, grid2 } from "../site-admin/ui";
import type { InstructorCourse } from "./types";

/** Name, description, pictures, price and access period of a course (workspace tab "ข้อมูลคอร์ส"). */
export const CourseBasicsForm: React.FC<{ course: InstructorCourse; onSaved: () => void }> = ({ course, onSaved }) => {
  const api = useApi();
  const initial = () => ({
    title: course.title,
    description: course.description ?? "",
    thumbnail_url: course.thumbnail_url ?? "",
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
        thumbnail_url: form.thumbnail_url || undefined,
        cover_image_url: form.cover_image_url || undefined,
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
      <div style={grid2}>
        <Field label="รูปปกคอร์ส" hint="ลิงก์รูปภาพ แสดงบนการ์ดคอร์ส">
          <input className="form-input" type="url" value={form.thumbnail_url} onChange={set("thumbnail_url")} placeholder="https://..." />
        </Field>
        <Field label="แบนเนอร์หน้าคอร์ส (ไม่บังคับ)" hint="รูปขนาดใหญ่ด้านบนหน้ารายละเอียดคอร์ส">
          <input className="form-input" type="url" value={form.cover_image_url} onChange={set("cover_image_url")} placeholder="https://..." />
        </Field>
        <Field label="ราคา (บาท)" hint="ใส่ 0 ถ้าเป็นคอร์สฟรี">
          <input className="form-input" type="number" min={0} step="0.01" value={form.price} onChange={set("price")} />
        </Field>
        <Field label="ระยะเวลาเข้าเรียน (วัน)" hint="เว้นว่างไว้ถ้าเรียนได้ตลอดชีพ">
          <input className="form-input" type="number" min={1} value={form.access_duration_days} onChange={set("access_duration_days")} placeholder="ตลอดชีพ" />
        </Field>
      </div>
      {form.thumbnail_url && (
        <img src={form.thumbnail_url} alt="ตัวอย่างรูปปก" style={{ width: 200, height: 112, objectFit: "cover", borderRadius: "0.75rem", border: "1px solid var(--border-subtle)" }} />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="submit" className="tech-button-primary" disabled={saving} style={{ borderRadius: "1rem" }}>{saving ? "กำลังบันทึก..." : "บันทึกข้อมูลคอร์ส"}</button>
        {notice && <span role="status" style={{ fontSize: 13, color: "var(--accent)" }}>{notice}</span>}
      </div>
    </form>
  );
};
