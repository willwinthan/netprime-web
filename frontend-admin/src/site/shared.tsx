import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { API_BASE_URL, useApi, User } from "../hooks/useApi";
import { usePublicSite, PublicSession } from "../components/site/PublicSections";
import { formatBaht, formatDate, formatDateRange, MODE_LABEL } from "../components/site-admin/ui";
import { Link, navigate, useLocation } from "./router";
import logo from "../../logo/NetPrimeLogo.png";
import { getLang, LanguageSwitcher, MessageKey, t, useDocumentLang, useI18n } from "../i18n";
import { useBranding } from "../components/builder/theme";
import { menuLinks, MenuLink as MenuItem, useSiteNav } from "../components/builder/siteChrome";
import { InstallAppButton } from "../pwa/pwa";
import { safeHref } from "./Markdown";
import { MarketingRuntime } from "../components/marketing/MarketingRuntime";
import { reopenConsent, sendSignupAttribution, track } from "../components/marketing/runtime";
import { Stars, useCourseRatings } from "../components/marketing/Ratings";
import { SsoLoginButton } from "../components/settings/SsoLogin";

// ==========================================
// Data types and helpers
// ==========================================

export interface Course {
  id: string;
  title: string;
  description: string | null;
  price: number;
  access_duration_days: number | null;
  lesson_count: number;
  /** Sales-page slug when the catalog provides one (falls back to id). */
  slug?: string | null;
}

export interface Article {
  id: string;
  slug: string;
  title: string;
  category: string | null;
  excerpt: string | null;
  cover_url: string | null;
  published_at: string;
  body?: string;
  content_json?: string | null;
  author_name?: string | null;
}

/** Vendor badge derived from the course title (the catalog has no vendor column). */
export function vendorOf(title: string): string {
  const t = title.toUpperCase();
  if (t.includes("AWS")) return "AWS";
  if (t.includes("AZURE") || t.includes("AZ-")) return "Azure";
  if (t.includes("CISCO") || t.includes("CCNA") || t.includes("CCNP")) return "Cisco";
  if (t.includes("ARISTA")) return "Arista";
  if (t.includes("ARUBA")) return "Aruba";
  if (t.includes("JUNIPER")) return "Juniper";
  if (t.includes("NUTANIX")) return "Nutanix";
  if (t.includes("HUAWEI")) return "Huawei";
  if (t.includes("CLOUDFLARE") || t.includes("WORKERS") || /\b(D1|R2)\b/.test(t)) return "Cloudflare";
  return "อื่น ๆ";
}

const TONES: Record<string, { bg: string; fg: string }> = {
  Cisco: { bg: "#dcebf7", fg: "#1d4ea8" },
  Aruba: { bg: "#fde3d2", fg: "#9a3f12" },
  AWS: { bg: "#fff1d6", fg: "#7a4b00" },
  VMware: { bg: "#e4e8ec", fg: "#3c4a55" },
  Juniper: { bg: "#dff3e8", fg: "#1f6b45" },
  Cloudflare: { bg: "#fde3d2", fg: "#9a3f12" }
};
export const toneOf = (key: string | null | undefined) => TONES[key || ""] || { bg: "#f1e9ff", fg: "#5b2aa6" };

/** Coordinator-entered links: "#schedule" style anchors map to the new site URLs. */
export function resolveSiteLink(link: string): string {
  const anchors: Record<string, string> = {
    "#schedule": "/schedule", "#articles": "/blog", "#blog": "/blog",
    "#courses": "/courses", "#contact": "/#contact", "#about": "/about", "#verify": "/#verify"
  };
  if (anchors[link]) return anchors[link];
  if (link.startsWith("#")) return "/" + link;
  return link;
}

export function openSiteLink(link: string) {
  const target = resolveSiteLink(link);
  if (/^https?:\/\//.test(target) && new URL(target).origin !== window.location.origin) {
    window.open(target, "_blank", "noopener");
  } else {
    navigate(target);
  }
}

/** Reading time for Thai text (no word spaces): roughly 600 characters per minute. */
export const readingMinutes = (body: string) => Math.max(1, Math.round(body.length / 600));

