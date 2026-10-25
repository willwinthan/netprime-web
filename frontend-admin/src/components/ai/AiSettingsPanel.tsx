import React, { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Empty, ErrorBox, Field, formatDateTime, grid2, tableStyle, tdStyle, thStyle } from "../site-admin/ui";

interface AiSettings { features: Record<string, boolean>; daily_quota: number; chatbot_per_ip: number; chatbot_daily_cap: number }
interface FeatureRow { feature: string; requests: number; mock_requests: number; refused: number; input_chars: number; output_chars: number; tokens: number }
interface UserRow { user_id: string; name: string; email: string; requests: number; chars: number }
interface LogRow { id: number; feature: string; user_name: string | null; input_chars: number; output_chars: number; tokens: number | null; mock: number; status: string; created_at: string }
interface Usage { days: number; by_feature: FeatureRow[]; by_user: UserRow[]; recent: LogRow[]; daily: Array<{ day: string; requests: number }> }

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString("th-TH");

/**
 * Admin "ตั้งค่า AI": per-feature switches, per-user daily quota, chatbot limit and a usage report.
 * Needs integrations.manage (settings) / reports.view (report). Not mounted yet — the coordinator
 * wires it into the admin console.
 */
export const AiSettingsPanel: React.FC = () => {
  const api = useApi();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [labels, setLabels] = useState<Array<{ key: string; label: string }>>([]);
  const [available, setAvailable] = useState(true);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ settings: AiSettings; features: Array<{ key: string; label: string }>; ai_available: boolean }>("/admin/ai/settings")
      .then(d => { setSettings(d.settings); setLabels(d.features); setAvailable(d.ai_available); })
      .catch(err => setError(err.message));
  }, [api.token]);
  useEffect(() => {
    api.get<Usage>(`/admin/ai/usage?days=${days}`).then(setUsage).catch(err => setError(err.message));
  }, [api.token, days]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setBusy(true); setError(null); setSaved(null);
    try {
      const d = await api.request<{ settings: AiSettings }>("/admin/ai/settings", { method: "PUT", body: JSON.stringify(settings) });
      setSettings(d.settings);
      setSaved("บันทึกการตั้งค่า AI แล้ว");
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const labelOf = (key: string) => labels.find(l => l.key === key)?.label ?? key;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <ErrorBox message={error} />
      {!available && (
        <div role="status" style={{ borderLeft: "4px solid var(--warning)", background: "rgba(245,158,11,0.1)", padding: "12px 16px", borderRadius: 8, fontSize: 14 }}>
          ระบบนี้ยังไม่ได้เชื่อม Workers AI — ทุกฟีเจอร์จะตอบด้วยผลตัวอย่าง (AI ไม่พร้อมใช้งาน)
        </div>
      )}
      {settings && (
        <form onSubmit={save} className="glass-card" style={{ padding: 24 }}>
          <h3 style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><Sparkles size={18} color="var(--primary)" /> ตั้งค่าผู้ช่วย AI</h3>
          <fieldset style={{ border: "none", padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, marginBottom: 16 }}>
            <legend className="form-label" style={{ marginBottom: 8 }}>เปิด/ปิดฟีเจอร์</legend>
            {labels.map(({ key, label }) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                <input type="checkbox" checked={!!settings.features[key]} onChange={e => setSettings({ ...settings, features: { ...settings.features, [key]: e.target.checked } })} />
                {label}
              </label>
            ))}
          </fieldset>
          <div style={grid2}>
            <Field label="โควตาต่อผู้ใช้ต่อวัน (ครั้ง)" hint="นับทุกฟีเจอร์รวมกัน รีเซ็ตเที่ยงคืนเวลาไทย ผู้ดูแลระบบไม่ถูกจำกัด">
              <input className="form-input" type="number" min={0} max={10000} value={settings.daily_quota} onChange={e => setSettings({ ...settings, daily_quota: Number(e.target.value) })} />
            </Field>
            <Field label="แชทบอทเว็บไซต์: ข้อความต่อ IP ต่อ 10 นาที">
              <input className="form-input" type="number" min={1} max={1000} value={settings.chatbot_per_ip} onChange={e => setSettings({ ...settings, chatbot_per_ip: Number(e.target.value) })} />
            </Field>
            <Field label="แชทบอทเว็บไซต์: คำตอบจาก AI สูงสุดต่อวัน (ทุกคนรวมกัน)" hint="เกินจำนวนนี้ แชทบอทจะตอบจากข้อมูลบนเว็บไซต์โดยไม่เรียก AI เพื่อคุมค่าใช้จ่าย">
              <input className="form-input" type="number" min={0} max={100000} value={settings.chatbot_daily_cap ?? 500} onChange={e => setSettings({ ...settings, chatbot_daily_cap: Number(e.target.value) })} />
            </Field>
          </div>
          <button type="submit" className="tech-button-primary" disabled={busy} style={{ borderRadius: "1rem", marginTop: 12 }}>{busy ? "กำลังบันทึก..." : "บันทึก"}</button>
          {saved && <span role="status" style={{ marginLeft: 12, color: "var(--accent)", fontWeight: 600 }}>{saved}</span>}
        </form>
      )}

      <div className="glass-card" style={{ padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <h3>รายงานการใช้งาน AI</h3>
          <select className="form-input" style={{ width: "auto" }} value={days} onChange={e => setDays(Number(e.target.value))} aria-label="ช่วงเวลา">
            <option value={1}>วันนี้</option><option value={7}>7 วัน</option><option value={30}>30 วัน</option><option value={90}>90 วัน</option>
          </select>
        </div>
        {!usage ? <Empty text="กำลังโหลด..." /> : usage.by_feature.length === 0 ? <Empty text="ยังไม่มีการใช้งานในช่วงนี้" /> : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table style={tableStyle}>
                <thead><tr><th style={thStyle}>ฟีเจอร์</th><th style={thStyle}>คำขอ</th><th style={thStyle}>ผลตัวอย่าง</th><th style={thStyle}>ปฏิเสธ</th><th style={thStyle}>ตัวอักษร (เข้า/ออก)</th><th style={thStyle}>โทเค็น</th></tr></thead>
                <tbody>
                  {usage.by_feature.map(r => (
                    <tr key={r.feature}>
                      <td style={tdStyle}>{labelOf(r.feature)}</td><td style={tdStyle}>{n(r.requests)}</td><td style={tdStyle}>{n(r.mock_requests)}</td>
                      <td style={tdStyle}>{n(r.refused)}</td><td style={tdStyle}>{n(r.input_chars)} / {n(r.output_chars)}</td><td style={tdStyle}>{n(r.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h4 style={{ margin: "20px 0 8px" }}>ผู้ใช้ที่ใช้งานมากที่สุด</h4>
            {usage.by_user.length === 0 ? <Empty text="มีเฉพาะการใช้งานแชทบอทสาธารณะ" /> : (
              <div style={{ overflowX: "auto" }}>
                <table style={tableStyle}>
                  <thead><tr><th style={thStyle}>ผู้ใช้</th><th style={thStyle}>คำขอ</th><th style={thStyle}>ตัวอักษรรวม</th></tr></thead>
                  <tbody>{usage.by_user.map(u => (
                    <tr key={u.user_id}><td style={tdStyle}>{u.name}<div style={{ fontSize: 12, color: "var(--text-muted)" }}>{u.email}</div></td><td style={tdStyle}>{n(u.requests)}</td><td style={tdStyle}>{n(u.chars)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <h4 style={{ margin: "20px 0 8px" }}>บันทึกล่าสุด</h4>
            <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto" }}>
              <table style={tableStyle}>
                <thead><tr><th style={thStyle}>เวลา</th><th style={thStyle}>ฟีเจอร์</th><th style={thStyle}>ผู้ใช้</th><th style={thStyle}>ตัวอักษร</th><th style={thStyle}>สถานะ</th></tr></thead>
                <tbody>{usage.recent.map(r => (
                  <tr key={r.id}>
                    <td style={tdStyle}>{formatDateTime(r.created_at)}</td><td style={tdStyle}>{labelOf(r.feature)}</td>
                    <td style={tdStyle}>{r.user_name ?? "ผู้เยี่ยมชมเว็บไซต์"}</td><td style={tdStyle}>{n(r.input_chars)} / {n(r.output_chars)}</td>
                    <td style={tdStyle}>{r.status === "refused" ? "ปฏิเสธ (นอกเรื่อง)" : r.mock ? "ผลตัวอย่าง" : "AI"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>ระบบเก็บเฉพาะจำนวนตัวอักษรและสถานะ ไม่เก็บข้อความคำถามหรือคำตอบ</p>
          </>
        )}
      </div>
    </div>
  );
};
