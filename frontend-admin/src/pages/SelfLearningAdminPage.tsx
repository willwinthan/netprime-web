import React, { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Eye, ExternalLink, FilePlus2, History, Pencil, Plus, Save, Trash2, Upload } from "lucide-react";
import { API_BASE_URL, useApi } from "../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, Modal, formatDateTime, grid2, tableStyle, tdStyle, thStyle } from "../components/site-admin/ui";
import { IconBtn, ImageInput, Notice, SelectInput, TextInput } from "../components/builder/adminKit";
import { slugify } from "../components/builder/blocks";
import { useDangerousDelete } from "../components/security/DangerConfirmDialog";
import { LessonFrame } from "../site/SelfLearningPage";

// Console tab "บทเรียน Self-learning" (permission site.self_learning): lessons are uploaded HTML files,
// listed on the public site at /self-learning. API: backend handlers/selfLearning.ts.

type Api = ReturnType<typeof useApi>;
type Level = "" | "beginner" | "intermediate" | "advanced";

interface AdminLesson {
  id: string; slug: string; title: string; title_en: string | null; summary: string | null; summary_en: string | null;
  cover_url: string | null; level: Exclude<Level, ""> | null; status: "draft" | "published"; sort_order: number;
  current_file_id: string | null; published_at: string | null; updated_at: string;
  file_version: number | null; file_size: number | null; uses_kit: number | null; file_uploaded_at: string | null;
}
interface LessonFile {
  id: string; version: number; filename: string | null; size_bytes: number; uses_kit: boolean; external_hosts: string[]; created_at: string;
}

const STATUS = {
  draft: { label: "ฉบับร่าง", color: "#3a4660", bg: "#eceff4" },
  published: { label: "เผยแพร่แล้ว", color: "#1f6b45", bg: "#dff3e8" }
};
const LEVELS: Array<[Level, string]> = [["", "ไม่ระบุ"], ["beginner", "พื้นฐาน"], ["intermediate", "กลาง"], ["advanced", "สูง"]];

