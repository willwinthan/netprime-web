import React, { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox, Field, grid2 } from "../site-admin/ui";
import { LessonEditorModal } from "./LessonEditorModal";
import { BuilderLesson, CourseOutline, LESSON_TYPE_LABEL, LEVEL_LABEL } from "./types";
import "./course.css";

/**
 * Course builder for the instructor console (mounted in InstructorConsole › จัดการเนื้อหาหลักสูตร):
 * chapters with drag & drop lesson ordering, typed lessons, drip settings, sales-page fields,
 * category, "เรียนตามลำดับ" and prerequisite courses. Video lessons keep using the console's
 * existing video form (onAddVideoLesson / onEditVideoLesson).
 */
interface Props {
  courseId: string;
  /** Changes whenever the console reloads the lesson list (e.g. after its own video form saved). */
  refreshToken?: unknown;
  onAddVideoLesson: () => void;
  onEditVideoLesson: (lesson: BuilderLesson) => void;
  onManageQuizzes: (lesson: BuilderLesson) => void;
  onDeleteLesson: (lessonId: string) => void;
}

type Tab = "structure" | "sales" | "access";
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };
interface Layout { unsectioned: string[]; sections: { id: string; title: string; lesson_ids: string[] }[] }

function layoutOf(outline: CourseOutline): Layout {
  return {
    unsectioned: outline.lessons.filter(l => !l.section_id).map(l => l.id),
    sections: outline.sections.map(s => ({ id: s.id, title: s.title, lesson_ids: outline.lessons.filter(l => l.section_id === s.id).map(l => l.id) }))
  };
}

