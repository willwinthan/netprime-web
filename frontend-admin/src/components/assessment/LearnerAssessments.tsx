import React, { useCallback, useEffect, useState } from "react";
import { ClipboardList, FileText } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, Modal } from "../site-admin/ui";
import { ExamPlayer, AttemptResult } from "./ExamPlayer";
import { AssignmentPanel } from "./AssignmentPanel";
import { Gradebook } from "./ExamReport";
import { Attempt, SUBMISSION_STATUS, Submission, cardStyle, formatWhen, mutedText, rowFlex, smallButton } from "./types";

interface LearnerExam {
  id: string; title: string; description: string | null; lesson_id: string | null; lesson_title: string | null; is_final: boolean;
  time_limit_minutes: number | null; max_attempts: number | null; pass_percent: number; available_from: string | null; available_until: string | null;
  attempts_used: number; best_percent: number | null; passed: boolean | null; open_attempt_id: string | null;
  attempts: { id: string; attempt_no: number; status: string; percent: number | null; passed: number | null; submitted_at: string | null }[];
}
interface LearnerAssignment {
  id: string; title: string; lesson_id: string; lesson_title: string; due_at: string | null; max_score: number;
  submission_status: Submission["status"] | null; final_score: number | null;
}

/** Exams, assignments and the learner's own gradebook for a course (Dashboard course view tab). */
export const LearnerAssessments: React.FC<{ courseId: string; lessonId?: string | null }> = ({ courseId, lessonId }) => {
  const api = useApi();
  const [data, setData] = useState<{ requires_final_exam: boolean; exams: LearnerExam[]; assignments: LearnerAssignment[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [assignmentId, setAssignmentId] = useState<string | null>(null);
  const [result, setResult] = useState<Attempt | null>(null);
  const [showBook, setShowBook] = useState(false);

  const load = useCallback(() => {
    api.request<typeof data>(`/student/courses/${courseId}/assessments`).then(setData).catch(err => setError(err.message));
  }, [api.request, courseId]);
  useEffect(() => { load(); }, [load]);

  const viewAttempt = async (id: string) => {
    try {
      const res = await api.request<{ attempt: Attempt }>(`/student/exam-attempts/${id}`);
      setResult(res.attempt);
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (playing) return <ExamPlayer examId={playing} onExit={() => { setPlaying(null); load(); }} />;
  if (!data) return error ? <ErrorBox message={error} /> : <Empty text="กำลังโหลด..." />;

  const now = Date.now();
  const examState = (e: LearnerExam) => {
    if (e.open_attempt_id) return { label: "ทำต่อ", can: true };
    if (e.available_from && Date.parse(e.available_from) > now) return { label: `เปิด ${formatWhen(e.available_from)}`, can: false };
    if (e.available_until && Date.parse(e.available_until) <= now) return { label: "ปิดแล้ว", can: false };
    if (e.max_attempts && e.attempts_used >= e.max_attempts) return { label: "ครบจำนวนครั้ง", can: false };
    return { label: e.attempts_used ? "ทำอีกครั้ง" : "เริ่มทำข้อสอบ", can: true };
  };
  const inLesson = (id: string | null) => !!lessonId && id === lessonId;
  const exams = [...data.exams].sort((a, b) => Number(inLesson(b.lesson_id)) - Number(inLesson(a.lesson_id)));
  const assignments = [...data.assignments].sort((a, b) => Number(inLesson(b.lesson_id)) - Number(inLesson(a.lesson_id)));

  return (
    <div style={{ paddingTop: "12px" }}>
      <ErrorBox message={error} />
      {data.requires_final_exam && data.exams.some(e => e.is_final) && (
        <div style={{ ...cardStyle, marginBottom: "16px", borderColor: "var(--primary)" }}>
          คอร์สนี้ต้องสอบผ่านข้อสอบปลายภาคก่อนรับใบประกาศนียบัตร
        </div>
      )}
      <div style={{ ...rowFlex, marginBottom: "12px" }}>
        <ClipboardList size={18} color="var(--primary)" /><h4 style={{ fontSize: "16px", color: "var(--text-primary)" }}>ข้อสอบ</h4>
      </div>
      {exams.length === 0 ? <Empty text="คอร์สนี้ยังไม่มีข้อสอบ" /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "24px" }}>
          {exams.map(e => {
            const state = examState(e);
            return (
              <div key={e.id} style={{ ...cardStyle, borderColor: inLesson(e.lesson_id) ? "var(--primary)" : undefined }}>
                <div style={{ ...rowFlex, justifyContent: "space-between" }}>
                  <div>
                    <div style={rowFlex}>
                      <strong>{e.title}</strong>
                      {e.is_final && <Chip label="ปลายภาค" color="var(--primary)" bg="var(--primary-glow)" />}
                      {e.passed === true && <Chip label="ผ่านแล้ว" color="var(--accent)" bg="var(--accent-glow)" />}
                      {inLesson(e.lesson_id) && <span style={mutedText}>บทเรียนนี้</span>}
                    </div>
                    {e.description && <p style={{ fontSize: "13px", marginTop: "4px" }}>{e.description}</p>}
                    <div style={{ ...mutedText, marginTop: "4px" }}>
                      เกณฑ์ผ่าน {e.pass_percent}% • {e.time_limit_minutes ? `${e.time_limit_minutes} นาที` : "ไม่จำกัดเวลา"}
                      {" • "}ทำแล้ว {e.attempts_used}{e.max_attempts ? `/${e.max_attempts}` : ""} ครั้ง
                      {e.best_percent !== null ? ` • คะแนนสูงสุด ${e.best_percent}%` : ""}
                      {e.lesson_title ? ` • ${e.lesson_title}` : ""}
                    </div>
                    {e.attempts.filter(a => a.status !== "in_progress").length > 0 && (
                      <div style={{ ...rowFlex, marginTop: "6px" }}>
                        {e.attempts.filter(a => a.status !== "in_progress").map(a => (
                          <button key={a.id} className="tech-button-outline" style={{ ...smallButton, padding: "3px 8px" }} onClick={() => viewAttempt(a.id)}>
                            ครั้งที่ {a.attempt_no}: {a.status === "pending_grading" ? "รอตรวจ" : `${a.percent}%`}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button className="tech-button-primary" style={smallButton} disabled={!state.can} onClick={() => setPlaying(e.id)}>{state.label}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ ...rowFlex, marginBottom: "12px" }}>
        <FileText size={18} color="var(--primary)" /><h4 style={{ fontSize: "16px", color: "var(--text-primary)" }}>งานที่มอบหมาย</h4>
      </div>
      {assignments.length === 0 ? <Empty text="คอร์สนี้ยังไม่มีงานที่มอบหมาย" /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "24px" }}>
          {assignments.map(a => {
            const status = a.submission_status ? SUBMISSION_STATUS[a.submission_status] : null;
            return (
              <div key={a.id} style={{ ...cardStyle, borderColor: inLesson(a.lesson_id) ? "var(--primary)" : undefined }}>
                <div style={{ ...rowFlex, justifyContent: "space-between" }}>
                  <div>
                    <div style={rowFlex}>
                      <strong>{a.title}</strong>
                      {status ? <Chip {...status} /> : <Chip label="ยังไม่ส่ง" color="var(--text-secondary)" bg="rgba(100,116,139,0.12)" />}
                    </div>
                    <div style={{ ...mutedText, marginTop: "4px" }}>
                      {a.lesson_title} • กำหนดส่ง {formatWhen(a.due_at)}{a.submission_status === "graded" ? ` • ได้ ${a.final_score}/${a.max_score}` : ""}
                    </div>
                  </div>
                  <button className="tech-button-outline" style={smallButton} onClick={() => setAssignmentId(a.id)}>เปิดงาน</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button className="tech-button-outline" style={smallButton} onClick={() => setShowBook(!showBook)}>{showBook ? "ซ่อนสมุดคะแนน" : "ดูสมุดคะแนนของฉัน"}</button>
      {showBook && <div style={{ marginTop: "12px" }}><Gradebook courseId={courseId} learner /></div>}

      {assignmentId && (
        <Modal title="งานที่มอบหมาย" onClose={() => { setAssignmentId(null); load(); }} width={760}>
          <AssignmentPanel assignmentId={assignmentId} onChanged={load} />
        </Modal>
      )}
      {result && (
        <Modal title={`${result.exam_title} • ครั้งที่ ${result.attempt_no}`} onClose={() => setResult(null)} width={760}>
          <AttemptResult attempt={result} />
        </Modal>
      )}
    </div>
  );
};

export default LearnerAssessments;
