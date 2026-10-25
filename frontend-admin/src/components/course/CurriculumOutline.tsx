import React from "react";
import { CheckCircle, FileText, Globe, Layers, Lock, PlayCircle, Package } from "lucide-react";
import { CourseSection, LESSON_TYPE_LABEL, PlayerLesson, unlockText } from "./types";
import "./course.css";

/**
 * Learner curriculum sidebar: lessons grouped by chapter with per-chapter progress, completion
 * ticks and lock state (drip / date / sequential) from GET /courses/:id.
 */
interface Props {
  lessons: PlayerLesson[];
  sections: CourseSection[];
  activeLessonId: string | null;
  enrolled: boolean;
  onSelect: (lesson: PlayerLesson) => void;
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  video: <PlayCircle size={10} />, text: <FileText size={10} />, pdf: <FileText size={10} />, embed: <Globe size={10} />, scorm: <Package size={10} />
};

export const CurriculumOutline: React.FC<Props> = ({ lessons, sections, activeLessonId, enrolled, onSelect }) => {
  const loose = lessons.filter(l => !l.section_id || !sections.some(s => s.id === l.section_id));
  const groups = [
    ...(loose.length ? [{ id: "", title: sections.length ? "บทนำ" : "", lessons: loose }] : []),
    ...sections.map(s => ({ id: s.id, title: s.title, lessons: lessons.filter(l => l.section_id === s.id) }))
  ];
  const numbers = new Map(lessons.map((l, i) => [l.id, i + 1]));

  return (
    <div>
      {groups.map(group => {
        const done = group.lessons.filter(l => l.completed).length;
        return (
          <div key={group.id || "loose"} className="np-outline-section">
            {group.title && (
              <>
                <div className="np-outline-head">
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}><Layers size={13} /> {group.title}</span>
                  {enrolled && <span className="np-outline-count">{done}/{group.lessons.length}</span>}
                </div>
                {enrolled && group.lessons.length > 0 && <div className="np-outline-bar"><div style={{ width: `${Math.round((done / group.lessons.length) * 100)}%` }} /></div>}
              </>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {group.lessons.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "4px 6px" }}>ยังไม่มีบทเรียนในบทนี้</div>}
              {group.lessons.map(lesson => {
                const isActive = activeLessonId === lesson.id;
                const locked = enrolled && !!lesson.locked;
                return (
                  <button key={lesson.id} type="button" onClick={() => enrolled && onSelect(lesson)} disabled={!enrolled}
                    title={locked ? unlockText(lesson) : undefined}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                      background: isActive ? "var(--primary-glow)" : "rgba(255, 255, 255, 0.3)",
                      border: `1px solid ${isActive ? "var(--primary)" : "var(--border-subtle)"}`, borderRadius: "1rem",
                      padding: "12px 16px", textAlign: "left", cursor: enrolled ? "pointer" : "not-allowed", opacity: locked ? 0.75 : 1,
                      transition: "var(--transition-fast)"
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: isActive ? "var(--primary)" : "var(--text-muted)" }}>
                        {String(numbers.get(lesson.id)).padStart(2, "0")}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ fontSize: 13, fontWeight: 600, color: isActive ? "var(--color-brand-primary)" : "var(--text-primary)" }}>{lesson.title}</p>
                        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
                          {TYPE_ICON[lesson.type ?? "video"]}
                          {LESSON_TYPE_LABEL[lesson.type ?? "video"]}
                          {locked && <> • {unlockText(lesson)}</>}
                        </p>
                      </div>
                    </div>
                    {lesson.completed ? <CheckCircle size={16} color="var(--accent)" style={{ flexShrink: 0 }} />
                      : !enrolled || locked ? <Lock size={14} color="var(--text-muted)" style={{ flexShrink: 0 }} />
                      : <PlayCircle size={16} color={isActive ? "var(--primary)" : "var(--text-secondary)"} style={{ flexShrink: 0 }} />}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};
