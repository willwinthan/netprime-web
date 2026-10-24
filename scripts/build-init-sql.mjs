#!/usr/bin/env node
// สร้าง backend/init.sql สำหรับ "ฐานข้อมูล D1 ใหม่ที่ว่างเปล่า" (staging/production) จาก backend/schema.sql
//
// schema.sql ใช้กับ local/test เท่านั้น: เริ่มด้วย DROP TABLE และใส่บัญชีเดโมรหัสผ่าน plaintext
// สคริปต์นี้อ่าน schema.sql ตอนรัน (ไม่ hard-code รายชื่อตาราง) แล้ว:
//   - ตัดทุก DROP และ PRAGMA ทิ้ง
//   - CREATE TABLE/INDEX/TRIGGER/VIEW -> เติม IF NOT EXISTS (รันซ้ำได้)
//   - INSERT เก็บไว้เฉพาะตารางใน REFERENCE_TABLES ด้านล่าง (แปลงเป็น INSERT OR IGNORE) ที่เหลือคือข้อมูลเดโม ตัดทิ้ง
//   - สร้างตาราง d1_migrations และบันทึกทุกไฟล์ใน backend/migrations ว่า apply แล้ว
//     (schema.sql คือสถานะล่าสุดหลังทุก migration แล้ว) `wrangler d1 migrations apply` จึงไม่รันซ้ำ
//   - UPDATE/DELETE ที่แก้ seed: เก็บเฉพาะของ REFERENCE_TABLES
//   - ALTER TABLE ... ADD COLUMN -> รวมคอลัมน์เข้าไปใน CREATE TABLE ของตารางนั้น (ลำดับคอลัมน์เหมือนเดิม) เพื่อให้รันซ้ำได้
//   - statement ชนิดอื่น (ALTER/...) -> หยุดพร้อม error ให้คนตรวจ
//
// การตัดสินใจรายตาราง (seed ใน schema.sql ณ 24 ต.ค. 2026):
//   เก็บ  role_permissions   สิทธิ์เริ่มต้นของแต่ละบทบาท (เหมือน migration 0008/0010) ไม่มีจะใช้เมนูไม่ได้
//   เก็บ  achievements       นิยาม badge; โค้ดอ้าง id ตรง ๆ (ach_first_log, ach_high_eval, ach_diligent_work)
//   ตัด   site_settings      แถว 'site' เป็นข้อมูลติดต่อเดโม (02-000-0000, admin@netprime.com);
//                            โค้ดรองรับกรณีไม่มีแถว ให้ admin กรอกเองใน "ตั้งค่าเว็บไซต์"
//   ตัด   payment_settings   แถว 'bank_transfer' เป็นบัญชีธนาคารตัวอย่าง (000-0-00000-0) ห้ามให้ลูกค้าโอนเข้า
//                            admin ต้องกรอกบัญชีจริงในหน้าตั้งค่าการชำระเงินก่อนเปิดขาย
//   ตัด   vouchers           โค้ดส่วนลดเดโม (รวม DEMO-FREE100 ลด 100%) อันตรายถ้าหลุดไป production
//   ตัด   partners, users, courses, partner_courses, lessons, enrollments, quizzes,
//         internship_*, user_gamification, user_achievements, it_projects, training_sessions,
//         session_registrations, articles, promotions, inquiries  -> ข้อมูลเดโม/บุคคลสมมติ
//   ตารางที่มี seed แต่ไม่อยู่ในรายการเก็บจะถูกตัดอัตโนมัติและพิมพ์รายชื่อเตือน
//   ถ้ามีตารางอ้างอิงใหม่ที่ระบบต้องมีข้อมูลตั้งต้น ให้เพิ่มชื่อใน REFERENCE_TABLES
//
// ใช้:  node scripts/build-init-sql.mjs            สร้าง backend/init.sql
//       node scripts/build-init-sql.mjs --verify   สร้าง + ทดสอบกับ SQLite ในหน่วยความจำ (ต้องใช้ Node >= 22.13)
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REFERENCE_TABLES = new Set(['role_permissions', 'achievements']);

const root = fileURLToPath(new URL('../', import.meta.url));
const schemaPath = resolve(root, 'backend/schema.sql');
const migrationsDir = resolve(root, 'backend/migrations');
const outPath = resolve(root, 'backend/init.sql');

