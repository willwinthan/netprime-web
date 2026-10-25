// Platform suite: school settings, outgoing webhooks, public API keys + /api/v1, enterprise SSO (OIDC)
// and live meetings. Uses the local mock receiver (https://hooks.mock.test) and mock IdP
// (https://idp.mock.test), both available only when ALLOW_LOCAL_SEED_PASSWORDS=true.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { dangerCode, request, login, expectStatus } from './helpers.mjs';

const base = process.env.NETPRIME_TEST_BASE;
const FRONT = 'http://localhost:5173';
let admin, coord, instructor, student;
const tokens = {};

const b64url = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const api = (path, key, options = {}) => request(path, { ...options, headers: { Authorization: `Bearer ${key}`, ...(options.headers || {}) } });

async function poll(fn, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await delay(150);
  }
  return last;
}

test('setup: sign in fixtures', async () => {
  admin = (await login('admin@netprime.com', 'admin123')).token;
  coord = (await login('coord@netprime.com', 'coord123')).token;
  instructor = (await login('instructor@netprime.com', 'inst123')).token;
  student = (await login('student3@netprime.com', 'stud123')).token;
});

// ==========================================
// School settings
// ==========================================

test('settings: integrations.manage only, validated, public view and sign-up terms enforced', async () => {
  await expectStatus('/api/admin/platform/settings', 401);
  await expectStatus('/api/admin/platform/settings', 403, { token: coord });
  const current = await expectStatus('/api/admin/platform/settings', 200, { token: admin });
  assert.equal(current.settings.timezone, 'Asia/Bangkok');
  assert.equal(current.settings.default_language, 'th');

  for (const bad of [
    { timezone: 'Mars/Olympus' }, { default_language: 'fr' }, { support_email: 'nope' }, { school_name: '' },
    { signup: { allowed_domains: ['not a domain'] } }, { signup: { open: 'yes' } }, { maintenance: { active: true, message: '' } }
  ]) {
    const res = await request('/api/admin/platform/settings', { token: admin, method: 'PUT', body: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(typeof res.data.error, 'string');
  }

  const saved = await expectStatus('/api/admin/platform/settings', 200, { token: admin, method: 'PUT', body: {
    school_name: 'NetPrime Test Academy', support_email: 'Help@NetPrime.com', timezone: 'Asia/Bangkok',
    maintenance: { active: true, message: 'ปิดปรับปรุงคืนนี้ 22:00', level: 'warning' }
  } });
  assert.equal(saved.settings.support_email, 'help@netprime.com');
  const pub = await expectStatus('/api/public/platform', 200);
  assert.equal(pub.school_name, 'NetPrime Test Academy');
  assert.deepEqual(pub.maintenance, { active: true, message: 'ปิดปรับปรุงคืนนี้ 22:00', level: 'warning' });

  // Closed sign-up.
  await expectStatus('/api/admin/platform/settings', 200, { token: admin, method: 'PUT', body: { signup: { open: false }, maintenance: { active: false } } });
  const closed = await request('/api/auth/register', { method: 'POST', body: { email: 'closed@example.com', password: 'a-long-password-123', name: 'Closed' } });
  assert.equal(closed.status, 403);
  assert.equal(closed.data.code, 'signup_closed');

  // Domain-restricted sign-up.
  await expectStatus('/api/admin/platform/settings', 200, { token: admin, method: 'PUT', body: { signup: { open: true, allowed_domains: 'school.example, @Partner.example' } } });
  const wrongDomain = await request('/api/auth/register', { method: 'POST', body: { email: 'x@gmail.com', password: 'a-long-password-123', name: 'X' } });
  assert.equal(wrongDomain.status, 403);
  const okDomain = await request('/api/auth/register', { method: 'POST', body: { email: 'pupil@partner.example', password: 'a-long-password-123', name: 'Pupil' } });
  assert.equal(okDomain.status, 201, JSON.stringify(okDomain.data));
  tokens.unverified = okDomain.data.token;
  tokens.unverifiedId = okDomain.data.user.id;

  const reset = await expectStatus('/api/admin/platform/settings', 200, { token: admin, method: 'PUT', body: { signup: { open: true, allowed_domains: [] } } });
  assert.deepEqual(reset.settings.signup.allowed_domains, []);
  assert.equal((await expectStatus('/api/public/platform', 200)).maintenance.active, false);
});

// ==========================================
// Webhooks
// ==========================================

const hooks = {};

test('webhooks: SSRF guard on create, secret shown once, list never exposes it', async () => {
  for (const url of ['http://hooks.example.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://localhost/x',
    'https://metadata.google.internal/x', 'https://[::1]/x', 'https://10.0.0.5/hook', 'https://user:pw@hooks.example.com/x']) {
    const res = await request('/api/admin/platform/webhooks', { token: admin, method: 'POST', body: { name: 'bad', url, events: ['*'] } });
    assert.equal(res.status, 400, url);
  }
  await expectStatus('/api/admin/platform/webhooks', 400, { token: admin, method: 'POST', body: { name: 'no events', url: 'https://hooks.mock.test/ok', events: [] } });
  await expectStatus('/api/admin/platform/webhooks', 400, { token: admin, method: 'POST', body: { name: 'bad event', url: 'https://hooks.mock.test/ok', events: ['user.deleted'] } });
  await expectStatus('/api/admin/platform/webhooks', 403, { token: coord, method: 'POST', body: { name: 'x', url: 'https://hooks.mock.test/ok', events: ['*'] } });

  const ok = await expectStatus('/api/admin/platform/webhooks', 201, { token: admin, method: 'POST', body: { name: 'Zapier users', url: 'https://hooks.mock.test/ok', events: ['user.created'] } });
  assert.match(ok.secret, /^whsec_/);
  hooks.ok = ok.endpoint.id;
  hooks.okSecret = ok.secret;
  const down = await expectStatus('/api/admin/platform/webhooks', 201, { token: admin, method: 'POST', body: { name: 'Unreachable orders', url: 'https://netprime-hook-test.invalid/hook', events: ['order.paid'] } });
  hooks.down = down.endpoint.id;
  const failing = await expectStatus('/api/admin/platform/webhooks', 201, { token: admin, method: 'POST', body: { name: 'Failing', url: 'https://hooks.mock.test/fail', events: ['*'], active: false } });
  hooks.failing = failing.endpoint.id;

  const list = await expectStatus('/api/admin/platform/webhooks', 200, { token: admin });
  const text = JSON.stringify(list);
  assert.ok(!text.includes(hooks.okSecret), 'secret must not be listed');
  assert.ok(!text.includes('secret_enc'));
  assert.ok(list.events.some(e => e.name === 'order.paid'));
  assert.deepEqual(list.endpoints.find(e => e.id === hooks.ok).events, ['user.created']);
});

test('webhooks: signed test ping succeeds; unreachable and failing hosts are logged with retry info', async () => {
  const ping = await expectStatus(`/api/admin/platform/webhooks/${hooks.ok}/test`, 200, { token: admin, method: 'POST' });
  assert.equal(ping.delivery.status, 'success');
  assert.equal(ping.delivery.response_code, 200);
  assert.equal(ping.delivery.attempts, 1);
  assert.ok(Number.isInteger(ping.delivery.duration_ms));
  assert.equal(JSON.parse(ping.delivery.response_excerpt).signature_valid, true, 'mock receiver verified X-NetPrime-Signature');
  const payload = JSON.parse(ping.delivery.payload);
  assert.equal(payload.event, 'ping');
  assert.ok(payload.id && payload.created_at && 'user_email' in payload && 'data' in payload);

  const unreachable = await expectStatus(`/api/admin/platform/webhooks/${hooks.down}/test`, 200, { token: admin, method: 'POST' });
  assert.equal(unreachable.delivery.status, 'pending', 'first failure is queued for retry');
  assert.equal(unreachable.delivery.attempts, 1);
  assert.equal(unreachable.delivery.response_code, null);
  assert.ok(unreachable.delivery.error);
  assert.ok(Date.parse(unreachable.delivery.next_attempt_at) > Date.now());

  const failed = await expectStatus(`/api/admin/platform/webhooks/${hooks.failing}/test`, 200, { token: admin, method: 'POST' });
  assert.equal(failed.delivery.response_code, 500);
  assert.equal(failed.delivery.status, 'pending');
  assert.match(failed.delivery.error, /500/);

  const log = await expectStatus(`/api/admin/platform/webhooks/${hooks.down}/deliveries`, 200, { token: admin });
  assert.equal(log.deliveries.length, 1);
});

test('webhooks: tracked events reach only subscribed endpoints; manual redeliver', async () => {
  const email = `hook-${Date.now()}@example.com`;
  await expectStatus('/api/auth/register', 201, { method: 'POST', body: { email, password: 'a-long-password-123', name: 'Hook User' } });
  const delivered = await poll(async () => {
    const log = await expectStatus(`/api/admin/platform/webhooks/${hooks.ok}/deliveries`, 200, { token: admin });
    return log.deliveries.find(d => d.event === 'user.created' && JSON.parse(d.payload).user_email === email && d.status === 'success');
  });
  assert.ok(delivered, 'user.created delivered to the subscribed endpoint');
  const body = JSON.parse(delivered.payload);
  assert.equal(body.user_name, 'Hook User');
  assert.equal(body.data.method, 'password');

  const other = await expectStatus(`/api/admin/platform/webhooks/${hooks.down}/deliveries`, 200, { token: admin });
  assert.ok(!other.deliveries.some(d => d.event === 'user.created'), 'order.paid endpoint did not receive user.created');
  const paused = await expectStatus(`/api/admin/platform/webhooks/${hooks.failing}/deliveries`, 200, { token: admin });
  assert.ok(!paused.deliveries.some(d => d.event === 'user.created'), 'inactive endpoint receives nothing');

  const again = await expectStatus(`/api/admin/platform/webhook-deliveries/${delivered.id}/redeliver`, 200, { token: admin, method: 'POST' });
  assert.notEqual(again.delivery.id, delivered.id);
  assert.equal(again.delivery.status, 'success');
  assert.equal(again.delivery.payload, delivered.payload);

  const rotated = await expectStatus(`/api/admin/platform/webhooks/${hooks.ok}/rotate-secret`, 200, { token: admin, method: 'POST' });
  assert.notEqual(rotated.secret, hooks.okSecret);
  const patched = await expectStatus(`/api/admin/platform/webhooks/${hooks.ok}`, 200, { token: admin, method: 'PATCH', body: { events: ['*'], active: true } });
  assert.deepEqual(patched.endpoint.events, ['*']);
  await expectStatus(`/api/admin/platform/webhooks/${hooks.ok}`, 400, { token: admin, method: 'PATCH', body: { url: 'https://192.168.0.1/x' } });
  // Security-critical: always an emailed code, admins only, to the requesting admin's own address.
  const noCode = await request(`/api/admin/platform/webhooks/${hooks.failing}`, { token: admin, method: 'DELETE' });
  assert.equal(noCode.status, 428);
  assert.equal(noCode.data.code, 'confirmation_required');
  await expectStatus(`/api/security/delete-preview?action=webhook.delete&target_id=${hooks.failing}`, 403, { token: coord });
  await expectStatus('/api/security/delete-codes', 403, { token: coord, method: 'POST', body: { action: 'webhook.delete', target_id: hooks.failing } });
  const issued = await dangerCode(admin, 'webhook.delete', hooks.failing);
  assert.equal(issued.approver, 'admin');
  assert.equal(issued.sent_to, 'ad***@netprime.com');
  await expectStatus(`/api/admin/platform/webhooks/${hooks.failing}`, 200, { token: admin, method: 'DELETE', body: { confirmation_code: issued.debug_code } });
  await expectStatus(`/api/admin/platform/webhooks/${hooks.failing}`, 404, { token: admin, method: 'DELETE' });
});

// ==========================================
// API keys + /api/v1
// ==========================================

const keys = {};

test('api keys: validated, shown once, hash-only listing', async () => {
  await expectStatus('/api/admin/platform/api-keys', 403, { token: coord });
  await expectStatus('/api/admin/platform/api-keys', 400, { token: admin, method: 'POST', body: { name: 'none', scopes: [] } });
  await expectStatus('/api/admin/platform/api-keys', 400, { token: admin, method: 'POST', body: { name: 'bad', scopes: ['admin:all'] } });
  await expectStatus('/api/admin/platform/api-keys', 400, { token: admin, method: 'POST', body: { name: 'limit', scopes: ['users:read'], rate_limit_per_minute: 0 } });

  const full = await expectStatus('/api/admin/platform/api-keys', 201, { token: admin, method: 'POST', body: {
    name: 'HR sync', scopes: ['users:read', 'users:write', 'courses:read', 'enrollments:read', 'enrollments:write', 'orders:read'], rate_limit_per_minute: 1000
  } });
  assert.match(full.secret, /^npk_[A-Za-z0-9_-]{43}$/);
  keys.full = full.secret;
  keys.fullId = full.key.id;
  const readOnly = await expectStatus('/api/admin/platform/api-keys', 201, { token: admin, method: 'POST', body: { name: 'Read users', scopes: ['users:read'], rate_limit_per_minute: 2 } });
  keys.limited = readOnly.secret;
  keys.limitedId = readOnly.key.id;

  const list = await expectStatus('/api/admin/platform/api-keys', 200, { token: admin });
  const text = JSON.stringify(list);
  assert.ok(!text.includes(keys.full) && !text.includes(keys.limited), 'raw keys are never listed');
  assert.ok(!text.includes('key_hash'));
  const row = list.keys.find(k => k.id === keys.fullId);
  assert.equal(row.prefix, keys.full.slice(0, 12));
  assert.equal(row.last_used_at, null);
});

test('v1: authentication, scopes and per-key rate limit', async () => {
  const doc = await expectStatus('/api/v1/openapi.json', 200);
  assert.equal(doc.openapi, '3.0.3');
  assert.ok(doc.paths['/enrollments'].post);

  assert.equal((await request('/api/v1/users')).status, 401);
  assert.equal((await api('/api/v1/users', 'npk_' + 'x'.repeat(43))).status, 401);
  const scoped = await api('/api/v1/courses', keys.limited);
  assert.equal(scoped.status, 403);
  assert.equal(scoped.data.required_scope, 'courses:read');

  // limit 2/min: the 403 above did not count (the scope check runs before the limiter).
  const first = await api('/api/v1/users?limit=1', keys.limited);
  assert.equal(first.status, 200);
  const second = await api('/api/v1/users?limit=1', keys.limited);
  assert.equal(second.status, 200);
  const third = await api('/api/v1/users?limit=1', keys.limited);
  assert.equal(third.status, 429);
  assert.equal(third.headers.get('retry-after'), '60');

  const listed = await expectStatus('/api/admin/platform/api-keys', 200, { token: admin });
  assert.ok(listed.keys.find(k => k.id === keys.limitedId).last_used_at, 'last used is recorded');

  await expectStatus(`/api/admin/platform/api-keys/${keys.limitedId}`, 428, { token: admin, method: 'DELETE' });
  const revokeCode = (await dangerCode(admin, 'api_key.revoke', keys.limitedId)).debug_code;
  await expectStatus(`/api/admin/platform/api-keys/${keys.limitedId}`, 200, { token: admin, method: 'DELETE', headers: { 'X-Confirmation-Code': revokeCode } });
  assert.equal((await api('/api/v1/users', keys.limited)).status, 401, 'revoked key stops working');
  await expectStatus(`/api/admin/platform/api-keys/${keys.limitedId}`, 404, { token: admin, method: 'DELETE' });
});

test('v1: cursor pagination over users, courses, enrollments and orders', async () => {
  const page1 = await api('/api/v1/users?limit=2', keys.full);
  assert.equal(page1.status, 200);
  assert.equal(page1.data.data.length, 2);
  assert.ok(page1.data.next_cursor);
  assert.ok(!('password_hash' in page1.data.data[0]));
  const page2 = await api(`/api/v1/users?limit=2&cursor=${page1.data.next_cursor}`, keys.full);
  assert.equal(page2.status, 200);
  assert.ok(page2.data.data.every(u => u.id > page1.data.data[1].id));
  assert.equal((await api('/api/v1/users?cursor=***', keys.full)).status, 400);

  const one = await api('/api/v1/users/usr_student3', keys.full);
  assert.equal(one.data.data.email, 'student3@netprime.com');
  assert.deepEqual(one.data.data.roles, ['student']);
  assert.equal((await api('/api/v1/users/usr_nope', keys.full)).status, 404);

  const courses = await api('/api/v1/courses?limit=200', keys.full);
  assert.equal(courses.status, 200);
  assert.ok(courses.data.data.some(c => c.id === 'course_cf_workers'));
  const orders = await api('/api/v1/orders', keys.full);
  assert.equal(orders.status, 200);
  assert.ok(Array.isArray(orders.data.data));
  const enr = await api('/api/v1/enrollments?user_id=usr_student3', keys.full);
  assert.ok(enr.data.data.length >= 2 && enr.data.data.every(e => e.user_id === 'usr_student3'));
});

test('v1: create user (invite) and idempotent enrollment for published courses only', async () => {
  const email = `api-${Date.now()}@example.com`;
  const created = await api('/api/v1/users', keys.full, { method: 'POST', body: { email, name: 'API Learner', tags: ['hr-sync'] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.invited, true);
  assert.match(created.data.debug_url, /\/reset-password\?token=.+&invite=1/);
  const userId = created.data.data.id;
  assert.equal((await api('/api/v1/users', keys.full, { method: 'POST', body: { email, name: 'Again' } })).status, 409);
  assert.equal((await api('/api/v1/users', keys.full, { method: 'POST', body: { email: 'bad', name: 'x' } })).status, 400);

  const enrolled = await api('/api/v1/enrollments', keys.full, { method: 'POST', body: { email, course_id: 'course_cisco_ccna' } });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.data));
  assert.equal(enrolled.data.created, true);
  const repeat = await api('/api/v1/enrollments', keys.full, { method: 'POST', body: { user_id: userId, course_id: 'course_cisco_ccna' } });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.created, false);
  assert.equal(repeat.data.data.id, enrolled.data.data.id);
  assert.equal((await api('/api/v1/enrollments', keys.full, { method: 'POST', body: { user_id: userId, course_id: 'course_missing' } })).status, 404);

  const draft = await request('/api/instructor/courses', { token: instructor, method: 'POST', body: { title: 'Draft for API test', description: 'ร่าง' } });
  assert.ok([200, 201].includes(draft.status), JSON.stringify(draft.data));
  const draftId = draft.data.course?.id ?? draft.data.id ?? draft.data.course_id;
  const unpublished = await api('/api/v1/enrollments', keys.full, { method: 'POST', body: { user_id: userId, course_id: draftId } });
  assert.equal(unpublished.status, 422);
  tokens.apiLearnerEmail = email;
});

// ==========================================
// Enterprise SSO (OIDC) with the local mock IdP
// ==========================================

const sso = {};

test('sso admin: config validation, secret never returned, discovery test', async () => {
  const valid = { name: 'Corp Entra', issuer: 'https://idp.mock.test', client_id: 'np-client', client_secret: 'mock-secret', allowed_domains: ['corp-sso.example'], jit_tags: ['sso-jit'] };
  await expectStatus('/api/admin/platform/sso', 403, { token: coord, method: 'POST', body: valid });
  for (const bad of [{ issuer: 'http://idp.example.com' }, { issuer: 'https://10.0.0.1' }, { issuer: 'https://login.microsoftonline.com/common/v2.0' },
    { allowed_domains: [] }, { client_secret: '' }, { default_role: 'admin' }, { partner_id: 'partner_missing' }]) {
    const res = await request('/api/admin/platform/sso', { token: admin, method: 'POST', body: { ...valid, ...bad } });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  const created = await expectStatus('/api/admin/platform/sso', 201, { token: admin, method: 'POST', body: valid });
  sso.id = created.provider.id;
  assert.match(created.redirect_uri, /\/api\/sso\/callback$/);
  const list = await expectStatus('/api/admin/platform/sso', 200, { token: admin });
  assert.ok(!JSON.stringify(list).includes('mock-secret'));
  assert.ok(!JSON.stringify(list).includes('client_secret_enc'));
  const check = await expectStatus(`/api/admin/platform/sso/${sso.id}/test`, 200, { token: admin, method: 'POST' });
  assert.equal(check.ok, true);
  assert.equal((await expectStatus('/api/sso/status', 200)).enabled, true);
});

// Browser binding: the SPA keeps SSO_SECRET in sessionStorage and sends only its SHA-256 to /sso/start.
const SSO_SECRET = 'browser-binding-secret-0123456789abcdef';
const bindingFor = secret => createHash('sha256').update(secret).digest('hex');
const exchange = (ticket, secret = SSO_SECRET) => request('/api/sso/exchange', { method: 'POST', body: { ticket, secret } });

async function startSso(email, secret = SSO_SECRET) {
  const res = await request('/api/sso/start', { method: 'POST', body: { email, return_to: FRONT, binding: bindingFor(secret) } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const url = new URL(res.data.url);
  assert.equal(url.origin, 'https://idp.mock.test');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  for (const p of ['state', 'nonce', 'code_challenge', 'redirect_uri']) assert.ok(url.searchParams.get(p), p);
  return Object.fromEntries(url.searchParams);
}

async function callback(params) {
  const res = await fetch(`${base}/api/sso/callback?${new URLSearchParams(params)}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin + location.pathname, `${FRONT}/auth/sso/complete`);
  return Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
}

const codeFor = (auth, claims) => b64url({ sub: claims.sub, email: claims.email, email_verified: true, name: claims.name, nonce: auth.nonce, code_challenge: auth.code_challenge, ...claims });

test('sso login: PKCE + state + nonce, JIT user, one-time ticket and state', async () => {
  assert.equal((await request('/api/sso/start', { method: 'POST', body: { email: 'alice@corp-sso.example', return_to: FRONT } })).status, 400, 'browser binding required');
  assert.equal((await request('/api/sso/start', { method: 'POST', body: { email: 'someone@unknown-domain.example', binding: bindingFor(SSO_SECRET) } })).status, 404);
  const auth = await startSso('alice@corp-sso.example');
  const result = await callback({ state: auth.state, code: codeFor(auth, { sub: 'alice-1', email: 'alice@corp-sso.example', name: 'Alice Corp' }) });
  assert.ok(result.ticket, JSON.stringify(result));
  const session = await expectStatus('/api/sso/exchange', 200, { method: 'POST', body: { ticket: result.ticket, secret: SSO_SECRET } });
  assert.equal(session.user.email, 'alice@corp-sso.example');
  assert.deepEqual(session.user.roles, ['student']);
  assert.equal(session.user.email_verified, true);
  const me = await expectStatus('/api/auth/me', 200, { token: session.token });
  assert.equal(me.user.id, session.user.id);
  sso.aliceId = session.user.id;

  assert.equal((await exchange(result.ticket)).status, 400, 'ticket is single-use');
  assert.equal((await callback({ state: auth.state, code: 'x' })).error, 'state_invalid', 'state is single-use');
  assert.equal((await callback({ state: 'forged-state-value', code: 'x' })).error, 'state_invalid');

  // Login CSRF: a ticket minted for a login started in another browser cannot be exchanged here.
  const foreign = await startSso('alice@corp-sso.example', 'attacker-browser-secret-0123456789abcdef');
  const planted = await callback({ state: foreign.state, code: codeFor(foreign, { sub: 'alice-1', email: 'alice@corp-sso.example' }) });
  assert.ok(planted.ticket);
  assert.equal((await exchange(planted.ticket)).status, 400, 'wrong browser secret');
  assert.equal((await exchange(planted.ticket, 'attacker-browser-secret-0123456789abcdef')).status, 400, 'ticket burned after a failed exchange');
  const missing = await startSso('alice@corp-sso.example');
  const noSecret = await callback({ state: missing.state, code: codeFor(missing, { sub: 'alice-1', email: 'alice@corp-sso.example' }) });
  assert.equal((await request('/api/sso/exchange', { method: 'POST', body: { ticket: noSecret.ticket } })).status, 400, 'secret required');

  // Same IdP subject again → same account.
  const again = await startSso('alice@corp-sso.example');
  const second = await callback({ state: again.state, code: codeFor(again, { sub: 'alice-1', email: 'alice@corp-sso.example', name: 'Alice' }) });
  const session2 = await expectStatus('/api/sso/exchange', 200, { method: 'POST', body: { ticket: second.ticket, secret: SSO_SECRET } });
  assert.equal(session2.user.id, sso.aliceId);
});

test('sso login: nonce, PKCE, domain and provisioning failures', async () => {
  let auth = await startSso('bob@corp-sso.example');
  assert.equal((await callback({ state: auth.state, code: codeFor(auth, { sub: 'bob-1', email: 'bob@corp-sso.example', nonce: 'replayed-nonce' }) })).error, 'id_token_invalid');
  auth = await startSso('bob@corp-sso.example');
  assert.equal((await callback({ state: auth.state, code: codeFor(auth, { sub: 'bob-1', email: 'bob@corp-sso.example', code_challenge: 'wrong' }) })).error, 'token_exchange_failed');
  auth = await startSso('bob@corp-sso.example');
  assert.equal((await callback({ state: auth.state, code: codeFor(auth, { sub: 'bob-1', email: 'bob@gmail.com' }) })).error, 'domain_not_allowed');
  auth = await startSso('bob@corp-sso.example');
  assert.equal((await callback({ state: auth.state, code: codeFor(auth, { sub: 'bob-1', email: 'bob@corp-sso.example', email_verified: false }) })).error, 'email_missing');
  auth = await startSso('bob@corp-sso.example');
  assert.equal((await callback({ state: auth.state, error: 'access_denied' })).error, 'idp_error');

  // Existing account with an allowed domain is linked by verified email; with auto-create off, unknown users are refused.
  const existing = await api('/api/v1/users', keys.full, { method: 'POST', body: { email: 'carol@corp-sso.example', name: 'Carol', send_invite: false } });
  assert.equal(existing.status, 201);
  await expectStatus(`/api/admin/platform/sso/${sso.id}`, 200, { token: admin, method: 'PATCH', body: { auto_create: false } });
  auth = await startSso('carol@corp-sso.example');
  const linked = await callback({ state: auth.state, code: codeFor(auth, { sub: 'carol-1', email: 'carol@corp-sso.example' }) });
  const carol = await expectStatus('/api/sso/exchange', 200, { method: 'POST', body: { ticket: linked.ticket, secret: SSO_SECRET } });
  assert.equal(carol.user.id, existing.data.data.id);
  auth = await startSso('dave@corp-sso.example');
  assert.equal((await callback({ state: auth.state, code: codeFor(auth, { sub: 'dave-1', email: 'dave@corp-sso.example' }) })).error, 'not_provisioned');

  // Existing account: a missing email_verified claim is not verified, and preferred_username never links.
  const erin = await api('/api/v1/users', keys.full, { method: 'POST', body: { email: 'erin@corp-sso.example', name: 'Erin', send_invite: false } });
  assert.equal(erin.status, 201);
  auth = await startSso('erin@corp-sso.example');
  assert.equal((await callback({ state: auth.state, code: codeFor(auth, { sub: 'erin-1', email: 'erin@corp-sso.example', email_verified: undefined }) })).error, 'email_unverified');
  auth = await startSso('erin@corp-sso.example');
  assert.equal((await callback({ state: auth.state, code: codeFor(auth, { sub: 'erin-1', email: undefined, preferred_username: 'erin@corp-sso.example' }) })).error, 'email_missing');
  auth = await startSso('erin@corp-sso.example');
  const erinLinked = await callback({ state: auth.state, code: codeFor(auth, { sub: 'erin-1', email: 'erin@corp-sso.example', email_verified: undefined, xms_edov: true }) });
  assert.ok(erinLinked.ticket, 'Entra xms_edov=true counts as verified');

  // Staff accounts (instructor/coordinator/admin) are never auto-linked, even with a verified email.
  await expectStatus('/api/admin/accounts', 201, { method: 'POST', token: admin, body: { email: 'frank@corp-sso.example', name: 'Frank', roles: ['student', 'instructor'], password: 'frank-password-123' } });
  auth = await startSso('frank@corp-sso.example');
  assert.equal((await callback({ state: auth.state, code: codeFor(auth, { sub: 'frank-1', email: 'frank@corp-sso.example' }) })).error, 'staff_link_required');

  await expectStatus(`/api/admin/platform/sso/${sso.id}`, 200, { token: admin, method: 'PATCH', body: { enabled: false } });
  assert.equal((await request('/api/sso/start', { method: 'POST', body: { email: 'alice@corp-sso.example', binding: bindingFor(SSO_SECRET) } })).status, 404);
});

// ==========================================
// Live meetings
// ==========================================

const inMinutes = m => new Date(Date.now() + m * 60_000).toISOString();

test('live: training session meeting permissions, validation and unconfigured providers', async () => {
  const providers = await expectStatus('/api/live/providers', 200, { token: admin });
  assert.equal(providers.providers.zoom.configured, false);
  assert.equal(providers.providers.manual.configured, true);
  const body = { provider: 'manual', join_url: 'https://meet.example.com/np-aws', starts_at: inMinutes(10), duration_minutes: 180 };
  await expectStatus('/api/live/sessions/ses_aws_nov/meeting', 401, { method: 'PUT', body });
  await expectStatus('/api/live/sessions/ses_aws_nov/meeting', 403, { token: student, method: 'PUT', body });
  await expectStatus('/api/live/sessions/ses_ccna_nov/meeting', 400, { token: admin, method: 'PUT', body });
  await expectStatus('/api/live/sessions/ses_aws_nov/meeting', 503, { token: admin, method: 'PUT', body: { ...body, provider: 'zoom' } });
  await expectStatus('/api/live/sessions/ses_aws_nov/meeting', 503, { token: admin, method: 'PUT', body: { ...body, provider: 'teams' } });
  await expectStatus('/api/live/sessions/ses_aws_nov/meeting', 400, { token: admin, method: 'PUT', body: { ...body, join_url: 'http://insecure.example.com' } });
  await expectStatus('/api/live/sessions/ses_aws_nov/meeting', 400, { token: admin, method: 'PUT', body: { ...body, provider: 'meet' } });
  await expectStatus('/api/live/sessions/ses_aws_nov/meeting', 400, { token: admin, method: 'PUT', body: { ...body, starts_at: '2026-11-18 09:00' } });
  const saved = await expectStatus('/api/live/sessions/ses_aws_nov/meeting', 200, { token: coord, method: 'PUT', body });
  assert.equal(saved.meeting.join_url, body.join_url);
  assert.equal((await expectStatus('/api/live/sessions/ses_aws_nov/meeting', 200, { token: admin })).meeting.provider, 'manual');
  assert.equal((await request('/api/live/sessions/ses_aws_nov/meeting/import-attendance', { token: admin, method: 'POST' })).status, 400);
});

test('live: join link only for confirmed registrants and only from 30 minutes before start', async () => {
  await expectStatus('/api/admin/site/sessions/ses_aws_nov/registrations', 201, { token: admin, method: 'POST', body: {
    name: 'Emma Watson', email: 'student3@netprime.com', phone: '0800000000', status: 'pending'
  } });
  let mine = await expectStatus('/api/live/my', 200, { token: student });
  assert.ok(!mine.items.some(i => i.kind === 'session' && i.id === 'ses_aws_nov'), 'pending registrants do not see the meeting');
  const pending = await request('/api/live/join/session/ses_aws_nov', { token: student, method: 'POST' });
  assert.equal(pending.status, 403);
  assert.equal(pending.data.code, 'not_confirmed');

  const regs = await expectStatus('/api/admin/site/sessions/ses_aws_nov/registrations', 200, { token: admin });
  const reg = regs.registrations.find(r => r.email === 'student3@netprime.com');
  await expectStatus(`/api/admin/site/registrations/${reg.id}`, 200, { token: admin, method: 'PATCH', body: { status: 'confirmed', notify: false } });

  mine = await expectStatus('/api/live/my', 200, { token: student });
  const item = mine.items.find(i => i.kind === 'session' && i.id === 'ses_aws_nov');
  assert.ok(item, JSON.stringify(mine));
  assert.equal(item.join_available, true);
  assert.ok(!('join_url' in item), 'the list never carries the link');
  const join = await expectStatus('/api/live/join/session/ses_aws_nov', 200, { token: student, method: 'POST' });
  assert.equal(join.join_url, 'https://meet.example.com/np-aws');

  await expectStatus('/api/live/sessions/ses_aws_nov/meeting', 200, { token: admin, method: 'PUT', body: { provider: 'manual', join_url: 'https://meet.example.com/np-aws', starts_at: inMinutes(120), duration_minutes: 60 } });
  const early = await request('/api/live/join/session/ses_aws_nov', { token: student, method: 'POST' });
  assert.equal(early.status, 403);
  assert.equal(early.data.code, 'too_early');
  assert.ok(early.data.join_opens_at);
  mine = await expectStatus('/api/live/my', 200, { token: student });
  assert.equal(mine.items.find(i => i.id === 'ses_aws_nov').join_available, false);

  const other = (await login('student2@netprime.com', 'stud123')).token;
  assert.equal((await request('/api/live/join/session/ses_aws_nov', { token: other, method: 'POST' })).status, 403);
});

test('live: course live classes for enrolled learners, attendance and email verification gate', async () => {
  const cls = { title: 'Live Q&A CCNA', provider: 'manual', join_url: 'https://teams.example.com/l/ccna', starts_at: inMinutes(15), duration_minutes: 60 };
  await expectStatus('/api/live/courses/course_cisco_ccna/classes', 403, { token: student, method: 'POST', body: cls });
  await expectStatus('/api/live/courses/course_cisco_ccna/classes', 400, { token: instructor, method: 'POST', body: { ...cls, title: '' } });
  await expectStatus('/api/live/courses/course_cisco_ccna/classes', 503, { token: instructor, method: 'POST', body: { ...cls, provider: 'zoom' } });
  const created = await expectStatus('/api/live/courses/course_cisco_ccna/classes', 201, { token: instructor, method: 'POST', body: cls });
  const id = created.class.id;

  const view = await expectStatus('/api/live/courses/course_cisco_ccna/classes', 200, { token: student });
  const learnerRow = view.classes.find(c => c.id === id);
  assert.equal(learnerRow.join_available, true);
  assert.ok(!('join_url' in learnerRow));
  const notEnrolled = (await login('student2@netprime.com', 'stud123')).token;
  assert.equal((await request('/api/live/courses/course_cisco_ccna/classes', { token: notEnrolled })).status, 403);
  assert.equal((await request(`/api/live/join/class/${id}`, { token: notEnrolled, method: 'POST' })).status, 403);

  const mine = await expectStatus('/api/live/my', 200, { token: student });
  assert.ok(mine.items.some(i => i.kind === 'class' && i.id === id && i.course_title));
  const join = await expectStatus(`/api/live/join/class/${id}`, 200, { token: student, method: 'POST' });
  assert.equal(join.join_url, cls.join_url);

  let attendance = await expectStatus(`/api/live/classes/${id}/attendance`, 200, { token: instructor });
  assert.equal(attendance.learners.find(l => l.user_id === 'usr_student3').source, 'join');
  await expectStatus(`/api/live/classes/${id}/attendance`, 200, { token: instructor, method: 'PUT', body: { user_id: 'usr_student3', attended: false } });
  attendance = await expectStatus(`/api/live/classes/${id}/attendance`, 200, { token: instructor });
  assert.equal(attendance.learners.find(l => l.user_id === 'usr_student3').source, null);
  await expectStatus(`/api/live/classes/${id}/attendance`, 403, { token: student });

  // Later class: not joinable yet.
  const later = await expectStatus(`/api/live/classes/${id}`, 200, { token: instructor, method: 'PATCH', body: { starts_at: inMinutes(180) } });
  assert.equal(later.class.join_url, cls.join_url);
  const early = await request(`/api/live/join/class/${id}`, { token: student, method: 'POST' });
  assert.equal(early.data.code, 'too_early');
  await expectStatus(`/api/live/classes/${id}`, 200, { token: instructor, method: 'PATCH', body: { starts_at: inMinutes(5) } });

  // Email verification gate (school setting) for an unverified learner enrolled through the API.
  await api('/api/v1/enrollments', keys.full, { method: 'POST', body: { user_id: tokens.unverifiedId, course_id: 'course_cisco_ccna' } });
  assert.equal((await request(`/api/live/join/class/${id}`, { token: tokens.unverified, method: 'POST' })).status, 200);
  await expectStatus('/api/admin/platform/settings', 200, { token: admin, method: 'PUT', body: { signup: { require_email_verification: true } } });
  const gated = await request(`/api/live/join/class/${id}`, { token: tokens.unverified, method: 'POST' });
  assert.equal(gated.status, 403);
  assert.equal(gated.data.code, 'email_unverified');
  assert.equal((await request(`/api/live/join/class/${id}`, { token: student, method: 'POST' })).status, 200, 'verified learners are not affected');
  await expectStatus('/api/admin/platform/settings', 200, { token: admin, method: 'PUT', body: { signup: { require_email_verification: false } } });

  await expectStatus(`/api/live/classes/${id}`, 403, { token: student, method: 'DELETE' });
  await expectStatus(`/api/live/classes/${id}`, 200, { token: instructor, method: 'DELETE' });
  await expectStatus('/api/live/sessions/ses_aws_nov/meeting', 200, { token: admin, method: 'DELETE' });
});

test('scoping: platform/live/v1 middleware never puts auth in front of other public /api routes', async () => {
  await expectStatus('/api/public/site', 200);
  await expectStatus('/api/public/platform', 200);
  await expectStatus('/api/sso/status', 200);
  await expectStatus('/api/v1/openapi.json', 200);
  const unknown = await request('/api/definitely-not-a-route');
  assert.equal(unknown.status, 404, 'unknown /api paths reach the 404 handler, not an auth wall');
  assert.equal((await request('/api/live/my')).status, 401, 'live routes do require a session');
  assert.equal((await request('/api/v1/users')).status, 401, 'v1 routes do require an API key');
});

test('sso admin: deleting a provider needs an emailed admin code', async () => {
  const created = await expectStatus('/api/admin/platform/sso', 201, { token: admin, method: 'POST', body: {
    name: 'To Delete', issuer: 'https://idp.mock.test', client_id: 'np-delete', client_secret: 'mock-secret', allowed_domains: ['delete-sso.example'] } });
  const id = created.provider.id;
  await expectStatus(`/api/admin/platform/sso/${id}`, 428, { token: admin, method: 'DELETE' });
  const preview = await expectStatus(`/api/security/delete-preview?action=sso.delete&target_id=${id}`, 200, { token: admin });
  assert.equal(preview.admin_only, true);
  const code = (await dangerCode(admin, 'sso.delete', id)).debug_code;
  await expectStatus(`/api/admin/platform/sso/${id}`, 200, { token: admin, method: 'DELETE', body: { confirmation_code: code } });
  await expectStatus(`/api/admin/platform/sso/${id}`, 404, { token: admin, method: 'DELETE' });
});
