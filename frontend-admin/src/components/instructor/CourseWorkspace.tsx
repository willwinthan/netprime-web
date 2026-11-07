import React, { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Circle, Send, Trash2 } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip } from "../site-admin/ui";
import { COURSE_STATUS } from "../../pages/CoursesAdminPage";
import { CourseDetailsForms } from "../course/CourseBuilder";
import type { CourseOutline } from "../course/types";
import { CourseAssessments } from "../assessment/CourseAssessments";
import { CourseLiveClassesPanel } from "../settings/CourseLiveClasses";
import { CourseAnnouncements } from "../communication/CourseAnnouncements";
import { CourseBasicsForm } from "./CourseBasicsForm";
import { CourseLearnersPanel } from "./CourseLearnersPanel";
import { InstructorCourse, WORKSPACE_TABS, WorkspaceTab } from "./types";
import "../course/course.css";

interface Props {
  course: InstructorCourse;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  onBack: () => void;
  onSubmitForReview: () => void;
  onDelete: () => void;
  /** Reload the console's course list (title, status, counts changed). */
  onCourseChanged: () => void;
  busy?: boolean;
  /** The "เนื้อหา" tab: CourseBuilder wired to the console's video and quiz forms. */
  content: React.ReactNode;
  /** AI tools button for this course. */
  aiTools?: React.ReactNode;
  /** Changes when lessons change, so the checklist reloads. */
  lessonsVersion?: unknown;
}

interface CheckItem { label: string; done: boolean; required?: boolean; tab: WorkspaceTab; hint: string }

function checklist(course: InstructorCourse, outline: CourseOutline | null): CheckItem[] {
  const c = outline?.course;
  return [
    { label: "มีบทเรียนอย่างน้อย 1 บท", done: (outline?.lessons.length ?? 0) > 0, required: true, tab: "content", hint: "เพิ่มบทเรียนในแท็บเนื้อหา" },
    { label: "คำอธิบายคอร์สละเอียดพอ", done: (course.description ?? "").trim().length >= 50, tab: "details", hint: "อย่างน้อย 50 ตัวอักษร บอกว่าเรียนอะไรและเหมาะกับใคร" },
    { label: "มีคำโปรยใต้ชื่อคอร์ส", done: !!c?.subtitle?.trim(), tab: "details", hint: "ประโยคสั้น ๆ ในหน้าขายคอร์ส" },
    { label: "ระบุสิ่งที่ผู้เรียนจะได้", done: (c?.learning_outcomes.filter(Boolean).length ?? 0) > 0, tab: "details", hint: "อย่างน้อย 1 ข้อในหน้าขายคอร์ส" },
    { label: "เลือกหมวดหมู่คอร์ส", done: !!c?.category_id, tab: "details", hint: "ช่วยให้ผู้เรียนหาคอร์สเจอ" }
  ];
}

const STATUS_MESSAGE: Record<string, string> = {
  draft: "ฉบับร่างยังไม่แสดงบนเว็บไซต์ เตรียมเนื้อหาให้ครบแล้วกด \"ส่งตรวจ\"",
  review: "รอผู้ตรวจอนุมัติ ระหว่างนี้ยังแก้ไขเนื้อหาได้",
  published: "คอร์สแสดงบนเว็บไซต์แล้ว",
  archived: "คอร์สถูกเก็บเข้าคลัง ไม่แสดงบนเว็บไซต์และรับผู้เรียนใหม่ไม่ได้"
};

/**
 * One course, everything in one place: overview with a pre-review checklist, content, course details
 * (basics + sales page + conditions), assessments, learners, announcements and live classes.
 * The console keeps the active tab in the URL so Back and refresh work.
 */
