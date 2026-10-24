import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let learner;
before(async () => { learner = await login('student1@netprime.com', 'stud123'); });

test('certificate requires every lesson and at least 80% server-graded answers', async () => {
  const cert = '/api/student/courses/course_cf_workers/certificate';
  await expectStatus(cert, 400, { method: 'POST', token: learner.token });
  await expectStatus('/api/student/progress', 403, { method: 'PATCH', token: learner.token,
    body: { course_id: 'course_cf_workers', progress_percent: 100 } });
  await expectStatus('/api/student/lessons/lesson_cf_workers_intro/quiz-attempts', 403, {
    method: 'POST', token: learner.token, body: { score: 100, total_questions: 100 } });

  for (const lessonId of ['lesson_cf_workers_intro', 'lesson_cf_workers_hono']) {
    await expectStatus(`/api/student/lessons/${lessonId}/progress`, 200, { method: 'POST', token: learner.token,
      body: { resume_seconds: 30, completed: 1 } });
  }
  await expectStatus(cert, 400, { method: 'POST', token: learner.token });
  const correct = await expectStatus('/api/student/quizzes/quiz_workers_intro_1/submit', 200,
    { method: 'POST', token: learner.token, body: { answer_index: 0 } });
  assert.equal(correct.correct, true);
  assert.equal('correctOptionIndex' in correct, false);
  await expectStatus('/api/student/quizzes/quiz_workers_hono_1/submit', 200,
    { method: 'POST', token: learner.token, body: { answer_index: 1 } });
  await expectStatus(cert, 400, { method: 'POST', token: learner.token });
  await expectStatus('/api/student/quizzes/quiz_workers_hono_1/submit', 200,
    { method: 'POST', token: learner.token, body: { answer_index: 0 } });
  const issued = await expectStatus(cert, 201, { method: 'POST', token: learner.token });
  assert.ok(issued.certificate.certificate_code);
});

test('lesson files and video keys cannot cross course entitlements', async () => {
  await expectStatus('/api/student/lessons/lesson_aws_csa_vpc/progress', 403,
    { method: 'POST', token: learner.token, body: { resume_seconds: 10, completed: 1 } });
  await expectStatus('/api/student/lessons/lesson_cf_d1_schema/handout', 403, { token: learner.token });
  await expectStatus('/api/student/video?key=cf-stream-uid-d1-schema&token=' + encodeURIComponent(learner.token), 403);
  await expectStatus('/api/student/lessons/lesson_cf_workers_intro/handout', 404, { token: learner.token });
  await expectStatus('/api/lessons/lesson_cf_d1_schema/qa', 403, { token: learner.token });
  await expectStatus('/api/lessons/lesson_cf_d1_schema/qa', 403, { method: 'POST', token: learner.token,
    body: { content: 'Cross-course question' } });
  const own = await expectStatus('/api/lessons/lesson_cf_workers_intro/qa', 201, { method: 'POST', token: learner.token,
    body: { content: 'Own-course question' } });
  await expectStatus('/api/lessons/lesson_cf_workers_hono/qa', 404, { method: 'POST', token: learner.token,
    body: { content: 'Wrong parent lesson', parent_id: own.id } });
});

const PASSWORD = 'learning-test-pass-1';
async function account(admin, tag, roles) {
  const email = `${tag}-${Date.now()}@example.invalid`;
  const created = await request('/api/admin/accounts', { method: 'POST', token: admin.token,
    body: { email, name: `บัญชี ${tag}`, roles, password: PASSWORD } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const session = await login(email, PASSWORD);
  // DEMO-FREE100 opens the paid Workers course for this account.
  const order = await request('/api/student/orders', { method: 'POST', token: session.token,
    body: { course_id: 'course_cf_workers', voucher_code: 'DEMO-FREE100' } });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  return { ...session, id: created.data.user.id };
}

test('Q&A delete: an instructor who only studies the course cannot delete others\' posts', async () => {
  const admin = await login('admin@netprime.com', 'admin123');
  const teacher = await login('instructor@netprime.com', 'inst123');
  const both = await account(admin, 'inst-student', ['instructor', 'student']);
  const path = '/api/lessons/lesson_cf_workers_intro/qa';
  const post = await expectStatus(path, 201, { method: 'POST', token: learner.token, body: { content: 'Question by the learner' } });
  await expectStatus(`${path}/${post.id}`, 403, { method: 'DELETE', token: both.token });
  const own = await expectStatus(path, 201, { method: 'POST', token: both.token, body: { content: 'Own post' } });
  await expectStatus(`${path}/${own.id}`, 200, { method: 'DELETE', token: both.token });
  // The course's own instructor moderates it.
  await expectStatus(`${path}/${post.id}`, 200, { method: 'DELETE', token: teacher.token });
});

test('suspended accounts lose video links and optional sign-in', async () => {
  const admin = await login('admin@netprime.com', 'admin123');
  const session = await account(admin, 'suspend-video', ['student']);
  const video = '/api/student/video?key=cf-stream-uid-workers-intro&token=' + encodeURIComponent(session.token);
  // Entitled: passes the access check (the local bucket has no video file).
  await expectStatus(video, 404);
  const listed = await expectStatus('/api/courses', 200, { token: session.token });
  assert.equal(listed.find(c => c.id === 'course_cf_workers').progress_percent, 0);

  await expectStatus(`/api/admin/accounts/${session.id}`, 200, { method: 'PATCH', token: admin.token, body: { status: 'suspended' } });
  await expectStatus(video, 401);
  const anonymous = await expectStatus('/api/courses', 200, { token: session.token });
  assert.equal(anonymous.find(c => c.id === 'course_cf_workers').progress_percent, null);
});
