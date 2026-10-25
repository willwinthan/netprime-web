import React, { useEffect, useState } from "react";
import { BellRing, Mail, MessageCircle, Smartphone } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { ErrorBox } from "../site-admin/ui";
import { pushSupported, subscribeToPush, unsubscribeFromPush, currentPushSubscription } from "./pushClient";

interface Prefs { email_marketing: boolean; email_course: boolean; push: boolean; line: boolean }
interface PrefResponse {
  preferences: Prefs;
  push: { configured: boolean; public_key: string | null; subscriptions: number };
  line: { configured: boolean; linked: boolean; linked_at: string | null; oa_id: string | null };
}

const Toggle: React.FC<{ label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({ label, hint, checked, onChange, disabled }) => (
  <label style={{ display: "flex", gap: "12px", alignItems: "flex-start", padding: "10px 0", borderBottom: "1px solid rgba(0,0,0,0.05)", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1 }}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} style={{ marginTop: "3px" }} />
    <span>
      <span style={{ display: "block", fontWeight: 600, fontSize: "14px" }}>{label}</span>
      <span style={{ display: "block", fontSize: "12px", color: "var(--text-muted)" }}>{hint}</span>
    </span>
  </label>
);

/** "การแจ้งเตือน": channel preferences, this device's web push, and LINE linking. For the profile page. */
export const NotificationPreferences: React.FC = () => {
  const api = useApi();
  const [data, setData] = useState<PrefResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deviceOn, setDeviceOn] = useState(false);
  const [lineCode, setLineCode] = useState<{ code: string; instructions: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<PrefResponse>("/me/notification-preferences").then(setData).catch(err => setError(err.message));
  useEffect(() => {
    load();
    currentPushSubscription().then(sub => setDeviceOn(!!sub)).catch(() => undefined);
  }, [api.token]);

  const save = async (changes: Partial<Prefs>) => {
    try {
      setError(null);
      const res = await api.request<{ preferences: Prefs; message: string }>("/me/notification-preferences", { method: "PUT", body: JSON.stringify(changes) });
      setData(d => d ? { ...d, preferences: res.preferences } : d);
      setNotice(res.message);
    } catch (err: any) { setError(err.message); }
  };

  const enableDevice = async () => {
    if (!data?.push.public_key) return;
    try {
      setBusy(true);
      setError(null);
      const sub = await subscribeToPush(data.push.public_key);
      await api.post("/push/subscriptions", { endpoint: sub.endpoint, keys: sub.keys });
      setDeviceOn(true);
      setNotice("เปิดการแจ้งเตือนบนอุปกรณ์นี้แล้ว");
      load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const disableDevice = async () => {
    try {
      setBusy(true);
      const endpoint = await unsubscribeFromPush();
      if (endpoint) await api.request("/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint }) });
      setDeviceOn(false);
      setNotice("ปิดการแจ้งเตือนบนอุปกรณ์นี้แล้ว");
      load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const testPush = async () => {
    try {
      const res = await api.post<{ delivered: number }>("/push/test", {});
      setNotice(res.delivered ? "ส่งการแจ้งเตือนทดสอบแล้ว" : "ยังไม่มีอุปกรณ์ที่รับการแจ้งเตือนได้");
    } catch (err: any) { setError(err.message); }
  };

  const requestLineCode = async () => {
    try {
      setError(null);
      setLineCode(await api.post("/line/link-code", {}));
    } catch (err: any) { setError(err.message); }
  };

  const unlinkLine = async () => {
    try {
      await api.request("/line/link", { method: "DELETE" });
      setNotice("ยกเลิกการเชื่อม LINE แล้ว");
      load();
    } catch (err: any) { setError(err.message); }
  };

  if (!data) return <section className="glass-card" style={{ padding: "24px" }}><ErrorBox message={error} />กำลังโหลด…</section>;
  const p = data.preferences;
  return (
    <section className="glass-card" style={{ padding: "24px" }} aria-labelledby="notif-pref-title">
      <h3 id="notif-pref-title" style={{ fontSize: "16px", display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px" }}>
        <BellRing size={18} />การแจ้งเตือน
      </h3>
      <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "12px" }}>เลือกช่องทางที่ต้องการรับข่าวสาร อีเมลสำคัญของบัญชี (เช่น รีเซ็ตรหัสผ่าน ใบเสร็จ) จะส่งเสมอ</p>
      <ErrorBox message={error} />
      {notice && <div role="status" style={{ color: "var(--accent)", fontSize: "13px", marginBottom: "10px" }}>{notice}</div>}

      <h4 style={{ fontSize: "13px", display: "flex", gap: "6px", alignItems: "center", marginTop: "8px" }}><Mail size={14} />อีเมล</h4>
      <Toggle label="อัปเดตจากคอร์สเรียน" hint="ประกาศจากผู้สอนและข่าวของคอร์สที่คุณเรียน" checked={p.email_course} onChange={v => save({ email_course: v })} />
      <Toggle label="ข่าวสารและโปรโมชั่น" hint="คอร์สใหม่ กิจกรรม และข้อเสนอพิเศษ" checked={p.email_marketing} onChange={v => save({ email_marketing: v })} />

      <h4 style={{ fontSize: "13px", display: "flex", gap: "6px", alignItems: "center", marginTop: "16px" }}><Smartphone size={14} />แจ้งเตือนบนอุปกรณ์ (Web Push)</h4>
      <Toggle label="รับการแจ้งเตือนบนอุปกรณ์" hint="ข้อความใหม่ ประกาศ และความเคลื่อนไหวในชุมชน" checked={p.push} onChange={v => save({ push: v })} disabled={!data.push.configured} />
      {!data.push.configured ? (
        <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>ระบบยังไม่เปิดใช้การแจ้งเตือนบนอุปกรณ์</p>
      ) : !pushSupported() ? (
        <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>เบราว์เซอร์นี้ไม่รองรับ (บน iPhone ให้เพิ่มเว็บไว้ที่หน้าจอโฮมก่อน)</p>
      ) : (
        <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
          {deviceOn
            ? <button type="button" className="tech-button-outline" disabled={busy} onClick={disableDevice} style={{ padding: "6px 14px", fontSize: "13px" }}>ปิดบนอุปกรณ์นี้</button>
            : <button type="button" className="tech-button-primary" disabled={busy || !p.push} onClick={enableDevice} style={{ padding: "6px 14px", fontSize: "13px" }}>เปิดบนอุปกรณ์นี้</button>}
          {data.push.subscriptions > 0 && <button type="button" className="tech-button-outline" onClick={testPush} style={{ padding: "6px 14px", fontSize: "13px" }}>ส่งทดสอบ</button>}
          <span style={{ fontSize: "12px", color: "var(--text-muted)", alignSelf: "center" }}>อุปกรณ์ที่ลงทะเบียน: {data.push.subscriptions}</span>
        </div>
      )}

      <h4 style={{ fontSize: "13px", display: "flex", gap: "6px", alignItems: "center", marginTop: "16px" }}><MessageCircle size={14} />LINE</h4>
      {!data.line.configured ? (
        <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>ระบบยังไม่ได้เชื่อม LINE Official Account</p>
      ) : (
        <>
          <Toggle label="รับการแจ้งเตือนทาง LINE" hint="ส่งเข้าแชท LINE Official Account" checked={p.line} onChange={v => save({ line: v })} disabled={!data.line.linked} />
          {data.line.linked ? (
            <button type="button" className="tech-button-outline" onClick={unlinkLine} style={{ padding: "6px 14px", fontSize: "13px", marginTop: "8px" }}>ยกเลิกการเชื่อม LINE</button>
          ) : (
            <div style={{ marginTop: "8px" }}>
              <button type="button" className="tech-button-primary" onClick={requestLineCode} style={{ padding: "6px 14px", fontSize: "13px" }}>เชื่อมบัญชี LINE</button>
              {lineCode && (
                <div style={{ marginTop: "10px", padding: "12px", borderRadius: "8px", background: "rgba(16,185,129,0.08)", fontSize: "13px" }}>
                  <div style={{ fontFamily: "monospace", fontSize: "20px", fontWeight: 700, letterSpacing: "2px" }}>{lineCode.code}</div>
                  <div style={{ marginTop: "6px" }}>{lineCode.instructions}</div>
                  <button type="button" className="tech-button-outline" onClick={load} style={{ padding: "4px 12px", fontSize: "12px", marginTop: "8px" }}>ส่งรหัสแล้ว ตรวจสอบสถานะ</button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
};
