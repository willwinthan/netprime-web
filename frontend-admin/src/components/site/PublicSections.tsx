import React, { useEffect, useRef, useState } from "react";
import { CalendarDays, Clock, MapPin, Phone, Mail, MessageCircle, Megaphone, ArrowRight, CheckCircle, X } from "lucide-react";
import { API_BASE_URL } from "../../hooks/useApi";
import { MODE_LABEL, SessionMode, formatBaht, formatDate, formatDateRange } from "../site-admin/ui";

// ==========================================
// Public data access (no authentication)
// ==========================================

export interface PublicSettings {
  phone: string | null; email: string | null; line: string | null; address: string | null; hours: string | null;
  map_url: string | null; facebook_url: string | null;
  announcement: { active: boolean; text: string | null; link: string | null };
}
export interface PublicPromotion { id: string; title: string; description: string | null; voucher_code: string | null; link_url: string | null; image_url: string | null; ends_at: string | null }
export interface PublicSession {
  id: string; title: string; vendor: string | null; description: string | null; start_date: string; end_date: string;
  time_text: string | null; mode: SessionMode; location: string | null; instructor_name: string | null; price: number;
  registration_deadline: string; seats_left: number; registration_open: boolean; waitlist: boolean;
}
interface PublicArticle { id: string; slug: string; title: string; category: string | null; excerpt: string | null; cover_url: string | null; published_at: string; body?: string }

export async function publicGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/public${path}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "โหลดข้อมูลไม่สำเร็จ");
  return data as T;
}

export async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/public${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "ส่งข้อมูลไม่สำเร็จ กรุณาลองใหม่");
  return data as T;
}

/** Site settings and promotions are shared by several sections; fetch once per page load. */
let sitePromise: Promise<{ settings: PublicSettings; promotions: PublicPromotion[] }> | null = null;
export function usePublicSite() {
  const [site, setSite] = useState<{ settings: PublicSettings; promotions: PublicPromotion[] } | null>(null);
  useEffect(() => {
    sitePromise ??= publicGet<{ settings: PublicSettings; promotions: PublicPromotion[] }>("/site").catch(error => { sitePromise = null; throw error; });
    sitePromise.then(setSite).catch(() => setSite(null));
  }, []);
  return site;
}

const sectionStyle: React.CSSProperties = { borderTop: "1px solid rgba(0,0,0,0.05)", paddingTop: "48px", scrollMarginTop: "96px" };
const eyebrow: React.CSSProperties = { display: "inline-block", fontSize: "12px", fontWeight: 700, letterSpacing: "0.08em", color: "var(--primary)", background: "var(--primary-glow)", padding: "5px 12px", borderRadius: "99px" };
const card: React.CSSProperties = { background: "var(--bg-card)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.7)", borderRadius: "1.5rem", boxShadow: "var(--shadow-lg)" };

const SectionHead: React.FC<{ tag: string; title: string; text?: string }> = ({ tag, title, text }) => (
  <div style={{ textAlign: "center", maxWidth: "720px", margin: "0 auto 32px" }}>
    <span style={eyebrow}>{tag}</span>
    <h2 style={{ fontSize: "32px", fontWeight: 800, margin: "12px 0 8px" }}>{title}</h2>
    {text && <p style={{ color: "var(--text-secondary)" }}>{text}</p>}
  </div>
);

const Notice: React.FC<{ tone: "error" | "success"; children: React.ReactNode }> = ({ tone, children }) => (
  <div role={tone === "error" ? "alert" : "status"} style={{
    padding: "12px 16px", borderRadius: "12px", fontSize: "14px", marginBottom: "12px",
    background: tone === "error" ? "rgba(239,68,68,0.08)" : "var(--accent-glow)", color: tone === "error" ? "var(--danger)" : "var(--accent)"
  }}>{children}</div>
);

// ==========================================
// Header extras: announcement bar + contact strip
// ==========================================

