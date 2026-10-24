import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

const sign = payload => {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${head}.${body}.${createHmac('sha256', 'local-test-only-not-a-production-secret').update(`${head}.${body}`).digest('base64url')}`;
};
const studentClaims = { id: 'usr_student3', email: 'student3@netprime.com', name: 'Fixture', role: 'student', partner_id: null };

test('registration persists an individual student and supports password login', async () => {
  const created = await expectStatus('/api/auth/register', 201, { method: 'POST', body: {
    email: '  New.Student@Example.invalid  ', name: ' New Student ', password: 'long-test-password-123'
  } });
  assert.equal(created.user.role, 'student');
  assert.equal(created.user.email, 'new.student@example.invalid');
  assert.equal(created.user.name, 'New Student');
  assert.equal(created.user.partner_id, null);
  assert.equal(created.user.password_hash, undefined);
  const signedIn = await login('NEW.STUDENT@example.invalid', 'long-test-password-123');
  assert.equal(signedIn.user.id, created.user.id);
  await expectStatus('/api/auth/login', 401, { method: 'POST', body: { email: created.user.email, password: 'incorrect-password' } });
  await expectStatus('/api/auth/register', 409, { method: 'POST', body: { email: created.user.email, name: 'Duplicate', password: 'long-test-password-123' } });
});

test('registration rejects all privileged roles and organization self-assignment', async () => {
  for (const fields of [{ role: 'admin' }, { role: 'instructor' }, { role: 'partner' }, { partner_id: 'partner_acme' }]) {
    await expectStatus('/api/auth/register', 403, { method: 'POST', body: { email: 'blocked@example.invalid', name: 'Blocked', password: 'long-test-password-123', ...fields } });
  }
});

test('malformed login and registration input returns validation errors', async () => {
  for (const body of [null, {}, { email: 12, password: [] }, { email: 'not-email', password: 'password' }]) {
    await expectStatus('/api/auth/login', 400, { method: 'POST', body });
    await expectStatus('/api/auth/register', 400, { method: 'POST', body });
  }
  await expectStatus('/api/auth/register', 400, { method: 'POST', body: { email: 'short@example.invalid', name: 'Short', password: 'short' } });
});

test('login does not provision unknown users or accept omitted passwords', async () => {
  await expectStatus('/api/auth/login', 400, { method: 'POST', body: { email: 'admin@netprime.com' } });
  await expectStatus('/api/auth/login', 401, { method: 'POST', body: { email: 'unknown-admin@example.invalid', password: 'arbitrary-password' } });
});

test('seed password migration preserves login and each session is unique', async () => {
  const first = await login('student3@netprime.com', 'stud123');
  const second = await login('student3@netprime.com', 'stud123');
  assert.notEqual(first.token, second.token);
  await expectStatus('/api/auth/logout', 200, { method: 'POST', token: first.token });
  await expectStatus('/api/auth/me', 401, { token: first.token });
  await expectStatus('/api/auth/me', 200, { token: second.token });
  const catalog = await expectStatus('/api/courses', 200, { token: first.token });
  assert.ok(catalog.every(course => course.progress_percent === null));
});

test('authorization uses current database role instead of signed role claims', async () => {
  const token = sign({ ...studentClaims, role: 'admin', partner_id: 'partner_acme', exp: Math.floor(Date.now() / 1000) + 600 });
  await expectStatus('/api/admin/users', 403, { token });
  const profile = await expectStatus('/api/auth/me', 200, { token });
  assert.equal(profile.user.role, 'student');
  assert.equal(profile.user.partner_id, null);
});

test('tokens without expiry, expired tokens and missing users are rejected', async () => {
  for (const payload of [studentClaims, { ...studentClaims, exp: 1 }, { ...studentClaims, id: 'deleted-user', exp: Math.floor(Date.now() / 1000) + 600 }]) {
    await expectStatus('/api/auth/me', 401, { token: sign(payload) });
  }
});

test('logout accepts sessions with less than 60 seconds remaining', async () => {
  const token = sign({ ...studentClaims, exp: Math.floor(Date.now() / 1000) + 30 });
  await expectStatus('/api/auth/logout', 200, { method: 'POST', token });
  await expectStatus('/api/auth/me', 401, { token });
});

test('client-provided OAuth identities are never accepted', async () => {
  for (const provider of ['google', 'github', 'microsoft']) {
    await expectStatus(`/api/auth/oauth/${provider}/callback`, 403, { method: 'POST', body: { simulatedProfile: { email: 'admin@netprime.com', name: 'Impersonated' } } });
  }
  await expectStatus('/api/auth/oauth/google-token', 403, { method: 'POST', body: { credential: 'untrusted-token' } });
});

test('unconfigured OAuth providers advertise unavailable and do not simulate success', async () => {
  const status = await expectStatus('/api/auth/oauth/providers', 200);
  assert.ok(Object.values(status.providers).every(provider => !provider.enabled));
  await expectStatus('/api/auth/oauth/google/url', 503);
});

test('CORS permits local PUT uploads and omits untrusted origins', async () => {
  const allowed = await request('/api/instructor/upload/direct', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.match(allowed.headers.get('access-control-allow-methods'), /\bPUT\b/);
  const denied = await request('/api/auth/login', { method: 'OPTIONS', headers: { Origin: 'https://untrusted.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('auth responses must not be cached', async () => {
  const response = await request('/api/auth/oauth/providers');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
