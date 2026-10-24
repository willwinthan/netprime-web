import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let admin, acme, mit;
before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  acme = await login('hr@netprime.com', 'partner123');
  mit = await login('coordinator@mit.edu', 'univ123');
});

const strong = 'partner-strong-123';
const usedSeats = async (partnerId) =>
  (await expectStatus(`/api/business/analytics?partner_id=${partnerId}`, 200, { token: admin.token })).usedSeats;
const addEmployee = (token, email, body = {}) => expectStatus('/api/corporate/roster', 201, { method: 'POST', token,
  body: { email, name: body.name || email.split('@')[0], password: strong, ...body } });
const enrollmentStatus = async (token, courseId) =>
  (await expectStatus(`/api/courses/${courseId}`, 200, { token })).enrollment?.status;

test('HR must use a 12-character password or an invite link', async () => {
  await expectStatus('/api/corporate/roster', 400, { method: 'POST', token: acme.token,
    body: { email: 'short-pass@example.invalid', name: 'Short', password: 'short-pass1' } });
  await expectStatus('/api/corporate/roster', 400, { method: 'POST', token: acme.token,
    body: { email: 'no-choice@example.invalid', name: 'No Choice' } });

  const invited = await expectStatus('/api/corporate/roster', 201, { method: 'POST', token: acme.token,
    body: { email: 'Invited.Staff@example.invalid', name: 'Invited Staff', invite: true } });
  assert.equal(invited.invited, true);
  assert.equal(invited.student.partner_id, 'partner_acme');
  const link = new URL(invited.debug_url);
  assert.equal(link.pathname, '/reset-password');
  assert.equal(link.searchParams.get('invite'), '1');
  await expectStatus('/api/auth/reset-password', 200, { method: 'POST',
    body: { token: link.searchParams.get('token'), password: 'invited-strong-123' } });
  const session = await login('invited.staff@example.invalid', 'invited-strong-123');
  assert.equal(session.user.role, 'student');
});

test('removing an employee returns the seat, suspends sponsored courses and keeps the account', async () => {
  const { student } = await addEmployee(acme.token, 'leaver@example.invalid', { name: 'Leaver' });
  const seatsBefore = await usedSeats('partner_acme');
  await expectStatus('/api/business/courses/assign', 201, { method: 'POST', token: acme.token,
    body: { student_id: student.id, course_id: 'course_cf_workers' } });
  // A course the organization does not sponsor, given to the learner personally.
  const personal = await request('/api/instructor/courses/course_nutanix_ncp/assign', { method: 'POST', token: admin.token,
    body: { target_type: 'student', target_id: student.id } });
  assert.ok([200, 201].includes(personal.status), JSON.stringify(personal.data));

  // Another organization's partner cannot touch Acme employees, and HR cannot remove a partner account.
  await expectStatus(`/api/business/employees/${student.id}/remove`, 404, { method: 'POST', token: mit.token });
  await expectStatus('/api/business/employees/usr_student_univ/remove', 404, { method: 'POST', token: acme.token });
  await expectStatus('/api/business/employees/usr_partner/remove', 400, { method: 'POST', token: admin.token });

  const removed = await expectStatus(`/api/business/employees/${student.id}/remove`, 200, { method: 'POST', token: acme.token });
  assert.equal(removed.suspended_enrollments, 1);
  assert.equal(await usedSeats('partner_acme'), seatsBefore - 1);
  await expectStatus(`/api/business/employees/${student.id}/remove`, 404, { method: 'POST', token: acme.token });

  const leaver = await login('leaver@example.invalid', strong);
  const me = await expectStatus('/api/auth/me', 200, { token: leaver.token });
  assert.ok(!me.user.partner_id && !me.user.corporate_id);
  assert.equal(await enrollmentStatus(leaver.token, 'course_cf_workers'), 'suspended');
  assert.equal(await enrollmentStatus(leaver.token, 'course_nutanix_ncp'), 'active');
  const roster = await expectStatus('/api/business/analytics', 200, { token: acme.token });
  assert.ok(!roster.roster.some(r => r.id === student.id));
});

