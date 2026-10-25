import React, { useCallback, useEffect, useRef, useState } from "react";
import { Clock, ArrowUp, ArrowDown, CheckCircle2, XCircle } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox } from "../site-admin/ui";
import { Attempt, AttemptQuestion, Option, TYPE_LABEL, cardStyle, formatWhen, mutedText, rowFlex, smallButton } from "./types";

const AUTOSAVE_MS = 15_000;
const text = (opts: Option[] | undefined, id: unknown) => opts?.find(o => o.id === id)?.text ?? "-";

/** The learner's response in words (results and grading). */
export const ResponseView: React.FC<{ q: AttemptQuestion }> = ({ q }) => {
  const r = q.response;
  if (r === null || r === undefined || (Array.isArray(r) && !r.length) || r === "") return <div style={mutedText}>ไม่ได้ตอบ</div>;
  let body: React.ReactNode;
  switch (q.type) {
    case "single": case "true_false": body = text(q.options, Array.isArray(r) ? r[0] : r); break;
    case "multiple": body = (r as number[]).map(id => text(q.options, id)).join(", "); break;
    case "fill_blank": body = (r as string[]).map((v, i) => `(${i + 1}) ${v || "-"}`).join("  "); break;
    case "matching": body = q.left?.map(l => `${l.text} → ${text(q.right, (r as number[])[l.id])}`).join(" • "); break;
    case "ordering": body = (r as number[]).map(id => text(q.options, id)).join(" → "); break;
    default: body = <span style={{ whiteSpace: "pre-wrap" }}>{String(r)}</span>;
  }
  return <div style={{ fontSize: "14px" }}><span style={mutedText}>คำตอบ: </span>{body}</div>;
};

/** The answer key (only present when the exam policy reveals answers). */
const CorrectView: React.FC<{ q: AttemptQuestion }> = ({ q }) => {
  const c = q.correct_answer;
  if (c === undefined || c === null) return null;
  let body: string;
  switch (q.type) {
    case "single": case "multiple": case "true_false": body = (c as number[]).map(id => text(q.options, id)).join(", "); break;
    case "short": body = (c as string[]).join(" / "); break;
    case "fill_blank": body = (c as string[][]).map((a, i) => `(${i + 1}) ${a.join("/")}`).join("  "); break;
    case "matching": body = (q.left ?? []).map(l => `${l.text} → ${text(q.right, (c as number[])[l.id])}`).join(" • "); break;
    case "ordering": body = (c as number[]).map(id => text(q.options, id)).join(" → "); break;
    default: return null;
  }
  return <div style={{ fontSize: "13px", color: "var(--accent)" }}>เฉลย: {body}</div>;
};

/** Input for one question; `value` follows the server's response format per type. */
const QuestionInput: React.FC<{ q: AttemptQuestion; value: any; onChange: (v: any) => void }> = ({ q, value, onChange }) => {
  switch (q.type) {
    case "single": case "true_false":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {q.options?.map(o => (
            <label key={o.id} style={{ display: "flex", gap: "8px", alignItems: "center", cursor: "pointer" }}>
              <input type="radio" name={q.id} checked={value === o.id} onChange={() => onChange(o.id)} /> {o.text}
            </label>
          ))}
        </div>
      );
    case "multiple": {
      const list: number[] = Array.isArray(value) ? value : [];
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {q.options?.map(o => (
            <label key={o.id} style={{ display: "flex", gap: "8px", alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={list.includes(o.id)} onChange={() => onChange(list.includes(o.id) ? list.filter(x => x !== o.id) : [...list, o.id])} /> {o.text}
            </label>
          ))}
          <span style={mutedText}>เลือกได้มากกว่า 1 ข้อ</span>
        </div>
      );
    }
    case "short":
      return <input className="form-input" value={value ?? ""} maxLength={1000} onChange={e => onChange(e.target.value)} placeholder="พิมพ์คำตอบ" />;
    case "essay":
      return <textarea className="form-input" rows={6} value={value ?? ""} maxLength={20000} onChange={e => onChange(e.target.value)} placeholder="เขียนคำตอบ" />;
    case "fill_blank": {
      const parts = q.prompt.split(/_{3,}/);
      const list: string[] = Array.isArray(value) ? value : Array(q.blanks ?? 0).fill("");
      return (
        <div style={{ lineHeight: 2.4 }}>
          {parts.map((p, i) => (
            <React.Fragment key={i}>
              <span style={{ whiteSpace: "pre-wrap" }}>{p}</span>
              {i < parts.length - 1 && (
                <input className="form-input" style={{ display: "inline-block", width: "160px", margin: "0 6px" }} value={list[i] ?? ""} aria-label={`ช่องที่ ${i + 1}`}
                  onChange={e => onChange(Array.from({ length: q.blanks ?? 0 }, (_, j) => j === i ? e.target.value : list[j] ?? ""))} />
              )}
            </React.Fragment>
          ))}
        </div>
      );
    }
    case "matching": {
      const list: (number | null)[] = Array.isArray(value) ? value : (q.left ?? []).map(() => null);
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {q.left?.map(l => (
            <div key={l.id} style={{ ...rowFlex, flexWrap: "nowrap" }}>
              <span style={{ flex: 1 }}>{l.text}</span>
              <select className="form-input" style={{ flex: 1 }} value={list[l.id] ?? ""} aria-label={`คู่ของ ${l.text}`}
                onChange={e => onChange((q.left ?? []).map(x => x.id === l.id ? (e.target.value === "" ? null : Number(e.target.value)) : list[x.id] ?? null))}>
                <option value="">— เลือก —</option>
                {q.right?.map(r => <option key={r.id} value={r.id}>{r.text}</option>)}
              </select>
            </div>
          ))}
        </div>
      );
    }
    case "ordering": {
      const order: number[] = Array.isArray(value) && value.length === q.options?.length ? value : (q.options ?? []).map(o => o.id);
      const move = (i: number, d: number) => {
        const next = [...order];
        [next[i], next[i + d]] = [next[i + d], next[i]];
        onChange(next);
      };
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {order.map((id, i) => (
            <div key={id} style={{ ...rowFlex, flexWrap: "nowrap", ...cardStyle, padding: "8px 12px" }}>
              <span style={{ width: "24px", ...mutedText }}>{i + 1}.</span>
              <span style={{ flex: 1 }}>{text(q.options, id)}</span>
              <button type="button" className="tech-button-outline" style={smallButton} disabled={i === 0} onClick={() => move(i, -1)} aria-label="เลื่อนขึ้น"><ArrowUp size={14} /></button>
              <button type="button" className="tech-button-outline" style={smallButton} disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label="เลื่อนลง"><ArrowDown size={14} /></button>
            </div>
          ))}
        </div>
      );
    }
  }
  return null;
};

