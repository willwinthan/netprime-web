import React, { useEffect, useState } from "react";
import { BadgeCheck, KeyRound, Mail, Save, UserRound } from "lucide-react";
import { useApi, User } from "../hooks/useApi";
import { ErrorBox, Field, grid2 } from "../components/site-admin/ui";

const noticeStyle: React.CSSProperties = { padding: "10px 14px", borderRadius: 10, background: "var(--accent-glow)", color: "var(--accent)", marginBottom: 14, fontSize: 14 };
const sectionTitle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 17, margin: "0 0 14px" };

/** Sends a new verification link; shared by the profile page and the console banner. */
function useResendVerification() {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resend = async () => {
    try {
      setBusy(true);
      setError(null);
      const res = await api.post<{ message: string; email_verified: boolean }>("/auth/resend-verification", {});
      setMessage(res.message);
      // The account may have been verified in another tab.
      if (res.email_verified) await api.refreshUser();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, error, resend };
}

/**
 * The signed-in user's own account: display name, password and email verification.
 * `children` is the slot for the PDPA panel (export my data / request deletion) built separately;
 * it renders below the account sections.
 */
export const ProfilePage: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const api = useApi();
  const user = api.user;
  // Pick up email_verified and name changes made elsewhere (e.g. the verify link in another tab).
  useEffect(() => { api.refreshUser().catch(() => undefined); }, [api.token]);

  return (
    <div>
      <div className="header-row">
        <div>
          <h1 className="header-title">โปรไฟล์ของฉัน</h1>
          <p className="header-desc">แก้ไขชื่อที่แสดง เปลี่ยนรหัสผ่าน และยืนยันอีเมลของบัญชี</p>
        </div>
      </div>
      <div style={{ display: "grid", gap: 20, maxWidth: 760 }}>
        {user && <NameSection user={user} />}
        {user && <EmailSection user={user} />}
        <PasswordSection />
        {/* PDPA panel slot: export data / request account deletion (provided by the coordinator). */}
        {children}
      </div>
    </div>
  );
};

const NameSection: React.FC<{ user: User }> = ({ user }) => {
  const api = useApi();
  const [name, setName] = useState(user.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setName(user.name), [user.name]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      setNotice(null);
      const res = await api.patch<{ message: string }>("/auth/me", { name });
      await api.refreshUser();
      setNotice(res.message);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <section className="glass-card" style={{ padding: 24 }} aria-labelledby="profile-name">
      <h2 id="profile-name" style={sectionTitle}><UserRound size={18} />ข้อมูลบัญชี</h2>
      <ErrorBox message={error} />
      {notice && <div role="status" style={noticeStyle}>{notice}</div>}
      <form onSubmit={save} style={grid2}>
        <Field label="ชื่อที่แสดง" hint="ใช้ในใบประกาศนียบัตรและรายชื่อผู้เรียน">
          <input className="form-input" required maxLength={120} autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
        </Field>
        <Field label="อีเมล (ใช้เข้าสู่ระบบ)" hint="เปลี่ยนอีเมลได้โดยติดต่อผู้ดูแลระบบ">
          <input className="form-input" value={user.email} disabled />
        </Field>
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end" }}>
          <button type="submit" className="tech-button-primary" disabled={busy || !name.trim() || name.trim() === user.name}><Save size={16} />{busy ? "กำลังบันทึก…" : "บันทึกชื่อ"}</button>
        </div>
      </form>
    </section>
  );
};

const EmailSection: React.FC<{ user: User }> = ({ user }) => {
  const { busy, message, error, resend } = useResendVerification();
  const verified = user.email_verified !== false;
  return (
    <section className="glass-card" style={{ padding: 24 }} aria-labelledby="profile-email">
      <h2 id="profile-email" style={sectionTitle}>{verified ? <BadgeCheck size={18} /> : <Mail size={18} />}การยืนยันอีเมล</h2>
      <ErrorBox message={error} />
      {message && <div role="status" style={noticeStyle}>{message}</div>}
      {verified ? (
        <p style={{ margin: 0, fontSize: 14 }}>ยืนยันอีเมล <strong>{user.email}</strong> แล้ว</p>
      ) : (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <p style={{ margin: 0, fontSize: 14, flex: "1 1 280px" }}>
            ยังไม่ได้ยืนยันอีเมล <strong>{user.email}</strong> กดลิงก์ในอีเมลที่เราส่งไป เพื่อรับการแจ้งเตือนและกู้คืนบัญชีได้
          </p>
          <button type="button" className="tech-button-outline" disabled={busy} onClick={resend}><Mail size={16} />{busy ? "กำลังส่ง…" : "ส่งลิงก์ยืนยันอีกครั้ง"}</button>
        </div>
      )}
    </section>
  );
};

