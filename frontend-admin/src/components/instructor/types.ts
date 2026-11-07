import type { CourseStatus } from "../../pages/CoursesAdminPage";

/** A course as the instructor console lists it (GET /instructor/analytics › courses). */
export interface InstructorCourse {
  id: string;
  title: string;
  description: string;
  thumbnail_url: string;
  cover_image_url?: string | null;
  access_duration_days?: number | null;
  price?: number;
  created_at: string;
  student_count: number;
  avg_progress: number | null;
  status: CourseStatus;
  submitted_at?: string | null;
  published_at?: string | null;
  /** Reviewer's note when the course was sent back. */
  review_note?: string | null;
}

/** Tabs of the course workspace; the active one is kept in the URL (?course=<id>&tab=<tab>). */
export type WorkspaceTab = "overview" | "content" | "details" | "assessments" | "learners" | "communication";

export const WORKSPACE_TABS: { key: WorkspaceTab; label: string }[] = [
  { key: "overview", label: "ภาพรวม" },
  { key: "content", label: "เนื้อหา" },
  { key: "details", label: "ข้อมูลคอร์ส" },
  { key: "assessments", label: "การวัดผล" },
  { key: "learners", label: "ผู้เรียน" },
  { key: "communication", label: "ประกาศและคลาสสด" }
];

export const isWorkspaceTab = (value: string | null): value is WorkspaceTab =>
  WORKSPACE_TABS.some(tab => tab.key === value);
