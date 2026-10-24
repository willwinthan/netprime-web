import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

// Each test uses its own client IP so the per-IP rate limits of one test never affect another.
let ipCounter = 0;
const freshIp = () => `198.51.100.${++ipCounter}`;
const as = ip => ({ 'CF-Connecting-IP': ip });
const tokenFrom = url => new URL(url).searchParams.get('token');
const unique = label => `${label}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.invalid`;

async function register(email, password = 'first-password-123', ip = freshIp()) {
  return expectStatus('/api/auth/register', 201, { method: 'POST', headers: as(ip), body: { email, name: 'Account Test', password } });
}

test('forgot password emails a single-use link that revokes old sessions', async () => {
  const ip = freshIp();
  const email = unique('reset');
  const created = await register(email, 'first-password-123', ip);
  const oldSession = created.token;
  await expectStatus('/api/auth/me', 200, { token: oldSession });

  const known = await expectStatus('/api/auth/forgot-password', 200, { method: 'POST', headers: as(ip), body: { email: email.toUpperCase() } });
  assert.match(known.debug_url, /\/reset-password\?token=/);
  const unknown = await expectStatus('/api/auth/forgot-password', 200, { method: 'POST', headers: as(ip), body: { email: unique('nobody') } });
  assert.equal(unknown.message, known.message, 'unknown emails get the same answer');
  assert.equal(unknown.debug_url, undefined);
  await expectStatus('/api/auth/forgot-password', 400, { method: 'POST', headers: as(ip), body: { email: 'not-an-email' } });

  const token = tokenFrom(known.debug_url);
  await expectStatus('/api/auth/reset-password', 400, { method: 'POST', headers: as(ip), body: { token, password: 'short' } });
  await expectStatus('/api/auth/reset-password', 400, { method: 'POST', headers: as(ip), body: { token: 'x'.repeat(43), password: 'second-password-123' } });
  const done = await expectStatus('/api/auth/reset-password', 200, { method: 'POST', headers: as(ip), body: { token, password: 'second-password-123' } });
  assert.equal(done.invite, false);
  await expectStatus('/api/auth/reset-password', 400, { method: 'POST', headers: as(ip), body: { token, password: 'third-password-1234' } });

  await expectStatus('/api/auth/me', 401, { token: oldSession });
  await expectStatus('/api/auth/login', 401, { method: 'POST', headers: as(ip), body: { email, password: 'first-password-123' } });
  const signedIn = await login(email, 'second-password-123');
  assert.equal(signedIn.user.email_verified, true, 'following an emailed link proves the address');
});

test('a newer reset link replaces the older one', async () => {
  const ip = freshIp();
  const email = unique('superseded');
  await register(email, 'first-password-123', ip);
  const first = await expectStatus('/api/auth/forgot-password', 200, { method: 'POST', headers: as(ip), body: { email } });
  const second = await expectStatus('/api/auth/forgot-password', 200, { method: 'POST', headers: as(ip), body: { email } });
  await expectStatus('/api/auth/reset-password', 400, { method: 'POST', headers: as(ip), body: { token: tokenFrom(first.debug_url), password: 'second-password-123' } });
  await expectStatus('/api/auth/reset-password', 200, { method: 'POST', headers: as(ip), body: { token: tokenFrom(second.debug_url), password: 'second-password-123' } });
});

test('suspended accounts cannot reset their password', async () => {
  const ip = freshIp();
  const admin = await login('admin@netprime.com', 'admin123');
  const email = unique('suspended');
  const created = await expectStatus('/api/admin/accounts', 201, { method: 'POST', token: admin.token,
    body: { email, name: 'Suspended Later', roles: ['student'], password: 'initial-password-123' } });
  const link = await expectStatus('/api/auth/forgot-password', 200, { method: 'POST', headers: as(ip), body: { email } });
  assert.ok(link.debug_url);
  await expectStatus(`/api/admin/accounts/${created.user.id}`, 200, { method: 'PATCH', token: admin.token, body: { status: 'suspended' } });
  await expectStatus('/api/auth/reset-password', 403, { method: 'POST', headers: as(ip), body: { token: tokenFrom(link.debug_url), password: 'second-password-123' } });
  const again = await expectStatus('/api/auth/forgot-password', 200, { method: 'POST', headers: as(ip), body: { email } });
  assert.equal(again.debug_url, undefined);
  await expectStatus(`/api/admin/accounts/${created.user.id}/invite`, 400, { method: 'POST', token: admin.token });
});