test('admin manages organizations: university type, seat usage and no seats below allocated', async () => {
  await expectStatus('/api/admin/organizations', 403, { method: 'POST', token: acme.token,
    body: { company_name: 'Sneaky', partner_type: 'company', total_seats: 5 } });
  await expectStatus('/api/admin/organizations', 400, { method: 'POST', token: admin.token,
    body: { company_name: 'Bad Type', partner_type: 'school', total_seats: 5 } });
  const created = await expectStatus('/api/admin/organizations', 201, { method: 'POST', token: admin.token,
    body: { company_name: 'Kasetsart University', partner_type: 'university', total_seats: 2 } });
  const org = created.organization;
  assert.equal(org.partner_type, 'university');
  assert.equal(org.total_seats, 2);
  assert.equal(org.allocated_seats, 0);

  // Transfer two Acme employees in (one with a sponsored course); the third finds no seat.
  const first = (await addEmployee(acme.token, 'mover-1@example.invalid')).student;
  const second = (await addEmployee(acme.token, 'mover-2@example.invalid')).student;
  const third = (await addEmployee(acme.token, 'mover-3@example.invalid')).student;
  await expectStatus('/api/business/courses/assign', 201, { method: 'POST', token: acme.token,
    body: { student_id: first.id, course_id: 'course_cisco_ccna' } });
  const acmeBefore = await usedSeats('partner_acme');
  await expectStatus(`/api/admin/users/${first.id}/transfer`, 403, { method: 'POST', token: acme.token, body: { partner_id: org.id } });
  const moved = await expectStatus(`/api/admin/users/${first.id}/transfer`, 200, { method: 'POST', token: admin.token, body: { partner_id: org.id } });
  assert.equal(moved.suspended_enrollments, 1);
  await expectStatus(`/api/admin/users/${second.id}/transfer`, 200, { method: 'POST', token: admin.token, body: { partner_id: org.id } });
  await expectStatus(`/api/admin/users/${third.id}/transfer`, 409, { method: 'POST', token: admin.token, body: { partner_id: org.id } });
  await expectStatus(`/api/admin/users/${first.id}/transfer`, 400, { method: 'POST', token: admin.token, body: { partner_id: org.id } });
  assert.equal(await usedSeats('partner_acme'), acmeBefore - 2);
  assert.equal(await usedSeats(org.id), 2);
  const firstSession = await login('mover-1@example.invalid', strong);
  assert.equal(await enrollmentStatus(firstSession.token, 'course_cisco_ccna'), 'suspended');

  await expectStatus(`/api/admin/organizations/${org.id}`, 400, { method: 'PATCH', token: admin.token, body: { total_seats: 1 } });
  const edited = await expectStatus(`/api/admin/organizations/${org.id}`, 200, { method: 'PATCH', token: admin.token,
    body: { total_seats: 3, company_name: 'Kasetsart University (KU)', partner_type: 'company' } });
  assert.equal(edited.organization.total_seats, 3);
  assert.equal(edited.organization.partner_type, 'company');
  await expectStatus(`/api/admin/users/${third.id}/transfer`, 200, { method: 'POST', token: admin.token, body: { partner_id: org.id } });

  const list = await expectStatus('/api/admin/organizations', 200, { token: admin.token });
  const row = list.organizations.find(o => o.id === org.id);
  assert.equal(row.allocated_seats, 3);
  assert.equal(row.company_name, 'Kasetsart University (KU)');
});