export const CourseBuilder: React.FC<Props> = ({ courseId, refreshToken, onAddVideoLesson, onEditVideoLesson, onManageQuizzes, onDeleteLesson }) => {
  const api = useApi();
  const [tab, setTab] = useState<Tab>("structure");
  const [outline, setOutline] = useState<CourseOutline | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ lesson: BuilderLesson | null; sectionId?: string | null } | null>(null);
  const [newSection, setNewSection] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<CourseOutline>(`/instructor/courses/${courseId}/outline`);
      setOutline(data);
      setLayout(layoutOf(data));
    } catch (err: any) {
      setError(err.message);
    }
  }, [courseId, api.token]);

  useEffect(() => { load(); }, [load, refreshToken]);

  const flash = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(null), 2500); };

  const saveLayout = async (next: Layout) => {
    setLayout(next);
    setError(null);
    try {
      await api.request(`/instructor/courses/${courseId}/structure`, {
        method: "PUT",
        body: JSON.stringify({ unsectioned: next.unsectioned, sections: next.sections.map(s => ({ id: s.id, lesson_ids: s.lesson_ids })) })
      });
      flash("บันทึกลำดับแล้ว");
    } catch (err: any) {
      setError(err.message);
      load();
    }
  };

  /** Moves a lesson to `target` (null = outside chapters) at `index` (default: end). */
  const moveLesson = (lessonId: string, target: string | null, index?: number) => {
    if (!layout) return;
    const next: Layout = { unsectioned: layout.unsectioned.filter(id => id !== lessonId), sections: layout.sections.map(s => ({ ...s, lesson_ids: s.lesson_ids.filter(id => id !== lessonId) })) };
    const list = target === null ? next.unsectioned : next.sections.find(s => s.id === target)!.lesson_ids;
    list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, lessonId);
    saveLayout(next);
  };

  const containerOf = (lessonId: string): { target: string | null; index: number } => {
    const loose = layout!.unsectioned.indexOf(lessonId);
    if (loose >= 0) return { target: null, index: loose };
    const section = layout!.sections.find(s => s.lesson_ids.includes(lessonId))!;
    return { target: section.id, index: section.lesson_ids.indexOf(lessonId) };
  };

  const nudgeLesson = (lessonId: string, delta: number) => {
    const { target, index } = containerOf(lessonId);
    moveLesson(lessonId, target, index + delta);
  };

  const nudgeSection = (sectionId: string, delta: number) => {
    if (!layout) return;
    const sections = [...layout.sections];
    const i = sections.findIndex(s => s.id === sectionId);
    const j = i + delta;
    if (j < 0 || j >= sections.length) return;
    [sections[i], sections[j]] = [sections[j], sections[i]];
    saveLayout({ ...layout, sections });
  };

  const addSection = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newSection.trim()) return;
    try {
      await api.post(`/instructor/courses/${courseId}/sections`, { title: newSection.trim() });
      setNewSection("");
      load();
    } catch (err: any) { setError(err.message); }
  };

  const renameSection = async (sectionId: string, title: string) => {
    const current = outline?.sections.find(s => s.id === sectionId);
    if (!title.trim() || title.trim() === current?.title) return;
    try {
      await api.patch(`/instructor/sections/${sectionId}`, { title: title.trim() });
      flash("บันทึกชื่อบทแล้ว");
      load();
    } catch (err: any) { setError(err.message); }
  };

  const deleteSection = async (sectionId: string) => {
    if (!confirm("ลบบทนี้? บทเรียนในบทจะย้ายไปอยู่นอกบท (ไม่ถูกลบ)")) return;
    try {
      await api.request(`/instructor/sections/${sectionId}`, { method: "DELETE" });
      load();
    } catch (err: any) { setError(err.message); }
  };

  if (!outline || !layout) {
    return error ? <ErrorBox message={error} /> : <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>กำลังโหลดโครงสร้างคอร์ส...</div>;
  }
  const lessonById = new Map(outline.lessons.map(l => [l.id, l]));

  const dropProps = (target: string | null, index?: number, key = `${target}:${index ?? "end"}`) => ({
    onDragOver: (e: React.DragEvent) => { if (dragId) { e.preventDefault(); e.stopPropagation(); setOverId(key); } },
    onDragLeave: () => setOverId(prev => (prev === key ? null : prev)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (dragId) moveLesson(dragId, target, index);
      setDragId(null); setOverId(null);
    }
  });

  const renderLesson = (id: string, target: string | null, index: number, count: number) => {
    const lesson = lessonById.get(id);
    if (!lesson) return null;
    const key = `${target}:${index}`;
    return (
      <div key={id} className={`np-cb-lesson${dragId === id ? " is-dragging" : ""}${overId === key ? " is-over" : ""}`} draggable
        onDragStart={e => { setDragId(id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id); }}
        onDragEnd={() => { setDragId(null); setOverId(null); }}
        {...dropProps(target, index, key)}>
        <GripVertical size={16} className="np-cb-grip" aria-hidden />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="np-cb-type">{LESSON_TYPE_LABEL[lesson.type] ?? lesson.type}</span>
            <strong style={{ fontSize: 14, color: "var(--text-primary)" }}>{lesson.title}</strong>
          </div>
          <div className="np-cb-meta">
            {lesson.type === "video" && lesson.video_stream_uid && <span>วิดีโอ: {lesson.video_provider || "cloudflare"}</span>}
            {lesson.type === "pdf" && <span>{lesson.pdf_r2_key ? `PDF: ${lesson.pdf_r2_key.split("/").pop()}` : "ยังไม่มีไฟล์ PDF"}</span>}
            {lesson.type === "embed" && lesson.embed_url && <span>{hostOf(lesson.embed_url)}</span>}
            {lesson.type === "scorm" && <span>{lesson.scorm_launch ? `เริ่มที่ ${lesson.scorm_launch}` : "ยังไม่ได้อัปโหลดแพ็กเกจ"}</span>}
            {lesson.type === "text" && !lesson.has_text && <span>ยังไม่มีเนื้อหา</span>}
            {lesson.handout_r2_key && <span>มีเอกสารประกอบ</span>}
            {lesson.available_after_days ? <span>เปิดหลังลงทะเบียน {lesson.available_after_days} วัน</span> : null}
            {lesson.available_on && <span>เปิดวันที่ {new Date(lesson.available_on + "T00:00:00+07:00").toLocaleDateString("th-TH", { dateStyle: "medium" })}</span>}
          </div>
        </div>
        <div className="np-cb-actions">
          <button type="button" className="np-cb-btn" aria-label="เลื่อนขึ้น" disabled={index === 0} onClick={() => nudgeLesson(id, -1)}><ArrowUp size={12} /></button>
          <button type="button" className="np-cb-btn" aria-label="เลื่อนลง" disabled={index === count - 1} onClick={() => nudgeLesson(id, 1)}><ArrowDown size={12} /></button>
          <select className="np-cb-btn" aria-label="ย้ายไปบท" value={target ?? ""} onChange={e => moveLesson(id, e.target.value || null)}>
            <option value="">นอกบท</option>
            {layout.sections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
          {lesson.type === "video" && <button type="button" className="np-cb-btn" onClick={() => onEditVideoLesson(lesson)}>แก้ไขวิดีโอ</button>}
          <button type="button" className="np-cb-btn" onClick={() => setEditing({ lesson })}>{lesson.type === "video" ? "ตั้งค่า" : "แก้ไข"}</button>
          <button type="button" className="np-cb-btn" onClick={() => onManageQuizzes(lesson)}>แบบทดสอบ</button>
          <button type="button" className="np-cb-btn danger" onClick={() => onDeleteLesson(id)}>ลบ</button>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="np-cb-tabs" role="tablist">
        {([["structure", "โครงสร้างหลักสูตร"], ["sales", "หน้าขายคอร์ส"], ["access", "หมวดหมู่และเงื่อนไข"]] as [Tab, string][]).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className="np-cb-tab" onClick={() => setTab(key)}>{label}</button>
        ))}
        {notice && <span role="status" style={{ marginLeft: "auto", alignSelf: "center", fontSize: 13, color: "var(--accent)" }}>{notice}</span>}
      </div>
      <ErrorBox message={error} />

      {tab === "structure" && (
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            <button type="button" className="tech-button-primary" style={{ borderRadius: "1rem" }} onClick={onAddVideoLesson}><Plus size={14} /> บทเรียนวิดีโอ</button>
            <button type="button" className="tech-button-outline" style={{ borderRadius: "1rem" }} onClick={() => setEditing({ lesson: null })}><Plus size={14} /> บทความ / PDF / ฝังเนื้อหา / SCORM</button>
            <form onSubmit={addSection} style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
              <input className="form-input" value={newSection} onChange={e => setNewSection(e.target.value)} placeholder="ชื่อบทใหม่ เช่น บทที่ 1 พื้นฐาน" maxLength={200} aria-label="ชื่อบทใหม่" />
              <button type="submit" className="tech-button-outline" style={{ borderRadius: "1rem", whiteSpace: "nowrap" }}>เพิ่มบท</button>
            </form>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>ลากบทเรียนเพื่อเรียงลำดับหรือย้ายข้ามบท (หรือใช้ปุ่มลูกศร) ระบบบันทึกให้อัตโนมัติ</p>

          {(layout.unsectioned.length > 0 || layout.sections.length === 0) && (
            <div className={`np-cb-section${overId === "null:end" ? " is-over" : ""}`} {...dropProps(null)}>
              <div className="np-cb-section-head"><strong style={{ fontSize: 14, color: "var(--text-secondary)" }}>บทเรียนนอกบท</strong></div>
              {layout.unsectioned.length ? layout.unsectioned.map((id, i) => renderLesson(id, null, i, layout.unsectioned.length))
                : <div className="np-cb-empty">ยังไม่มีบทเรียน เพิ่มบทเรียนจากปุ่มด้านบน</div>}
            </div>
          )}

          {layout.sections.map((section, si) => (
            <div key={section.id} className={`np-cb-section${overId === `${section.id}:end` ? " is-over" : ""}`} {...dropProps(section.id)}>
              <div className="np-cb-section-head">
                <input defaultValue={section.title} aria-label="ชื่อบท" maxLength={200}
                  onBlur={e => renameSection(section.id, e.target.value)} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{section.lesson_ids.length} บทเรียน</span>
                <button type="button" className="np-cb-btn" aria-label="เลื่อนบทขึ้น" disabled={si === 0} onClick={() => nudgeSection(section.id, -1)}><ArrowUp size={12} /></button>
                <button type="button" className="np-cb-btn" aria-label="เลื่อนบทลง" disabled={si === layout.sections.length - 1} onClick={() => nudgeSection(section.id, 1)}><ArrowDown size={12} /></button>
                <button type="button" className="np-cb-btn" onClick={() => setEditing({ lesson: null, sectionId: section.id })}><Plus size={12} /> บทเรียน</button>
                <button type="button" className="np-cb-btn danger" aria-label="ลบบท" onClick={() => deleteSection(section.id)}><Trash2 size={12} /></button>
              </div>
              {section.lesson_ids.length ? section.lesson_ids.map((id, i) => renderLesson(id, section.id, i, section.lesson_ids.length))
                : <div className="np-cb-empty">ลากบทเรียนมาวางที่นี่</div>}
            </div>
          ))}
        </div>
      )}

      {tab === "sales" && <SalesForm courseId={courseId} outline={outline} onSaved={() => { flash("บันทึกหน้าขายคอร์สแล้ว"); load(); }} onError={setError} />}
      {tab === "access" && <AccessForm courseId={courseId} outline={outline} onSaved={() => { flash("บันทึกเงื่อนไขแล้ว"); load(); }} onError={setError} />}

      {editing && (
        <LessonEditorModal courseId={courseId} lesson={editing.lesson} sections={outline.sections} embedProviders={outline.embed_providers}
          defaultSectionId={editing.sectionId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); flash("บันทึกบทเรียนแล้ว"); load(); }} />
      )}
    </div>
  );
};

