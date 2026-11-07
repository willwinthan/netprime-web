import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, Send } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { Chip, Empty, ErrorBox, tableStyle, tdStyle, thStyle } from "../site-admin/ui";
import { Card, Notice } from "./shared";
import "../course/course.css"; // np-cb-btn

interface Status {
  mode: "live" | "log_only";
  sender: string;
  sender_configured: boolean;
  last_24h: { sent: number; failed: number; logged: number };
  last_sent_at: string | null;
}

interface LoggedEmail {
  id: string; to_email: string; subject: string; kind: string; status: "sent" | "failed" | "logged";
  error: string | null; attempts: number; can_retry: boolean; created_at: string;
}

const STATUS_CHIP: Record<LoggedEmail["status"], { label: string; color: string; bg: string }> = {
  sent: { label: "ส่งแล้ว", color: "var(--accent)", bg: "var(--accent-glow)" },
  failed: { label: "ส่งไม่สำเร็จ", color: "#b42318", bg: "rgba(239,68,68,0.1)" },
  logged: { label: "ยังไม่ได้ส่งจริง", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" }
};

const KIND_LABEL: Record<string, string> = {
  welcome: "ต้อนรับ", verification: "ยืนยันอีเมล", invite: "คำเชิญ", reset: "ลืมรหัสผ่าน",
  password_changed: "เปลี่ยนรหัสผ่าน", receipt: "ใบเสร็จ", reminder: "เตือนก่อนอบรม", certificate: "ใบประกาศ",
  broadcast: "ประกาศ / การตลาด", test: "ทดสอบ", general: "อื่น ๆ"
};

/** D1 timestamps are UTC without a zone; show them in Thai time. */
const thaiTime = (value: string) => new Date(value.replace(" ", "T") + "Z").toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "short", timeStyle: "short" });

