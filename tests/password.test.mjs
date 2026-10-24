import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { hashPassword, verifyPassword, needsPasswordUpgrade } from '../backend/src/utils/crypto.ts';

test('PBKDF2 hashes have random salts and verify only the correct password', async () => {
  const password = 'a-test-password-with-unicode-กขค';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('wrong', first), false);
  assert.equal(needsPasswordUpgrade(first), false);
});

test('legacy SHA-256 is verified for upgrade; plaintext is rejected by default', async () => {
  const old = 'legacy-salt:' + createHash('sha256').update('legacy-saltpassword').digest('hex');
  assert.equal(await verifyPassword('password', old), true);
  assert.equal(await verifyPassword('wrong', old), false);
  assert.equal(needsPasswordUpgrade(old), true);
  assert.equal(await verifyPassword('seed-only', 'seed-only'), false);
  assert.equal(await verifyPassword('seed-only', 'seed-only', true), true);
});

test('malformed or excessive-work-factor hashes fail closed', async () => {
  for (const stored of ['', 'pbkdf2-sha256$1$salt$hash', 'pbkdf2-sha256$1000000$00$00', 'pbkdf2-sha256$100000$zz$00']) {
    assert.equal(await verifyPassword('password', stored), false);
  }
});
