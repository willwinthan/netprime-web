#!/usr/bin/env node
// สร้าง password hash รูปแบบเดียวกับ backend/src/utils/crypto.ts (PBKDF2-SHA256 100,000 รอบ, salt 16 ไบต์)
// ผลลัพธ์: pbkdf2-sha256$100000$<salt hex>$<hash hex>
//
// รหัสผ่านอ่านจาก terminal แบบไม่แสดงตัวอักษร (หรือจาก stdin ถ้า pipe เข้ามา) ไม่รับทาง argument เพื่อไม่ให้ค้างใน shell history
//   node scripts/hash-password.mjs                                   -> พิมพ์เฉพาะ hash
//   node scripts/hash-password.mjs --email admin@example.com --name "ผู้ดูแลระบบ" > first-admin.sql
//                                                                    -> พิมพ์ SQL สร้าง admin คนแรก (ไฟล์มีแค่ hash ไม่มีรหัสผ่าน)
import { webcrypto as crypto } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ITERATIONS = 100_000; // ต้องตรงกับ ITERATIONS ใน backend/src/utils/crypto.ts
const MIN_LENGTH = 12;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return `pbkdf2-sha256$${ITERATIONS}$${hex(salt)}$${hex(new Uint8Array(bits))}`;
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readHidden(prompt) {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) { // piped input: first line
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.split(/\r?\n/)[0];
  }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let value = '';
  return new Promise((resolve, reject) => {
    const onData = chars => {
      for (const ch of chars) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stderr.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') { stdin.setRawMode(false); stderr.write('\n'); return reject(new Error('ยกเลิก')); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const email = arg('email')?.trim().toLowerCase();
    const name = arg('name')?.trim();
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name)) throw new Error('ต้องระบุ --email ที่ถูกต้องและ --name');
    const password = await readHidden('รหัสผ่าน: ');
    if (password.length < MIN_LENGTH) throw new Error(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_LENGTH} ตัวอักษร`);
    if (process.stdin.isTTY && (await readHidden('ยืนยันรหัสผ่าน: ')) !== password) throw new Error('รหัสผ่านไม่ตรงกัน');
    const hash = await hashPassword(password);
    if (!email) {
      console.log(hash);
    } else {
      const q = value => `'${value.replace(/'/g, "''")}'`;
      const id = `usr_${crypto.randomUUID()}`;
      // trigger users_primary_role ใส่ user_roles ('admin') ให้อัตโนมัติ
      console.log(`-- First admin for NetPrime LMS (generated ${new Date().toISOString()}). Contains a password HASH only.
INSERT INTO users (id, email, password_hash, name, role, partner_id, email_verified_at)
VALUES (${q(id)}, ${q(email)}, ${q(hash)}, ${q(name)}, 'admin', NULL, CURRENT_TIMESTAMP);
INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (${q(id)}, 'admin');`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
