import React, { useEffect, useState } from "react";
import { Megaphone, Pin, Trash2, Send } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox, formatDateTime } from "../site-admin/ui";
import { RichTextEditor, SafeHtml } from "./RichTextEditor";

export interface Announcement {
  id: string; course_id: string; course_title?: string; title: string; body: string; body_html: string;
  pinned: number; created_at: string; author_name: string | null; recipient_count?: number;
}

/**
 * Announcements of one course: learners read them; the course instructor (or communication.manage) posts,
 * optionally by email too. Mounted on the learner course page; instructors can reuse it in their console.
 */
export const CourseAnnouncements: React.FC<{ courseId: string; compact?: boolean }> = ({ courseId, compact }) => {
  const api = useApi();
  const [items, setItems] = useState<Announcement[]>([]);
  const [canPost, setCanPost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = () => api.get<{ announcements: Announcement[]; can_post: boolean }>(`/communication/courses/${encodeURIComponent(courseId)}/announcements`)
    .then(d => { setItems(d.announcements); setCanPost(d.can_post); setError(null); })
    .catch(() => setItems([]));
  useEffect(() => { load(); }, [courseId, api.token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      await api.post(`/communication/courses/${encodeURIComponent(courseId)}/announcements`, { title, body, send_email: sendEmail, pinned });
      setTitle(""); setBody(""); setComposing(false); setPinned(false);
      await load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!window.confirm("ลบประกาศนี้?")) return;
    try {
      await api.request(`/communication/announcements/${id}`, { method: "DELETE" });
      await load();
    } catch (err: any) { setError(err.message); }
  };

  if (!items.length && !canPost) return null;
  const visible = expanded || !compact ? items : items.slice(0, 2);
  return (
    <section aria-labelledby={`ann-${courseId}`} style={{ border: "1px solid rgba(99,102,241,0.18)", background: "rgba(99,102,241,0.04)", borderRadius: "14px", padding: "16px", marginBottom: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: items.length || composing ? "10px" : 0 }}>
        <Megaphone size={16} color="var(--primary)" />
        <h3 id={`ann-${courseId}`} style={{ fontSize: "15px", margin: 0, flex: 1 }}>ประกาศจากผู้สอน</h3>
        {canPost && !composing && (
          <button type="button" className="tech-button-primary" onClick={() => setComposing(true)} style={{ padding: "4px 12px", fontSize: "12px", borderRadius: "99px" }}>เขียนประกาศ</button>
        )}
      </div>
      <ErrorBox message={error} />
      {composing && (
        <form onSubmit={submit} style={{ display: "grid", gap: "10px", marginBottom: "14px" }}>
          <input className="form-input" aria-label="หัวข้อประกาศ" placeholder="หัวข้อประกาศ" value={title} maxLength={200} onChange={e => setTitle(e.target.value)} required />
          <RichTextEditor value={body} onChange={setBody} rows={5} placeholder="รายละเอียด (รองรับ **ตัวหนา**, *ตัวเอียง*, ลิงก์ และรายการ)" />
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", fontSize: "13px" }}>
            <label style={{ display: "flex", gap: "6px", alignItems: "center" }}><input type="checkbox" checked={sendEmail} onChange={e => setSendEmail(e.target.checked)} />ส่งอีเมลถึงผู้เรียนด้วย</label>
            <label style={{ display: "flex", gap: "6px", alignItems: "center" }}><input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} />ปักหมุด</label>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="submit" className="tech-button-primary" disabled={busy || !title.trim() || !body.trim()} style={{ padding: "6px 16px", display: "inline-flex", gap: "6px", alignItems: "center" }}>
              <Send size={14} />{busy ? "กำลังประกาศ…" : "ประกาศ"}
            </button>
            <button type="button" className="tech-button-outline" onClick={() => setComposing(false)} style={{ padding: "6px 16px" }}>ยกเลิก</button>
          </div>
        </form>
      )}
      {visible.map(a => (
        <article key={a.id} style={{ background: "#fff", borderRadius: "10px", padding: "12px 14px", marginBottom: "8px", border: "1px solid rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {a.pinned ? <Pin size={13} color="var(--warning)" aria-label="ปักหมุด" /> : null}
            <strong style={{ fontSize: "14px", flex: 1 }}>{a.title}</strong>
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{a.author_name ?? ""} • {formatDateTime(a.created_at)}</span>
            {canPost && <button type="button" onClick={() => remove(a.id)} aria-label="ลบประกาศ" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)" }}><Trash2 size={14} /></button>}
          </div>
          <SafeHtml html={a.body_html} style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "6px" }} />
        </article>
      ))}
      {compact && items.length > 2 && (
        <button type="button" onClick={() => setExpanded(x => !x)} style={{ background: "none", border: "none", color: "var(--primary)", cursor: "pointer", fontSize: "12px" }}>
          {expanded ? "ย่อ" : `ดูทั้งหมด (${items.length})`}
        </button>
      )}
    </section>
  );
};

/** Latest announcements across the learner's courses (dashboard home). */
export const MyAnnouncements: React.FC<{ onOpenCourse?: (courseId: string) => void }> = ({ onOpenCourse }) => {
  const api = useApi();
  const [items, setItems] = useState<Announcement[]>([]);
  useEffect(() => {
    api.get<{ announcements: Announcement[] }>("/communication/my-announcements").then(d => setItems(d.announcements)).catch(() => setItems([]));
  }, [api.token]);
  if (!items.length) return null;
  return (
    <section className="glass-card" style={{ padding: "18px", marginBottom: "20px" }} aria-labelledby="my-ann-title">
      <h3 id="my-ann-title" style={{ fontSize: "15px", display: "flex", gap: "8px", alignItems: "center", marginBottom: "10px" }}><Megaphone size={16} />ประกาศล่าสุดจากคอร์สของฉัน</h3>
      {items.slice(0, 3).map(a => (
        <button key={a.id} type="button" onClick={() => onOpenCourse?.(a.course_id)}
          style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderTop: "1px solid rgba(0,0,0,0.05)", padding: "8px 0", cursor: onOpenCourse ? "pointer" : "default" }}>
          <span style={{ fontSize: "11px", color: "var(--primary)", fontWeight: 600 }}>{a.course_title}</span>
          <span style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>{a.title}</span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{formatDateTime(a.created_at)}</span>
        </button>
      ))}
    </section>
  );
};
