import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let student, secondStudent, instructor, partner, admin;
before(async () => {
  student = await login('student3@netprime.com', 'stud123');
  secondStudent = await login('student1@netprime.com', 'stud123');
  instructor = await login('instructor@netprime.com', 'inst123');
  partner = await login('hr@netprime.com', 'partner123');
  admin = await login('admin@netprime.com', 'admin123');
});

test('health and unknown routes', async () => {
  const health = await request('/');
  assert.equal(health.status, 200);
  assert.match(health.data, /Netprime/);
  await expectStatus('/api/does-not-exist', 404);
});

test('public catalog contains the seeded course and numeric prices', async () => {
  const courses = await expectStatus('/api/courses', 200);
  assert.ok(courses.some(course => course.id === 'course_cf_workers'));
  assert.ok(courses.every(course => typeof course.price === 'number'));
});

test('missing and invalid bearer tokens are rejected', async () => {
  await expectStatus('/api/auth/me', 401);
  await expectStatus('/api/auth/me', 401, { token: 'invalid-token' });
});

test('wrong password for an existing user is rejected', async () => {
  await expectStatus('/api/auth/login', 401, { method: 'POST', body: { email: 'student3@netprime.com', password: 'wrong-password' } });
});

test('authenticated profile and role restrictions', async () => {
  const profile = await expectStatus('/api/auth/me', 200, { token: student.token });
  assert.equal(profile.user.id, 'usr_student3');
  await expectStatus('/api/admin/users', 403, { token: student.token });
  await expectStatus('/api/instructor/analytics', 403, { token: partner.token });
});

for (const [name, endpoint, auth] of [
  ['admin', '/api/admin/analytics', () => admin],
  ['instructor', '/api/instructor/analytics', () => instructor],
  ['partner', '/api/business/analytics', () => partner]
]) {
  test(`${name} analytics loads from the real local schema`, async () => {
    const data = await expectStatus(endpoint, 200, { token: auth().token });
    assert.equal(typeof data, 'object');
    assert.ok(Object.keys(data).length > 0);
  });
}

test('course details, enrolled quizzes and duplicate enrollment', async () => {
  const data = await expectStatus('/api/courses/course_cf_workers', 200, { token: student.token });
  assert.ok(data.lessons.length > 0);
  assert.equal(data.enrollment.progress_percent, 100);
  await expectStatus('/api/student/courses/course_cf_workers/quizzes', 200, { token: student.token });
  await expectStatus('/api/courses/course_cf_workers/enroll', 400, { method: 'POST', token: student.token });
});

test('course progress cannot be set directly by a client', async () => {
  await expectStatus('/api/student/progress', 403, { method: 'PATCH', token: student.token, body: { course_id: 'course_cf_workers', progress_percent: 100 } });
});

test('notes persist and remain private to the owner', async () => {
  const note = await expectStatus('/api/student/notes', 201, {
    method: 'POST', token: student.token,
    body: { course_id: 'course_cf_workers', lesson_id: 'lesson_cf_workers_intro', timestamp_seconds: 12, content: 'Local smoke note' }
  });
  const own = await expectStatus('/api/student/notes?course_id=course_cf_workers', 200, { token: student.token });
  assert.ok(own.some(row => row.id === note.id));
  const other = await expectStatus('/api/student/notes?course_id=course_cf_workers', 200, { token: secondStudent.token });
  assert.ok(!other.some(row => row.id === note.id));
  await expectStatus(`/api/student/notes/${note.id}`, 200, { method: 'DELETE', token: student.token });
});

test('certificate issuance is repeatable without duplicates and publicly verifiable', async () => {
  for (const lessonId of ['lesson_cf_workers_intro', 'lesson_cf_workers_hono']) {
    await expectStatus(`/api/student/lessons/${lessonId}/progress`, 200, { method: 'POST', token: student.token,
      body: { resume_seconds: 60, completed: 1 } });
  }
  for (const quizId of ['quiz_workers_intro_1', 'quiz_workers_hono_1']) {
    await expectStatus(`/api/student/quizzes/${quizId}/submit`, 200, { method: 'POST', token: student.token,
      body: { answer_index: 0 } });
  }
  const path = '/api/student/courses/course_cf_workers/certificate';
  const issued = await expectStatus(path, 201, { method: 'POST', token: student.token });
  const again = await expectStatus(path, 200, { method: 'POST', token: student.token });
  assert.equal(issued.certificate.id, again.certificate.id);
  const verified = await expectStatus(`/api/certificates/verify/${issued.certificate.certificate_code}`, 200);
  assert.equal(verified.verified, true);
});

test('internship, projects, gamification and notification lists load', async () => {
  for (const path of ['/api/internships/openings', '/api/outsource/projects', '/api/gamification/profile', '/api/notifications']) {
    await expectStatus(path, 200, { token: student.token });
  }
});

test('AI returns an explicit local mock without calling Workers AI', async () => {
  const data = await expectStatus('/api/ai/chat', 200, { method: 'POST', token: student.token, body: { message: 'Local test', history: [] } });
  assert.match(data.reply, /โหมดจำลองในเครื่อง/);
});

test('logout revokes the bearer token on protected routes', async () => {
  await expectStatus('/api/auth/logout', 200, { method: 'POST', token: student.token });
  await expectStatus('/api/auth/me', 401, { token: student.token });
});
