import {
  articlePageMeta, coursePageMeta, missingCourseMeta, PublicCourse, headTags, missingArticleMeta, PageMeta, PublicArticle, robotsTxt,
  sitemapEntries, sitemapXml, staticPageMeta, DEFAULT_DESCRIPTION, DEFAULT_IMAGE_PATH, DEFAULT_TITLE
} from "./meta";
import { customPageMeta, customPageSitemapEntries, manifestJson, missingCustomPageMeta, PublicCustomPage } from "./meta";

/**
 * Frontend Worker in front of the static SPA build.
 * Link previews (LINE, Facebook, X) and crawlers read <meta> tags without running JavaScript,
 * so public HTML pages get per-page title/description/og:image here. wrangler.jsonc routes only
 * those paths plus /sitemap.xml and /robots.txt to this Worker (run_worker_first); every other
 * request, including JS/CSS/images, is served by the assets layer directly.
 */
interface Env {
  ASSETS: Fetcher;
  /** Same value as VITE_API_BASE_URL, e.g. https://api.example.com/api. Empty = default tags only. */
  API_BASE_URL?: string;
}

const ARTICLE_PATH = /^\/blog\/([^/]+)\/?$/;
const CUSTOM_PAGE_PATH = /^\/p\/([^/]+)\/?$/;
const COURSE_PATH = /^\/courses\/([^/]+)\/?$/;
// Static defaults in index.html that a page-specific value replaces.
const MANAGED_TAGS = 'meta[name="description"], meta[property^="og:"], meta[property^="article:"], meta[name^="twitter:"], meta[name="robots"], link[rel="canonical"]';
const API_CACHE_SECONDS = 300;

const apiBase = (env: Env) => env.API_BASE_URL?.trim().replace(/\/+$/, "") || null;

function plain(body: string, contentType: string, maxAge: number): Response {
  return new Response(body, { headers: { "content-type": contentType, "cache-control": `public, max-age=${maxAge}` } });
}

function genericMeta(url: URL): PageMeta {
  return { title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION, url: url.origin + url.pathname, image: url.origin + DEFAULT_IMAGE_PATH, type: "website" };
}

/** Serves index.html with this page's tags. Falls back to the untouched asset response on any surprise. */
async function renderShell(request: Request, url: URL, env: Env, meta: PageMeta, status = 200): Promise<Response> {
  const shell = await env.ASSETS.fetch(new Request(new URL("/", url).toString()));
  if (!shell.ok || !(shell.headers.get("content-type") || "").includes("text/html")) return shell;
  const headers = new Headers(shell.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.set("cache-control", "public, max-age=60");
  const response = new Response(request.method === "HEAD" ? null : shell.body, { status, headers });
  return new HTMLRewriter()
    .on(MANAGED_TAGS, { element(el) { el.remove(); } })
    .on("title", { element(el) { el.setInnerContent(meta.title); } })
    .on("head", { element(el) { el.append(headTags(meta), { html: true }); } })
    .transform(response);
}

async function articlePage(request: Request, url: URL, rawSlug: string, env: Env): Promise<Response> {
  let slug: string;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    return renderShell(request, url, env, missingArticleMeta(url.pathname, url.origin), 404);
  }
  const base = apiBase(env);
  if (!base) return renderShell(request, url, env, genericMeta(url));
  try {
    const res = await fetch(`${base}/public/articles/${encodeURIComponent(slug)}`, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: API_CACHE_SECONDS, cacheEverything: true }
    });
    if (res.status === 404) return renderShell(request, url, env, missingArticleMeta(url.pathname, url.origin), 404);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const { article } = await res.json() as { article: PublicArticle };
    return renderShell(request, url, env, articlePageMeta(article, url.origin));
  } catch (error) {
    // The SPA still renders the article client-side; only the preview tags are generic.
    console.error("Article metadata unavailable:", error);
    return renderShell(request, url, env, genericMeta(url));
  }
}

/** Course sales pages: share tags from the public sales-page API (published courses only). */
async function coursePage(request: Request, url: URL, rawId: string, env: Env): Promise<Response> {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return renderShell(request, url, env, missingCourseMeta(url.pathname, url.origin), 404);
  }
  const base = apiBase(env);
  if (!base) return renderShell(request, url, env, genericMeta(url));
  try {
    const res = await fetch(`${base}/public/marketing/courses/${encodeURIComponent(id)}`, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: API_CACHE_SECONDS, cacheEverything: true }
    });
    if (res.status === 404) return renderShell(request, url, env, missingCourseMeta(url.pathname, url.origin), 404);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const { course } = await res.json() as { course: PublicCourse };
    return renderShell(request, url, env, coursePageMeta(course, url.origin));
  } catch (error) {
    console.error("Course metadata unavailable:", error);
    return renderShell(request, url, env, genericMeta(url));
  }
}

