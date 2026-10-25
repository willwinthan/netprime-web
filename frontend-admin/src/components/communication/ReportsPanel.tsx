import React, { useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { Chip, ErrorBox, Empty, formatDateTime, tableStyle, thStyle, tdStyle } from "../site-admin/ui";

interface Report {
  id: string; target_type: "post" | "comment"; target_id: string; post_id: string | null; space_name: string | null; reporter_name: string | null;
  reason: string; status: string; target_excerpt: string | null; target_hidden: number | null; created_at: string;
}

/** Community abuse reports (community.moderate; instructors see their courses' spaces only). */
export const ReportsPanel: React.FC<{ onOpenPost?: (postId: string) => void }> = ({ onOpenPost }) => {
  const api = useApi();
  const [status, setStatus] = useState("open");
  const [reports, setReports] = useState<Report[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get<{ reports: Report[] }>(`/community/reports?status=${status}`).then(d => setReports(d.reports)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [status, api.token]);

  const resolve = async (r: Report, next: "resolved" | "dismissed", hide: boolean) => {
    try {
      setError(null);
      await api.patch(`/community/reports/${r.id}`, { status: next, hide });
      await load();
    } catch (err: any) { setError(err.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        {[["open", "รอตรวจสอบ"], ["resolved", "ดำเนินการแล้ว"], ["dismissed", "ไม่ดำเนินการ"]].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setStatus(k)} className={status === k ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "4px 12px", fontSize: "13px", borderRadius: "99px" }}>{l}</button>
        ))}
      </div>
      <ErrorBox message={error} />
      {reports.length === 0 ? <Empty text="ไม่มีรายงาน" /> : (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead><tr><th style={thStyle}>เนื้อหา</th><th style={thStyle}>ห้อง</th><th style={thStyle}>เหตุผล</th><th style={thStyle}>ผู้รายงาน</th><th style={thStyle}>วันที่</th>{status === "open" && <th style={thStyle}></th>}</tr></thead>
            <tbody>
              {reports.map(r => (
                <tr key={r.id}>
                  <td style={tdStyle}>
                    <Chip label={r.target_type === "post" ? "โพสต์" : "ความคิดเห็น"} color="var(--primary)" bg="var(--primary-glow)" />
                    {r.target_hidden ? <Chip label="ซ่อนอยู่" color="var(--danger)" bg="rgba(239,68,68,0.1)" /> : null}
                    <div style={{ marginTop: "4px" }}>
                      {onOpenPost && r.post_id
                        ? <button type="button" onClick={() => onOpenPost(r.post_id!)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text-primary)", textAlign: "left" }}>{r.target_excerpt ?? "(ถูกลบแล้ว)"}</button>
                        : (r.target_excerpt ?? "(ถูกลบแล้ว)")}
                    </div>
                  </td>
                  <td style={tdStyle}>{r.space_name ?? "-"}</td>
                  <td style={tdStyle}>{r.reason}</td>
                  <td style={tdStyle}>{r.reporter_name ?? "-"}</td>
                  <td style={tdStyle}>{formatDateTime(r.created_at)}</td>
                  {status === "open" && (
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <button type="button" className="tech-button-primary" onClick={() => resolve(r, "resolved", true)} style={{ padding: "4px 10px", fontSize: "12px", marginRight: "6px" }}>ซ่อนเนื้อหา</button>
                      <button type="button" className="tech-button-outline" onClick={() => resolve(r, "dismissed", false)} style={{ padding: "4px 10px", fontSize: "12px" }}>ไม่ผิดกติกา</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