test('invited accounts set their own password from the emailed link', async () => {
  const ip = freshIp();
  const admin = await login('admin@netprime.com', 'admin123');
  const email = unique('invite');
  await expectStatus('/api/admin/accounts', 400, { method: 'POST', token: admin.token, body: { email, name: 'No Password', roles: ['student'] } });
  const created = await expectStatus('/api/admin/accounts', 201, { method: 'POST', token: admin.token, body: { email, name: 'Invited Person', roles: ['instructor'], invite: true } });
  assert.match(created.debug_url, /\/reset-password\?token=.+&invite=1$/);
  assert.equal(created.user.email_verified_at, null);
  assert.ok(created.user.invite_expires_at);

  const resent = await expectStatus(`/api/admin/accounts/${created.user.id}/invite`, 200, { method: 'POST', token: admin.token });
  await expectStatus('/api/auth/reset-password', 400, { method: 'POST', headers: as(ip), body: { token: tokenFrom(created.debug_url), password: 'invited-password-123' } });
  const accepted = await expectStatus('/api/auth/reset-password', 200, { method: 'POST', headers: as(ip), body: { token: tokenFrom(resent.debug_url), password: 'invited-password-123' } });
  assert.equal(accepted.invite, true);
  const signedIn = await login(email, 'invited-password-123');
  assert.deepEqual(signedIn.user.roles, ['instructor']);
  assert.equal(signedIn.user.email_verified, true);

  const student = await login('student3@netprime.com', 'stud123');
  await expectStatus(`/api/admin/accounts/${created.user.id}/invite`, 403, { method: 'POST', token: student.token });
  await expectStatus('/api/admin/accounts/usr_missing/invite', 404, { method: 'POST', token: admin.token });
});

test('email verification is soft and can be resent', async () => {
  const ip = freshIp();
  const email = unique('verify');
  const created = await register(email, 'first-password-123', ip);
  assert.equal(created.user.email_verified, false);
  assert.match(created.debug_url, /\/verify-email\?token=/);
  const me = await expectStatus('/api/auth/me', 200, { token: created.token });
  assert.equal(me.user.email_verified, false, 'unverified accounts still sign in');

  const resent = await expectStatus('/api/auth/resend-verification', 200, { method: 'POST', token: created.token });
  assert.match(resent.debug_url, /\/verify-email\?token=/);
  await expectStatus('/api/auth/verify-email', 400, { method: 'POST', headers: as(ip), body: { token: tokenFrom(created.debug_url) } });
  await expectStatus('/api/auth/verify-email', 400, { method: 'POST', headers: as(ip), body: { token: 'not-a-real-token-value-at-all' } });
  await expectStatus('/api/auth/verify-email', 200, { method: 'POST', headers: as(ip), body: { token: tokenFrom(resent.debug_url) } });
  await expectStatus('/api/auth/verify-email', 400, { method: 'POST', headers: as(ip), body: { token: tokenFrom(resent.debug_url) } });
  assert.equal((await expectStatus('/api/auth/me', 200, { token: created.token })).user.email_verified, true);
  const already = await expectStatus('/api/auth/resend-verification', 200, { method: 'POST', token: created.token });
  assert.equal(already.email_verified, true);
  assert.equal(already.debug_url, undefined);
  await expectStatus('/api/auth/resend-verification', 401, { method: 'POST' });

  const seeded = await login('student1@netprime.com', 'stud123');
  assert.equal(seeded.user.email_verified, true, 'existing accounts count as verified');
});