let coursesPromise: Promise<Course[]> | null = null;
/** Public catalog, fetched once per page load (no auth: the public listing). */
export function useCourses(): { courses: Course[] | null; error: string | null } {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    coursesPromise ??= fetch(`${API_BASE_URL}/courses`).then(async res => {
      if (!res.ok) throw new Error("โหลดรายการคอร์สไม่สำเร็จ");
      return res.json() as Promise<Course[]>;
    }).catch(err => { coursesPromise = null; throw err; });
    coursesPromise.then(setCourses).catch(err => setError(err.message));
  }, []);
  return { courses, error };
}

// ==========================================
// Site context: auth dialog + login state
// ==========================================

interface SiteContextValue {
  loggedIn: boolean;
  openAuth: (mode: "login" | "register") => void;
}
export const SiteContext = createContext<SiteContextValue>({ loggedIn: false, openAuth: () => undefined });
export const useSite = () => useContext(SiteContext);

// ==========================================
// Icons (inline, decorative)
// ==========================================

export const ArrowIcon: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const CloseIcon: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const SearchIcon: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
);

// ==========================================
// Layout
// ==========================================

const NAV: Array<{ to: string; key: MessageKey }> = [
  { to: "/courses", key: "nav.courses" },
  { to: "/schedule", key: "nav.schedule" },
  { to: "/blog", key: "nav.blog" },
  { to: "/about", key: "nav.about" }
];

/** Public legal pages (content edited in the content console; see site/LegalPage.tsx). */
export const LEGAL_LINKS: Array<{ to: string; label: string; key: MessageKey }> = [
  { to: "/privacy", label: "นโยบายความเป็นส่วนตัว", key: "legal.privacy" },
  { to: "/terms", label: "ข้อกำหนดการใช้งาน", key: "legal.terms" },
  { to: "/refund-policy", label: "นโยบายการคืนเงิน", key: "legal.refund" }
];

/** Menu link from the website builder: validated on the server, re-checked here; new_tab opens safely. */
const MenuLink: React.FC<{ item: MenuItem; current?: boolean; style?: React.CSSProperties }> = ({ item, current, style }) => {
  const href = safeHref(item.to);
  if (!href) return null;
  return item.newTab
    ? <a href={href} target="_blank" rel="noopener noreferrer" style={style}>{item.label}</a>
    : <Link to={href} aria-current={current ? "page" : undefined} style={style}>{item.label}</Link>;
};

