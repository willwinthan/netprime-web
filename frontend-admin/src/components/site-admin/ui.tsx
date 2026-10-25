import { createPortal } from "react-dom";
import React from "react";
import { X } from "lucide-react";
import { API_BASE_URL } from "../../hooks/useApi";

// ==========================================
// Types shared by the content console and the public site sections
// ==========================================

export type SessionMode = "classroom" | "online" | "hybrid";
export type SessionStatus = "draft" | "open" | "closed" | "cancelled";
export type RegistrationStatus = "pending" | "confirmed" | "paid" | "waitlist" | "cancelled" | "attended";

export interface AdminSession {
  id: string;
  course_id: string | null;
  title: string;
  vendor: string | null;
  description: string | null;
  start_date: string;
  end_date: string;
  time_text: string | null;
  mode: SessionMode;
  location: string | null;
  instructor_name: string | null;
  price: number;
  capacity: number;
  registration_deadline: string | null;
  status: SessionStatus;
  seats_taken: number;
  pending_count: number;
  waitlist_count: number;
}

export interface Registration {
  id: string;
  session_id: string;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  attendees: number;
  note: string | null;
  invoice_required: number;
  tax_id: string | null;
  billing_address: string | null;
  status: RegistrationStatus;
  payment_ref: string | null;
  admin_note: string | null;
  source: "web" | "admin";
  created_at: string;
  /** Linked LMS account (same email); see migrations/0014_site_ops.sql. */
  user_id?: string | null;
  reminder_sent_at?: string | null;
  account_id?: string | null;
  account_status?: "active" | "suspended" | null;
  account_last_login?: string | null;
  /** 1 when the account already has the session's online course. */
  course_access?: number | null;
}

export const MODE_LABEL: Record<SessionMode, string> = { classroom: "ห้องอบรม", online: "ออนไลน์", hybrid: "Hybrid" };

export const SESSION_STATUS: Record<SessionStatus, { label: string; color: string; bg: string }> = {
  draft: { label: "ฉบับร่าง", color: "var(--text-secondary)", bg: "rgba(100,116,139,0.12)" },
  open: { label: "เปิดรับสมัคร", color: "var(--accent)", bg: "var(--accent-glow)" },
  closed: { label: "ปิดรับสมัคร", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  cancelled: { label: "ยกเลิก", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" }
};

export const REG_STATUS: Record<RegistrationStatus, { label: string; color: string; bg: string }> = {
  pending: { label: "รอตรวจสอบ", color: "var(--primary)", bg: "var(--primary-glow)" },
  confirmed: { label: "ยืนยันแล้ว", color: "var(--secondary)", bg: "var(--secondary-glow)" },
  paid: { label: "ชำระเงินแล้ว", color: "var(--accent)", bg: "var(--accent-glow)" },
  attended: { label: "เข้าอบรมแล้ว", color: "var(--text-primary)", bg: "rgba(15,23,42,0.08)" },
  waitlist: { label: "รอคิว", color: "var(--warning)", bg: "rgba(245,158,11,0.12)" },
  cancelled: { label: "ยกเลิก", color: "var(--danger)", bg: "rgba(239,68,68,0.1)" }
};

// ==========================================
// Formatting
// ==========================================

const THAI_DATE = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const THAI_DAY_MONTH = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", timeZone: "UTC" });

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value.slice(0, 10) + "T00:00:00Z");
  return isNaN(date.getTime()) ? value : THAI_DATE.format(date);
}

export function formatDateRange(start: string, end: string): string {
  if (start === end) return formatDate(start);
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  return `${sameYear ? THAI_DAY_MONTH.format(s) : THAI_DATE.format(s)} – ${THAI_DATE.format(e)}`;
}

/** D1 CURRENT_TIMESTAMP values are UTC without a zone marker. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z"));
  return isNaN(date.getTime()) ? value : date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

export function formatBaht(value: number): string {
  return value === 0 ? "ฟรี" : `฿${value.toLocaleString("th-TH")}`;
}

// ==========================================
// Small UI building blocks
// ==========================================

export const Chip: React.FC<{ label: string; color: string; bg: string }> = ({ label, color, bg }) => (
  <span style={{ display: "inline-block", fontSize: "12px", fontWeight: 600, padding: "3px 10px", borderRadius: "99px", color, background: bg, whiteSpace: "nowrap" }}>
    {label}
  </span>
);

export const SeatBar: React.FC<{ taken: number; capacity: number }> = ({ taken, capacity }) => {
  const percent = Math.min(100, Math.round((taken / Math.max(capacity, 1)) * 100));
  const color = percent >= 100 ? "var(--danger)" : percent >= 80 ? "var(--warning)" : "var(--accent)";
  return (
    <div style={{ minWidth: "110px" }}>
      <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "4px" }}>{taken}/{capacity} ที่นั่ง</div>
      <div className="progress-bar-container" style={{ height: "6px" }}>
        <div className="progress-bar-fill" style={{ width: `${percent}%`, background: color }} />
      </div>
    </div>
  );
};

/**
 * Rendered into document.body: cards use backdrop-filter/transform, which would otherwise trap a
 * position:fixed overlay inside the card that opened it.
 */
export const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; width?: number }> = ({ title, onClose, children, width = 640 }) => createPortal(
  <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose}
    style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", backdropFilter: "blur(6px)", zIndex: 9000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
    <div className="glass-card" onClick={e => e.stopPropagation()}
      style={{ width: "100%", maxWidth: `${width}px`, background: "#fff", padding: "28px", position: "relative" }}>
      <button onClick={onClose} aria-label="ปิด" style={{ position: "absolute", top: 16, right: 16, background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}>
        <X size={20} />
      </button>
      <h2 style={{ fontSize: "20px", marginBottom: "20px", paddingRight: "32px" }}>{title}</h2>
      {children}
    </div>
  </div>,
  document.body
);

export const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode; span?: boolean }> = ({ label, hint, children, span }) => (
  <label className="form-group" style={{ display: "flex", flexDirection: "column", gap: "6px", gridColumn: span ? "1 / -1" : undefined }}>
    <span className="form-label">{label}</span>
    {children}
    {hint && <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{hint}</span>}
  </label>
);

export const ErrorBox: React.FC<{ message: string | null }> = ({ message }) => message ? (
  <div role="alert" style={{ borderLeft: "4px solid var(--danger)", background: "rgba(239,68,68,0.08)", color: "var(--danger)", padding: "12px 16px", borderRadius: "8px", marginBottom: "16px", fontSize: "14px" }}>
    {message}
  </div>
) : null;

export const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ padding: "40px", textAlign: "center", color: "var(--text-muted)", fontSize: "14px" }}>{text}</div>
);

export const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px 16px" };

export const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };
export const thStyle: React.CSSProperties = { textAlign: "left", padding: "10px 12px", fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", borderBottom: "1px solid rgba(0,0,0,0.06)", whiteSpace: "nowrap" };
export const tdStyle: React.CSSProperties = { padding: "12px", borderBottom: "1px solid rgba(0,0,0,0.05)", verticalAlign: "top" };

/** Authenticated download (CSV export) that keeps the token out of the URL. */
export async function downloadWithAuth(path: string, token: string | null, filename: string) {
  const response = await fetch(`${API_BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `ดาวน์โหลดไม่สำเร็จ (${response.status})`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function uploadImage(file: File, token: string | null): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE_URL}/admin/site/images`, {
    method: "POST", body: form, headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "อัปโหลดรูปไม่สำเร็จ");
  return data.url;
}
