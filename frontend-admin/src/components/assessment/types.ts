import React from "react";

// Shapes returned by backend/src/handlers/assessments.ts.

export type QuestionType = "single" | "multiple" | "true_false" | "short" | "fill_blank" | "matching" | "ordering" | "essay";
export type Difficulty = "easy" | "medium" | "hard";

export interface BankQuestion {
  id: string;
  course_id: string;
  type: QuestionType;
  prompt: string;
  /** Choices, matching pairs {left,right} or ordering items in the correct order. */
  options: string[] | { left: string[]; right: string[] } | null;
  /** Option indexes, accepted texts or per-blank accepted texts. */
  correct: number[] | string[] | string[][] | null;
  explanation: string | null;
  points: number;
  tags: string[];
  difficulty: Difficulty;
}

export interface DrawRule { tag?: string | null; difficulty?: string | null; count: number }

export interface Exam {
  id: string;
  course_id: string;
  lesson_id: string | null;
  lesson_title?: string | null;
  title: string;
  description: string | null;
  is_final: boolean;
  selection_mode: "fixed" | "random";
  draw_rules: DrawRule[];
  shuffle_questions: boolean;
  shuffle_options: boolean;
  time_limit_minutes: number | null;
  max_attempts: number | null;
  pass_percent: number;
  show_answers: "never" | "after_submit" | "after_pass";
  available_from: string | null;
  available_until: string | null;
  status: "draft" | "published";
  question_count?: number;
  attempt_count?: number;
  pending_count?: number;
  question_ids?: string[];
}

export interface Option { id: number; text: string }

/** A question inside an attempt (answer key only after submit, when the exam policy allows). */
export interface AttemptQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  points: number;
  options?: Option[];
  left?: Option[];
  right?: Option[];
  blanks?: number;
  response: any;
  is_correct?: boolean | null;
  points_awarded?: number | null;
  feedback?: string | null;
  correct_answer?: any;
  explanation?: string | null;
}

export interface Attempt {
  id: string;
  exam_id: string;
  exam_title: string;
  attempt_no: number;
  status: "in_progress" | "pending_grading" | "graded";
  started_at: string;
  deadline_at: string | null;
  submitted_at: string | null;
  auto_closed: boolean;
  score: number | null;
  max_score: number | null;
  percent: number | null;
  passed: boolean | null;
  pass_percent: number;
  feedback: string | null;
  answers_revealed: boolean;
  questions: AttemptQuestion[];
  user_name?: string;
  user_email?: string;
}

export interface Criterion { criterion: string; max_points: number }

export interface Assignment {
  id: string;
  course_id: string;
  lesson_id: string;
  lesson_title?: string;
  title: string;
  instructions: string | null;
  max_score: number;
  due_at: string | null;
  late_policy: "accept" | "penalty" | "reject";
  late_penalty_percent: number;
  allow_text: boolean;
  allow_files: boolean;
  rubric: Criterion[];
  status: "draft" | "published";
  submission_count?: number;
  pending_count?: number;
}

export interface Submission {
  id: string;
  assignment_id: string;
  user_id: string;
  user_name?: string;
  user_email?: string;
  version: number;
  text_content: string | null;
  files: { name: string; size: number; content_type: string }[];
  status: "submitted" | "graded" | "returned";
  is_late: boolean;
  submitted_at: string;
  score: number | null;
  final_score: number | null;
  rubric_scores: number[] | null;
  feedback: string | null;
}

export interface LessonRef { id: string; title: string; sort_order?: number; video_provider?: string }

export const TYPE_LABEL: Record<QuestionType, string> = {
  single: "ตัวเลือกเดียว",
  multiple: "หลายตัวเลือก",
  true_false: "ถูก/ผิด",
  short: "คำตอบสั้น",
  fill_blank: "เติมคำในช่องว่าง",
  matching: "จับคู่",
  ordering: "เรียงลำดับ",
  essay: "อัตนัย (ตรวจเอง)"
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: "ง่าย", medium: "ปานกลาง", hard: "ยาก" };

export const SHOW_ANSWERS_LABEL: Record<Exam["show_answers"], string> = {
  never: "ไม่แสดงเฉลย",
  after_submit: "แสดงเฉลยหลังส่ง",
  after_pass: "แสดงเฉลยเมื่อสอบผ่าน"
};

export const LATE_POLICY_LABEL: Record<Assignment["late_policy"], string> = {
  accept: "รับงานส่งช้า",
  penalty: "รับแต่หักคะแนน",
  reject: "ไม่รับงานส่งช้า"
};

export const SUBMISSION_STATUS: Record<Submission["status"], { label: string; color: string; bg: string }> = {
  submitted: { label: "รอตรวจ", color: "var(--primary)", bg: "var(--primary-glow)" },
  returned: { label: "ส่งกลับให้แก้ไข", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  graded: { label: "ตรวจแล้ว", color: "var(--accent)", bg: "var(--accent-glow)" }
};

/** ISO → value for <input type="datetime-local"> in local time. */
export function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (value: string) => value ? new Date(value).toISOString() : null;

export const formatWhen = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "-";

export const cardStyle: React.CSSProperties = {
  padding: "16px 20px", background: "rgba(255,255,255,0.5)", border: "1px solid var(--border-subtle)", borderRadius: "1rem"
};
export const smallButton: React.CSSProperties = { padding: "6px 12px", fontSize: "12px", borderRadius: "0.75rem" };
export const rowFlex: React.CSSProperties = { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" };
export const mutedText: React.CSSProperties = { fontSize: "12px", color: "var(--text-muted)" };
