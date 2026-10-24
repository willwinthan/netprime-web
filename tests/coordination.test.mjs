import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let admin, coord, student;
const day = offset => new Date(Date.now() + 7 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);
const applicant = (email, extra = {}) => ({ name: `ผู้สมัคร ${email}`, email, phone: '0812345678', consent: true, ...extra });

before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  coord = await login('coord@netprime.com', 'coord123');
  student = await login('student3@netprime.com', 'stud123');
});

async function createSession(body = {}) {
  const data = await expectStatus('/api/admin/site/sessions', 201, { method: 'POST', token: coord.token, body: {
    title: 'Coordination Session', vendor: 'Cisco', start_date: day(20), end_date: day(21), capacity: 10, price: 9900, status: 'open', ...body
  } });
  return data.session;
}

async function registrations(sessionId) {
  return (await expectStatus(`/api/admin/site/sessions/${sessionId}/registrations`, 200, { token: coord.token })).registrations;
}

async function exportOf(token) {
  return expectStatus('/api/me/export', 200, { token });
}

// ---------- Registrations ↔ accounts ----------

let linkedSession, linkedRegistration;

test('a public registration links to the existing account with the same email', async () => {
  linkedSession = await createSession({ course_id: 'course_cisco_ccnp' });
  const created = await expectStatus(`/api/public/sessions/${linkedSession.id}/register`, 201, { method: 'POST',
    body: applicant('Student3@NetPrime.com') });
  linkedRegistration = created.registration.id;
  const row = (await registrations(linkedSession.id)).find(r => r.id === linkedRegistration);
  assert.equal(row.user_id, 'usr_student3');
  assert.equal(row.account_id, 'usr_student3');
  assert.equal(row.account_status, 'active');
  assert.ok(!row.course_access, 'pending registrations do not get the course yet');
});

test('confirmed then paid grants the linked course exactly once', async () => {
  const confirmed = await expectStatus(`/api/admin/site/registrations/${linkedRegistration}`, 200, { method: 'PATCH', token: coord.token,
    body: { status: 'confirmed', notify: false } });
  assert.equal(confirmed.course_access, 'created');
  const paid = await expectStatus(`/api/admin/site/registrations/${linkedRegistration}`, 200, { method: 'PATCH', token: coord.token,
    body: { status: 'paid', payment_ref: 'TX-1', notify: false } });
  assert.equal(paid.course_access, 'existing');
  const data = await exportOf(student.token);
  const ccnp = data.enrollments.filter(e => e.course_id === 'course_cisco_ccnp');
  assert.equal(ccnp.length, 1);
  assert.equal(ccnp[0].status, 'active');
  const row = (await registrations(linkedSession.id)).find(r => r.id === linkedRegistration);
  assert.equal(row.course_access, 1);
});

test('linking a course to a session later grants it to confirmed registrants', async () => {
  const session = await createSession();
  const added = await expectStatus(`/api/admin/site/sessions/${session.id}/registrations`, 201, { method: 'POST', token: coord.token,
    body: applicant('student3@netprime.com', { status: 'confirmed' }) });
  assert.equal(added.course_access, null);
  await expectStatus(`/api/admin/site/sessions/${session.id}`, 200, { method: 'PATCH', token: coord.token, body: { course_id: 'course_cisco_sdwan' } });
  const data = await exportOf(student.token);
  assert.equal(data.enrollments.filter(e => e.course_id === 'course_cisco_sdwan').length, 1);
});