export const SiteTopBar: React.FC<{ onNavigate?: (target: string) => void }> = ({ onNavigate }) => {
  const site = usePublicSite();
  if (!site) return null;
  const { settings } = site;
  const ann = settings.announcement;
  const follow = (link: string | null) => {
    if (!link) return;
    if (link.startsWith("#")) onNavigate?.(link.slice(1));
    else window.open(link, link.startsWith("/") ? "_self" : "_blank", "noopener");
  };
  return (
    <div style={{ marginBottom: "8px" }}>
      {ann.active && ann.text && (
        <button onClick={() => follow(ann.link)} style={{ width: "100%", border: "none", cursor: ann.link ? "pointer" : "default", background: "linear-gradient(90deg, var(--primary), #f08a4b)", color: "#fff", padding: "10px 16px", borderRadius: "1rem", fontSize: "14px", fontWeight: 600, display: "flex", gap: "8px", alignItems: "center", justifyContent: "center", marginBottom: "8px" }}>
          <Megaphone size={16} />{ann.text}{ann.link && <ArrowRight size={14} />}
        </button>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "18px", flexWrap: "wrap", fontSize: "13px", color: "var(--text-secondary)" }}>
        {settings.phone && <a href={`tel:${settings.phone}`} style={{ color: "inherit", display: "flex", gap: "6px", alignItems: "center" }}><Phone size={13} />{settings.phone}</a>}
        {settings.email && <a href={`mailto:${settings.email}`} style={{ color: "inherit", display: "flex", gap: "6px", alignItems: "center" }}><Mail size={13} />{settings.email}</a>}
        {settings.line && <span style={{ display: "flex", gap: "6px", alignItems: "center" }}><MessageCircle size={13} />LINE {settings.line}</span>}
        {settings.hours && <span style={{ display: "flex", gap: "6px", alignItems: "center" }}><Clock size={13} />{settings.hours}</span>}
      </div>
    </div>
  );
};

// ==========================================
// Training schedule + registration
// ==========================================

