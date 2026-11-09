import React, { useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { VideoPlayer } from "../VideoPlayer";
import { LessonContentView } from "./LessonContentView";
import { LessonType } from "./types";
import { BankQuestion, Exam, TYPE_LABEL } from "../assessment/types";
import { Empty, ErrorBox } from "../site-admin/ui";

// ==========================================
// Course review (courses.approve): open each lesson and read the exams before publishing.
// Staff previews never record progress: the video heartbeat is dropped here and
// LessonContentView hides "mark as read" for staff who are not enrolled.
// ==========================================

interface StreamToken { lessonId: string; videoStreamUid: string; videoProvider?: string; signedUrl: string; isMock: boolean }

/** One lesson as the learner would see it (GET /lessons/:id/stream-token or /student/lessons/:id/content). */
export const ReviewLessonView: React.FC<{ lesson: { id: string; title: string; type?: LessonType; sort_order: number } }> = ({ lesson }) => {
  const api = useApi();
  const type = lesson.type ?? "video";
  const [video, setVideo] = useState<StreamToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVideo(null); setError(null);
    if (type !== "video") return;
    api.get<StreamToken>(`/lessons/${lesson.id}/stream-token`).then(setVideo).catch((err: Error) => setError(err.message));
  }, [lesson.id, type]);

  if (type !== "video") return <LessonContentView lesson={{ ...lesson, type }} onCompleted={() => undefined} />;
  if (error) return <ErrorBox message={error} />;
  if (!video) return <p style={{ fontSize: 13, color: "var(--text-muted)" }}>กำลังโหลดวิดีโอ…</p>;
  return (
    <VideoPlayer lessonId={lesson.id} lessonTitle={lesson.title} signedUrl={video.signedUrl} isMock={video.isMock}
      videoProvider={video.videoProvider} videoStreamUid={video.videoStreamUid} onHeartbeat={() => undefined} />
  );
};

interface ReviewExam extends Exam { questions: BankQuestion[] }
interface ReviewAssignment { id: string; title: string; instructions: string | null; max_score: number; due_at: string | null; status: "draft" | "published"; lesson_title: string }
interface ReviewData { requires_final_exam: boolean; bank_size: number; exams: ReviewExam[]; assignments: ReviewAssignment[] }

const box: React.CSSProperties = { border: "1px solid var(--border-subtle)", borderRadius: 12, padding: "12px 14px" };
const muted: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)" };

/** The answer key in words for the reviewer. */
function answerText(q: BankQuestion): string {
  const correct = q.correct;
  if (!Array.isArray(correct) || !correct.length) return q.type === "essay" ? "ผู้สอนตรวจเอง" : "-";
  if (q.type === "ordering" && Array.isArray(q.options)) return q.options.join(" → ");
  if (q.type === "matching" && q.options && !Array.isArray(q.options)) {
    const { left, right } = q.options;
    return left.map((l, i) => `${l} = ${right[Number((correct as unknown[])[i])] ?? right[i] ?? "?"}`).join(" · ");
  }
  // true_false is stored like a single choice over the options ["จริง", "เท็จ"].
  if ((q.type === "single" || q.type === "multiple" || q.type === "true_false") && Array.isArray(q.options)) {
    const options = q.options as string[];
    return (correct as unknown[]).map(i => (typeof i === "number" ? options[i] : String(i)) ?? String(i)).join(", ");
  }
  return (correct as unknown[]).map(v => (Array.isArray(v) ? v.join(" / ") : String(v))).join(" | ");
}

const QuestionRow: React.FC<{ q: BankQuestion; n: number }> = ({ q, n }) => (
  <li style={{ display: "grid", gap: 4 }}>
    <span style={{ fontSize: 14 }}><strong>{n}.</strong> {q.prompt} <span style={muted}>({TYPE_LABEL[q.type] ?? q.type} · {q.points} คะแนน)</span></span>
    {(q.type === "single" || q.type === "multiple") && Array.isArray(q.options) && (
      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "var(--text-secondary)" }}>
        {(q.options as string[]).map((o, i) => <li key={i}>{o}</li>)}
      </ul>
    )}
    <span style={{ fontSize: 13, color: "var(--accent)" }}>เฉลย: {answerText(q)}</span>
    {q.explanation && <span style={muted}>คำอธิบาย: {q.explanation}</span>}
  </li>
);

/** Exams with questions and answer keys, and assignments (GET /admin/courses/:id/assessments). */
export const ReviewAssessments: React.FC<{ courseId: string }> = ({ courseId }) => {
  const api = useApi();
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setError(null);
    api.get<ReviewData>(`/admin/courses/${courseId}/assessments`).then(setData).catch((err: Error) => setError(err.message));
  }, [courseId]);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <p style={muted}>กำลังโหลดข้อสอบ…</p>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <span style={muted}>
        คลังข้อสอบ {data.bank_size} ข้อ · {data.requires_final_exam ? "ต้องสอบผ่านข้อสอบปลายภาคก่อนรับใบประกาศ" : "ไม่บังคับสอบปลายภาคก่อนรับใบประกาศ"}
      </span>
      {data.exams.length === 0 ? <Empty text="ยังไม่มีข้อสอบ" /> : data.exams.map(exam => (
        <details key={exam.id} style={box}>
          <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 14 }}>
            {exam.is_final ? "ข้อสอบปลายภาค: " : ""}{exam.title}
            <span style={{ ...muted, fontWeight: 400 }}>
              {" "}· {exam.status === "published" ? "เผยแพร่" : "ฉบับร่าง"} · ผ่าน {exam.pass_percent}%
              {exam.time_limit_minutes ? ` · ${exam.time_limit_minutes} นาที` : ""}{exam.max_attempts ? ` · สอบได้ ${exam.max_attempts} ครั้ง` : ""}
              {exam.lesson_title ? ` · บท ${exam.lesson_title}` : ""}
            </span>
          </summary>
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {exam.selection_mode === "random" && (
              <span style={muted}>สุ่มข้อสอบจากคลัง: {exam.draw_rules.map(r => `${r.count} ข้อ${r.difficulty ? ` ระดับ ${r.difficulty}` : ""}${r.tag ? ` แท็ก ${r.tag}` : ""}`).join(", ") || "-"}</span>
            )}
            {exam.questions.length === 0
              ? exam.selection_mode === "random" ? null : <Empty text="ข้อสอบนี้ยังไม่มีคำถาม" />
              : <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 12 }}>{exam.questions.map((q, i) => <QuestionRow key={q.id} q={q} n={i + 1} />)}</ol>}
          </div>
        </details>
      ))}
      {data.assignments.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          <strong style={{ fontSize: 14 }}>งานที่มอบหมาย</strong>
          {data.assignments.map(a => (
            <div key={a.id} style={box}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{a.title} <span style={{ ...muted, fontWeight: 400 }}>· {a.status === "published" ? "เผยแพร่" : "ฉบับร่าง"} · {a.max_score} คะแนน · บท {a.lesson_title}</span></div>
              {a.instructions && <p style={{ margin: "6px 0 0", fontSize: 13, whiteSpace: "pre-wrap", color: "var(--text-secondary)" }}>{a.instructions}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
