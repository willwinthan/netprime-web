import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Mail, ShieldCheck } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox, Modal } from "../site-admin/ui";

/**
 * Email confirmation for dangerous deletions (backend utils/dangerConfirm.ts).
 * The server decides when a code is needed: the target is published, has learner data or money attached,
 * or is security-critical. Otherwise the hook falls back to the simple browser confirm.
 */

export type DangerAction =
  | "course.delete" | "lesson.delete" | "section.delete" | "exam.delete" | "assignment.delete"
  | "session.delete" | "article.delete" | "product.delete" | "page.delete"
  | "webhook.delete" | "api_key.revoke" | "sso.delete" | "privacy.approve";

export interface DeletePreview {
  action: DangerAction;
  target_id: string;
  label: string;
  kind: string;
  title: string;
  required: boolean;
  admin_only: boolean;
  counts: Array<{ label: string; value: number }>;
  consequences: string[];
  confirm_text: string | null;
  approvers: Array<{ kind: "owner" | "admin"; label: string; hint: string }>;
  default_approver: "owner" | "admin" | null;
  expires_minutes: number;
  max_attempts: number;
}

export interface DangerousDeleteRequest {
  action: DangerAction;
  targetId: string;
  /** API path of the destructive call, e.g. `/instructor/courses/${id}`. */
  path: string;
  method?: "DELETE" | "POST";
  /** Extra JSON body fields (the code is added as confirmation_code). */
  body?: Record<string, unknown>;
  /** Simple confirm text used when the server says no code is needed. */
  confirmMessage: string;
}

const box: React.CSSProperties = { borderRadius: "10px", padding: "12px 14px", fontSize: "14px", marginBottom: "14px" };

export const DangerConfirmDialog: React.FC<{
  preview: DeletePreview;
  onSubmit: (code: string) => Promise<void>;
  onClose: () => void;
}> = ({ preview, onSubmit, onClose }) => {
  const api = useApi();
  const [approver, setApprover] = useState(preview.default_approver ?? preview.approvers[0]?.kind ?? null);
  const [sent, setSent] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleOk = !preview.confirm_text || typed.trim() === preview.confirm_text.trim();
  const ready = /^\d{6}$/.test(code) && titleOk && !busy;

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ message: string }>("/security/delete-codes", { action: preview.action, target_id: preview.target_id, approver });
      setSent(res.message);
      setCode("");
    } catch (err: any) {
      setError(err.message || "ส่งรหัสไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(code);
    } catch (err: any) {
      setError(err.message || "ดำเนินการไม่สำเร็จ");
      setBusy(false);
    }
  };

  return (
    <Modal title={`ยืนยันการ${preview.label}`} onClose={busy ? () => undefined : onClose} width={560}>
      <div style={{ ...box, border: "1px solid var(--danger)", background: "rgba(239,68,68,0.06)" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
          <AlertTriangle size={18} color="var(--danger)" style={{ flexShrink: 0, marginTop: "2px" }} />
          <div>
            <strong>{preview.kind}: {preview.title}</strong>
            {preview.counts.length > 0 && (
              <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
                {preview.counts.map(c => <li key={c.label}>{c.label}: {c.value.toLocaleString("th-TH")}</li>)}
              </ul>
            )}
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px", color: "var(--text-secondary)" }}>
              {preview.consequences.map(t => <li key={t}>{t}</li>)}
            </ul>
          </div>
        </div>
      </div>

      <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "12px", display: "flex", gap: "6px", alignItems: "flex-start" }}>
        <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: "2px" }} />
        รายการนี้ต้องยืนยันด้วยรหัส 6 หลักที่ส่งทางอีเมล{preview.admin_only ? "ของผู้ดูแลระบบ" : "ของเจ้าของหรือผู้ดูแลระบบ"} รหัสมีอายุ {preview.expires_minutes} นาที ใช้ได้ครั้งเดียว
        {" "}หากผู้อนุมัติไม่ใช่คุณ ให้ขอรหัสจากผู้อนุมัติโดยตรง
      </p>

      <ErrorBox message={error} />

      {preview.approvers.length === 0 ? (
        <ErrorBox message="ไม่พบผู้อนุมัติที่ใช้งานอยู่ (เจ้าของหรือผู้ดูแลระบบ) จึงยังดำเนินการไม่ได้" />
      ) : (
        <fieldset style={{ border: "none", padding: 0, margin: "0 0 14px" }}>
          <legend className="form-label" style={{ marginBottom: "6px" }}>ส่งรหัสยืนยันไปที่</legend>
          {preview.approvers.map(a => (
            <label key={a.kind} style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "14px", padding: "4px 0", cursor: "pointer" }}>
              <input type="radio" name="danger-approver" checked={approver === a.kind} onChange={() => setApprover(a.kind)} disabled={busy} />
              <span>{a.label} <span style={{ color: "var(--text-muted)" }}>({a.hint})</span></span>
            </label>
          ))}
          <button type="button" className="tech-button-outline" onClick={sendCode} disabled={busy || !approver} style={{ marginTop: "8px" }}>
            <Mail size={16} />{sent ? "ส่งรหัสใหม่" : "ส่งรหัสยืนยัน"}
          </button>
        </fieldset>
      )}

      {sent && (
        <form onSubmit={confirm}>
          <div role="status" style={{ ...box, borderLeft: "4px solid var(--accent)", background: "var(--accent-glow)" }}>{sent}</div>
          <label className="form-group" style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "12px" }}>
            <span className="form-label">รหัสยืนยัน 6 หลัก</span>
            <input className="form-input" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric" autoComplete="one-time-code" placeholder="000000" autoFocus
              style={{ letterSpacing: "6px", fontFamily: "monospace", fontSize: "18px" }} />
          </label>
          {preview.confirm_text && (
            <label className="form-group" style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "12px" }}>
              <span className="form-label">พิมพ์ชื่อ{preview.kind} “{preview.confirm_text}” เพื่อยืนยัน</span>
              <input className="form-input" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" />
            </label>
          )}
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button type="button" className="tech-button-outline" onClick={onClose} disabled={busy}>ยกเลิก</button>
            <button type="submit" className="tech-button-primary" disabled={!ready}
              style={{ background: ready ? "var(--danger)" : undefined, borderColor: "var(--danger)" }}>
              {busy ? "กำลังดำเนินการ…" : `ยืนยันการ${preview.label}`}
            </button>
          </div>
        </form>
      )}
      {!sent && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="tech-button-outline" onClick={onClose} disabled={busy}>ยกเลิก</button>
        </div>
      )}
    </Modal>
  );
};

