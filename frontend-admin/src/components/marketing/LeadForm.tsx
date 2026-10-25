import React, { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "../../hooks/useApi";
import { PublicLeadForm, storedUtm } from "./runtime";

/** Cloudflare Turnstile when VITE_TURNSTILE_SITE_KEY is set; otherwise nothing (same as the website forms). */
const TURNSTILE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
export const TurnstileBox: React.FC<{ onToken: (token: string) => void }> = ({ onToken }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!TURNSTILE_KEY || !ref.current) return;
    const render = () => (window as any).turnstile?.render(ref.current, { sitekey: TURNSTILE_KEY, callback: onToken });
    if ((window as any).turnstile) { render(); return; }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }, []);
  return TURNSTILE_KEY ? <div ref={ref} /> : null;
};

const inputStyle: React.CSSProperties = { background: "#fff", borderColor: "#d9cfc5", width: "100%" };
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 14, fontWeight: 600 };

/**
 * Lead capture form rendered from the form builder's field list. Works as an embedded block
 * (<LeadFormEmbed formId>) or inside a popup. Honeypot + Turnstile + PDPA consent.
 */
export const LeadFormView: React.FC<{ form: PublicLeadForm; onDone?: () => void; compact?: boolean }> = ({ form, onDone, compact }) => {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [token, setToken] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!consent) { setError("กรุณายินยอมให้เก็บและใช้ข้อมูลตามนโยบายความเป็นส่วนตัว"); return; }
    try {
      setSending(true);
      setError(null);
      const utm = storedUtm();
      const res = await fetch(`${API_BASE_URL}/public/marketing/forms/${encodeURIComponent(form.id)}/submit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values, consent: true, website, turnstile_token: token, page_path: window.location.pathname,
          utm_source: utm.utm_source, utm_medium: utm.utm_medium, utm_campaign: utm.utm_campaign })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "ส่งข้อมูลไม่สำเร็จ กรุณาลองใหม่");
      setDone(data.message || form.success_message);
      onDone?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  if (done) {
    return <p role="status" style={{ margin: 0, padding: "14px 16px", borderRadius: 12, background: "#e8f6ee", color: "#146c43", fontSize: 15 }}>{done}</p>;
  }
  const set = (key: string, value: string | boolean) => setValues(prev => ({ ...prev, [key]: value }));
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: compact ? 12 : 14 }}>
      {error && <p role="alert" style={{ margin: 0, padding: "10px 12px", borderRadius: 12, background: "#fdecec", color: "#b42318", fontSize: 14 }}>{error}</p>}
      {form.fields.map(field => {
        const label = `${field.label}${field.required ? " *" : ""}`;
        const value = values[field.key];
        if (field.type === "checkbox") {
          return (
            <label key={field.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14 }}>
              <input type="checkbox" required={field.required} checked={value === true} onChange={e => set(field.key, e.target.checked)} style={{ marginTop: 4, width: 18, height: 18 }} />
              <span>{label}</span>
            </label>
          );
        }
        return (
          <label key={field.key} style={labelStyle}>{label}
            {field.type === "textarea" ? (
              <textarea className="form-input" style={inputStyle} rows={3} maxLength={2000} required={field.required}
                value={String(value ?? "")} onChange={e => set(field.key, e.target.value)} />
            ) : field.type === "select" ? (
              <select className="form-input" style={inputStyle} required={field.required} value={String(value ?? "")} onChange={e => set(field.key, e.target.value)}>
                <option value="">เลือก…</option>
                {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input className="form-input" style={inputStyle} type={field.type} maxLength={field.type === "email" ? 254 : 200} required={field.required}
                autoComplete={{ name: "name", email: "email", phone: "tel", company: "organization" }[field.key] ?? "off"}
                value={String(value ?? "")} onChange={e => set(field.key, e.target.value)} />
            )}
          </label>
        );
      })}
      {/* Honeypot: hidden from people, filled by naive bots. */}
      <input type="text" name="website" value={website} onChange={e => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true"
        style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }} />
      <TurnstileBox onToken={setToken} />
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, lineHeight: 1.5, color: "#4a5775" }}>
        <input type="checkbox" required checked={consent} onChange={e => setConsent(e.target.checked)} style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }} />
        <span>{form.consent_text} <a href="/privacy" target="_blank" rel="noopener">อ่านนโยบายความเป็นส่วนตัว</a></span>
      </label>
      <button type="submit" className="ps-btn ps-btn-primary ps-btn-lg" disabled={sending}>{sending ? "กำลังส่ง…" : form.submit_label}</button>
    </form>
  );
};

/** Embeddable block for site pages: loads an active form by id. */
export const LeadFormEmbed: React.FC<{ formId: string }> = ({ formId }) => {
  const [form, setForm] = useState<PublicLeadForm | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch(`${API_BASE_URL}/public/marketing/forms/${encodeURIComponent(formId)}`)
      .then(async res => { if (!res.ok) throw new Error(); setForm((await res.json()).form); })
      .catch(() => setMissing(true));
  }, [formId]);
  if (missing) return null;
  if (!form) return <p className="ps-muted">กำลังโหลดฟอร์ม…</p>;
  return (
    <section className="ps-card" style={{ padding: 24, maxWidth: 560 }} aria-label={form.title}>
      <h2 style={{ margin: "0 0 6px", fontSize: 22 }}>{form.title}</h2>
      {form.description && <p className="ps-muted" style={{ margin: "0 0 16px" }}>{form.description}</p>}
      <LeadFormView form={form} />
    </section>
  );
};
