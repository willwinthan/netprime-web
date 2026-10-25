import React, { useEffect, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { useApi, hasRole } from "../../hooks/useApi";
import { Empty, ErrorBox } from "../site-admin/ui";
import { QuestionBankPage } from "./QuestionBankPage";
import { ExamBuilder } from "./ExamBuilder";
import { AssignmentManager } from "./AssignmentPanel";
import { GradingQueue } from "./GradingQueue";
import { VideoQuestionsEditor } from "./VideoQuestionsEditor";
import { Gradebook } from "./ExamReport";
import { LessonRef, rowFlex } from "./types";

type Tab = "bank" | "exams" | "assignments" | "video" | "grading" | "gradebook";
const TABS: { key: Tab; label: string }[] = [
  { key: "bank", label: "คลังข้อสอบ" },
  { key: "exams", label: "ข้อสอบ" },
  { key: "assignments", label: "งานที่มอบหมาย" },
  { key: "video", label: "คำถามในวิดีโอ" },
  { key: "grading", label: "รอตรวจ" },
  { key: "gradebook", label: "สมุดคะแนน" }
];

const tabButton = (active: boolean): React.CSSProperties => ({
  padding: "6px 12px", borderRadius: "0.5rem", border: "none", cursor: "pointer", fontWeight: 600,
  background: active ? "var(--primary-glow)" : "none", color: active ? "var(--color-brand-primary)" : "var(--text-secondary)"
});

/** Instructor hub for one course's assessments; mounted in the curriculum view of InstructorConsole. */
export const CourseAssessments: React.FC<{ courseId: string }> = ({ courseId }) => {
  const api = useApi();
  const [tab, setTab] = useState<Tab>("exams");
  const [lessons, setLessons] = useState<LessonRef[]>([]);
  useEffect(() => {
    api.request<{ lessons?: LessonRef[] }>(`/courses/${courseId}`).then(res => setLessons(res.lessons ?? [])).catch(() => setLessons([]));
  }, [api.request, courseId]);

  return (
    <div className="glass-card" style={{ padding: "24px", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem", marginTop: "24px" }}>
      <h3 style={{ fontSize: "20px", display: "flex", alignItems: "center", gap: "8px", color: "var(--text-primary)", marginBottom: "12px" }}>
        <ClipboardCheck size={22} color="var(--primary)" /> การวัดผล
      </h3>
      <div style={{ ...rowFlex, borderBottom: "1px solid var(--border-subtle)", paddingBottom: "10px", marginBottom: "16px" }}>
        {TABS.map(t => <button key={t.key} style={tabButton(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>
      {tab === "bank" && <QuestionBankPage courseId={courseId} />}
      {tab === "exams" && <ExamBuilder courseId={courseId} lessons={lessons} />}
      {tab === "assignments" && <AssignmentManager courseId={courseId} lessons={lessons} />}
      {tab === "video" && <VideoQuestionsEditor lessons={lessons} />}
      {tab === "grading" && <GradingQueue courseId={courseId} />}
      {tab === "gradebook" && <Gradebook courseId={courseId} />}
    </div>
  );
};

/** Standalone console page: pick one of your courses, or see the grading queue of all of them. */
export const AssessmentsConsole: React.FC = () => {
  const api = useApi();
  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.request<{ courses: { id: string; title: string }[] }>("/instructor/analytics").then(res => {
      setCourses(res.courses);
    }).catch(err => setError(err.message));
  }, [api.request]);

  if (!hasRole(api.user, "instructor", "admin")) return <Empty text="หน้านี้สำหรับผู้สอนและผู้ดูแลระบบ" />;
  return (
    <div>
      <div style={{ ...rowFlex, marginBottom: "8px" }}>
        <h2 style={{ fontSize: "24px", color: "var(--text-primary)" }}>การวัดผลและสอบ</h2>
        <select className="form-input" style={{ width: "auto", minWidth: "260px" }} value={courseId} onChange={e => setCourseId(e.target.value)} aria-label="เลือกคอร์ส">
          <option value="">— งานรอตรวจทุกคอร์ส —</option>
          {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
      </div>
      <ErrorBox message={error} />
      {courseId ? <CourseAssessments key={courseId} courseId={courseId} /> : (
        <div className="glass-card" style={{ padding: "24px", borderRadius: "1.5rem", marginTop: "16px" }}>
          <GradingQueue />
        </div>
      )}
    </div>
  );
};

export default CourseAssessments;
