import React, { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Download, Upload, Trash2, Pencil } from "lucide-react";
import { API_BASE_URL, useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, Modal, downloadWithAuth, grid2 } from "../site-admin/ui";
import { BankQuestion, DIFFICULTY_LABEL, Difficulty, QuestionType, TYPE_LABEL, cardStyle, mutedText, rowFlex, smallButton } from "./types";

const ALL_TYPES = Object.keys(TYPE_LABEL) as QuestionType[];
const CHOICE_TYPES: QuestionType[] = ["single", "multiple", "true_false"];

/** Editable question payload; the server validates it again (handlers/assessments.ts parseQuestion). */
export interface QuestionPayload {
  type: QuestionType;
  prompt: string;
  options?: string[];
  correct?: unknown;
  explanation?: string | null;
  points?: number;
  tags?: string[];
  difficulty?: Difficulty;
}

interface FormState {
  type: QuestionType;
  prompt: string;
  options: string[];
  correct: number[];
  accepted: string;      // short: one accepted answer per line
  blanks: string[];      // fill_blank: alternatives separated by "/"
  pairs: { left: string; right: string }[];
  explanation: string;
  points: string;
  tags: string;
  difficulty: Difficulty;
}

function initialState(q?: Partial<BankQuestion> | null, type: QuestionType = "single"): FormState {
  const t = q?.type ?? type;
  const opts = q?.options;
  return {
    type: t,
    prompt: q?.prompt ?? "",
    options: Array.isArray(opts) ? [...opts] : ["", "", "", ""],
    correct: CHOICE_TYPES.includes(t) && Array.isArray(q?.correct) ? (q!.correct as number[]) : [0],
    accepted: t === "short" && Array.isArray(q?.correct) ? (q!.correct as string[]).join("\n") : "",
    blanks: t === "fill_blank" && Array.isArray(q?.correct) ? (q!.correct as string[][]).map(a => a.join("/")) : [],
    pairs: opts && !Array.isArray(opts) ? opts.left.map((left, i) => ({ left, right: opts.right[i] })) : [{ left: "", right: "" }, { left: "", right: "" }],
    explanation: q?.explanation ?? "",
    points: String(q?.points ?? 1),
    tags: (q?.tags ?? []).join(", "),
    difficulty: (q?.difficulty as Difficulty) ?? "medium"
  };
}

function toPayload(s: FormState): QuestionPayload {
  const base: QuestionPayload = { type: s.type, prompt: s.prompt, explanation: s.explanation.trim() || null, points: Number(s.points) || 1,
    tags: s.tags.split(",").map(t => t.trim()).filter(Boolean), difficulty: s.difficulty };
  const options = s.options.map(o => o.trim()).filter(Boolean);
  switch (s.type) {
    case "single": case "multiple": return { ...base, options, correct: s.correct.filter(i => i < options.length) };
    case "true_false": return { ...base, correct: [s.correct[0] ?? 0] };
    case "short": return { ...base, correct: s.accepted.split("\n").map(a => a.trim()).filter(Boolean) };
    case "fill_blank": return { ...base, correct: s.blanks.map(b => b.split("/").map(a => a.trim()).filter(Boolean)) };
    case "matching": return { ...base, options: s.pairs.filter(p => p.left.trim() || p.right.trim()).map(p => `${p.left.trim()}::${p.right.trim()}`) };
    case "ordering": return { ...base, options };
    default: return base;
  }
}

const blankCount = (prompt: string) => (prompt.match(/_{3,}/g) || []).length;

