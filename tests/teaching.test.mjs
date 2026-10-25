import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { dangerCode, expectStatus, login, request } from './helpers.mjs';

let admin, coord, instructor, other, student;
const base = process.env.NETPRIME_TEST_BASE;
const post = (path, token, body) => request(path, { method: 'POST', token, body });

/** Raw PUT, because helpers.request always sends JSON. */
async function putRaw(path, token, body, contentType) {
  const response = await fetch(`${base}/api${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function newCourse(token, title, price = 0) {
  const created = await expectStatus('/api/instructor/courses', 201, { method: 'POST', token, body: { title, description: 'Teaching suite fixture', price } });
  assert.equal(created.course.status, 'draft');
  return created.course.id;
}

before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  coord = await login('coord@netprime.com', 'coord123');
  instructor = await login('instructor@netprime.com', 'inst123');
  student = await login('student3@netprime.com', 'stud123');
  const created = await post('/api/admin/accounts', admin.token, {
    email: 'second-instructor@example.invalid', name: 'ผู้สอนคนที่สอง', password: 'second-instructor-1', roles: ['instructor']
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  other = await login('second-instructor@example.invalid', 'second-instructor-1');
});

test('direct uploads need a server-issued reservation for the same user, type and size', async () => {
  // No reservation (also a key outside the user's prefix)
  assert.equal((await putRaw('/instructor/upload/direct?key=handouts/forged.pdf', instructor.token, 'x', 'application/pdf')).status, 403);

  const ticket = await expectStatus('/api/instructor/upload/presign', 200, { method: 'POST', token: instructor.token,
    body: { filename: 'notes.pdf', type: 'handout', size: 16, mimeType: 'application/pdf' } });
  assert.ok(ticket.key.startsWith(`uploads/${instructor.user.id}/handouts/`), ticket.key);

  const path = `/instructor/upload/direct?key=${encodeURIComponent(ticket.key)}`;
  assert.equal((await putRaw(path, other.token, '%PDF-1.4 tiny', 'application/pdf')).status, 403, 'other user cannot use the key');
  assert.equal((await putRaw(path, instructor.token, '%PDF-1.4 tiny', 'text/html')).status, 400, 'content type must match');
  assert.equal((await putRaw(path, instructor.token, '%PDF-1.4 this body is too large', 'application/pdf')).status, 413, 'oversize rejected');
  assert.equal((await putRaw(path, instructor.token, '%PDF-1.4 tiny', 'application/pdf')).status, 200);
  assert.equal((await putRaw(path, instructor.token, '%PDF-1.4 tiny', 'application/pdf')).status, 403, 'reservation is single use');

  // Videos above the Worker limit must go through Stream; a fake extension is not a video
  await expectStatus('/api/instructor/upload/presign', 400, { method: 'POST', token: instructor.token,
    body: { filename: 'big.mp4', type: 'video', size: 101 * 1024 * 1024, mimeType: 'video/mp4' } });
  await expectStatus('/api/instructor/upload/presign', 400, { method: 'POST', token: instructor.token,
    body: { filename: 'evil.html', type: 'video', size: 10, mimeType: 'text/html' } });
  // Stream credentials are not configured locally
  await expectStatus('/api/instructor/stream/direct-upload', 503, { method: 'POST', token: instructor.token, body: { size: 500 * 1024 * 1024 } });

  // Another instructor cannot attach this file (or another course's video) to their own lesson
  const otherCourse = await newCourse(other.token, 'Other instructor course');
  await expectStatus('/api/instructor/lessons', 403, { method: 'POST', token: other.token,
    body: { course_id: otherCourse, title: 'Stolen handout', video_stream_uid: 'fresh-uid-1', handout_r2_key: ticket.key, sort_order: 1 } });
  await expectStatus('/api/instructor/lessons', 403, { method: 'POST', token: other.token,
    body: { course_id: otherCourse, title: 'Stolen video', video_stream_uid: 'cf-stream-uid-d1-schema', sort_order: 1 } });
  await expectStatus('/api/instructor/lessons', 201, { method: 'POST', token: instructor.token,
    body: { course_id: 'course_cf_workers', title: 'Own handout', video_stream_uid: 'fresh-uid-2', handout_r2_key: ticket.key, sort_order: 99 } });
});

test('vouchers belong to their creator and respect max_uses', async () => {
  await expectStatus('/api/instructor/vouchers', 400, { method: 'POST', token: instructor.token,
    body: { code: 'SITEWIDE-INST', discount_type: 'percent', discount_value: 10 } });
  await expectStatus('/api/instructor/vouchers', 403, { method: 'POST', token: other.token,
    body: { code: 'NOT-MY-COURSE', discount_type: 'percent', discount_value: 10, course_id: 'course_cf_workers' } });
  await expectStatus('/api/instructor/vouchers', 400, { method: 'POST', token: instructor.token,
    body: { code: 'BAD-MAX', discount_type: 'percent', discount_value: 10, course_id: 'course_cf_workers', max_uses: 0 } });

  const own = await expectStatus('/api/instructor/vouchers', 201, { method: 'POST', token: instructor.token,
    body: { code: 'teach-once', discount_type: 'fixed', discount_value: 100, course_id: 'course_cf_workers', max_uses: 1 } });
  assert.equal(own.voucher.created_by, instructor.user.id);
  assert.equal(own.voucher.max_uses, 1);
  const site = await expectStatus('/api/instructor/vouchers', 201, { method: 'POST', token: admin.token,
    body: { code: 'SITE-TEACH', discount_type: 'percent', discount_value: 5 } });

  const mine = await expectStatus('/api/instructor/vouchers', 200, { token: instructor.token });
  assert.ok(mine.some(v => v.id === own.voucher.id && v.used_count === 0 && v.max_uses === 1));
  assert.ok(mine.every(v => v.created_by === instructor.user.id));
  assert.deepEqual(await expectStatus('/api/instructor/vouchers', 200, { token: other.token }), []);
  const all = await expectStatus('/api/instructor/vouchers', 200, { token: admin.token });
  assert.ok(all.some(v => v.id === own.voucher.id) && all.some(v => v.id === site.voucher.id));

  await expectStatus(`/api/instructor/vouchers/${own.voucher.id}`, 404, { method: 'DELETE', token: other.token });
  await expectStatus(`/api/instructor/vouchers/${site.voucher.id}`, 404, { method: 'DELETE', token: instructor.token });
  await expectStatus(`/api/instructor/vouchers/${own.voucher.id}`, 200, { method: 'DELETE', token: instructor.token });
  await expectStatus(`/api/instructor/vouchers/${site.voucher.id}`, 200, { method: 'DELETE', token: admin.token });
});

test('student groups are private to the instructor who made them', async () => {
  const mine = await expectStatus('/api/instructor/groups', 201, { method: 'POST', token: instructor.token, body: { name: 'กลุ่มของผู้สอนหลัก' } });
  const theirs = await expectStatus('/api/instructor/groups', 201, { method: 'POST', token: other.token, body: { name: 'กลุ่มของผู้สอนคนที่สอง' } });
  const gid = mine.group.id;

  const listed = await expectStatus('/api/instructor/groups', 200, { token: other.token });
  assert.deepEqual(listed.map(g => g.id), [theirs.group.id]);
  assert.ok((await expectStatus('/api/instructor/groups', 200, { token: admin.token })).some(g => g.id === gid));

  await expectStatus(`/api/instructor/groups/${gid}/members`, 201, { method: 'POST', token: instructor.token, body: { user_id: student.user.id } });
  await expectStatus(`/api/instructor/groups/${gid}/members`, 404, { token: other.token });
  await expectStatus(`/api/instructor/groups/${gid}/members`, 404, { method: 'POST', token: other.token, body: { user_id: student.user.id } });
  await expectStatus(`/api/instructor/groups/${gid}/members/${student.user.id}`, 404, { method: 'DELETE', token: other.token });
  await expectStatus(`/api/instructor/groups/${gid}`, 404, { method: 'DELETE', token: other.token });

  // Assigning a course to someone else's group is refused too
  const otherCourse = await newCourse(other.token, 'Group assign course');
  await expectStatus(`/api/admin/courses/${otherCourse}/approve`, 200, { method: 'POST', token: admin.token });
  await expectStatus(`/api/instructor/courses/${otherCourse}/assign`, 404, { method: 'POST', token: other.token,
    body: { target_type: 'group', target_id: gid } });

  assert.equal((await expectStatus(`/api/instructor/groups/${gid}/members`, 200, { token: instructor.token })).length, 1);
  await expectStatus(`/api/instructor/groups/${gid}`, 200, { method: 'DELETE', token: instructor.token });
});

test('courses go draft → review → published and only published ones are public', async () => {
  const courseId = await newCourse(instructor.token, 'Workflow fixture course');
  const inCatalog = async (token) => (await expectStatus('/api/courses', 200, token ? { token } : {})).some(c => c.id === courseId);

  assert.equal(await inCatalog(), false);
  assert.equal(await inCatalog(student.token), false);
  await expectStatus(`/api/courses/${courseId}`, 404, { token: student.token });
  await expectStatus(`/api/courses/${courseId}`, 200, { token: instructor.token });
  await expectStatus(`/api/courses/${courseId}/enroll`, 403, { method: 'POST', token: student.token });
  await expectStatus(`/api/instructor/courses/${courseId}/assign`, 403, { method: 'POST', token: instructor.token,
    body: { target_type: 'student', target_id: student.user.id } });

  // Submitting needs a lesson; others cannot submit
  await expectStatus(`/api/instructor/courses/${courseId}/submit`, 400, { method: 'POST', token: instructor.token });
  await expectStatus('/api/instructor/lessons', 201, { method: 'POST', token: instructor.token,
    body: { course_id: courseId, title: 'บทที่ 1', video_stream_uid: 'workflow-uid-1', sort_order: 1 } });
  await expectStatus(`/api/instructor/courses/${courseId}/submit`, 403, { method: 'POST', token: other.token });
  const submitted = await expectStatus(`/api/instructor/courses/${courseId}/submit`, 200, { method: 'POST', token: instructor.token });
  assert.equal(submitted.status, 'review');
  await expectStatus(`/api/instructor/courses/${courseId}/submit`, 409, { method: 'POST', token: instructor.token });
  const adminInbox = await expectStatus('/api/notifications', 200, { token: admin.token });
  assert.ok(JSON.stringify(adminInbox).includes('Workflow fixture course'), 'approvers are notified');

  // Coordinators lack courses.approve by default; instructors cannot approve their own course
  await expectStatus('/api/admin/courses', 403, { token: coord.token });
  await expectStatus(`/api/admin/courses/${courseId}/approve`, 403, { method: 'POST', token: coord.token });
  await expectStatus(`/api/admin/courses/${courseId}/approve`, 403, { method: 'POST', token: instructor.token });

  const queue = await expectStatus('/api/admin/courses?status=review', 200, { token: admin.token });
  assert.ok(queue.courses.some(c => c.id === courseId && c.instructor_name));
  assert.ok(queue.courses.every(c => c.status === 'review'));
  const everything = await expectStatus('/api/admin/courses', 200, { token: admin.token });
  assert.equal(everything.courses[0].status, 'review', 'review queue comes first');
  await expectStatus(`/api/courses/${courseId}`, 200, { token: admin.token });

  // Send back with a note → draft, note visible to the instructor
  await expectStatus(`/api/admin/courses/${courseId}/send-back`, 400, { method: 'POST', token: admin.token, body: {} });
  await expectStatus(`/api/admin/courses/${courseId}/send-back`, 200, { method: 'POST', token: admin.token, body: { note: 'เพิ่มคำอธิบายบทเรียน' } });
  const analytics = await expectStatus('/api/instructor/analytics', 200, { token: instructor.token });
  const mine = analytics.courses.find(c => c.id === courseId);
  assert.equal(mine.status, 'draft');
  assert.equal(mine.review_note, 'เพิ่มคำอธิบายบทเรียน');
  const inbox = await expectStatus('/api/notifications', 200, { token: instructor.token });
  assert.ok(JSON.stringify(inbox).includes('เพิ่มคำอธิบายบทเรียน'), 'instructor is notified');

  // Resubmit and approve → public and open for enrollment
  await expectStatus(`/api/instructor/courses/${courseId}/submit`, 200, { method: 'POST', token: instructor.token });
  await expectStatus(`/api/admin/courses/${courseId}/approve`, 200, { method: 'POST', token: admin.token });
  assert.equal(await inCatalog(), true);
  await expectStatus(`/api/courses/${courseId}/enroll`, 201, { method: 'POST', token: student.token });

  // Archive: leaves the catalog, but the enrolled learner keeps the course
  await expectStatus(`/api/admin/courses/${courseId}/archive`, 200, { method: 'POST', token: admin.token });
  assert.equal(await inCatalog(), false);
  assert.equal(await inCatalog(student.token), true);
  await expectStatus(`/api/courses/${courseId}`, 200, { token: student.token });
  const learner = await login('student1@netprime.com', 'stud123');
  await expectStatus(`/api/courses/${courseId}`, 404, { token: learner.token });
  await expectStatus(`/api/courses/${courseId}/enroll`, 403, { method: 'POST', token: learner.token });
  await expectStatus(`/api/admin/courses/${courseId}/archive`, 409, { method: 'POST', token: admin.token });
});

test('seeded demo courses are published and stream tokens use the configured key', async () => {
  const catalog = await expectStatus('/api/courses', 200);
  assert.ok(catalog.some(c => c.id === 'course_cf_workers'));
  const video = await expectStatus('/api/lessons/lesson_cf_workers_intro/stream-token', 200, { token: instructor.token });
  assert.equal(video.isMock, true, 'local wrangler config uses a mock Stream key');
});

test('instructors see only their own students and assign organizations only to courses they sponsor', async () => {
  const emails = (list) => list.map(s => s.email);
  assert.ok(emails(await expectStatus('/api/instructor/students', 200, { token: admin.token })).includes('student1@netprime.com'));
  assert.ok(emails(await expectStatus('/api/instructor/students', 200, { token: instructor.token })).includes('student1@netprime.com'),
    'enrolled in the instructor\'s course');
  const othersList = await expectStatus('/api/instructor/students', 200, { token: other.token });
  assert.ok(!emails(othersList).includes('student1@netprime.com'), 'not enrolled with the second instructor');
  // Exact email lookup finds one student to assign, without listing everyone
  const found = await expectStatus('/api/instructor/students?email=Student1@netprime.com', 200, { token: other.token });
  assert.deepEqual(emails(found), ['student1@netprime.com']);
  assert.deepEqual(await expectStatus('/api/instructor/students?email=nobody@example.invalid', 200, { token: other.token }), []);
  assert.deepEqual(await expectStatus('/api/instructor/students?email=instructor@netprime.com', 200, { token: other.token }), []);

  // Organizations: only those sponsoring one of the instructor's courses, without tax IDs
  const partners = await expectStatus('/api/business/partners', 200, { token: instructor.token });
  assert.ok(partners.some(p => p.id === 'partner_acme'));
  assert.ok(!partners.some(p => p.id === 'partner_globex'));
  assert.ok(partners.every(p => p.tax_id === undefined));
  assert.deepEqual(await expectStatus('/api/business/partners', 200, { token: other.token }), []);

  const otherCourse = await newCourse(other.token, 'Partner assign course');
  await expectStatus(`/api/admin/courses/${otherCourse}/approve`, 200, { method: 'POST', token: admin.token });
  await expectStatus(`/api/instructor/courses/${otherCourse}/assign`, 403, { method: 'POST', token: other.token,
    body: { target_type: 'partner', target_id: 'partner_acme' } });
  await expectStatus('/api/instructor/courses/course_cf_workers/assign', 403, { method: 'POST', token: instructor.token,
    body: { target_type: 'partner', target_id: 'partner_globex' } });
  const sponsored = await expectStatus('/api/instructor/courses/course_cf_workers/assign', 200, { method: 'POST', token: instructor.token,
    body: { target_type: 'partner', target_id: 'partner_acme' } });
  assert.ok(sponsored.enrolledCount >= 1);
});

// ==========================================
// Dangerous deletes: emailed confirmation codes (utils/dangerConfirm.ts)
// ==========================================

const addLesson = async (token, courseId, title, order = 1) => (await expectStatus('/api/instructor/lessons', 201, { method: 'POST', token,
  body: { course_id: courseId, title, video_stream_uid: `danger-${order}-${Date.now()}`, sort_order: order } })).lesson.id;
const del = (path, token, code, headers) => request(path, { method: 'DELETE', token, headers, body: code === undefined ? undefined : { confirmation_code: code } });

test('course delete always needs an emailed code bound to the course and the requester', async () => {
  const title = `Danger draft ${Date.now()}`;
  const courseId = await newCourse(instructor.token, title);
  const keepLesson = await addLesson(instructor.token, courseId, 'บทที่เก็บไว้', 1);
  // Low-risk: a lesson of a course without learners is deleted with the simple confirm.
  const extra = await addLesson(instructor.token, courseId, 'บทที่ลบ', 2);
  assert.equal((await del(`/api/instructor/lessons/${extra}`, instructor.token)).status, 200);
  assert.ok(keepLesson);

  const missing = await del(`/api/instructor/courses/${courseId}`, instructor.token);
  assert.equal(missing.status, 428);
  assert.equal(missing.data.code, 'confirmation_required');

  const preview = await expectStatus(`/api/security/delete-preview?action=course.delete&target_id=${courseId}`, 200, { token: instructor.token });
  assert.equal(preview.required, true);
  assert.equal(preview.confirm_text, title);
  assert.equal(preview.default_approver, 'owner');
  assert.deepEqual(preview.approvers.map(a => a.kind), ['owner', 'admin']);
  assert.ok(!JSON.stringify(preview).includes('instructor@netprime.com'), 'only a masked hint');

  // Someone who may not delete the course cannot trigger emails either.
  await expectStatus(`/api/security/delete-preview?action=course.delete&target_id=${courseId}`, 403, { token: other.token });
  await expectStatus('/api/security/delete-codes', 403, { method: 'POST', token: other.token, body: { action: 'course.delete', target_id: courseId } });
  await expectStatus(`/api/security/delete-preview?action=course.delete&target_id=${courseId}`, 403, { token: coord.token });
  await expectStatus('/api/security/delete-codes', 400, { method: 'POST', token: instructor.token, body: { action: 'nope', target_id: courseId } });

  // Owner path: code to the owner's own (masked) address; 5 wrong tries invalidate it.
  const first = await dangerCode(instructor.token, 'course.delete', courseId);
  assert.equal(first.approver, 'owner');
  assert.equal(first.sent_to, 'in***@netprime.com');
  assert.match(first.debug_code, /^\d{6}$/);
  const wrong = first.debug_code === '000000' ? '111111' : '000000';
  for (let i = 1; i <= 5; i++) {
    const res = await del(`/api/instructor/courses/${courseId}`, instructor.token, wrong);
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'confirmation_invalid');
    assert.equal(res.data.attempts_left, 5 - i);
  }
  assert.equal((await del(`/api/instructor/courses/${courseId}`, instructor.token, first.debug_code)).status, 403, 'invalidated after 5 wrong tries');

  // A new request replaces the previous code.
  const older = await dangerCode(instructor.token, 'course.delete', courseId);
  const code = (await dangerCode(instructor.token, 'course.delete', courseId)).debug_code;
  if (older.debug_code !== code) assert.equal((await del(`/api/instructor/courses/${courseId}`, instructor.token, older.debug_code)).status, 403);

  // Bound to the target and the requesting user.
  const otherCourse = await newCourse(instructor.token, `Danger other ${Date.now()}`);
  assert.equal((await del(`/api/instructor/courses/${otherCourse}`, instructor.token, code)).status, 403, 'not valid for another course');
  assert.equal((await del(`/api/instructor/courses/${courseId}`, admin.token, code)).status, 403, 'not valid for another user');
  // Expired after 10 minutes (local test clock), also via the header.
  const later = new Date(Date.now() + 11 * 60 * 1000).toISOString();
  assert.equal((await del(`/api/instructor/courses/${courseId}`, instructor.token, undefined, { 'X-Test-Now': later, 'X-Confirmation-Code': code })).status, 403);

  const done = await del(`/api/instructor/courses/${courseId}`, instructor.token, code);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.archived, false);
  await expectStatus(`/api/courses/${courseId}`, 404, { token: instructor.token });

  const log = await expectStatus('/api/admin/site/audit', 200, { token: admin.token });
  const actions = JSON.stringify(log);
  for (const event of ['danger.code_requested', 'danger.code_failed', 'danger.code_verified']) assert.ok(actions.includes(event), event);
});

test('a course with learners is archived (not hard-deleted); its lessons need a code; codes work once', async () => {
  const courseId = await newCourse(instructor.token, `Danger live ${Date.now()}`);
  const lessonA = await addLesson(instructor.token, courseId, 'บทที่ 1', 1);
  const lessonB = await addLesson(instructor.token, courseId, 'บทที่ 2', 2);
  await expectStatus(`/api/instructor/courses/${courseId}/submit`, 200, { method: 'POST', token: instructor.token });
  await expectStatus(`/api/admin/courses/${courseId}/approve`, 200, { method: 'POST', token: admin.token });
  await expectStatus(`/api/courses/${courseId}/enroll`, 201, { method: 'POST', token: student.token });

  assert.equal((await del(`/api/instructor/lessons/${lessonB}`, instructor.token)).status, 428, 'learners → code required');
  const preview = await expectStatus(`/api/security/delete-preview?action=lesson.delete&target_id=${lessonB}`, 200, { token: instructor.token });
  assert.equal(preview.required, true);
  assert.ok(preview.counts.some(c => c.value === 1), 'shows the enrolled learner');
  const lessonCode = (await dangerCode(instructor.token, 'lesson.delete', lessonB)).debug_code;
  assert.equal((await del(`/api/instructor/lessons/${lessonB}`, instructor.token, lessonCode)).status, 200);
  assert.ok(lessonA);
  const section = (await expectStatus(`/api/instructor/courses/${courseId}/sections`, 201, { method: 'POST', token: instructor.token, body: { title: 'บทใหม่' } })).section;
  assert.equal((await del(`/api/instructor/sections/${section.id}`, instructor.token)).status, 428);
  const sectionCode = (await dangerCode(instructor.token, 'section.delete', section.id)).debug_code;
  assert.equal((await del(`/api/instructor/sections/${section.id}`, instructor.token, sectionCode)).status, 200);

  // Admin deleting someone else's course: code goes to the admin's own address.
  const issued = await dangerCode(admin.token, 'course.delete', courseId);
  assert.equal(issued.approver, 'admin');
  assert.equal(issued.sent_to, 'ad***@netprime.com');
  const archived = await del(`/api/instructor/courses/${courseId}`, admin.token, issued.debug_code);
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  assert.equal(archived.data.archived, true);
  await expectStatus(`/api/courses/${courseId}`, 200, { token: student.token });
  assert.equal((await del(`/api/instructor/courses/${courseId}`, admin.token, issued.debug_code)).status, 409, 'archived course with learners cannot be removed');

  // Re-published: the used code does not work a second time.
  await expectStatus(`/api/admin/courses/${courseId}/approve`, 200, { method: 'POST', token: admin.token });
  const reused = await del(`/api/instructor/courses/${courseId}`, admin.token, issued.debug_code);
  assert.equal(reused.status, 403);
  assert.equal(reused.data.code, 'confirmation_invalid');
});
