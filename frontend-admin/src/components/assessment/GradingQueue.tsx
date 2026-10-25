import React, { useCallback, useEffect, useState } from "react";
import { Paperclip } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, Field, Modal, downloadWithAuth, tableStyle, tdStyle, thStyle } from "../site-admin/ui";
import { Assignment, Attempt, Submission, TYPE_LABEL, cardStyle, formatWhen, mutedText, rowFlex, smallButton } from "./types";
import { ResponseView } from "./ExamPlayer";

/** Per-question points (essays and overrides) for one exam attempt. */
export const AttemptGrader: React.FC<{ attemptId: string; onGraded: () => void }> = ({ attemptId, onGraded }) => {
  const api = useApi();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [points, setPoints] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.request<{ attempt: Attempt }>(`/instructor/exam-attempts/${attemptId}`).then(res => {
      setAttempt(res.attempt);
      setPoints(Object.fromEntries(res.attempt.questions.map(q => [q.id, q.points_awarded === null || q.points_awarded === undefined ? "" : String(q.points_awarded)])));
      setNotes(Object.fromEntries(res.attempt.questions.map(q => [q.id, q.feedback ?? ""])));
      setFeedback(res.attempt.feedback ?? "");
    }).catch(err => setError(err.message));
  }, [api.request, attemptId]);

  const save = async () => {
    if (!attempt) return;
    setSaving(true);
    setError(null);
    try {
      const grades = attempt.questions.filter(q => points[q.id] !== "").map(q => ({ question_id: q.id, points: Number(points[q.id]), feedback: notes[q.id] || null }));
      await api.post(`/instructor/exam-attempts/${attempt.id}/grade`, { grades, feedback: feedback || null });
      onGraded();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!attempt) return error ? <ErrorBox message={error} /> : <Empty text="กำลังโหลด..." />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <ErrorBox message={error} />
      <div style={mutedText}>
        {attempt.user_name} ({attempt.user_email}) • {attempt.exam_title} ครั้งที่ {attempt.attempt_no} • ส่ง {formatWhen(attempt.submitted_at)}
        {attempt.auto_closed ? " • ปิดอัตโนมัติเมื่อหมดเวลา" : ""} • คะแนนปัจจุบัน {attempt.score ?? "-"}/{attempt.max_score ?? "-"}
      </div>
      {attempt.questions.map((q, i) => (
        <div key={q.id} style={{ ...cardStyle, borderColor: q.type === "essay" && points[q.id] === "" ? "var(--warning)" : undefined }}>
          <div style={{ ...rowFlex, marginBottom: "6px" }}>
            <strong>ข้อ {i + 1}</strong><span style={mutedText}>{TYPE_LABEL[q.type]} • เต็ม {q.points}</span>
            {q.is_correct === true && <Chip label="ถูก" color="var(--accent)" bg="var(--accent-glow)" />}
            {q.is_correct === false && <Chip label="ผิด" color="var(--danger)" bg="rgba(239,68,68,0.1)" />}
          </div>
          <div style={{ whiteSpace: "pre-wrap", marginBottom: "8px" }}>{q.prompt}</div>
          <ResponseView q={q} />
          <div style={{ ...rowFlex, marginTop: "8px" }}>
            <label style={rowFlex}>คะแนน
              <input className="form-input" style={{ width: "90px" }} type="number" min={0} max={q.points} step={0.5} value={points[q.id] ?? ""}
                onChange={e => setPoints({ ...points, [q.id]: e.target.value })} />
            </label>
            <input className="form-input" style={{ flex: 1, minWidth: "200px" }} placeholder="ความเห็นรายข้อ" value={notes[q.id] ?? ""}
              onChange={e => setNotes({ ...notes, [q.id]: e.target.value })} />
          </div>
        </div>
      ))}
      <Field label="ความเห็นโดยรวม">
        <textarea className="form-input" rows={2} value={feedback} onChange={e => setFeedback(e.target.value)} />
      </Field>
      <div style={{ ...rowFlex, justifyContent: "flex-end" }}>
        <button className="tech-button-primary" onClick={save} disabled={saving}>{saving ? "กำลังบันทึก..." : "บันทึกคะแนน"}</button>
      </div>
    </div>
  );
};