export const SiteLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const site = usePublicSite();
  const { loggedIn, openAuth } = useSite();
  const { lang, t } = useI18n();
  const brand = useBranding();
  const siteNav = useSiteNav();
  useDocumentLang();
  const announcement = site?.settings.announcement;
  const settings = site?.settings;
  const isCurrent = (to: string) => location.pathname === to || (to !== "/" && location.pathname.startsWith(to + "/"));
  // Builder menus when available; the built-in menu otherwise (API down, first paint).
  const headerMenu: MenuItem[] = menuLinks(siteNav, "header", lang) ?? NAV.map(n => ({ to: n.to, label: t(n.key), newTab: false }));
  const footerMenu: MenuItem[] = menuLinks(siteNav, "footer", lang) ?? [];
  const year = new Date().getFullYear() + (lang === "th" ? 543 : 0);

  return (
    <div className="ps">
      <a href="#main" className="ps-sr">{t("a11y.skip")}</a>
      {announcement?.active && announcement.text && (
        announcement.link
          ? <button type="button" className="ps-announce" onClick={() => openSiteLink(announcement.link!)}>
              <span className="ps-announce-tag">{t("announce.tag")}</span><span>{announcement.text}</span><ArrowIcon size={16} />
            </button>
          : <div className="ps-announce" role="note"><span className="ps-announce-tag">{t("announce.tag")}</span><span>{announcement.text}</span></div>
      )}
      <header className="ps-header">
        <div className="ps-container ps-header-inner">
          <Link to="/" className="ps-brand">
            <img src={brand.logo || logo} alt="" />
            <span><strong>{brand.name}</strong><small>{lang === "th" && brand.tagline ? brand.tagline : t("brand.tagline")}</small></span>
          </Link>
          <nav aria-label={t("a11y.mainNav")} className="ps-nav">
            {headerMenu.map(item => <MenuLink key={item.to + item.label} item={item} current={isCurrent(item.to)} />)}
          </nav>
          <div className="ps-actions">
            <LanguageSwitcher />
            {loggedIn
              ? <Link to="/dashboard" className="ps-btn ps-btn-ghost">{t("header.dashboard")}</Link>
              : <button type="button" className="ps-btn ps-btn-ghost" onClick={() => openAuth("login")}>{t("header.login")}</button>}
            <Link to="/schedule" className="ps-btn ps-btn-primary">{t("header.register")}</Link>
          </div>
        </div>
      </header>

      <main id="main" className="ps-main-area">{children}</main>

      <footer className="ps-footer">
        <div className="ps-container ps-footer-grid">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <strong style={{ fontSize: 20 }}>{brand.name}</strong>
            <span style={{ fontSize: 14 }}>{t("brand.footer")}</span>
            {settings?.phone && <a href={`tel:${settings.phone}`} style={{ fontSize: 14 }}>{settings.phone}</a>}
            {settings?.email && <a href={`mailto:${settings.email}`} style={{ fontSize: 14 }}>{settings.email}</a>}
            {settings?.line && <span style={{ fontSize: 14 }}>LINE {settings.line}</span>}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
              <LanguageSwitcher />
              <InstallAppButton className="ps-btn ps-btn-ghost" style={{ minHeight: 36, padding: "0 14px", fontSize: 14 }} />
            </div>
          </div>
          <nav aria-label={t("footer.courses")}><strong>{t("footer.courses")}</strong><Link to="/courses">{t("footer.onlineCourses")}</Link><Link to="/schedule">{t("nav.schedule")}</Link></nav>
          <nav aria-label={t("footer.info")}><strong>{t("footer.info")}</strong><Link to="/#verify">{t("nav.verify")}</Link><Link to="/blog">{t("nav.blog")}</Link><Link to="/about">{t("nav.about")}</Link><Link to="/#contact">{t("nav.contact")}</Link></nav>
          {footerMenu.length > 0 && (
            <nav aria-label={t("footer.pages")}><strong>{t("footer.pages")}</strong>
              {footerMenu.map(item => <MenuLink key={item.to + item.label} item={item} />)}
            </nav>
          )}
          <nav aria-label={t("footer.account")}><strong>{t("footer.account")}</strong>
            {loggedIn
              ? <Link to="/dashboard">{t("header.dashboard")}</Link>
              : <>
                  <button type="button" className="ps-linkbtn" style={{ color: "#d7deec", textAlign: "left", minHeight: 0 }} onClick={() => openAuth("login")}>{t("header.login")}</button>
                  <button type="button" className="ps-linkbtn" style={{ color: "#d7deec", textAlign: "left", minHeight: 0 }} onClick={() => openAuth("register")}>{t("footer.signup")}</button>
                </>}
          </nav>
        </div>
        <div className="ps-container ps-footer-bottom" style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <span>{t("footer.copyright", { year, name: brand.name === "NetPrime" ? "NetPrime Training Center" : brand.name })}</span>
          <nav aria-label={t("footer.legal")} style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {LEGAL_LINKS.map(l => <Link key={l.to} to={l.to} style={{ color: "#d7deec" }}>{t(l.key)}</Link>)}
            <button type="button" className="ps-linkbtn" style={{ color: "#d7deec", minHeight: 0 }} onClick={reopenConsent}>ตั้งค่าคุกกี้</button>
          </nav>
        </div>
      </footer>
      <MarketingRuntime />
    </div>
  );
};

// ==========================================
// Dialog shell (Escape closes, focus moves inside)
// ==========================================