/** ตั้งค่าระบบ › อีเมล: sending status, a test email and the delivery log with retry. */
export const EmailPanel: React.FC = () => {
  const api = useApi();
  const [status, setStatus] = useState<Status | null>(null);
  const [emails, setEmails] = useState<LoggedEmail[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<"" | LoggedEmail["status"]>("");
  const [query, setQuery] = useState("");
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  const loadStatus = useCallback(() => api.get<Status>("/admin/email/status").then(setStatus).catch(err => setError(err.message)), [api.token]);
  const loadLog = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page) });
    if (filter) params.set("status", filter);
    if (query.trim()) params.set("q", query.trim());
    try {
      const data = await api.get<{ emails: LoggedEmail[]; total: number }>(`/admin/email/log?${params}`);
      setEmails(data.emails);
      setTotal(data.total);
    } catch (err: any) {
      setError(err.message);
    }
  }, [api.token, page, filter, query]);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  // Search waits for typing to pause.
  useEffect(() => { const t = window.setTimeout(loadLog, 300); return () => window.clearTimeout(t); }, [loadLog]);

  const sendTest = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("test");
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<{ to: string; status: LoggedEmail["status"]; error: string | null }>("/admin/email/test", testTo.trim() ? { to: testTo.trim() } : {});
      setNotice(res.status === "sent" ? { text: `ส่งอีเมลทดสอบไปที่ ${res.to} แล้ว ตรวจกล่องจดหมาย (และโฟลเดอร์สแปม)`, tone: "ok" }
        : res.status === "logged" ? { text: "ยังไม่ได้ตั้งค่าการส่งอีเมล ระบบจึงบันทึกอีเมลไว้ใน log ของเซิร์ฟเวอร์แทนการส่งจริง", tone: "warn" }
        : { text: `ส่งไม่สำเร็จ: ${res.error ?? "ไม่ทราบสาเหตุ"}`, tone: "warn" });
      await Promise.all([loadStatus(), loadLog()]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const retry = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await api.post<{ status: string; error: string | null }>(`/admin/email/log/${id}/retry`, {});
      setNotice(res.status === "sent" ? { text: "ส่งซ้ำสำเร็จ", tone: "ok" } : { text: `ส่งซ้ำไม่สำเร็จ: ${res.error ?? ""}`, tone: "warn" });
      await Promise.all([loadStatus(), loadLog()]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const pages = Math.max(1, Math.ceil(total / 50));
  const live = status?.mode === "live";

  return (
    <div style={{ display: "grid", gap: "20px" }}>
      <ErrorBox message={error} />

      <Card title="สถานะการส่งอีเมล" description="ระบบส่งอีเมลผ่าน Resend ตั้งค่าด้วย RESEND_API_KEY (secret) และ EMAIL_FROM (ผู้ส่ง) ของ Worker">
        {!status ? <p style={{ color: "var(--text-muted)", fontSize: 14 }}>กำลังโหลด...</p> : (
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Chip {...(live ? { label: "ส่งอีเมลจริง", color: "var(--accent)", bg: "var(--accent-glow)" } : { label: "ยังไม่ได้ตั้งค่า: บันทึกไว้ใน log เท่านั้น", color: "#9a5b00", bg: "rgba(245,158,11,0.14)" })} />
              <span style={{ fontSize: 14 }}>ผู้ส่ง: <strong>{status.sender}</strong>{!status.sender_configured && <span style={{ color: "var(--text-muted)" }}> (ค่าเริ่มต้น ยังไม่ได้ตั้ง EMAIL_FROM)</span>}</span>
            </div>
            {!live && (
              <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
                ผู้ใช้จะยังไม่ได้รับอีเมลลืมรหัสผ่าน คำเชิญ หรือใบเสร็จ จนกว่าจะยืนยันโดเมนผู้ส่งใน Resend และตั้ง <code>RESEND_API_KEY</code> ขั้นตอนอยู่ใน docs/CLOUDFLARE-DEPLOY.md
              </p>
            )}
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 14 }}>
              <span>24 ชั่วโมงล่าสุด: ส่งแล้ว <strong>{status.last_24h.sent}</strong></span>
              <span style={{ color: status.last_24h.failed ? "#b42318" : undefined }}>ไม่สำเร็จ <strong>{status.last_24h.failed}</strong></span>
              <span>ยังไม่ได้ส่งจริง <strong>{status.last_24h.logged}</strong></span>
              {status.last_sent_at && <span style={{ color: "var(--text-muted)" }}>ส่งล่าสุด {thaiTime(status.last_sent_at)}</span>}
            </div>
          </div>
        )}
      </Card>

      <Card title="ส่งอีเมลทดสอบ" description="ใช้ตรวจว่าตั้งค่าถูกต้อง ถ้าส่งไม่ได้ ระบบจะบอกสาเหตุจาก Resend เช่น โดเมนยังไม่ได้ยืนยัน">
        <Notice message={notice?.text ?? null} tone={notice?.tone} />
        <form onSubmit={sendTest} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input className="form-input" type="email" value={testTo} onChange={e => setTestTo(e.target.value)}
            placeholder={`ส่งถึง (เว้นว่าง = ${api.user?.email ?? "อีเมลของคุณ"})`} aria-label="อีเมลผู้รับ" style={{ flex: "1 1 260px" }} />
          <button type="submit" className="tech-button-primary" disabled={busy === "test"} style={{ borderRadius: "1rem", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Send size={15} /> {busy === "test" ? "กำลังส่ง..." : "ส่งอีเมลทดสอบ"}
          </button>
        </form>
      </Card>

      <Card title="ประวัติการส่งอีเมล" description="ทุกอีเมลที่ระบบส่งในช่วง 90 วัน อีเมลที่ล้มเหลวชั่วคราวระบบจะส่งซ้ำให้เองทุกวัน หรือกด &quot;ส่งซ้ำ&quot; ได้ภายใน 1 วัน"
        actions={<button type="button" className="tech-button-outline" onClick={() => { loadLog(); loadStatus(); }} style={{ borderRadius: "1rem", display: "inline-flex", alignItems: "center", gap: 6 }}><RefreshCw size={14} /> รีเฟรช</button>}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          <input className="form-input" type="search" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}
            placeholder="ค้นหาอีเมลผู้รับหรือหัวข้อ" aria-label="ค้นหาอีเมล" style={{ flex: "1 1 240px" }} />
          <select className="form-input" value={filter} onChange={e => { setFilter(e.target.value as typeof filter); setPage(1); }} aria-label="สถานะ" style={{ width: "auto" }}>
            <option value="">ทุกสถานะ</option>
            <option value="failed">ส่งไม่สำเร็จ</option>
            <option value="sent">ส่งแล้ว</option>
            <option value="logged">ยังไม่ได้ส่งจริง</option>
          </select>
        </div>
        {emails.length === 0 ? <Empty text={query || filter ? "ไม่พบอีเมลที่ตรงกับการค้นหา" : "ยังไม่มีอีเมล"} /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>{["เวลา", "ผู้รับ", "หัวข้อ", "ประเภท", "สถานะ", ""].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {emails.map(m => (
                  <tr key={m.id}>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{thaiTime(m.created_at)}</td>
                    <td style={{ ...tdStyle, wordBreak: "break-all" }}>{m.to_email}</td>
                    <td style={tdStyle}>
                      {m.subject}
                      {m.error && <div style={{ fontSize: 12, color: "#b42318", marginTop: 4 }}>{m.error}{m.attempts > 1 ? ` (ลอง ${m.attempts} ครั้ง)` : ""}</div>}
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{KIND_LABEL[m.kind] ?? m.kind}</td>
                    <td style={tdStyle}><Chip {...STATUS_CHIP[m.status]} /></td>
                    <td style={tdStyle}>
                      {m.can_retry && (
                        <button type="button" className="np-cb-btn" onClick={() => retry(m.id)} disabled={busy === m.id}>{busy === m.id ? "กำลังส่ง..." : "ส่งซ้ำ"}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", marginTop: 12, fontSize: 13 }}>
            <button type="button" className="np-cb-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>ก่อนหน้า</button>
            <span>หน้า {page} / {pages} ({total.toLocaleString("th-TH")} ฉบับ)</span>
            <button type="button" className="np-cb-btn" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>ถัดไป</button>
          </div>
        )}
      </Card>
    </div>
  );
};
