import React, { useEffect, useMemo, useState } from "react";
import serverRack from "../../logo/server_rack_hero.png";
import { publicGet, usePublicSite, PublicSession, ScheduleSection, ContactSection } from "../components/site/PublicSections";
import { formatDate, formatDateRange, MODE_LABEL } from "../components/site-admin/ui";
import { Link, navigate, usePageMeta, useInitialHashScroll } from "./router";
import { Article, ArticleCard, ArrowIcon, Course, CourseCard, CourseDialog, openSiteLink, seatsText, toneOf, useCourses, vendorOf } from "./shared";

// Homepage copy is edited in the content console (tab "เนื้อหาหน้าแรก") and served by /api/public/site.
// These defaults mirror the server defaults and show only while loading or if the API is unreachable.
export interface HomeContent {
  hero: { eyebrow: string; title: string; lead: string };
  brands: Array<{ name: string; text: string; link: string | null }>;
  services: Array<{ title: string; text: string; icon: string }>;
  faq: Array<{ q: string; a: string }>;
}

export const HOME_ICONS: Record<string, React.ReactNode> = {
  video: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M10 8.5l4 2.5-4 2.5z" /><path d="M8 21h8" /></>,
  certificate: <><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>,
  building: <><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 10h1M14 10h1M9 14h1M14 14h1" /></>,
  briefcase: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M3 13h18" /></>,
  network: <><rect x="9" y="2" width="6" height="5" rx="1" /><rect x="2" y="17" width="6" height="5" rx="1" /><rect x="16" y="17" width="6" height="5" rx="1" /><path d="M12 7v5M5 17v-2h14v2M12 12v3" /></>,
  cloud: <path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.5 4.25 4.25 0 0 0 7 18z" />,
  shield: <><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></>
};

export const DEFAULT_HOME: HomeContent = {
  hero: {
    eyebrow: "Network · Cloud · Security",
    title: "อบรมด้าน IT ทั้งในห้องเรียนและออนไลน์ ในที่เดียว",
    lead: "เลือกเรียนคอร์สออนไลน์ด้วยตัวเอง หรือสมัครรอบอบรมกับผู้สอน จบแล้วได้ใบประกาศนียบัตรที่ใครก็ตรวจสอบได้ออนไลน์"
  },
  brands: [],
  services: [
    { title: "เรียนออนไลน์ครบในที่เดียว", text: "วิดีโอ แบบทดสอบ บันทึกย่อตามเวลาในวิดีโอ และถามตอบกับผู้สอน", icon: "video" },
    { title: "ใบประกาศตรวจสอบได้", text: "เรียนครบทุกบทและตอบแบบทดสอบถูกอย่างน้อย 80% ได้ใบประกาศพร้อมรหัสตรวจสอบออนไลน์", icon: "certificate" },
    { title: "สำหรับองค์กร", text: "ซื้อที่นั่งให้ทีม กำหนดคอร์ส และดูความคืบหน้าของพนักงานแต่ละคน", icon: "building" },
    { title: "ฝึกงานและงานจริง", text: "สมัครฝึกงานกับบริษัทพาร์ตเนอร์ และเสนอราคางานโปรเจกต์ Outsource", icon: "briefcase" }
  ],
  faq: []
};

/** Homepage content from the public site data (the shared /site request), with defaults until it loads. */
export function useHomeContent(): HomeContent {
  const site = usePublicSite() as (ReturnType<typeof usePublicSite> & { home?: HomeContent }) | null;
  return site?.home ?? DEFAULT_HOME;
}

export const FeatureGrid: React.FC = () => {
  const { services } = useHomeContent();
  return (
    <div className="ps-grid">
      {services.map(f => (
        <div key={f.title} className="ps-card ps-feature">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#c2541a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{HOME_ICONS[f.icon] ?? HOME_ICONS.network}</svg>
          <h3>{f.title}</h3>
          <p>{f.text}</p>
        </div>
      ))}
    </div>
  );
};

const BrandCards: React.FC<{ brands: HomeContent["brands"] }> = ({ brands }) => (
  <div className="ps-grid">
    {brands.map(b => {
      const tone = toneOf(b.name);
      const inner = <>
        <span className="ps-course-vendor" style={{ background: tone.bg, color: tone.fg }}>{b.name}</span>
        {b.text && <span className="ps-course-desc">{b.text}</span>}
      </>;
      return b.link
        ? <button key={b.name} type="button" className="ps-card ps-course" onClick={() => openSiteLink(b.link!)}>{inner}</button>
        : <div key={b.name} className="ps-card ps-course">{inner}</div>;
    })}
  </div>
);

