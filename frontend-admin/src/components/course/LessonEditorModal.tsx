import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import { API_BASE_URL, useApi } from "../../hooks/useApi";
import { ErrorBox, Field, Modal, grid2 } from "../site-admin/ui";
import type { LessonTextEditorHandle } from "./LessonTextEditor";
import { BuilderLesson, CourseSection, LESSON_TYPE_LABEL, LessonType } from "./types";
import "./course.css";

// BlockNote is large; load it only when a text lesson is edited.
const LessonTextEditor = lazy(() => import("./LessonTextEditor"));

const PDF_LIMIT = 50 * 1024 * 1024;
const SCORM_LIMIT = 100 * 1024 * 1024;

async function readError(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => ({}));
  return data.error || fallback;
}

interface Props {
  courseId: string;
  /** null = new lesson */
  lesson: BuilderLesson | null;
  sections: CourseSection[];
  embedProviders: string;
  defaultSectionId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Create or edit a text / PDF / embed / SCORM lesson, its chapter and drip settings. */
export const LessonEditorModal: React.FC<Props> = ({ courseId, lesson, sections, embedProviders, defaultSectionId, onClose, onSaved }) => {
  const api = useApi();
  const [title, setTitle] = useState(lesson?.title ?? "");
  const [type, setType] = useState<LessonType>(lesson?.type ?? "text");
  const [sectionId, setSectionId] = useState<string>(lesson ? lesson.section_id ?? "" : defaultSectionId ?? "");
  const [embedUrl, setEmbedUrl] = useState(lesson?.embed_url ?? "");
  const [pdfKey, setPdfKey] = useState(lesson?.pdf_r2_key ?? "");
  const [dripDays, setDripDays] = useState(lesson?.available_after_days ? String(lesson.available_after_days) : "");
  const [availableOn, setAvailableOn] = useState(lesson?.available_on ?? "");
  const [scormFile, setScormFile] = useState<File | null>(null);
  const [text, setText] = useState<{ json: string | null; md: string | null } | null>(lesson ? null : { json: null, md: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<LessonTextEditorHandle>(null);
  // Set after a create, so a retry (e.g. a rejected SCORM package) updates instead of adding a duplicate.
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Existing text lessons: load the body for the editor
  useEffect(() => {
    if (!lesson) return;
    api.get<{ lesson: { content_json: string | null; content_md: string | null } }>(`/instructor/lessons/${lesson.id}/content`)
      .then(res => setText({ json: res.lesson.content_json, md: res.lesson.content_md }))
      .catch(err => { setText({ json: null, md: null }); setError(err.message); });
  }, [lesson?.id]);

  const uploadPdf = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return setError("เลือกไฟล์ PDF เท่านั้น");
    if (file.size > PDF_LIMIT) return setError("ไฟล์ PDF ต้องมีขนาดไม่เกิน 50MB");
    setBusy("กำลังอัปโหลด PDF...");
    try {
      const ticket = await api.post<{ key: string; uploadUrl: string }>("/instructor/upload/presign",
        { filename: file.name, type: "handout", size: file.size, mimeType: "application/pdf" });
      const response = await fetch(`${API_BASE_URL}${ticket.uploadUrl}`, {
        method: "PUT", body: file, headers: { "Content-Type": "application/pdf", ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}) }
      });
      if (!response.ok) throw new Error(await readError(response, "อัปโหลด PDF ไม่สำเร็จ"));
      setPdfKey(ticket.key);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const uploadScorm = async (lessonId: string, file: File) => {
    setBusy("กำลังอัปโหลดและแตกไฟล์แพ็กเกจ SCORM...");
    const response = await fetch(`${API_BASE_URL}/instructor/lessons/${lessonId}/scorm`, {
      method: "PUT", body: file, headers: { "Content-Type": "application/zip", ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}) }
    });
    if (!response.ok) throw new Error(await readError(response, "อัปโหลดแพ็กเกจ SCORM ไม่สำเร็จ"));
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (type === "scorm" && !lesson?.scorm_launch && !scormFile) return setError("เลือกไฟล์ .zip ของแพ็กเกจ SCORM");
    if (scormFile && scormFile.size > SCORM_LIMIT) return setError("แพ็กเกจ SCORM ต้องมีขนาดไม่เกิน 100MB");
    const body: Record<string, unknown> = {
      title, type, section_id: sectionId || null,
      available_after_days: dripDays ? Number(dripDays) : null,
      available_on: availableOn || null
    };
    if (type === "embed") body.embed_url = embedUrl;
    if (type === "pdf") body.pdf_r2_key = pdfKey;
    if (type === "text" && editorRef.current) Object.assign(body, editorRef.current.getContent());
    setBusy("กำลังบันทึก...");
    try {
      let lessonId = lesson?.id ?? createdId;
      if (lessonId) await api.patch(`/instructor/lessons/${lessonId}/settings`, body);
      else {
        lessonId = (await api.post<{ lesson: BuilderLesson }>(`/instructor/courses/${courseId}/lessons`, body)).lesson.id;
        setCreatedId(lessonId);
      }
      if (type === "scorm" && scormFile) await uploadScorm(lessonId!, scormFile);
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  // A lesson can become video only through the video form (asset checks, Stream upload).
  const typeOptions = (Object.keys(LESSON_TYPE_LABEL) as LessonType[]).filter(t => t !== "video" || lesson?.type === "video");

  return (
    <Modal title={lesson ? `แก้ไขบทเรียน: ${lesson.title}` : "เพิ่มบทเรียน"} onClose={onClose} width={type === "text" ? 900 : 640}>
      <ErrorBox message={error} />
      <form onSubmit={save} style={{ display: "grid", gap: "14px" }}>
        <div style={grid2}>
          <Field label="ชื่อบทเรียน">
            <input className="form-input" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required />
          </Field>
          <Field label="ประเภทบทเรียน">
            <select className="form-input" value={type} onChange={e => setType(e.target.value as LessonType)}>
              {typeOptions.map(t => <option key={t} value={t}>{LESSON_TYPE_LABEL[t]}</option>)}
            </select>
          </Field>
          <Field label="อยู่ในบท">
            <select className="form-input" value={sectionId} onChange={e => setSectionId(e.target.value)}>
              <option value="">ไม่อยู่ในบท</option>
              {sections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </Field>
        </div>

        {type === "text" && (
          text ? (
            <Suspense fallback={<div className="np-lesson-editor" style={{ padding: 24, color: "var(--text-muted)" }}>กำลังโหลดตัวแก้ไข...</div>}>
              <LessonTextEditor ref={editorRef} initialJson={text.json} initialMarkdown={text.md} />
            </Suspense>
          ) : <div className="np-lesson-editor" style={{ padding: 24, color: "var(--text-muted)" }}>กำลังโหลดเนื้อหา...</div>
        )}

        {type === "embed" && (
          <Field label="ลิงก์เนื้อหาที่จะฝัง" hint={`รองรับ ${embedProviders} (ลิงก์ https เท่านั้น)`}>
            <input className="form-input" type="url" value={embedUrl} onChange={e => setEmbedUrl(e.target.value)} placeholder="https://docs.google.com/presentation/d/..." required />
          </Field>
        )}

        {type === "pdf" && (
          <Field label="ไฟล์ PDF" hint={pdfKey ? `ไฟล์ปัจจุบัน: ${pdfKey.split("/").pop()}` : "ไม่เกิน 50MB ผู้เรียนเปิดดูในเบราว์เซอร์ได้เมื่อลงทะเบียนแล้ว"}>
            <input type="file" accept="application/pdf,.pdf" onChange={e => uploadPdf(e.target.files?.[0])} disabled={!!busy} />
          </Field>
        )}

        {type === "scorm" && (
          <Field label="แพ็กเกจ SCORM 1.2 (.zip)" hint={lesson?.scorm_launch ? `แพ็กเกจปัจจุบันเริ่มที่ ${lesson.scorm_launch} — เลือกไฟล์ใหม่เพื่อแทนที่` : "ไม่เกิน 100MB ต้องมี imsmanifest.xml ที่ระดับบนสุดของไฟล์ zip"}>
            <input type="file" accept=".zip,application/zip" onChange={e => setScormFile(e.target.files?.[0] ?? null)} disabled={!!busy} />
          </Field>
        )}

        <fieldset style={{ border: "1px solid var(--border-subtle)", borderRadius: "12px", padding: "12px 16px" }}>
          <legend style={{ fontSize: "13px", fontWeight: 600, padding: "0 6px" }}>กำหนดเวลาเปิดบทเรียน (ไม่บังคับ)</legend>
          <div style={grid2}>
            <Field label="เปิดหลังลงทะเบียน (วัน)" hint="เว้นว่าง = เปิดทันที">
              <input className="form-input" type="number" min={0} max={3650} value={dripDays} onChange={e => setDripDays(e.target.value)} />
            </Field>
            <Field label="เปิดในวันที่" hint="เวลาเที่ยงคืน (เวลาประเทศไทย)">
              <input className="form-input" type="date" value={availableOn} onChange={e => setAvailableOn(e.target.value)} />
            </Field>
          </div>
        </fieldset>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", alignItems: "center" }}>
          {busy && <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>{busy}</span>}
          <button type="button" className="tech-button-outline" onClick={onClose} style={{ borderRadius: "1rem" }}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={!!busy} style={{ borderRadius: "1rem" }}>บันทึกบทเรียน</button>
        </div>
      </form>
    </Modal>
  );
};
