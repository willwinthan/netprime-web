import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

// Email delivery log (ตั้งค่าระบบ › อีเมล). The local Worker uses a mock Resend key, so emails are
// "logged" (written to the Worker log) instead of sent; the log, filters and admin tools still apply.

let admin, coord, instructor;
const unique = label => `${label}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.invalid`;
const log = (query = '') => expectStatus(`/api/admin/email/log${query}`, 200, { token: admin.token });

before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  coord = await login('coord@netprime.com', 'coord123');
  instructor = await login('instructor@netprime.com', 'inst123');
});

test('only admins (integrations.manage) see email status and the log', async () => {
  for (const user of [coord, instructor]) {
    await expectStatus('/api/admin/email/status', 403, { token: user.token });
    await expectStatus('/api/admin/email/log', 403, { token: user.token });
    await expectStatus('/api/admin/email/test', 403, { token: user.token, method: 'POST', body: {} });
  }
  await expectStatus('/api/admin/email/status', 401);

  const status = await expectStatus('/api/admin/email/status', 200, { token: admin.token });
  assert.equal(status.mode, 'log_only', 'a mock key never sends');
  assert.match(status.sender, /@/);
  assert.equal(typeof status.last_24h.logged, 'number');
});

test('system emails are recorded with their kind, and can be searched and filtered', async () => {
  const email = unique('maillog');
  await expectStatus('/api/auth/register', 201, { method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.201' }, body: { email, name: 'Mail Log', password: 'mail-log-password-1' } });
  await expectStatus('/api/auth/forgot-password', 200, { method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.202' }, body: { email } });

  const found = await log(`?q=${encodeURIComponent(email)}`);
  const kinds = found.emails.map(e => e.kind);
  assert.ok(kinds.includes('reset'), `reset email logged: ${JSON.stringify(found.emails)}`);
  for (const row of found.emails) {
    assert.equal(row.to_email, email);
    assert.equal(row.status, 'logged');
    assert.equal(row.can_retry, false);
    assert.equal(row.retry_html, undefined, 'bodies are never returned');
  }
  assert.equal(found.total, found.emails.length);

  assert.equal((await log('?status=sent&q=' + encodeURIComponent(email))).total, 0);
  assert.ok((await log('?status=logged&q=' + encodeURIComponent(email))).total >= 1);
  // LIKE wildcards in the query are literal
  assert.equal((await log('?q=%25%25nothing-like-this%25')).total, 0);
});

test('a test email goes to the admin by default or to a given address, and is logged', async () => {
  const self = await expectStatus('/api/admin/email/test', 200, { token: admin.token, method: 'POST', body: {} });
  assert.equal(self.to, 'admin@netprime.com');
  assert.equal(self.status, 'logged');

  const to = unique('testmail');
  const other = await expectStatus('/api/admin/email/test', 200, { token: admin.token, method: 'POST', body: { to } });
  assert.equal(other.to, to);
  const rows = (await log(`?q=${encodeURIComponent(to)}`)).emails;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'test');

  await expectStatus('/api/admin/email/test', 400, { token: admin.token, method: 'POST', body: { to: 'not-an-email' } });
  await expectStatus('/api/admin/email/test', 400, { token: admin.token, method: 'POST', body: { to: 'a@b.co, c@d.co' } });

  // Only failed emails that kept their body can be sent again
  const retry = await request(`/api/admin/email/log/${rows[0].id}/retry`, { token: admin.token, method: 'POST' });
  assert.equal(retry.status, 409);
});