export const ScheduleSection: React.FC<{ limit?: number; onViewAll?: () => void }> = ({ limit, onViewAll }) => {
  const [data, setData] = useState<{ sessions: PublicSession[]; vendors: string[] } | null>(null);
  const [vendor, setVendor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState<PublicSession | null>(null);

  const load = () => publicGet<{ sessions: PublicSession[]; vendors: string[] }>(`/sessions${vendor ? `?vendor=${encodeURIComponent(vendor)}` : ""}`)
    .then(d => { setData(d); setError(null); }).catch(err => setError(err.message));
  useEffect(() => { load(); }, [vendor]);

  const sessions = data ? (limit ? data.sessions.slice(0, limit) : data.sessions) : [];
  return (
    <section id="schedule" style={sectionStyle}>
      <SectionHead tag="ตารางอบรม" title="รอบอบรมที่กำลังจะเปิด" text="เลือกรอบที่สะดวกแล้วลงทะเบียนได้ทันที ที่นั่งมีจำกัดในแต่ละรอบ" />
      {data && data.vendors.length > 1 && (
        <div style={{ display: "flex", gap: "8px", justifyContent: "center", flexWrap: "wrap", marginBottom: "20px" }}>
          {["", ...data.vendors].map(v => (
            <button key={v || "all"} onClick={() => setVendor(v)} className={vendor === v ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "6px 16px", fontSize: "13px", borderWidth: "1px" }}>{v || "ทั้งหมด"}</button>
          ))}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <p style={{ textAlign: "center", color: "var(--text-muted)" }}>กำลังโหลดตารางอบรม…</p>}
      {data && sessions.length === 0 && <p style={{ textAlign: "center", color: "var(--text-muted)", padding: "24px" }}>ยังไม่มีรอบอบรมที่เปิดรับสมัคร ติดต่อเจ้าหน้าที่เพื่อสอบถามรอบถัดไป</p>}
      <div style={{ display: "grid", gap: "14px" }}>
        {sessions.map(s => (
          <article key={s.id} style={{ ...card, padding: "20px 24px", display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1.4fr) auto", gap: "16px", alignItems: "center" }} className="schedule-row">
            <div>
              <div style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: 600 }}>{s.vendor}</div>
              <h3 style={{ fontSize: "18px", margin: "2px 0 4px" }}>{s.title}</h3>
              {s.description && <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{s.description}</p>}
            </div>
            <div style={{ fontSize: "14px", color: "var(--text-secondary)", display: "grid", gap: "4px" }}>
              <span style={{ display: "flex", gap: "8px", alignItems: "center" }}><CalendarDays size={14} />{formatDateRange(s.start_date, s.end_date)}</span>
              {s.time_text && <span style={{ display: "flex", gap: "8px", alignItems: "center" }}><Clock size={14} />{s.time_text}</span>}
              <span style={{ display: "flex", gap: "8px", alignItems: "center" }}><MapPin size={14} />{MODE_LABEL[s.mode]}{s.location ? ` · ${s.location}` : ""}</span>
            </div>
            <div style={{ textAlign: "right", display: "grid", gap: "8px", justifyItems: "end" }}>
              <strong style={{ fontSize: "20px" }}>{formatBaht(s.price)}</strong>
              <SeatsLabel session={s} />
              <button className={s.registration_open ? "tech-button-primary" : "tech-button-outline"} disabled={!s.registration_open}
                onClick={() => setRegistering(s)} style={{ padding: "8px 18px" }}>
                {!s.registration_open ? "ปิดรับสมัคร" : s.waitlist ? "ลงชื่อรอคิว" : "ลงทะเบียน"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {limit && data && data.sessions.length > limit && onViewAll && (
        <p style={{ textAlign: "center", marginTop: "20px" }}><button className="tech-button-outline" onClick={onViewAll}>ดูตารางอบรมทั้งหมด ({data.sessions.length} รอบ)</button></p>
      )}
      {registering && <RegisterModal session={registering} onClose={() => setRegistering(null)} onDone={load} />}
    </section>
  );
};

const SeatsLabel: React.FC<{ session: PublicSession }> = ({ session }) => {
  if (!session.registration_open) return <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>ปิดรับสมัคร</span>;
  if (session.seats_left === 0) return <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--danger)" }}>เต็มแล้ว · รับรอคิว</span>;
  const low = session.seats_left <= 3;
  return <span style={{ fontSize: "12px", fontWeight: 600, padding: "2px 10px", borderRadius: "99px", color: low ? "var(--primary)" : "var(--accent)", background: low ? "var(--primary-glow)" : "var(--accent-glow)" }}>
    เหลือ {session.seats_left} ที่นั่ง
  </span>;
};

/** Renders Cloudflare Turnstile when VITE_TURNSTILE_SITE_KEY is configured; otherwise nothing. */
const TURNSTILE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const Turnstile: React.FC<{ onToken: (token: string) => void }> = ({ onToken }) => {
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
  return TURNSTILE_KEY ? <div ref={ref} style={{ gridColumn: "1 / -1" }} /> : null;
};

const inputStyle: React.CSSProperties = { width: "100%" };
const FormField: React.FC<{ label: string; span?: boolean; children: React.ReactNode }> = ({ label, span, children }) => (
  <label style={{ display: "grid", gap: "6px", fontSize: "13px", fontWeight: 600, gridColumn: span ? "1 / -1" : undefined }}>{label}{children}</label>
);
const formGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px" };

/** Exported for the calendar view on /schedule (site/ScheduleCalendar.tsx). */
export const RegisterModal: React.FC<{ session: PublicSession; onClose: () => void; onDone: () => void }> = ({ session, onClose, onDone }) => {
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", attendees: 1, note: "", invoice_required: false, tax_id: "", billing_address: "", consent: false, website: "", turnstile_token: "" });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [key]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSending(true);
      setError(null);
      const res = await publicPost<{ message: string }>(`/sessions/${session.id}/register`, { ...form, attendees: Number(form.attendees) });
      setResult(res.message);
      onDone();
    } catch (err: any) { setError(err.message); } finally { setSending(false); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={`ลงทะเบียน ${session.title}`} onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", backdropFilter: "blur(8px)", zIndex: 10000, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "40px 16px", overflowY: "auto" }}>
      <div onClick={e => e.stopPropagation()} style={{ ...card, background: "#fff", width: "100%", maxWidth: "640px", padding: "28px", position: "relative" }}>
        <button onClick={onClose} aria-label="ปิด" style={{ position: "absolute", top: 16, right: 16, background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}><X size={20} /></button>
        {result ? (
          <div style={{ textAlign: "center", padding: "24px 8px" }}>
            <CheckCircle size={48} color="var(--accent)" />
            <h2 style={{ fontSize: "22px", margin: "12px 0 8px" }}>{result}</h2>
            <p style={{ color: "var(--text-secondary)" }}>เราส่งอีเมลยืนยันการรับใบสมัครไปที่ {form.email}</p>
            <button className="tech-button-primary" style={{ marginTop: "20px" }} onClick={onClose}>ปิด</button>
          </div>
        ) : <>
          <span style={eyebrow}>{session.waitlist ? "ลงชื่อรอคิว" : "ลงทะเบียนอบรม"}</span>
          <h2 style={{ fontSize: "22px", margin: "10px 0 4px", paddingRight: "28px" }}>{session.title}</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "14px", marginBottom: "16px" }}>
            {formatDateRange(session.start_date, session.end_date)}{session.time_text ? ` · ${session.time_text}` : ""} · {MODE_LABEL[session.mode]} · {formatBaht(session.price)}/ท่าน
            <br />ปิดรับสมัคร {formatDate(session.registration_deadline)}
          </p>
          {session.waitlist && <Notice tone="error">ที่นั่งรอบนี้เต็มแล้ว ระบบจะบันทึกคุณในรายชื่อรอคิว และแจ้งเมื่อมีที่ว่าง</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
          <form onSubmit={submit} style={formGrid}>
            <FormField label="ชื่อ-นามสกุล *"><input className="form-input" style={inputStyle} required maxLength={120} value={form.name} onChange={set("name")} autoComplete="name" /></FormField>
            <FormField label="บริษัท / หน่วยงาน"><input className="form-input" style={inputStyle} maxLength={160} value={form.company} onChange={set("company")} autoComplete="organization" /></FormField>
            <FormField label="อีเมล *"><input className="form-input" style={inputStyle} type="email" required maxLength={254} value={form.email} onChange={set("email")} autoComplete="email" /></FormField>
            <FormField label="เบอร์โทร *"><input className="form-input" style={inputStyle} type="tel" required maxLength={30} value={form.phone} onChange={set("phone")} autoComplete="tel" /></FormField>
            <FormField label="จำนวนผู้เข้าอบรม *"><input className="form-input" style={inputStyle} type="number" min={1} max={50} required value={form.attendees} onChange={set("attendees")} /></FormField>
            <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "14px", alignSelf: "end", paddingBottom: "10px" }}>
              <input type="checkbox" checked={form.invoice_required} onChange={set("invoice_required")} />ต้องการใบกำกับภาษี
            </label>
            {form.invoice_required && <>
              <FormField label="เลขประจำตัวผู้เสียภาษี (13 หลัก) *"><input className="form-input" style={inputStyle} required inputMode="numeric" maxLength={20} value={form.tax_id} onChange={set("tax_id")} /></FormField>
              <FormField label="ที่อยู่สำหรับออกใบกำกับภาษี *" span><textarea className="form-input" style={inputStyle} required rows={2} maxLength={500} value={form.billing_address} onChange={set("billing_address")} /></FormField>
            </>}
            <FormField label="หมายเหตุ" span><textarea className="form-input" style={inputStyle} rows={2} maxLength={1000} value={form.note} onChange={set("note")} placeholder="เช่น รายชื่อผู้เข้าอบรมคนอื่น ความต้องการพิเศษ" /></FormField>
            {/* Honeypot: hidden from people, filled by naive bots. */}
            <input type="text" name="website" value={form.website} onChange={set("website")} tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }} />
            <Turnstile onToken={token => setForm(prev => ({ ...prev, turnstile_token: token }))} />
            <label style={{ gridColumn: "1 / -1", display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px", color: "var(--text-secondary)" }}>
              <input type="checkbox" required checked={form.consent} onChange={set("consent")} style={{ marginTop: "3px" }} />
              ยินยอมให้เก็บและใช้ข้อมูลนี้เพื่อติดต่อกลับเรื่องการอบรม ตามนโยบายความเป็นส่วนตัว
            </label>
            <button type="submit" className="tech-button-primary" disabled={sending} style={{ gridColumn: "1 / -1", justifyContent: "center" }}>
              {sending ? "กำลังส่ง…" : session.waitlist ? "ลงชื่อรอคิว" : "ส่งใบสมัคร"}
            </button>
            <p style={{ gridColumn: "1 / -1", fontSize: "12px", color: "var(--text-muted)", textAlign: "center" }}>ยังไม่มีการเก็บเงินในขั้นตอนนี้ เจ้าหน้าที่จะติดต่อยืนยันที่นั่งและแจ้งวิธีชำระเงิน</p>
          </form>
        </>}
      </div>
    </div>
  );
};