/** Split SQL into statements, dropping comments. Handles quotes and CREATE TRIGGER ... BEGIN ... END; */
export function splitSql(sql) {
  const statements = [];
  let current = '';
  let words = []; // first keywords of the current statement
  let inTrigger = false, sawBegin = false, caseDepth = 0, lastWord = '';
  let i = 0;
  const flush = () => {
    const text = current.trim();
    if (text) statements.push(text);
    current = ''; words = []; inTrigger = false; sawBegin = false; caseDepth = 0; lastWord = '';
  };
  while (i < sql.length) {
    const ch = sql[i], next = sql[i + 1];
    if (ch === '-' && next === '-') { // line comment
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') { // block comment
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      current += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) { j += 2; continue; } // escaped '' or ""
          break;
        }
        j++;
      }
      if (j >= sql.length) throw new Error(`Unterminated ${ch} quote near: ${sql.slice(i, i + 60)}`);
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const word = sql.slice(i, j).toUpperCase();
      if (words.length < 4) {
        words.push(word);
        if (words[0] === 'CREATE' && (word === 'TRIGGER')) inTrigger = true;
      }
      if (inTrigger) {
        if (word === 'BEGIN') sawBegin = true;
        else if (word === 'CASE') caseDepth++;
        else if (word === 'END' && caseDepth > 0) caseDepth--;
        lastWord = word;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ';') {
      if (inTrigger && !(sawBegin && lastWord === 'END' && caseDepth === 0)) {
        current += ch; lastWord = ';'; i++;
        continue;
      }
      flush();
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  flush();
  return statements;
}

function transform(statement) {
  const s = statement.replace(/\s+/g, ' ').trim();
  let m;
  if (/^DROP\s/i.test(s)) return { kind: 'drop' };
  if (/^PRAGMA\s/i.test(s)) return { kind: 'pragma' };
  if ((m = /^CREATE\s+(?:(TEMP|TEMPORARY)\s+)?(UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(IF\s+NOT\s+EXISTS\s+)?/i.exec(statement))) {
    if (m[1]) throw new Error(`TEMP objects are not supported in init.sql: ${s.slice(0, 80)}`);
    const head = `CREATE ${m[2] ? 'UNIQUE ' : ''}${m[3].toUpperCase()} IF NOT EXISTS `;
    return { kind: 'create', sql: head + statement.slice(m[0].length) };
  }
  if ((m = /^(?:INSERT|REPLACE)(?:\s+OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK))?\s+INTO\s+["`[]?(\w+)["`\]]?/i.exec(statement))) {
    const table = m[1];
    if (!REFERENCE_TABLES.has(table)) return { kind: 'seed-skipped', table };
    return { kind: 'seed', table, sql: `INSERT OR IGNORE INTO ${table}` + statement.slice(m[0].length) };
  }
  // UPDATE/DELETE in schema.sql only adjust seed rows: keep them for reference tables, drop the rest.
  if ((m = /^(?:UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?(\w+)["`\]]?/i.exec(statement))) {
    const table = m[1];
    if (!REFERENCE_TABLES.has(table)) return { kind: 'seed-skipped', table };
    return { kind: 'seed', table, sql: statement };
  }
  if ((m = /^ALTER\s+TABLE\s+["`[]?(\w+)["`\]]?\s+ADD\s+(?:COLUMN\s+)?/i.exec(statement))) {
    return { kind: 'add-column', table: m[1], column: statement.slice(m[0].length).trim() };
  }
  throw new Error(`Unsupported statement in schema.sql (init.sql must be safe to run on an empty DB): ${s.slice(0, 120)}`);
}

/** Split the CREATE TABLE body on top-level commas, respecting parentheses and quotes. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0, start = 0, quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '[') quote = ']';
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts;
}

/** ALTER TABLE ... ADD COLUMN in schema.sql -> fold the column into the CREATE TABLE so init.sql stays re-runnable. */
function addColumn(createSql, column) {
  const open = createSql.indexOf('(');
  const close = createSql.lastIndexOf(')');
  if (open === -1 || close < open) throw new Error(`Cannot parse CREATE TABLE: ${createSql.slice(0, 80)}`);
  const parts = splitTopLevel(createSql.slice(open + 1, close));
  // Columns must come before table constraints.
  let at = parts.findIndex(part => /^\s*(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(part));
  if (at === -1) at = parts.length;
  const indent = (/\n([ \t]+)/.exec(createSql) || [, '    '])[1];
  const appending = at === parts.length;
  parts[at - 1] = parts[at - 1].replace(/\s+$/, '');
  parts.splice(at, 0, `\n${indent}${column}${appending ? '\n' : ''}`);
  return createSql.slice(0, open + 1) + parts.join(',') + createSql.slice(close);
}

export async function buildInitSql() {
  const schema = await readFile(schemaPath, 'utf8');
  const migrations = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
  const out = [];
  const skipped = new Map();
  const kept = new Map();
  const tableIndex = new Map(); // table -> index of its CREATE TABLE in out
  let creates = 0, folded = 0;
  for (const statement of splitSql(schema)) {
    const result = transform(statement);
    if (result.kind === 'create') {
      const table = /^CREATE TABLE IF NOT EXISTS\s+["`[]?(\w+)/i.exec(result.sql)?.[1];
      if (table) tableIndex.set(table, out.length);
      out.push(result.sql + ';'); creates++;
    }
    else if (result.kind === 'add-column') {
      if (!tableIndex.has(result.table)) throw new Error(`ALTER TABLE ${result.table} ADD COLUMN before its CREATE TABLE`);
      const index = tableIndex.get(result.table);
      out[index] = addColumn(out[index].replace(/;$/, ''), result.column) + ';';
      folded++;
    }
    else if (result.kind === 'seed') { out.push(result.sql + ';'); kept.set(result.table, (kept.get(result.table) || 0) + 1); }
    else if (result.kind === 'seed-skipped') skipped.set(result.table, (skipped.get(result.table) || 0) + 1);
  }
  for (const table of REFERENCE_TABLES) {
    if (!kept.has(table)) console.warn(`warning: reference table "${table}" has no INSERT in schema.sql`);
  }
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const header = [
    '-- GENERATED by scripts/build-init-sql.mjs from backend/schema.sql - DO NOT EDIT.',
    '-- For a NEW, EMPTY D1 database only (no DROP, no demo data). Rebuild: pnpm run db:init-sql',
    `-- Migrations recorded as applied: ${migrations.length ? `${migrations[0]} .. ${migrations.at(-1)}` : '(none)'}`,
    ''
  ];
  const footer = [
    '',
    '-- Mark every existing migration as applied: schema.sql already contains their result.',
    'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);',
    ...(migrations.length ? [`INSERT OR IGNORE INTO d1_migrations (name) VALUES\n${migrations.map(name => `(${quote(name)})`).join(',\n')};`] : []),
    ''
  ];
  await writeFile(outPath, header.join('\n') + out.join('\n\n') + '\n' + footer.join('\n'));
  console.log(`Wrote backend/init.sql: ${creates} CREATE statements (${folded} ADD COLUMN folded in), reference data for ${[...kept.keys()].join(', ') || '(none)'}, ${migrations.length} migrations marked applied`);
  if (skipped.size) console.log(`Skipped demo seed data for: ${[...skipped.keys()].join(', ')}`);
  return { migrations, kept, skipped };
}