// ---------- Sales page ----------

const ListEditor: React.FC<{ label: string; hint?: string; items: string[]; onChange: (items: string[]) => void; placeholder: string }> = ({ label, hint, items, onChange, placeholder }) => (
  <Field label={label} hint={hint} span>
    <div>
      {items.map((item, i) => (
        <div key={i} className="np-cb-list-input">
          <input className="form-input" value={item} maxLength={300} placeholder={placeholder} onChange={e => onChange(items.map((v, j) => (j === i ? e.target.value : v)))} />
          <button type="button" className="np-cb-btn danger" aria-label="ลบรายการ" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 size={12} /></button>
        </div>
      ))}
      {items.length < 20 && <button type="button" className="np-cb-btn" onClick={() => onChange([...items, ""])}><Plus size={12} /> เพิ่มรายการ</button>}
    </div>
  </Field>
);

const SalesForm: React.FC<{ courseId: string; outline: CourseOutline; onSaved: () => void; onError: (m: string) => void }> = ({ courseId, outline, onSaved, onError }) => {
  const api = useApi();
  const c = outline.course;
  const [form, setForm] = useState({
    subtitle: c.subtitle ?? "", level: c.level ?? "", language: c.language ?? "", duration_hours: c.duration_hours?.toString() ?? "",
    promo_video_url: c.promo_video_url ?? ""
  });
  const [outcomes, setOutcomes] = useState(c.learning_outcomes);
  const [requirements, setRequirements] = useState(c.requirements);
  const [audience, setAudience] = useState(c.target_audience);
  const [faq, setFaq] = useState(c.faq);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm(f => ({ ...f, [key]: e.target.value }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.request(`/instructor/courses/${courseId}/details`, { method: "PUT", body: JSON.stringify({
        ...form, duration_hours: form.duration_hours === "" ? null : Number(form.duration_hours),
        learning_outcomes: outcomes.filter(v => v.trim()), requirements: requirements.filter(v => v.trim()),
        target_audience: audience.filter(v => v.trim()), faq: faq.filter(f => f.question.trim() || f.answer.trim())
      }) });
      onSaved();
    } catch (err: any) { onError(err.message); } finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} style={{ display: "grid", gap: 16 }}>
      <div style={grid2}>
        <Field label="คำโปรย (subtitle)" span><input className="form-input" value={form.subtitle} onChange={set("subtitle")} maxLength={200} placeholder="ประโยคสั้น ๆ ใต้ชื่อคอร์ส" /></Field>
        <Field label="ระดับ">
          <select className="form-input" value={form.level} onChange={set("level")}>
            <option value="">ไม่ระบุ</option>
            {Object.entries(LEVEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="ภาษา"><input className="form-input" value={form.language} onChange={set("language")} maxLength={40} placeholder="ไทย" /></Field>
        <Field label="ระยะเวลาเรียน (ชั่วโมง)"><input className="form-input" type="number" min={0} step={0.5} value={form.duration_hours} onChange={set("duration_hours")} /></Field>
        <Field label="วิดีโอแนะนำคอร์ส" hint="ลิงก์ YouTube, Vimeo หรือ Loom"><input className="form-input" type="url" value={form.promo_video_url} onChange={set("promo_video_url")} placeholder="https://youtu.be/..." /></Field>
      </div>
      <ListEditor label="สิ่งที่จะได้เรียนรู้" items={outcomes} onChange={setOutcomes} placeholder="เช่น Deploy แอปบน Cloudflare Workers ได้" />
      <ListEditor label="ความรู้พื้นฐานที่ต้องมี" items={requirements} onChange={setRequirements} placeholder="เช่น เขียน JavaScript เบื้องต้นได้" />
      <ListEditor label="คอร์สนี้เหมาะกับใคร" items={audience} onChange={setAudience} placeholder="เช่น นักพัฒนาเว็บที่อยากเริ่มใช้ Serverless" />
      <Field label="คำถามที่พบบ่อย (FAQ)" span>
        <div>
          {faq.map((item, i) => (
            <div key={i} style={{ display: "grid", gap: 6, marginBottom: 10, padding: 10, border: "1px solid var(--border-subtle)", borderRadius: 10 }}>
              <div className="np-cb-list-input">
                <input className="form-input" value={item.question} maxLength={300} placeholder="คำถาม" onChange={e => setFaq(faq.map((f, j) => (j === i ? { ...f, question: e.target.value } : f)))} />
                <button type="button" className="np-cb-btn danger" aria-label="ลบคำถาม" onClick={() => setFaq(faq.filter((_, j) => j !== i))}><Trash2 size={12} /></button>
              </div>
              <textarea className="form-input" rows={2} value={item.answer} maxLength={3000} placeholder="คำตอบ" onChange={e => setFaq(faq.map((f, j) => (j === i ? { ...f, answer: e.target.value } : f)))} />
            </div>
          ))}
          {faq.length < 30 && <button type="button" className="np-cb-btn" onClick={() => setFaq([...faq, { question: "", answer: "" }])}><Plus size={12} /> เพิ่มคำถาม</button>}
        </div>
      </Field>
      <div><button type="submit" className="tech-button-primary" disabled={saving} style={{ borderRadius: "1rem" }}>{saving ? "กำลังบันทึก..." : "บันทึกหน้าขายคอร์ส"}</button></div>
    </form>
  );
};

// ---------- Category, sequential, prerequisites ----------

const AccessForm: React.FC<{ courseId: string; outline: CourseOutline; onSaved: () => void; onError: (m: string) => void }> = ({ courseId, outline, onSaved, onError }) => {
  const api = useApi();
  const [categoryId, setCategoryId] = useState(outline.course.category_id ?? "");
  const [sequential, setSequential] = useState(outline.course.sequential);
  const [prerequisites, setPrerequisites] = useState<string[]>(outline.prerequisites.map(p => p.id));
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const options = outline.prerequisite_options.filter(o => !filter || o.title.toLowerCase().includes(filter.toLowerCase()) || prerequisites.includes(o.id));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.request(`/instructor/courses/${courseId}/details`, { method: "PUT", body: JSON.stringify({ category_id: categoryId || null, sequential, prerequisite_ids: prerequisites }) });
      onSaved();
    } catch (err: any) { onError(err.message); } finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} style={{ display: "grid", gap: 18, maxWidth: 640 }}>
      <Field label="หมวดหมู่คอร์ส" hint={outline.categories.length ? undefined : "ยังไม่มีหมวดหมู่ ผู้ดูแลระบบสร้างได้ที่หน้าจัดการหมวดหมู่คอร์ส"}>
        <select className="form-input" value={categoryId} onChange={e => setCategoryId(e.target.value)}>
          <option value="">ไม่มีหมวดหมู่</option>
          {outline.categories.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
        </select>
      </Field>
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14 }}>
        <input type="checkbox" checked={sequential} onChange={e => setSequential(e.target.checked)} style={{ marginTop: 4 }} />
        <span><strong>เรียนตามลำดับ</strong><br /><span style={{ color: "var(--text-muted)", fontSize: 13 }}>บทเรียนถัดไปจะเปิดเมื่อผู้เรียนเรียนบทก่อนหน้าจบแล้ว</span></span>
      </label>
      <Field label="คอร์สที่ต้องเรียนจบก่อน" hint="ผู้เรียนต้องเรียนจบคอร์สที่เลือกก่อนจึงจะลงทะเบียนหรือสั่งซื้อคอร์สนี้ได้">
        <div>
          <input className="form-input" value={filter} onChange={e => setFilter(e.target.value)} placeholder="ค้นหาคอร์ส" style={{ marginBottom: 8 }} />
          <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: 8 }}>
            {options.length === 0 && <div style={{ fontSize: 13, color: "var(--text-muted)", padding: 6 }}>ไม่พบคอร์ส</div>}
            {options.map(o => (
              <label key={o.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, padding: "4px 2px" }}>
                <input type="checkbox" checked={prerequisites.includes(o.id)}
                  onChange={e => setPrerequisites(p => (e.target.checked ? [...p, o.id] : p.filter(id => id !== o.id)))} />
                {o.title}{o.status !== "published" && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>(ยังไม่เผยแพร่)</span>}
              </label>
            ))}
          </div>
        </div>
      </Field>
      <div><button type="submit" className="tech-button-primary" disabled={saving} style={{ borderRadius: "1rem" }}>{saving ? "กำลังบันทึก..." : "บันทึก"}</button></div>
    </form>
  );
};
