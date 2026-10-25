import React, { useEffect, useMemo, useState } from "react";
import { LegalPage, LEGAL_PATHS } from "./LegalPage";
import { User } from "../hooks/useApi";
import { ScheduleSection, ContactSection } from "../components/site/PublicSections";
import { Link, navigate, useLocation, usePageMeta, useInitialHashScroll } from "./router";
import { AuthDialog, Course, CourseCard, CourseDialog, SearchIcon, SiteContext, SiteLayout, useCourses, vendorOf } from "./shared";
import { HomePage, FeatureGrid } from "./HomePage";
import { BlogPage } from "./BlogPage";
import { BlogPostPage } from "./BlogPostPage";
import { ResetPasswordPage, VerifyEmailPage } from "./AccountPages";
import { ScheduleCalendarView } from "./ScheduleCalendar";
import { AiSalesChatWidget } from "../components/ai/AiSalesChatWidget";
import "./site.css";
import { CustomPage } from "./CustomPage";
import { CoursePage, consumeReturnTo } from "./CoursePage";
import { useI18n } from "../i18n";
import { PublicCategoryChips } from "../components/course/CategoryFilter";

/** Paths served by the public website (everything else while signed in is the LMS console). */
export function isPublicPath(pathname: string): boolean {
  // Emailed account links (reset / invitation / verification) also open while signed in.
  return ["/", "/courses", "/schedule", "/about", "/blog", "/reset-password", "/verify-email", ...Object.keys(LEGAL_PATHS)].includes(pathname.replace(/\/+$/, "") || "/") ||
    pathname.startsWith("/blog/") || pathname.startsWith("/p/") || /^\/courses\/[^/]+\/?$/.test(pathname);
}

const PageHead: React.FC<{ kicker: string; title: string; lead?: string; children?: React.ReactNode }> = ({ kicker, title, lead, children }) => (
  <section className="ps-page-head">
    <div className="ps-container ps-page-head-inner">
      <div>
        <span className="ps-kicker">{kicker}</span>
        <h1>{title}</h1>
        {lead && <p className="ps-lead" style={{ marginTop: 8, fontSize: 17 }}>{lead}</p>}
      </div>
      {children}
    </div>
  </section>
);

const CoursesPage: React.FC = () => {
  usePageMeta("คอร์สออนไลน์", "คอร์สออนไลน์ด้าน Network, Cloud และ Security จาก Cisco, AWS, Aruba, Juniper และอื่น ๆ");
  const { courses, error } = useCourses();
  const { t } = useI18n();
  const [vendor, setVendor] = useState("ทั้งหมด");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Course | null>(null);
  const vendors = useMemo(() => ["ทั้งหมด", ...Array.from(new Set((courses ?? []).map(c => vendorOf(c.title)))).sort()], [courses]);
  const term = search.trim().toLowerCase();
  const shown = (courses ?? []).filter(c =>
    (vendor === "ทั้งหมด" || vendorOf(c.title) === vendor) &&
    (!category || (c as Course & { category_id?: string | null }).category_id === category) &&
    (!term || c.title.toLowerCase().includes(term) || (c.description || "").toLowerCase().includes(term)));

  return (
    <>
      <PageHead kicker={t("catalog.kicker")} title={t("catalog.title")} lead={t("catalog.lead")}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <label className="ps-search">
            <SearchIcon /><span className="ps-sr">{t("catalog.search")}</span>
            <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t("catalog.searchPlaceholder")} />
          </label>
          <div className="ps-chips" role="group" aria-label={t("catalog.filterVendor")}>
            {vendors.map(v => <button key={v} type="button" className="ps-chip" aria-pressed={vendor === v} onClick={() => setVendor(v)}>{v === "ทั้งหมด" ? t("catalog.all") : v}</button>)}
          </div>
          <PublicCategoryChips value={category} onChange={setCategory} label="กรองตามหมวดหมู่" allLabel={t("catalog.all")} />
        </div>
      </PageHead>
      <div className="ps-container" style={{ paddingTop: 32 }}>
        {error && <p role="alert" style={{ color: "#b42318" }}>{error}</p>}
        {!courses && !error && <p className="ps-muted">{t("catalog.loading")}</p>}
        {courses && (
          <>
            <p className="ps-muted" style={{ margin: "0 0 16px" }}>{t("catalog.count", { count: shown.length })}</p>
            {shown.length === 0
              ? <div className="ps-card ps-empty">{t("catalog.empty")}</div>
              : <div className="ps-grid">{shown.map(c => <CourseCard key={c.id} course={c} onOpen={() => setOpen(c)} />)}</div>}
          </>
        )}
      </div>
      {open && <CourseDialog course={open} onClose={() => setOpen(null)} />}
    </>
  );
};

type ScheduleView = "list" | "calendar";
const SCHEDULE_VIEW_KEY = "netprime.site.schedule.view";

/** Saved choice first; otherwise list on phones and calendar on wider screens. */
function initialScheduleView(): ScheduleView {
  try {
    const saved = localStorage.getItem(SCHEDULE_VIEW_KEY);
    if (saved === "list" || saved === "calendar") return saved;
  } catch { /* storage unavailable */ }
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 639px)").matches ? "list" : "calendar";
}

