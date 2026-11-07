#!/usr/bin/env node
// สร้างไฟล์ SQL บัญชีทดสอบสำหรับ staging (หรือฐานข้อมูลจริงอื่น) ไฟล์มีแค่ password hash ไม่มีรหัสผ่าน
// รหัสผ่านพิมพ์ใน terminal แบบไม่แสดงตัวอักษร อย่างน้อย 12 ตัวอักษร ห้ามใช้รหัสเดโมใน docs/TESTING.md
//
// ใช้:  node scripts/test-accounts-sql.mjs \
//         --account "instructor:teacher@example.com:ผู้สอนทดสอบ" \
//         --account "coordinator:coord@example.com:เจ้าหน้าที่ทดสอบ" \
//         --account "student:learner@example.com:ผู้เรียนทดสอบ"
//       แล้ว: cd backend && npx wrangler d1 execute netprime-db-staging --remote --env staging --file ../staging-test-accounts.sql.local
//
//   --account <บทบาท:อีเมล:ชื่อ>  ใส่ได้หลายครั้ง บทบาท: admin, coordinator, instructor, student
//                                  (บัญชีพาร์ตเนอร์ต้องผูกกับองค์กร ให้สร้างในหลังบ้านแทน)
//   --same-password               ใช้รหัสผ่านเดียวกันทุกบัญชี (ถามครั้งเดียว) ไม่ใส่จะถามทีละบัญชี
//   --out <ไฟล์>                  ค่าเริ่มต้น staging-test-accounts.sql.local (นามสกุล .local ถูก git ละเว้น)
//
// รันไฟล์ซ้ำได้: อีเมลที่มีอยู่แล้วจะถูกตั้งรหัสผ่าน ชื่อ และบทบาทนี้ใหม่ เปิดใช้งาน และยืนยันอีเมลให้ ไม่สร้างซ้ำ
import { webcrypto as crypto } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { hashPassword, MIN_LENGTH, readHidden } from './hash-password.mjs';

const ROLES = ['admin', 'coordinator', 'instructor', 'student'];
const DEMO_PASSWORDS = new Set(['admin123', 'inst123', 'partner123', 'stud123', 'coord123']);

const args = process.argv.slice(2);
const values = name => args.flatMap((a, i) => a === `--${name}` && args[i + 1] !== undefined ? [args[i + 1]] : []);
const out = values('out')[0] || 'staging-test-accounts.sql.local';
const samePassword = args.includes('--same-password');
const q = value => `'${String(value).replace(/'/g, "''")}'`;

function parseAccount(spec) {
  const [role, email, ...rest] = spec.split(':');
  const name = rest.join(':').trim();
  if (!ROLES.includes(role)) throw new Error(`บทบาท "${role}" ไม่ถูกต้อง ใช้ได้: ${ROLES.join(', ')}`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) throw new Error(`อีเมล "${email}" ไม่ถูกต้อง`);
  if (!name) throw new Error(`ต้องระบุชื่อของ ${email} เช่น "${role}:${email}:ชื่อ"`);
  return { role, email: email.trim().toLowerCase(), name };
}

async function askPassword(label) {
  const password = await readHidden(`รหัสผ่าน${label}: `);
  if (password.length < MIN_LENGTH) throw new Error(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_LENGTH} ตัวอักษร`);
  if (DEMO_PASSWORDS.has(password)) throw new Error('ห้ามใช้รหัสผ่านเดโมที่อยู่ใน repo');
  if ((await readHidden(`ยืนยันรหัสผ่าน${label}: `)) !== password) throw new Error('รหัสผ่านไม่ตรงกัน');
  return password;
}

/** One account: insert, or reset an existing email to this name, role and password. */
function accountSql({ role, email, name }, hash) {
  // Coordinators keep base role 'student' with staff_role (migrations/0006_staff_role.sql).
  const base = role === 'coordinator' ? 'student' : role;
  const staff = role === 'coordinator' ? q('coordinator') : 'NULL';
  return `-- ${role}: ${email}
INSERT INTO users (id, email, password_hash, name, role, staff_role, partner_id, email_verified_at)
VALUES (${q(`usr_${crypto.randomUUID()}`)}, ${q(email)}, ${q(hash)}, ${q(name)}, ${q(base)}, ${staff}, NULL, CURRENT_TIMESTAMP)
ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, name = excluded.name, role = excluded.role,
  staff_role = excluded.staff_role, status = 'active', email_verified_at = COALESCE(users.email_verified_at, CURRENT_TIMESTAMP),
  sessions_revoked_at = ${q(new Date().toISOString())};
INSERT OR IGNORE INTO user_roles (user_id, role) SELECT id, ${q(role)} FROM users WHERE email = ${q(email)};`;
}

try {
  const accounts = values('account').map(parseAccount);
  if (!accounts.length) throw new Error('ระบุบัญชีอย่างน้อย 1 บัญชีด้วย --account "บทบาท:อีเมล:ชื่อ" (ดูวิธีใช้ที่หัวไฟล์ scripts/test-accounts-sql.mjs)');
  if (new Set(accounts.map(a => a.email)).size !== accounts.length) throw new Error('มีอีเมลซ้ำกันใน --account');
  if (!process.stdin.isTTY) throw new Error('รันใน terminal เพื่อพิมพ์รหัสผ่านแบบซ่อนตัวอักษร');

  const shared = samePassword ? await askPassword(' (ใช้กับทุกบัญชี)') : null;
  const statements = [];
  for (const account of accounts) {
    const password = shared ?? await askPassword(` ของ ${account.email}`);
    statements.push(accountSql(account, await hashPassword(password)));
  }
  await writeFile(out, `-- NetPrime test accounts (generated ${new Date().toISOString()}). Contains password HASHES only; do not commit.
${statements.join('\n\n')}
`, { mode: 0o600 });
  console.log(`เขียน ${out} แล้ว (${accounts.length} บัญชี)`);
  console.log(`ต่อไป: cd backend && npx wrangler d1 execute netprime-db-staging --remote --env staging --file ../${out}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