export const CourseWorkspace: React.FC<Props> = ({ course, tab, onTabChange, onBack, onSubmitForReview, onDelete, onCourseChanged, busy, content, aiTools, lessonsVersion }) => {
  const api = useApi();
  const [outline, setOutline] = useState<CourseOutline | null>(null);
  const [outlineVersion, setOutlineVersion] = useState(0);

  // The checklist needs the outline; reload it when the overview is shown or lessons/details changed.
  useEffect(() => {
    if (tab !== "overview") return;
    api.get<CourseOutline>(`/instructor/courses/${course.id}/outline`).then(setOutline).catch(() => setOutline(null));
  }, [course.id, tab, lessonsVersion, outlineVersion, api.token]);

  const items = checklist(course, outline);
  const missingRequired = !!outline && items.some(i => i.required && !i.done);
  const status = COURSE_STATUS[course.status];

  return (
    <div className="glass-card animate-fade-in" style={{ padding: "28px 32px", border: "1px solid var(--border-subtle)", borderRadius: "1.5rem" }}>
      <button type="button" onClick={onBack}
        style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "14px", fontWeight: 600, marginBottom: "18px", padding: 0, fontFamily: "inherit" }}>
        <ArrowLeft size={16} /> คอร์สทั้งหมด
      </button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap", marginBottom: "18px" }}>
        <div style={{ display: "flex", gap: "16px", alignItems: "center", minWidth: 0 }}>
          {course.thumbnail_url && <img src={course.thumbnail_url} alt="" style={{ width: 72, height: 54, borderRadius: "0.6rem", objectFit: "cover", border: "1px solid var(--border-subtle)", flexShrink: 0 }} />}
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: "22px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              {course.title} {status && <Chip {...status} />}
            </h2>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>
              ผู้เรียน {course.student_count} คน{course.avg_progress !== null ? ` • ความคืบหน้าเฉลี่ย ${Math.round(course.avg_progress)}%` : ""}
            </p>
          </div>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          {aiTools}
          {course.status === "draft" && (
            <button type="button" className="tech-button-primary" onClick={onSubmitForReview} disabled={busy || missingRequired}
              title={missingRequired ? "เพิ่มบทเรียนอย่างน้อย 1 บทก่อนส่งตรวจ" : undefined}
              style={{ borderRadius: "1rem", display: "flex", alignItems: "center", gap: "6px" }}>
              <Send size={15} /> ส่งตรวจ
            </button>
          )}
        </div>
      </div>

      <div className="np-cb-tabs" role="tablist" aria-label="ส่วนของคอร์ส">
        {WORKSPACE_TABS.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className="np-cb-tab" onClick={() => onTabChange(t.key)}>{t.label}</button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === "overview" && (
          <div style={{ display: "grid", gap: "20px" }}>
            {course.status === "draft" && course.review_note && (
              <div role="note" style={{ fontSize: "14px", color: "#9a5b00", background: "rgba(245,158,11,0.1)", borderRadius: "0.9rem", padding: "12px 14px" }}>
                <strong>ผู้ตรวจส่งกลับให้แก้ไข:</strong> {course.review_note}
              </div>
            )}
            <p style={{ fontSize: "14px", color: "var(--text-secondary)" }}>
              {STATUS_MESSAGE[course.status]}
              {course.status === "review" && course.submitted_at && ` (ส่งเมื่อ ${new Date(course.submitted_at).toLocaleDateString("th-TH")})`}
            </p>

            <section>
              <h4 className="np-ws-subhead">ความพร้อมของคอร์ส</h4>
              <p className="np-ws-subdesc">ข้อที่มีป้าย "จำเป็น" ต้องทำก่อนส่งตรวจ ข้ออื่นช่วยให้คอร์สน่าสนใจขึ้น</p>
              {!outline ? <p style={{ fontSize: 13, color: "var(--text-muted)" }}>กำลังตรวจ...</p> : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "8px" }}>
                  {items.map(item => (
                    <li key={item.label} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 14px", border: "1px solid var(--border-subtle)", borderRadius: "0.9rem", background: "#fff" }}>
                      {item.done ? <CheckCircle2 size={20} color="var(--accent)" aria-label="ทำแล้ว" /> : <Circle size={20} color={item.required ? "var(--danger)" : "var(--text-muted)"} aria-label="ยังไม่ได้ทำ" />}
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>{item.label}</span>
                        {item.required && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: item.done ? "var(--text-muted)" : "var(--danger)" }}>จำเป็น</span>}
                        {!item.done && <span style={{ display: "block", fontSize: "12px", color: "var(--text-muted)", marginTop: 2 }}>{item.hint}</span>}
                      </span>
                      {!item.done && <button type="button" className="np-cb-btn" onClick={() => onTabChange(item.tab)}>ไปแก้</button>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "18px" }}>
              <h4 className="np-ws-subhead" style={{ color: "var(--danger)" }}>ลบคอร์ส</h4>
              <p className="np-ws-subdesc">คอร์สที่มีผู้เรียนหรือคำสั่งซื้อจะถูกเก็บเข้าคลังแทนการลบ ระบบส่งรหัสยืนยันทางอีเมลก่อนลบ</p>
              <button type="button" className="tech-button-outline" onClick={onDelete} disabled={busy}
                style={{ borderRadius: "1rem", color: "var(--danger)", borderColor: "rgba(239, 68, 68, 0.3)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Trash2 size={15} /> ลบคอร์สนี้
              </button>
            </section>
          </div>
        )}

        {tab === "content" && content}

        {tab === "details" && (
          <div style={{ display: "grid", gap: "28px" }}>
            <section>
              <h4 className="np-ws-subhead">ข้อมูลพื้นฐาน</h4>
              <p className="np-ws-subdesc">ชื่อ คำอธิบาย รูป ราคา และระยะเวลาเรียน</p>
              <CourseBasicsForm course={course} onSaved={() => { onCourseChanged(); setOutlineVersion(v => v + 1); }} />
            </section>
            <CourseDetailsForms courseId={course.id} onSaved={() => setOutlineVersion(v => v + 1)} />
          </div>
        )}

        {tab === "assessments" && <CourseAssessments courseId={course.id} />}

        {tab === "learners" && <CourseLearnersPanel courseId={course.id} accessDurationDays={course.access_duration_days} onChanged={onCourseChanged} />}

        {tab === "communication" && (
          <div style={{ display: "grid", gap: "24px" }}>
            <CourseAnnouncements courseId={course.id} />
            <CourseLiveClassesPanel courseId={course.id} />
          </div>
        )}
      </div>
    </div>
  );
};