const fileSize = (bytes: number | null) => bytes === null ? "—" : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const SelfLearningAdminPage: React.FC = () => {
  const api = useApi();
  const { confirmDelete, dangerDialog } = useDangerousDelete();
  const [lessons, setLessons] = useState<AdminLesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => api.get<{ lessons: AdminLesson[] }>("/self-learning/lessons").then(d => setLessons(d.lessons)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const move = async (index: number, delta: number) => {
    if (!lessons) return;
    const next = [...lessons];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setLessons(next);
    try { await api.post("/self-learning/reorder", { ids: next.map(l => l.id) }); } catch (err: any) { setError(err.message); load(); }
  };

  const remove = async (lesson: AdminLesson) => {
    try {
      const done = await confirmDelete({ action: "self_learning.delete", targetId: lesson.id, path: `/self-learning/lessons/${lesson.id}`,
        confirmMessage: `ลบบทเรียน "${lesson.title}" และไฟล์ทุกเวอร์ชันถาวร?` });
      if (done) load();
    } catch (err: any) { setError(err.message); }
  };

  return (
    <div>
      {dangerDialog}
      <div className="header-row">
        <div>
          <h1 className="header-title">บทเรียน Self-learning</h1>
          <p className="header-desc">อัปโหลดบทเรียนเป็นไฟล์ .html ไฟล์เดียว บทเรียนที่เผยแพร่แล้วจะแสดงที่เมนู Self-learning ของหน้าเว็บ (/self-learning)</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a href="/self-learning" target="_blank" rel="noreferrer" className="tech-button-outline"><ExternalLink size={16} />เปิดหน้าเว็บ</a>
          <button type="button" className="tech-button-primary" onClick={() => setCreating(true)}><FilePlus2 size={16} />เพิ่มบทเรียน</button>
        </div>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        <ErrorBox message={error} />
        {!lessons ? <Empty text="กำลังโหลด…" /> : lessons.length === 0 ? <Empty text="ยังไม่มีบทเรียน กด เพิ่มบทเรียน เพื่อเริ่ม" /> : (
          <div className="glass-card" style={{ padding: 8, overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead><tr><th style={thStyle}>ลำดับ</th><th style={thStyle}>บทเรียน</th><th style={thStyle}>สถานะ</th><th style={thStyle}>ไฟล์ปัจจุบัน</th><th style={thStyle}>แก้ไขล่าสุด</th><th style={thStyle} /></tr></thead>
              <tbody>
                {lessons.map((l, i) => (
                  <tr key={l.id}>
                    <td style={tdStyle}>
                      <span style={{ display: "inline-flex", gap: 4 }}>
                        <IconBtn label="เลื่อนขึ้น" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></IconBtn>
                        <IconBtn label="เลื่อนลง" disabled={i === lessons.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></IconBtn>
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <button type="button" onClick={() => setEditing(l.id)} style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }}>
                        <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{l.title}</div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>/self-learning/{l.slug}</div>
                      </button>
                    </td>
                    <td style={tdStyle}><Chip {...STATUS[l.status]} /></td>
                    <td style={{ ...tdStyle, fontSize: 13 }}>
                      {l.file_version ? <>เวอร์ชัน {l.file_version} · {fileSize(l.file_size)}{!l.uses_kit && <div style={{ color: "#92400e" }}>ไม่ได้ใช้ Lesson Kit</div>}</> : <span style={{ color: "#92400e" }}>ยังไม่มีไฟล์</span>}
                    </td>
                    <td style={{ ...tdStyle, fontSize: 13, color: "var(--text-secondary)" }}>{formatDateTime(l.updated_at)}</td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <span style={{ display: "inline-flex", gap: 4 }}>
                        <IconBtn label="แก้ไข" onClick={() => setEditing(l.id)}><Pencil size={14} /></IconBtn>
                        {l.status === "published" && <IconBtn label="เปิดหน้าเว็บ" onClick={() => window.open(`/self-learning/${l.slug}`, "_blank", "noopener")}><ExternalLink size={14} /></IconBtn>}
                        <IconBtn label="ลบ" danger onClick={() => remove(l)}><Trash2 size={14} /></IconBtn>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <CreateLessonDialog api={api} onClose={() => setCreating(false)} onCreated={l => { setCreating(false); load(); setEditing(l.id); }} />}
      {editing && <LessonEditor api={api} lessonId={editing} onClose={() => { setEditing(null); load(); }} />}
    </div>
  );
};

const CreateLessonDialog: React.FC<{ api: Api; onClose: () => void; onCreated: (lesson: AdminLesson) => void }> = ({ api, onClose, onCreated }) => {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { lesson } = await api.post<{ lesson: AdminLesson }>("/self-learning/lessons", { title, slug });
      onCreated(lesson);
    } catch (err: any) { setError(err.message); setSaving(false); }
  };
  return (
    <Modal title="เพิ่มบทเรียน" onClose={onClose} width={520}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        <ErrorBox message={error} />
        <TextInput label="ชื่อบทเรียน" required value={title} max={200} onChange={v => { setTitle(v); if (!slugTouched) setSlug(slugify(v)); }} />
        <Field label="ลิงก์ (slug) *" hint={`บทเรียนจะอยู่ที่ /self-learning/${slug || "ชื่อบทเรียน"} ใช้ได้เฉพาะ a-z 0-9 และขีดกลาง`}>
          <input className="form-input" required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={e => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }} />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={saving}><Plus size={16} />{saving ? "กำลังสร้าง…" : "สร้างบทเรียน"}</button>
        </div>
      </form>
    </Modal>
  );
};

const LessonEditor: React.FC<{ api: Api; lessonId: string; onClose: () => void }> = ({ api, lessonId, onClose }) => {
  const [lesson, setLesson] = useState<AdminLesson | null>(null);
  const [form, setForm] = useState<Partial<AdminLesson>>({});
  const [files, setFiles] = useState<LessonFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<LessonFile | null>(null);
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = () => api.get<{ lesson: AdminLesson; files: LessonFile[] }>(`/self-learning/lessons/${lessonId}`)
    .then(d => { setLesson(d.lesson); setForm(d.lesson); setFiles(d.files); }).catch(err => setError(err.message));
  useEffect(() => { load(); }, [lessonId]);

  const run = async (label: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
      await load();
    } catch (err: any) { setError(err.message); } finally { setBusy(null); }
  };

  const save = () => run("save", () => api.patch(`/self-learning/lessons/${lessonId}`, {
    title: form.title, title_en: form.title_en, slug: form.slug, summary: form.summary, summary_en: form.summary_en,
    cover_url: form.cover_url, level: form.level || null
  }), "บันทึกข้อมูลบทเรียนแล้ว");

  const upload = (file: File | undefined) => {
    if (!file) return;
    run("upload", async () => {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`${API_BASE_URL}/self-learning/lessons/${lessonId}/file`, {
        method: "POST", body, headers: api.token ? { Authorization: `Bearer ${api.token}` } : {}
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "อัปโหลดไฟล์ไม่สำเร็จ");
      setReport(data.file);
    }, "อัปโหลดไฟล์แล้ว ไฟล์นี้เป็นเวอร์ชันที่ผู้เรียนเห็น").finally(() => { if (fileInput.current) fileInput.current.value = ""; });
  };

  const openPreview = (file?: LessonFile) => run("preview", async () => {
    const { url } = await api.get<{ url: string }>(`/self-learning/lessons/${lessonId}/preview${file ? `?file_id=${file.id}` : ""}`);
    setPreview({ url, label: file ? `เวอร์ชัน ${file.version}` : "ไฟล์ปัจจุบัน" });
  });

  const set = <K extends keyof AdminLesson>(key: K) => (value: AdminLesson[K]) => setForm(f => ({ ...f, [key]: value }));

  return (
    <Modal title={lesson ? `แก้ไขบทเรียน: ${lesson.title}` : "แก้ไขบทเรียน"} onClose={onClose} width={860}>
      <div style={{ display: "grid", gap: 18 }}>
        <ErrorBox message={error} />
        {notice && <Notice>{notice}</Notice>}
        {!lesson ? <Empty text="กำลังโหลด…" /> : (
          <>
            <section style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <Chip {...STATUS[lesson.status]} />
                {lesson.status === "published"
                  ? <button type="button" className="tech-button-outline" disabled={!!busy} onClick={() => run("publish", () => api.post(`/self-learning/lessons/${lessonId}/unpublish`, {}), "ซ่อนบทเรียนจากหน้าเว็บแล้ว")}>ซ่อนจากหน้าเว็บ</button>
                  : <button type="button" className="tech-button-primary" disabled={!!busy || !lesson.current_file_id} onClick={() => run("publish", () => api.post(`/self-learning/lessons/${lessonId}/publish`, {}), "เผยแพร่บทเรียนแล้ว")}>เผยแพร่</button>}
                {!lesson.current_file_id && <span style={{ fontSize: 13, color: "#92400e" }}>อัปโหลดไฟล์ก่อนจึงเผยแพร่ได้</span>}
              </div>
            </section>

            <section style={{ display: "grid", gap: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>ไฟล์บทเรียน</h3>
              <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
                ไฟล์ .html ไฟล์เดียว ไม่เกิน 15 MB ใส่ CSS, JavaScript, ฟอนต์และรูปไว้ในไฟล์ (หรือโหลดจากเว็บภายนอก) อัปโหลดใหม่ได้ทุกเมื่อ ลิงก์เดิมไม่เปลี่ยน และย้อนกลับไปเวอร์ชันเก่าได้
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input ref={fileInput} type="file" accept=".html,.htm,text/html" style={{ display: "none" }} onChange={e => upload(e.target.files?.[0])} />
                <button type="button" className="tech-button-primary" disabled={!!busy} onClick={() => fileInput.current?.click()}>
                  <Upload size={16} />{busy === "upload" ? "กำลังอัปโหลด…" : lesson.current_file_id ? "อัปโหลดไฟล์ใหม่" : "อัปโหลดไฟล์ .html"}
                </button>
                {lesson.current_file_id && <button type="button" className="tech-button-outline" disabled={!!busy} onClick={() => openPreview()}><Eye size={16} />ดูตัวอย่าง</button>}
              </div>
              {report && <UploadReport file={report} />}
              {files.length > 0 && (
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 14 }}><History size={14} style={{ verticalAlign: -2 }} /> ประวัติไฟล์ ({files.length} เวอร์ชัน)</summary>
                  <table style={{ ...tableStyle, marginTop: 8 }}>
                    <thead><tr><th style={thStyle}>เวอร์ชัน</th><th style={thStyle}>ไฟล์</th><th style={thStyle}>อัปโหลดเมื่อ</th><th style={thStyle} /></tr></thead>
                    <tbody>
                      {files.map(f => (
                        <tr key={f.id}>
                          <td style={tdStyle}>{f.version}{f.id === lesson.current_file_id && <div style={{ fontSize: 12, color: "#1f6b45" }}>ใช้อยู่</div>}</td>
                          <td style={{ ...tdStyle, fontSize: 13 }}>{f.filename || "—"} · {fileSize(f.size_bytes)}</td>
                          <td style={{ ...tdStyle, fontSize: 13 }}>{formatDateTime(f.created_at)}</td>
                          <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                            <button type="button" className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 12 }} disabled={!!busy} onClick={() => openPreview(f)}>ดู</button>{" "}
                            {f.id !== lesson.current_file_id && (
                              <button type="button" className="tech-button-outline" style={{ padding: "4px 10px", fontSize: 12 }} disabled={!!busy}
                                onClick={() => run("restore", () => api.post(`/self-learning/lessons/${lessonId}/files/${f.id}/restore`, {}), `ใช้ไฟล์เวอร์ชัน ${f.version} แล้ว`)}>ใช้เวอร์ชันนี้</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </section>

            <section style={{ display: "grid", gap: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>ข้อมูลที่แสดงบนหน้าเว็บ</h3>
              <div style={grid2}>
                <TextInput label="ชื่อบทเรียน" required value={form.title} max={200} onChange={set("title")} />
                <TextInput label="ชื่อภาษาอังกฤษ" value={form.title_en} max={200} onChange={set("title_en")} />
                <Field label="ลิงก์ (slug)" hint="เปลี่ยนแล้วลิงก์เดิมที่แชร์ไว้จะใช้ไม่ได้">
                  <input className="form-input" maxLength={80} value={form.slug || ""} onChange={e => set("slug")(e.target.value.toLowerCase())} />
                </Field>
                <SelectInput label="ระดับ" value={(form.level || "") as Level} options={LEVELS} onChange={v => set("level")((v || null) as AdminLesson["level"])} />
                <TextInput label="คำอธิบายสั้น" multiline value={form.summary} max={500} onChange={set("summary")} span />
                <TextInput label="คำอธิบายภาษาอังกฤษ" multiline value={form.summary_en} max={500} onChange={set("summary_en")} span />
                <ImageInput label="รูปปก" value={form.cover_url} onChange={set("cover_url")} token={api.token} span hint="แนะนำ 1200×630 px" />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="tech-button-outline" onClick={onClose}>ปิด</button>
                <button type="button" className="tech-button-primary" disabled={!!busy} onClick={save}><Save size={16} />{busy === "save" ? "กำลังบันทึก…" : "บันทึกข้อมูล"}</button>
              </div>
            </section>
          </>
        )}
      </div>
      {preview && (
        <Modal title={`ตัวอย่าง: ${lesson?.title ?? ""} (${preview.label})`} onClose={() => setPreview(null)} width={1100}>
          <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-secondary)" }}>ลิงก์ตัวอย่างใช้ได้ 30 นาที แสดงเหมือนบนหน้าเว็บจริง</p>
          <LessonFrame src={preview.url} title="ตัวอย่างบทเรียน" shareUrl={`${window.location.origin}/self-learning/${lesson?.slug ?? ""}`} />
        </Modal>
      )}
    </Modal>
  );
};

const UploadReport: React.FC<{ file: LessonFile }> = ({ file }) => (
  <div className="glass-card" style={{ padding: "12px 14px", fontSize: 13, display: "grid", gap: 6 }}>
    <strong>ผลตรวจไฟล์เวอร์ชัน {file.version} ({fileSize(file.size_bytes)})</strong>
    {file.uses_kit
      ? <span style={{ color: "#1f6b45" }}>ใช้ Lesson Kit: กรอบบทเรียนปรับความสูงตามเนื้อหาได้</span>
      : <span style={{ color: "#92400e" }}>ไม่พบ Lesson Kit: กรอบบทเรียนจะสูงคงที่ 900 px และไม่จำตำแหน่งบทใน URL</span>}
    {file.external_hosts.length > 0
      ? <span>ไฟล์อ้างถึงเว็บภายนอก: {file.external_hosts.join(", ")} ตรวจว่าเชื่อถือได้ก่อนเผยแพร่</span>
      : <span>ไม่อ้างถึงเว็บภายนอก</span>}
  </div>
);
