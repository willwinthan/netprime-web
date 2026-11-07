import React, { useEffect, useState } from "react";
import { GraduationCap } from "lucide-react";
import { useApi } from "../../hooks/useApi";

// "ห้องเรียนของฉัน": self-learning lessons the learner started but has not finished. Lessons are learned on
// the public site (/self-learning/:slug), which saves progress to the account when signed in.

interface Started { slug: string; title: string; percent: number; completed_at: string | null }

export const SelfLearningResume: React.FC = () => {
  const api = useApi();
  const [started, setStarted] = useState<Started[]>([]);
  useEffect(() => {
    if (!api.token) return;
    api.get<{ progress: Started[] }>("/me/self-learning")
      .then(d => setStarted(d.progress.filter(p => !p.completed_at).slice(0, 3))).catch(() => setStarted([]));
  }, [api.token]);
  if (!started.length) return null;

  return (
    <div className="glass-card" style={{ padding: "16px 20px", marginBottom: 24, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
        <strong style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--text-primary)" }}>
          <GraduationCap size={18} /> บทเรียน Self-learning ที่เรียนค้างอยู่
        </strong>
        <a href="/self-learning" style={{ fontSize: 13 }}>ดูบทเรียนทั้งหมด</a>
      </div>
      {started.map(p => (
        <a key={p.slug} href={`/self-learning/${p.slug}`} style={{ display: "grid", gap: 4, textDecoration: "none", color: "var(--text-primary)" }}>
          <span style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14 }}>
            <span>{p.title}</span><span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>เรียนต่อ {p.percent}%</span>
          </span>
          <span aria-hidden style={{ height: 6, borderRadius: 3, background: "rgba(0,0,0,0.06)", overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: `${p.percent}%`, background: "var(--primary)" }} />
          </span>
        </a>
      ))}
    </div>
  );
};
