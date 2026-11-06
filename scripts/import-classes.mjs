#!/usr/bin/env node
// สร้างรอบอบรมจากเว็บเก่า (scripts/class-import/sessions.json) ผ่าน API: Virtual Classroom เป็นแบบร่าง ส่วนรอบ Classroom ที่มีวันจริงเปิดรับสมัครทันที
// แบบร่างใช้วันชั่วคราว 2027-12-31 เจ้าหน้าที่ต้องใส่วันจริง ราคา และเปิดรับสมัครเองในหน้าจัดการรอบ
//
// ใช้:  NETPRIME_TOKEN=<JWT ของ admin> node scripts/import-classes.mjs --base <URL ของ backend> --site <URL ของเว็บ>
// รันซ้ำได้: รอบที่มีชื่อนี้แล้วจะไม่สร้างซ้ำ และยังพิมพ์ลิงก์ลงทะเบียนให้เหมือนเดิม
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1]?.replace(/\/$/, '') : null;
const base = option('--base');
const site = option('--site');
const token = process.env.NETPRIME_TOKEN;
if (!base || !site || !token) {
  console.error('ต้องระบุ --base <URL ของ backend>, --site <URL ของเว็บ> และตัวแปร NETPRIME_TOKEN');
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path}: ${res.status} ${data.error || ''}`);
  return data;
}

const classes = JSON.parse(await readFile(fileURLToPath(new URL('./class-import/sessions.json', import.meta.url)), 'utf8'));
const { sessions } = await api('/admin/site/sessions?limit=200');
const byTitle = new Map(sessions.map(session => [session.title, session]));
for (const { old_url, duration, level, outline, ...round } of classes) {
  const session = byTitle.get(round.title) ?? (await api('/admin/site/sessions', { method: 'POST', body: JSON.stringify(round) })).session;
  console.log(`${byTitle.has(round.title) ? 'มีอยู่แล้ว' : 'สร้างแล้ว'}\t${round.title}\t${site}/schedule?register=${session.id}`);
}