const PasswordSection: React.FC = () => {
  const api = useApi();
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.next !== form.confirm) { setError("รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน"); return; }
    try {
      setBusy(true);
      setError(null);
      setNotice(null);
      const res = await api.post<{ message: string; token: string; user: User }>("/auth/change-password", { current_password: form.current, new_password: form.next });
      // Other sessions were revoked; keep this one with the fresh token.
      api.saveAuth(res.token, res.user);
      setForm({ current: "", next: "", confirm: "" });
      setNotice(res.message);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <section className="glass-card" style={{ padding: 24 }} aria-labelledby="profile-password">
      <h2 id="profile-password" style={sectionTitle}><KeyRound size={18} />เปลี่ยนรหัสผ่าน</h2>
      <ErrorBox message={error} />
      {notice && <div role="status" style={noticeStyle}>{notice}</div>}
      <form onSubmit={save} style={grid2}>
        <Field label="รหัสผ่านปัจจุบัน" span>
          <input className="form-input" type="password" required maxLength={256} autoComplete="current-password" value={form.current} onChange={e => setForm(f => ({ ...f, current: e.target.value }))} />
        </Field>
        <Field label="รหัสผ่านใหม่" hint="อย่างน้อย 12 ตัวอักษร">
          <input className="form-input" type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={form.next} onChange={e => setForm(f => ({ ...f, next: e.target.value }))} />
        </Field>
        <Field label="ยืนยันรหัสผ่านใหม่">
          <input className="form-input" type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} />
        </Field>
        <p style={{ gridColumn: "1 / -1", margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
          เมื่อเปลี่ยนรหัสผ่าน อุปกรณ์อื่นทั้งหมดจะถูกออกจากระบบ อุปกรณ์นี้ยังใช้งานต่อได้ ถ้าเข้าสู่ระบบด้วย Google หรือ GitHub และยังไม่เคยตั้งรหัสผ่าน ให้ใช้ “ลืมรหัสผ่าน?” ที่หน้าเข้าสู่ระบบ
        </p>
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end" }}>
          <button type="submit" className="tech-button-primary" disabled={busy}><KeyRound size={16} />{busy ? "กำลังบันทึก…" : "เปลี่ยนรหัสผ่าน"}</button>
        </div>
      </form>
    </section>
  );
};

/**
 * Console banner for accounts whose email is not verified yet (render it near the top of the console).
 * Hidden for verified accounts and for cached sessions that predate the email_verified field.
 * `onOpenProfile` optionally links to the profile page.
 */
export const VerifyEmailBanner: React.FC<{ onOpenProfile?: () => void }> = ({ onOpenProfile }) => {
  const api = useApi();
  const { busy, message, error, resend } = useResendVerification();
  const [hidden, setHidden] = useState(false);
  if (!api.user || api.user.email_verified !== false || hidden) return null;
  return (
    <div role="status" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "12px 16px", borderRadius: 12, marginBottom: 18,
      background: "#fff4dc", color: "#7a4b00", fontSize: 14, border: "1px solid rgba(245,158,11,0.3)" }}>
      <Mail size={18} style={{ flexShrink: 0 }} />
      <span style={{ flex: "1 1 260px" }}>{error || message || `ยืนยันอีเมล ${api.user.email} เพื่อรับการแจ้งเตือนและกู้คืนบัญชีได้ ตรวจสอบกล่องจดหมายของคุณ`}</span>
      {!message && <button type="button" className="tech-button-outline" style={{ padding: "4px 12px", fontSize: 13 }} disabled={busy} onClick={resend}>{busy ? "กำลังส่ง…" : "ส่งลิงก์อีกครั้ง"}</button>}
      {onOpenProfile && <button type="button" className="tech-button-outline" style={{ padding: "4px 12px", fontSize: 13 }} onClick={onOpenProfile}>โปรไฟล์</button>}
      <button type="button" aria-label="ซ่อน" onClick={() => setHidden(true)} style={{ background: "none", border: 0, cursor: "pointer", color: "inherit", fontSize: 18, lineHeight: 1 }}>×</button>
    </div>
  );
};
