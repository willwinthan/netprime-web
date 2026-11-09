import React, { useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import { useApi, User } from "../../hooks/useApi";
import { ErrorBox, Field } from "../site-admin/ui";
import logo from "../../../logo/NetPrimeLogo.png";

/**
 * Shown instead of the console while the account still has a password someone else chose
 * (users.must_change_password). The API refuses every other route until this succeeds.
 */
export const ForcePasswordChange: React.FC = () => {
  const api = useApi();
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.next !== form.confirm) { setError("รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน"); return; }
    try {
      setBusy(true);
      setError(null);
      const res = await api.post<{ token: string; user: User }>("/auth/change-password", { current_password: form.current, new_password: form.next });
      // The old token was revoked with every other session; keep this one with the fresh token.
      api.saveAuth(res.token, res.user);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <main style={{ minHeight: "100vh", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <section className="glass-card" style={{ width: "100%", maxWidth: 440, padding: 28 }} aria-labelledby="force-password-title">
        <img src={logo} alt="โลโก้ NetPrime" style={{ height: 32, width: "auto", marginBottom: 16 }} />
        <h1 id="force-password-title" style={{ fontSize: 22, margin: "0 0 8px", display: "flex", alignItems: "center", gap: 8 }}>
          <KeyRound size={20} />ตั้งรหัสผ่านของคุณ
        </h1>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: "0 0 16px", lineHeight: 1.5 }}>
          บัญชี {api.user?.email} ใช้รหัสผ่านชั่วคราวที่เจ้าหน้าที่ตั้งให้ กรุณาตั้งรหัสผ่านใหม่ที่มีแค่คุณรู้ก่อนเริ่มใช้งาน
        </p>
        <ErrorBox message={error} />
        <form onSubmit={save} style={{ display: "grid", gap: 12 }}>
          <Field label="รหัสผ่านชั่วคราว">
            <input className="form-input" type="password" required maxLength={256} autoComplete="current-password" autoFocus
              value={form.current} onChange={e => setForm(f => ({ ...f, current: e.target.value }))} />
          </Field>
          <Field label="รหัสผ่านใหม่" hint="อย่างน้อย 12 ตัวอักษร และต้องไม่ซ้ำกับรหัสผ่านชั่วคราว">
            <input className="form-input" type="password" required minLength={12} maxLength={256} autoComplete="new-password"
              value={form.next} onChange={e => setForm(f => ({ ...f, next: e.target.value }))} />
          </Field>
          <Field label="ยืนยันรหัสผ่านใหม่">
            <input className="form-input" type="password" required minLength={12} maxLength={256} autoComplete="new-password"
              value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} />
          </Field>
          <button type="submit" className="tech-button-primary" disabled={busy} style={{ justifyContent: "center" }}>
            <KeyRound size={16} />{busy ? "กำลังบันทึก…" : "ตั้งรหัสผ่านและเริ่มใช้งาน"}
          </button>
          <button type="button" className="tech-button-outline" onClick={() => api.logout().catch(() => undefined)} style={{ justifyContent: "center" }}>
            <LogOut size={16} />ออกจากระบบ
          </button>
        </form>
      </section>
    </main>
  );
};
