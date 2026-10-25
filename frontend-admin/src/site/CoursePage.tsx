import React, { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import { publicGet, usePublicSite, RegisterModal, PublicSession } from "../components/site/PublicSections";
import { formatBaht, formatDateRange, MODE_LABEL, SessionMode } from "../components/site-admin/ui";
import { CourseOrderModal } from "../components/learner/CourseOrder";
import { Stars } from "../components/marketing/Ratings";
import { CourseReviewForm } from "../components/marketing/CourseReviewForm";
import { track } from "../components/marketing/runtime";
import { Link, navigate, usePageMeta } from "./router";
import { useSite, vendorOf } from "./shared";

// ==========================================
// Public course sales page: /courses/:id (id or slug)
// ==========================================

interface SalesCourse {
  id: string; title: string; description: string | null; price: number; cover_image_url: string | null;
  access_duration_days: number | null; lesson_count: number; category: { name: string; slug: string } | null;
  instructor: { name: string };
  slug: string | null; subtitle: string | null; learning_outcomes: string[]; requirements: string[]; audience: string[];
  level: string | null; language: string | null; duration_hours: number | null; promo_video_url: string | null;
  faq: Array<{ question: string; answer: string }>;
}
interface SalesSession {
  id: string; title: string; start_date: string; end_date: string; time_text: string | null; mode: SessionMode; location: string | null;
  price: number; registration_deadline: string; seats_left: number; registration_open: boolean; waitlist: boolean;
}
interface Review { id: string; rating: number; body: string | null; created_at: string; reviewer: string }
interface SalesPageData {
  course: SalesCourse; outline: Array<{ title: string; lessons: Array<{ title: string }> }>;
  rating: { average: number | null; count: number }; reviews: Review[]; sessions: SalesSession[];
}

/** After sign-in from this page, come back here and continue to checkout (read by PublicSite). */
export const RETURN_KEY = "netprime_return_to";
const CHECKOUT_KEY = "netprime_checkout_course";

export function consumeReturnTo(): string | null {
  try {
    const value = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
  } catch { return null; }
}

const LEVEL_LABEL: Record<string, string> = { beginner: "เริ่มต้น", intermediate: "กลาง", advanced: "สูง", all: "ทุกระดับ" };

/** YouTube/Vimeo links become privacy-friendly embeds; other https links open in a new tab. */
function videoEmbed(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("youtube.com")) {
      const id = u.searchParams.get("v") || (u.pathname.startsWith("/embed/") ? u.pathname.split("/")[2] : null);
      return id && /^[\w-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
    }
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1);
      return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
    }
    if (u.hostname.endsWith("vimeo.com")) {
      const id = u.pathname.split("/").filter(Boolean).pop();
      return id && /^\d{5,12}$/.test(id) ? `https://player.vimeo.com/video/${id}?dnt=1` : null;
    }
  } catch { /* not a URL */ }
  return null;
}

const Section: React.FC<{ id: string; title: string; children: React.ReactNode }> = ({ id, title, children }) => (
  <section aria-labelledby={id} style={{ paddingTop: 40 }}>
    <h2 id={id} className="ps-h2" style={{ fontSize: 26, marginBottom: 16 }}>{title}</h2>
    {children}
  </section>
);

const Checklist: React.FC<{ items: string[] }> = ({ items }) => (
  <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "10px 24px" }}>
    {items.map((item, i) => (
      <li key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span aria-hidden="true" style={{ color: "#1f6b45", fontWeight: 700 }}>✓</span><span>{item}</span>
      </li>
    ))}
  </ul>
);