/** Grade (rubric or score) or return a submission for resubmission. */
export const SubmissionGrader: React.FC<{ assignment: Assignment; submission: Submission; onDone: () => void }> = ({ assignment, submission, onDone }) => {
  const api = useApi();
  const [score, setScore] = useState(submission.score === null ? "" : String(submission.score));
  const [rubric, setRubric] = useState<string[]>(assignment.rubric.map((_, i) => submission.rubric_scores?.[i] !== undefined ? String(submission.rubric_scores[i]) : ""));
  const [feedback, setFeedback] = useState(submission.feedback ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const send = async (action: "grade" | "return") => {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/instructor/assignment-submissions/${submission.id}/grade`, action === "return" ? { action, feedback } :
        assignment.rubric.length ? { action, rubric_scores: rubric.map(Number), feedback } : { action, score: Number(score), feedback });
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const rubricTotal = rubric.reduce((s, v) => s + (Number(v) || 0), 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <ErrorBox message={error} />
      <div style={mutedText}>
        {submission.user_name} ({submission.user_email}) • ส่งครั้งที่ {submission.version} • {formatWhen(submission.submitted_at)}
        {submission.is_late ? ` • ส่งช้า${assignment.late_policy === "penalty" ? ` (หัก ${assignment.late_penalty_percent}%)` : ""}` : ""}
      </div>
      {submission.text_content && <div style={{ ...cardStyle, whiteSpace: "pre-wrap" }}>{submission.text_content}</div>}
      {submission.files.map((f, i) => (
        <button key={i} className="tech-button-outline" style={{ ...smallButton, alignSelf: "flex-start" }}
          onClick={() => downloadWithAuth(`/assignment-submissions/${submission.id}/files/${i}`, api.token, f.name).catch(err => setError(err.message))}>
          <Paperclip size={14} /> {f.name} ({Math.ceil(f.size / 1024)} KB)
        </button>
      ))}
      {assignment.rubric.length ? (
        <div>
          {assignment.rubric.map((r, i) => (
            <div key={i} style={{ ...rowFlex, marginBottom: "6px" }}>
              <span style={{ flex: 1 }}>{r.criterion}</span>
              <input className="form-input" style={{ width: "90px" }} type="number" min={0} max={r.max_points} value={rubric[i]}
                onChange={e => setRubric(rubric.map((v, j) => j === i ? e.target.value : v))} />
              <span style={mutedText}>/ {r.max_points}</span>
            </div>
          ))}
          <div style={mutedText}>รวม {rubricTotal}/{assignment.max_score}</div>
        </div>
      ) : (
        <Field label={`คะแนน (เต็ม ${assignment.max_score})`}>
          <input className="form-input" type="number" min={0} max={assignment.max_score} value={score} onChange={e => setScore(e.target.value)} />
        </Field>
      )}
      <Field label="ความเห็นถึงผู้เรียน">
        <textarea className="form-input" rows={3} value={feedback} onChange={e => setFeedback(e.target.value)} />
      </Field>
      <div style={{ ...rowFlex, justifyContent: "flex-end" }}>
        <button className="tech-button-outline" onClick={() => send("return")} disabled={saving}>ส่งกลับให้แก้ไข</button>
        <button className="tech-button-primary" onClick={() => send("grade")} disabled={saving}>บันทึกคะแนน</button>
      </div>
    </div>
  );
};

interface Queue {
  exam_attempts: { id: string; exam_title: string; course_title: string; user_name: string; user_email: string; attempt_no: number; submitted_at: string }[];
  submissions: { id: string; assignment_id: string; assignment_title: string; course_title: string; user_name: string; user_email: string; version: number; is_late: number; submitted_at: string }[];
}

/** Everything waiting for the instructor: essay answers and assignment submissions. */
export const GradingQueue: React.FC<{ courseId?: string }> = ({ courseId }) => {
  const api = useApi();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [grading, setGrading] = useState<{ assignment: Assignment; submission: Submission } | null>(null);

  const load = useCallback(() => {
    api.request<Queue>(`/instructor/grading-queue${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`)
      .then(setQueue).catch(err => setError(err.message));
  }, [api.request, courseId]);
  useEffect(() => { load(); }, [load]);

  const openSubmission = async (assignmentId: string, submissionId: string) => {
    try {
      const res = await api.request<{ assignment: Assignment; submissions: Submission[] }>(`/instructor/assignments/${assignmentId}/submissions`);
      const submission = res.submissions.find(s => s.id === submissionId);
      if (submission) setGrading({ assignment: res.assignment, submission });
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (!queue) return error ? <ErrorBox message={error} /> : <Empty text="กำลังโหลด..." />;
  return (
    <div>
      <ErrorBox message={error} />
      <h4 style={{ marginBottom: "8px" }}>ข้อสอบอัตนัยรอตรวจ ({queue.exam_attempts.length})</h4>
      {queue.exam_attempts.length === 0 ? <Empty text="ไม่มีข้อสอบรอตรวจ" /> : (
        <table style={{ ...tableStyle, marginBottom: "20px" }}>
          <thead><tr><th style={thStyle}>ผู้เรียน</th><th style={thStyle}>ข้อสอบ</th><th style={thStyle}>ส่งเมื่อ</th><th style={thStyle}></th></tr></thead>
          <tbody>
            {queue.exam_attempts.map(a => (
              <tr key={a.id}>
                <td style={tdStyle}>{a.user_name}<div style={mutedText}>{a.user_email}</div></td>
                <td style={tdStyle}>{a.exam_title} (ครั้งที่ {a.attempt_no}){!courseId && <div style={mutedText}>{a.course_title}</div>}</td>
                <td style={tdStyle}>{formatWhen(a.submitted_at)}</td>
                <td style={tdStyle}><button className="tech-button-primary" style={smallButton} onClick={() => setAttemptId(a.id)}>ตรวจ</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4 style={{ margin: "16px 0 8px" }}>งานที่ส่งรอตรวจ ({queue.submissions.length})</h4>
      {queue.submissions.length === 0 ? <Empty text="ไม่มีงานรอตรวจ" /> : (
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>ผู้เรียน</th><th style={thStyle}>งาน</th><th style={thStyle}>ส่งเมื่อ</th><th style={thStyle}></th></tr></thead>
          <tbody>
            {queue.submissions.map(s => (
              <tr key={s.id}>
                <td style={tdStyle}>{s.user_name}<div style={mutedText}>{s.user_email}</div></td>
                <td style={tdStyle}>{s.assignment_title} {s.version > 1 && <span style={mutedText}>(ส่งใหม่ครั้งที่ {s.version})</span>}
                  {s.is_late ? <Chip label="ส่งช้า" color="var(--warning)" bg="rgba(245,158,11,0.12)" /> : null}
                  {!courseId && <div style={mutedText}>{s.course_title}</div>}</td>
                <td style={tdStyle}>{formatWhen(s.submitted_at)}</td>
                <td style={tdStyle}><button className="tech-button-primary" style={smallButton} onClick={() => openSubmission(s.assignment_id, s.id)}>ตรวจ</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {attemptId && (
        <Modal title="ตรวจข้อสอบ" onClose={() => setAttemptId(null)} width={820}>
          <AttemptGrader attemptId={attemptId} onGraded={() => { setAttemptId(null); load(); }} />
        </Modal>
      )}
      {grading && (
        <Modal title={`ตรวจงาน: ${grading.assignment.title}`} onClose={() => setGrading(null)} width={760}>
          <SubmissionGrader assignment={grading.assignment} submission={grading.submission} onDone={() => { setGrading(null); load(); }} />
        </Modal>
      )}
    </div>
  );
};

export default GradingQueue;
