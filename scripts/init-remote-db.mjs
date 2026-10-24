#!/usr/bin/env node
// สร้างโครงสร้างฐานข้อมูล D1 remote ใหม่ (ว่างเปล่า) จาก backend/init.sql
//   pnpm run db:init:remote                     -> netprime-db (production, config ระดับบนสุด)
//   pnpm run db:init:remote -- --env staging    -> netprime-db-staging
// ป้องกัน 2 ชั้น: (1) ปฏิเสธถ้าฐานข้อมูลมีตารางอยู่แล้ว (ฐานเดิมให้ใช้ `wrangler d1 migrations apply`)
//                 (2) ต้องพิมพ์ชื่อฐานข้อมูลยืนยัน หรือตั้ง CONFIRM_INIT_REMOTE=<ชื่อฐานข้อมูล> (สำหรับ CI)
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildInitSql } from './build-init-sql.mjs';

const DATABASES = { production: 'netprime-db', staging: 'netprime-db-staging' };
const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const config = resolve(root, 'backend/wrangler.jsonc');

const envIndex = process.argv.indexOf('--env');
const envName = envIndex === -1 ? 'production' : process.argv[envIndex + 1];
if (!DATABASES[envName]) { console.error(`Unknown --env "${envName}" (use staging or omit for production)`); process.exit(1); }
const database = DATABASES[envName];
const envArgs = envName === 'production' ? [] : ['--env', envName];

function runWrangler(args, capture = false) {
  const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', database, '--remote', '--config', config, ...envArgs, ...args],
    { cwd: root, encoding: 'utf8', stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit' });
  if (result.status !== 0) { console.error(`wrangler exited with ${result.status}`); process.exit(result.status || 1); }
  return result.stdout;
}

await buildInitSql();

console.log(`\nChecking that remote D1 "${database}" (${envName}) is empty…`);
const output = runWrangler(['--json', '--command',
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name"], true);
let tables;
try {
  const parsed = JSON.parse(output.slice(output.indexOf('[')));
  tables = parsed.flatMap(entry => entry.results || []).map(row => row.name);
} catch {
  console.error(`Could not read wrangler output; refusing to continue.\n${output}`);
  process.exit(1);
}
if (tables.length) {
  console.error(`\nREFUSED: "${database}" already has ${tables.length} table(s): ${tables.slice(0, 8).join(', ')}${tables.length > 8 ? ', …' : ''}`);
  console.error('init.sql is only for a brand-new database. For an existing one run:');
  console.error(`  cd backend && npx wrangler d1 migrations apply ${database} --remote${envArgs.length ? ' --env ' + envName : ''}`);
  process.exit(1);
}

const banner = `
############################################################
#  กำลังสร้างตารางใน D1 REMOTE: ${database} (${envName})
#  ไฟล์: backend/init.sql (ไม่มี DROP, ไม่มีข้อมูลเดโม)
############################################################`;
console.log(banner);
let confirmed = process.env.CONFIRM_INIT_REMOTE === database;
if (!confirmed) {
  if (!process.stdin.isTTY) {
    console.error(`Not a terminal: set CONFIRM_INIT_REMOTE=${database} to confirm.`);
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`พิมพ์ชื่อฐานข้อมูล "${database}" เพื่อยืนยัน: `);
  rl.close();
  confirmed = answer.trim() === database;
}
if (!confirmed) { console.error('ยกเลิก: ชื่อไม่ตรง'); process.exit(1); }

runWrangler(['--file', resolve(root, 'backend/init.sql'), ...(process.stdin.isTTY ? [] : ['--yes'])]);
console.log(`\nเสร็จแล้ว ตรวจด้วย: cd backend && npx wrangler d1 migrations list ${database} --remote${envArgs.length ? ' --env ' + envName : ''} (ต้องไม่มีรายการค้าง)`);