export const Dialog: React.FC<{ label: string; onClose: () => void; children: React.ReactNode; width?: number }> = ({ label, onClose, children, width }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, button:not(.ps-dialog-close), a")?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, []);
  return (
    <div className="ps-dialog-backdrop" onClick={onClose}>
      <div ref={ref} className="ps-dialog" role="dialog" aria-modal="true" aria-label={label} style={width ? { maxWidth: width } : undefined} onClick={e => e.stopPropagation()}>
        <button type="button" className="ps-dialog-close" aria-label="ปิด" onClick={onClose}><CloseIcon /></button>
        {children}
      </div>
    </div>
  );
};

// ==========================================
// Sign in / sign up (moved from the old Landing page)
// ==========================================

export const AuthDialog: React.FC<{ mode: "login" | "register"; onClose: () => void; onLogin: (token: string, user: User) => void }> = ({ mode, onClose, onLogin }) => {
  const api = useApi();
  const [view, setView] = useState<"login" | "register" | "forgot">(mode);
  const registering = view === "register";
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [providers, setProviders] = useState<Record<string, { enabled: boolean }>>({});
  const { t } = useI18n();

  useEffect(() => {
    api.get<{ providers: Record<string, { enabled: boolean }> }>("/auth/oauth/providers")
      .then(data => setProviders(data.providers)).catch(() => setProviders({}));
  }, []);

  const switchView = (next: typeof view) => { setView(next); setError(null); setNotice(null); setPassword(""); };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (view === "forgot") {
      try {
        setLoading(true);
        setError(null);
        // The server answers the same way for every address, so this never reveals whether an account exists.
        const res = await api.post<{ message: string }>("/auth/forgot-password", { email });
        setNotice(res.message);
      } catch (err: any) {
        setError(err.message || "ส่งลิงก์ไม่สำเร็จ กรุณาลองใหม่");
      } finally {
        setLoading(false);
      }
      return;
    }
    if (registering && !consent) {
      setError("กรุณายอมรับนโยบายความเป็นส่วนตัวและข้อกำหนดการใช้งานก่อนสมัครสมาชิก");
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const res = await api.post<{ token: string; user: User }>(registering ? "/auth/register" : "/auth/login",
        registering ? { email, password, name } : { email, password });
      // Referral + first-touch UTM (server keeps it once, for new accounts only).
      void sendSignupAttribution(res.token);
      if (registering) track("sign_up", { method: "email" });
      onLogin(res.token, res.user);
    } catch (err: any) {
      setError(err.message || "เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจสอบอีเมลและรหัสผ่าน");
      setLoading(false);
    }
  };

  const startOAuth = async (provider: "google" | "github" | "microsoft") => {
    try {
      setLoading(true);
      setError(null);
      const redirectUri = `${window.location.origin}/auth/callback/${provider}`;
      const data = await api.get<{ url: string; state: string }>(`/auth/oauth/${provider}/url?redirect_uri=${encodeURIComponent(redirectUri)}`);
      sessionStorage.setItem("netprime_oauth", JSON.stringify({ state: data.state, provider, redirectUri }));
      window.location.assign(data.url);
    } catch (err: any) {
      setError(err.message || "เริ่มการเข้าสู่ระบบไม่สำเร็จ");
      setLoading(false);
    }
  };

  const oauth = (["google", "github", "microsoft"] as const).filter(p => providers[p]?.enabled);
  const oauthLabel = { google: "Google", github: "GitHub", microsoft: "Microsoft" };

  return (
    <Dialog label={view === "forgot" ? t("auth.forgot") : registering ? t("auth.register") : t("auth.login")} onClose={onClose} width={440}>
      <h2 style={{ margin: "0 0 6px", fontSize: 24 }}>{view === "forgot" ? t("auth.forgot") : registering ? t("auth.createAccount") : t("auth.login")}</h2>
      <p className="ps-muted" style={{ margin: "0 0 20px", fontSize: 14 }}>
        {view === "forgot" ? t("auth.leadForgot") : t("auth.leadLogin")}
      </p>
      {error && <p role="alert" style={{ margin: "0 0 16px", padding: "10px 12px", borderRadius: 12, background: "#fdecec", color: "#b42318", fontSize: 14 }}>{error}</p>}
      {notice && <p role="status" style={{ margin: "0 0 16px", padding: "10px 12px", borderRadius: 12, background: "#e8f6ee", color: "#146c43", fontSize: 14 }}>{notice}</p>}
      {view === "forgot" ? (
        <>
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14, fontWeight: 600 }}>{t("auth.email")}
              <input className="form-input" type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} style={{ background: "#fff", borderColor: "#d9cfc5" }} />
            </label>
            <button type="submit" className="ps-btn ps-btn-primary ps-btn-lg" disabled={loading}>{loading ? t("auth.wait") : t("auth.sendReset")}</button>
          </form>
          <button type="button" className="ps-btn ps-btn-outline" style={{ width: "100%", marginTop: 12 }} disabled={loading} onClick={() => switchView("login")}>
            {t("auth.backToLogin")}
          </button>
        </>
      ) : <>
      {!registering && <SsoLoginButton disabled={loading} email={email} />}
      {oauth.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
          {oauth.map(p => (
            <button key={p} type="button" className="ps-btn ps-btn-ghost" disabled={loading} onClick={() => startOAuth(p)}>{t("auth.continueWith", { provider: oauthLabel[p] })}</button>
          ))}
          <span className="ps-muted" style={{ textAlign: "center", fontSize: 13 }}>{t("auth.orEmail")}</span>
        </div>
      )}
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {registering && (
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14, fontWeight: 600 }}>{t("auth.name")}
            <input className="form-input" required maxLength={120} autoComplete="name" value={name} onChange={e => setName(e.target.value)} style={{ background: "#fff", borderColor: "#d9cfc5" }} />
          </label>
        )}
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14, fontWeight: 600 }}>{t("auth.email")}
          <input className="form-input" type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} style={{ background: "#fff", borderColor: "#d9cfc5" }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14, fontWeight: 600 }}>{t("auth.password")}
          <input className="form-input" type="password" required minLength={registering ? 12 : 1} maxLength={256}
            autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} style={{ background: "#fff", borderColor: "#d9cfc5" }} />
          {registering && <span className="ps-muted" style={{ fontWeight: 400, fontSize: 13 }}>{t("auth.passwordHint")}</span>}
        </label>
        {!registering && (
          <button type="button" className="ps-linkbtn" style={{ alignSelf: "flex-end", fontSize: 14, minHeight: 0, marginTop: -6 }} onClick={() => switchView("forgot")}>
            {t("auth.forgotQ")}
          </button>
        )}
        {registering && (
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, lineHeight: 1.5 }}>
            <input type="checkbox" required checked={consent} onChange={e => setConsent(e.target.checked)} style={{ marginTop: 4, width: 18, height: 18, flexShrink: 0 }} />
            <span>
              {t("auth.consent", { privacy: "\u0001", terms: "\u0002" }).split(/(\u0001|\u0002)/).map((part, i) =>
                part === "\u0001" ? <a key={i} href="/privacy" target="_blank" rel="noopener">{t("legal.privacy")}</a>
                  : part === "\u0002" ? <a key={i} href="/terms" target="_blank" rel="noopener">{t("legal.terms")}</a>
                  : <React.Fragment key={i}>{part}</React.Fragment>)}
            </span>
          </label>
        )}
        <button type="submit" className="ps-btn ps-btn-primary ps-btn-lg" disabled={loading}>{loading ? t("auth.wait") : registering ? t("auth.submitRegister") : t("auth.submitLogin")}</button>
      </form>
      <button type="button" className="ps-btn ps-btn-outline" style={{ width: "100%", marginTop: 12 }} disabled={loading}
        onClick={() => switchView(registering ? "login" : "register")}>
        {registering ? t("auth.haveAccount") : t("auth.noAccount")}
      </button>
      </>}
    </Dialog>
  );
};

