import React, { useState } from "react";
import { Sparkles, Plus, Trash2 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox, Field, Modal, grid2 } from "../site-admin/ui";
import { AI_DISCLAIMER, MockNotice } from "./aiShared";

// ==========================================
// Types (match backend/src/handlers/ai.ts)
// ==========================================

interface OutlineLesson { title: string; description: string; objectives: string[] }
interface OutlineSection { title: string; description: string; lessons: OutlineLesson[] }
export interface CourseOutline { title: string; description: string; objectives: string[]; sections: OutlineSection[] }

export type QuestionType = "single" | "multiple" | "true_false" | "short" | "essay";
export interface BankQuestion {
  type: QuestionType; prompt: string; options?: string[]; correct?: number[] | string[];
  explanation?: string; points?: number; tags?: string[];
}

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  single: "ตัวเลือกเดียว", multiple: "หลายคำตอบ", true_false: "ถูก/ผิด", short: "ตอบสั้น", essay: "อัตนัย"
};

interface CourseOption { id: string; title: string; status?: string }
interface LessonOption { id: string; title: string }

type Tab = "outline" | "quiz" | "summary";

const linesOf = (value: string) => value.split("\n").map(s => s.trim()).filter(Boolean);

// ==========================================
// 1. Outline generator
// ==========================================

