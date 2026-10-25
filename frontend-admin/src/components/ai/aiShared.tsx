import React from "react";
import { Sparkles } from "lucide-react";

/** Shown whenever the server answered through its deterministic fallback (`mock: true`). */
export const MockNotice: React.FC<{ mock?: boolean }> = ({ mock }) => mock ? (
  <div role="status" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 99, color: "var(--warning)", background: "rgba(245,158,11,0.12)" }}>
    ผลตัวอย่าง (AI ไม่พร้อมใช้งาน)
  </div>
) : null;

export const AiBadge: React.FC<{ label?: string }> = ({ label = "สร้างโดย AI" }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 99, color: "var(--primary)", background: "var(--primary-glow)" }}>
    <Sparkles size={12} /> {label}
  </span>
);

export const AI_DISCLAIMER = "AI อาจให้ข้อมูลไม่ถูกต้อง กรุณาตรวจทานก่อนใช้งานจริง";
