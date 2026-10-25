import React, { useEffect, useState } from "react";
import { CheckCircle, ExternalLink, Lock } from "lucide-react";
import { API_BASE_URL, useApi } from "../../hooks/useApi";
import { BlockRenderer, parseDocument } from "../../site/BlockRenderer";
import { Markdown, parseMarkdown } from "../../site/Markdown";
import { LESSON_TYPE_LABEL, PlayerLesson, unlockText } from "./types";
import "./course.css";

/**
 * Learner player for non-video lessons (text, PDF, embed, SCORM) and the lock screen for any
 * locked lesson. Mounted in Dashboard's video tab instead of VideoPlayer for those lessons.
 */
interface Props {
  lesson: PlayerLesson;
  /** Called after the lesson became complete (mark as read or SCORM), with the new course progress. */
  onCompleted: (progressPercent: number | null) => void;
}

interface Content {
  completed: boolean;
  content_json: string | null;
  content_md: string | null;
  embed_src: string | null;
  has_pdf: boolean;
  has_scorm: boolean;
  preview: boolean;
}

const apiOrigin = (() => { try { return new URL(API_BASE_URL, window.location.href).origin; } catch { return ""; } })();

export const LessonContentView: React.FC<Props> = ({ lesson, onCompleted }) => {
  const api = useApi();
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [scormUrl, setScormUrl] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [completed, setCompleted] = useState(!!lesson.completed);

  useEffect(() => {
    setContent(null); setError(null); setPdfUrl(null); setScormUrl(null); setCompleted(!!lesson.completed);
    if (lesson.locked) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const data = await api.get<Content>(`/student/lessons/${lesson.id}/content`);
        if (cancelled) return;
        setContent(data);
        setCompleted(data.completed);
        if (data.has_pdf) {
          // Fetch with the Bearer token and show a blob URL: the file never has a shareable link.
          const response = await fetch(`${API_BASE_URL}/student/lessons/${lesson.id}/pdf`, { headers: api.token ? { Authorization: `Bearer ${api.token}` } : {} });
          if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "โหลดไฟล์ PDF ไม่สำเร็จ");
          objectUrl = URL.createObjectURL(await response.blob());
          if (!cancelled) setPdfUrl(objectUrl);
        }
        if (data.has_scorm) {
          const launch = await api.get<{ url: string }>(`/student/lessons/${lesson.id}/scorm/launch`);
          if (!cancelled) setScormUrl(launch.url);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [lesson.id, lesson.locked, api.token]);

  // The SCORM player page posts its status after each LMSCommit / LMSFinish.
  useEffect(() => {
    if (lesson.type !== "scorm") return;
    const listener = (event: MessageEvent) => {
      if (event.origin !== apiOrigin || event.data?.source !== "netprime-scorm" || event.data.lessonId !== lesson.id) return;
      if (event.data.completed && !completed) {
        setCompleted(true);
        onCompleted(typeof event.data.progress_percent === "number" ? event.data.progress_percent : null);
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [lesson.id, lesson.type, completed]);

  const markComplete = async () => {
    setMarking(true);
    try {
      const res = await api.post<{ progress_percent: number }>(`/student/lessons/${lesson.id}/complete`, {});
      setCompleted(true);
      onCompleted(res.progress_percent);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setMarking(false);
    }
  };

  if (lesson.locked) {
    return (
      <div style={{ background: "rgba(0,0,0,0.02)", border: "1px dashed var(--border-active)", padding: "40px 24px", borderRadius: "1.5rem", textAlign: "center", marginBottom: 24 }}>
        <Lock size={32} color="var(--secondary)" style={{ margin: "0 auto 14px" }} />
        <h3 style={{ color: "var(--text-primary)" }}>บทเรียนนี้ยังล็อกอยู่</h3>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", marginTop: 6 }}>{unlockText(lesson)}</p>
      </div>
    );
  }

  const blocks = content?.content_json ? parseDocument(content.content_json) : null;
  const canMark = lesson.type === "text" || lesson.type === "pdf" || lesson.type === "embed";

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <span className="np-cb-type">{LESSON_TYPE_LABEL[lesson.type ?? "text"]}</span>
        <h3 style={{ fontSize: 20, color: "var(--text-primary)", margin: 0 }}>{lesson.title}</h3>
        {content?.preview && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>(โหมดดูตัวอย่าง ไม่บันทึกความคืบหน้า)</span>}
      </div>
      {error && <div role="alert" style={{ color: "var(--danger)", fontSize: 14, marginBottom: 12 }}>{error}</div>}
      {!content && !error && <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>กำลังโหลดบทเรียน...</div>}

      {content && lesson.type === "text" && (
        <div className="np-lesson-prose glass-card" style={{ padding: 28, maxWidth: "none" }}>
          {blocks ? <BlockRenderer blocks={blocks} /> : content.content_md ? <Markdown blocks={parseMarkdown(content.content_md)} />
            : <p style={{ color: "var(--text-muted)" }}>บทเรียนนี้ยังไม่มีเนื้อหา</p>}
        </div>
      )}

      {content && lesson.type === "embed" && (content.embed_src ? (
        <iframe className="np-lesson-frame" src={content.embed_src} title={lesson.title} loading="lazy" referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation allow-forms"
          allow="fullscreen; autoplay; encrypted-media; picture-in-picture" allowFullScreen />
      ) : <p style={{ color: "var(--text-muted)" }}>ลิงก์ของบทเรียนนี้ฝังไม่ได้ กรุณาแจ้งผู้สอน</p>)}

      {content && lesson.type === "pdf" && (pdfUrl ? (
        <>
          <iframe className="np-lesson-frame tall" src={pdfUrl} title={lesson.title} />
          <button type="button" className="tech-button-outline" style={{ borderRadius: "1rem", marginTop: 10 }} onClick={() => window.open(pdfUrl, "_blank", "noopener")}>
            <ExternalLink size={14} /> เปิดเต็มหน้าจอ
          </button>
        </>
      ) : !error && <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>กำลังโหลดไฟล์ PDF...</div>)}

      {content && lesson.type === "scorm" && (scormUrl ? (
        <iframe className="np-lesson-frame tall" src={scormUrl} title={lesson.title} allow="fullscreen; autoplay" allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" />
      ) : !error && <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>{content.has_scorm ? "กำลังเปิดบทเรียน SCORM..." : "ผู้สอนยังไม่ได้อัปโหลดแพ็กเกจ SCORM"}</div>)}

      {content && !content.preview && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          {completed ? (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--accent)", fontWeight: 600, fontSize: 14 }}>
              <CheckCircle size={16} /> เรียนบทนี้แล้ว
            </span>
          ) : canMark ? (
            <button type="button" className="tech-button-primary" style={{ borderRadius: "1rem" }} disabled={marking} onClick={markComplete}>
              {marking ? "กำลังบันทึก..." : "ทำเครื่องหมายว่าเรียนแล้ว"}
            </button>
          ) : lesson.type === "scorm" && (
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>ระบบจะบันทึกว่าเรียนจบเมื่อทำบทเรียนในแพ็กเกจเสร็จ</span>
          )}
        </div>
      )}
    </div>
  );
};