/** Results of a closed attempt, following the exam's show-answers policy. */
export const AttemptResult: React.FC<{ attempt: Attempt }> = ({ attempt }) => (
  <div>
    <div style={{ ...cardStyle, marginBottom: "16px", textAlign: "center" }}>
      {attempt.status === "pending_grading" ? (
        <>
          <h3 style={{ color: "var(--text-primary)" }}>ส่งข้อสอบแล้ว รอผู้สอนตรวจข้อเขียน</h3>
          <p style={mutedText}>คะแนนส่วนปรนัยตอนนี้ {attempt.score}/{attempt.max_score}</p>
        </>
      ) : (
        <>
          {attempt.passed ? <CheckCircle2 size={36} color="var(--accent)" style={{ margin: "0 auto" }} /> : <XCircle size={36} color="var(--danger)" style={{ margin: "0 auto" }} />}
          <h3 style={{ color: "var(--text-primary)", marginTop: "8px" }}>{attempt.percent}% — {attempt.passed ? "ผ่านเกณฑ์" : "ยังไม่ผ่านเกณฑ์"}</h3>
          <p style={mutedText}>{attempt.score}/{attempt.max_score} คะแนน • เกณฑ์ผ่าน {attempt.pass_percent}%</p>
        </>
      )}
      {attempt.auto_closed && <p style={{ ...mutedText, color: "var(--warning)" }}>หมดเวลา ระบบส่งคำตอบที่บันทึกไว้ให้อัตโนมัติ</p>}
      {attempt.feedback && <p style={{ marginTop: "8px" }}>ความเห็นผู้สอน: {attempt.feedback}</p>}
    </div>
    {attempt.questions.map((q, i) => (
      <div key={q.id} style={{ ...cardStyle, marginBottom: "10px" }}>
        <div style={{ ...rowFlex, marginBottom: "6px" }}>
          <strong>ข้อ {i + 1}</strong>
          {q.is_correct === true && <Chip label="ถูก" color="var(--accent)" bg="var(--accent-glow)" />}
          {q.is_correct === false && <Chip label={q.points_awarded ? "ได้บางส่วน" : "ผิด"} color="var(--danger)" bg="rgba(239,68,68,0.1)" />}
          {q.points_awarded !== undefined && q.points_awarded !== null && <span style={mutedText}>{q.points_awarded}/{q.points} คะแนน</span>}
          {q.type === "essay" && q.points_awarded === null && <span style={mutedText}>รอตรวจ</span>}
        </div>
        <div style={{ whiteSpace: "pre-wrap", marginBottom: "6px" }}>{q.prompt}</div>
        <ResponseView q={q} />
        <CorrectView q={q} />
        {q.explanation && <div style={{ ...mutedText, marginTop: "4px" }}>คำอธิบาย: {q.explanation}</div>}
        {q.feedback && <div style={{ fontSize: "13px", marginTop: "4px" }}>ความเห็น: {q.feedback}</div>}
      </div>
    ))}
    {!attempt.answers_revealed && attempt.status === "graded" && <p style={mutedText}>ข้อสอบนี้ไม่แสดงเฉลย</p>}
  </div>
);

function remaining(deadline: string | null) {
  if (!deadline) return null;
  return Math.max(0, Math.floor((Date.parse(deadline) - Date.now()) / 1000));
}