const OutlinePanel: React.FC<{ courses: CourseOption[]; course?: CourseOption; onCreated: (courseId: string) => void }> = ({ courses, course, onCreated }) => {
  const api = useApi();
  const [form, setForm] = useState({ topic: "", audience: "", level: "beginner", duration_hours: 6, language: "th" });
  const [outline, setOutline] = useState<CourseOutline | null>(null);
  const [mock, setMock] = useState(false);
  const drafts = courses.filter(c => !c.status || c.status === "draft");
  const [target, setTarget] = useState<string>(course && (!course.status || course.status === "draft") ? course.id : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const generate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setDone(null);
    try {
      const data = await api.post<{ outline: CourseOutline; mock: boolean }>("/ai/outline", form);
      setOutline(data.outline); setMock(data.mock);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!outline) return;
    setBusy(true); setError(null);
    try {
      const data = await api.post<{ course_id: string; lessons_created: number; sections_created: number; sections_supported: boolean }>(
        "/ai/outline/apply", { outline, course_id: target || undefined });
      setDone(`สร้างแล้ว ${data.sections_supported ? `${data.sections_created} ส่วน ` : ""}${data.lessons_created} บทเรียน (ฉบับร่าง)`);
      onCreated(data.course_id);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const update = (fn: (o: CourseOutline) => void) => setOutline(prev => {
    if (!prev) return prev;
    const next: CourseOutline = JSON.parse(JSON.stringify(prev));
    fn(next);
    return next;
  });

  return (
    <div>
      <form onSubmit={generate} style={grid2}>
        <Field label="หัวข้อคอร์ส" span><input className="form-input" required maxLength={160} value={form.topic} onChange={e => setForm({ ...form, topic: e.target.value })} placeholder="เช่น Cisco CCNA สำหรับผู้เริ่มต้น" /></Field>
        <Field label="กลุ่มผู้เรียน"><input className="form-input" maxLength={200} value={form.audience} onChange={e => setForm({ ...form, audience: e.target.value })} placeholder="เช่น วิศวกรเครือข่ายจบใหม่" /></Field>
        <Field label="ระดับ">
          <select className="form-input" value={form.level} onChange={e => setForm({ ...form, level: e.target.value })}>
            <option value="beginner">เริ่มต้น</option><option value="intermediate">กลาง</option><option value="advanced">สูง</option>
          </select>
        </Field>
        <Field label="ความยาว (ชั่วโมง)"><input className="form-input" type="number" min={1} max={200} value={form.duration_hours} onChange={e => setForm({ ...form, duration_hours: Number(e.target.value) })} /></Field>
        <Field label="ภาษา">
          <select className="form-input" value={form.language} onChange={e => setForm({ ...form, language: e.target.value })}>
            <option value="th">ไทย</option><option value="en">อังกฤษ</option>
          </select>
        </Field>
        <div style={{ gridColumn: "1 / -1" }}>
          <button type="submit" className="tech-button-primary" disabled={busy || !form.topic.trim()} style={{ borderRadius: "1rem" }}>
            <Sparkles size={16} /> {busy && !outline ? "กำลังสร้าง..." : outline ? "สร้างโครงร่างใหม่" : "เสนอโครงร่าง"}
          </button>
        </div>
      </form>

      <ErrorBox message={error} />
      {outline && (
        <div style={{ marginTop: 20, borderTop: "1px solid var(--border-subtle)", paddingTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
            <strong>ตรวจและแก้ไขโครงร่าง</strong>
            <MockNotice mock={mock} />
          </div>
          <Field label="ชื่อคอร์ส"><input className="form-input" value={outline.title} maxLength={160} onChange={e => update(o => { o.title = e.target.value; })} /></Field>
          <Field label="คำอธิบาย"><textarea className="form-input" rows={2} value={outline.description} onChange={e => update(o => { o.description = e.target.value; })} /></Field>
          <Field label="วัตถุประสงค์การเรียนรู้ (บรรทัดละข้อ)">
            <textarea className="form-input" rows={3} value={outline.objectives.join("\n")} onChange={e => update(o => { o.objectives = linesOf(e.target.value); })} />
          </Field>
          {outline.sections.map((section, si) => (
            <div key={si} className="glass-card" style={{ padding: 16, margin: "12px 0", borderRadius: "1rem" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>ส่วนที่ {si + 1}</span>
                <input className="form-input" aria-label={`ชื่อส่วนที่ ${si + 1}`} value={section.title} onChange={e => update(o => { o.sections[si].title = e.target.value; })} />
                <button type="button" className="tech-button-outline" aria-label="ลบส่วนนี้" onClick={() => update(o => { o.sections.splice(si, 1); })}><Trash2 size={14} /></button>
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
                {section.lessons.map((lesson, li) => (
                  <li key={li} style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr auto", gap: 8, marginBottom: 6 }}>
                    <input className="form-input" aria-label="ชื่อบทเรียน" value={lesson.title} onChange={e => update(o => { o.sections[si].lessons[li].title = e.target.value; })} />
                    <input className="form-input" aria-label="คำอธิบายบทเรียน" value={lesson.description} onChange={e => update(o => { o.sections[si].lessons[li].description = e.target.value; })} />
                    <button type="button" className="tech-button-outline" aria-label="ลบบทเรียน" onClick={() => update(o => { o.sections[si].lessons.splice(li, 1); if (!o.sections[si].lessons.length) o.sections.splice(si, 1); })}><Trash2 size={14} /></button>
                  </li>
                ))}
              </ul>
              <button type="button" className="tech-button-outline" style={{ fontSize: 13 }} onClick={() => update(o => { o.sections[si].lessons.push({ title: "บทเรียนใหม่", description: "", objectives: [] }); })}>
                <Plus size={14} /> เพิ่มบทเรียน
              </button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginTop: 12 }}>
            <Field label="สร้างลงใน">
              <select className="form-input" value={target} onChange={e => setTarget(e.target.value)}>
                <option value="">คอร์สใหม่ (ฉบับร่าง)</option>
                {drafts.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </Field>
            <button type="button" className="tech-button-primary" disabled={busy || !outline.sections.length} onClick={apply} style={{ borderRadius: "1rem" }}>
              {busy ? "กำลังสร้าง..." : "สร้างโครงร่างคอร์ส"}
            </button>
          </div>
          {done && <p role="status" style={{ color: "var(--accent)", marginTop: 12, fontWeight: 600 }}>{done}</p>}
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>บทเรียนที่สร้างเป็นบทเรียนข้อความฉบับร่าง เพิ่มได้เฉพาะคอร์สของคุณที่ยังเป็นฉบับร่าง • {AI_DISCLAIMER}</p>
        </div>
      )}
    </div>
  );
};

// ==========================================
// 2. Quiz generator → question bank
// ==========================================

const QuizPanel: React.FC<{ courses: CourseOption[]; course?: CourseOption; lessons?: LessonOption[] }> = ({ courses, course, lessons }) => {
  const api = useApi();
  const [courseId, setCourseId] = useState(course?.id ?? courses[0]?.id ?? "");
  const [lessonId, setLessonId] = useState("");
  const [text, setText] = useState("");
  const [count, setCount] = useState(5);
  const [types, setTypes] = useState<QuestionType[]>(["single", "true_false"]);
  const [questions, setQuestions] = useState<BankQuestion[] | null>(null);
  const [mock, setMock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const toggleType = (t: QuestionType) => setTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  const generate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setDone(null);
    try {
      const data = await api.post<{ questions: BankQuestion[]; mock: boolean }>("/ai/quiz", { course_id: courseId, lesson_id: lessonId || undefined, text, count, types });
      setQuestions(data.questions); setMock(data.mock);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const save = async () => {
    if (!questions?.length) return;
    setBusy(true); setError(null);
    try {
      const data = await api.post<{ created: number }>(`/instructor/courses/${courseId}/questions/bulk`, { questions });
      setDone(`เพิ่มเข้าคลังข้อสอบแล้ว ${data.created ?? questions.length} ข้อ`);
      setQuestions(null);
    } catch (err: any) {
      setError(/404|ไม่พบเส้นทาง/.test(err.message) ? "คลังข้อสอบยังไม่พร้อมใช้งานในระบบนี้ กรุณาคัดลอกคำถามไว้ก่อน" : err.message);
    } finally { setBusy(false); }
  };

  const edit = (i: number, fn: (q: BankQuestion) => void) => setQuestions(prev => prev ? prev.map((q, idx) => {
    if (idx !== i) return q;
    const next: BankQuestion = JSON.parse(JSON.stringify(q));
    fn(next);
    return next;
  }) : prev);

  return (
    <div>
      <form onSubmit={generate} style={grid2}>
        {!course && (
          <Field label="คอร์ส">
            <select className="form-input" value={courseId} onChange={e => setCourseId(e.target.value)} required>
              {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </Field>
        )}
        {lessons && lessons.length > 0 && (
          <Field label="ใช้เนื้อหาจากบทเรียน (ไม่บังคับ)">
            <select className="form-input" value={lessonId} onChange={e => setLessonId(e.target.value)}>
              <option value="">— ไม่เลือก —</option>
              {lessons.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
          </Field>
        )}
        <Field label="จำนวนข้อ"><input className="form-input" type="number" min={1} max={20} value={count} onChange={e => setCount(Number(e.target.value))} /></Field>
        <Field label="เนื้อหา บันทึก หรือคำบรรยายวิดีโอ" hint="วางข้อความอย่างน้อย 80 ตัวอักษร (สูงสุด 12,000)" span>
          <textarea className="form-input" rows={6} maxLength={12000} value={text} onChange={e => setText(e.target.value)} />
        </Field>
        <fieldset style={{ gridColumn: "1 / -1", border: "none", padding: 0, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <legend className="form-label" style={{ marginBottom: 6 }}>ประเภทคำถาม</legend>
          {(Object.keys(QUESTION_TYPE_LABEL) as QuestionType[]).map(t => (
            <label key={t} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
              <input type="checkbox" checked={types.includes(t)} onChange={() => toggleType(t)} /> {QUESTION_TYPE_LABEL[t]}
            </label>
          ))}
        </fieldset>
        <div style={{ gridColumn: "1 / -1" }}>
          <button type="submit" className="tech-button-primary" disabled={busy || !types.length || !courseId} style={{ borderRadius: "1rem" }}>
            <Sparkles size={16} /> {busy && !questions ? "กำลังสร้าง..." : "สร้างคำถาม"}
          </button>
        </div>
      </form>
      <ErrorBox message={error} />
      {done && <p role="status" style={{ color: "var(--accent)", fontWeight: 600 }}>{done}</p>}
      {questions && (
        <div style={{ marginTop: 20, borderTop: "1px solid var(--border-subtle)", paddingTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
            <strong>ตรวจคำถาม ({questions.length} ข้อ)</strong>
            <MockNotice mock={mock} />
          </div>
          <ol style={{ paddingLeft: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            {questions.map((q, i) => (
              <li key={i}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ fontSize: 12, color: "var(--primary)", fontWeight: 600, whiteSpace: "nowrap", marginTop: 10 }}>{QUESTION_TYPE_LABEL[q.type]}</span>
                  <textarea className="form-input" rows={2} aria-label={`คำถามข้อ ${i + 1}`} value={q.prompt} onChange={e => edit(i, n => { n.prompt = e.target.value; })} />
                  <button type="button" className="tech-button-outline" aria-label="ลบคำถาม" onClick={() => setQuestions(prev => prev!.filter((_, idx) => idx !== i))}><Trash2 size={14} /></button>
                </div>
                {q.options && (
                  <ul style={{ listStyle: "none", padding: "6px 0 0 0", margin: 0 }}>
                    {q.options.map((opt, oi) => {
                      const correct = (q.correct as number[] | undefined)?.includes(oi);
                      return (
                        <li key={oi} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginBottom: 4 }}>
                          <input type={q.type === "multiple" ? "checkbox" : "radio"} name={`q${i}`} aria-label="คำตอบที่ถูก" checked={!!correct}
                            onChange={() => edit(i, n => {
                              const cur = (n.correct as number[]) ?? [];
                              n.correct = q.type === "multiple" ? (cur.includes(oi) ? cur.filter(x => x !== oi) : [...cur, oi].sort()) : [oi];
                            })} />
                          {q.type === "true_false" ? <span>{opt}</span> : (
                            <input className="form-input" style={{ padding: "4px 8px" }} aria-label={`ตัวเลือก ${oi + 1}`} value={opt} onChange={e => edit(i, n => { n.options![oi] = e.target.value; })} />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {q.type === "short" && (
                  <input className="form-input" style={{ marginTop: 6 }} aria-label="คำตอบที่ยอมรับ (คั่นด้วย ,)" value={(q.correct as string[] | undefined)?.join(", ") ?? ""}
                    onChange={e => edit(i, n => { n.correct = e.target.value.split(",").map(s => s.trim()).filter(Boolean); })} />
                )}
                {q.explanation && <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>คำอธิบาย: {q.explanation}</p>}
              </li>
            ))}
          </ol>
          <button type="button" className="tech-button-primary" disabled={busy || !questions.length} onClick={save} style={{ borderRadius: "1rem", marginTop: 12 }}>
            {busy ? "กำลังบันทึก..." : "เพิ่มเข้าคลังข้อสอบ"}
          </button>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>{AI_DISCLAIMER}</p>
        </div>
      )}
    </div>
  );
};

// ==========================================
// 3. Lesson summary (instructor regenerate)
// ==========================================

const SummaryPanel: React.FC<{ lessons: LessonOption[] }> = ({ lessons }) => {
  const api = useApi();
  const [lessonId, setLessonId] = useState(lessons[0]?.id ?? "");
  const [sourceText, setSourceText] = useState("");
  const [result, setResult] = useState<{ summary: string; key_points: string[]; mock: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const regenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      setResult(await api.post(`/ai/lessons/${lessonId}/summary`, { source_text: sourceText || undefined }));
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  if (!lessons.length) return <p style={{ color: "var(--text-muted)" }}>ยังไม่มีบทเรียนในคอร์สนี้</p>;
  return (
    <form onSubmit={regenerate}>
      <Field label="บทเรียน">
        <select className="form-input" value={lessonId} onChange={e => { setLessonId(e.target.value); setResult(null); }}>
          {lessons.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
        </select>
      </Field>
      <Field label="บันทึก/คำบรรยาย/ข้อความจากเอกสารประกอบ (ไม่บังคับ)" hint="เว้นว่างเพื่อสรุปจากเนื้อหาข้อความของบทเรียน หรือใช้ข้อความที่เคยวางไว้">
        <textarea className="form-input" rows={5} maxLength={12000} value={sourceText} onChange={e => setSourceText(e.target.value)} />
      </Field>
      <button type="submit" className="tech-button-primary" disabled={busy || !lessonId} style={{ borderRadius: "1rem" }}>
        <Sparkles size={16} /> {busy ? "กำลังสรุป..." : "สร้างสรุปใหม่"}
      </button>
      <ErrorBox message={error} />
      {result && (
        <div className="glass-card" style={{ padding: 16, marginTop: 16, borderRadius: "1rem" }}>
          <MockNotice mock={result.mock} />
          <p style={{ marginTop: 8 }}>{result.summary}</p>
          <ul>{result.key_points.map((p, i) => <li key={i}>{p}</li>)}</ul>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>ผู้เรียนจะเห็นสรุปนี้ในหน้าเรียน</p>
        </div>
      )}
    </form>
  );
};

// ==========================================
// Entry point: button + modal
// ==========================================

/**
 * "ผู้ช่วย AI" for the instructor console. On the dashboard pass `courses`; inside a course
 * (curriculum view) also pass `course` and `lessons` to enable quiz-from-lesson and summaries.
 */
export const AiInstructorTools: React.FC<{
  courses: CourseOption[];
  course?: CourseOption;
  lessons?: LessonOption[];
  onChanged?: (courseId: string) => void;
  label?: string;
}> = ({ courses, course, lessons, onChanged, label = "ผู้ช่วย AI" }) => {
  const [open, setOpen] = useState(false);
  const tabs: Array<[Tab, string]> = [["outline", "โครงร่างคอร์ส"], ["quiz", "สร้างข้อสอบ"], ...(lessons ? [["summary", "สรุปบทเรียน"] as [Tab, string]] : [])];
  const [tab, setTab] = useState<Tab>(course ? "quiz" : "outline");
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="tech-button-outline" style={{ borderRadius: "1rem", display: "flex", alignItems: "center", gap: 6 }}>
        <Sparkles size={16} /> {label}
      </button>
      {open && (
        <Modal title={course ? `ผู้ช่วย AI — ${course.title}` : "ผู้ช่วย AI สำหรับผู้สอน"} onClose={() => setOpen(false)} width={860}>
          <div role="tablist" style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
            {tabs.map(([key, text]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
                style={{ padding: "6px 12px", borderRadius: "0.5rem", border: "none", cursor: "pointer", fontWeight: 600,
                  background: tab === key ? "var(--primary-glow)" : "none", color: tab === key ? "var(--color-brand-primary)" : "var(--text-secondary)" }}>
                {text}
              </button>
            ))}
          </div>
          {tab === "outline" && <OutlinePanel courses={courses} course={course} onCreated={id => onChanged?.(id)} />}
          {tab === "quiz" && <QuizPanel courses={courses} course={course} lessons={lessons} />}
          {tab === "summary" && lessons && <SummaryPanel lessons={lessons} />}
        </Modal>
      )}
    </>
  );
};
