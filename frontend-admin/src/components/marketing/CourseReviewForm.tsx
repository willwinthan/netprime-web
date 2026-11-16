import React, { useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { StarInput } from "./Ratings";

interface MyReview { id: string; rating: number; body: string | null; status: "pending" | "approved" | "hidden" }
const STATUS_TEXT: Record<MyReview["status"], string> = {
  pending: "รอเจ้าหน้าที่ตรวจสอบก่อนแสดงบนหน้าคอร์ส",
  approved: "แสดงบนหน้าคอร์สแล้ว",
  hidden: "ถูกซ่อนโดยเจ้าหน้าที่"
};

/**
 * Learner review form (rate 1–5 + text). Shown only when the learner reached 30% progress or completed
 * the course; edits go back to moderation. Usable on the public course page and in the learner console.
 */
export const CourseReviewForm: React.FC<{ courseId: string; tone?: "site" | "console" }> = ({ courseId, tone = "site" }) => {
  const api = useApi();
  const [state, setState] = useState<{ eligible: boolean; reason?: string; review: MyReview | null } | null>(null);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.token) return;
    api.get<{ eligible: boolean; reason?: string; review: MyReview | null }>(`/marketing/courses/${encodeURIComponent(courseId)}/review`)
      .then(data => { setState(data); if (data.review) { setRating(data.review.rating); setBody(data.review.body || ""); } })
      .catch(() => setState(null));
  }, [courseId, api.token]);

  if (!api.token || !state) return null;
  if (!state.eligible && !state.review) {
    return state.reason ? <p style={{ fontSize: 14, color: tone === "site" ? "#4a5775" : "var(--text-muted)", margin: tone === "console" ? "0 0 24px" : 0 }}>{state.reason}</p> : null;
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!rating) { setError("กรุณาให้คะแนน 1–5 ดาว"); return; }
    try {
      setBusy(true);
      setError(null);
      const res = await api.request<{ message: string; review: MyReview }>(`/marketing/courses/${encodeURIComponent(courseId)}/review`, {
        method: "PUT", body: JSON.stringify({ rating, body })
      });
      setState(prev => (prev ? { ...prev, review: res.review } : prev));
      setMessage(res.message);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const status = state.review?.status;
  const statusTone = status === "approved" ? { bg: "rgba(16,185,129,0.12)", fg: "#146c43" }
    : status === "hidden" ? { bg: "rgba(100,116,139,0.14)", fg: "#475569" }
    : { bg: "rgba(245,158,11,0.14)", fg: "#8a5300" };
  // In the console the form sits between the course intro and the lesson tabs, so it gets its own card
  // and bottom margin; on the public site the caller already wraps it in a card.
  const consoleCard: React.CSSProperties = tone === "console"
    ? { padding: "20px 22px", marginBottom: 28, borderRadius: "1.25rem", border: "1px solid rgba(15,23,42,0.08)", background: "rgba(255,255,255,0.75)" }
    : {};

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 14, ...consoleCard }} aria-label="รีวิวคอร์สนี้">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px" }}>
        <strong style={{ fontSize: 16 }}>{state.review ? "รีวิวของคุณ" : "ให้คะแนนคอร์สนี้"}</strong>
        {status && (
          <span style={{ fontSize: 12.5, fontWeight: 600, padding: "3px 10px", borderRadius: 999, background: statusTone.bg, color: statusTone.fg }}>
            {STATUS_TEXT[status]}
          </span>
        )}
      </div>
      <StarInput value={rating} onChange={setRating} />
      <textarea className="form-input" rows={3} maxLength={2000} value={body} onChange={e => setBody(e.target.value)}
        placeholder="เล่าประสบการณ์การเรียน สิ่งที่ได้ และคำแนะนำสำหรับผู้เรียนคนอื่น (ไม่บังคับ)" style={{ background: "#fff", width: "100%" }} />
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "8px 16px" }}>
        <div style={{ minHeight: 20 }}>
          {error && <span role="alert" style={{ color: "#b42318", fontSize: 14 }}>{error}</span>}
          {!error && message && <span role="status" style={{ color: "#146c43", fontSize: 14 }}>{message}</span>}
        </div>
        <button type="submit" className={tone === "site" ? "ps-btn ps-btn-primary" : "tech-button-primary"} disabled={busy}
          style={tone === "console" ? { padding: "10px 22px", fontSize: 14 } : undefined}>
          {busy ? "กำลังส่ง…" : state.review ? "อัปเดตรีวิว" : "ส่งรีวิว"}
        </button>
      </div>
    </form>
  );
};
