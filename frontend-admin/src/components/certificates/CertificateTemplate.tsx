import React, { useEffect, useMemo, useState } from "react";
import { API_BASE_URL } from "../../hooks/useApi";
import { encodeQr, qrPath } from "./qr";

/**
 * Certificate renderer driven by a template from the website builder (website.design).
 * Used by the learner print view, the public verification page and the designer preview.
 * All text is rendered as text; images only from http(s) or site-relative URLs.
 *
 *   const template = useCertificateTemplate({ courseId });           // or { code }
 *   <CertificateTemplate config={template.config} data={...} verifyUrl={...} />
 */

export const CERT_FONTS = ["Anuphan", "IBM Plex Sans Thai", "Noto Sans Thai", "Sarabun", "Prompt", "Kanit"] as const;
type Align = "left" | "center" | "right";
export interface TextSlot { x: number; y: number; size: number; align: Align; visible: boolean }
export const SLOT_KEYS = ["logo", "title", "subtitle", "intro", "name", "body", "course", "date", "code", "verify_url"] as const;
export type SlotKey = typeof SLOT_KEYS[number];

export interface CertificateConfig {
  orientation: "landscape" | "portrait";
  background_url: string | null; logo_url: string | null; font: typeof CERT_FONTS[number]; show_border: boolean;
  colors: { primary: string; text: string; muted: string; border: string };
  texts: { title: string; subtitle: string; intro: string; body: string; issuer: string };
  slots: Record<SlotKey, TextSlot>;
  qr: { x: number; y: number; size: number; visible: boolean };
  signatures: Array<{ image_url: string | null; name: string; title: string | null }>;
  signatures_y: number;
}

export interface CertificateFields {
  certificate_code: string; issued_at: string; student_name: string; course_title: string; revoked_at?: string | null;
}

const slot = (x: number, y: number, size: number, align: Align = "center", visible = true): TextSlot => ({ x, y, size, align, visible });

/** Same as the server's DEFAULT_CERTIFICATE (backend/src/handlers/website.ts): the built-in look. */
export const DEFAULT_CERTIFICATE: CertificateConfig = {
  orientation: "landscape", background_url: null, logo_url: null, font: "Anuphan", show_border: true,
  colors: { primary: "#e56b25", text: "#0f172a", muted: "#475569", border: "#e56b25" },
  texts: {
    title: "ใบประกาศนียบัตร", subtitle: "Certificate of Completion", intro: "ขอมอบใบประกาศนียบัตรฉบับนี้เพื่อแสดงว่า",
    body: "ได้เรียนจบและผ่านการประเมินของหลักสูตร", issuer: "NetPrime"
  },
  slots: {
    logo: slot(50, 12, 18), title: slot(50, 24, 30), subtitle: slot(50, 31, 11), intro: slot(50, 39, 14), name: slot(50, 47, 32),
    body: slot(50, 58, 14), course: slot(50, 64, 22), date: slot(12, 82, 11, "left"), code: slot(12, 86, 11, "left"), verify_url: slot(12, 90, 9, "left")
  },
  qr: { x: 88, y: 84, size: 24, visible: true },
  signatures: [{ image_url: null, name: "คณะกรรมการ NetPrime", title: null }],
  signatures_y: 84
};

