// Analytics: presence heartbeats, school dashboard KPIs, reports, events log, CSV export and global search.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let admin, coord, instructor, student1, student3;
const post = (path, token, body) => request(path, { method: 'POST', token, body });

before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  coord = await login('coord@netprime.com', 'coord123');
  instructor = await login('instructor@netprime.com', 'inst123');
  student1 = await login('student1@netprime.com', 'stud123');
  student3 = await login('student3@netprime.com', 'stud123');
});

const dashboard = (token, range = '30d') => expectStatus(`/api/analytics/dashboard?range=${range}`, 200, { token });
const learnerRow = async (email) => {
  const data = await expectStatus(`/api/reports/learners?q=${encodeURIComponent(email)}`, 200, { token: admin.token });
  return data.learners.find(l => l.email === email);
};

async function rawCsv(path, token) {
  const response = await fetch(`${process.env.NETPRIME_TEST_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  return { status: response.status, type: response.headers.get('content-type'), bytes: new Uint8Array(await response.arrayBuffer()) };
}

test('heartbeat credits at most 60 s and never more than the time since the last beat', async () => {
  const before = (await learnerRow('student3@netprime.com')).seconds;
  const first = await expectStatus('/api/me/heartbeat', 200, { method: 'POST', token: student3.token, body: { course_id: 'course_cisco_ccna', seconds: 600 } });
  assert.equal(first.credited_seconds, 60);
  assert.equal(first.course_id, 'course_cisco_ccna');
  // A burst of extra heartbeats right away adds (almost) nothing.
  let burst = 0;
  for (let i = 0; i < 3; i++) {
    const r = await expectStatus('/api/me/heartbeat', 200, { method: 'POST', token: student3.token, body: { course_id: 'course_cisco_ccna', seconds: 60 } });
    burst += r.credited_seconds;
  }
  assert.ok(burst <= 3, `burst credited ${burst}`);
  const after = (await learnerRow('student3@netprime.com')).seconds;
  assert.ok(after - before >= 60 && after - before <= 63, `accumulated ${after - before}`);

  const mine = await expectStatus('/api/me/learning-time?range=7d', 200, { token: student3.token });
  assert.ok(mine.rows.some(r => r.course_id === 'course_cisco_ccna' && r.seconds >= 60));

  // Courses the user is not enrolled in are not credited to that course.
  const other = await expectStatus('/api/me/heartbeat', 200, { method: 'POST', token: student1.token, body: { course_id: 'course_juniper_jncie', lesson_id: 'x' } });
  assert.equal(other.course_id, null);
  assert.equal((await post('/api/me/heartbeat', student1.token, { seconds: -5 })).status, 400);
  assert.equal((await post('/api/me/heartbeat', student1.token, { course_id: "bad id'--" })).status, 400);
  assert.equal((await post('/api/me/heartbeat', null, {})).status, 401);
});

test('online users lists recent heartbeats; reports.view only', async () => {
  await expectStatus('/api/me/heartbeat', 200, { method: 'POST', token: student1.token, body: {} });
  const online = await expectStatus('/api/analytics/online', 200, { token: coord.token });
  const s1 = online.users.find(u => u.email === 'student1@netprime.com');
  assert.ok(s1, 'student1 is online');
  assert.ok(s1.roles.includes('student'));
  assert.equal((await request('/api/analytics/online', { token: student1.token })).status, 403);
  assert.equal((await request('/api/analytics/online', { token: instructor.token })).status, 403);
});

test('dashboard KPIs follow new signups, enrollments and paid orders; refunds are excluded', async () => {
  const k0 = (await dashboard(admin.token)).kpis;
  const email = `analytics-${Date.now()}@example.com`;
  const signup = await post('/api/auth/register', null, { email, password: 'analytics-pass-123', name: 'Analytics Learner' });
  assert.equal(signup.status, 201, JSON.stringify(signup.data));
  const learner = signup.data;

  // Paid order counts toward sales and revenue.
  const order = await post('/api/student/orders', learner.token, { course_id: 'course_aws_sec' });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  await expectStatus(`/api/manage/orders/${order.data.order.id}/confirm`, 200, { method: 'POST', token: coord.token, body: { amount_received: 1234 } });
  // A second order is paid and then refunded: not revenue.
  const refunded = await post('/api/student/orders', learner.token, { course_id: 'course_juniper_jncia' });
  assert.equal(refunded.status, 201, JSON.stringify(refunded.data));
  await expectStatus(`/api/manage/orders/${refunded.data.order.id}/confirm`, 200, { method: 'POST', token: coord.token, body: { amount_received: 999 } });
  await expectStatus(`/api/manage/orders/${refunded.data.order.id}/refund`, 200, { method: 'POST', token: coord.token, body: { note: 'ทดสอบคืนเงิน' } });

  const k1 = (await dashboard(admin.token)).kpis;
  assert.equal(k1.total_users, k0.total_users + 1);
  assert.equal(k1.new_signups, k0.new_signups + 1);
  assert.equal(k1.converted_users, k0.converted_users + 1);
  assert.equal(k1.revenue, k0.revenue + 1234);
  assert.equal(k1.sales_count, k0.sales_count + 1);
  assert.equal(k1.revenue_30d, k0.revenue_30d + 1234);
  assert.equal(k1.conversion_percent, Math.round((k1.converted_users / k1.total_users) * 1000) / 10);
  assert.ok(k1.published_courses >= 20);
  assert.ok(k1.active_learners >= 1, 'heartbeat learners are active');

  const full = await dashboard(coord.token, '7d');
  assert.equal(full.series.length, 7);
  assert.equal(full.series.at(-1).key, full.range.to);
  assert.ok(full.series.at(-1).revenue >= 1234);
  assert.ok(full.series.at(-1).signups >= 1);
  assert.equal((await dashboard(admin.token, '12m')).series.length, 12);
  assert.equal((await request('/api/analytics/dashboard?range=custom&from=2026-02-01&to=2026-01-01', { token: admin.token })).status, 400);
  assert.equal((await request('/api/analytics/dashboard?range=forever', { token: admin.token })).status, 400);
  const custom = await dashboard(admin.token, 'custom&from=2026-01-01&to=2026-01-10');
  assert.equal(custom.series.length, 10);

  const revenue = await expectStatus('/api/reports/revenue?range=7d', 200, { token: coord.token });
  assert.ok(revenue.by_course.some(r => r.course_id === 'course_aws_sec' && r.revenue >= 1234));
  assert.ok(!revenue.by_course.some(r => r.course_id === 'course_juniper_jncia'));
  assert.ok(revenue.refunds.some(r => r.reference === refunded.data.order.reference));
  assert.ok(revenue.totals.refunds_amount >= 999);

  // Events were recorded for signup, order_paid; widgets show them with Thai descriptions.
  const events = await expectStatus(`/api/analytics/events?user=${encodeURIComponent(email)}`, 200, { token: coord.token });
  const types = events.events.map(e => e.type);
  assert.ok(types.includes('signup') && types.includes('order_paid'), types.join(','));
  const paid = events.events.find(e => e.type === 'order_paid');
  assert.match(paid.description, /ชำระเงินสำเร็จ/);
  assert.equal(paid.link.tab, 'orders');
  const activity = await expectStatus('/api/analytics/activity', 200, { token: coord.token });
  assert.ok(activity.new_users.some(u => u.email === email));
  assert.ok(activity.events.length > 0);
  assert.ok(Array.isArray(activity.posts) && Array.isArray(activity.online));
});

test('login and enrollment are recorded in the events log', async () => {
  const fresh = await login('student1@netprime.com', 'stud123');
  await expectStatus('/api/courses/course_cf_d1_r2/enroll', 201, { method: 'POST', token: fresh.token });
  const log = await expectStatus(`/api/analytics/events?user=${fresh.user.id}`, 200, { token: admin.token });
  assert.ok(log.events.some(e => e.type === 'login'));
  const enroll = log.events.find(e => e.type === 'enroll' && e.course_id === 'course_cf_d1_r2');
  assert.ok(enroll);
  assert.match(enroll.description, /ลงทะเบียนเรียน/);
  const filtered = await expectStatus(`/api/analytics/events?type=enroll&course=course_cf_d1_r2&limit=1&page=1`, 200, { token: admin.token });
  assert.equal(filtered.events.length, 1);
  assert.ok(filtered.total >= 1);
  assert.equal((await request('/api/analytics/events?type=DROP%20TABLE', { token: admin.token })).status, 400);
  assert.equal((await request('/api/analytics/events?from=yesterday', { token: admin.token })).status, 400);
});

test('reports: students are denied, instructors only see their own courses', async () => {
  for (const path of ['/api/analytics/dashboard', '/api/analytics/activity', '/api/analytics/events', '/api/reports/courses', '/api/reports/learners', '/api/reports/revenue', '/api/reports/courses/course_cf_workers']) {
    assert.equal((await request(path, { token: student3.token })).status, 403, path);
    assert.equal((await request(path)).status, 401, path);
  }
  assert.equal((await request('/api/analytics/dashboard', { token: instructor.token })).status, 403);

  // A second instructor with one course of their own.
  const created = await post('/api/admin/accounts', admin.token, { email: `inst2-${Date.now()}@example.com`, name: 'Second Instructor', roles: ['instructor'], password: 'analytics-pass-123' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const inst2 = await login(created.data.user.email, 'analytics-pass-123');
  const course = await expectStatus('/api/instructor/courses', 201, { method: 'POST', token: inst2.token, body: { title: 'Analytics Own Course', description: 'ทดสอบรายงาน' } });

  const own = await expectStatus('/api/reports/courses', 200, { token: inst2.token });
  assert.equal(own.scope, 'own');
  assert.deepEqual(own.courses.map(c => c.id), [course.course.id]);
  assert.equal((await request('/api/reports/courses/course_cf_workers', { token: inst2.token })).status, 403);
  assert.equal((await expectStatus('/api/reports/learners', 200, { token: inst2.token })).total, 0);
  assert.equal((await expectStatus('/api/reports/revenue', 200, { token: inst2.token })).totals.revenue, 0);
  assert.equal((await expectStatus('/api/analytics/events', 200, { token: inst2.token })).total, 0);

  const mine = await expectStatus('/api/reports/courses', 200, { token: instructor.token });
  assert.ok(!mine.courses.some(c => c.id === course.course.id));
  const workers = mine.courses.find(c => c.id === 'course_cf_workers');
  assert.ok(workers.enrolled >= 3);
  assert.equal(workers.completion_rate, Math.round((workers.completed / workers.enrolled) * 1000) / 10);

  const detail = await expectStatus('/api/reports/courses/course_cf_workers', 200, { token: instructor.token });
  assert.equal(detail.enrolled, workers.enrolled);
  assert.ok(detail.lessons.length > 0);
  assert.ok(detail.learners.some(l => l.email === 'student3@netprime.com'));

  const learners = await expectStatus('/api/reports/learners?q=student3', 200, { token: coord.token });
  const s3 = learners.learners.find(l => l.email === 'student3@netprime.com');
  assert.ok(s3.courses >= 2 && s3.completed >= 1 && s3.seconds >= 60 && s3.last_activity);
});

test('CSV exports have a BOM and neutralise spreadsheet formulas', async () => {
  // A learner whose name starts with a formula character.
  const email = `formula-${Date.now()}@example.com`;
  const res = await post('/api/auth/register', null, { email, password: 'analytics-pass-123', name: '=HYPERLINK("http://evil","x")' });
  assert.equal(res.status, 201);
  await expectStatus('/api/courses/course_cf_workers', 200, { token: res.data.token });

  const events = await rawCsv(`/api/analytics/events?format=csv&user=${encodeURIComponent(email)}`, admin.token);
  assert.equal(events.status, 200);
  assert.match(events.type, /text\/csv/);
  assert.deepEqual([...events.bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(events.bytes);
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), text);
  assert.ok(!/(^|,)"=/m.test(text));

  for (const path of ['/api/reports/courses?format=csv', '/api/reports/learners?format=csv', '/api/reports/revenue?format=csv',
    '/api/reports/revenue?format=csv&section=course', '/api/reports/revenue?format=csv&section=refunds', '/api/reports/courses/course_cf_workers?format=csv&section=learners']) {
    const r = await rawCsv(path, coord.token);
    assert.equal(r.status, 200, path);
    assert.deepEqual([...r.bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], path);
  }
  assert.equal((await rawCsv('/api/reports/learners?format=csv', student3.token)).status, 403);
});

test('global search only returns what the caller may see', async () => {
  const asAdmin = await expectStatus('/api/search?q=student3', 200, { token: admin.token });
  assert.ok(asAdmin.results.some(r => r.kind === 'user' && r.subtitle === 'student3@netprime.com'));
  const byBuyer = await expectStatus('/api/search?q=analytics-', 200, { token: admin.token });
  assert.ok(byBuyer.results.some(r => r.kind === 'order'), 'admin finds orders by buyer email');

  const asStudent = await expectStatus('/api/search?q=student3', 200, { token: student3.token });
  assert.ok(!asStudent.results.some(r => r.kind === 'user' || r.kind === 'order'));
  const courses = await expectStatus('/api/search?q=Cisco', 200, { token: student3.token });
  assert.ok(courses.results.some(r => r.kind === 'course' && r.target.tab === 'dashboard'));
  assert.ok(!(await expectStatus('/api/search?q=คำสั่งซื้อ', 200, { token: student3.token })).results.some(r => r.target.tab === 'orders'));

  // Coordinators (no users.view) find orders and sessions but not user accounts.
  const asCoord = await expectStatus('/api/search?q=analytics-', 200, { token: coord.token });
  assert.ok(!asCoord.results.some(r => r.kind === 'user'));
  assert.ok(asCoord.results.some(r => r.kind === 'order'));
  assert.ok(!(await expectStatus('/api/search?q=analytics-', 200, { token: student3.token })).results.some(r => r.kind === 'order' || r.kind === 'user'));
  const menu = await expectStatus('/api/search?q=รายงาน', 200, { token: coord.token });
  assert.ok(menu.results.some(r => r.kind === 'page' && r.target.tab === 'reports'));

  // Drafts are hidden from learners but visible to their instructor.
  const draft = await expectStatus('/api/instructor/courses', 201, { method: 'POST', token: instructor.token, body: { title: 'Zebra Draft Search', description: 'ร่าง' } });
  assert.ok(!(await expectStatus('/api/search?q=Zebra%20Draft', 200, { token: student3.token })).results.some(r => r.id === draft.course.id));
  const asInst = await expectStatus('/api/search?q=Zebra%20Draft', 200, { token: instructor.token });
  assert.equal(asInst.results.find(r => r.id === draft.course.id)?.target.tab, 'instructor');

  assert.deepEqual((await expectStatus('/api/search?q=a', 200, { token: student3.token })).results, []);
  assert.equal((await request('/api/search?q=' + 'x'.repeat(101), { token: student3.token })).status, 400);
  assert.equal((await request('/api/search?q=%25%25')).status, 401);
  // LIKE wildcards are escaped.
  assert.ok(!(await expectStatus('/api/search?q=%25%25', 200, { token: admin.token })).results.some(r => r.kind === 'user'));
});

test('instructor learner report shows activity in their own courses only, not platform-wide presence', async () => {
  const email = `scoped-activity-${Date.now()}@example.invalid`;
  const created = await post('/api/admin/accounts', admin.token, { email, name: 'Scoped Activity', roles: ['student'], password: 'analytics-pass-123' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const learner = await login(email, 'analytics-pass-123');
  const order = await post('/api/student/orders', learner.token, { course_id: 'course_cf_workers', voucher_code: 'DEMO-FREE100' });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  await new Promise(resolve => setTimeout(resolve, 50));
  // Activity outside the instructor's courses (a plain heartbeat) comes after the course events.
  await expectStatus('/api/me/heartbeat', 200, { method: 'POST', token: learner.token, body: { seconds: 1 } });
  const asAdmin = (await expectStatus(`/api/reports/learners?q=${encodeURIComponent(email)}`, 200, { token: admin.token })).learners[0];
  const asInstructor = (await expectStatus(`/api/reports/learners?q=${encodeURIComponent(email)}`, 200, { token: instructor.token })).learners[0];
  assert.ok(asAdmin && asInstructor);
  assert.ok(asInstructor.last_activity, 'course events count');
  assert.ok(asInstructor.last_activity < asAdmin.last_activity, JSON.stringify({ asAdmin, asInstructor }));
});