/** Takes an exam: starts or resumes the attempt, autosaves, counts down to the server deadline. */
export const ExamPlayer: React.FC<{ examId: string; onExit: () => void }> = ({ examId, onExit }) => {
  const api = useApi();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dirty = useRef(false);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  useEffect(() => {
    api.post<{ attempt: Attempt }>(`/student/exams/${examId}/start`, {}).then(res => {
      setAttempt(res.attempt);
      // Ordering starts from the shown order so an untouched list is still a valid answer.
      setAnswers(Object.fromEntries(res.attempt.questions.map(q => [q.id, q.response ?? (q.type === "ordering" ? q.options?.map(o => o.id) : null)])
        .filter(([, v]) => v !== null && v !== undefined)));
      setLeft(remaining(res.attempt.deadline_at));
    }).catch(err => setError(err.message));
  }, [examId]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = attempt?.status === "in_progress";

  const submit = useCallback(async (auto = false) => {
    if (!attempt) return;
    if (!auto && !confirm("ยืนยันส่งข้อสอบ? ส่งแล้วแก้ไขไม่ได้")) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ attempt: Attempt }>(`/student/exam-attempts/${attempt.id}/submit`, { answers: answersRef.current });
      setAttempt(res.attempt);
    } catch (err: any) {
      // Past the deadline the server closes the attempt with the saved answers.
      setError(err.message);
      const res = await api.request<{ attempt: Attempt }>(`/student/exam-attempts/${attempt.id}`).catch(() => null);
      if (res) setAttempt(res.attempt);
    } finally {
      setSubmitting(false);
    }
  }, [attempt, api.post, api.request]); // eslint-disable-line react-hooks/exhaustive-deps

  // Countdown; submit automatically at zero.
  useEffect(() => {
    if (!open || !attempt?.deadline_at) return;
    const timer = setInterval(() => {
      const s = remaining(attempt.deadline_at);
      setLeft(s);
      if (s === 0) { clearInterval(timer); submit(true); }
    }, 1000);
    return () => clearInterval(timer);
  }, [open, attempt?.deadline_at, submit]);

  // Autosave so a closed tab or lost connection keeps the answers.
  useEffect(() => {
    if (!open || !attempt) return;
    const timer = setInterval(() => {
      if (!dirty.current) return;
      dirty.current = false;
      api.request(`/student/exam-attempts/${attempt.id}/answers`, { method: "PUT", body: JSON.stringify({ answers: answersRef.current }) })
        .catch(err => setError(err.message));
    }, AUTOSAVE_MS);
    return () => clearInterval(timer);
  }, [open, attempt, api.request]);

  const change = (qid: string, v: any) => {
    dirty.current = true;
    setAnswers(prev => ({ ...prev, [qid]: v }));
  };

  if (!attempt) return error ? <div><ErrorBox message={error} /><button className="tech-button-outline" onClick={onExit}>กลับ</button></div> : <Empty text="กำลังเตรียมข้อสอบ..." />;

  return (
    <div>
      <div style={{ ...rowFlex, justifyContent: "space-between", marginBottom: "16px" }}>
        <div>
          <h3 style={{ color: "var(--text-primary)" }}>{attempt.exam_title}</h3>
          <span style={mutedText}>ครั้งที่ {attempt.attempt_no} • เริ่ม {formatWhen(attempt.started_at)}</span>
        </div>
        <div style={rowFlex}>
          {open && left !== null && (
            <span style={{ ...rowFlex, fontWeight: 700, color: left < 60 ? "var(--danger)" : "var(--text-primary)" }}>
              <Clock size={16} /> {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
            </span>
          )}
          <button className="tech-button-outline" style={smallButton} onClick={onExit}>{open ? "ออก (บันทึกไว้)" : "กลับ"}</button>
        </div>
      </div>
      <ErrorBox message={error} />
      {open ? (
        <>
          {attempt.questions.map((q, i) => (
            <div key={q.id} style={{ ...cardStyle, marginBottom: "12px" }}>
              <div style={{ ...rowFlex, marginBottom: "8px" }}>
                <strong>ข้อ {i + 1}</strong><span style={mutedText}>{TYPE_LABEL[q.type]} • {q.points} คะแนน</span>
              </div>
              {q.type !== "fill_blank" && <div style={{ whiteSpace: "pre-wrap", marginBottom: "10px", color: "var(--text-primary)" }}>{q.prompt}</div>}
              <QuestionInput q={q} value={answers[q.id] ?? null} onChange={v => change(q.id, v)} />
            </div>
          ))}
          <div style={{ ...rowFlex, justifyContent: "flex-end" }}>
            <span style={mutedText}>ตอบแล้ว {attempt.questions.filter(q => answers[q.id] !== undefined && answers[q.id] !== null && answers[q.id] !== "").length}/{attempt.questions.length} ข้อ</span>
            <button className="tech-button-primary" onClick={() => submit(false)} disabled={submitting}>{submitting ? "กำลังส่ง..." : "ส่งข้อสอบ"}</button>
          </div>
        </>
      ) : <AttemptResult attempt={attempt} />}
    </div>
  );
};

export default ExamPlayer;
