#!/usr/bin/env node
// นำบทความจากเว็บเก่า (scripts/blog-import/articles.json) เข้าระบบผ่าน API ของ backend
// รูปจะถูกดาวน์โหลดจาก LearnWorlds แล้วอัปโหลดเข้า R2 จึงต้องรันก่อนปิดบัญชี LearnWorlds
//
// ใช้:  NETPRIME_TOKEN=<JWT ของ admin> node scripts/import-blog.mjs --base http://127.0.0.1:8788
//       เพิ่ม --dry-run เพื่อดูรายการโดยยังไม่เขียนอะไร
// รันซ้ำได้: บทความที่มี slug นี้แล้วจะถูกข้าม ไม่เขียนทับสิ่งที่แก้ในระบบใหม่
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1]?.replace(/\/$/, '') : null;
const dryRun = args.includes('--dry-run');
const token = process.env.NETPRIME_TOKEN;
if (!base || !token) {
  console.error('ต้องระบุ --base <URL ของ backend> และตัวแปร NETPRIME_TOKEN');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${token}` };
const OLD_IMAGE = /https:\/\/lwfiles\.mycourse\.app\/[^\s)"']+/g;
const uploaded = new Map();

async function api(path, init = {}) {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path}: ${res.status} ${data.error || ''}`);
  return data;
}

async function existingSlugs() {
  const slugs = new Set();
  for (let offset = 0; ;) {
    const { articles, total } = await api(`/admin/site/articles?limit=100&offset=${offset}`);
    articles.forEach(article => slugs.add(article.slug));
    offset += articles.length;
    if (offset >= total || articles.length === 0) return slugs;
  }
}

async function rehost(url) {
  if (uploaded.has(url)) return uploaded.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ดาวน์โหลดรูปไม่ได้ ${url}: ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0];
  const form = new FormData();
  form.append('file', new Blob([await res.arrayBuffer()], { type }), url.split('/').pop());
  const { url: hosted } = await api('/admin/site/images', { method: 'POST', body: form });
  uploaded.set(url, hosted);
  return hosted;
}

const articles = JSON.parse(await readFile(fileURLToPath(new URL('./blog-import/articles.json', import.meta.url)), 'utf8'));
const existing = await existingSlugs();
let created = 0;
for (const { old_categories, ...article } of articles) {
  if (existing.has(article.slug)) {
    console.log(`ข้าม ${article.slug} (มีอยู่แล้ว)`);
    continue;
  }
  const images = new Set(article.body.match(OLD_IMAGE) || []);
  if (dryRun) {
    console.log(`จะนำเข้า ${article.slug} (${images.size} รูปในเนื้อหา)`);
    continue;
  }
  for (const url of images) article.body = article.body.replaceAll(url, await rehost(url));
  if (article.cover_url) article.cover_url = await rehost(article.cover_url);
  await api('/admin/site/articles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(article) });
  created++;
  console.log(`นำเข้า ${article.slug} (${images.size} รูป)`);
}
console.log(`เสร็จ: นำเข้า ${created} บทความ, อัปโหลด ${uploaded.size} รูป`);
