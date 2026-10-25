import React, { useEffect, useRef, useState } from "react";
import { Building2 } from "lucide-react";
import { useApi, User } from "../../hooks/useApi";
import { navigate } from "../../site/router";

/** Per-login browser binding: a random secret kept in sessionStorage; only its SHA-256 goes to /sso/start. */
const SSO_BINDING_KEY = "np-sso-binding";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function newSsoBinding(): Promise<string> {
  const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(SSO_BINDING_KEY, secret);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  return [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
}

function takeSsoBinding(): string {
  try {
    const secret = sessionStorage.getItem(SSO_BINDING_KEY) || "";
    sessionStorage.removeItem(SSO_BINDING_KEY);
    return secret;
  } catch { return ""; }
}

/**
 * "เข้าสู่ระบบด้วย SSO องค์กร" for the sign-in dialog. Hidden until an SSO connection is enabled.
 * Asks for the work email (it picks the organization's IdP) and goes to the IdP; the IdP returns to
 * the API, which redirects to /auth/sso/complete#ticket=… (see SsoCompletePage).
 */
export const SsoLoginButton: React.FC<{ disabled?: boolean; email?: string }> = ({ disabled, email: initialEmail = "" }) => {
  const api = useApi();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ enabled: boolean }>("/sso/status").then(d => setEnabled(d.enabled)).catch(() => setEnabled(false));
  }, []);
  if (!enabled) return null;

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      setError(null);
      const binding = await newSsoBinding();
      const res = await api.post<{ url: string }>("/sso/start", { email, return_to: window.location.origin, binding });
      window.location.assign(res.url);
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div style={{ display: "flex", flexDirection: "column", marginBottom: 14 }}>
        <button type="button" className="ps-btn ps-btn-ghost" disabled={disabled} onClick={() => setOpen(true)}>
          <Building2 size={16} style={{ marginRight: 6, verticalAlign: "-3px" }} />เข้าสู่ระบบด้วย SSO องค์กร
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={start} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, border: "1px solid #e7ddd3", borderRadius: 12, marginBottom: 14 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14, fontWeight: 600 }}>อีเมลองค์กรของคุณ
        <input className="form-input" type="email" required autoFocus autoComplete="username" value={email} onChange={e => setEmail(e.target.value)}
          placeholder="name@company.co.th" style={{ background: "#fff", borderColor: "#d9cfc5" }} />
      </label>
      {error && <p role="alert" style={{ margin: 0, fontSize: 13, color: "#b42318" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="ps-btn ps-btn-primary" disabled={busy} style={{ flex: 1 }}>{busy ? "กำลังไปยังระบบองค์กร…" : "ดำเนินการต่อ"}</button>
        <button type="button" className="ps-btn ps-btn-outline" onClick={() => { setOpen(false); setError(null); }}>ยกเลิก</button>
      </div>
    </form>
  );
};

const SSO_ERRORS: Record<string, string> = {
  state_invalid: "ลิงก์เข้าสู่ระบบหมดอายุหรือถูกใช้ไปแล้ว กรุณาเริ่มใหม่",
  idp_error: "ระบบขององค์กรยกเลิกหรือปฏิเสธการเข้าสู่ระบบ",
  provider_disabled: "การเข้าสู่ระบบ SSO ขององค์กรนี้ถูกปิดใช้งาน",
  token_exchange_failed: "ยืนยันกับระบบขององค์กรไม่สำเร็จ กรุณาติดต่อผู้ดูแลระบบ",
  id_token_invalid: "ข้อมูลยืนยันตัวตนจากองค์กรไม่ถูกต้อง",
  email_missing: "บัญชีองค์กรไม่มีอีเมลที่ยืนยันแล้ว",
  domain_not_allowed: "โดเมนอีเมลนี้ไม่ได้รับอนุญาตให้ใช้ SSO",
  not_provisioned: "ยังไม่มีบัญชีสำหรับอีเมลนี้ กรุณาติดต่อผู้ดูแลระบบให้เพิ่มบัญชี",
  account_suspended: "บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ",
  staff_link_required: "บัญชีผู้ดูแล ผู้ประสานงาน หรือผู้สอนเชื่อมกับ SSO อัตโนมัติไม่ได้ กรุณาเข้าสู่ระบบด้วยอีเมลและรหัสผ่าน แล้วติดต่อผู้ดูแลระบบเพื่อเชื่อมบัญชี SSO",
  email_unverified: "ระบบขององค์กรไม่ได้ยืนยันอีเมลนี้ จึงเชื่อมกับบัญชีเดิมไม่ได้ กรุณาเข้าสู่ระบบด้วยอีเมลและรหัสผ่าน หรือติดต่อผู้ดูแลระบบ",
  account_link_conflict: "บัญชีนี้เชื่อมกับผู้ใช้อื่นในระบบองค์กรแล้ว กรุณาติดต่อผู้ดูแลระบบ",
  server_error: "เกิดข้อผิดพลาด กรุณาลองใหม่"
};

/**
 * Page for /auth/sso/complete: exchanges the one-time ticket from the URL fragment for a session.
 * `onLogin` should be the same handler the sign-in dialog uses (App's handleLoginSuccess).
 */
export const SsoCompletePage: React.FC<{ onLogin: (token: string, user: User) => void }> = ({ onLogin }) => {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    // Drop the ticket from the address bar and history right away.
    window.history.replaceState(null, "", window.location.pathname);
    const ticket = params.get("ticket");
    const secret = takeSsoBinding();
    if (!ticket) { setError(SSO_ERRORS[params.get("error") || ""] || SSO_ERRORS.server_error); return; }
    if (!secret) { setError("ลิงก์เข้าสู่ระบบนี้ไม่ได้เริ่มจากเบราว์เซอร์นี้ กรุณาเริ่มเข้าสู่ระบบด้วย SSO ใหม่อีกครั้ง"); return; }
    api.post<{ token: string; user: User }>("/sso/exchange", { ticket, secret })
      .then(res => { onLogin(res.token, res.user); navigate("/dashboard", { replace: true }); })
      .catch(err => setError(err.message));
  }, []);

  return (
    <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div className="glass-card" style={{ padding: 32, maxWidth: 440, textAlign: "center" }}>
        {error ? <>
          <h2 style={{ fontSize: 20, marginBottom: 10 }}>เข้าสู่ระบบด้วย SSO ไม่สำเร็จ</h2>
          <p role="alert" style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>
          <button className="tech-button-primary" onClick={() => navigate("/", { replace: true })}>กลับหน้าแรก</button>
        </> : <p style={{ margin: 0 }}>กำลังเข้าสู่ระบบด้วยบัญชีองค์กร…</p>}
      </div>
    </div>
  );
};
