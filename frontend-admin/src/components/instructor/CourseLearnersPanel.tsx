import React, { useCallback, useEffect, useState } from "react";
import { Calendar, PlusCircle, ShieldAlert, Users } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox } from "../site-admin/ui";
import { StudentEmailLookup } from "./StudentEmailLookup";

const ENROLLMENT_STATUS_LABELS: Record<string, string> = {
  active: "ใช้งานอยู่",
  completed: "เรียนจบ",
  expired: "หมดอายุ",
  suspended: "ระงับ",
  pending: "รอดำเนินการ"
};

type TargetType = "student" | "partner" | "group";
interface Option { id: string; label: string }

const card: React.CSSProperties = { padding: "24px", background: "rgba(255, 255, 255, 0.45)", borderRadius: "1.25rem", border: "1px solid var(--border-subtle)" };
const cell: React.CSSProperties = { padding: "12px" };

/**
 * Workspace tab "ผู้เรียน": give a learner, a partner organization's seats or a study group access to
 * the course, and list who is enrolled with progress and expiry.
 */
export const CourseLearnersPanel: React.FC<{ courseId: string; accessDurationDays?: number | null; onChanged?: () => void }> = ({ courseId, accessDurationDays, onChanged }) => {
  const api = useApi();
  const [enrollments, setEnrollments] = useState<any[]>([]);
  const [students, setStudents] = useState<Option[]>([]);
  const [partners, setPartners] = useState<Option[]>([]);
  const [groups, setGroups] = useState<Option[]>([]);
  const [targetType, setTargetType] = useState<TargetType>("student");
  const [targetId, setTargetId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const options = targetType === "student" ? students : targetType === "partner" ? partners : groups;

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [enrolls, studentRows, partnerRows, groupRows] = await Promise.all([
        api.get<any[]>(`/instructor/courses/${courseId}/enrollments`),
        api.get<any[]>("/instructor/students"),
        api.get<any[]>("/business/partners").catch(() => []),
        api.get<any[]>("/instructor/groups").catch(() => [])
      ]);
      setEnrollments(enrolls);
      setStudents(studentRows.map(s => ({ id: s.id, label: `${s.name} (${s.email})` })));
      setPartners(partnerRows.map(p => ({ id: p.id, label: `${p.company_name} (จัดสรรแล้ว ${p.allocated_seats}/${p.total_seats} ที่นั่ง)` })));
      setGroups(groupRows.map(g => ({ id: g.id, label: `${g.name} (${g.member_count} คน)` })));
    } catch (err: any) {
      setError(err.message || "โหลดข้อมูลผู้เรียนไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [courseId, api.token]);

  useEffect(() => { load(); }, [load]);
  // Keep the picked recipient valid when the type or the lists change.
  useEffect(() => {
    if (!options.some(o => o.id === targetId)) setTargetId(options[0]?.id ?? "");
  }, [targetType, students, partners, groups]);

  const assign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetId) { setError("กรุณาเลือกผู้เรียน องค์กร หรือกลุ่มเรียน"); return; }
    try {
      setBusy(true);
      setError(null);
      const res = await api.post<{ message?: string }>(`/instructor/courses/${courseId}/assign`, { target_type: targetType, target_id: targetId });
      setNotice(res.message || "ให้สิทธิ์เข้าเรียนแล้ว");
      window.setTimeout(() => setNotice(null), 4000);
      await load();
      onChanged?.();
    } catch (err: any) {
      setError(err.message || "ให้สิทธิ์เข้าเรียนไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const radio = (value: TargetType, label: string) => (
    <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
      <input type="radio" name="assignTargetType" value={value} checked={targetType === value} onChange={() => setTargetType(value)} />
      {label}
    </label>
  );

  return (
    <div style={{ display: "grid", gap: "24px" }}>
      <ErrorBox message={error} />

      <div className="glass-card" style={card}>
        <h4 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "16px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "6px" }}>
          <PlusCircle size={18} color="var(--primary)" />
          ให้สิทธิ์เข้าเรียน
        </h4>
        <form onSubmit={assign} style={{ display: "grid", gap: "20px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "20px" }}>
            <div className="form-group">
              <label className="form-label">ให้ใคร</label>
              <div style={{ display: "flex", gap: "14px", marginTop: "4px", flexWrap: "wrap" }}>
                {radio("student", "ผู้เรียนรายคน")}
                {radio("partner", "องค์กร")}
                {radio("group", "กลุ่มเรียน")}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">เลือกผู้รับสิทธิ์</label>
              <select value={targetId} onChange={e => setTargetId(e.target.value)} className="form-input" style={{ borderRadius: "1rem", fontSize: "13px" }} required>
                {options.length === 0 && <option value="">{loading ? "กำลังโหลด..." : targetType === "partner" ? "ยังไม่มีองค์กรพาร์ตเนอร์" : targetType === "group" ? "ยังไม่มีกลุ่มเรียน" : "ยังไม่มีผู้เรียน ค้นหาด้วยอีเมลด้านล่าง"}</option>}
                {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              {targetType === "student" && (
                <StudentEmailLookup onFound={st => {
                  setStudents(prev => prev.some(p => p.id === st.id) ? prev : [...prev, { id: st.id, label: `${st.name} (${st.email})` }]);
                  setTargetId(st.id);
                }} />
              )}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-subtle)", paddingTop: "16px", gap: "12px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "4px" }}>
              <Calendar size={14} /> {accessDurationDays ? `เข้าเรียนได้ ${accessDurationDays} วันนับจากวันที่ได้สิทธิ์` : "เข้าเรียนได้ตลอดชีพ"}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              {notice && <span role="status" style={{ fontSize: 13, color: "var(--accent)" }}>{notice}</span>}
              <button type="submit" disabled={busy || !targetId} className="tech-button-primary" style={{ padding: "10px 24px", borderRadius: "1rem", fontSize: "13px" }}>
                {busy ? "กำลังให้สิทธิ์..." : "ให้สิทธิ์เข้าเรียน"}
              </button>
            </span>
          </div>
        </form>
      </div>

      <div className="glass-card" style={card}>
        <h4 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "16px", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "6px" }}>
          <Users size={18} color="var(--primary)" />
          ผู้เรียนในคอร์สนี้ {enrollments.length > 0 && <span style={{ fontWeight: 500, color: "var(--text-muted)" }}>({enrollments.length} คน)</span>}
        </h4>
        {loading && !enrollments.length ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>กำลังโหลด...</div>
        ) : enrollments.length === 0 ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>ยังไม่มีผู้เรียนในคอร์สนี้</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--border-subtle)" }}>
                  {["ชื่อผู้เรียน", "อีเมล", "วันที่ลงทะเบียน", "ความคืบหน้า", "สถานะ", "หมดสิทธิ์เข้าเรียน"].map(h =>
                    <th key={h} style={{ ...cell, color: "var(--text-secondary)" }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {enrollments.map(enr => {
                  const isExpired = enr.expires_at ? new Date(enr.expires_at).getTime() < Date.now() : false;
                  return (
                    <tr key={enr.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                      <td style={{ ...cell, fontWeight: 600 }}>{enr.student_name}</td>
                      <td style={{ ...cell, color: "var(--text-secondary)" }}>{enr.student_email}</td>
                      <td style={{ ...cell, color: "var(--text-secondary)" }}>{new Date(enr.enrolled_at).toLocaleDateString("th-TH")}</td>
                      <td style={{ ...cell, fontWeight: 700, color: "var(--color-brand-primary)" }}>{enr.progress_percent}%</td>
                      <td style={cell}>
                        <span className="badge-gamified" style={{
                          backgroundColor: isExpired ? "rgba(239, 68, 68, 0.1)" : "rgba(16, 185, 129, 0.1)",
                          color: isExpired ? "var(--danger)" : "var(--accent)",
                          borderColor: isExpired ? "rgba(239, 68, 68, 0.2)" : "rgba(16, 185, 129, 0.2)",
                          textTransform: "none", fontSize: "11px"
                        }}>
                          {isExpired ? "หมดอายุ" : (ENROLLMENT_STATUS_LABELS[enr.status] || enr.status)}
                        </span>
                      </td>
                      <td style={{ ...cell, color: isExpired ? "var(--danger)" : "var(--text-secondary)" }}>
                        {enr.expires_at ? (
                          <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                            {isExpired ? <ShieldAlert size={14} /> : <Calendar size={14} />}
                            {new Date(enr.expires_at).toLocaleDateString("th-TH")}
                          </span>
                        ) : "ตลอดชีพ"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
