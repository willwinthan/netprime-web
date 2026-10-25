import React from "react";
import { API_BASE_URL } from "../../hooks/useApi";

export type FieldType = "text" | "number" | "date" | "select" | "checkbox";
export type Visibility = "signup" | "profile" | "admin";
export interface ProfileField {
  id: string; key: string; label: string; type: FieldType; options: string[];
  required: boolean; visibility: Visibility; sort_order: number; value?: string | null;
}
export interface CourseOption { id: string; title: string; status: string }
export interface TagCount { tag: string; users: number }
export interface SegmentOption { id: string; name: string }
export interface PeopleMeta {
  courses: CourseOption[]; tags: TagCount[]; segments: SegmentOption[]; fields: ProfileField[];
  canManage: boolean; canImport: boolean;
}

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "ข้อความ", number: "ตัวเลข", date: "วันที่", select: "ตัวเลือก", checkbox: "ช่องติ๊ก (ใช่/ไม่ใช่)"
};
export const VISIBILITY_LABEL: Record<Visibility, string> = {
  signup: "หน้าสมัครสมาชิกและโปรไฟล์", profile: "หน้าโปรไฟล์เท่านั้น", admin: "เฉพาะเจ้าหน้าที่"
};

export const noticeStyle: React.CSSProperties = { padding: "10px 14px", borderRadius: 10, background: "var(--accent-glow)", color: "var(--accent)", marginBottom: 14, fontSize: 14 };
export const smallButton: React.CSSProperties = { padding: "4px 12px", fontSize: 12, borderWidth: 1 };

/** Renders one custom field as a form control; the value is the stored string ("1"/"0" for checkboxes). */
export const FieldInput: React.FC<{ field: ProfileField; value: string; onChange: (value: string) => void; disabled?: boolean }> = ({ field, value, onChange, disabled }) => {
  if (field.type === "checkbox") {
    return (
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, minHeight: 42 }}>
        <input type="checkbox" checked={value === "1"} disabled={disabled} onChange={e => onChange(e.target.checked ? "1" : "0")} style={{ width: 18, height: 18 }} />
        ใช่
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <select className="form-input" value={value} disabled={disabled} required={field.required} onChange={e => onChange(e.target.value)}>
        <option value="">— เลือก —</option>
        {field.options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input className="form-input" disabled={disabled} required={field.required}
      type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
      step={field.type === "number" ? "any" : undefined} maxLength={field.type === "text" ? 500 : undefined}
      value={value} onChange={e => onChange(e.target.value)} />
  );
};

export function displayValue(field: ProfileField, value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  if (field.type === "checkbox") return value === "1" ? "ใช่" : "ไม่ใช่";
  if (field.type === "date") {
    const d = new Date(value + "T00:00:00");
    return isNaN(d.getTime()) ? value : d.toLocaleDateString("th-TH", { dateStyle: "medium" });
  }
  return value;
}

/** POSTs JSON and saves the CSV response (keeps the token out of the URL). */
export async function postForDownload(path: string, token: string | null, body: unknown, filename: string) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `ดาวน์โหลดไม่สำเร็จ (${response.status})`);
  }
  saveBlob(await response.blob(), filename);
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