export const HomePage: React.FC = () => {
  usePageMeta(null, "อบรม Network, Cloud และ Security ทั้งคอร์สออนไลน์และรอบอบรมกับผู้สอน พร้อมใบประกาศนียบัตรที่ตรวจสอบได้ออนไลน์");
  useInitialHashScroll();
  const site = usePublicSite();
  const home = useHomeContent();
  const { courses } = useCourses();
  const [sessions, setSessions] = useState<PublicSession[] | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [vendor, setVendor] = useState("ทั้งหมด");
  const [openCourse, setOpenCourse] = useState<Course | null>(null);
  const [certCode, setCertCode] = useState("");

  useEffect(() => {
    publicGet<{ sessions: PublicSession[] }>("/sessions").then(d => setSessions(d.sessions)).catch(() => setSessions([]));
    publicGet<{ articles: Article[] }>("/articles?limit=3").then(d => setArticles(d.articles)).catch(() => setArticles([]));
  }, []);

  const openSessions = sessions?.filter(s => s.registration_open) ?? [];
  const nextSession = openSessions[0];
  const promotion = site?.promotions[0];
  const vendors = useMemo(() => ["ทั้งหมด", ...Array.from(new Set((courses ?? []).map(c => vendorOf(c.title)))).sort()], [courses]);
  const shownCourses = (courses ?? []).filter(c => vendor === "ทั้งหมด" || vendorOf(c.title) === vendor).slice(0, 4);

  const verify = (event: React.FormEvent) => {
    event.preventDefault();
    const code = certCode.trim().toUpperCase();
    // The certificate page is handled by the app shell from the URL.
    if (code) navigate(`/verify-certificates?code=${encodeURIComponent(code)}`);
  };

  return (
    <>
      <section className="ps-hero">
        <div className="ps-container ps-hero-inner">
          <div className="ps-hero-copy">
            {home.hero.eyebrow && <span className="ps-eyebrow">{home.hero.eyebrow}</span>}
            <h1>{home.hero.title}</h1>
            <p className="ps-lead">{home.hero.lead}</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link to="/schedule" className="ps-btn ps-btn-primary ps-btn-lg">ดูตารางอบรม <ArrowIcon /></Link>
              <Link to="/courses" className="ps-btn ps-btn-outline ps-btn-lg">ดูคอร์สออนไลน์</Link>
            </div>
            {courses && sessions && (
              <dl className="ps-stats">
                <div><dt>คอร์สออนไลน์</dt><dd>{courses.length} คอร์ส</dd></div>
                <div><dt>รอบอบรมที่เปิดรับ</dt><dd>{openSessions.length} รอบ</dd></div>
                <div><dt>ตรวจสอบใบประกาศ</dt><dd>ออนไลน์</dd></div>
              </dl>
            )}
          </div>
          <div className="ps-hero-art">
            <img src={serverRack} alt="ห้องปฏิบัติการอุปกรณ์เครือข่าย" />
            {nextSession && (
              <Link to="/schedule" className="ps-next">
                <span style={{ fontSize: 12, fontWeight: 700, color: "#9a3f12" }}>รอบอบรมถัดไป</span>
                <strong style={{ fontSize: 17 }}>{nextSession.title}</strong>
                <span className="ps-muted" style={{ fontSize: 14 }}>{formatDateRange(nextSession.start_date, nextSession.end_date)} · {MODE_LABEL[nextSession.mode]} · {seatsText(nextSession)}</span>
              </Link>
            )}
          </div>
        </div>
      </section>

      {promotion && (
        <section aria-label="โปรโมชั่น" className="ps-container" style={{ paddingTop: 32 }}>
          <div className="ps-promo">
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <strong style={{ fontSize: 20 }}>{promotion.title}</strong>
              <span className="ps-muted" style={{ fontSize: 15 }}>
                {[promotion.description, promotion.ends_at ? `ถึง ${formatDate(promotion.ends_at)}` : null].filter(Boolean).join(" · ")}
              </span>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              {promotion.voucher_code && <code className="ps-code">{promotion.voucher_code}</code>}
              <button type="button" className="ps-btn ps-btn-dark" onClick={() => openSiteLink(promotion.link_url || "#schedule")}>ดูรายละเอียด</button>
            </div>
          </div>
        </section>
      )}

      <div className="ps-container" style={{ paddingTop: 24 }}>
        <ScheduleSection limit={3} onViewAll={() => navigate("/schedule")} />
      </div>

      <section className="ps-container ps-section" aria-labelledby="home-courses">
        <div className="ps-section-head">
          <div><span className="ps-kicker">คอร์สออนไลน์</span><h2 id="home-courses">เรียนด้วยตัวเอง ได้ทุกเวลา</h2></div>
          {courses && <Link to="/courses" style={{ fontWeight: 600 }}>ดูทั้ง {courses.length} คอร์ส</Link>}
        </div>
        <div className="ps-chips" role="group" aria-label="กรองตามแบรนด์" style={{ marginBottom: 20 }}>
          {vendors.map(v => <button key={v} type="button" className="ps-chip" aria-pressed={vendor === v} onClick={() => setVendor(v)}>{v}</button>)}
        </div>
        {!courses ? <p className="ps-muted">กำลังโหลดคอร์ส…</p> : (
          <div className="ps-grid">{shownCourses.map(c => <CourseCard key={c.id} course={c} onOpen={() => setOpenCourse(c)} />)}</div>
        )}
      </section>

      {home.brands.length > 0 && (
        <section className="ps-container ps-section" aria-labelledby="home-brands">
          <div className="ps-section-head">
            <div><span className="ps-kicker">แบรนด์ที่เราสอน</span><h2 id="home-brands">หลักสูตรจากผู้ผลิตชั้นนำ</h2></div>
          </div>
          <BrandCards brands={home.brands} />
        </section>
      )}

      <section className="ps-container ps-section" aria-labelledby="home-features">
        <div className="ps-section-head">
          <div><span className="ps-kicker">เรียนกับ NetPrime</span><h2 id="home-features">ครบตั้งแต่เรียนจนนำไปใช้งาน</h2></div>
        </div>
        <FeatureGrid />
      </section>

      <section id="verify" className="ps-container ps-section" aria-label="ตรวจสอบใบประกาศนียบัตร" style={{ scrollMarginTop: 96 }}>
        <form className="ps-verify" onSubmit={verify}>
          <div style={{ flex: "1 1 320px" }}>
            <h2>ตรวจสอบใบประกาศนียบัตร</h2>
            <p>ใส่รหัสที่อยู่บนใบประกาศ เพื่อยืนยันชื่อผู้เรียน คอร์ส และวันที่ออก</p>
          </div>
          <div className="ps-verify-form">
            <label htmlFor="cert-code" className="ps-sr">รหัสใบประกาศนียบัตร</label>
            <input id="cert-code" value={certCode} onChange={e => setCertCode(e.target.value)} placeholder="เช่น NP-XXXXXX" autoComplete="off" required />
            <button type="submit">ตรวจสอบ</button>
          </div>
        </form>
      </section>

      {articles.length > 0 && (
        <section className="ps-container ps-section" aria-labelledby="home-blog">
          <div className="ps-section-head">
            <div><span className="ps-kicker">บทความ</span><h2 id="home-blog">อัปเดตความรู้ด้าน IT</h2></div>
            <Link to="/blog" style={{ fontWeight: 600 }}>อ่านบทความทั้งหมด</Link>
          </div>
          <div className="ps-grid-3">{articles.map(a => <ArticleCard key={a.id} article={a} />)}</div>
        </section>
      )}

      {home.faq.length > 0 && <section className="ps-container ps-section ps-faq" aria-labelledby="home-faq">
        <div style={{ flex: "1 1 280px" }}><span className="ps-kicker">คำถามที่พบบ่อย</span><h2 id="home-faq" className="ps-h2">ก่อนสมัครอบรม</h2></div>
        <div className="ps-faq-list">
          {home.faq.map((item, i) => (
            <details key={item.q} open={i === 0}><summary>{item.q}</summary><p>{item.a}</p></details>
          ))}
        </div>
      </section>}

      <div className="ps-container" style={{ paddingTop: 24, scrollMarginTop: 96 }}>
        <ContactSection />
      </div>

      {openCourse && <CourseDialog course={openCourse} onClose={() => setOpenCourse(null)} />}
    </>
  );
};