const SchedulePage: React.FC = () => {
  usePageMeta("ตารางอบรม", "รอบอบรมในห้องเรียนและออนไลน์สด พร้อมจำนวนที่นั่งคงเหลือ ลงทะเบียนได้ทันที");
  const [view, setView] = useState<ScheduleView>(initialScheduleView);
  const { t } = useI18n();
  const choose = (next: ScheduleView) => {
    setView(next);
    try { localStorage.setItem(SCHEDULE_VIEW_KEY, next); } catch { /* storage unavailable */ }
  };
  return (
    <div className="ps-container" style={{ paddingTop: 24 }}>
      <div className="ps-chips ps-view-toggle" role="group" aria-label={t("schedule.viewToggle")}>
        <button type="button" className="ps-chip" aria-pressed={view === "list"} onClick={() => choose("list")}>{t("schedule.list")}</button>
        <button type="button" className="ps-chip" aria-pressed={view === "calendar"} onClick={() => choose("calendar")}>{t("schedule.calendar")}</button>
      </div>
      {view === "list" ? <ScheduleSection /> : <ScheduleCalendarView />}
    </div>
  );
};

const AboutPage: React.FC = () => {
  usePageMeta("เกี่ยวกับเรา", "NetPrime ศูนย์ฝึกอบรมด้าน Network, Cloud และ Security");
  useInitialHashScroll();
  return (
    <>
      <PageHead kicker="เกี่ยวกับเรา" title="NetPrime Training Center"
        lead="ศูนย์ฝึกอบรมด้าน Network, Cloud และ Security มีทั้งคอร์สออนไลน์ให้เรียนด้วยตัวเอง และรอบอบรมกับผู้สอนในห้องเรียนหรือออนไลน์สด" />
      <section className="ps-container ps-section" aria-labelledby="about-features" style={{ paddingTop: 48 }}>
        <div className="ps-section-head"><h2 id="about-features">สิ่งที่ผู้เรียนและองค์กรได้รับ</h2></div>
        <FeatureGrid />
      </section>
      <div className="ps-container" style={{ paddingTop: 24 }}><ContactSection /></div>
    </>
  );
};

const NotFoundPage: React.FC = () => {
  usePageMeta("ไม่พบหน้า");
  const { t } = useI18n();
  return (
    <div className="ps-container" style={{ padding: "72px 24px", textAlign: "center" }}>
      <h1 style={{ fontSize: 32 }}>{t("notFound.title")}</h1>
      <p className="ps-muted">{t("notFound.text")}</p>
      <Link to="/" className="ps-btn ps-btn-primary" style={{ marginTop: 12 }}>{t("notFound.home")}</Link>
    </div>
  );
};

/** Public website: routes, layout, and the sign-in dialog. */
export const PublicSite: React.FC<{ loggedIn: boolean; onLogin: (token: string, user: User) => void }> = ({ loggedIn, onLogin }) => {
  const location = useLocation();
  const [auth, setAuth] = useState<"login" | "register" | null>(null);
  const context = useMemo(() => ({ loggedIn, openAuth: setAuth }), [loggedIn]);
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const postSlug = /^\/blog\/([^/]+)$/.exec(path)?.[1];
  const pageSlug = /^\/p\/([^/]+)$/.exec(path)?.[1];
  const courseSlug = /^\/courses\/([^/]+)$/.exec(path)?.[1];
  // Re-render every page when the visitor switches TH/EN (page components read t() while rendering).
  useI18n();
  // A signed-out visit to the console (an old bookmark, an expired session) asks to sign in.
  const consolePath = !loggedIn && path === "/dashboard";
  useEffect(() => { if (consolePath) setAuth("login"); }, [consolePath]);

  let page: React.ReactNode;
  // While the console takes over (the site animates out), render nothing rather than a 404.
  if (loggedIn && !isPublicPath(path)) page = null;
  else if (path === "/" || consolePath) page = <HomePage />;
  else if (path === "/courses") page = <CoursesPage />;
  else if (path === "/schedule") page = <SchedulePage />;
  else if (path === "/about") page = <AboutPage />;
  else if (path === "/blog") page = <BlogPage />;
  else if (path === "/reset-password") page = <ResetPasswordPage />;
  else if (path === "/verify-email") page = <VerifyEmailPage />;
  else if (LEGAL_PATHS[path]) page = <LegalPage pageKey={LEGAL_PATHS[path]} />;
  else if (postSlug) page = <BlogPostPage key={postSlug} slug={decodeURIComponent(postSlug)} />;
  else if (pageSlug) page = <CustomPage key={pageSlug} slug={decodeURIComponent(pageSlug)} />;
  else if (courseSlug) page = <CoursePage key={courseSlug} courseId={decodeURIComponent(courseSlug)} />;
  else page = <NotFoundPage />;

  return (
    <SiteContext.Provider value={context}>
      <SiteLayout>{page}</SiteLayout>
      {page && <AiSalesChatWidget />}
      {auth && (
        <AuthDialog mode={auth} onClose={() => setAuth(null)} onLogin={(token, user) => {
          setAuth(null);
          onLogin(token, user);
          navigate(consumeReturnTo() ?? "/dashboard");
        }} />
      )}
    </SiteContext.Provider>
  );
};
