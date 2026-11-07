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
  assert.equal(site.settings.phone, '062-559-4622');
  assert.match(site.settings.company, /Plantecplus/);
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

test('migrated articles keep their original author and publish date', async () => {
  const { article } = await expectStatus('/api/admin/site/articles', 201, { method: 'POST', token: admin.token,
    body: { title: 'บทความจากเว็บเก่า', slug: 'old-site-post', body: 'เนื้อหา', status: 'published', published_at: '2015-06-21', author_label: 'ผู้เขียนเดิม' } });
  const pub = await expectStatus(`/api/public/articles/${article.slug}`, 200);
  assert.equal(pub.article.author_name, 'ผู้เขียนเดิม');
  assert.equal(pub.article.published_at, '2015-06-21 00:00:00');
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

test('the announcement bar lists rounds starting soon that can still take registrations', async () => {
  const soon = await createSession({ title: 'Soon Round', start_date: day(5), end_date: day(6) });
  const later = await createSession({ title: 'Later Round', start_date: day(31), end_date: day(32) });
  const draft = await createSession({ title: 'Draft Round', start_date: day(5), end_date: day(6), status: 'draft' });
  const started = await createSession({ title: 'Started Round', start_date: day(-1), end_date: day(3) });
  const deadlinePassed = await createSession({ title: 'Deadline Round', start_date: day(5), end_date: day(6), registration_deadline: day(-1) });
  const full = await createSession({ title: 'Full Round', start_date: day(5), end_date: day(6), capacity: 1 });
  await expectStatus(`/api/public/sessions/${full.id}/register`, 201, { method: 'POST', body: applicant('bar-full') });

  const listed = async () => (await expectStatus('/api/public/site', 200)).upcoming_sessions;
  const ids = (await listed()).map(s => s.id);
  assert.ok(ids.includes(soon.id));
  for (const hidden of [later, draft, started, deadlinePassed, full]) assert.ok(!ids.includes(hidden.id), hidden.title);
  assert.deepEqual(Object.keys((await listed())[0]).sort(), ['id', 'start_date', 'title']);

  const settings = (await expectStatus('/api/admin/site/settings', 200, { token: admin.token })).settings;
  const put = auto => expectStatus('/api/admin/site/settings', 200, { method: 'PUT', token: admin.token,
    body: { ...settings, announcement: { ...settings.announcement, auto } } });
  await put(false);
  assert.deepEqual(await listed(), []);
  await put(true);
  assert.ok((await listed()).some(s => s.id === soon.id));
  for (const s of [soon, later, draft, started, deadlinePassed]) {
    await expectStatus(`/api/admin/site/sessions/${s.id}`, 200, { method: 'PATCH', token: admin.token, body: { status: 'draft' } });
  }
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function registerWithSlip(sessionId, person, bytes = PNG, type = 'image/png') {
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...person, consent: 'true' })) form.append(key, String(value));
  form.append('slip', new Blob([bytes], { type }), 'slip.png');
  const res = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/public/sessions/${sessionId}/register`, { method: 'POST', body: form });
  return { status: res.status, data: await res.json() };
}

test('public registration keeps a slip privately and refuses a fake one', async () => {
  const session = await createSession({ capacity: 1 });
  const fake = await registerWithSlip(session.id, applicant('slip-fake'), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(fake.status, 400);

  const saved = await registerWithSlip(session.id, applicant('slip-ok', { buyer_type: 'individual' }));
  assert.equal(saved.status, 201);
  const id = saved.data.registration.id;
  await expectStatus(`/api/admin/site/registrations/${id}/slip`, 401);
  await expectStatus(`/api/admin/site/registrations/${id}/slip`, 403, { token: student.token });
  const res = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/admin/site/registrations/${id}/slip`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);

  // The round is now full: the next person waits, and no money should change hands for that seat.
  const waiting = await registerWithSlip(session.id, applicant('slip-wait'));
  assert.equal(waiting.data.registration.status, 'waitlist');
  const { registrations } = await expectStatus(`/api/admin/site/sessions/${session.id}/registrations`, 200, { token: admin.token });
  assert.equal(registrations.find(r => r.id === waiting.data.registration.id).slip_r2_key, null);
  assert.equal(registrations.find(r => r.id === id).buyer_type, 'individual');

  await expectStatus(`/api/admin/site/registrations/${id}`, 200, { method: 'DELETE', token: admin.token });
  await expectStatus(`/api/admin/site/registrations/${id}/slip`, 404, { token: admin.token });
});

test('bank details for the registration form are public', async () => {
  const { bank } = await expectStatus('/api/public/payment-info', 200);
  assert.deepEqual(Object.keys(bank).sort(), ['account_name', 'account_number', 'bank_name', 'note', 'promptpay_id']);
});