test('inviting a registrant without an account creates a linked student account', async () => {
  const email = `invitee-${Date.now()}@example.invalid`;
  const created = await expectStatus(`/api/public/sessions/${linkedSession.id}/register`, 201, { method: 'POST', body: applicant(email) });
  const id = created.registration.id;
  let row = (await registrations(linkedSession.id)).find(r => r.id === id);
  assert.equal(row.user_id, null);
  assert.equal(row.account_id, null);
  await expectStatus(`/api/admin/site/registrations/${id}`, 200, { method: 'PATCH', token: coord.token, body: { status: 'confirmed', notify: false } });

  await expectStatus(`/api/admin/site/registrations/${id}/invite`, 403, { method: 'POST', token: student.token, body: {} });
  const invite = await expectStatus(`/api/admin/site/registrations/${id}/invite`, 201, { method: 'POST', token: coord.token, body: {} });
  assert.equal(invite.created, true);
  assert.equal(invite.course_access, 'created');
  assert.match(invite.debug_url, /\/reset-password\?token=[\w-]{20,}&invite=1$/);
  row = (await registrations(linkedSession.id)).find(r => r.id === id);
  assert.equal(row.user_id, invite.user_id);
  assert.equal(row.account_status, 'active');
  assert.equal(row.account_last_login, null);
  // The account has no usable password until the invitation is accepted.
  await expectStatus('/api/auth/login', 401, { method: 'POST', body: { email, password: 'pbkdf2-sha256$unusable$' } });

  // Inviting again before the password is set sends a fresh link to the same account.
  const again = await expectStatus(`/api/admin/site/registrations/${id}/invite`, 200, { method: 'POST', token: coord.token, body: {} });
  assert.equal(again.created, false);
  assert.equal(again.resent, true);
  assert.equal(again.user_id, invite.user_id);
  assert.notEqual(again.debug_url, invite.debug_url);
  // Registrants who already use their account are only linked, never re-invited.
  const existing = await expectStatus(`/api/admin/site/registrations/${linkedRegistration}/invite`, 200, { method: 'POST', token: coord.token, body: {} });
  assert.equal(existing.resent, undefined);
  assert.equal(existing.debug_url, undefined);
  const options = await expectStatus('/api/admin/site/course-options', 200, { token: coord.token });
  assert.ok(options.courses.some(c => c.id === 'course_cisco_ccnp'));
});

// ---------- Reminder job ----------

test('the reminder job emails confirmed registrants two days ahead, once', async () => {
  const session = await createSession({ start_date: day(2), end_date: day(3) });
  const confirmed = await expectStatus(`/api/admin/site/sessions/${session.id}/registrations`, 201, { method: 'POST', token: coord.token,
    body: applicant(`remind-${Date.now()}@example.invalid`, { status: 'confirmed' }) });
  const pending = await expectStatus(`/api/admin/site/sessions/${session.id}/registrations`, 201, { method: 'POST', token: coord.token,
    body: applicant(`remind-pending-${Date.now()}@example.invalid`, { status: 'pending' }) });
  const later = await createSession({ start_date: day(5), end_date: day(5) });
  const notYet = await expectStatus(`/api/admin/site/sessions/${later.id}/registrations`, 201, { method: 'POST', token: coord.token,
    body: applicant(`remind-later-${Date.now()}@example.invalid`, { status: 'paid' }) });

  await expectStatus('/api/admin/site/jobs/run', 403, { method: 'POST', token: coord.token, body: {} });
  const first = await expectStatus('/api/admin/site/jobs/run', 200, { method: 'POST', token: admin.token, body: {} });
  assert.ok(first.reminders.registration_ids.includes(confirmed.registration.id));
  assert.ok(!first.reminders.registration_ids.includes(pending.registration.id));
  assert.ok(!first.reminders.registration_ids.includes(notYet.registration.id));
  assert.equal(first.tokens_purged, true);

  const rows = await registrations(session.id);
  const sentAt = rows.find(r => r.id === confirmed.registration.id).reminder_sent_at;
  assert.ok(sentAt);
  assert.equal(rows.find(r => r.id === pending.registration.id).reminder_sent_at, null);

  const second = await expectStatus('/api/admin/site/jobs/run', 200, { method: 'POST', token: admin.token, body: {} });
  assert.ok(!second.reminders.registration_ids.includes(confirmed.registration.id));
  const after = (await registrations(session.id)).find(r => r.id === confirmed.registration.id);
  assert.equal(after.reminder_sent_at, sentAt);
});

