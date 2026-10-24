// Unit tests for the frontend Worker's share tags and sitemap (pure functions, no Worker runtime needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  absoluteUrl, articlePageMeta, headTags, missingArticleMeta, robotsTxt, sitemapEntries, sitemapXml, staticPageMeta, summarize
} from '../frontend-admin/worker/meta.ts';

const origin = 'https://www.netprime.example';
const article = {
  slug: 'ccna-study-plan', title: 'เตรียมสอบ "CCNA" <ให้ผ่าน>', excerpt: 'แผนอ่าน 6 สัปดาห์',
  cover_url: 'https://api.netprime.example/api/public/images/abc.jpg', category: 'Cisco', published_at: '2026-10-18 09:00:00'
};

test('article pages get absolute, escaped share tags', () => {
  const meta = articlePageMeta(article, origin);
  assert.equal(meta.url, `${origin}/blog/ccna-study-plan`);
  assert.equal(meta.image, article.cover_url);
  assert.equal(meta.publishedTime, '2026-10-18T09:00:00Z');
  const html = headTags(meta);
  assert.match(html, /<meta property="og:title" content="เตรียมสอบ &quot;CCNA&quot; &lt;ให้ผ่าน&gt; \| NetPrime">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/api\.netprime\.example\/api\/public\/images\/abc\.jpg">/);
  assert.match(html, /<meta property="og:type" content="article">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.netprime\.example\/blog\/ccna-study-plan">/);
  assert.ok(!html.includes('<ให้ผ่าน>'), 'raw markup must never reach the head');
});

test('missing covers, relative covers and unsafe covers fall back safely', () => {
  assert.equal(articlePageMeta({ ...article, cover_url: null }, origin).image, `${origin}/og-default.jpg`);
  assert.equal(articlePageMeta({ ...article, cover_url: '/uploads/a.png' }, origin).image, `${origin}/uploads/a.png`);
  assert.equal(articlePageMeta({ ...article, cover_url: 'javascript:alert(1)' }, origin).image, `${origin}/og-default.jpg`);
  assert.equal(absoluteUrl('//evil.example/x.png', origin), null);
});

test('descriptions come from the excerpt, else a plain summary of the Markdown body', () => {
  const meta = articlePageMeta({ ...article, excerpt: null, body: '## หัวข้อ\n\nอ่าน **OSI** และ [subnetting](https://x.example)\n\n```\nvlan 10\n```' }, origin);
  assert.equal(meta.description, 'หัวข้อ อ่าน OSI และ subnetting');
  assert.ok(summarize('ก'.repeat(500)).length <= 160);
});

test('static pages and missing articles', () => {
  const blog = staticPageMeta('/blog', origin);
  assert.equal(blog.title, 'บทความ | NetPrime');
  assert.equal(staticPageMeta('/dashboard', origin), null);
  const missing = headTags(missingArticleMeta('/blog/nope', origin));
  assert.match(missing, /<meta name="robots" content="noindex">/);
  assert.ok(!missing.includes('rel="canonical"'));
});

test('sitemap lists public pages and articles; robots points to it', () => {
  const xml = sitemapXml(sitemapEntries(origin, [{ slug: 'ccna-study-plan', published_at: '2026-10-18 09:00:00' }]));
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  for (const path of ['/', '/courses', '/schedule', '/blog', '/about']) assert.ok(xml.includes(`<loc>${origin}${path}</loc>`), path);
  assert.ok(xml.includes(`<url><loc>${origin}/blog/ccna-study-plan</loc><lastmod>2026-10-18</lastmod></url>`));
  assert.ok(!xml.includes('/dashboard'));
  assert.match(robotsTxt(origin), /Sitemap: https:\/\/www\.netprime\.example\/sitemap\.xml/);
  assert.match(robotsTxt(origin), /Disallow: \/dashboard/);
});
