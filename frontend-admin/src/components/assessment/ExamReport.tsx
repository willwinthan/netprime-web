import React, { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Empty, ErrorBox, Modal, downloadWithAuth, tableStyle, tdStyle, thStyle } from "../site-admin/ui";
import { TYPE_LABEL, QuestionType, formatWhen, mutedText, rowFlex, smallButton } from "./types";
import { AttemptGrader } from "./GradingQueue";

interface Report {
  exam: { id: string; title: string; pass_percent: number };
  summary: { attempts: number; learners: number; graded: number; pending: number; average_percent: number | null; pass_rate: number | null };
  questions: { question_id: string; prompt: string; type: QuestionType; responses: number; difficulty_index: number | null; discrimination: number | null }[];
  attempts: { id: string; user_name: string; user_email: string; attempt_no: number; status: string; score: number | null; max_score: number | null;
    percent: number | null; passed: number | null; submitted_at: string | null; auto_closed: number }[];
}

const Stat: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div style={{ padding: "12px 16px", border: "1px solid var(--border-subtle)", borderRadius: "0.75rem", minWidth: "120px" }}>
    <div style={mutedText}>{label}</div>
    <div style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-primary)" }}>{value}</div>
  </div>
);

/** Difficulty index p (share of points earned) and discrimination D (top 27% − bottom 27%). */
const discriminationHint = (d: number | null) => d === null ? "-" : d >= 0.4 ? "ดีมาก" : d >= 0.2 ? "พอใช้" : d >= 0 ? "ต่ำ" : "ควรทบทวนข้อนี้";

