#!/usr/bin/env node
// ย้ายบทเรียน Self-learning ที่เคยฝังไว้ในโค้ด (scripts/self-learning/*.html) เข้าระบบจัดการบทเรียน แล้วเผยแพร่
// ตอนนี้มีบทเดียวคือ Basic Network หลังจากนี้ให้เพิ่มหรือแก้บทเรียนในหลังบ้าน เมนู "บทเรียน Self-learning"
//
// ใช้:  NETPRIME_TOKEN=<JWT ของ admin> node scripts/import-self-learning.mjs --base <URL ของ backend>
// รันซ้ำได้: บทเรียนที่มี slug นี้แล้วจะถูกข้าม ไม่เขียนทับไฟล์ที่อัปโหลดใหม่ในหลังบ้าน
//       เพิ่ม --update เพื่ออัปโหลดไฟล์ใน repo เป็นเวอร์ชันใหม่ของบทเรียนที่มีอยู่แล้ว (เวอร์ชันเก่ายังย้อนกลับได้ในหลังบ้าน)
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const LESSONS = [
  {
    file: 'basic-network.html',
    slug: 'basic-network',
    title: 'Basic Network: ดูอินเทอร์เน็ตทำงานทีละแพ็กเก็ต',
    title_en: 'Basic Network: watch the internet work, packet by packet',
    summary: 'บทเรียนโต้ตอบ 16 บท ดูแพ็กเก็ตวิ่งบนเครือข่ายและถอดรหัสทีละไบต์ ครอบคลุม DHCP, ARP, IP, ICMP, DNS, TCP, UDP, HTTP, TLS, HTTPS, SMTP, POP3, IMAP, FTP และ SSH',
    summary_en: '16 interactive lessons in Thai: watch packets cross the network and decode them byte by byte, from DHCP and ARP to TLS, HTTPS and SSH.',
    level: 'beginner'
  }
];

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1]?.replace(/\/$/, '') : null;
const update = args.includes('--update');
const token = process.env.NETPRIME_TOKEN;
if (!base || !token) {
  console.error('ต้องระบุ --base <URL ของ backend> และตัวแปร NETPRIME_TOKEN');
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path}: ${res.status} ${data.error || ''}`);
  return data;
}

async function uploadFile(lessonId, file) {
  const html = await readFile(fileURLToPath(new URL(`./self-learning/${file}`, import.meta.url)));
  const form = new FormData();
  form.append('file', new Blob([html], { type: 'text/html' }), file);
  return (await api(`/self-learning/lessons/${lessonId}/file`, { method: 'POST', body: form })).file;
}

const { lessons } = await api('/self-learning/lessons');
const existing = new Map(lessons.map(lesson => [lesson.slug, lesson]));
for (const { file, ...fields } of LESSONS) {
  const found = existing.get(fields.slug);
  if (found) {
    if (!update) { console.log(`ข้าม ${fields.slug} (มีอยู่แล้ว ใช้ --update เพื่ออัปโหลดไฟล์ใหม่)`); continue; }
    const uploaded = await uploadFile(found.id, file);
    console.log(`อัปโหลด ${fields.slug} เป็นเวอร์ชัน ${uploaded.version} (${Math.round(uploaded.size_bytes / 1024)} KB)`);
    continue;
  }
  const { lesson } = await api('/self-learning/lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
  const uploaded = await uploadFile(lesson.id, file);
  await api(`/self-learning/lessons/${lesson.id}/publish`, { method: 'POST' });
  console.log(`นำเข้าและเผยแพร่ ${fields.slug} (${Math.round(uploaded.size_bytes / 1024)} KB)`);
}
