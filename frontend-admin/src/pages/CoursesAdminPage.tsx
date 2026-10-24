import React, { useEffect, useState } from "react";
import { BookOpen, Search, CheckCircle2, Undo2, Archive, Eye, RefreshCw } from "lucide-react";
import { can, useApi } from "../hooks/useApi";
import { Chip, Modal, Field, ErrorBox, Empty, tableStyle, thStyle, tdStyle, formatDateTime, formatBaht } from "../components/site-admin/ui";

export type CourseStatus = "draft" | "review" | "published" | "archived";

/** Labels and colors shared with the instructor console. */
export const COURSE_STATUS: Record<CourseStatus, { label: string; color: string; bg: string }> = {
  draft: { label: "ฉบับร่าง", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" },
  review: { label: "รอตรวจ", color: "#9a5b00", bg: "rgba(245,158,11,0.14)" },
  published: { label: "เผยแพร่แล้ว", color: "var(--accent)", bg: "var(--accent-glow)" },
  archived: { label: "เก็บเข้าคลัง", color: "#b42318", bg: "rgba(239,68,68,0.1)" }
};

interface AdminCourse {
  id: string; title: string; description: string | null; price: number; status: CourseStatus;
  created_at: string; submitted_at: string | null; published_at: string | null; review_note: string | null;
  instructor_id: string; instructor_name: string | null; instructor_email: string | null;
  lesson_count: number; enrollment_count: number;
}
interface CourseList { courses: AdminCourse[]; instructors: Array<{ id: string; name: string }>; counts: Partial<Record<CourseStatus, number>> }
interface Preview {
  course: AdminCourse & { cover_image_url?: string | null; access_duration_days?: number | null };
  lessons: Array<{ id: string; title: string; video_provider: string; video_stream_uid: string | null; handout_r2_key: string | null; sort_order: number }>;
}

/** Course review queue and catalog control for holders of courses.approve (admins included). */
export const CoursesAdminPage: React.FC = () => {
  const api = useApi();
  const [data, setData] = useState<CourseList | null>(null);
  const [status, setStatus] = useState<CourseStatus | "">("");
  const [instructorId, setInstructorId] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sendBack, setSendBack] = useState<AdminCourse | null>(null);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);

  const load = async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (instructorId) params.set("instructor_id", instructorId);
    if (query.trim()) params.set("q", query.trim());
    try {
      setError(null);
      setData(await api.get<CourseList>(`/admin/courses?${params}`));
    } catch (err: any) {
      setError(err.message);
    }
  };
  useEffect(() => { load(); }, [api.token, status, instructorId]);

  const act = async (course: AdminCourse, action: "approve" | "archive" | "send-back", body: unknown = {}) => {
    if (action === "archive" && !window.confirm(`นำคอร์ส "${course.title}" ออกจากแคตตาล็อก? ผู้เรียนที่ลงทะเบียนแล้วยังเรียนต่อได้`)) return;
    try {
      setBusy(course.id);
      setError(null);
      await api.post(`/admin/courses/${course.id}/${action}`, body);
      setSendBack(null);
      setNote("");
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const openPreview = async (course: AdminCourse) => {
    try {
      setPreview(await api.get<Preview>(`/courses/${course.id}`));
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (!can(api.user, "courses.approve")) {
    return <ErrorBox message="บัญชีของคุณไม่มีสิทธิ์ตรวจและเผยแพร่คอร์ส" />;
  }

  const counts = data?.counts || {};
  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">ตรวจและเผยแพร่คอร์ส</h1>
          <p className="header-desc">คอร์สใหม่ของผู้สอนเป็นฉบับร่างจนกว่าจะส่งตรวจและได้รับอนุมัติ เฉพาะคอร์สที่เผยแพร่แล้วจึงแสดงในแคตตาล็อกและเปิดรับลงทะเบียน</p>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <button onClick={() => setStatus("")} className={status === "" ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "8px 14px", fontSize: 13 }}>
          ทั้งหมด
        </button>
        {(Object.keys(COURSE_STATUS) as CourseStatus[]).map(key => (
          <button key={key} onClick={() => setStatus(key)} className={status === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "8px 14px", fontSize: 13 }}>
            {COURSE_STATUS[key].label} ({counts[key] || 0})
          </button>
        ))}
      </div>

      <form onSubmit={e => { e.preventDefault(); load(); }} style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <div style={{ position: "relative", flex: "1 1 240px" }}>
          <Search size={16} style={{ position: "absolute", left: 12, top: 12, color: "var(--text-muted)" }} />
          <input className="form-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="ค้นหาชื่อหรือคำอธิบายคอร์ส" style={{ paddingLeft: 36 }} />
        </div>
        <select className="form-input" value={instructorId} onChange={e => setInstructorId(e.target.value)} style={{ flex: "0 1 220px" }} aria-label="ผู้สอน">
          <option value="">ผู้สอนทุกคน</option>
          {data?.instructors.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <button type="submit" className="tech-button-outline" style={{ padding: "8px 14px", fontSize: 13 }}><RefreshCw size={14} />ค้นหา</button>
      </form>

      <ErrorBox message={error} />

      <div className="glass-card" style={{ padding: 0, overflowX: "auto" }}>
        {!data ? <Empty text="กำลังโหลด..." /> : data.courses.length === 0 ? <Empty text="ไม่พบคอร์สตามเงื่อนไข" /> : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>คอร์ส</th>
                <th style={thStyle}>ผู้สอน</th>
                <th style={thStyle}>สถานะ</th>
                <th style={thStyle}>บทเรียน / ผู้เรียน</th>
                <th style={thStyle}>ส่งตรวจ / เผยแพร่</th>
                <th style={{ ...thStyle, textAlign: "right" }}>การดำเนินการ</th>
              </tr>
            </thead>
            <tbody>
              {data.courses.map(course => (
                <tr key={course.id}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{course.title}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{formatBaht(Number(course.price) || 0)} • {course.id}</div>
                    {course.review_note && (
                      <div style={{ fontSize: 12, color: "#9a5b00", marginTop: 4 }}>หมายเหตุที่ส่งกลับ: {course.review_note}</div>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <div>{course.instructor_name || "-"}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{course.instructor_email}</div>
                  </td>
                  <td style={tdStyle}><Chip {...COURSE_STATUS[course.status]} /></td>
                  <td style={tdStyle}>{course.lesson_count} บท / {course.enrollment_count} คน</td>
                  <td style={{ ...tdStyle, fontSize: 12, color: "var(--text-secondary)" }}>
                    <div>{course.submitted_at ? formatDateTime(course.submitted_at) : "-"}</div>
                    <div>{course.published_at ? formatDateTime(course.published_at) : "-"}</div>
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                    <div style={{ display: "inline-flex", gap: 6 }}>
                      <button onClick={() => openPreview(course)} className="tech-button-outline" style={{ padding: "6px 10px", fontSize: 12 }}><Eye size={14} />ดูตัวอย่าง</button>
                      {course.status !== "published" && (
                        <button disabled={busy === course.id} onClick={() => act(course, "approve")} className="tech-button-primary" style={{ padding: "6px 10px", fontSize: 12 }}>
                          <CheckCircle2 size={14} />{course.status === "archived" ? "เผยแพร่อีกครั้ง" : "อนุมัติและเผยแพร่"}
                        </button>
                      )}
                      {course.status !== "draft" && (
                        <button disabled={busy === course.id} onClick={() => { setSendBack(course); setNote(""); }} className="tech-button-outline" style={{ padding: "6px 10px", fontSize: 12 }}>
                          <Undo2 size={14} />ส่งกลับแก้ไข
                        </button>
                      )}
                      {course.status !== "archived" && (
                        <button disabled={busy === course.id} onClick={() => act(course, "archive")} className="tech-button-outline" style={{ padding: "6px 10px", fontSize: 12, color: "var(--danger)" }}>
                          <Archive size={14} />เก็บเข้าคลัง
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {sendBack && (
        <Modal title={`ส่งกลับให้แก้ไข: ${sendBack.title}`} onClose={() => setSendBack(null)} width={560}>
          <form onSubmit={e => { e.preventDefault(); act(sendBack, "send-back", { note }); }}>
            <Field label="สิ่งที่ผู้สอนต้องแก้ไข" hint="ผู้สอนจะเห็นข้อความนี้ในคอนโซลผู้สอนและได้รับการแจ้งเตือน">
              <textarea className="form-input" rows={4} value={note} onChange={e => setNote(e.target.value)} required maxLength={2000} />
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setSendBack(null)} className="tech-button-outline">ยกเลิก</button>
              <button type="submit" disabled={!note.trim() || busy === sendBack.id} className="tech-button-primary">ส่งกลับ</button>
            </div>
          </form>
        </Modal>
      )}

      {preview && (
        <Modal title={preview.course.title} onClose={() => setPreview(null)} width={720}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <Chip {...COURSE_STATUS[preview.course.status]} />
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {formatBaht(Number(preview.course.price) || 0)}
              {preview.course.access_duration_days ? ` • เข้าเรียนได้ ${preview.course.access_duration_days} วัน` : " • เข้าเรียนได้ไม่จำกัด"}
            </span>
          </div>
          {preview.course.cover_image_url && (
            <img src={preview.course.cover_image_url} alt="" style={{ width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: 12, marginBottom: 12 }} />
          )}
          <p style={{ fontSize: 14, color: "var(--text-secondary)", whiteSpace: "pre-wrap", marginBottom: 16 }}>{preview.course.description}</p>
          <h3 style={{ fontSize: 15, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}><BookOpen size={16} />บทเรียน ({preview.lessons.length})</h3>
          {preview.lessons.length === 0 ? <Empty text="ยังไม่มีบทเรียน" /> : (
            <table style={tableStyle}>
              <tbody>
                {preview.lessons.map(lesson => (
                  <tr key={lesson.id}>
                    <td style={tdStyle}>{lesson.sort_order}. {lesson.title}</td>
                    <td style={{ ...tdStyle, fontSize: 12, color: "var(--text-muted)" }}>
                      {lesson.video_provider}{lesson.video_stream_uid ? "" : " (ยังไม่มีวิดีโอ)"}{lesson.handout_r2_key ? " • มีเอกสาร" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  );
};
