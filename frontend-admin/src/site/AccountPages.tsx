import React, { useEffect, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { Link, usePageMeta } from "./router";
import { useSite } from "./shared";

/**
 * Public pages opened from emailed links: /reset-password (password reset and invitations)
 * and /verify-email. The token is read once and removed from the address bar so it does not
 * stay in history or leak through the Referer header.
 */
function useLinkToken(): string | null {
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token"));
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("token")) {
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    }
  }, []);
  return token;
}

const Shell: React.FC<{ title: string; lead?: string; children: React.ReactNode }> = ({ title, lead, children }) => (
  <div className="ps-container" style={{ padding: "56px 16px 72px", display: "flex", justifyContent: "center" }}>
    <div className="ps-card" style={{ width: "100%", maxWidth: 460, padding: 28 }}>
      <h1 style={{ margin: "0 0 8px", fontSize: 26, lineHeight: 1.3 }}>{title}</h1>
      {lead && <p className="ps-muted" style={{ margin: "0 0 20px", fontSize: 15 }}>{lead}</p>}
      {children}
    </div>
  </div>
);

const alertStyle: React.CSSProperties = { margin: "0 0 16px", padding: "10px 12px", borderRadius: 12, background: "#fdecec", color: "#b42318", fontSize: 14 };
const okStyle: React.CSSProperties = { margin: "0 0 16px", padding: "10px 12px", borderRadius: 12, background: "#e8f6ee", color: "#146c43", fontSize: 14 };
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 14, fontWeight: 600 };
const inputStyle: React.CSSProperties = { background: "#fff", borderColor: "#d9cfc5" };

export const ResetPasswordPage: React.FC = () => {
  const invite = new URLSearchParams(window.location.search).get("invite") === "1";
  const title = invite ? "ตั้งรหัสผ่านเพื่อเริ่มใช้งาน" : "ตั้งรหัสผ่านใหม่";
  usePageMeta(title);
  const token = useLinkToken();
  const api = useApi();
  const { loggedIn, openAuth } = useSite();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirm) { setError("รหัสผ่านทั้งสองช่องไม่ตรงกัน"); return; }
    try {
      setLoading(true);
      setError(null);
      const res = await api.post<{ message: string }>("/auth/reset-password", { token, password });
      setDone(res.message);
      // Every session was signed out; let a signed-in tab notice right away.
      if (loggedIn) api.refreshUser().catch(() => undefined);
    } catch (err: any) {
      setError(err.message || "ตั้งรหัสผ่านไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <Shell title={title} lead="ลิงก์ไม่ครบถ้วน กรุณาเปิดลิงก์จากอีเมลอีกครั้ง หรือขอลิงก์ใหม่">
        <button type="button" className="ps-btn ps-btn-primary" onClick={() => openAuth("login")}>ไปหน้าเข้าสู่ระบบ</button>
      </Shell>
    );
  }
  if (done) {
    return (
      <Shell title={title}>
        <p role="status" style={okStyle}>{done}</p>
        <button type="button" className="ps-btn ps-btn-primary ps-btn-lg" style={{ width: "100%" }} onClick={() => openAuth("login")}>เข้าสู่ระบบ</button>
      </Shell>
    );
  }
  return (
    <Shell title={title} lead={invite ? "ตั้งรหัสผ่านของคุณเองเพื่อเข้าใช้งาน Netprime LMS ครั้งแรก" : "รหัสผ่านใหม่จะใช้แทนรหัสเดิม และทุกอุปกรณ์จะถูกออกจากระบบ"}>
      {error && <p role="alert" style={alertStyle}>{error}</p>}
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label style={labelStyle}>รหัสผ่านใหม่
          <input className="form-input" type="password" required minLength={12} maxLength={256} autoComplete="new-password"
            value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} />
          <span className="ps-muted" style={{ fontWeight: 400, fontSize: 13 }}>อย่างน้อย 12 ตัวอักษร</span>
        </label>
        <label style={labelStyle}>ยืนยันรหัสผ่านใหม่
          <input className="form-input" type="password" required minLength={12} maxLength={256} autoComplete="new-password"
            value={confirm} onChange={e => setConfirm(e.target.value)} style={inputStyle} />
        </label>
        <button type="submit" className="ps-btn ps-btn-primary ps-btn-lg" disabled={loading}>{loading ? "กรุณารอสักครู่…" : "บันทึกรหัสผ่าน"}</button>
      </form>
      {!invite && <p className="ps-muted" style={{ margin: "16px 0 0", fontSize: 13 }}>ลิงก์หมดอายุ? เปิด “เข้าสู่ระบบ” แล้วเลือก “ลืมรหัสผ่าน?” เพื่อขอลิงก์ใหม่</p>}
    </Shell>
  );
};

export const VerifyEmailPage: React.FC = () => {
  usePageMeta("ยืนยันอีเมล");
  const token = useLinkToken();
  const api = useApi();
  const { loggedIn, openAuth } = useSite();
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // Tokens are single-use, so StrictMode's double effect must not send it twice.
    if (started.current || !token) return;
    started.current = true;
    api.post<{ message: string }>("/auth/verify-email", { token })
      .then(res => {
        setState({ ok: true, message: res.message });
        if (loggedIn) api.refreshUser().catch(() => undefined);
      })
      .catch((err: Error) => setState({ ok: false, message: err.message || "ยืนยันอีเมลไม่สำเร็จ" }));
  }, [token]);

  return (
    <Shell title="ยืนยันอีเมล">
      {!token && <p role="alert" style={alertStyle}>ลิงก์ไม่ครบถ้วน กรุณาเปิดลิงก์จากอีเมลอีกครั้ง</p>}
      {token && !state && <p className="ps-muted">กำลังยืนยันอีเมล…</p>}
      {state && <p role={state.ok ? "status" : "alert"} style={state.ok ? okStyle : alertStyle}>{state.message}</p>}
      {state && !state.ok && <p className="ps-muted" style={{ fontSize: 14 }}>เข้าสู่ระบบแล้วขอลิงก์ยืนยันใหม่ได้จากหน้าโปรไฟล์</p>}
      {(state || !token) && (loggedIn
        ? <Link to="/dashboard" className="ps-btn ps-btn-primary">ไปที่แดชบอร์ด</Link>
        : <button type="button" className="ps-btn ps-btn-primary" onClick={() => openAuth("login")}>เข้าสู่ระบบ</button>)}
    </Shell>
  );
};
