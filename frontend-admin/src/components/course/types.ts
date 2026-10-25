// Shared types and labels for the course builder (instructor) and the learner player.

export type LessonType = "video" | "text" | "pdf" | "embed" | "scorm";

export const LESSON_TYPE_LABEL: Record<LessonType, string> = {
  video: "วิดีโอ",
  text: "บทความ",
  pdf: "เอกสาร PDF",
  embed: "ฝังเนื้อหา",
  scorm: "SCORM"
};

export const LEVEL_LABEL: Record<string, string> = {
  beginner: "เริ่มต้น",
  intermediate: "ปานกลาง",
  advanced: "ขั้นสูง",
  all: "ทุกระดับ"
};

export interface CourseSection { id: string; title: string; sort_order: number }

/** Lesson as the builder sees it (GET /instructor/courses/:id/outline). */
export interface BuilderLesson {
  id: string;
  title: string;
  type: LessonType;
  section_id: string | null;
  sort_order: number;
  video_stream_uid: string | null;
  video_provider: string | null;
  handout_r2_key: string | null;
  pdf_r2_key: string | null;
  embed_url: string | null;
  scorm_launch: string | null;
  has_text: boolean;
  available_after_days: number | null;
  available_on: string | null;
}

export interface CourseDetails {
  id: string;
  title: string;
  status: string;
  category_id: string | null;
  subtitle: string | null;
  learning_outcomes: string[];
  requirements: string[];
  target_audience: string[];
  level: string | null;
  language: string | null;
  duration_hours: number | null;
  promo_video_url: string | null;
  faq: { question: string; answer: string }[];
  sequential: boolean;
}

export interface CourseOutline {
  course: CourseDetails;
  sections: CourseSection[];
  lessons: BuilderLesson[];
  prerequisites: { id: string; title: string }[];
  categories: { id: string; name: string; slug: string }[];
  prerequisite_options: { id: string; title: string; status: string }[];
  embed_providers: string;
}

/** Lesson as the learner player sees it (GET /courses/:id). */
export interface PlayerLesson {
  id: string;
  title: string;
  type?: LessonType;
  section_id?: string | null;
  sort_order: number;
  completed?: number;
  locked?: boolean;
  lock_reason?: "date" | "drip" | "sequence" | null;
  unlock_at?: string | null;
  available_after_days?: number | null;
  available_on?: string | null;
}

/** "จะเปิดเมื่อ …" text for a locked lesson. */
export function unlockText(lesson: Pick<PlayerLesson, "lock_reason" | "unlock_at">): string {
  if (lesson.lock_reason === "sequence") return "เรียนบทก่อนหน้าให้จบก่อน";
  if (!lesson.unlock_at) return "ยังไม่เปิดให้เรียน";
  const date = new Date(lesson.unlock_at);
  return `เปิดเรียน ${date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}`;
}