const safeImg = (url: string | null | undefined) =>
  url && ((url.startsWith("/") && !url.startsWith("//")) || /^https?:\/\//i.test(url)) && !url.includes("\\") ? url : null;

const THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
export function thaiLongDate(value: string): string {
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (isNaN(date.getTime())) return value;
  return `${date.getDate()} ${THAI_MONTHS[date.getMonth()]} ${date.getFullYear() + 543}`;
}

export const QrCode: React.FC<{ value: string; sizeMm?: number; size?: string | number; color?: string; label?: string }> = ({ value, sizeMm, size, color = "#000000", label }) => {
  const { path, count } = useMemo(() => {
    try {
      const modules = encodeQr(value, "M");
      return { path: qrPath(modules, 2), count: modules.length + 4 };
    } catch {
      return { path: "", count: 0 };
    }
  }, [value]);
  if (!count) return null;
  const dimension = sizeMm ? `${sizeMm}mm` : size ?? 120;
  return (
    <svg viewBox={`0 0 ${count} ${count}`} width={dimension} height={dimension} role="img" aria-label={label ?? "QR code"} shapeRendering="crispEdges" style={{ display: "block", background: "#ffffff" }}>
      <path d={path} fill={color} />
    </svg>
  );
};

/** Positions are % of the page; text sizes in pt; the QR size in mm. */
export const CertificateTemplate: React.FC<{ config?: CertificateConfig | null; data: CertificateFields; verifyUrl: string; scale?: number }> = ({ config, data, verifyUrl, scale }) => {
  const c = config ?? DEFAULT_CERTIFICATE;
  const landscape = c.orientation !== "portrait";
  const width = landscape ? 297 : 210, height = landscape ? 210 : 297;
  const font = `'${c.font}', 'Anuphan', 'Sarabun', system-ui, sans-serif`;
  const background = safeImg(c.background_url);
  const logo = safeImg(c.logo_url);
  useEffect(() => {
    if (c.font === "Anuphan" || !CERT_FONTS.includes(c.font) || document.querySelector(`link[data-np-font="${c.font}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${c.font.replace(/ /g, "+")}:wght@400;600;700;800&display=swap`;
    link.dataset.npFont = c.font;
    document.head.appendChild(link);
  }, [c.font]);

  const place = (key: SlotKey, content: React.ReactNode, style: React.CSSProperties = {}) => {
    const s = c.slots[key];
    if (!s?.visible || content === null || content === "" || content === undefined) return null;
    const shift = s.align === "center" ? "-50%" : s.align === "right" ? "-100%" : "0";
    return (
      <div key={key} style={{
        position: "absolute", left: `${s.x}%`, top: `${s.y}%`, transform: `translate(${shift}, -50%)`, textAlign: s.align,
        fontSize: `${s.size}pt`, lineHeight: 1.25, whiteSpace: "nowrap", maxWidth: s.align === "center" ? "92%" : "80%", ...style
      }}>{content}</div>
    );
  };

  const page = (
    <div className="np-certificate" style={{
      width: `${width}mm`, height: `${height}mm`, position: "relative", overflow: "hidden", boxSizing: "border-box", background: "#ffffff",
      color: c.colors.text, fontFamily: font, WebkitPrintColorAdjust: "exact", printColorAdjust: "exact"
    }}>
      {background && <img src={background} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />}
      {c.show_border && (
        <div aria-hidden="true" style={{ position: "absolute", inset: "10mm", border: `3px solid ${c.colors.border}`, outline: `1px solid ${c.colors.border}`, outlineOffset: "-7px", opacity: 0.9 }} />
      )}
      {data.revoked_at && (
        <div style={{ position: "absolute", top: "45%", left: 0, right: 0, transform: "rotate(-12deg)", textAlign: "center", fontSize: "54pt", fontWeight: 900, color: "rgba(220,38,38,0.35)", zIndex: 2 }}>
          เพิกถอนแล้ว
        </div>
      )}
      {place("logo", logo ? <img src={logo} alt="" style={{ height: `${c.slots.logo.size}mm`, width: "auto", display: "block" }} /> : <span style={{ fontWeight: 800, color: c.colors.primary, letterSpacing: "0.05em" }}>{c.texts.issuer}</span>)}
      {place("title", c.texts.title, { fontWeight: 800 })}
      {place("subtitle", c.texts.subtitle, { color: c.colors.muted, letterSpacing: "0.2em", textTransform: "uppercase" })}
      {place("intro", c.texts.intro, { color: c.colors.muted })}
      {place("name", data.student_name, { fontWeight: 800, borderBottom: `1px solid ${c.colors.muted}55`, padding: "0 10mm 2mm" })}
      {place("body", c.texts.body, { color: c.colors.muted })}
      {place("course", data.course_title, { fontWeight: 700, color: c.colors.primary, whiteSpace: "normal", width: "80%" })}
      {place("date", `วันที่ออก: ${thaiLongDate(data.issued_at)}`, { color: c.colors.muted })}
      {place("code", `รหัสตรวจสอบ: ${data.certificate_code}`, { fontFamily: "ui-monospace, Menlo, monospace", fontWeight: 700 })}
      {place("verify_url", `ตรวจสอบได้ที่ ${verifyUrl}`, { color: c.colors.muted })}
      {c.signatures.length > 0 && (
        <div style={{ position: "absolute", top: `${c.signatures_y}%`, left: "22%", right: "22%", transform: "translateY(-50%)", display: "flex", justifyContent: "space-around", gap: "8mm" }}>
          {c.signatures.map((s, i) => (
            <div key={i} style={{ textAlign: "center", minWidth: "45mm", fontSize: "10pt", color: c.colors.muted }}>
              {safeImg(s.image_url) ? <img src={safeImg(s.image_url)!} alt="" style={{ height: "14mm", width: "auto", display: "block", margin: "0 auto 1mm" }} /> : <div style={{ height: "14mm" }} />}
              <div style={{ borderTop: `1px solid ${c.colors.muted}`, paddingTop: "1.5mm", color: c.colors.text, fontWeight: 600 }}>{s.name}</div>
              {s.title && <div>{s.title}</div>}
            </div>
          ))}
        </div>
      )}
      {c.qr.visible && (
        <div style={{ position: "absolute", left: `${c.qr.x}%`, top: `${c.qr.y}%`, transform: "translate(-50%, -50%)" }}>
          <QrCode value={verifyUrl} sizeMm={c.qr.size} label={`QR ตรวจสอบใบประกาศ ${data.certificate_code}`} />
        </div>
      )}
    </div>
  );
  if (!scale || scale === 1) return page;
  // Scaled preview (designer, verification page): keeps mm layout, shrinks visually.
  return (
    <div style={{ width: `calc(${width}mm * ${scale})`, height: `calc(${height}mm * ${scale})`, overflow: "hidden" }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>{page}</div>
    </div>
  );
};

/** Template for a course (override → default → built-in) or for a certificate code (public verification page). */
export function useCertificateTemplate(target: { courseId?: string | null; code?: string | null }): { config: CertificateConfig | null; loading: boolean } {
  const [config, setConfig] = useState<CertificateConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const query = target.courseId ? `course_id=${encodeURIComponent(target.courseId)}` : target.code ? `code=${encodeURIComponent(target.code)}` : "";
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`${API_BASE_URL}/public/website/certificate-template${query ? `?${query}` : ""}`)
      .then(res => res.ok ? res.json() : Promise.reject(new Error(String(res.status))))
      .then((d: { template: { config: CertificateConfig } }) => { if (alive) setConfig(d.template.config); })
      .catch(() => { if (alive) setConfig(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [query]);
  return { config, loading };
}

/**
 * Drop-in replacement for PrintView's CertificateDocument: loads the course's template and renders it.
 * Pass courseId when known; otherwise the template is resolved from the certificate code.
 */
export const TemplatedCertificate: React.FC<{ cert: CertificateFields; verifyUrl: string; courseId?: string | null; scale?: number }> = ({ cert, verifyUrl, courseId, scale }) => {
  const { config, loading } = useCertificateTemplate({ courseId, code: courseId ? null : cert.certificate_code });
  if (loading) return <div style={{ padding: 24, color: "#64748b" }}>กำลังเตรียมใบประกาศ…</div>;
  return <CertificateTemplate config={config} data={cert} verifyUrl={verifyUrl} scale={scale} />;
};

export default CertificateTemplate;
