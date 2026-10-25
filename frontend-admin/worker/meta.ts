// Pure helpers for the frontend Worker: page metadata, share tags, sitemap and robots.txt.
// No Workers globals here, so tests can import this file directly in Node.

export const SITE_NAME = "NetPrime";
export const DEFAULT_TITLE = "NetPrime LMS — ระบบเรียนออนไลน์และอบรมด้าน IT";
export const DEFAULT_DESCRIPTION = "อบรม Network, Cloud และ Security ทั้งคอร์สออนไลน์และรอบอบรมกับผู้สอน พร้อมใบประกาศนียบัตรที่ตรวจสอบได้ออนไลน์";
export const DEFAULT_IMAGE_PATH = "/og-default.jpg";

/** Public pages besides articles; titles and descriptions match the SPA's usePageMeta calls. */
export const STATIC_PAGES: Record<string, { title: string | null; description: string }> = {
  "/": { title: null, description: DEFAULT_DESCRIPTION },
  "/courses": { title: "คอร์สออนไลน์", description: "คอร์สออนไลน์ด้าน Network, Cloud และ Security จาก Cisco, AWS, Aruba, Juniper และอื่น ๆ" },
  "/schedule": { title: "ตารางอบรม", description: "รอบอบรมในห้องเรียนและออนไลน์สด พร้อมจำนวนที่นั่งคงเหลือ ลงทะเบียนได้ทันที" },
  "/blog": { title: "บทความ", description: "บทความด้าน Network, Cloud และ Security เทคนิคเตรียมสอบ และข่าวรอบอบรมจาก NetPrime" },
  "/about": { title: "เกี่ยวกับเรา", description: "NetPrime ศูนย์ฝึกอบรมด้าน Network, Cloud และ Security" }
};

export interface PublicArticle {
  slug: string;
  title: string;
  excerpt: string | null;
  body?: string;
  cover_url: string | null;
  category: string | null;
  published_at: string;
}

export interface PageMeta {
  title: string;          // full <title>
  description: string;
  url: string;            // canonical, absolute
  image: string;          // absolute
  type: "website" | "article";
  publishedTime?: string; // ISO 8601
  section?: string | null;
  noindex?: boolean;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** http(s) URLs pass through; site-relative paths resolve against the site; anything else is rejected. */
export function absoluteUrl(value: string | null | undefined, origin: string): string | null {
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return origin + value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Plain-text summary of a Markdown body for descriptions. */
export function summarize(text: string, max = 160): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*([-*>]|\d+[.)])\s+/gm, "")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + "…" : plain;
}

/** D1 timestamps ("2026-10-18 09:00:00") are UTC without a zone marker. */
export function toIso(timestamp: string): string {
  return timestamp.includes("T") ? timestamp : timestamp.replace(" ", "T") + "Z";
}

export function staticPageMeta(pathname: string, origin: string): PageMeta | null {
  const page = STATIC_PAGES[pathname];
  if (!page) return null;
  return {
    title: page.title ? `${page.title} | ${SITE_NAME}` : DEFAULT_TITLE,
    description: page.description,
    url: origin + pathname,
    image: origin + DEFAULT_IMAGE_PATH,
    type: "website"
  };
}

export function articlePageMeta(article: PublicArticle, origin: string): PageMeta {
  return {
    title: `${article.title} | ${SITE_NAME}`,
    description: article.excerpt?.trim() || (article.body ? summarize(article.body) : "") || DEFAULT_DESCRIPTION,
    url: `${origin}/blog/${encodeURIComponent(article.slug)}`,
    image: absoluteUrl(article.cover_url, origin) || origin + DEFAULT_IMAGE_PATH,
    type: "article",
    publishedTime: toIso(article.published_at),
    section: article.category
  };
}

export function missingArticleMeta(pathname: string, origin: string): PageMeta {
  return {
    title: `ไม่พบบทความ | ${SITE_NAME}`,
    description: DEFAULT_DESCRIPTION,
    url: origin + pathname,
    image: origin + DEFAULT_IMAGE_PATH,
    type: "website",
    noindex: true
  };
}

