import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let admin, student;
const day = offset => new Date(Date.now() + 7 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);
const applicant = (n, extra = {}) => ({ name: `ผู้สมัคร ${n}`, email: `site-${n}@example.invalid`, phone: '0812345678', consent: true, ...extra });

before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  student = await login('student3@netprime.com', 'stud123');
});

async function createSession(body = {}) {
  const data = await expectStatus('/api/admin/site/sessions', 201, { method: 'POST', token: admin.token, body: {
    title: 'Test Session', vendor: 'Cisco', start_date: day(20), end_date: day(22), capacity: 3, price: 9900, status: 'open', ...body
  } });
  return data.session;
}

test('public site data hides drafts and internal notification recipients', async () => {
  const site = await expectStatus('/api/public/site', 200);
  assert.equal(site.settings.notify_emails, undefined);
  assert.ok(site.settings.phone);
  assert.ok(site.promotions.every(p => p.title));
  const { sessions } = await expectStatus('/api/public/sessions', 200);
  assert.ok(sessions.length > 0);
  assert.ok(!sessions.some(s => s.id === 'ses_secplus_dec'), 'draft sessions must not be public');
  assert.ok(sessions.every(s => s.capacity === undefined && typeof s.seats_left === 'number'));
  await expectStatus('/api/public/sessions/ses_secplus_dec', 404);
});

test('content management is restricted to admins', async () => {
  await expectStatus('/api/admin/site/summary', 401);
  await expectStatus('/api/admin/site/summary', 403, { token: student.token });
  await expectStatus('/api/admin/site/sessions', 403, { method: 'POST', token: student.token, body: { title: 'x' } });
  const summary = await expectStatus('/api/admin/site/summary', 200, { token: admin.token });
  assert.ok(summary.counts.new_inquiries >= 1);
});

test('session validation rejects inconsistent dates and unknown courses', async () => {
  const bad = await expectStatus('/api/admin/site/sessions', 400, { method: 'POST', token: admin.token,
    body: { title: 'Bad', start_date: day(10), end_date: day(5), capacity: 5 } });
  assert.match(bad.error, /วันสิ้นสุด/);
  await expectStatus('/api/admin/site/sessions', 400, { method: 'POST', token: admin.token,
    body: { title: 'Bad', start_date: '2026-02-30', end_date: day(5), capacity: 5 } });
  await expectStatus('/api/admin/site/sessions', 400, { method: 'POST', token: admin.token,
    body: { title: 'Bad', start_date: day(5), end_date: day(6), capacity: 5, course_id: 'course_missing' } });
});

test('concurrent registrations cannot overbook and overflow goes to the waitlist', async () => {
  const session = await createSession();
  const results = await Promise.all([1, 2, 3, 4, 5].map(n =>
    request(`/api/public/sessions/${session.id}/register`, { method: 'POST', body: applicant(`race-${n}`) })));
  assert.ok(results.every(r => r.status === 201), JSON.stringify(results.map(r => r.data)));
  const statuses = results.map(r => r.data.registration.status);
  assert.equal(statuses.filter(s => s === 'pending').length, 3);
  assert.equal(statuses.filter(s => s === 'waitlist').length, 2);

  const pub = await expectStatus(`/api/public/sessions/${session.id}`, 200);
  assert.equal(pub.session.seats_left, 0);
  assert.equal(pub.session.waitlist, true);

  const dup = await expectStatus(`/api/public/sessions/${session.id}/register`, 409, { method: 'POST', body: applicant('race-1') });
  assert.match(dup.error, /ลงทะเบียน/);

  // Promoting a waitlisted person while full is refused; cancelling a seat frees it.
  const { registrations } = await expectStatus(`/api/admin/site/sessions/${session.id}/registrations`, 200, { token: admin.token });
  const waiting = registrations.find(r => r.status === 'waitlist');
  const holding = registrations.find(r => r.status === 'pending');
  await expectStatus(`/api/admin/site/registrations/${waiting.id}`, 409, { method: 'PATCH', token: admin.token, body: { status: 'confirmed' } });
  await expectStatus(`/api/admin/site/registrations/${holding.id}`, 200, { method: 'PATCH', token: admin.token, body: { status: 'cancelled' } });
  const promoted = await expectStatus(`/api/admin/site/registrations/${waiting.id}`, 200, { method: 'PATCH', token: admin.token,
    body: { status: 'paid', payment_ref: 'TRF-001' } });
  assert.equal(promoted.registration.status, 'paid');

  // Capacity cannot drop below seats already held, and sessions with registrations are not deleted.
  await expectStatus(`/api/admin/site/sessions/${session.id}`, 409, { method: 'PATCH', token: admin.token, body: { capacity: 2 } });
  await expectStatus(`/api/admin/site/sessions/${session.id}`, 200, { method: 'PATCH', token: admin.token, body: { capacity: 4 } });
  await expectStatus(`/api/admin/site/sessions/${session.id}`, 409, { method: 'DELETE', token: admin.token });
});