// ---------- Homepage CMS & legal pages ----------

test('homepage content is validated and published through the public site data', async () => {
  const site = await expectStatus('/api/public/site', 200);
  assert.ok(site.home.hero.title);
  assert.ok(site.home.services.length >= 1 && site.home.faq.length >= 1 && site.home.brands.length >= 1);
  assert.deepEqual(site.legal.map(l => l.path), ['/privacy', '/terms', '/refund-policy']);

  const valid = {
    hero: { eyebrow: 'IT Training', title: 'หัวข้อใหม่จากเจ้าหน้าที่', lead: 'คำอธิบายใหม่' },
    brands: [{ name: 'Cisco', text: 'CCNA', link: '/schedule' }, { name: 'AWS', text: '', link: 'https://aws.amazon.com' }],
    services: [{ title: 'อบรมในห้องเรียน', text: 'ฝึก Lab จริง', icon: 'network' }],
    faq: [{ q: 'คำถามใหม่', a: 'คำตอบใหม่' }]
  };
  await expectStatus('/api/admin/site/home', 403, { method: 'PUT', token: student.token, body: valid });
  for (const bad of [
    { ...valid, brands: [{ name: 'X', link: 'javascript:alert(1)' }] },
    { ...valid, hero: { ...valid.hero, title: 'ก'.repeat(121) } },
    { ...valid, services: [{ title: 'x', text: 'y', icon: 'rocket' }] },
    { ...valid, faq: [{ q: 'คำถามไม่มีคำตอบ', a: '' }] },
    { ...valid, faq: Array.from({ length: 21 }, (_, i) => ({ q: `q${i}`, a: 'a' })) },
    { ...valid, services: 'not a list' }
  ]) {
    await expectStatus('/api/admin/site/home', 400, { method: 'PUT', token: coord.token, body: bad });
  }
  await expectStatus('/api/admin/site/home', 200, { method: 'PUT', token: coord.token, body: valid });
  const after = await expectStatus('/api/public/site', 200);
  assert.equal(after.home.hero.title, 'หัวข้อใหม่จากเจ้าหน้าที่');
  assert.deepEqual(after.home.brands.map(b => b.name), ['Cisco', 'AWS']);
  assert.equal(after.home.faq[0].q, 'คำถามใหม่');
  const editor = await expectStatus('/api/admin/site/home', 200, { token: coord.token });
  assert.equal(editor.is_default, false);
  assert.ok(editor.defaults.faq.length >= 4);
});

test('legal pages ship draft templates and are editable by site.settings', async () => {
  const draft = await expectStatus('/api/public/legal/privacy', 200);
  assert.equal(draft.page.is_default, true);
  assert.match(draft.page.content, /ร่างเอกสาร/);
  assert.match(draft.page.content, /PDPA/);
  await expectStatus('/api/public/legal/refund-policy', 200);
  await expectStatus('/api/public/legal/secret', 404);

  await expectStatus('/api/admin/site/legal/terms', 403, { method: 'PUT', token: student.token, body: { title: 'x', content: 'y' } });
  await expectStatus('/api/admin/site/legal/terms', 400, { method: 'PUT', token: coord.token, body: { title: 'ข้อกำหนด', content: '' } });
  await expectStatus('/api/admin/site/legal/terms', 400, { method: 'PUT', token: coord.token, body: { title: 'ข้อกำหนด', content: 'ก'.repeat(50_001) } });
  await expectStatus('/api/admin/site/legal/terms', 200, { method: 'PUT', token: coord.token,
    body: { title: 'ข้อกำหนดการใช้งาน (ฉบับจริง)', content: '## ข้อ 1\n\nตรวจทานโดยทนายแล้ว' } });
  const saved = await expectStatus('/api/public/legal/terms', 200);
  assert.equal(saved.page.is_default, false);
  assert.equal(saved.page.title, 'ข้อกำหนดการใช้งาน (ฉบับจริง)');
  assert.ok(saved.page.updated_at);
  const reset = await expectStatus('/api/admin/site/legal/terms', 200, { method: 'PUT', token: coord.token, body: { reset: true } });
  assert.equal(reset.page.is_default, true);
});

