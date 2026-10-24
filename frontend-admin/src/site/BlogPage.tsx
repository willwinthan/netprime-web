import React, { useEffect, useState } from "react";
import { publicGet, usePublicSite, PublicSession } from "../components/site/PublicSections";
import { formatDate } from "../components/site-admin/ui";
import { Link, navigate, useLocation, usePageMeta } from "./router";
import { Article, ArticleCard, ArticleCover, SearchIcon, seatsText, sessionSummary } from "./shared";

const PAGE_SIZE = 9;

/** /blog — filters live in the URL (?category=&q=&page=) so filtered views can be shared. */
export const BlogPage: React.FC = () => {
  const location = useLocation();
  const category = location.searchParams.get("category") || "";
  const q = location.searchParams.get("q") || "";
  const page = Math.max(1, parseInt(location.searchParams.get("page") || "1", 10) || 1);
  usePageMeta(category ? `บทความ ${category}` : "บทความ", "บทความด้าน Network, Cloud และ Security เทคนิคเตรียมสอบ และข่าวรอบอบรมจาก NetPrime");

  const site = usePublicSite();
  const [data, setData] = useState<{ articles: Article[]; total: number; categories: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(q);
  const [nextSession, setNextSession] = useState<PublicSession | null>(null);

  const setFilters = (next: { category?: string; q?: string; page?: number }, replace = false) => {
    const params = new URLSearchParams();
    const c = next.category ?? category;
    const s = next.q ?? q;
    const p = next.page ?? 1;
    if (c) params.set("category", c);
    if (s) params.set("q", s);
    if (p > 1) params.set("page", String(p));
    const query = params.toString();
    navigate(`/blog${query ? `?${query}` : ""}`, { replace });
  };

  useEffect(() => {
    setData(null);
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
    if (category) params.set("category", category);
    if (q) params.set("q", q);
    publicGet<{ articles: Article[]; total: number; categories: string[] }>(`/articles?${params}`)
      .then(setData).catch(err => setError(err.message));
  }, [category, q, page]);

  useEffect(() => { setSearch(q); }, [q]);
  // Search as the visitor types, without adding a history entry per keystroke.
  useEffect(() => {
    if (search.trim() === q) return;
    const timer = window.setTimeout(() => setFilters({ q: search.trim(), page: 1 }, true), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    publicGet<{ sessions: PublicSession[] }>("/sessions?limit=10")
      .then(d => setNextSession(d.sessions.find(s => s.registration_open) || null)).catch(() => undefined);
  }, []);

  const showFeatured = page === 1 && !category && !q && (data?.articles.length ?? 0) > 0;
  const featured = showFeatured ? data!.articles[0] : null;
  const rest = data ? (showFeatured ? data.articles.slice(1) : data.articles) : [];
  const pages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <>
      <section className="ps-page-head">
        <div className="ps-container ps-page-head-inner">
          <div>
            <span className="ps-kicker">บทความและข่าวสาร</span>
            <h1>ความรู้ด้าน IT จากทีมผู้สอน</h1>
            <p className="ps-lead" style={{ marginTop: 8, fontSize: 17 }}>เทคนิคเตรียมสอบ แนวทางออกแบบระบบ และข่าวรอบอบรม</p>
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <label className="ps-search">
              <SearchIcon />
              <span className="ps-sr">ค้นหาบทความ</span>
              <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหาบทความ" maxLength={100} />
            </label>
            {data && data.categories.length > 0 && (
              <div className="ps-chips" role="group" aria-label="หมวดหมู่">
                {["", ...data.categories].map(c => (
                  <button key={c || "all"} type="button" className="ps-chip" aria-pressed={category === c} onClick={() => setFilters({ category: c, page: 1 })}>{c || "ทั้งหมด"}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="ps-container ps-layout">
        <div className="ps-main">
          {error && <p role="alert" style={{ color: "#b42318" }}>{error}</p>}
          {!data && !error && <p className="ps-muted">กำลังโหลดบทความ…</p>}
          {data && data.articles.length === 0 && (
            <div className="ps-card ps-empty">
              {q ? <>ไม่พบบทความที่ตรงกับ “{q}”</> : "ยังไม่มีบทความในหมวดนี้"}
              <div style={{ marginTop: 12 }}><button type="button" className="ps-btn ps-btn-ghost" onClick={() => { setSearch(""); setFilters({ category: "", q: "", page: 1 }); }}>ดูบทความทั้งหมด</button></div>
            </div>
          )}
          {featured && (
            <Link to={`/blog/${featured.slug}`} className="ps-card ps-featured">
              <ArticleCover article={featured} />
              <span className="ps-featured-body">
                <span className="ps-eyebrow">บทความล่าสุด</span>
                <strong>{featured.title}</strong>
                {featured.excerpt && <span className="ps-muted" style={{ fontSize: 16 }}>{featured.excerpt}</span>}
                <span className="ps-meta">{[featured.category, formatDate(featured.published_at)].filter(Boolean).join(" · ")}</span>
              </span>
            </Link>
          )}
          {rest.length > 0 && <div className="ps-grid">{rest.map(a => <ArticleCard key={a.id} article={a} />)}</div>}
          {pages > 1 && (
            <nav aria-label="เลขหน้า" className="ps-pager">
              {page > 1 && <button type="button" onClick={() => setFilters({ page: page - 1 })}>ก่อนหน้า</button>}
              {Array.from({ length: pages }, (_, i) => i + 1).map(n => (
                <button key={n} type="button" aria-current={n === page ? "page" : undefined} onClick={() => setFilters({ page: n })}>{n}</button>
              ))}
              {page < pages && <button type="button" onClick={() => setFilters({ page: page + 1 })}>ถัดไป</button>}
            </nav>
          )}
        </div>

        <aside className="ps-aside" aria-label="ข้อมูลเพิ่มเติม">
          {data && data.categories.length > 0 && (
            <section className="ps-card ps-aside-box">
              <h2>หมวดหมู่</h2>
              {data.categories.map(c => (
                <Link key={c} to={`/blog?category=${encodeURIComponent(c)}`} aria-current={category === c ? "page" : undefined}
                  style={{ display: "flex", alignItems: "center", minHeight: 36, fontWeight: category === c ? 700 : 400, color: "#182443", textDecoration: "none" }}>{c}</Link>
              ))}
            </section>
          )}
          {nextSession && (
            <section className="ps-aside-dark">
              <span style={{ fontSize: 12, fontWeight: 700, color: "#f7b98f" }}>รอบอบรมถัดไป</span>
              <strong style={{ fontSize: 19 }}>{nextSession.title}</strong>
              <span style={{ fontSize: 14, color: "#d7deec" }}>{sessionSummary(nextSession)}</span>
              <span style={{ fontSize: 14, color: "#a7e3c3", fontWeight: 600 }}>{seatsText(nextSession)}</span>
              <Link to="/schedule" className="ps-btn" style={{ background: "#e56b25", color: "#182443", marginTop: 6 }}>ลงทะเบียน</Link>
            </section>
          )}
          {site?.settings.line && (
            <section className="ps-card ps-aside-box">
              <h2>ติดตามข่าวรอบอบรม</h2>
              <p className="ps-muted" style={{ margin: 0, fontSize: 14 }}>เพิ่มเพื่อน LINE {site.settings.line} เพื่อรับประกาศรอบใหม่</p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
};