test('resending verification is limited per user', async () => {
  const created = await register(unique('resend-limit'));
  for (let i = 0; i < 3; i++) await expectStatus('/api/auth/resend-verification', 200, { method: 'POST', token: created.token });
  const limited = await expectStatus('/api/auth/resend-verification', 429, { method: 'POST', token: created.token });
  assert.ok(limited.error);
});

test('change password keeps this session and signs out the others', async () => {
  const ip = freshIp();
  const email = unique('change');
  const created = await register(email, 'first-password-123', ip);
  const other = await login(email, 'first-password-123');
  await expectStatus('/api/auth/change-password', 400, { method: 'POST', token: created.token, body: { current_password: 'wrong-password-123', new_password: 'second-password-123' } });
  await expectStatus('/api/auth/change-password', 400, { method: 'POST', token: created.token, body: { current_password: 'first-password-123', new_password: 'short' } });
  await expectStatus('/api/auth/change-password', 401, { method: 'POST', body: { current_password: 'first-password-123', new_password: 'second-password-123' } });
  const changed = await expectStatus('/api/auth/change-password', 200, { method: 'POST', token: created.token,
    body: { current_password: 'first-password-123', new_password: 'second-password-123' } });
  assert.ok(changed.token);
  assert.equal(changed.user.email, email);
  await expectStatus('/api/auth/me', 401, { token: created.token });
  await expectStatus('/api/auth/me', 401, { token: other.token });
  await expectStatus('/api/auth/me', 200, { token: changed.token });
  await expectStatus('/api/auth/login', 401, { method: 'POST', headers: as(ip), body: { email, password: 'first-password-123' } });
  await login(email, 'second-password-123');
});

test('users can edit their own display name', async () => {
  const created = await register(unique('profile'));
  await expectStatus('/api/auth/me', 400, { method: 'PATCH', token: created.token, body: { name: '   ' } });
  await expectStatus('/api/auth/me', 400, { method: 'PATCH', token: created.token, body: { name: 'x'.repeat(121) } });
  await expectStatus('/api/auth/me', 401, { method: 'PATCH', body: { name: 'Anonymous' } });
  const updated = await expectStatus('/api/auth/me', 200, { method: 'PATCH', token: created.token, body: { name: '  ชื่อใหม่  ', email: 'evil@example.invalid', role: 'admin' } });
  assert.equal(updated.user.name, 'ชื่อใหม่');
  const me = await expectStatus('/api/auth/me', 200, { token: created.token });
  assert.equal(me.user.name, 'ชื่อใหม่');
  assert.equal(me.user.email, created.user.email);
  assert.equal(me.user.role, 'student');
});

test('repeated failed logins are rate limited per email and per IP', async () => {
  const email = unique('brute');
  await register(email, 'correct-password-123');
  for (let i = 0; i < 10; i++) {
    await expectStatus('/api/auth/login', 401, { method: 'POST', headers: as(freshIp()), body: { email, password: `wrong-password-${i}` } });
  }
  const blocked = await request('/api/auth/login', { method: 'POST', headers: as(freshIp()), body: { email, password: 'correct-password-123' } });
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /บ่อยเกินไป/);

  const ip = freshIp();
  for (let i = 0; i < 20; i++) {
    await expectStatus('/api/auth/login', 401, { method: 'POST', headers: as(ip), body: { email: unique(`spray${i}`), password: 'guess-password-1' } });
  }
  await expectStatus('/api/auth/login', 429, { method: 'POST', headers: as(ip), body: { email: 'student3@netprime.com', password: 'stud123' } });
  // Other clients and successful sign-ins are unaffected.
  await expectStatus('/api/auth/login', 200, { method: 'POST', headers: as(freshIp()), body: { email: 'student3@netprime.com', password: 'stud123' } });
});

test('forgot password is rate limited per email', async () => {
  const email = unique('forgot-limit');
  for (let i = 0; i < 5; i++) await expectStatus('/api/auth/forgot-password', 200, { method: 'POST', headers: as(freshIp()), body: { email } });
  await expectStatus('/api/auth/forgot-password', 429, { method: 'POST', headers: as(freshIp()), body: { email } });
});