/**
 * `const { confirmDelete, dangerDialog } = useDangerousDelete();` then render `{dangerDialog}` and call
 * `await confirmDelete({ action, targetId, path, confirmMessage })`. Resolves with the API response,
 * or null when the user cancels. The preview request may throw (no permission, not found).
 */
export function useDangerousDelete() {
  const api = useApi();
  const [pending, setPending] = useState<{ req: DangerousDeleteRequest; preview: DeletePreview } | null>(null);
  const resolver = useRef<((value: unknown) => void) | null>(null);

  const call = <T,>(req: DangerousDeleteRequest, code?: string) => api.request<T>(req.path, {
    method: req.method ?? "DELETE",
    body: JSON.stringify({ ...(req.body ?? {}), ...(code ? { confirmation_code: code } : {}) })
  });

  const confirmDelete = async <T = { message?: string },>(req: DangerousDeleteRequest): Promise<T | null> => {
    const preview = await api.get<DeletePreview>(`/security/delete-preview?action=${encodeURIComponent(req.action)}&target_id=${encodeURIComponent(req.targetId)}`);
    if (!preview.required) {
      if (!window.confirm(req.confirmMessage)) return null;
      return call<T>(req);
    }
    resolver.current?.(null);
    return new Promise<T | null>(resolve => {
      resolver.current = resolve as (value: unknown) => void;
      setPending({ req, preview });
    });
  };

  const finish = (value: unknown) => {
    resolver.current?.(value);
    resolver.current = null;
    setPending(null);
  };

  // Portal: callers render {dangerDialog} anywhere, even inside another dialog or a transformed card.
  const dangerDialog = pending ? createPortal(
    <DangerConfirmDialog key={`${pending.preview.action}:${pending.preview.target_id}`} preview={pending.preview} onClose={() => finish(null)}
      onSubmit={async (code) => { finish(await call(pending.req, code)); }} />,
    document.body
  ) : null;

  return { confirmDelete, dangerDialog };
}