// ---------- PDPA ----------

test('data export contains only the signed-in user\'s own data', async () => {
  await expectStatus('/api/me/export', 401);
  const data = await exportOf(student.token);
  assert.equal(data.profile.id, 'usr_student3');
  assert.equal(data.profile.email, 'student3@netprime.com');
  assert.deepEqual(data.roles, ['student']);
  assert.ok(data.enrollments.length >= 2);
  for (const key of ['enrollments', 'lesson_progress', 'quiz_attempts', 'notes', 'certificates', 'notifications']) {
    assert.ok(Array.isArray(data[key]), key);
    assert.ok(data[key].every(row => row.user_id === 'usr_student3'), key);
  }
  assert.ok(data.training_registrations.some(r => r.id === linkedRegistration));
  const text = JSON.stringify(data);
  assert.ok(!text.includes('password_hash') && !text.includes('token_hash'));
  assert.ok(!text.includes('usr_student1') && !text.includes('admin@netprime.com'));
});

test('a deletion request, once approved, anonymizes the account and blocks sign-in', async () => {
  const email = `pdpa-${Date.now()}@example.invalid`;
  const account = await expectStatus('/api/auth/register', 201, { method: 'POST', body: { email, name: 'PDPA Tester', password: 'long-test-password-123' } });
  const token = account.token;
  await expectStatus(`/api/public/sessions/${linkedSession.id}/register`, 201, { method: 'POST', body: applicant(email) });

  await expectStatus('/api/me/deletion-request', 400, { method: 'POST', token, body: { reason: 'x'.repeat(1001) } });
  const created = await expectStatus('/api/me/deletion-request', 201, { method: 'POST', token, body: { reason: 'ไม่ใช้งานแล้ว' } });
  await expectStatus('/api/me/deletion-request', 409, { method: 'POST', token, body: {} });
  assert.equal((await expectStatus('/api/me/deletion-request', 200, { token })).request.status, 'pending');

  await expectStatus('/api/admin/privacy/requests', 403, { token: student.token });
  const list = await expectStatus('/api/admin/privacy/requests?status=pending', 200, { token: admin.token });
  assert.ok(list.requests.some(r => r.id === created.request.id && r.user_email === email));

  await expectStatus(`/api/admin/privacy/requests/${created.request.id}/approve`, 200, { method: 'POST', token: admin.token, body: { note: 'ดำเนินการตามคำขอ' } });
  await expectStatus(`/api/admin/privacy/requests/${created.request.id}/approve`, 409, { method: 'POST', token: admin.token, body: {} });
  await expectStatus('/api/auth/login', 401, { method: 'POST', body: { email, password: 'long-test-password-123' } });
  await expectStatus('/api/auth/me', 401, { token });

  const processed = (await expectStatus('/api/admin/privacy/requests', 200, { token: admin.token })).requests.find(r => r.id === created.request.id);
  assert.equal(processed.status, 'approved');
  assert.equal(processed.user_name, 'ผู้ใช้ที่ลบแล้ว');
  assert.equal(processed.user_email, `deleted-${account.user.id}@invalid`);
  assert.equal(processed.account_status, 'suspended');
  const reg = (await registrations(linkedSession.id)).find(r => r.user_id === account.user.id);
  assert.equal(reg.name, 'ผู้ใช้ที่ลบแล้ว');
  assert.ok(!reg.email.includes('pdpa-'));
});

