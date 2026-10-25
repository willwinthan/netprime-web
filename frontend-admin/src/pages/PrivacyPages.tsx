import React, { useEffect, useState } from "react";
import { Download, ShieldCheck, Trash2, Check, X, RefreshCw } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { Chip, ErrorBox, Empty, Field, Modal, downloadWithAuth, formatDateTime, tableStyle, thStyle, tdStyle } from "../components/site-admin/ui";
import { useDangerousDelete } from "../components/security/DangerConfirmDialog";

interface DeletionRequest {
  id: string; status: "pending" | "approved" | "rejected"; reason: string | null; admin_note: string | null;
  created_at: string; processed_at: string | null;
}

const REQUEST_STATUS: Record<DeletionRequest["status"], { label: string; color: string; bg: string }> = {
  pending: { label: "รอดำเนินการ", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  approved: { label: "ลบข้อมูลแล้ว", color: "var(--accent)", bg: "var(--accent-glow)" },
  rejected: { label: "ปฏิเสธ", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" }
};

// ==========================================
// User side (embedded in the profile page)
// ==========================================

/** "ข้อมูลส่วนบุคคลของฉัน": download a JSON copy of my data and ask for account deletion (PDPA). */
export const PrivacyPanel: React.FC = () => {
  const api = useApi();
  const [request, setRequest] = useState<DeletionRequest | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => api.get<{ request: DeletionRequest | null }>("/me/deletion-request").then(d => setRequest(d.request)).catch(err => setError(err.message));
  useEffect(() => { load(); }, [api.token]);

  const download = async () => {
    try {
      setBusy(true);
      setError(null);
      await downloadWithAuth("/me/export", api.token, `netprime-my-data-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      const res = await api.post<{ message: string }>("/me/deletion-request", { reason: reason.trim() || undefined });
      setNotice(res.message);
      setAsking(false);
      setReason("");
      await load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const pending = request?.status === "pending";
  return (
    <section className="glass-card" style={{ padding: "24px" }} aria-labelledby="privacy-panel-title">
      <h3 id="privacy-panel-title" style={{ fontSize: "16px", display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px" }}>
        <ShieldCheck size={18} />ข้อมูลส่วนบุคคลของฉัน
      </h3>
      <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "16px" }}>
        ตามกฎหมายคุ้มครองข้อมูลส่วนบุคคล (PDPA) คุณขอรับสำเนาข้อมูลของคุณ หรือขอลบบัญชีได้ อ่านรายละเอียดใน <a href="/privacy" target="_blank" rel="noreferrer">นโยบายความเป็นส่วนตัว</a>
      </p>
      <ErrorBox message={error} />
      {notice && <div role="status" style={{ borderLeft: "4px solid var(--accent)", background: "var(--accent-glow)", padding: "10px 16px", borderRadius: "8px", marginBottom: "12px", fontSize: "14px" }}>{notice}</div>}
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <button className="tech-button-outline" disabled={busy} onClick={download}><Download size={16} />ดาวน์โหลดข้อมูลของฉัน (JSON)</button>
        {!pending && <button className="tech-button-outline" style={{ color: "var(--danger)", borderColor: "var(--danger)" }} disabled={busy} onClick={() => setAsking(true)}>
          <Trash2 size={16} />ขอลบบัญชี
        </button>}
      </div>
      {request && (
        <div style={{ marginTop: "16px", fontSize: "13px", color: "var(--text-secondary)", display: "grid", gap: "4px" }}>
          <div>คำขอลบบัญชีล่าสุด {formatDateTime(request.created_at)} · <Chip {...REQUEST_STATUS[request.status]} /></div>
          {pending && <div>เจ้าหน้าที่จะดำเนินการภายใน 30 วัน เมื่ออนุมัติแล้วบัญชีจะถูกปิดและเข้าสู่ระบบไม่ได้อีก</div>}
          {request.status === "rejected" && request.admin_note && <div>เหตุผล: {request.admin_note}</div>}
        </div>
      )}
      {asking && (
        <Modal title="ขอลบบัญชีและข้อมูลส่วนบุคคล" onClose={() => setAsking(false)} width={540}>
          <form onSubmit={submit} style={{ display: "grid", gap: "14px" }}>
            <div style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: 1.7 }}>
              เมื่อเจ้าหน้าที่อนุมัติ:
              <ul style={{ margin: "6px 0 0", paddingLeft: "20px" }}>
                <li>ชื่อและอีเมลของคุณจะถูกลบ บัญชีจะถูกปิดและเข้าสู่ระบบไม่ได้อีก</li>
                <li>บันทึกย่อ การแจ้งเตือน และการเชื่อมบัญชี Google/Microsoft/GitHub จะถูกลบ</li>
                <li>ข้อมูลการชำระเงิน ใบเสร็จ และใบประกาศนียบัตรจะเก็บไว้ตามที่กฎหมายกำหนด (ไม่ระบุชื่อ)</li>
              </ul>
              แนะนำให้ดาวน์โหลดข้อมูลของคุณเก็บไว้ก่อน
            </div>
            <Field label="เหตุผล (ไม่บังคับ)"><textarea className="form-input" rows={3} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button type="button" className="tech-button-outline" onClick={() => setAsking(false)}>ยกเลิก</button>
              <button type="submit" className="tech-button-primary" style={{ background: "var(--danger)" }} disabled={busy}>ส่งคำขอลบบัญชี</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
};

// ==========================================
// Admin side (privacy.manage)
// ==========================================

interface AdminRequest extends DeletionRequest {
  user_id: string; user_name: string; user_email: string; account_status: string; processed_by_name: string | null;
}

/** Page "คำขอข้อมูลส่วนบุคคล (PDPA)": list deletion requests and approve (anonymize) or reject. */
export const PrivacyRequestsPage: React.FC = () => {
  const api = useApi();
  const [status, setStatus] = useState<"pending" | "all">("pending");
  const [rows, setRows] = useState<AdminRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<{ request: AdminRequest; action: "approve" | "reject" } | null>(null);

  const load = async () => {
    try {
      setError(null);
      const data = await api.get<{ requests: AdminRequest[] }>(`/admin/privacy/requests${status === "pending" ? "?status=pending" : ""}`);
      setRows(data.requests);
    } catch (err: any) { setError(err.message); }
  };
  useEffect(() => { load(); }, [status, api.token]);

  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">คำขอข้อมูลส่วนบุคคล (PDPA)</h1>
          <p className="header-desc">คำขอลบบัญชีจากผู้ใช้ ต้องดำเนินการภายใน 30 วัน · ผู้ใช้ดาวน์โหลดข้อมูลของตัวเองได้เองที่หน้าโปรไฟล์</p>
        </div>
        <button className="tech-button-outline" onClick={load}><RefreshCw size={16} />โหลดใหม่</button>
      </div>
      <div style={{ display: "flex", gap: "6px", marginBottom: "16px" }}>
        {(["pending", "all"] as const).map(s => (
          <button key={s} onClick={() => setStatus(s)} className={status === s ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "4px 12px", fontSize: "12px" }}>
            {s === "pending" ? "รอดำเนินการ" : "ทั้งหมด"}
          </button>
        ))}
      </div>
      <ErrorBox message={error} />
      <div className="glass-card" style={{ padding: "8px", overflowX: "auto" }}>
        {!rows ? <Empty text="กำลังโหลด…" /> : rows.length === 0 ? <Empty text="ไม่มีคำขอ" /> : (
          <table style={tableStyle}>
            <thead><tr>
              <th style={thStyle}>ผู้ใช้</th><th style={thStyle}>ส่งคำขอ</th><th style={thStyle}>เหตุผล</th><th style={thStyle}>สถานะ</th><th style={thStyle}></th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={tdStyle}><div style={{ fontWeight: 700 }}>{r.user_name}</div><div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{r.user_email}</div></td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{formatDateTime(r.created_at)}</td>
                  <td style={tdStyle}>{r.reason || <span style={{ color: "var(--text-muted)" }}>-</span>}</td>
                  <td style={tdStyle}>
                    <Chip {...REQUEST_STATUS[r.status]} />
                    {r.processed_at && <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>{r.processed_by_name || "-"} · {formatDateTime(r.processed_at)}</div>}
                    {r.admin_note && <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>{r.admin_note}</div>}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    {r.status === "pending" && <>
                      <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px", marginRight: "6px", color: "var(--danger)", borderColor: "var(--danger)" }}
                        onClick={() => setActing({ request: r, action: "approve" })}><Check size={14} />อนุมัติและลบข้อมูล</button>
                      <button className="tech-button-outline" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={() => setActing({ request: r, action: "reject" })}><X size={14} />ปฏิเสธ</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {acting && <ProcessDialog api={api} {...acting} onClose={() => setActing(null)} onDone={() => { setActing(null); load(); }} />}
    </div>
  );
};

const ProcessDialog: React.FC<{ api: ReturnType<typeof useApi>; request: AdminRequest; action: "approve" | "reject"; onClose: () => void; onDone: () => void }> = ({ api, request, action, onClose, onDone }) => {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirmDelete, dangerDialog } = useDangerousDelete();
  const approve = action === "approve";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      const body = { note: note.trim() || undefined };
      if (approve) {
        // Irreversible anonymization: an emailed admin code (backend utils/dangerConfirm.ts).
        const done = await confirmDelete({ action: "privacy.approve", targetId: request.id, path: `/admin/privacy/requests/${request.id}/approve`,
          method: "POST", body, confirmMessage: `ลบข้อมูลของ ${request.user_name}? ย้อนกลับไม่ได้` });
        if (!done) { setBusy(false); return; }
      } else {
        await api.post(`/admin/privacy/requests/${request.id}/${action}`, body);
      }
      onDone();
    } catch (err: any) { setError(err.message); setBusy(false); }
  };
  return (
    <Modal title={approve ? `ลบข้อมูลของ ${request.user_name}?` : "ปฏิเสธคำขอลบบัญชี"} onClose={onClose} width={540}>
      {dangerDialog}
      <form onSubmit={submit} style={{ display: "grid", gap: "14px" }}>
        <ErrorBox message={error} />
        {approve
          ? <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: 1.7, margin: 0 }}>
              ระบบจะเปลี่ยนชื่อเป็น "ผู้ใช้ที่ลบแล้ว" ลบอีเมล ปิดบัญชีและออกจากระบบทุกอุปกรณ์ ลบบันทึกย่อ การแจ้งเตือน และการเชื่อมบัญชีภายนอก
              และลบข้อมูลติดต่อในใบสมัครอบรม คำสั่งซื้อ การชำระเงิน และใบประกาศนียบัตรจะเก็บไว้ (ไม่ระบุชื่อ) ตามกฎหมาย <strong>ย้อนกลับไม่ได้</strong>
            </p>
          : <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: 0 }}>ผู้ใช้จะเห็นเหตุผลนี้ในหน้าโปรไฟล์และได้รับการแจ้งเตือน</p>}
        <Field label={approve ? "หมายเหตุ (ไม่บังคับ)" : "เหตุผลที่ปฏิเสธ *"}>
          <textarea className="form-input" rows={3} maxLength={1000} required={!approve} value={note} onChange={e => setNote(e.target.value)} />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button type="button" className="tech-button-outline" onClick={onClose}>ยกเลิก</button>
          <button type="submit" className="tech-button-primary" style={approve ? { background: "var(--danger)" } : undefined} disabled={busy}>
            {approve ? "ยืนยันลบข้อมูล" : "ปฏิเสธคำขอ"}
          </button>
        </div>
      </form>
    </Modal>
  );
};