test('HR export is an Excel-friendly CSV with neutralised formulas', async () => {
  const { student } = await addEmployee(acme.token, 'formula@example.invalid', { name: '=HYPERLINK("http://x.invalid","click")' });
  await expectStatus('/api/business/courses/assign', 201, { method: 'POST', token: acme.token,
    body: { student_id: student.id, course_id: 'course_cf_d1_r2' } });
  await expectStatus('/api/business/export.csv', 401);
  const response = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/business/export.csv`, {
    headers: { Authorization: `Bearer ${acme.token}` }, signal: AbortSignal.timeout(10000)
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.match(response.headers.get('content-disposition'), /attachment; filename="employees-partner_acme-/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes);
  const [header, ...lines] = text.split('\r\n');
  assert.equal(header, '"ชื่อ-นามสกุล","อีเมล","สถานะบัญชี","วันที่เพิ่มเข้าระบบ","เข้าสู่ระบบล่าสุด","คอร์ส","สถานะการเรียน","ความคืบหน้า (%)","วันที่เริ่มเรียน","วันที่เรียนจบ","สิทธิ์หมดอายุ"');
  const formulaLine = lines.find(line => line.includes('formula@example.invalid'));
  assert.ok(formulaLine.startsWith(`"'=HYPERLINK(""http://x.invalid"",""click"")"`), formulaLine);
  assert.ok(lines.some(line => line.includes('student1@netprime.com') && line.includes('"กำลังเรียน","50"')));
  assert.ok(!lines.some(line => line.includes('student_mit@mit.edu')), 'only own organization');
  // Admin exports any organization; MIT's partner only their own.
  const mitCsv = await request('/api/business/export.csv?partner_id=partner_acme', { token: mit.token });
  assert.equal(mitCsv.status, 200);
  assert.ok(!String(mitCsv.data).includes('student1@netprime.com'));
  assert.ok(String(mitCsv.data).includes('student_mit@mit.edu'));
});

test('a course the employee paid for personally is not the organization\'s, even when it also sponsors it', async () => {
  const { student } = await addEmployee(acme.token, 'self-payer@example.invalid', { name: 'Self Payer' });
  const session = await login('self-payer@example.invalid', strong);
  // Acme sponsors course_cf_d1_r2, but this learner buys it by bank transfer.
  const order = await request('/api/student/orders', { method: 'POST', token: session.token, body: { course_id: 'course_cf_d1_r2' } });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  await expectStatus(`/api/manage/orders/${order.data.order.id}/confirm`, 200, { method: 'POST', token: admin.token,
    body: { amount_received: order.data.order.amount } });
  assert.equal(await enrollmentStatus(session.token, 'course_cf_d1_r2'), 'active');
  await expectStatus('/api/business/courses/assign', 201, { method: 'POST', token: acme.token,
    body: { student_id: student.id, course_id: 'course_cf_workers' } });

  const csv = await request('/api/business/export.csv', { token: acme.token });
  assert.equal(csv.status, 200);
  const lines = String(csv.data).split('\r\n').filter(line => line.includes('self-payer@example.invalid'));
  assert.equal(lines.length, 1, 'only the sponsored course is listed');
  assert.ok(lines[0].includes('Cloudflare Workers') && !lines[0].includes('D1 SQLite'), lines[0]);

  const removed = await expectStatus(`/api/business/employees/${student.id}/remove`, 200, { method: 'POST', token: acme.token });
  assert.equal(removed.suspended_enrollments, 1);
  assert.equal(await enrollmentStatus(session.token, 'course_cf_workers'), 'suspended');
  assert.equal(await enrollmentStatus(session.token, 'course_cf_d1_r2'), 'active');
});

test('organization list: partners see only their own, only admins see tax IDs', async () => {
  const student = await login('student1@netprime.com', 'stud123');
  await expectStatus('/api/business/partners', 403, { token: student.token });
  const own = await expectStatus('/api/business/partners', 200, { token: acme.token });
  assert.deepEqual(own.map(p => p.id), ['partner_acme']);
  assert.equal(own[0].tax_id, undefined);
  const mitOwn = await expectStatus('/api/business/partners', 200, { token: mit.token });
  assert.deepEqual(mitOwn.map(p => p.id), ['partner_mit']);
  const all = await expectStatus('/api/business/partners', 200, { token: admin.token });
  assert.ok(all.length >= 4);
  assert.equal(all.find(p => p.id === 'partner_acme').tax_id, 'TX-99881122');
});

test('assigning a course to a whole organization never takes over a personal enrollment', async () => {
  const { student } = await addEmployee(acme.token, 'personal-first@example.invalid');
  const personal = await request('/api/instructor/courses/course_nutanix_ncp/assign', { method: 'POST', token: admin.token,
    body: { target_type: 'student', target_id: student.id } });
  assert.equal(personal.status, 200, JSON.stringify(personal.data));
  const org = await request('/api/instructor/courses/course_nutanix_ncp/assign', { method: 'POST', token: admin.token,
    body: { target_type: 'partner', target_id: 'partner_acme' } });
  assert.equal(org.status, 200, JSON.stringify(org.data));
  await expectStatus('/api/instructor/courses/course_nutanix_ncp/assign', 404, { method: 'POST', token: admin.token,
    body: { target_type: 'partner', target_id: 'partner_missing' } });

  const removed = await expectStatus(`/api/business/employees/${student.id}/remove`, 200, { method: 'POST', token: acme.token });
  assert.equal(removed.suspended_enrollments, 0);
  const session = await login('personal-first@example.invalid', strong);
  assert.equal(await enrollmentStatus(session.token, 'course_nutanix_ncp'), 'active');
});