test('rounds may skip days, and the days must agree with the start and end', async () => {
  const days = [day(30), day(32), day(37)];
  const session = await createSession({ start_date: days[0], end_date: days[2], session_dates: [days[2], days[0], days[1], days[0]] });
  assert.equal(session.session_dates, JSON.stringify(days));
  const { session: shown } = await expectStatus(`/api/public/sessions/${session.id}`, 200);
  assert.deepEqual(shown.session_dates, days);

  const bad = await expectStatus('/api/admin/site/sessions', 400, { method: 'POST', token: admin.token,
    body: { title: 'Bad', start_date: days[0], end_date: days[2], capacity: 5, session_dates: [days[1], days[2]] } });
  assert.match(bad.error, /วันอบรม/);
  await expectStatus('/api/admin/site/sessions', 400, { method: 'POST', token: admin.token,
    body: { title: 'Bad', start_date: days[0], end_date: days[2], capacity: 5, session_dates: ['nope'] } });
});

test('staff record payment details and add a company group, reporting who could not be added', async () => {
  const session = await createSession({ capacity: 2 });
  const shared = { company: 'บริษัท ทดสอบ จำกัด', status: 'paid', sales_stage: 'po_received',
    paid_amount_satang: 1070000, paid_on: day(0), paid_account: 'บริษัท', receipt_nos: 'RC-1, RC-2' };
  await expectStatus(`/api/admin/site/sessions/${session.id}/registrations/bulk`, 400, { method: 'POST', token: admin.token,
    body: { ...shared, people: [{ name: 'A', email: 'not-an-email' }] } });
  await expectStatus(`/api/admin/site/sessions/${session.id}/registrations/bulk`, 403, { method: 'POST', token: student.token,
    body: { ...shared, people: [{ name: 'A', email: 'a@example.invalid' }] } });

  const people = ['a', 'a', 'b', 'c'].map(n => ({ name: `Bulk ${n}`, email: `bulk-${n}@example.invalid` }));
  const result = await expectStatus(`/api/admin/site/sessions/${session.id}/registrations/bulk`, 201, { method: 'POST', token: admin.token, body: { ...shared, people } });
  assert.equal(result.added, 2);
  assert.deepEqual(result.results.map(r => r.error ?? 'ok'), ['ok', 'อีเมลนี้ลงทะเบียนรอบนี้ไว้แล้ว', 'ok', 'ที่นั่งไม่พอ']);

  const { registrations } = await expectStatus(`/api/admin/site/sessions/${session.id}/registrations`, 200, { token: admin.token });
  assert.equal(registrations.length, 2);
  assert.ok(registrations.every(r => r.buyer_type === 'company' && r.paid_amount_satang === 1070000 && r.receipt_nos === 'RC-1, RC-2'));

  const { registration } = await expectStatus(`/api/admin/site/registrations/${registrations[0].id}`, 200, { method: 'PATCH', token: admin.token,
    body: { paid_amount_satang: 950000, notify: false } });
  assert.equal(registration.paid_amount_satang, 950000);
  const csv = await request(`/api/admin/site/sessions/${session.id}/registrations.csv`, { token: admin.token });
  assert.match(csv.data, /9500\.00/);
  assert.match(csv.data, /PO แล้ว/);
});

test('confirming a registrant of a round with a course opens an account and the course', async () => {
  const session = await createSession({ course_id: 'course_cisco_ccna' });
  const { registration } = await expectStatus(`/api/public/sessions/${session.id}/register`, 201, { method: 'POST', body: applicant('auto-invite') });
  await expectStatus(`/api/admin/site/registrations/${registration.id}`, 200, { method: 'PATCH', token: admin.token, body: { status: 'confirmed' } });
  const { registrations } = await expectStatus(`/api/admin/site/sessions/${session.id}/registrations`, 200, { token: admin.token });
  assert.ok(registrations[0].account_id);
  assert.equal(registrations[0].course_access, 1);

  // Staff can hold it back by not notifying.
  const quiet = await expectStatus(`/api/public/sessions/${session.id}/register`, 201, { method: 'POST', body: applicant('quiet') });
  await expectStatus(`/api/admin/site/registrations/${quiet.registration.id}`, 200, { method: 'PATCH', token: admin.token, body: { status: 'confirmed', notify: false } });
  const after = await expectStatus(`/api/admin/site/sessions/${session.id}/registrations`, 200, { token: admin.token });
  assert.equal(after.registrations.find(r => r.id === quiet.registration.id).account_id, null);

  // The same goes for a person staff add by hand.
  await expectStatus(`/api/admin/site/sessions/${session.id}/registrations`, 201, { method: 'POST', token: admin.token,
    body: { ...applicant('quiet-manual'), status: 'confirmed', notify: false } });
  const manual = await expectStatus(`/api/admin/site/sessions/${session.id}/registrations`, 200, { token: admin.token });
  assert.equal(manual.registrations.find(r => r.email === 'site-quiet-manual@example.invalid').account_id, null);
});

