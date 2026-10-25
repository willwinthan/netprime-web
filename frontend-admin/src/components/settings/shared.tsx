import React, { useState } from "react";
import { Copy, Check } from "lucide-react";
import { useApi } from "../../hooks/useApi";

export type Api = ReturnType<typeof useApi>;

export const put = <T,>(api: Api, path: string, body: unknown) => api.request<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const del = <T,>(api: Api, path: string) => api.request<T>(path, { method: "DELETE" });

export const Card: React.FC<{ title: string; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }> = ({ title, description, actions, children }) => (
  <section className="glass-card" style={{ padding: "24px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start", flexWrap: "wrap", marginBottom: "14px" }}>
      <div>
        <h3 style={{ fontSize: "16px", marginBottom: "4px" }}>{title}</h3>
        {description && <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: 0 }}>{description}</p>}
      </div>
      {actions && <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>{actions}</div>}
    </div>
    {children}
  </section>
);

export const Toggle: React.FC<{ checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }> = ({ checked, onChange, label, hint }) => (
  <label style={{ display: "flex", gap: "10px", alignItems: "flex-start", fontSize: "14px", cursor: "pointer" }}>
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ marginTop: "3px" }} />
    <span>{label}{hint && <span style={{ display: "block", fontSize: "12px", color: "var(--text-muted)" }}>{hint}</span>}</span>
  </label>
);

export const Notice: React.FC<{ message: string | null; tone?: "ok" | "warn" }> = ({ message, tone = "ok" }) => message ? (
  <div role="status" style={{ borderLeft: `4px solid ${tone === "ok" ? "var(--accent)" : "var(--warning)"}`, background: tone === "ok" ? "var(--accent-glow)" : "rgba(245,158,11,0.12)", padding: "10px 16px", borderRadius: "8px", marginBottom: "16px", fontSize: "14px" }}>
    {message}
  </div>
) : null;

/** A secret shown once right after creation, with a copy button. */
export const SecretOnce: React.FC<{ label: string; value: string; onDone: () => void }> = ({ label, value, onDone }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <div role="alert" style={{ border: "1px solid var(--warning)", background: "rgba(245,158,11,0.08)", borderRadius: "10px", padding: "16px", marginBottom: "16px" }}>
      <strong style={{ display: "block", marginBottom: "6px" }}>{label}</strong>
      <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: "0 0 10px" }}>คัดลอกเก็บไว้ในที่ปลอดภัยตอนนี้ ระบบเก็บไว้แบบเข้ารหัสและจะไม่แสดงค่านี้อีก</p>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <code style={{ flex: "1 1 280px", wordBreak: "break-all", background: "#fff", padding: "8px 10px", borderRadius: "6px", fontSize: "13px" }}>{value}</code>
        <button type="button" className="tech-button-outline" onClick={copy}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "คัดลอกแล้ว" : "คัดลอก"}</button>
        <button type="button" className="tech-button-primary" onClick={onDone}>เก็บแล้ว</button>
      </div>
    </div>
  );
};

/** ISO instant → value for <input type="datetime-local"> in the browser's local time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value (local time) → ISO instant with Z. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatInstant(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

export const STATUS_TONE: Record<string, { label: string; color: string; bg: string }> = {
  success: { label: "สำเร็จ", color: "var(--accent)", bg: "var(--accent-glow)" },
  pending: { label: "รอส่งซ้ำ", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  sending: { label: "กำลังส่ง", color: "var(--secondary)", bg: "var(--secondary-glow)" },
  failed: { label: "ล้มเหลว", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" }
};