export const ExamReport: React.FC<{ examId: string }> = ({ examId }) => {
  const api = useApi();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api.request<Report>(`/instructor/exams/${examId}/report`).then(setReport).catch(err => setError(err.message));
  }, [api.request, examId, version]);

  if (error) return <ErrorBox message={error} />;
  if (!report) return <Empty text="กำลังโหลด..." />;
  const s = report.summary;
  return (
    <div>
      <div style={{ ...rowFlex, justifyContent: "space-between", marginBottom: "16px" }}>
        <strong>{report.exam.title}</strong>
        <button className="tech-button-outline" style={smallButton}
          onClick={() => downloadWithAuth(`/instructor/exams/${examId}/report/export`, api.token, `exam-report-${examId}.csv`).catch(err => setError(err.message))}>
          <Download size={14} /> ส่งออก CSV
        </button>
      </div>
      <div style={{ ...rowFlex, marginBottom: "20px" }}>
        <Stat label="จำนวนครั้งที่ส่ง" value={s.attempts} />
        <Stat label="ผู้เรียน" value={s.learners} />
        <Stat label="คะแนนเฉลี่ย" value={s.average_percent === null ? "-" : `${s.average_percent}%`} />
        <Stat label="อัตราการผ่าน" value={s.pass_rate === null ? "-" : `${s.pass_rate}%`} />
        <Stat label="รอตรวจ" value={s.pending} />
      </div>

      <h4 style={{ marginBottom: "8px" }}>วิเคราะห์รายข้อ</h4>
      <p style={{ ...mutedText, marginBottom: "8px" }}>ค่าความง่าย = สัดส่วนคะแนนที่ผู้เรียนทำได้ (0–1) • ค่าอำนาจจำแนก = กลุ่มคะแนนสูง 27% ลบกลุ่มคะแนนต่ำ 27%</p>
      <div style={{ overflowX: "auto", marginBottom: "20px" }}>
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>คำถาม</th><th style={thStyle}>ประเภท</th><th style={thStyle}>ตอบ</th><th style={thStyle}>ค่าความง่าย</th><th style={thStyle}>อำนาจจำแนก</th></tr></thead>
          <tbody>
            {report.questions.map(q => (
              <tr key={q.question_id}>
                <td style={tdStyle}>{q.prompt}</td>
                <td style={tdStyle}>{TYPE_LABEL[q.type] ?? q.type}</td>
                <td style={tdStyle}>{q.responses}</td>
                <td style={tdStyle}>{q.difficulty_index ?? "-"}</td>
                <td style={tdStyle}>{q.discrimination ?? "-"} <span style={mutedText}>{discriminationHint(q.discrimination)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.questions.length === 0 && <Empty text="ยังไม่มีผู้ส่งข้อสอบ" />}
      </div>

      <h4 style={{ marginBottom: "8px" }}>การทำข้อสอบ</h4>
      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>ผู้เรียน</th><th style={thStyle}>ครั้งที่</th><th style={thStyle}>คะแนน</th><th style={thStyle}>ผล</th><th style={thStyle}>ส่งเมื่อ</th><th style={thStyle}></th></tr></thead>
          <tbody>
            {report.attempts.map(a => (
              <tr key={a.id}>
                <td style={tdStyle}>{a.user_name}<div style={mutedText}>{a.user_email}</div></td>
                <td style={tdStyle}>{a.attempt_no}</td>
                <td style={tdStyle}>{a.score ?? "-"}/{a.max_score ?? "-"} ({a.percent ?? "-"}%)</td>
                <td style={tdStyle}>{a.passed === null ? "รอตรวจ" : a.passed ? "ผ่าน" : "ไม่ผ่าน"}{a.auto_closed ? <div style={mutedText}>หมดเวลา</div> : null}</td>
                <td style={tdStyle}>{formatWhen(a.submitted_at)}</td>
                <td style={tdStyle}><button className="tech-button-outline" style={smallButton} onClick={() => setViewing(a.id)}>ดู/ให้คะแนน</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {viewing && (
        <Modal title="รายละเอียดการทำข้อสอบ" onClose={() => setViewing(null)} width={820}>
          <AttemptGrader attemptId={viewing} onGraded={() => { setViewing(null); setVersion(v => v + 1); }} />
        </Modal>
      )}
    </div>
  );
};

interface GradebookData {
  exams: { id: string; title: string; is_final: boolean; pass_percent: number }[];
  assignments: { id: string; title: string; max_score: number }[];
  quiz_total: number;
  video_question_total: number;
  rows: {
    user_id: string; name: string; email: string; progress_percent: number;
    exams: Record<string, { attempts: number; best_percent: number | null; passed: boolean | null; pending: boolean }>;
    assignments: Record<string, { status: string; final_score: number | null; is_late: boolean }>;
    quiz: { answered: number; correct: number };
    video: { answered: number; correct: number };
  }[];
}

/** Gradebook per course: all learners (instructor) or the learner's own row (`learner`). */
export const Gradebook: React.FC<{ courseId: string; learner?: boolean }> = ({ courseId, learner }) => {
  const api = useApi();
  const [data, setData] = useState<GradebookData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.request<GradebookData>(`/${learner ? "student" : "instructor"}/courses/${courseId}/gradebook`).then(setData).catch(err => setError(err.message));
  }, [api.request, courseId, learner]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Empty text="กำลังโหลด..." />;
  if (!data.rows.length) return <Empty text="ยังไม่มีผู้เรียน" />;
  const examCell = (r: GradebookData["rows"][number], id: string) => {
    const e = r.exams[id];
    if (!e) return "-";
    if (e.best_percent === null) return e.pending ? "รอตรวจ" : "-";
    return `${e.best_percent}% ${e.passed ? "✓" : ""}${e.pending ? " (มีรอตรวจ)" : ""}`;
  };
  const asgCell = (r: GradebookData["rows"][number], a: GradebookData["assignments"][number]) => {
    const s = r.assignments[a.id];
    if (!s) return "ยังไม่ส่ง";
    if (s.status === "graded") return `${s.final_score}/${a.max_score}${s.is_late ? " (ช้า)" : ""}`;
    return s.status === "returned" ? "ส่งกลับแก้ไข" : "รอตรวจ";
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            {!learner && <th style={thStyle}>ผู้เรียน</th>}
            <th style={thStyle}>ความคืบหน้า</th>
            {data.exams.map(e => <th key={e.id} style={thStyle}>{e.title}{e.is_final ? " (ปลายภาค)" : ""}</th>)}
            {data.assignments.map(a => <th key={a.id} style={thStyle}>งาน: {a.title}</th>)}
            <th style={thStyle}>แบบทดสอบบทเรียน</th>
            <th style={thStyle}>คำถามในวิดีโอ</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map(r => (
            <tr key={r.user_id}>
              {!learner && <td style={tdStyle}>{r.name}<div style={mutedText}>{r.email}</div></td>}
              <td style={tdStyle}>{r.progress_percent ?? 0}%</td>
              {data.exams.map(e => <td key={e.id} style={tdStyle}>{examCell(r, e.id)}</td>)}
              {data.assignments.map(a => <td key={a.id} style={tdStyle}>{asgCell(r, a)}</td>)}
              <td style={tdStyle}>{r.quiz.correct}/{data.quiz_total}</td>
              <td style={tdStyle}>{r.video.correct}/{data.video_question_total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default ExamReport;