test('a deletion request can be rejected with a reason', async () => {
  const account = await expectStatus('/api/auth/register', 201, { method: 'POST',
    body: { email: `pdpa-reject-${Date.now()}@example.invalid`, name: 'Keep Me', password: 'long-test-password-123' } });
  const created = await expectStatus('/api/me/deletion-request', 201, { method: 'POST', token: account.token, body: {} });
  await expectStatus(`/api/admin/privacy/requests/${created.request.id}/reject`, 400, { method: 'POST', token: admin.token, body: {} });
  await expectStatus(`/api/admin/privacy/requests/${created.request.id}/reject`, 200, { method: 'POST', token: admin.token, body: { note: 'มีคำสั่งซื้อค้างชำระ' } });
  const mine = await expectStatus('/api/me/deletion-request', 200, { token: account.token });
  assert.equal(mine.request.status, 'rejected');
  assert.equal(mine.request.admin_note, 'มีคำสั่งซื้อค้างชำระ');
  // A rejected request does not block a new one.
  await expectStatus('/api/me/deletion-request', 201, { method: 'POST', token: account.token, body: {} });
});

// ---------- Article revisions & conflicts ----------

test('stale article saves get 409 with the latest version, and revisions can be restored', async () => {
  const { article } = await expectStatus('/api/admin/site/articles', 201, { method: 'POST', token: admin.token,
    body: { title: 'บทความทดสอบประวัติ', body: 'ฉบับแรก', status: 'draft' } });
  const v1 = article.updated_at;

  const saved = await expectStatus(`/api/admin/site/articles/${article.id}`, 200, { method: 'PATCH', token: admin.token,
    body: { body: 'ฉบับสองโดยแอดมิน', expected_updated_at: v1 } });
  const v2 = saved.article.updated_at;
  assert.notEqual(v2, v1);

  // A coordinator still holding the first version must not overwrite silently.
  const conflict = await expectStatus(`/api/admin/site/articles/${article.id}`, 409, { method: 'PATCH', token: coord.token,
    body: { body: 'ฉบับของเจ้าหน้าที่', expected_updated_at: v1 } });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.article.body, 'ฉบับสองโดยแอดมิน');
  assert.equal(conflict.article.updated_at, v2);
  // Explicit overwrite ("บันทึกทับ") with the latest timestamp.
  await expectStatus(`/api/admin/site/articles/${article.id}`, 200, { method: 'PATCH', token: coord.token,
    body: { body: 'ฉบับของเจ้าหน้าที่', expected_updated_at: v2 } });

  const { revisions } = await expectStatus(`/api/admin/site/articles/${article.id}/revisions`, 200, { token: coord.token });
  assert.deepEqual(revisions.map(r => r.excerpt), ['ฉบับสองโดยแอดมิน', 'ฉบับแรก']);
  const first = revisions[1];
  const detail = await expectStatus(`/api/admin/site/articles/${article.id}/revisions/${first.id}`, 200, { token: admin.token });
  assert.equal(detail.revision.body, 'ฉบับแรก');

  await expectStatus(`/api/admin/site/articles/${article.id}/restore`, 404, { method: 'POST', token: admin.token, body: { revision_id: 'rev_missing' } });
  const restored = await expectStatus(`/api/admin/site/articles/${article.id}/restore`, 200, { method: 'POST', token: admin.token, body: { revision_id: first.id } });
  assert.equal(restored.article.body, 'ฉบับแรก');
  const history = (await expectStatus(`/api/admin/site/articles/${article.id}/revisions`, 200, { token: admin.token })).revisions;
  assert.equal(history[0].excerpt, 'ฉบับของเจ้าหน้าที่', 'the version replaced by the restore is kept');
  assert.equal(history.length, 3);

  // Students cannot see article history.
  await expectStatus(`/api/admin/site/articles/${article.id}/revisions`, 403, { token: student.token });
});