test('instructors schedule rounds as drafts and see limited registrant details', async () => {
  const instructor = await login('instructor@netprime.com', 'inst123');
  const base = '/api/instructor/sessions';
  await expectStatus(base, 401);
  await expectStatus(base, 403, { token: student.token });
  const { courses } = await expectStatus(`${base}/course-options`, 200, { token: instructor.token });
  assert.ok(courses.length > 0);
  const round = { title: 'รอบของอาจารย์', course_id: courses[0].id, start_date: day(40), end_date: day(41), capacity: 5, status: 'open', instructor_id: 'usr_x', instructor_name: 'คนอื่น' };

  const created = await expectStatus(base, 201, { method: 'POST', token: instructor.token, body: round });
  const session = created.session;
  assert.equal(session.status, 'draft', 'instructors cannot open a round themselves');
  assert.equal(session.instructor_id, instructor.user.id);
  assert.notEqual(session.instructor_name, 'คนอื่น');
  await expectStatus(`/api/public/sessions/${session.id}`, 404);

  const stranger = await expectStatus('/api/admin/site/sessions', 201, { method: 'POST', token: admin.token,
    body: { title: 'ไม่ใช่คอร์สของอาจารย์', start_date: day(40), end_date: day(41), capacity: 5, course_id: 'course_cisco_ccna' } });
  const foreign = await expectStatus('/api/instructor/courses', 201, { method: 'POST', token: admin.token, body: { title: 'คอร์สของคนอื่น', description: 'x' } });
  const refused = await expectStatus(base, 403, { method: 'POST', token: instructor.token, body: { ...round, course_id: foreign.id ?? foreign.course.id } });
  assert.match(refused.error, /คอร์สของคุณ/);
  await expectStatus(`${base}/${stranger.session.id}`, 403, { method: 'PATCH', token: instructor.token, body: { title: 'x' } });
  await expectStatus(`${base}/${stranger.session.id}`, 403, { method: 'DELETE', token: instructor.token });
  await expectStatus(`${base}/${stranger.session.id}/registrations`, 404, { token: instructor.token });
  await expectStatus('/api/admin/site/sessions', 403, { token: instructor.token });

  const edited = await expectStatus(`${base}/${session.id}`, 200, { method: 'PATCH', token: instructor.token, body: { capacity: 8, status: 'open' } });
  assert.equal(edited.session.capacity, 8);
  assert.equal(edited.session.status, 'draft');
  // A classroom-only round needs no online course, and a draft can drop its course link.
  const { course_id: _course, ...classroomOnly } = round;
  const live = await expectStatus(base, 201, { method: 'POST', token: instructor.token, body: { ...classroomOnly, title: 'คลาสสดไม่มีคอร์สออนไลน์' } });
  assert.equal(live.session.course_id, null);
  assert.equal(live.session.status, 'draft');
  const linked = await expectStatus(`${base}/${live.session.id}`, 200, { method: 'PATCH', token: instructor.token, body: { course_id: courses[0].id } });
  assert.equal(linked.session.course_id, courses[0].id);
  const cleared = await expectStatus(`${base}/${live.session.id}`, 200, { method: 'PATCH', token: instructor.token, body: { course_id: '' } });
  assert.equal(cleared.session.course_id, null);
  await expectStatus(`${base}/${live.session.id}`, 403, { method: 'PATCH', token: instructor.token, body: { course_id: foreign.id ?? foreign.course.id } });
  await expectStatus(`${base}/${live.session.id}`, 200, { method: 'DELETE', token: instructor.token });

  // Staff open it; from then on changes go through staff.
  await expectStatus(`/api/admin/site/sessions/${session.id}`, 200, { method: 'PATCH', token: admin.token, body: { status: 'open' } });
  await expectStatus(`${base}/${session.id}`, 403, { method: 'PATCH', token: instructor.token, body: { capacity: 9 } });
  await expectStatus(`${base}/${session.id}`, 403, { method: 'DELETE', token: instructor.token });

  await expectStatus(`/api/public/sessions/${session.id}/register`, 201, { method: 'POST',
    body: applicant('for-instructor', { company: 'ACME', invoice_required: true, tax_id: '1234567890123', billing_address: 'Bangkok' }) });
  const { registrations } = await expectStatus(`${base}/${session.id}/registrations`, 200, { token: instructor.token });
  assert.equal(registrations.length, 1);
  assert.deepEqual(Object.keys(registrations[0]).sort(), ['attendees', 'company', 'created_at', 'id', 'name', 'status']);

  const list = await expectStatus(base, 200, { token: instructor.token });
  assert.ok(list.sessions.some(s => s.id === session.id));
  assert.ok(!list.sessions.some(s => s.id === stranger.session.id));

  const draft = await expectStatus(base, 201, { method: 'POST', token: instructor.token, body: round });
  await expectStatus(`${base}/${draft.session.id}`, 200, { method: 'DELETE', token: instructor.token });
});

test('staff can assign a round to instructor accounts only', async () => {
  const { instructors } = await expectStatus('/api/admin/site/instructor-options', 200, { token: admin.token });
  assert.ok(instructors.length > 0);
  await expectStatus('/api/admin/site/instructor-options', 403, { token: student.token });
  await createSession({ instructor_id: instructors[0].id });
  const bad = await expectStatus('/api/admin/site/sessions', 400, { method: 'POST', token: admin.token,
    body: { title: 'Bad', start_date: day(5), end_date: day(6), capacity: 5, instructor_id: student.user.id } });
  assert.match(bad.error, /วิทยากร/);
});