/** Question fields for every type; used by the bank and by interactive video questions. */
export const QuestionForm: React.FC<{
  initial?: Partial<BankQuestion> | null;
  allowed?: QuestionType[];
  showMeta?: boolean;
  submitLabel?: string;
  extra?: React.ReactNode;
  onSubmit: (payload: QuestionPayload) => Promise<void>;
  onCancel: () => void;
}> = ({ initial, allowed = ALL_TYPES, showMeta = true, submitLabel = "บันทึกคำถาม", extra, onSubmit, onCancel }) => {
  const [s, setS] = useState<FormState>(() => initialState(initial, allowed[0]));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setS(prev => ({ ...prev, [key]: value }));
  const blanks = blankCount(s.prompt);

  useEffect(() => {
    if (s.type === "fill_blank" && s.blanks.length !== blanks) set("blanks", Array.from({ length: blanks }, (_, i) => s.blanks[i] ?? ""));
  }, [blanks, s.type]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSubmit(toPayload(s));
    } catch (err: any) {
      setError(err.message || "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  };

  const toggleCorrect = (i: number) => {
    if (s.type === "multiple") set("correct", s.correct.includes(i) ? s.correct.filter(x => x !== i) : [...s.correct, i]);
    else set("correct", [i]);
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <ErrorBox message={error} />
      <div style={grid2}>
        <Field label="ประเภทคำถาม">
          <select className="form-input" value={s.type} onChange={e => setS(initialState({ ...toPayload(s) as any, options: s.options, type: e.target.value as QuestionType, correct: [0] }))}>
            {allowed.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </Field>
        {showMeta && (
          <Field label="คะแนน">
            <input className="form-input" type="number" min={0.5} step={0.5} value={s.points} onChange={e => set("points", e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="โจทย์" hint={s.type === "fill_blank" ? "พิมพ์ ___ (ขีดล่าง 3 ตัวขึ้นไป) ตรงตำแหน่งช่องว่าง" : undefined}>
        <textarea className="form-input" rows={3} value={s.prompt} onChange={e => set("prompt", e.target.value)} required maxLength={5000} />
      </Field>

      {(s.type === "single" || s.type === "multiple") && (
        <Field label={s.type === "single" ? "ตัวเลือก (เลือกคำตอบที่ถูก 1 ข้อ)" : "ตัวเลือก (เลือกคำตอบที่ถูกได้หลายข้อ)"}>
          {s.options.map((opt, i) => (
            <div key={i} style={{ ...rowFlex, flexWrap: "nowrap" }}>
              <input type={s.type === "single" ? "radio" : "checkbox"} checked={s.correct.includes(i)} onChange={() => toggleCorrect(i)} aria-label={`ข้อ ${i + 1} ถูก`} />
              <input className="form-input" value={opt} placeholder={`ตัวเลือกที่ ${i + 1}`}
                onChange={e => set("options", s.options.map((o, j) => j === i ? e.target.value : o))} />
              {s.options.length > 2 && (
                <button type="button" className="tech-button-outline" style={smallButton}
                  onClick={() => { set("options", s.options.filter((_, j) => j !== i)); set("correct", s.correct.filter(x => x !== i).map(x => x > i ? x - 1 : x)); }}>ลบ</button>
              )}
            </div>
          ))}
          {s.options.length < 10 && <button type="button" className="tech-button-outline" style={{ ...smallButton, alignSelf: "flex-start" }} onClick={() => set("options", [...s.options, ""])}>+ เพิ่มตัวเลือก</button>}
        </Field>
      )}

      {s.type === "true_false" && (
        <Field label="คำตอบที่ถูก">
          <div style={rowFlex}>
            {["จริง", "เท็จ"].map((label, i) => (
              <label key={label} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <input type="radio" checked={s.correct[0] === i} onChange={() => set("correct", [i])} /> {label}
              </label>
            ))}
          </div>
        </Field>
      )}

      {s.type === "short" && (
        <Field label="คำตอบที่ยอมรับ (บรรทัดละ 1 คำตอบ)" hint="ไม่สนตัวพิมพ์เล็ก/ใหญ่และช่องว่างซ้ำ">
          <textarea className="form-input" rows={3} value={s.accepted} onChange={e => set("accepted", e.target.value)} />
        </Field>
      )}

      {s.type === "fill_blank" && (
        <Field label={`คำตอบของแต่ละช่อง (${blanks} ช่อง)`} hint="ใส่คำตอบที่ยอมรับได้หลายแบบโดยคั่นด้วย /">
          {blanks === 0 && <span style={mutedText}>ยังไม่มีช่องว่างในโจทย์</span>}
          {s.blanks.map((b, i) => (
            <input key={i} className="form-input" value={b} placeholder={`ช่องที่ ${i + 1}`}
              onChange={e => set("blanks", s.blanks.map((x, j) => j === i ? e.target.value : x))} />
          ))}
        </Field>
      )}

      {s.type === "matching" && (
        <Field label="คู่ที่ถูกต้อง (ฝั่งขวาจะถูกสลับลำดับให้ผู้เรียน)">
          {s.pairs.map((p, i) => (
            <div key={i} style={{ ...rowFlex, flexWrap: "nowrap" }}>
              <input className="form-input" value={p.left} placeholder="ฝั่งซ้าย" onChange={e => set("pairs", s.pairs.map((x, j) => j === i ? { ...x, left: e.target.value } : x))} />
              <span>↔</span>
              <input className="form-input" value={p.right} placeholder="ฝั่งขวา" onChange={e => set("pairs", s.pairs.map((x, j) => j === i ? { ...x, right: e.target.value } : x))} />
              {s.pairs.length > 2 && <button type="button" className="tech-button-outline" style={smallButton} onClick={() => set("pairs", s.pairs.filter((_, j) => j !== i))}>ลบ</button>}
            </div>
          ))}
          {s.pairs.length < 20 && <button type="button" className="tech-button-outline" style={{ ...smallButton, alignSelf: "flex-start" }} onClick={() => set("pairs", [...s.pairs, { left: "", right: "" }])}>+ เพิ่มคู่</button>}
        </Field>
      )}

      {s.type === "ordering" && (
        <Field label="รายการตามลำดับที่ถูกต้อง (ผู้เรียนจะเห็นแบบสลับ)">
          {s.options.map((opt, i) => (
            <div key={i} style={{ ...rowFlex, flexWrap: "nowrap" }}>
              <span style={{ width: "24px", ...mutedText }}>{i + 1}.</span>
              <input className="form-input" value={opt} onChange={e => set("options", s.options.map((o, j) => j === i ? e.target.value : o))} />
              {s.options.length > 2 && <button type="button" className="tech-button-outline" style={smallButton} onClick={() => set("options", s.options.filter((_, j) => j !== i))}>ลบ</button>}
            </div>
          ))}
          {s.options.length < 20 && <button type="button" className="tech-button-outline" style={{ ...smallButton, alignSelf: "flex-start" }} onClick={() => set("options", [...s.options, ""])}>+ เพิ่มรายการ</button>}
        </Field>
      )}

      {s.type === "essay" && <p style={mutedText}>คำถามอัตนัยจะเข้าคิว "รอตรวจ" ให้ผู้สอนให้คะแนนเอง</p>}

      <Field label="คำอธิบายเฉลย (ไม่บังคับ)">
        <textarea className="form-input" rows={2} value={s.explanation} onChange={e => set("explanation", e.target.value)} maxLength={5000} />
      </Field>
      {showMeta && (
        <div style={grid2}>
          <Field label="แท็ก (คั่นด้วย ,)" hint="ใช้สุ่มข้อสอบตามหัวข้อ">
            <input className="form-input" value={s.tags} onChange={e => set("tags", e.target.value)} />
          </Field>
          <Field label="ระดับความยาก">
            <select className="form-input" value={s.difficulty} onChange={e => set("difficulty", e.target.value as Difficulty)}>
              {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map(d => <option key={d} value={d}>{DIFFICULTY_LABEL[d]}</option>)}
            </select>
          </Field>
        </div>
      )}
      {extra}
      <div style={{ ...rowFlex, justifyContent: "flex-end" }}>
        <button type="button" className="tech-button-outline" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="tech-button-primary" disabled={saving}>{saving ? "กำลังบันทึก..." : submitLabel}</button>
      </div>
    </form>
  );
};

/** Short text describing the answer key, for lists. */
export function answerSummary(q: Pick<BankQuestion, "type" | "options" | "correct">): string {
  const c = q.correct as any;
  if (q.type === "essay") return "ตรวจเอง";
  if (q.type === "true_false") return c?.[0] === 0 ? "จริง" : "เท็จ";
  if ((q.type === "single" || q.type === "multiple") && Array.isArray(q.options)) return (c as number[]).map(i => (q.options as string[])[i]).join(", ");
  if (q.type === "short") return (c as string[]).join(" / ");
  if (q.type === "fill_blank") return (c as string[][]).map(a => a.join("/")).join(" | ");
  if (q.type === "matching" && q.options && !Array.isArray(q.options)) { const o = q.options; return o.left.map((l, i) => `${l}→${o.right[i]}`).join(", "); }
  if (q.type === "ordering" && Array.isArray(q.options)) return (q.options as string[]).join(" → ");
  return "";
}

/** Question bank of one course: filter, add/edit, delete, CSV import/export. */
export const QuestionBankPage: React.FC<{ courseId: string }> = ({ courseId }) => {
  const api = useApi();
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [filter, setFilter] = useState({ type: "", tag: "", difficulty: "", q: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BankQuestion | "new" | null>(null);
  const [importErrors, setImportErrors] = useState<{ row: number; error: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
      const res = await api.request<{ questions: BankQuestion[]; tags: string[] }>(`/instructor/courses/${courseId}/questions?${params}`);
      setQuestions(res.questions);
      setTags(res.tags);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api.request, courseId, filter]);

  useEffect(() => { load(); }, [load]);

  const save = async (payload: QuestionPayload) => {
    if (editing && editing !== "new") await api.patch(`/instructor/questions/${editing.id}`, payload);
    else await api.post(`/instructor/courses/${courseId}/questions`, payload);
    setEditing(null);
    load();
  };

  const remove = async (q: BankQuestion) => {
    if (!confirm("ลบคำถามนี้ออกจากคลัง? การทำข้อสอบที่ผ่านมาจะยังเก็บคำถามเดิมไว้")) return;
    try {
      await api.request(`/instructor/questions/${q.id}`, { method: "DELETE" });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const importCsv = async (file: File) => {
    setImportErrors([]);
    setError(null);
    try {
      const csv = await file.text();
      const res = await fetch(`${API_BASE_URL}/instructor/courses/${courseId}/questions/import`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${api.token}` }, body: JSON.stringify({ csv })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "นำเข้าไม่สำเร็จ");
        setImportErrors(data.errors || []);
        return;
      }
      alert(`นำเข้าคำถาม ${data.created} ข้อเรียบร้อยแล้ว`);
      load();
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div>
      <div style={{ ...rowFlex, justifyContent: "space-between", marginBottom: "16px" }}>
        <div style={rowFlex}>
          <select className="form-input" style={{ width: "auto" }} value={filter.type} onChange={e => setFilter({ ...filter, type: e.target.value })} aria-label="กรองประเภท">
            <option value="">ทุกประเภท</option>
            {ALL_TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
          <select className="form-input" style={{ width: "auto" }} value={filter.tag} onChange={e => setFilter({ ...filter, tag: e.target.value })} aria-label="กรองแท็ก">
            <option value="">ทุกแท็ก</option>
            {tags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className="form-input" style={{ width: "auto" }} value={filter.difficulty} onChange={e => setFilter({ ...filter, difficulty: e.target.value })} aria-label="กรองความยาก">
            <option value="">ทุกระดับ</option>
            {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map(d => <option key={d} value={d}>{DIFFICULTY_LABEL[d]}</option>)}
          </select>
          <input className="form-input" style={{ width: "180px" }} placeholder="ค้นหาโจทย์" value={filter.q} onChange={e => setFilter({ ...filter, q: e.target.value })} />
        </div>
        <div style={rowFlex}>
          <button className="tech-button-outline" style={smallButton}
            onClick={() => downloadWithAuth(`/instructor/courses/${courseId}/questions/export`, api.token, `questions-${courseId}.csv`).catch(err => setError(err.message))}>
            <Download size={14} /> ส่งออก CSV
          </button>
          <button className="tech-button-outline" style={smallButton} onClick={() => fileRef.current?.click()}><Upload size={14} /> นำเข้า CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={e => e.target.files?.[0] && importCsv(e.target.files[0])} />
          <button className="tech-button-primary" style={smallButton} onClick={() => setEditing("new")}><Plus size={14} /> เพิ่มคำถาม</button>
        </div>
      </div>
      <p style={{ ...mutedText, marginBottom: "12px" }}>
        CSV: type,prompt,options,correct,explanation,points,tags,difficulty — ตัวเลือกคั่นด้วย | คำตอบแบบตัวเลือกใช้เลขข้อ (เริ่มที่ 1) จับคู่ใช้ ซ้าย::ขวา
      </p>
      <ErrorBox message={error} />
      {importErrors.length > 0 && (
        <ul style={{ ...mutedText, color: "var(--danger)", marginBottom: "12px", paddingLeft: "18px" }}>
          {importErrors.map(e => <li key={e.row}>แถว {e.row}: {e.error}</li>)}
        </ul>
      )}
      {loading ? <Empty text="กำลังโหลด..." /> : questions.length === 0 ? <Empty text="ยังไม่มีคำถามในคลัง" /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {questions.map(q => (
            <div key={q.id} style={cardStyle}>
              <div style={{ ...rowFlex, justifyContent: "space-between", flexWrap: "nowrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...rowFlex, marginBottom: "6px" }}>
                    <Chip label={TYPE_LABEL[q.type]} color="var(--primary)" bg="var(--primary-glow)" />
                    <Chip label={DIFFICULTY_LABEL[q.difficulty]} color="var(--text-secondary)" bg="rgba(100,116,139,0.12)" />
                    <span style={mutedText}>{q.points} คะแนน</span>
                    {q.tags.map(t => <span key={t} style={{ ...mutedText, color: "var(--secondary)" }}>#{t}</span>)}
                  </div>
                  <div style={{ fontSize: "14px", color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>{q.prompt}</div>
                  <div style={{ ...mutedText, marginTop: "4px" }}>เฉลย: {answerSummary(q)}</div>
                </div>
                <div style={{ ...rowFlex, flexWrap: "nowrap" }}>
                  <button className="tech-button-outline" style={smallButton} onClick={() => setEditing(q)} aria-label="แก้ไข"><Pencil size={14} /></button>
                  <button className="tech-button-outline" style={{ ...smallButton, color: "var(--danger)" }} onClick={() => remove(q)} aria-label="ลบ"><Trash2 size={14} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <Modal title={editing === "new" ? "เพิ่มคำถาม" : "แก้ไขคำถาม"} onClose={() => setEditing(null)} width={720}>
          <QuestionForm initial={editing === "new" ? null : editing} onSubmit={save} onCancel={() => setEditing(null)} />
        </Modal>
      )}
    </div>
  );
};

export default QuestionBankPage;
