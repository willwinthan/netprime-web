import React, { useEffect, useState } from "react";
import { Award, RefreshCw, Search } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Modal, Field, ErrorBox, Empty, tableStyle, thStyle, tdStyle, formatDateTime } from "./ui";

interface AdminCertificate {
  id: string; certificate_code: string; issued_at: string; user_name: string; user_email: string; course_title: string;
  revoked_at: string | null; revoke_reason: string | null; revoked_by_name: string | null; reissued_from: string | null;
}

const ACTIVE = { label: "ใช้งานได้", color: "var(--accent)", bg: "var(--accent-glow)" };
const REVOKED = { label: "เพิกถอนแล้ว", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" };

/** certificates.manage: find certificates by code or learner, revoke, or reissue with a new code. */
export const CertificatesAdminPanel: React.FC = () => {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<AdminCertificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ kind: "revoke" | "reissue"; cert: AdminCertificate } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.get<{ certificates: AdminCertificate[] }>(`/manage/certificates${search ? `?q=${encodeURIComponent(search)}` : ""}`);
      setRows(data.certificates);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [search, api.token]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "16px" }}>
        <h2 style={{ fontSize: "18px", display: "flex", alignItems: "center", gap: "8px" }}><Award size={20} color="var(--primary)" />ใบประกาศนียบัตร</h2>
        <form onSubmit={e => { e.preventDefault(); setSearch(query.trim()); }} style={{ display: "flex", gap: "8px" }}>
          <input className="form-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="รหัส / ชื่อ / อีเมล / คอร์ส"
            style={{ minWidth: "220px" }} aria-label="ค้นหาใบประกาศ" />
          <button type="submit" className="tech-button-outline" style={{ padding: "8px 14px" }} aria-label="ค้นหา"><Search size={16} /></button>
          <button type="button" className="tech-button-outline" onClick={load} style={{ padding: "8px 14px" }} aria-label="รีเฟรช"><RefreshCw size={16} /></button>
        </form>
      </div>

      <ErrorBox message={error} />
      {notice && <div role="status" style={{ color: "var(--accent)", fontSize: "14px", marginBottom: "12px" }}>{notice}</div>}

      <div className="glass-card" style={{ padding: "8px", overflowX: "auto" }}>
        {loading ? <Empty text="กำลังโหลด…" /> : rows.length === 0 ? <Empty text="ไม่พบใบประกาศ" /> : (
          <table style={tableStyle}>
            <thead><tr>
              <th style={thStyle}>รหัส</th><th style={thStyle}>ผู้เรียน</th><th style={thStyle}>คอร์ส</th>
              <th style={thStyle}>ออกเมื่อ</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th>
            </tr></thead>
            <tbody>
              {rows.map(cert => (
                <tr key={cert.id}>
                  <td style={{ ...tdStyle, fontFamily: "monospace", fontWeight: 700 }}>
                    <a href={`/verify-certificates?code=${encodeURIComponent(cert.certificate_code)}`} target="_blank" rel="noopener noreferrer">{cert.certificate_code}</a>
                    {cert.reissued_from && <div style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "inherit" }}>ออกใหม่แทนใบเดิม</div>}
                  </td>
                  <td style={tdStyle}>{cert.user_name}<div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{cert.user_email}</div></td>
                  <td style={tdStyle}>{cert.course_title}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{formatDateTime(cert.issued_at)}</td>
                  <td style={tdStyle}>
                    <Chip {...(cert.revoked_at ? REVOKED : ACTIVE)} />
                    {cert.revoked_at && (
                      <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
                        {formatDateTime(cert.revoked_at)}{cert.revoked_by_name ? ` โดย ${cert.revoked_by_name}` : ""}
                        {cert.revoke_reason && <div>{cert.revoke_reason}</div>}
                      </div>
                    )}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      {!cert.revoked_at && (
                        <button className="tech-button-outline" onClick={() => setAction({ kind: "revoke", cert })} style={{ padding: "4px 10px", fontSize: "12px", color: "var(--danger)" }}>เพิกถอน</button>
                      )}
                      <button className="tech-button-outline" onClick={() => setAction({ kind: "reissue", cert })} style={{ padding: "4px 10px", fontSize: "12px" }}>ออกใบใหม่</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {action && (
        <CertificateActionDialog api={api} kind={action.kind} cert={action.cert} onClose={() => setAction(null)}
          onDone={message => { setAction(null); setNotice(message); load(); }} />
      )}
    </div>
  );
};

const CertificateActionDialog: React.FC<{
  api: ReturnType<typeof useApi>; kind: "revoke" | "reissue"; cert: AdminCertificate; onClose: () => void; onDone: (message: string) => void;
}> = ({ api, kind, cert, onClose, onDone }) => {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      const res = await api.post<{ certificate: AdminCertificate }>(`/manage/certificates/${cert.id}/${kind}`, { reason });
      onDone(kind === "revoke" ? `เพิกถอน ${cert.certificate_code} แล้ว` : `ออกใบใหม่รหัส ${res.certificate.certificate_code} แล้ว`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={kind === "revoke" ? `เพิกถอน ${cert.certificate_code}` : `ออกใบใหม่แทน ${cert.certificate_code}`} onClose={onClose} width={520}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <ErrorBox message={error} />
        <p style={{ fontSize: "14px", color: "var(--text-secondary)" }}>
          {cert.user_name} · {cert.course_title}
          {kind === "revoke"
            ? " — หน้าตรวจสอบสาธารณะจะแสดงว่าใบนี้ถูกเพิกถอน ผู้เรียนขอใบใหม่เองไม่ได้"
            : " — ระบบสร้างรหัสใหม่ และเพิกถอนรหัสเดิม (ถ้ายังใช้งานอยู่)"}
        </p>
        <Field label={kind === "revoke" ? "เหตุผล (เก็บในระบบ ไม่แสดงต่อสาธารณะ)" : "เหตุผล (ไม่บังคับ)"}>
          <textarea className="form-input" rows={3} required={kind === "revoke"} value={reason} onChange={e => setReason(e.target.value)} maxLength={500} />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : kind === "revoke" ? "เพิกถอน" : "ออกใบใหม่"}</button>
        </div>
      </form>
    </Modal>
  );
};