test('public registration validates input and blocks bots and closed rounds', async () => {
  const session = await createSession({ capacity: 10 });
  const path = `/api/public/sessions/${session.id}/register`;
  await expectStatus(path, 400, { method: 'POST', body: { name: 'No email', phone: '0812345678', consent: true } });
  await expectStatus(path, 400, { method: 'POST', body: applicant('no-consent', { consent: false }) });
  await expectStatus(path, 400, { method: 'POST', body: applicant('bot', { website: 'http://spam.example' }) });
  const invoice = await expectStatus(path, 400, { method: 'POST', body: applicant('inv', { invoice_required: true }) });
  assert.match(invoice.error, /ใบกำกับภาษี/);
  await expectStatus(path, 400, { method: 'POST', body: applicant('att', { attendees: 0 }) });

  const closed = await createSession({ registration_deadline: day(-1), start_date: day(1), end_date: day(2) });
  await expectStatus(`/api/public/sessions/${closed.id}/register`, 400, { method: 'POST', body: applicant('late') });
  const draft = await createSession({ status: 'draft' });
  await expectStatus(`/api/public/sessions/${draft.id}/register`, 404, { method: 'POST', body: applicant('draft') });
});

test('registration export is Excel friendly and neutralises spreadsheet formulas', async () => {
  const session = await createSession({ capacity: 5 });
  await expectStatus(`/api/public/sessions/${session.id}/register`, 201, { method: 'POST',
    body: applicant('csv', { name: '=HYPERLINK("http://evil.example")', company: 'บริษัท "ทดสอบ"' }) });
  await expectStatus(`/api/admin/site/sessions/${session.id}/registrations`, 201, { method: 'POST', token: admin.token,
    body: applicant('phone', { status: 'confirmed', admin_note: 'สมัครทางโทรศัพท์' }) });
  const csv = await request(`/api/admin/site/sessions/${session.id}/registrations.csv`, { token: admin.token });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  // fetch().text() strips the BOM, so check the raw bytes Excel will see.
  const raw = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/admin/site/sessions/${session.id}/registrations.csv`,
    { headers: { Authorization: `Bearer ${admin.token}` } }).then(r => r.arrayBuffer());
  assert.deepEqual([...new Uint8Array(raw).slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(csv.data.includes(`"'=HYPERLINK(""http://evil.example"")"`));
  assert.ok(csv.data.includes('เจ้าหน้าที่เพิ่ม'));
  await expectStatus(`/api/admin/site/sessions/${session.id}/registrations.csv`, 403, { token: student.token });
});

test('articles publish on demand and reject unsafe links', async () => {
  await expectStatus('/api/public/articles/vsphere-8-basics', 404);
  await expectStatus('/api/admin/site/articles', 400, { method: 'POST', token: admin.token,
    body: { title: 'Bad link', body: 'x', cover_url: 'javascript:alert(1)' } });
  const created = await expectStatus('/api/admin/site/articles', 201, { method: 'POST', token: admin.token,
    body: { title: 'บทความทดสอบ', body: 'ย่อหน้าแรก\n\nย่อหน้าที่สอง', category: 'Cisco', status: 'draft' } });
  const slug = created.article.slug;
  await expectStatus(`/api/public/articles/${slug}`, 404);
  await expectStatus(`/api/admin/site/articles/${created.article.id}`, 200, { method: 'PATCH', token: admin.token, body: { status: 'published' } });
  const pub = await expectStatus(`/api/public/articles/${slug}`, 200);
  assert.equal(pub.article.title, 'บทความทดสอบ');
  const list = await expectStatus('/api/public/articles?category=Cisco', 200);
  assert.ok(list.articles.some(a => a.slug === slug));
  assert.ok(list.articles.every(a => a.body === undefined));
  await expectStatus('/api/admin/site/articles', 409, { method: 'POST', token: admin.token,
    body: { title: 'Duplicate slug', body: 'x', slug } });
});

test('contact form requires consent and lands in the coordinator queue', async () => {
  const body = { name: 'ผู้ติดต่อ', email: 'contact@example.invalid', message: 'สนใจอบรม In-house' };
  await expectStatus('/api/public/inquiries', 400, { method: 'POST', body });
  const created = await expectStatus('/api/public/inquiries', 201, { method: 'POST', body: { ...body, consent: true } });
  const queue = await expectStatus('/api/admin/site/inquiries?status=new', 200, { token: admin.token });
  assert.ok(queue.inquiries.some(i => i.id === created.id));
  await expectStatus(`/api/admin/site/inquiries/${created.id}`, 200, { method: 'PATCH', token: admin.token,
    body: { status: 'in_progress', admin_note: 'โทรกลับแล้ว' } });
});

test('settings validate notification recipients and are audited', async () => {
  await expectStatus('/api/admin/site/settings', 400, { method: 'PUT', token: admin.token,
    body: { notify_emails: 'not-an-email', announcement: { active: false } } });
  await expectStatus('/api/admin/site/settings', 400, { method: 'PUT', token: admin.token,
    body: { announcement: { active: true } } });
  const saved = await expectStatus('/api/admin/site/settings', 200, { method: 'PUT', token: admin.token,
    body: { phone: '02-111-2222', notify_emails: 'a@example.invalid, b@example.invalid', announcement: { active: true, text: 'ประกาศทดสอบ', link: '#schedule' } } });
  assert.equal(saved.settings.notify_emails, 'a@example.invalid, b@example.invalid');
  const site = await expectStatus('/api/public/site', 200);
  assert.equal(site.settings.announcement.text, 'ประกาศทดสอบ');
  const log = await expectStatus('/api/admin/site/audit', 200, { token: admin.token });
  assert.ok(log.entries.some(e => e.entity === 'settings' && e.user_name));
});

test('coordinators manage website content only', async () => {
  const coord = await login('coord@netprime.com', 'coord123');
  assert.equal(coord.user.role, 'coordinator');
  const me = await expectStatus('/api/auth/me', 200, { token: coord.token });
  assert.equal(me.user.role, 'coordinator');

  await expectStatus('/api/admin/site/summary', 200, { token: coord.token });
  const created = await expectStatus('/api/admin/site/sessions', 201, { method: 'POST', token: coord.token, body: {
    title: 'Coordinator Session', start_date: day(30), end_date: day(31), capacity: 5, status: 'open' } });
  await expectStatus(`/api/admin/site/sessions/${created.session.id}/registrations.csv`, 200, { token: coord.token });

  // Everything outside the website console is closed, including learner-only routes of the base account.
  for (const path of ['/api/admin/analytics', '/api/admin/users', '/api/instructor/analytics', '/api/business/analytics', '/api/student/stats']) {
    await expectStatus(path, 403, { token: coord.token });
  }
  await expectStatus('/api/ai/chat', 403, { method: 'POST', token: coord.token, body: { message: 'hi' } });
  await expectStatus('/api/admin/accounts', 403, { method: 'POST', token: coord.token,
    body: { email: 'x@example.invalid', name: 'x', password: 'long-enough-pass', roles: ['coordinator'] } });
  await expectStatus('/api/admin/accounts/usr_student3', 403, { method: 'PATCH', token: coord.token, body: { roles: ['student', 'coordinator'] } });

  // Coordinators are staff, not learners in instructor or leaderboard lists.
  const students = await expectStatus('/api/instructor/students', 200, { token: admin.token });
  assert.ok(!students.some(s => s.id === 'usr_coord'));
});

test('public blog supports search, author byline and catalog lesson counts', async () => {
  const found = await expectStatus(`/api/public/articles?q=${encodeURIComponent('CCNA')}`, 200);
  assert.ok(found.articles.some(a => a.slug === 'ccna-study-plan'));
  assert.ok(found.articles.every(a => /CCNA/i.test(a.title + a.excerpt)));
  // LIKE wildcards are literal, so "%" alone matches nothing instead of everything.
  const wildcard = await expectStatus(`/api/public/articles?q=${encodeURIComponent('%')}`, 200);
  assert.equal(wildcard.total, 0);
  const post = await expectStatus('/api/public/articles/ccna-study-plan', 200);
  assert.ok('author_name' in post.article);
  const courses = await expectStatus('/api/courses', 200);
  assert.ok(courses.length > 0 && courses.every(c => Number.isInteger(c.lesson_count)));
  assert.equal(courses.find(c => c.id === 'course_cisco_ccna').lesson_count, 3);
});