// ==========================================
// Courses
// ==========================================

/** Course card linking to the sales page (/courses/:id); `onOpen` is kept for older callers. */
export const CourseCard: React.FC<{ course: Course; onOpen?: () => void }> = ({ course }) => {
  const { t } = useI18n();
  const rating = useCourseRatings()[course.id];
  return (
    <Link to={`/courses/${encodeURIComponent(course.slug || course.id)}`} className="ps-card ps-course" style={{ textDecoration: "none" }}>
      <span className="ps-course-vendor">{vendorOf(course.title)}</span>
      <strong>{course.title}</strong>
      {rating && <Stars value={rating.average} count={rating.count} size={14} />}
      {course.description && <span className="ps-course-desc">{course.description}</span>}
      <span className="ps-course-foot"><span>{t("course.lessons", { count: course.lesson_count })}</span><strong>{formatBaht(course.price)}</strong></span>
    </Link>
  );
};

export const CourseDialog: React.FC<{ course: Course; onClose: () => void }> = ({ course, onClose }) => {
  const { loggedIn, openAuth } = useSite();
  const { t } = useI18n();
  return (
    <Dialog label={course.title} onClose={onClose}>
      <span className="ps-course-vendor">{vendorOf(course.title)}</span>
      <h2 style={{ margin: "6px 44px 10px 0", fontSize: 24, lineHeight: 1.3 }}>{course.title}</h2>
      {course.description && <p className="ps-muted" style={{ margin: 0, fontSize: 16 }}>{course.description}</p>}
      <dl className="ps-facts">
        <div><dt>{t("course.price")}</dt><dd>{formatBaht(course.price)}</dd></div>
        <div><dt>{t("course.lessonCount")}</dt><dd>{t("course.lessonUnit", { count: course.lesson_count })}</dd></div>
        <div><dt>{t("course.access")}</dt><dd>{course.access_duration_days ? t("course.days", { count: course.access_duration_days }) : t("course.lifetime")}</dd></div>
      </dl>
      {course.price > 0 ? (
        <>
          <p className="ps-note">{t("course.paymentNote")}</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
            <button type="button" className="ps-btn ps-btn-primary" onClick={() => { onClose(); navigate("/#contact"); }}>{t("course.ask")}</button>
            {loggedIn
              ? <Link to="/dashboard" className="ps-btn ps-btn-ghost" onClick={onClose}>{t("course.toDashboard")}</Link>
              : <button type="button" className="ps-btn ps-btn-ghost" onClick={() => { onClose(); openAuth("login"); }}>{t("header.login")}</button>}
          </div>
        </>
      ) : (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
          {loggedIn
            ? <Link to="/dashboard" className="ps-btn ps-btn-primary" onClick={onClose}>{t("course.startLearning")}</Link>
            : <button type="button" className="ps-btn ps-btn-primary" onClick={() => { onClose(); openAuth("register"); }}>{t("course.signupToStart")}</button>}
        </div>
      )}
    </Dialog>
  );
};

