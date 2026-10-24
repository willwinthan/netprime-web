import React, { useEffect, useMemo, useState } from "react";
import { publicGet, PublicSession } from "../components/site/PublicSections";
import { formatBaht, formatDate } from "../components/site-admin/ui";
import { Link, usePageMeta } from "./router";
import { Block, Markdown, parseMarkdown } from "./Markdown";
import { BlockRenderer, documentOutline, documentText, parseDocument } from "./BlockRenderer";
import { Article, ArticleCard, Course, CourseDialog, readingMinutes, seatsText, sessionSummary, toneOf, useCourses, vendorOf } from "./shared";

/** /blog/:slug */
export const BlogPostPage: React.FC<{ slug: string }> = ({ slug }) => {
  const [article, setArticle] = useState<Article | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [related, setRelated] = useState<Article[]>([]);
  const [session, setSession] = useState<PublicSession | null>(null);
  const [copied, setCopied] = useState(false);
  const [openCourse, setOpenCourse] = useState<Course | null>(null);
  const { courses } = useCourses();

  usePageMeta(article?.title ?? (status === "missing" ? "ไม่พบบทความ" : "บทความ"), article?.excerpt);

  useEffect(() => {
    setStatus("loading");
    setArticle(null);
    setSession(null);
    setRelated([]);
    publicGet<{ article: Article }>(`/articles/${encodeURIComponent(slug)}`)
      .then(d => { setArticle(d.article); setStatus("ready"); })
      .catch(err => setStatus(/ไม่พบ/.test(err.message) ? "missing" : "error"));
  }, [slug]);

  useEffect(() => {
    if (!article) return;
    const category = article.category;
    // Same category first; fall back to the latest posts.
    publicGet<{ articles: Article[] }>(`/articles?limit=4${category ? `&category=${encodeURIComponent(category)}` : ""}`)
      .then(async d => {
        let list = d.articles.filter(a => a.slug !== article.slug);
        if (list.length < 3 && category) {
          const latest = await publicGet<{ articles: Article[] }>("/articles?limit=6");
          list = [...list, ...latest.articles.filter(a => a.slug !== article.slug && !list.some(x => x.id === a.id))];
        }
        setRelated(list.slice(0, 3));
      }).catch(() => setRelated([]));
    // A training round of the same vendor, when the category is a vendor (e.g. Cisco).
    if (category) {
      publicGet<{ sessions: PublicSession[] }>(`/sessions?vendor=${encodeURIComponent(category)}&limit=5`)
        .then(d => setSession(d.sessions.find(s => s.registration_open) || null)).catch(() => setSession(null));
    }
  }, [article?.id]);

  // Articles from the block editor carry BlockNote JSON; older ones only Markdown.
  const doc = useMemo(() => parseDocument(article?.content_json), [article?.content_json]);
  const blocks = useMemo(() => doc ? [] : parseMarkdown(article?.body || ""), [doc, article?.body]);
  const toc = doc ? documentOutline(doc) : blocks.filter((b): b is Extract<Block, { id: string }> => b.type === "h2");
  const relatedCourse = article?.category ? courses?.find(c => vendorOf(c.title) === article.category) : undefined;

  if (status === "loading") return <div className="ps-container" style={{ padding: "64px 24px" }}><p className="ps-muted">กำลังโหลดบทความ…</p></div>;
  if (status !== "ready" || !article) {
    return (
      <div className="ps-container" style={{ padding: "72px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: 32 }}>{status === "missing" ? "ไม่พบบทความนี้" : "โหลดบทความไม่สำเร็จ"}</h1>
        <p className="ps-muted">{status === "missing" ? "บทความอาจถูกย้ายหรือยังไม่เผยแพร่" : "กรุณาลองใหม่อีกครั้ง"}</p>
        <Link to="/blog" className="ps-btn ps-btn-primary" style={{ marginTop: 12 }}>กลับไปหน้าบทความ</Link>
      </div>
    );
  }

  const url = window.location.origin + `/blog/${article.slug}`;
  const author = article.author_name || "ทีมงาน NetPrime";
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch { /* Clipboard may be blocked; the address bar still has the link. */ }
  };

  return (
    <>
      <div className="ps-container">
        <nav aria-label="ตำแหน่งหน้า" className="ps-breadcrumb">
          <Link to="/">หน้าแรก</Link><span aria-hidden="true">/</span>
          <Link to="/blog">บทความ</Link>
          {article.category && <><span aria-hidden="true">/</span><Link to={`/blog?category=${encodeURIComponent(article.category)}`}>{article.category}</Link></>}
        </nav>
      </div>

      <div className="ps-container ps-layout" style={{ paddingTop: 24 }}>
        <article className="ps-main" style={{ gap: 22 }}>
          <header className="ps-post-head">
            {article.category && <span className="ps-pill" style={{ alignSelf: "flex-start", background: toneOf(article.category).bg, color: toneOf(article.category).fg }}>{article.category}</span>}
            <h1>{article.title}</h1>
            {article.excerpt && <p className="ps-lead" style={{ fontSize: 20 }}>{article.excerpt}</p>}
            <div className="ps-byline">
              <span className="ps-avatar" aria-hidden="true">{author.trim().charAt(0)}</span>
              <span><strong style={{ color: "#182443" }}>{author}</strong><br />{formatDate(article.published_at)} · อ่าน {readingMinutes(doc ? documentText(doc) : article.body || "")} นาที</span>
            </div>
          </header>
          {article.cover_url && <img className="ps-post-cover" src={article.cover_url} alt="" />}

          {doc ? <BlockRenderer blocks={doc} /> : <Markdown blocks={blocks} />}

          {session && (
            <aside className="ps-session-card" aria-label="รอบอบรมที่เกี่ยวข้อง">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#9a3f12" }}>รอบอบรมที่เกี่ยวข้อง</span>
                <strong style={{ fontSize: 18 }}>{session.title}</strong>
                <span className="ps-muted" style={{ fontSize: 15 }}>{sessionSummary(session)} · {seatsText(session)}</span>
              </div>
              <Link to="/schedule" className="ps-btn ps-btn-primary">ลงทะเบียน</Link>
            </aside>
          )}

          <div className="ps-share">
            <span style={{ fontWeight: 600 }}>แชร์บทความ</span>
            <button type="button" className="ps-btn ps-btn-ghost" onClick={copyLink}>{copied ? "คัดลอกแล้ว" : "คัดลอกลิงก์"}</button>
            <a className="ps-btn ps-btn-ghost" href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer">Facebook</a>
            <a className="ps-btn ps-btn-ghost" href={`https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer">LINE</a>
          </div>
        </article>

        <aside className="ps-aside">
          {toc.length >= 2 && (
            <nav aria-label="สารบัญ" className="ps-card ps-aside-box">
              <h2 style={{ fontSize: 16 }}>ในบทความนี้</h2>
              {toc.map(h => <a key={h.id} href={`#${h.id}`} style={{ display: "flex", alignItems: "center", minHeight: 32, fontSize: 15 }}>{h.text}</a>)}
            </nav>
          )}
          {relatedCourse && (
            <section className="ps-card ps-aside-box">
              <span style={{ fontSize: 12, fontWeight: 700, color: "#1d4ea8" }}>คอร์สออนไลน์</span>
              <strong style={{ fontSize: 17, lineHeight: 1.4 }}>{relatedCourse.title}</strong>
              <span className="ps-muted" style={{ fontSize: 14 }}>{relatedCourse.lesson_count} บทเรียน · {formatBaht(relatedCourse.price)}</span>
              <button type="button" className="ps-linkbtn" style={{ textAlign: "left" }} onClick={() => setOpenCourse(relatedCourse)}>ดูรายละเอียดคอร์ส</button>
            </section>
          )}
        </aside>
      </div>

      {related.length > 0 && (
        <section className="ps-related" aria-labelledby="related-title">
          <div className="ps-container">
            <h2 id="related-title" className="ps-h2" style={{ marginBottom: 22 }}>บทความที่เกี่ยวข้อง</h2>
            <div className="ps-grid-3">{related.map(a => <ArticleCard key={a.id} article={a} />)}</div>
          </div>
        </section>
      )}

      {openCourse && <CourseDialog course={openCourse} onClose={() => setOpenCourse(null)} />}
    </>
  );
};