/** Website-builder pages (/p/:slug): share tags from the published page's SEO fields. Drafts are 404 in the API. */
async function customPage(request: Request, url: URL, rawSlug: string, env: Env): Promise<Response> {
  let slug: string;
  try {
    slug = decodeURIComponent(rawSlug).toLowerCase();
  } catch {
    return renderShell(request, url, env, missingCustomPageMeta(url.pathname, url.origin), 404);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return renderShell(request, url, env, missingCustomPageMeta(url.pathname, url.origin), 404);
  const base = apiBase(env);
  if (!base) return renderShell(request, url, env, genericMeta(url));
  try {
    const res = await fetch(`${base}/public/website/pages/${encodeURIComponent(slug)}`, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 60, cacheEverything: true }
    });
    if (res.status === 404) return renderShell(request, url, env, missingCustomPageMeta(url.pathname, url.origin), 404);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const { page } = await res.json() as { page: PublicCustomPage };
    return renderShell(request, url, env, customPageMeta(page, url.origin));
  } catch (error) {
    console.error("Custom page metadata unavailable:", error);
    return renderShell(request, url, env, genericMeta(url));
  }
}

/** Published custom pages for the sitemap; null when the API is unreachable (partial sitemap). */
async function customPagesForSitemap(env: Env): Promise<PublicCustomPage[] | null> {
  const base = apiBase(env);
  if (!base) return [];
  try {
    const res = await fetch(`${base}/public/website/pages`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return (await res.json() as { pages: PublicCustomPage[] }).pages;
  } catch (error) {
    console.error("Sitemap page listing failed:", error);
    return null;
  }
}

/** /manifest.webmanifest with the school name from the theme; the static file in dist/ is the fallback. */
async function manifest(request: Request, env: Env): Promise<Response> {
  const base = apiBase(env);
  if (!base) return env.ASSETS.fetch(request);
  try {
    const res = await fetch(`${base}/public/website/theme`, { headers: { accept: "application/json" }, cf: { cacheTtl: API_CACHE_SECONDS, cacheEverything: true } });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const { theme } = await res.json() as { theme: { school_name?: string; primary_color?: string } };
    return plain(manifestJson(theme), "application/manifest+json; charset=utf-8", 3600);
  } catch (error) {
    console.error("Manifest theme unavailable:", error);
    return env.ASSETS.fetch(request);
  }
}

async function sitemap(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cacheKey = new Request(url.origin + "/sitemap.xml");
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const articles: PublicArticle[] = [];
  let complete = false;
  const base = apiBase(env);
  if (base) {
    try {
      for (let offset = 0; offset < 10_000; offset += 48) {
        const res = await fetch(`${base}/public/articles?limit=48&offset=${offset}`, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const page = await res.json() as { articles: PublicArticle[]; total: number };
        articles.push(...page.articles);
        if (page.articles.length === 0 || articles.length >= page.total) break;
      }
      complete = true;
    } catch (error) {
      console.error("Sitemap article listing failed:", error);
    }
  }
  // A partial sitemap (API down or unset) still lists the static pages, but is not cached for long.
  let courses: Array<{ id: string; slug?: string | null }> = [];
  if (base) {
    try {
      const res = await fetch(`${base}/courses`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`API ${res.status}`);
      courses = await res.json() as Array<{ id: string; slug?: string | null }>;
    } catch (error) {
      complete = false;
      console.error("Sitemap course listing failed:", error);
    }
  }
  const pages = await customPagesForSitemap(env);
  if (pages === null) complete = false;
  const response = plain(sitemapXml([...sitemapEntries(url.origin, articles, courses), ...customPageSitemapEntries(url.origin, pages ?? [])]),
    "application/xml; charset=utf-8", complete ? 3600 : 60);
  if (complete) ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return env.ASSETS.fetch(request);
    if (url.pathname === "/sitemap.xml") return sitemap(url, env, ctx);
    if (url.pathname === "/robots.txt") return plain(robotsTxt(url.origin), "text/plain; charset=utf-8", 86400);
    if (url.pathname === "/manifest.webmanifest") return manifest(request, env);
    const pageSlug = CUSTOM_PAGE_PATH.exec(url.pathname)?.[1];
    if (pageSlug) return customPage(request, url, pageSlug, env);
    const slug = ARTICLE_PATH.exec(url.pathname)?.[1];
    if (slug) return articlePage(request, url, slug, env);
    const courseId = COURSE_PATH.exec(url.pathname)?.[1];
    if (courseId) return coursePage(request, url, courseId, env);
    const meta = staticPageMeta(url.pathname, url.origin);
    return meta ? renderShell(request, url, env, meta) : env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