export const CoursePage: React.FC<{ courseId: string }> = ({ courseId }) => {
  const api = useApi();
  const { loggedIn, openAuth } = useSite();
  const site = usePublicSite();
  const [data, setData] = useState<SalesPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [moreReviews, setMoreReviews] = useState(false);
  const [checkout, setCheckout] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [register, setRegister] = useState<SalesSession | null>(null);

  usePageMeta(data?.course.title ?? (missing ? "ไม่พบคอร์ส" : null), data ? (data.course.subtitle || data.course.description) : null);

  useEffect(() => {
    setData(null); setMissing(false); setError(null);
    publicGet<SalesPageData>(`/marketing/courses/${encodeURIComponent(courseId)}`)
      .then(result => { setData(result); setReviews(result.reviews); setMoreReviews(result.reviews.length >= 10); })
      .catch(err => (String(err.message).includes("ไม่พบ") ? setMissing(true) : setError(err.message)));
  }, [courseId]);

  // Signed-in learners: already enrolled? Resume a checkout started before sign-in.
  useEffect(() => {
    if (!loggedIn || !data) return;
    api.get<{ enrollment: { status?: string; expires_at: string | null } | null }>(`/courses/${encodeURIComponent(data.course.id)}`)
      .then(res => setEnrolled(!!res.enrollment && res.enrollment.status !== "suspended" && (!res.enrollment.expires_at || res.enrollment.expires_at > new Date().toISOString())))
      .catch(() => setEnrolled(false));
    try {
      if (sessionStorage.getItem(CHECKOUT_KEY) === data.course.id) {
        sessionStorage.removeItem(CHECKOUT_KEY);
        startCheckout();
      }
    } catch { /* storage unavailable */ }
  }, [loggedIn, data?.course.id]);

  const startCheckout = () => {
    if (!data) return;
    if (!loggedIn) {
      try {
        sessionStorage.setItem(RETURN_KEY, window.location.pathname);
        sessionStorage.setItem(CHECKOUT_KEY, data.course.id);
      } catch { /* storage unavailable */ }
      openAuth("register");
      return;
    }
    track("begin_checkout", { value: Math.round(data.course.price), item_id: data.course.id, item_name: data.course.title });
    setCheckout(true);
  };

  const loadMoreReviews = async () => {
    const res = await publicGet<{ reviews: Review[] }>(`/marketing/courses/${encodeURIComponent(courseId)}/reviews?offset=${reviews.length}&limit=10`).catch(() => null);
    if (!res) return;
    setReviews(prev => [...prev, ...res.reviews]);
    setMoreReviews(res.reviews.length >= 10);
  };

  if (missing) {
    return (
      <div className="ps-container" style={{ padding: "72px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: 32 }}>ไม่พบคอร์สนี้</h1>
        <p className="ps-muted">คอร์สอาจยังไม่เปิดขาย หรือลิงก์ไม่ถูกต้อง</p>
        <Link to="/courses" className="ps-btn ps-btn-primary" style={{ marginTop: 12 }}>ดูคอร์สทั้งหมด</Link>
      </div>
    );
  }
  if (error) return <div className="ps-container" style={{ paddingTop: 48 }}><p role="alert" style={{ color: "#b42318" }}>{error}</p></div>;
  if (!data) return <div className="ps-container" style={{ paddingTop: 48 }}><p className="ps-muted">กำลังโหลดคอร์ส…</p></div>;

  const { course, outline, rating, sessions } = data;
  const embed = course.promo_video_url ? videoEmbed(course.promo_video_url) : null;
  const vouchers = (site?.promotions ?? []).filter(p => p.voucher_code);
  const facts: Array<[string, string]> = [
    ["บทเรียน", `${course.lesson_count} บท`],
    ...(course.duration_hours ? [["ความยาว", `${course.duration_hours} ชั่วโมง`] as [string, string]] : []),
    ...(course.level ? [["ระดับ", LEVEL_LABEL[course.level] || course.level] as [string, string]] : []),
    ...(course.language ? [["ภาษา", course.language] as [string, string]] : []),
    ["ระยะเวลาเข้าถึง", course.access_duration_days ? `${course.access_duration_days} วัน` : "ตลอดชีพ"]
  ];

  const cta = enrolled
    ? <Link to="/dashboard" className="ps-btn ps-btn-primary ps-btn-lg" style={{ width: "100%" }}>เข้าเรียนคอร์สนี้</Link>
    : course.price > 0
      ? <button type="button" className="ps-btn ps-btn-primary ps-btn-lg" style={{ width: "100%" }} onClick={startCheckout}>ซื้อคอร์สนี้</button>
      : loggedIn
        ? <Link to="/dashboard" className="ps-btn ps-btn-primary ps-btn-lg" style={{ width: "100%" }}>เริ่มเรียนฟรีในแดชบอร์ด</Link>
        : <button type="button" className="ps-btn ps-btn-primary ps-btn-lg" style={{ width: "100%" }} onClick={() => openAuth("register")}>สมัครสมาชิกเพื่อเริ่มเรียนฟรี</button>;

  return (
    <>
      <section className="ps-page-head">
        <div className="ps-container" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 32, paddingTop: 40, paddingBottom: 40, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <nav aria-label="เส้นทาง" style={{ fontSize: 14 }}>
              <Link to="/courses">คอร์สออนไลน์</Link>{course.category ? <span className="ps-muted"> / {course.category.name}</span> : null}
            </nav>
            <span className="ps-course-vendor">{vendorOf(course.title)}</span>
            <h1 style={{ margin: 0, fontSize: "clamp(28px, 4vw, 42px)", lineHeight: 1.2 }}>{course.title}</h1>
            {(course.subtitle || course.description) && <p className="ps-lead" style={{ fontSize: 18 }}>{course.subtitle || course.description}</p>}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", fontSize: 15 }}>
              {rating.count > 0 ? <Stars value={rating.average} count={rating.count} /> : <span className="ps-muted">ยังไม่มีรีวิว</span>}
              <span className="ps-muted">ผู้สอน: <strong style={{ color: "#182443" }}>{course.instructor.name}</strong></span>
            </div>
          </div>
          <aside className="ps-card" style={{ padding: 22, display: "grid", gap: 16 }} aria-label="ราคาและการสมัคร">
            {embed ? (
              <div style={{ position: "relative", paddingTop: "56.25%", borderRadius: 14, overflow: "hidden", background: "#000" }}>
                <iframe src={embed} title={`วิดีโอแนะนำ ${course.title}`} loading="lazy" allow="encrypted-media; picture-in-picture" allowFullScreen
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }} />
              </div>
            ) : course.cover_image_url ? (
              <img src={course.cover_image_url} alt="" style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 14 }} />
            ) : null}
            {course.promo_video_url && !embed && <a href={course.promo_video_url} target="_blank" rel="noopener noreferrer">ดูวิดีโอแนะนำคอร์ส</a>}
            <div style={{ fontSize: 32, fontWeight: 700 }}>{formatBaht(course.price)}</div>
            {cta}
            {course.price > 0 && !enrolled && (
              <p className="ps-muted" style={{ margin: 0, fontSize: 13 }}>
                ชำระด้วยการโอนเงิน/พร้อมเพย์ ใส่โค้ดส่วนลดได้ในขั้นตอนชำระเงิน เปิดสิทธิ์เรียนหลังเจ้าหน้าที่ตรวจสอบสลิป
              </p>
            )}
            {vouchers.length > 0 && !enrolled && course.price > 0 && (
              <div style={{ background: "#fcefe7", borderRadius: 12, padding: "10px 12px", fontSize: 14 }}>
                {vouchers.slice(0, 2).map(p => <div key={p.id}><strong>{p.title}</strong> · โค้ด <code>{p.voucher_code}</code></div>)}
              </div>
            )}
            <dl className="ps-facts" style={{ margin: 0 }}>
              {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
          </aside>
        </div>
      </section>

      <div className="ps-container" style={{ paddingBottom: 24, maxWidth: 960 }}>
        {course.learning_outcomes.length > 0 && <Section id="learn" title="สิ่งที่คุณจะได้เรียนรู้"><div className="ps-card" style={{ padding: 22 }}><Checklist items={course.learning_outcomes} /></div></Section>}

        {course.description && course.subtitle && <Section id="about-course" title="รายละเอียดคอร์ส"><p style={{ margin: 0, whiteSpace: "pre-line" }}>{course.description}</p></Section>}

        <Section id="curriculum" title="เนื้อหาในคอร์ส">
          <p className="ps-muted" style={{ marginTop: -8 }}>{outline.length > 1 ? `${outline.length} หัวข้อ · ` : ""}{course.lesson_count} บทเรียน</p>
          {outline.length === 0 ? <div className="ps-card ps-empty">กำลังเตรียมเนื้อหา</div> : (
            <div className="ps-card" style={{ overflow: "hidden" }}>
              {outline.map((section, i) => (
                <details key={i} open={i === 0} style={{ borderTop: i ? "1px solid #efe8e1" : undefined }}>
                  <summary style={{ padding: "14px 18px", cursor: "pointer", fontWeight: 600, display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <span>{section.title}</span><span className="ps-muted" style={{ fontWeight: 400, fontSize: 14 }}>{section.lessons.length} บท</span>
                  </summary>
                  <ol style={{ margin: 0, padding: "0 18px 14px 40px", display: "grid", gap: 6 }}>
                    {section.lessons.map((lesson, j) => <li key={j} className="ps-muted">{lesson.title}</li>)}
                  </ol>
                </details>
              ))}
            </div>
          )}
        </Section>

        {course.requirements.length > 0 && <Section id="requirements" title="พื้นฐานที่ควรมี"><ul style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 6 }}>{course.requirements.map((r, i) => <li key={i}>{r}</li>)}</ul></Section>}
        {course.audience.length > 0 && <Section id="audience" title="คอร์สนี้เหมาะกับใคร"><ul style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 6 }}>{course.audience.map((r, i) => <li key={i}>{r}</li>)}</ul></Section>}

        {sessions.length > 0 && (
          <Section id="sessions" title="รอบอบรมกับผู้สอน">
            <div style={{ display: "grid", gap: 12 }}>
              {sessions.map(s => (
                <div key={s.id} className="ps-card" style={{ padding: "16px 18px", display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                  <div>
                    <strong>{s.title}</strong>
                    <div className="ps-muted" style={{ fontSize: 14 }}>{formatDateRange(s.start_date, s.end_date)}{s.time_text ? ` · ${s.time_text}` : ""} · {MODE_LABEL[s.mode]} · {formatBaht(s.price)}</div>
                  </div>
                  {s.registration_open
                    ? <button type="button" className="ps-btn ps-btn-outline" onClick={() => setRegister(s)}>{s.waitlist ? "ลงชื่อรอคิว" : `ลงทะเบียน (เหลือ ${s.seats_left} ที่)`}</button>
                    : <span className="ps-muted">ปิดรับสมัคร</span>}
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section id="instructor" title="ผู้สอน">
          <div className="ps-card" style={{ padding: 20, display: "flex", gap: 16, alignItems: "center" }}>
            <span aria-hidden="true" style={{ width: 56, height: 56, borderRadius: "50%", background: "#fcefe7", color: "#9a3f12", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 22 }}>
              {course.instructor.name.charAt(0)}
            </span>
            <div><strong style={{ fontSize: 18 }}>{course.instructor.name}</strong><div className="ps-muted" style={{ fontSize: 14 }}>ผู้สอน NetPrime Training Center</div></div>
          </div>
        </Section>

        {course.faq.length > 0 && (
          <Section id="faq" title="คำถามที่พบบ่อย">
            <div className="ps-card" style={{ overflow: "hidden" }}>
              {course.faq.map((item, i) => (
                <details key={i} style={{ borderTop: i ? "1px solid #efe8e1" : undefined }}>
                  <summary style={{ padding: "14px 18px", cursor: "pointer", fontWeight: 600 }}>{item.question}</summary>
                  <p style={{ margin: 0, padding: "0 18px 16px", whiteSpace: "pre-line" }} className="ps-muted">{item.answer}</p>
                </details>
              ))}
            </div>
          </Section>
        )}

        <Section id="reviews" title="รีวิวจากผู้เรียน">
          {rating.count > 0 && <p style={{ marginTop: -8 }}><Stars value={rating.average} count={rating.count} size={20} /></p>}
          {loggedIn && <div className="ps-card" style={{ padding: 20, marginBottom: 16 }}><CourseReviewForm courseId={course.id} /></div>}
          {reviews.length === 0 ? <div className="ps-card ps-empty">ยังไม่มีรีวิวสำหรับคอร์สนี้</div> : (
            <div style={{ display: "grid", gap: 12 }}>
              {reviews.map(r => (
                <article key={r.id} className="ps-card" style={{ padding: "16px 18px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <strong>{r.reviewer}</strong><Stars value={r.rating} showCount={false} size={15} />
                  </div>
                  {r.body && <p style={{ margin: "8px 0 0", whiteSpace: "pre-line" }}>{r.body}</p>}
                </article>
              ))}
              {moreReviews && <button type="button" className="ps-btn ps-btn-ghost" onClick={loadMoreReviews}>ดูรีวิวเพิ่มเติม</button>}
            </div>
          )}
        </Section>

        <div className="ps-card" style={{ marginTop: 40, padding: 24, display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center", background: "#faf6f2" }}>
          <div><strong style={{ fontSize: 20 }}>{course.title}</strong><div className="ps-muted">{formatBaht(course.price)}</div></div>
          <div style={{ minWidth: 220 }}>{cta}</div>
        </div>
      </div>

      {checkout && (
        <CourseOrderModal course={{ id: course.id, title: course.title, price: course.price, access_duration_days: course.access_duration_days }}
          onClose={() => setCheckout(false)}
          onEnrolled={() => setEnrolled(true)}
          onShowPayments={() => { setCheckout(false); navigate("/dashboard"); }} />
      )}
      {register && (
        <RegisterModal
          session={{ ...register, vendor: vendorOf(course.title), description: null, instructor_name: course.instructor.name } as PublicSession}
          onClose={() => setRegister(null)} onDone={() => undefined} />
      )}
    </>
  );
};