// ==========================================
// Promotions
// ==========================================

export const PromotionsSection: React.FC<{ onNavigate?: (target: string) => void }> = ({ onNavigate }) => {
  const site = usePublicSite();
  if (!site || site.promotions.length === 0) return null;
  return (
    <section id="promotions" style={sectionStyle}>
      <SectionHead tag="โปรโมชั่น" title="ข้อเสนอพิเศษตอนนี้" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "20px" }}>
        {site.promotions.map(p => (
          <div key={p.id} style={{ ...card, overflow: "hidden" }}>
            {p.image_url && <img src={p.image_url} alt="" style={{ width: "100%", height: "150px", objectFit: "cover" }} />}
            <div style={{ padding: "20px" }}>
              <h3 style={{ fontSize: "18px" }}>{p.title}</h3>
              {p.description && <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: "6px 0 12px" }}>{p.description}</p>}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                {p.voucher_code ? <code style={{ background: "var(--primary-glow)", color: "var(--primary)", padding: "4px 10px", borderRadius: "8px", fontWeight: 700 }}>{p.voucher_code}</code> : <span />}
                {p.ends_at && <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>ถึง {formatDate(p.ends_at)}</span>}
              </div>
              {p.link_url && (
                <button className="tech-button-outline" style={{ marginTop: "14px", padding: "6px 14px", fontSize: "13px" }}
                  onClick={() => p.link_url!.startsWith("#") ? onNavigate?.(p.link_url!.slice(1)) : window.open(p.link_url!, "_blank", "noopener")}>
                  ดูรายละเอียด <ArrowRight size={14} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

// ==========================================
// Articles
// ==========================================

export const ArticlesSection: React.FC<{ limit?: number; onViewAll?: () => void }> = ({ limit = 12, onViewAll }) => {
  const [data, setData] = useState<{ articles: PublicArticle[]; categories: string[]; total: number } | null>(null);
  const [category, setCategory] = useState("");
  const [open, setOpen] = useState<PublicArticle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    publicGet<{ articles: PublicArticle[]; categories: string[]; total: number }>(`/articles?limit=${limit}${category ? `&category=${encodeURIComponent(category)}` : ""}`)
      .then(setData).catch(err => setError(err.message));
  }, [category, limit]);

  const read = async (article: PublicArticle) => {
    try { setOpen((await publicGet<{ article: PublicArticle }>(`/articles/${article.slug}`)).article); }
    catch (err: any) { setError(err.message); }
  };

  if (data && data.total === 0 && !category) return null;
  return (
    <section id="articles" style={sectionStyle}>
      <SectionHead tag="บทความและข่าวสาร" title="อัปเดตความรู้ด้านไอที" />
      {data && data.categories.length > 1 && (
        <div style={{ display: "flex", gap: "8px", justifyContent: "center", flexWrap: "wrap", marginBottom: "20px" }}>
          {["", ...data.categories].map(c => (
            <button key={c || "all"} onClick={() => setCategory(c)} className={category === c ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "6px 16px", fontSize: "13px", borderWidth: "1px" }}>{c || "ทั้งหมด"}</button>
          ))}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "20px" }}>
        {data?.articles.map(a => (
          <button key={a.id} onClick={() => read(a)} style={{ ...card, overflow: "hidden", padding: 0, textAlign: "left", cursor: "pointer", border: "1px solid rgba(255,255,255,0.7)" }}>
            {a.cover_url
              ? <img src={a.cover_url} alt="" style={{ width: "100%", height: "140px", objectFit: "cover", display: "block" }} />
              : <div style={{ height: "140px", display: "grid", placeItems: "center", background: "linear-gradient(135deg, var(--primary), hsl(265, 80%, 66%))", color: "#fff", fontWeight: 800, fontSize: "22px" }}>{a.category || "NetPrime"}</div>}
            <div style={{ padding: "18px" }}>
              <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>{[a.category, formatDate(a.published_at)].filter(Boolean).join(" · ")}</div>
              <h3 style={{ fontSize: "15px", marginBottom: "6px", color: "var(--text-primary)" }}>{a.title}</h3>
              {a.excerpt && <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{a.excerpt}</p>}
            </div>
          </button>
        ))}
      </div>
      {onViewAll && data && data.total > (data.articles.length) && (
        <p style={{ textAlign: "center", marginTop: "20px" }}><button className="tech-button-outline" onClick={onViewAll}>ดูบทความทั้งหมด</button></p>
      )}
      {open && (
        <div role="dialog" aria-modal="true" aria-label={open.title} onClick={() => setOpen(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", backdropFilter: "blur(8px)", zIndex: 10000, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "40px 16px", overflowY: "auto" }}>
          <article onClick={e => e.stopPropagation()} style={{ ...card, background: "#fff", width: "100%", maxWidth: "760px", overflow: "hidden", position: "relative" }}>
            <button onClick={() => setOpen(null)} aria-label="ปิด" style={{ position: "absolute", top: 14, right: 14, background: "rgba(255,255,255,0.9)", border: "none", borderRadius: "99px", padding: "6px", cursor: "pointer" }}><X size={18} /></button>
            {open.cover_url && <img src={open.cover_url} alt="" style={{ width: "100%", maxHeight: "320px", objectFit: "cover", display: "block" }} />}
            <div style={{ padding: "28px" }}>
              <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>{[open.category, formatDate(open.published_at)].filter(Boolean).join(" · ")}</div>
              <h2 style={{ fontSize: "26px", margin: "8px 0 16px" }}>{open.title}</h2>
              {/* Plain-text body rendered as paragraphs; no HTML is interpreted. */}
              {(open.body || "").split(/\n\s*\n/).map((para, i) => <p key={i} style={{ marginBottom: "14px", whiteSpace: "pre-wrap", lineHeight: 1.8 }}>{para}</p>)}
            </div>
          </article>
        </div>
      )}
    </section>
  );
};

// ==========================================
// Contact
// ==========================================

export const ContactSection: React.FC = () => {
  const site = usePublicSite();
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", topic: "", message: "", consent: false, website: "", turnstile_token: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(prev => ({ ...prev, [key]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSending(true);
      setError(null);
      setDone((await publicPost<{ message: string }>("/inquiries", form)).message);
      setForm(prev => ({ ...prev, message: "", topic: "" }));
    } catch (err: any) { setError(err.message); } finally { setSending(false); }
  };
  const s = site?.settings;
  const channels: Array<[React.ReactNode, string, string | null | undefined, string?]> = [
    [<Phone size={18} />, "โทรศัพท์", s?.phone, s?.phone ? `tel:${s.phone}` : undefined],
    [<Mail size={18} />, "อีเมล", s?.email, s?.email ? `mailto:${s.email}` : undefined],
    [<MessageCircle size={18} />, "LINE Official", s?.line],
    [<MapPin size={18} />, "ที่อยู่", s?.address, s?.map_url || undefined],
    [<Clock size={18} />, "เวลาทำการ", s?.hours]
  ];
  return (
    <section id="contact" style={sectionStyle}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "32px" }}>
        <div>
          <span style={eyebrow}>ติดต่อเรา</span>
          <h2 style={{ fontSize: "32px", fontWeight: 800, margin: "12px 0" }}>สนใจหลักสูตรอบรม หรือสอบถามเพิ่มเติม?</h2>
          <p style={{ color: "var(--text-secondary)", marginBottom: "20px" }}>ทิ้งข้อมูลไว้ เจ้าหน้าที่จะติดต่อกลับภายใน 1 วันทำการ</p>
          <div style={{ display: "grid", gap: "14px" }}>
            {channels.filter(([, , value]) => value).map(([icon, label, value, href]) => (
              <div key={label} style={{ display: "flex", gap: "14px", alignItems: "center" }}>
                <div style={{ width: 44, height: 44, borderRadius: 14, display: "grid", placeItems: "center", background: "var(--primary-glow)", color: "var(--primary)", flex: "none" }}>{icon}</div>
                <div><div style={{ fontSize: "13px", color: "var(--text-muted)" }}>{label}</div>
                  {href ? <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" style={{ color: "var(--text-primary)" }}>{value}</a> : <span>{value}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
        <form onSubmit={submit} className="site-form" style={{ ...card, padding: "28px", ...formGrid, position: "relative" }}>
          {done && <div style={{ gridColumn: "1 / -1" }}><Notice tone="success">{done}</Notice></div>}
          {error && <div style={{ gridColumn: "1 / -1" }}><Notice tone="error">{error}</Notice></div>}
          <FormField label="ชื่อ-นามสกุล *"><input className="form-input" required maxLength={120} value={form.name} onChange={set("name")} autoComplete="name" /></FormField>
          <FormField label="บริษัท / หน่วยงาน"><input className="form-input" maxLength={160} value={form.company} onChange={set("company")} autoComplete="organization" /></FormField>
          <FormField label="อีเมล *"><input className="form-input" type="email" required maxLength={254} value={form.email} onChange={set("email")} autoComplete="email" /></FormField>
          <FormField label="เบอร์โทร"><input className="form-input" type="tel" maxLength={30} value={form.phone} onChange={set("phone")} autoComplete="tel" /></FormField>
          <FormField label="เรื่องที่สนใจ" span>
            <select className="form-input" value={form.topic} onChange={set("topic")}>
              <option value="">เลือกหัวข้อ</option>
              <option>สอบถามหลักสูตร / รอบอบรม</option>
              <option>อบรม In-house สำหรับองค์กร</option>
              <option>ขอใบเสนอราคา</option>
              <option>บริการที่ปรึกษา / ติดตั้งระบบ</option>
              <option>อื่น ๆ</option>
            </select>
          </FormField>
          <FormField label="ข้อความ *" span><textarea className="form-input" required rows={4} maxLength={3000} value={form.message} onChange={set("message")} placeholder="จำนวนผู้เรียน ช่วงเวลาที่สะดวก ฯลฯ" /></FormField>
          <input type="text" name="website" value={form.website} onChange={set("website")} tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }} />
          <Turnstile onToken={token => setForm(prev => ({ ...prev, turnstile_token: token }))} />
          <label style={{ gridColumn: "1 / -1", display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px", color: "var(--text-secondary)" }}>
            <input type="checkbox" required checked={form.consent} onChange={set("consent")} style={{ marginTop: "3px" }} />
            ยินยอมให้ติดต่อกลับตามนโยบายความเป็นส่วนตัว
          </label>
          <button type="submit" className="tech-button-primary" disabled={sending} style={{ gridColumn: "1 / -1", justifyContent: "center" }}>{sending ? "กำลังส่ง…" : "ส่งข้อความ"}</button>
        </form>
      </div>
    </section>
  );
};