/** Tags appended to <head>; the Worker removes the static defaults from index.html first. */
export function headTags(meta: PageMeta): string {
  const tags: Array<[string, string, string]> = [
    ["name", "description", meta.description],
    ["property", "og:site_name", SITE_NAME],
    ["property", "og:locale", "th_TH"],
    ["property", "og:type", meta.type],
    ["property", "og:title", meta.title],
    ["property", "og:description", meta.description],
    ["property", "og:url", meta.url],
    ["property", "og:image", meta.image],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", meta.title],
    ["name", "twitter:description", meta.description],
    ["name", "twitter:image", meta.image]
  ];
  if (meta.publishedTime) tags.push(["property", "article:published_time", meta.publishedTime]);
  if (meta.section) tags.push(["property", "article:section", meta.section]);
  if (meta.noindex) tags.push(["name", "robots", "noindex"]);
  const metaHtml = tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`).join("\n    ");
  const canonical = meta.noindex ? "" : `\n    <link rel="canonical" href="${escapeHtml(meta.url)}">`;
  return `\n    ${metaHtml}${canonical}\n  `;
}

export interface SitemapEntry { loc: string; lastmod?: string }

export function sitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map(e =>
    `  <url><loc>${escapeHtml(e.loc)}</loc>${e.lastmod ? `<lastmod>${escapeHtml(e.lastmod)}</lastmod>` : ""}</url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function sitemapEntries(origin: string, articles: Array<Pick<PublicArticle, "slug" | "published_at">>,
  courses: Array<Pick<PublicCourse, "id"> & { slug?: string | null }> = []): SitemapEntry[] {
  return [
    ...Object.keys(STATIC_PAGES).map(path => ({ loc: origin + path })),
    ...articles.map(a => ({ loc: `${origin}/blog/${encodeURIComponent(a.slug)}`, lastmod: toIso(a.published_at).slice(0, 10) })),
    ...courses.map(c => ({ loc: `${origin}/courses/${encodeURIComponent(c.slug || c.id)}` }))
  ];
}

/** Public course sales page (/courses/:id) as returned by /api/public/marketing/courses/:id. */
export interface PublicCourse {
  id: string;
  title: string;
  slug?: string | null;
  subtitle?: string | null;
  description: string | null;
  cover_image_url: string | null;
  price?: number;
}

export function coursePageMeta(course: PublicCourse, origin: string): PageMeta {
  return {
    title: `${course.title} | ${SITE_NAME}`,
    description: summarize(course.subtitle?.trim() || course.description?.trim() || "") || DEFAULT_DESCRIPTION,
    url: `${origin}/courses/${encodeURIComponent(course.slug || course.id)}`,
    image: absoluteUrl(course.cover_image_url, origin) || origin + DEFAULT_IMAGE_PATH,
    type: "website"
  };
}

export function missingCourseMeta(pathname: string, origin: string): PageMeta {
  return { title: `ไม่พบคอร์ส | ${SITE_NAME}`, description: DEFAULT_DESCRIPTION, url: origin + pathname, image: origin + DEFAULT_IMAGE_PATH, type: "website", noindex: true };
}

export function robotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /dashboard\n\nSitemap: ${origin}/sitemap.xml\n`;
}

// ---------- Website builder pages (/p/:slug) and the web app manifest ----------

/** Published custom page as returned by /api/public/website/pages/:slug. */
export interface PublicCustomPage {
  slug: string;
  title: string;
  seo_title: string | null;
  seo_description: string | null;
  og_image_url: string | null;
  published_at?: string | null;
  updated_at?: string | null;
}

export function customPageMeta(page: PublicCustomPage, origin: string): PageMeta {
  return {
    title: `${page.seo_title?.trim() || page.title} | ${SITE_NAME}`,
    description: page.seo_description?.trim() || DEFAULT_DESCRIPTION,
    url: `${origin}/p/${encodeURIComponent(page.slug)}`,
    image: absoluteUrl(page.og_image_url, origin) || origin + DEFAULT_IMAGE_PATH,
    type: "website"
  };
}

export function missingCustomPageMeta(pathname: string, origin: string): PageMeta {
  return { title: `ไม่พบหน้า | ${SITE_NAME}`, description: DEFAULT_DESCRIPTION, url: origin + pathname, image: origin + DEFAULT_IMAGE_PATH, type: "website", noindex: true };
}

export function customPageSitemapEntries(origin: string, pages: Array<Pick<PublicCustomPage, "slug" | "updated_at" | "published_at">>): SitemapEntry[] {
  return pages.map(p => {
    const stamp = p.updated_at || p.published_at;
    return { loc: `${origin}/p/${encodeURIComponent(p.slug)}`, ...(stamp ? { lastmod: toIso(stamp).slice(0, 10) } : {}) };
  });
}

/** Web app manifest with the school name from the website builder theme (falls back to the static file's values). */
export function manifestJson(theme: { school_name?: string | null; primary_color?: string | null } | null): string {
  const name = theme?.school_name?.trim() || SITE_NAME;
  const color = theme?.primary_color && /^#[0-9a-f]{6}$/i.test(theme.primary_color) ? theme.primary_color : "#c2541a";
  return JSON.stringify({
    name: name === SITE_NAME ? "NetPrime LMS" : name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: DEFAULT_DESCRIPTION,
    lang: "th", dir: "ltr", id: "/", start_url: "/?source=pwa", scope: "/", display: "standalone",
    background_color: "#fdfcfb", theme_color: color, categories: ["education"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  });
}
