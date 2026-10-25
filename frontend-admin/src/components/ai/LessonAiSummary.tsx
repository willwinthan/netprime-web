import React, { useEffect, useState } from "react";
import { Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { AI_DISCLAIMER, MockNotice } from "./aiShared";

interface SummaryData { summary: string | null; key_points: string[]; mock?: boolean; available?: boolean; disabled?: boolean }

/**
 * Learner-facing "สรุปบทเรียนด้วย AI" card. Hidden when the lesson has no text, the feature is off
 * or the learner has no access. The server caches one summary per lesson version.
 */
export const LessonAiSummary: React.FC<{ lessonId: string }> = ({ lessonId }) => {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => { setData(null); setError(null); setHidden(false); setOpen(false); }, [lessonId]);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const result = await api.get<SummaryData>(`/ai/lessons/${lessonId}/summary`);
      if (!result.summary) setHidden(true);
      setData(result);
    } catch (err: any) {
      if (/ปิดการใช้งาน|สิทธิ์/.test(err.message)) setHidden(true);
      else setError(err.message);
    } finally { setLoading(false); }
  };

  if (hidden) return null;
  return (
    <div className="glass-card" style={{ padding: "16px 20px", borderRadius: "1.25rem", marginBottom: 24 }}>
      <button type="button" aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (next && !data) load(); }}
        style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", cursor: "pointer", color: "var(--text-primary)", fontWeight: 600, fontSize: 15, padding: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Sparkles size={18} color="var(--primary)" /> สรุปบทเรียนและประเด็นสำคัญ (AI)</span>
        {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          {loading && <p style={{ fontSize: 14, color: "var(--text-muted)" }}>กำลังสรุปบทเรียน...</p>}
          {error && <p role="alert" style={{ fontSize: 14, color: "var(--danger)" }}>{error}</p>}
          {data?.summary && (
            <>
              <MockNotice mock={data.mock} />
              <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-secondary)", marginTop: 8 }}>{data.summary}</p>
              {data.key_points.length > 0 && (
                <ul style={{ fontSize: 14, lineHeight: 1.7, paddingLeft: 20, color: "var(--text-secondary)" }}>
                  {data.key_points.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              )}
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>{AI_DISCLAIMER}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
};