// ==========================================
// Articles and sessions
// ==========================================

export const ArticleCover: React.FC<{ article: Article; height?: number }> = ({ article, height }) => {
  const tone = toneOf(article.category);
  return (
    <div className="ps-cover" style={{ background: tone.bg, color: tone.fg, height }}>
      {article.cover_url ? <img src={article.cover_url} alt="" loading="lazy" /> : (article.category || "NetPrime")}
    </div>
  );
};

export const ArticleCard: React.FC<{ article: Article }> = ({ article }) => (
  <Link to={`/blog/${article.slug}`} className="ps-card ps-article-card">
    <ArticleCover article={article} />
    <span className="ps-article-body">
      <span className="ps-meta">{[article.category, formatDate(article.published_at)].filter(Boolean).join(" · ")}</span>
      <strong>{article.title}</strong>
      {article.excerpt && <span className="ps-muted" style={{ fontSize: 15 }}>{article.excerpt}</span>}
    </span>
  </Link>
);

export function sessionSummary(s: PublicSession): string {
  const mode = getLang() === "th" ? MODE_LABEL[s.mode] : t(`mode.${s.mode}` as MessageKey);
  return `${formatDateRange(s.start_date, s.end_date)} · ${mode} · ${formatBaht(s.price)}`;
}

export function seatsText(s: PublicSession): string {
  if (!s.registration_open) return t("schedule.closed");
  return s.seats_left === 0 ? t("schedule.full") : t("schedule.seatsLeft", { count: s.seats_left });
}
