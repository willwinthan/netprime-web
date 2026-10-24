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

export function sitemapEntries(origin: string, articles: Array<Pick<PublicArticle, "slug" | "published_at">>): SitemapEntry[] {
  return [
    ...Object.keys(STATIC_PAGES).map(path => ({ loc: origin + path })),
    ...articles.map(a => ({ loc: `${origin}/blog/${encodeURIComponent(a.slug)}`, lastmod: toIso(a.published_at).slice(0, 10) }))
  ];
}

export function robotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /dashboard\n\nSitemap: ${origin}/sitemap.xml\n`;
}
