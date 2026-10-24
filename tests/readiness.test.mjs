// Acceptance gates for the next phase. These intentionally fail on unresolved defects;
// a passing smoke suite alone is NOT approval to release this demo application.
import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let student, instructor, partner, university;
before(async () => {
  student = await login('student3@netprime.com', 'stud123');
  instructor = await login('instructor@netprime.com', 'inst123');
  partner = await login('hr@netprime.com', 'partner123');
  university = await login('coordinator@mit.edu', 'univ123');
});

const rejected = response => assert.ok([400, 401, 403].includes(response.status), `Expected rejection, received HTTP ${response.status}`);

test('AUTH-01 login requires an explicit password', async () => {
  rejected(await request('/api/auth/login', { method: 'POST', body: { email: 'admin@netprime.com' } }));
});

test('AUTH-02 unknown email must not create an administrator during login', async () => {
  rejected(await request('/api/auth/login', { method: 'POST', body: { email: 'unknown-admin@example.invalid', password: 'incorrect-password' } }));
});

test('AUTH-03 public signup cannot choose the admin role', async () => {
  rejected(await request('/api/auth/register', { method: 'POST', body: { email: 'signup-admin@example.invalid', password: 'test-only-12345', name: 'Local Test', role: 'admin' } }));
});

test('AUTH-04 OAuth callback cannot impersonate an existing user from client profile data', async () => {
  rejected(await request('/api/auth/oauth/google/callback', { method: 'POST', body: { simulatedProfile: { email: 'admin@netprime.com', name: 'Local Test' } } }));
});

test('DATA-01 current demo OAuth onboarding uses valid partner columns', async () => {
  const response = await request('/api/auth/oauth/google/callback', { method: 'POST', body: { simulatedProfile: { email: 'new-student@example.invalid', name: 'Local Test' } } });
  // A secure implementation may disable this path with an explicit 4xx. It must not fail in SQL.
  assert.ok([200, 400, 401, 403].includes(response.status), `New-profile callback returned HTTP ${response.status}`);
  if (response.status === 200) assert.equal(response.data.user.role, 'student');
});

test('DATA-02 partner can create an outsource project using the actual schema', async () => {
  await expectStatus('/api/outsource/projects', 200, { method: 'POST', token: partner.token, body: {
    title: 'Local Test Project', description: 'Disposable test', scopeOfWork: 'Build a local demo',
    budgetType: 'fixed', budgetRange: '1000', minLevel: 1
  } });
});

test('PAY-01 enrollment in a paid course requires a staff-confirmed bank-transfer order', async () => {
  const response = await request('/api/courses/course_cisco_ccnp/enroll', { method: 'POST', token: student.token });
  assert.ok([400, 402, 403].includes(response.status), `Unpaid enrollment returned HTTP ${response.status}`);
  const order = await expectStatus('/api/student/orders', 201, { method: 'POST', token: student.token, body: { course_id: 'course_cisco_ccnp' } });
  assert.equal(order.order.status, 'pending');
  // The learner cannot confirm their own order, and a pending order grants nothing.
  rejected(await request(`/api/manage/orders/${order.order.id}/confirm`, { method: 'POST', token: student.token, body: { amount_received: 6965 } }));
  const details = await expectStatus('/api/courses/course_cisco_ccnp', 200, { token: student.token });
  assert.equal(details.enrollment, null, 'Pending order incorrectly granted course access');
});

test('PAY-02 card checkout and the provider webhook cannot activate enrollment', async () => {
  const courseId = 'course_cisco_sdwan';
  const session = await request('/api/student/checkout/session', { method: 'POST', token: student.token, body: { course_id: courseId } });
  assert.equal(session.status, 410, `Card checkout returned HTTP ${session.status}`);
  const webhook = await request('/api/payment/omise-webhook', { method: 'POST', body: {
    key: 'charge.complete', data: { id: 'chrg_unverified', status: 'successful', paid: true,
      amount: 661500, currency: 'THB', metadata: { payment_id: 'unverified-payment' } }
  } });
  assert.ok(webhook.status >= 400, `Webhook returned HTTP ${webhook.status}`);
  const details = await expectStatus(`/api/courses/${courseId}`, 200, { token: student.token });
  assert.equal(details.enrollment, null, 'Unverified webhook incorrectly granted course access');
});

test('LEARN-01 arbitrary client progress alone cannot award a certificate', async () => {
  const learner = await login('student1@netprime.com', 'stud123');
  await request('/api/student/progress', { method: 'PATCH', token: learner.token,
    body: { course_id: 'course_cf_workers', progress_percent: 100 } });
  rejected(await request('/api/student/courses/course_cf_workers/certificate', { method: 'POST', token: learner.token }));
});

test('ACCESS-01 partner cannot inspect candidates from another organization', async () => {
  const projects = await expectStatus('/api/outsource/projects', 200, { token: student.token });
  const target = projects.find(project => project.partner_id === 'partner_acme');
  assert.ok(target, 'Expected an Acme project fixture');
  const response = await request(`/api/outsource/projects/${target.id}/candidates`, { token: university.token });
  assert.ok([403, 404].includes(response.status), `Cross-organization candidate access returned HTTP ${response.status}`);
});

test('HTTP-01 upload preflight permits the PUT method used by the API', async () => {
  const response = await request('/api/instructor/upload/direct', { method: 'OPTIONS', headers: {
    Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PUT',
    'Access-Control-Request-Headers': 'authorization,content-type'
  } });
  assert.match(response.headers.get('access-control-allow-methods') || '', /\bPUT\b/);
});