async function verify({ migrations, kept }) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error('--verify needs node:sqlite (Node >= 22.13)'); }
  const schema = await readFile(schemaPath, 'utf8');
  const init = await readFile(outPath, 'utf8');
  const reference = new DatabaseSync(':memory:');
  reference.exec(schema);
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(init);
  fresh.exec(init); // must be idempotent
  const objects = db => db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY type, name").all()
    .map(row => `${row.type}:${row.name}`);
  const columns = (db, table) => JSON.stringify([
    db.prepare(`PRAGMA table_info("${table}")`).all().map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
    db.prepare(`PRAGMA foreign_key_list("${table}")`).all().map(f => [f.table, f.from, f.to, f.on_delete]).sort(),
    db.prepare(`PRAGMA index_list("${table}")`).all().map(i => [i.name.startsWith('sqlite_autoindex') ? 'auto' : i.name, i.unique, i.partial]).sort()
  ]);
  const a = objects(reference), b = objects(fresh);
  const fail = message => { throw new Error(`verify failed: ${message}`); };
  if (a.join() !== b.join()) fail(`schema objects differ\n  schema.sql only: ${a.filter(x => !b.includes(x)).join(', ')}\n  init.sql only: ${b.filter(x => !a.includes(x)).join(', ')}`);
  for (const entry of a.filter(x => x.startsWith('table:'))) {
    const table = entry.slice(6);
    if (columns(reference, table) !== columns(fresh, table)) fail(`columns/foreign keys/indexes differ for ${table}`);
    const count = fresh.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    if (REFERENCE_TABLES.has(table)) {
      const expected = reference.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
      if (count !== expected) fail(`${table} has ${count} rows, expected ${expected}`);
    } else if (count !== 0) fail(`${table} should be empty but has ${count} rows`);
  }
  const applied = fresh.prepare('SELECT name FROM d1_migrations ORDER BY name').all().map(row => row.name);
  if (applied.join() !== migrations.join()) fail('d1_migrations does not list every migration file');
  console.log(`Verified: ${b.length} objects match schema.sql, demo tables empty, ${[...kept.keys()].join(' + ')} seeded, ${applied.length} migrations recorded, re-run is safe`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await buildInitSql();
    if (process.argv.includes('--verify')) await verify(result);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
