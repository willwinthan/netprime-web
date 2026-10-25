import React, { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, BarChart3 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, Modal, grid2 } from "../site-admin/ui";
import { BankQuestion, DIFFICULTY_LABEL, DrawRule, Exam, LessonRef, SHOW_ANSWERS_LABEL, TYPE_LABEL, cardStyle, formatWhen, fromLocalInput,
  mutedText, rowFlex, smallButton, toLocalInput } from "./types";
import { ExamReport } from "./ExamReport";

type Draft = Omit<Exam, "id" | "course_id" | "question_count" | "attempt_count" | "pending_count"> & { question_ids: string[] };

const emptyDraft = (): Draft => ({
  lesson_id: null, title: "", description: "", is_final: false, selection_mode: "fixed", draw_rules: [{ tag: "", difficulty: "", count: 5 }],
  shuffle_questions: false, shuffle_options: false, time_limit_minutes: null, max_attempts: null, pass_percent: 60,
  show_answers: "after_submit", available_from: null, available_until: null, status: "draft", question_ids: []
});

const ExamEditor: React.FC<{ courseId: string; exam: Exam | null; lessons: LessonRef[]; onSaved: () => void; onClose: () => void }> = ({ courseId, exam, lessons, onSaved, onClose }) => {
  const api = useApi();
  const [d, setD] = useState<Draft>(emptyDraft);
  const [bank, setBank] = useState<BankQuestion[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(prev => ({ ...prev, [k]: v }));

  useEffect(() => {
    api.request<{ questions: BankQuestion[]; tags: string[] }>(`/instructor/courses/${courseId}/questions`)
      .then(res => { setBank(res.questions); setTags(res.tags); }).catch(err => setError(err.message));
    if (exam) {
      api.request<{ exam: Exam }>(`/instructor/exams/${exam.id}`).then(res => setD({
        ...emptyDraft(), ...res.exam, description: res.exam.description ?? "", question_ids: res.exam.question_ids ?? [],
        draw_rules: res.exam.draw_rules.length ? res.exam.draw_rules : emptyDraft().draw_rules
      })).catch(err => setError(err.message));
    }
  }, [api.request, courseId, exam]);

  const toggleQuestion = (id: string) =>
    set("question_ids", d.question_ids.includes(id) ? d.question_ids.filter(x => x !== id) : [...d.question_ids, id]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const payload = {
      ...d, draw_rules: d.draw_rules.map(r => ({ tag: r.tag || null, difficulty: r.difficulty || null, count: Number(r.count) })),
      time_limit_minutes: d.time_limit_minutes || null, max_attempts: d.max_attempts || null, pass_percent: Number(d.pass_percent)
    };
    try {
      if (exam) await api.patch(`/instructor/exams/${exam.id}`, payload);
      else await api.post(`/instructor/courses/${courseId}/exams`, payload);
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const totalPoints = bank.filter(q => d.question_ids.includes(q.id)).reduce((s, q) => s + q.points, 0);

  return (
    <Modal title={exam ? "แก้ไขข้อสอบ" : "สร้างข้อสอบ"} onClose={onClose} width={820}>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <ErrorBox message={error} />
        <div style={grid2}>
          <Field label="ชื่อข้อสอบ" span>
            <input className="form-input" value={d.title} onChange={e => set("title", e.target.value)} required maxLength={200} />
          </Field>
          <Field label="คำอธิบาย" span>
            <textarea className="form-input" rows={2} value={d.description ?? ""} onChange={e => set("description", e.target.value)} />
          </Field>
          <Field label="แสดงเป็นขั้นตอนของบทเรียน" hint="ไม่บังคับ">
            <select className="form-input" value={d.lesson_id ?? ""} onChange={e => set("lesson_id", e.target.value || null)}>
              <option value="">— ข้อสอบของคอร์ส —</option>
              {lessons.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
          </Field>
          <Field label="สถานะ">
            <select className="form-input" value={d.status} onChange={e => set("status", e.target.value as Draft["status"])}>
              <option value="draft">ฉบับร่าง</option>
              <option value="published">เผยแพร่</option>
            </select>
          </Field>
          <Field label="เวลาทำข้อสอบ (นาที)" hint="เว้นว่าง = ไม่จำกัด">
            <input className="form-input" type="number" min={1} max={1440} value={d.time_limit_minutes ?? ""} onChange={e => set("time_limit_minutes", e.target.value ? Number(e.target.value) : null)} />
          </Field>
          <Field label="ทำได้สูงสุด (ครั้ง)" hint="เว้นว่าง = ไม่จำกัด">
            <input className="form-input" type="number" min={1} max={100} value={d.max_attempts ?? ""} onChange={e => set("max_attempts", e.target.value ? Number(e.target.value) : null)} />
          </Field>
          <Field label="เกณฑ์ผ่าน (%)">
            <input className="form-input" type="number" min={0} max={100} value={d.pass_percent} onChange={e => set("pass_percent", Number(e.target.value))} />
          </Field>
          <Field label="การแสดงเฉลย">
            <select className="form-input" value={d.show_answers} onChange={e => set("show_answers", e.target.value as Draft["show_answers"])}>
              {(Object.keys(SHOW_ANSWERS_LABEL) as Draft["show_answers"][]).map(k => <option key={k} value={k}>{SHOW_ANSWERS_LABEL[k]}</option>)}
            </select>
          </Field>
          <Field label="เปิดสอบตั้งแต่">
            <input className="form-input" type="datetime-local" value={toLocalInput(d.available_from)} onChange={e => set("available_from", fromLocalInput(e.target.value))} />
          </Field>
          <Field label="ปิดสอบเมื่อ">
            <input className="form-input" type="datetime-local" value={toLocalInput(d.available_until)} onChange={e => set("available_until", fromLocalInput(e.target.value))} />
          </Field>
        </div>
        <div style={rowFlex}>
          <label style={rowFlex}><input type="checkbox" checked={d.is_final} onChange={e => set("is_final", e.target.checked)} /> ข้อสอบปลายภาค (ใช้กับเงื่อนไขรับใบประกาศ)</label>
          <label style={rowFlex}><input type="checkbox" checked={d.shuffle_questions} onChange={e => set("shuffle_questions", e.target.checked)} /> สลับลำดับข้อ</label>
          <label style={rowFlex}><input type="checkbox" checked={d.shuffle_options} onChange={e => set("shuffle_options", e.target.checked)} /> สลับตัวเลือก</label>
        </div>

        <Field label="การเลือกคำถาม">
          <div style={rowFlex}>
            <label style={rowFlex}><input type="radio" checked={d.selection_mode === "fixed"} onChange={() => set("selection_mode", "fixed")} /> เลือกคำถามเอง</label>
            <label style={rowFlex}><input type="radio" checked={d.selection_mode === "random"} onChange={() => set("selection_mode", "random")} /> สุ่มจากคลังตามแท็ก/ความยาก</label>
          </div>
        </Field>

        {d.selection_mode === "fixed" ? (
          <div>
            <p style={{ ...mutedText, marginBottom: "8px" }}>เลือกแล้ว {d.question_ids.length} ข้อ • รวม {totalPoints} คะแนน</p>
            <div style={{ maxHeight: "280px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px", border: "1px solid var(--border-subtle)", borderRadius: "0.75rem", padding: "10px" }}>
              {bank.length === 0 && <span style={mutedText}>ยังไม่มีคำถามในคลัง เพิ่มคำถามที่แท็บ "คลังข้อสอบ" ก่อน</span>}
              {bank.map(q => (
                <label key={q.id} style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px" }}>
                  <input type="checkbox" checked={d.question_ids.includes(q.id)} onChange={() => toggleQuestion(q.id)} />
                  <span><strong>{d.question_ids.includes(q.id) ? `${d.question_ids.indexOf(q.id) + 1}. ` : ""}</strong>{q.prompt}
                    <span style={mutedText}> — {TYPE_LABEL[q.type]} • {q.points} คะแนน{q.tags.length ? ` • #${q.tags.join(" #")}` : ""}</span></span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {d.draw_rules.map((r, i) => (
              <div key={i} style={{ ...rowFlex, flexWrap: "nowrap" }}>
                <select className="form-input" value={r.tag ?? ""} onChange={e => set("draw_rules", d.draw_rules.map((x, j) => j === i ? { ...x, tag: e.target.value } : x))} aria-label="แท็ก">
                  <option value="">ทุกแท็ก</option>
                  {tags.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <select className="form-input" value={r.difficulty ?? ""} onChange={e => set("draw_rules", d.draw_rules.map((x, j) => j === i ? { ...x, difficulty: e.target.value } : x))} aria-label="ความยาก">
                  <option value="">ทุกระดับ</option>
                  {Object.entries(DIFFICULTY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <input className="form-input" style={{ width: "90px" }} type="number" min={1} max={200} value={r.count} aria-label="จำนวนข้อ"
                  onChange={e => set("draw_rules", d.draw_rules.map((x, j) => j === i ? { ...x, count: Number(e.target.value) } : x))} />
                <span style={mutedText}>ข้อ</span>
                {d.draw_rules.length > 1 && <button type="button" className="tech-button-outline" style={smallButton} onClick={() => set("draw_rules", d.draw_rules.filter((_, j) => j !== i))}>ลบ</button>}
              </div>
            ))}
            <button type="button" className="tech-button-outline" style={{ ...smallButton, alignSelf: "flex-start" }}
              onClick={() => set("draw_rules", [...d.draw_rules, { tag: "", difficulty: "", count: 1 } as DrawRule])}>+ เพิ่มเงื่อนไข</button>
            <p style={mutedText}>ผู้เรียนแต่ละคน/แต่ละครั้งจะได้ชุดคำถามที่สุ่มใหม่ ระบบบันทึกชุดคำถามไว้กับการทำข้อสอบแต่ละครั้ง</p>
          </div>
        )}
        <div style={{ ...rowFlex, justifyContent: "flex-end" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={saving}>{saving ? "กำลังบันทึก..." : "บันทึกข้อสอบ"}</button>
        </div>
      </form>
    </Modal>
  );
};

/** Exams of a course with the "final exam required for certificate" switch. */
export const ExamBuilder: React.FC<{ courseId: string; lessons: LessonRef[] }> = ({ courseId, lessons }) => {
  const api = useApi();
  const [exams, setExams] = useState<Exam[]>([]);
  const [requiresFinal, setRequiresFinal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Exam | "new" | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.request<{ exams: Exam[]; requires_final_exam: boolean }>(`/instructor/courses/${courseId}/exams`);
      setExams(res.exams);
      setRequiresFinal(res.requires_final_exam);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api.request, courseId]);
  useEffect(() => { load(); }, [load]);

  const toggleFinal = async (value: boolean) => {
    try {
      await api.patch(`/instructor/courses/${courseId}/assessment-settings`, { requires_final_exam: value });
      setRequiresFinal(value);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = async (exam: Exam) => {
    if (!confirm(`ลบข้อสอบ "${exam.title}" และผลสอบทั้งหมด?`)) return;
    try {
      await api.request(`/instructor/exams/${exam.id}`, { method: "DELETE" });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const hasFinal = exams.some(e => e.is_final && e.status === "published");

  return (
    <div>
      <div style={{ ...rowFlex, justifyContent: "space-between", marginBottom: "16px" }}>
        <label style={{ ...rowFlex, fontSize: "14px" }}>
          <input type="checkbox" checked={requiresFinal} onChange={e => toggleFinal(e.target.checked)} />
          ต้องสอบผ่านข้อสอบปลายภาคก่อนรับใบประกาศนียบัตร
          {requiresFinal && !hasFinal && <span style={{ ...mutedText, color: "var(--warning)" }}>(ยังไม่มีข้อสอบปลายภาคที่เผยแพร่ เงื่อนไขนี้จะยังไม่มีผล)</span>}
        </label>
        <button className="tech-button-primary" style={smallButton} onClick={() => setEditing("new")}><Plus size={14} /> สร้างข้อสอบ</button>
      </div>
      <ErrorBox message={error} />
      {loading ? <Empty text="กำลังโหลด..." /> : exams.length === 0 ? <Empty text="ยังไม่มีข้อสอบ" /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {exams.map(e => (
            <div key={e.id} style={cardStyle}>
              <div style={{ ...rowFlex, justifyContent: "space-between" }}>
                <div>
                  <div style={rowFlex}>
                    <strong style={{ fontSize: "15px" }}>{e.title}</strong>
                    <Chip label={e.status === "published" ? "เผยแพร่" : "ฉบับร่าง"} color={e.status === "published" ? "var(--accent)" : "var(--text-secondary)"}
                      bg={e.status === "published" ? "var(--accent-glow)" : "rgba(100,116,139,0.12)"} />
                    {e.is_final && <Chip label="ปลายภาค" color="var(--primary)" bg="var(--primary-glow)" />}
                    {!!e.pending_count && <Chip label={`รอตรวจ ${e.pending_count}`} color="var(--warning)" bg="rgba(245,158,11,0.12)" />}
                  </div>
                  <div style={{ ...mutedText, marginTop: "4px" }}>
                    {e.selection_mode === "random" ? `สุ่ม ${e.draw_rules.reduce((s, r) => s + r.count, 0)} ข้อ` : `${e.question_count ?? 0} ข้อ`}
                    {" • "}ผ่าน {e.pass_percent}%{" • "}{e.time_limit_minutes ? `${e.time_limit_minutes} นาที` : "ไม่จำกัดเวลา"}
                    {" • "}{e.max_attempts ? `ทำได้ ${e.max_attempts} ครั้ง` : "ทำได้ไม่จำกัด"}{" • "}{SHOW_ANSWERS_LABEL[e.show_answers]}
                    {e.lesson_title ? ` • บทเรียน: ${e.lesson_title}` : ""}
                    {(e.available_from || e.available_until) ? ` • เปิด ${formatWhen(e.available_from)} – ${formatWhen(e.available_until)}` : ""}
                    {" • "}ส่งแล้ว {e.attempt_count ?? 0} ครั้ง
                  </div>
                </div>
                <div style={rowFlex}>
                  <button className="tech-button-outline" style={smallButton} onClick={() => setReportId(e.id)}><BarChart3 size={14} /> รายงาน</button>
                  <button className="tech-button-outline" style={smallButton} onClick={() => setEditing(e)} aria-label="แก้ไข"><Pencil size={14} /></button>
                  <button className="tech-button-outline" style={{ ...smallButton, color: "var(--danger)" }} onClick={() => remove(e)} aria-label="ลบ"><Trash2 size={14} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <ExamEditor courseId={courseId} exam={editing === "new" ? null : editing} lessons={lessons}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {reportId && (
        <Modal title="รายงานผลสอบ" onClose={() => setReportId(null)} width={960}>
          <ExamReport examId={reportId} />
        </Modal>
      )}
    </div>
  );
};

export default ExamBuilder;
