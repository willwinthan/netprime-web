import React from "react";
import { useApi } from "../../hooks/useApi";

/**
 * Instructors only see learners of their own courses and groups; anyone else is found by exact email.
 */
export const StudentEmailLookup: React.FC<{ onFound: (student: { id: string; name: string; email: string }) => void }> = ({ onFound }) => {
  const api = useApi();
  const [email, setEmail] = React.useState("");
  const [message, setMessage] = React.useState<string | null>(null);
  const lookup = async () => {
    if (!email.trim()) return;
    try {
      setMessage(null);
      const found = await api.get<Array<{ id: string; name: string; email: string }>>(`/instructor/students?email=${encodeURIComponent(email.trim())}`);
      if (found.length) { onFound(found[0]); setEmail(""); setMessage(`เลือก ${found[0].name} แล้ว`); }
      else setMessage("ไม่พบผู้เรียนที่ใช้อีเมลนี้");
    } catch (err: any) { setMessage(err.message); }
  };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
      <input type="email" className="form-input" value={email} onChange={e => setEmail(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); lookup(); } }}
        placeholder="ไม่อยู่ในรายการ? ค้นหาด้วยอีเมล" aria-label="ค้นหาผู้เรียนด้วยอีเมล"
        style={{ flex: "1 1 200px", borderRadius: "1rem", fontSize: "13px" }} />
      <button type="button" className="tech-button-outline" onClick={lookup} style={{ padding: "8px 14px", fontSize: "12px", borderRadius: "1rem" }}>ค้นหา</button>
      {message && <span role="status" style={{ fontSize: 12, color: "var(--text-secondary)" }}>{message}</span>}
    </div>
  );
};
