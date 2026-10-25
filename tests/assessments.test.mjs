import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

const COURSE = 'course_cf_workers';
const LESSON = 'lesson_cf_workers_intro';
const PASSWORD = 'assessments-test-pass-1';
let admin, teacher, otherTeacher, learner, classmate;

async function account(tag, roles, { enroll = true } = {}) {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`;
  const created = await request('/api/admin/accounts', { method: 'POST', token: admin.token,
    body: { email, name: `บัญชี ${tag}`, roles, password: PASSWORD } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const session = await login(email, PASSWORD);
  if (enroll) {
    // DEMO-FREE100 opens the paid Workers course for this account.
    const order = await request('/api/student/orders', { method: 'POST', token: session.token,
      body: { course_id: COURSE, voucher_code: 'DEMO-FREE100' } });
    assert.equal(order.status, 201, JSON.stringify(order.data));
  }
  return { ...session, id: created.data.user.id };
}

async function upload(path, token, filename, bytes, type = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  const response = await fetch(`${process.env.NETPRIME_TEST_BASE}${path}`, {
    method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  return { status: response.status, data: await response.json().catch(() => null) };
}

const later = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  teacher = await login('instructor@netprime.com', 'inst123');
  learner = await login('student1@netprime.com', 'stud123');
  classmate = await login('student3@netprime.com', 'stud123');
  otherTeacher = await account('other-inst', ['instructor'], { enroll: false });
});

/** One question of every objective type plus the payload that answers it fully correctly. */
const OBJECTIVE = [
  { type: 'single', prompt: 'Workers รันที่ไหน', options: ['Edge', 'Mainframe', 'Desktop'], correct: [0], tags: ['net'], difficulty: 'easy' },
  { type: 'multiple', prompt: 'ข้อใดเป็น binding ของ Workers', options: ['D1', 'KV', 'FTP'], correct: [0, 1], tags: ['net'] },
  { type: 'true_false', prompt: 'Hono เป็นเว็บเฟรมเวิร์ก', correct: ['true'], tags: ['net'] },
  { type: 'short', prompt: 'ฐานข้อมูล SQL ของ Cloudflare ชื่ออะไร', correct: ['D1', 'Cloudflare D1'], tags: ['net'] },
  { type: 'fill_blank', prompt: 'คำสั่ง ___ deploy และ ___ dev', correct: [['wrangler'], ['wrangler']], points: 2 },
  { type: 'matching', prompt: 'จับคู่บริการ', options: ['KV::key-value', 'R2::object storage', 'D1::SQL'], points: 3 },
  { type: 'ordering', prompt: 'เรียงขั้นตอน', options: ['เขียนโค้ด', 'ทดสอบ', 'deploy'] }
];
const correctResponse = (q) => ({
  single: 0, multiple: [0, 1], true_false: 0, short: '  cloudflare   d1 ', fill_blank: ['Wrangler', 'wrangler'],
  matching: [0, 1, 2], ordering: [0, 1, 2]
})[q.type];

const TRUE_FALSE = ['จริง', 'เท็จ'];
/**
 * Option ids are random per attempt (they must not reveal the stored index, which is the answer key for
 * ordering/matching), so tests translate an answer written as authoring indexes into the attempt's ids by text.
 */
function toPublic(q, def, r) {
  if (r === null || r === undefined) return r;
  const texts = def.type === 'true_false' ? TRUE_FALSE : def.type === 'matching' ? def.options.map(p => p.split('::')[1]) : def.options;
  const list = def.type === 'matching' ? q.right : q.options;
  const id = (i) => {
    const option = list.find(o => o.text === texts[i]);
    assert.ok(option, `option ${texts[i]} shown`);
    return option.id;
  };
  switch (def.type) {
    case 'single': case 'true_false': return id(r);
    case 'multiple': case 'ordering': case 'matching': return r.map(id);
    default: return r;
  }
}
const idMap = (q) => JSON.stringify([...(q.options ?? []), ...(q.right ?? [])].map(o => [o.id, o.text]).sort());

async function createBank(token = teacher.token, questions = OBJECTIVE) {
  const res = await expectStatus(`/api/instructor/courses/${COURSE}/questions/bulk`, 201, { method: 'POST', token, body: { questions } });
  return res.ids;
}

async function createExam(body) {
  const res = await expectStatus(`/api/instructor/courses/${COURSE}/exams`, 201, { method: 'POST', token: teacher.token,
    body: { status: 'published', show_answers: 'after_submit', ...body } });
  return res.exam;
}

test('question bank: CRUD, bulk contract, CSV round trip and ownership', async () => {
  const bulk = await expectStatus(`/api/instructor/courses/${COURSE}/questions/bulk`, 201, { method: 'POST', token: teacher.token, body: {
    questions: [
      { type: 'single', prompt: 'AI single', options: ['a', 'b'], correct: [1], explanation: 'เพราะ b', points: 2, tags: ['AI', 'gen'] },
      { type: 'multiple', prompt: 'AI multiple', options: ['a', 'b', 'c'], correct: ['a', 'c'] },
      { type: 'true_false', prompt: 'AI tf', correct: [1] },
      { type: 'short', prompt: 'AI short', correct: ['hono'] },
      { type: 'essay', prompt: 'AI essay' }
    ] } });
  assert.equal(bulk.created, 5);
  assert.equal(bulk.ids.length, 5);
  assert.deepEqual(Object.keys(bulk).sort(), ['created', 'ids']);

  // All-or-nothing: the invalid item is reported by index and nothing is created.
  const before = await expectStatus(`/api/instructor/courses/${COURSE}/questions`, 200, { token: teacher.token });
  const bad = await request(`/api/instructor/courses/${COURSE}/questions/bulk`, { method: 'POST', token: teacher.token,
    body: { questions: [{ type: 'single', prompt: 'ok', options: ['a', 'b'], correct: [0] }, { type: 'single', prompt: 'no answer', options: ['a', 'b'] }] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.index, 1);
  const after = await expectStatus(`/api/instructor/courses/${COURSE}/questions`, 200, { token: teacher.token });
  assert.equal(after.total, before.total);

  const tagged = await expectStatus(`/api/instructor/courses/${COURSE}/questions?tag=ai`, 200, { token: teacher.token });
  assert.ok(tagged.questions.some(q => q.id === bulk.ids[0] && q.tags.includes('gen')));
  const single = tagged.questions.find(q => q.id === bulk.ids[0]);
  assert.deepEqual(single.correct, [1]);

  const created = await expectStatus(`/api/instructor/courses/${COURSE}/questions`, 201, { method: 'POST', token: teacher.token,
    body: { type: 'fill_blank', prompt: 'Edge ___ runtime', correct: ['worker/workers'], difficulty: 'hard' } });
  assert.deepEqual(created.question.correct, [['worker', 'workers']]);
  const edited = await expectStatus(`/api/instructor/questions/${created.question.id}`, 200, { method: 'PATCH', token: teacher.token,
    body: { prompt: 'Edge ___ and ___', correct: ['a', 'b'] } });
  assert.equal(edited.question.difficulty, 'hard');
  await expectStatus(`/api/instructor/questions/${created.question.id}`, 400, { method: 'PATCH', token: teacher.token, body: { prompt: 'no blanks now' } });

  // Ownership: another instructor and learners cannot read or change this course's bank.
  await expectStatus(`/api/instructor/courses/${COURSE}/questions`, 403, { token: otherTeacher.token });
  await expectStatus(`/api/instructor/courses/${COURSE}/questions/bulk`, 403, { method: 'POST', token: otherTeacher.token,
    body: { questions: [{ type: 'essay', prompt: 'x' }] } });
  await expectStatus(`/api/instructor/questions/${created.question.id}`, 403, { method: 'PATCH', token: otherTeacher.token, body: { prompt: 'x ___' } });
  await expectStatus(`/api/instructor/questions/${created.question.id}`, 403, { method: 'DELETE', token: otherTeacher.token });
  await expectStatus(`/api/instructor/courses/${COURSE}/questions`, 403, { token: learner.token });
  await expectStatus(`/api/instructor/courses/${COURSE}/questions/bulk`, 403, { method: 'POST', token: learner.token,
    body: { questions: [{ type: 'essay', prompt: 'x' }] } });
  await expectStatus(`/api/instructor/courses/${COURSE}/questions`, 200, { token: admin.token });
  await expectStatus(`/api/instructor/questions/${created.question.id}`, 200, { method: 'DELETE', token: teacher.token });

  // CSV export → import creates the same number of questions in another course the teacher owns.
  const csv = await request(`/api/instructor/courses/${COURSE}/questions/export`, { token: teacher.token });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const imported = await expectStatus('/api/instructor/courses/course_cf_d1_r2/questions/import', 201, { method: 'POST', token: teacher.token,
    body: { csv: csv.data } });
  assert.equal(imported.created, after.total);
  const copy = await expectStatus('/api/instructor/courses/course_cf_d1_r2/questions?q=AI', 200, { token: teacher.token });
  assert.ok(copy.questions.some(q => q.prompt === 'AI multiple' && JSON.stringify(q.correct) === '[0,2]'));
  const badCsv = await request(`/api/instructor/courses/${COURSE}/questions/import`, { method: 'POST', token: teacher.token,
    body: { csv: 'type,prompt,options,correct\nsingle,Q,a|b,3\n' } });
  assert.equal(badCsv.status, 400);
  assert.equal(badCsv.data.errors[0].row, 2);
});

test('objective types are auto-graded; answer keys stay hidden until submit', async () => {
  const ids = await createBank();
  const exam = await createExam({ title: 'ทุกประเภทคำถาม', question_ids: ids, pass_percent: 70 });
  await expectStatus(`/api/student/exams/${exam.id}/start`, 403, { method: 'POST', token: otherTeacher.token });

  const started = await expectStatus(`/api/student/exams/${exam.id}/start`, 201, { method: 'POST', token: learner.token });
  const attempt = started.attempt;
  assert.equal(attempt.questions.length, OBJECTIVE.length);
  const text = JSON.stringify(attempt);
  assert.ok(!/"(answer|correct|correct_answer|explanation)"/.test(text), 'no answer key while open');
  // Resuming returns the same attempt.
  const resumed = await expectStatus(`/api/student/exams/${exam.id}/start`, 200, { method: 'POST', token: learner.token });
  assert.equal(resumed.attempt.id, attempt.id);

  const def = (q) => OBJECTIVE[ids.indexOf(q.id)];
  const answers = Object.fromEntries(attempt.questions.map(q => [q.id, toPublic(q, def(q), correctResponse(def(q)))]));
  await expectStatus(`/api/student/exam-attempts/${attempt.id}/answers`, 400, { method: 'PUT', token: learner.token,
    body: { answers: { [attempt.questions[0].id]: { bad: true } } } });
  const done = await expectStatus(`/api/student/exam-attempts/${attempt.id}/submit`, 200, { method: 'POST', token: learner.token, body: { answers } });
  assert.equal(done.attempt.status, 'graded');
  assert.equal(done.attempt.percent, 100);
  assert.equal(done.attempt.passed, true);
  assert.ok(done.attempt.questions.every(q => q.is_correct === true && 'correct_answer' in q));
  // The revealed key is expressed in the attempt's own ids.
  for (const q of done.attempt.questions) {
    if (['single', 'multiple', 'true_false'].includes(q.type)) assert.deepEqual(q.correct_answer, [].concat(answers[q.id]).sort((a, b) => a - b), q.type);
    if (['matching', 'ordering'].includes(q.type)) assert.deepEqual(q.correct_answer, answers[q.id], q.type);
  }
  await expectStatus(`/api/student/exam-attempts/${attempt.id}/submit`, 409, { method: 'POST', token: learner.token, body: {} });

  // Second attempt: wrong or partial answers per type.
  const second = (await expectStatus(`/api/student/exams/${exam.id}/start`, 201, { method: 'POST', token: learner.token })).attempt;
  const wrong = {
    single: 1, multiple: [0], true_false: 1, short: 'KV', fill_blank: ['wrangler', 'npm'], matching: [0, 2, 1], ordering: [2, 1, 0]
  };
  // Regression: ids are re-randomised per attempt, so "sorted ids" is not the ordering/matching key.
  assert.ok(second.questions.some(q => idMap(q) !== idMap(attempt.questions.find(x => x.id === q.id))), 'option ids differ between attempts');
  const result = await expectStatus(`/api/student/exam-attempts/${second.id}/submit`, 200, { method: 'POST', token: learner.token,
    body: { answers: Object.fromEntries(second.questions.map(q => [q.id, toPublic(q, def(q), wrong[q.type])])) } });
  const byType = Object.fromEntries(result.attempt.questions.map(q => [q.type, q]));
  for (const type of ['single', 'multiple', 'true_false', 'short', 'ordering']) {
    assert.equal(byType[type].is_correct, false, type);
    assert.equal(byType[type].points_awarded, 0, type);
  }
  assert.equal(byType.fill_blank.points_awarded, 1); // 1 of 2 blanks × 2 points
  assert.equal(byType.matching.points_awarded, 1); // 1 of 3 pairs × 3 points
  assert.equal(result.attempt.passed, false);
});

test('fixed exams accept more questions than D1 allows bound parameters', async () => {
  const ids = await createBank(teacher.token, Array.from({ length: 120 }, (_, i) => ({ type: 'single', prompt: `จำนวนมาก ${i}`, options: ['a', 'b'], correct: [0] })));
  const exam = await createExam({ title: 'ข้อสอบ 120 ข้อ', question_ids: ids });
  const detail = await expectStatus(`/api/instructor/exams/${exam.id}`, 200, { token: teacher.token });
  assert.equal(detail.exam.question_ids.length, 120);
  await expectStatus(`/api/instructor/courses/${COURSE}/exams`, 400, { method: 'POST', token: teacher.token,
    body: { title: 'คำถามข้ามคอร์ส', question_ids: [...ids.slice(0, 110), 'qb_missing'] } });
});

test('random draw by tag, shuffled options, max attempts and availability window', async () => {
  const ids = await createBank(teacher.token, [
    ...['a', 'b', 'c', 'd'].map(p => ({ type: 'single', prompt: `random ${p}`, options: ['1', '2', '3', '4', '5', '6'], correct: [0], tags: ['pool'] })),
    { type: 'single', prompt: 'not in pool', options: ['1', '2'], correct: [0], tags: ['other'] }
  ]);
  const pool = new Set(ids.slice(0, 4));
  await expectStatus(`/api/instructor/courses/${COURSE}/exams`, 400, { method: 'POST', token: teacher.token,
    body: { title: 'too many', selection_mode: 'random', draw_rules: [{ tag: 'pool', count: 9 }], status: 'published' } });
  const exam = await createExam({ title: 'สุ่มข้อสอบ', selection_mode: 'random', draw_rules: [{ tag: 'pool', count: 2 }],
    shuffle_questions: true, shuffle_options: true, max_attempts: 2 });
  const seenOrders = new Set();
  for (let i = 0; i < 2; i++) {
    const a = (await expectStatus(`/api/student/exams/${exam.id}/start`, 201, { method: 'POST', token: learner.token })).attempt;
    assert.equal(a.questions.length, 2);
    for (const q of a.questions) {
      assert.ok(pool.has(q.id));
      assert.deepEqual(q.options.map(o => o.id).sort(), [0, 1, 2, 3, 4, 5]);
      seenOrders.add(q.options.map(o => o.id).join());
    }
    await expectStatus(`/api/student/exam-attempts/${a.id}/submit`, 200, { method: 'POST', token: learner.token, body: {} });
  }
  assert.ok(seenOrders.size > 1, 'options are shuffled per attempt');
  const third = await request(`/api/student/exams/${exam.id}/start`, { method: 'POST', token: learner.token });
  assert.equal(third.status, 403);

  const future = await createExam({ title: 'ยังไม่เปิด', question_ids: ids.slice(4), available_from: later(60) });
  await expectStatus(`/api/student/exams/${future.id}/start`, 403, { method: 'POST', token: learner.token });
  const draft = await expectStatus(`/api/instructor/courses/${COURSE}/exams`, 201, { method: 'POST', token: teacher.token,
    body: { title: 'ฉบับร่าง', question_ids: ids.slice(4) } });
  await expectStatus(`/api/student/exams/${draft.exam.id}/start`, 404, { method: 'POST', token: learner.token });
});

test('time limit is enforced on the server: late submissions only grade answers saved in time', async () => {
  const ids = await createBank(teacher.token, OBJECTIVE.slice(0, 2));
  const exam = await createExam({ title: 'จับเวลา', question_ids: ids, time_limit_minutes: 1, max_attempts: 2 });
  const a = (await expectStatus(`/api/student/exams/${exam.id}/start`, 201, { method: 'POST', token: learner.token })).attempt;
  assert.ok(Date.parse(a.deadline_at) - Date.parse(a.started_at) === 60_000);
  const single = a.questions.find(q => q.type === 'single');
  const multiple = a.questions.find(q => q.type === 'multiple');
  await expectStatus(`/api/student/exam-attempts/${a.id}/answers`, 200, { method: 'PUT', token: learner.token,
    body: { answers: { [single.id]: toPublic(single, OBJECTIVE[0], 0) } } });

  const lateHeaders = { 'X-Test-Now': later(5) };
  const late = await request(`/api/student/exam-attempts/${a.id}/submit`, { method: 'POST', token: learner.token, headers: lateHeaders,
    body: { answers: { [multiple.id]: toPublic(multiple, OBJECTIVE[1], [0, 1]) } } });
  assert.equal(late.status, 409);
  assert.equal(late.data.auto_closed, true);
  assert.equal(late.data.attempt.auto_closed, true);
  const graded = Object.fromEntries(late.data.attempt.questions.map(q => [q.type, q]));
  assert.equal(graded.single.is_correct, true);
  assert.equal(graded.multiple.is_correct, false, 'late answer ignored');

  // An abandoned attempt is closed lazily when the learner comes back after the deadline.
  const b = (await expectStatus(`/api/student/exams/${exam.id}/start`, 201, { method: 'POST', token: learner.token })).attempt;
  const view = await expectStatus(`/api/student/exam-attempts/${b.id}`, 200, { token: learner.token, headers: lateHeaders });
  assert.equal(view.attempt.status, 'graded');
  assert.equal(view.attempt.auto_closed, true);
  await expectStatus(`/api/student/exam-attempts/${b.id}/answers`, 409, { method: 'PUT', token: learner.token, body: { answers: {} } });
});

test('essays wait for manual grading, then notify the learner', async () => {
  const [essayId, singleId] = await createBank(teacher.token, [
    { type: 'essay', prompt: 'อธิบาย edge computing', points: 10 },
    { type: 'single', prompt: 'ง่าย', options: ['ใช่', 'ไม่'], correct: [0] }
  ]);
  const exam = await createExam({ title: 'อัตนัย', question_ids: [essayId, singleId], pass_percent: 50, show_answers: 'after_pass' });
  const a = (await expectStatus(`/api/student/exams/${exam.id}/start`, 201, { method: 'POST', token: learner.token })).attempt;
  const done = await expectStatus(`/api/student/exam-attempts/${a.id}/submit`, 200, { method: 'POST', token: learner.token,
    body: { answers: { [essayId]: 'Edge computing รันโค้ดใกล้ผู้ใช้',
      [singleId]: toPublic(a.questions.find(q => q.id === singleId), { type: 'single', options: ['ใช่', 'ไม่'] }, 0) } } });
  assert.equal(done.attempt.status, 'pending_grading');
  assert.equal(done.attempt.passed, null);
  assert.equal(done.attempt.answers_revealed, false);

  const queue = await expectStatus(`/api/instructor/grading-queue?courseId=${COURSE}`, 200, { token: teacher.token });
  assert.ok(queue.exam_attempts.some(q => q.id === a.id));
  const otherQueue = await expectStatus('/api/instructor/grading-queue', 200, { token: otherTeacher.token });
  assert.equal(otherQueue.exam_attempts.length, 0);
  await expectStatus(`/api/instructor/exam-attempts/${a.id}`, 403, { token: otherTeacher.token });
  const detail = await expectStatus(`/api/instructor/exam-attempts/${a.id}`, 200, { token: teacher.token });
  assert.equal(detail.attempt.questions.find(q => q.id === essayId).response, 'Edge computing รันโค้ดใกล้ผู้ใช้');

  await expectStatus(`/api/instructor/exam-attempts/${a.id}/grade`, 400, { method: 'POST', token: teacher.token,
    body: { grades: [{ question_id: essayId, points: 11 }] } });
  await expectStatus(`/api/instructor/exam-attempts/${a.id}/grade`, 403, { method: 'POST', token: otherTeacher.token,
    body: { grades: [{ question_id: essayId, points: 8 }] } });
  const graded = await expectStatus(`/api/instructor/exam-attempts/${a.id}/grade`, 200, { method: 'POST', token: teacher.token,
    body: { grades: [{ question_id: essayId, points: 8, feedback: 'ดีมาก' }], feedback: 'ผ่าน' } });
  assert.equal(graded.result.status, 'graded');
  assert.equal(graded.result.score, 9);
  assert.equal(graded.result.passed, true);

  const view = await expectStatus(`/api/student/exam-attempts/${a.id}`, 200, { token: learner.token });
  assert.equal(view.attempt.answers_revealed, true);
  assert.equal(view.attempt.questions.find(q => q.id === essayId).feedback, 'ดีมาก');
  const notes = await expectStatus('/api/notifications', 200, { token: learner.token });
  assert.ok(notes.some(n => n.title === 'ข้อสอบได้รับการตรวจแล้ว'));
});

test('requires_final_exam gates the certificate until the final exam is passed', async () => {
  const student = await account('final-exam', ['student']);
  for (const lessonId of ['lesson_cf_workers_intro', 'lesson_cf_workers_hono']) {
    await expectStatus(`/api/student/lessons/${lessonId}/progress`, 200, { method: 'POST', token: student.token, body: { resume_seconds: 30, completed: 1 } });
  }
  for (const quizId of ['quiz_workers_intro_1', 'quiz_workers_hono_1']) {
    await expectStatus(`/api/student/quizzes/${quizId}/submit`, 200, { method: 'POST', token: student.token, body: { answer_index: 0 } });
  }
  const [qid] = await createBank(teacher.token, [{ type: 'true_false', prompt: 'ปลายภาค: Workers รันที่ edge', correct: [true] }]);
  const final = await createExam({ title: 'ปลายภาค', question_ids: [qid], is_final: true, pass_percent: 100 });
  await expectStatus(`/api/instructor/courses/${COURSE}/assessment-settings`, 403, { method: 'PATCH', token: otherTeacher.token, body: { requires_final_exam: true } });
  await expectStatus(`/api/instructor/courses/${COURSE}/assessment-settings`, 200, { method: 'PATCH', token: teacher.token, body: { requires_final_exam: true } });

  const cert = `/api/student/courses/${COURSE}/certificate`;
  const blocked = await expectStatus(cert, 400, { method: 'POST', token: student.token });
  assert.match(blocked.error, /ปลายภาค/);
  const fail = (await expectStatus(`/api/student/exams/${final.id}/start`, 201, { method: 'POST', token: student.token })).attempt;
  await expectStatus(`/api/student/exam-attempts/${fail.id}/submit`, 200, { method: 'POST', token: student.token, body: { answers: { [qid]: toPublic(fail.questions[0], { type: 'true_false' }, 1) } } });
  await expectStatus(cert, 400, { method: 'POST', token: student.token });
  const pass = (await expectStatus(`/api/student/exams/${final.id}/start`, 201, { method: 'POST', token: student.token })).attempt;
  await expectStatus(`/api/student/exam-attempts/${pass.id}/submit`, 200, { method: 'POST', token: student.token, body: { answers: { [qid]: toPublic(pass.questions[0], { type: 'true_false' }, 0) } } });
  const issued = await expectStatus(cert, 201, { method: 'POST', token: student.token });
  assert.ok(issued.certificate.certificate_code);
  await expectStatus(`/api/instructor/courses/${COURSE}/assessment-settings`, 200, { method: 'PATCH', token: teacher.token, body: { requires_final_exam: false } });
});

test('assignments: private uploads, late penalty, return for resubmission and grading', async () => {
  const created = await expectStatus(`/api/instructor/courses/${COURSE}/assignments`, 201, { method: 'POST', token: teacher.token, body: {
    lesson_id: LESSON, title: 'รายงาน Workers', instructions: 'อธิบายสถาปัตยกรรม', due_at: later(-60), late_policy: 'penalty',
    late_penalty_percent: 50, rubric: [{ criterion: 'เนื้อหา', max_points: 60 }, { criterion: 'การนำเสนอ', max_points: 40 }], status: 'published' } });
  const asg = created.assignment;
  assert.equal(asg.max_score, 100);
  await expectStatus(`/api/instructor/courses/${COURSE}/assignments`, 400, { method: 'POST', token: teacher.token,
    body: { lesson_id: 'lesson_aws_csa_vpc', title: 'ข้ามคอร์ส' } });
  await expectStatus(`/api/instructor/assignments/${asg.id}`, 403, { method: 'PATCH', token: otherTeacher.token, body: { title: 'x' } });

  const pdf = new TextEncoder().encode('%PDF-1.4\n% test file\n');
  const files = `/api/student/assignments/${asg.id}/files`;
  const bad = await upload(files, learner.token, 'notes.txt', new TextEncoder().encode('hello'), 'text/plain');
  assert.equal(bad.status, 400);
  const fake = await upload(files, learner.token, 'fake.pdf', new TextEncoder().encode('not a pdf'), 'application/pdf');
  assert.equal(fake.status, 400);
  const outsider = await account('no-course', ['student'], { enroll: false });
  assert.equal((await upload(files, outsider.token, 'a.pdf', pdf, 'application/pdf')).status, 403);
  const up = await upload(files, learner.token, 'รายงาน.pdf', pdf, 'application/pdf');
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.ok(up.data.key.startsWith(`assignments/${asg.id}/`));

  // A classmate cannot attach someone else's upload.
  await expectStatus(`/api/student/assignments/${asg.id}/submit`, 400, { method: 'POST', token: classmate.token, body: { files: [up.data.key] } });
  await expectStatus(`/api/student/assignments/${asg.id}/submit`, 400, { method: 'POST', token: learner.token, body: {} });
  const sub = await expectStatus(`/api/student/assignments/${asg.id}/submit`, 201, { method: 'POST', token: learner.token,
    body: { text: 'คำตอบของฉัน', files: [up.data.key] } });
  assert.equal(sub.submission.is_late, true);
  assert.equal(sub.submission.files[0].name, 'รายงาน.pdf');
  assert.equal('key' in sub.submission.files[0], false);

  const fileUrl = `/api/assignment-submissions/${sub.submission.id}/files/0`;
  await expectStatus(fileUrl, 403, { token: classmate.token });
  await expectStatus(fileUrl, 403, { token: otherTeacher.token });
  for (const who of [learner, teacher, admin]) {
    const res = await request(fileUrl, { token: who.token });
    assert.equal(res.status, 200);
    assert.ok(String(res.data).startsWith('%PDF'));
  }

  const queue = await expectStatus('/api/instructor/grading-queue', 200, { token: teacher.token });
  assert.ok(queue.submissions.some(s => s.id === sub.submission.id));
  const instructorNotes = await expectStatus('/api/notifications', 200, { token: teacher.token });
  assert.ok(instructorNotes.some(n => n.title === 'มีงานส่งใหม่รอตรวจ'));

  const returned = await expectStatus(`/api/instructor/assignment-submissions/${sub.submission.id}/grade`, 200, { method: 'POST', token: teacher.token,
    body: { action: 'return', feedback: 'เพิ่มแผนภาพ' } });
  assert.equal(returned.submission.status, 'returned');
  const again = await expectStatus(`/api/student/assignments/${asg.id}/submit`, 200, { method: 'POST', token: learner.token, body: { text: 'ฉบับแก้ไข' } });
  assert.equal(again.submission.version, 2);
  assert.equal(again.submission.status, 'submitted');

  await expectStatus(`/api/instructor/assignment-submissions/${sub.submission.id}/grade`, 400, { method: 'POST', token: teacher.token,
    body: { action: 'grade', rubric_scores: [70, 30] } });
  await expectStatus(`/api/instructor/assignment-submissions/${sub.submission.id}/grade`, 403, { method: 'POST', token: otherTeacher.token,
    body: { action: 'grade', rubric_scores: [50, 30] } });
  const graded = await expectStatus(`/api/instructor/assignment-submissions/${sub.submission.id}/grade`, 200, { method: 'POST', token: teacher.token,
    body: { action: 'grade', rubric_scores: [50, 30], feedback: 'ดี' } });
  assert.equal(graded.submission.score, 80);
  assert.equal(graded.submission.final_score, 40); // 50% late penalty
  await expectStatus(`/api/student/assignments/${asg.id}/submit`, 409, { method: 'POST', token: learner.token, body: { text: 'อีกครั้ง' } });
  const learnerNotes = await expectStatus('/api/notifications', 200, { token: learner.token });
  assert.ok(learnerNotes.some(n => n.title === 'งานถูกส่งกลับให้แก้ไข'));
  assert.ok(learnerNotes.some(n => n.title === 'งานที่ส่งได้รับการตรวจแล้ว'));

  const strict = await expectStatus(`/api/instructor/courses/${COURSE}/assignments`, 201, { method: 'POST', token: teacher.token,
    body: { lesson_id: LESSON, title: 'ส่งช้าไม่รับ', due_at: later(-1), late_policy: 'reject', status: 'published' } });
  await expectStatus(`/api/student/assignments/${strict.assignment.id}/submit`, 403, { method: 'POST', token: learner.token, body: { text: 'ช้าไป' } });
  const own = await expectStatus(`/api/student/courses/${COURSE}/gradebook`, 200, { token: learner.token });
  assert.equal(own.rows.length, 1);
  assert.equal(own.rows[0].assignments[asg.id].final_score, 40);
});

test('interactive video questions: hidden key, answers stored and reported', async () => {
  await expectStatus(`/api/instructor/lessons/${LESSON}/video-questions`, 403, { method: 'POST', token: otherTeacher.token,
    body: { timestamp_seconds: 5, type: 'single', prompt: 'x', options: ['a', 'b'], correct: [0] } });
  await expectStatus(`/api/instructor/lessons/${LESSON}/video-questions`, 400, { method: 'POST', token: teacher.token,
    body: { timestamp_seconds: 5, type: 'essay', prompt: 'x' } });
  const vq = await expectStatus(`/api/instructor/lessons/${LESSON}/video-questions`, 201, { method: 'POST', token: teacher.token,
    body: { timestamp_seconds: 12.5, type: 'multiple', prompt: 'เลือก binding', options: ['D1', 'KV', 'SMTP'], correct: [0, 1], must_answer: true, explanation: 'SMTP ไม่ใช่' } });
  assert.equal(vq.question.must_answer, true);

  const list = await expectStatus(`/api/student/lessons/${LESSON}/video-questions`, 200, { token: learner.token });
  const item = list.questions.find(q => q.id === vq.question.id);
  assert.equal(item.answered, null);
  assert.equal('correct' in item, false);
  const outsider = await account('video-outsider', ['student'], { enroll: false });
  await expectStatus(`/api/student/lessons/${LESSON}/video-questions`, 403, { token: outsider.token });
  await expectStatus(`/api/student/video-questions/${vq.question.id}/answer`, 403, { method: 'POST', token: outsider.token, body: { response: [0, 1] } });

  // Regression: a wrong first try neither reveals the key nor can be "fixed" for the score.
  const wrong = await expectStatus(`/api/student/video-questions/${vq.question.id}/answer`, 200, { method: 'POST', token: learner.token, body: { response: [0] } });
  assert.equal(wrong.correct, false);
  assert.equal(wrong.final, false);
  assert.equal(wrong.tries_left, 1);
  assert.equal('correct_answer' in wrong, false, 'no key while a try is left');
  assert.equal('explanation' in wrong, false);
  const pending = (await expectStatus(`/api/student/lessons/${LESSON}/video-questions`, 200, { token: learner.token })).questions.find(q => q.id === vq.question.id);
  assert.equal(pending.answered, null);
  assert.equal(pending.tries_left, 1);
  const right = await expectStatus(`/api/student/video-questions/${vq.question.id}/answer`, 200, { method: 'POST', token: learner.token, body: { response: [1, 0] } });
  assert.equal(right.correct, true);
  assert.equal(right.final, true);
  assert.deepEqual(right.correct_answer, [0, 1]);
  await expectStatus(`/api/student/video-questions/${vq.question.id}/answer`, 409, { method: 'POST', token: learner.token, body: { response: [0] } });
  const after = await expectStatus(`/api/student/lessons/${LESSON}/video-questions`, 200, { token: learner.token });
  const answered = after.questions.find(q => q.id === vq.question.id).answered;
  assert.equal(answered.is_correct, true);
  assert.equal(answered.first_try_correct, false);

  // Two wrong tries: final, key revealed, nothing more accepted.
  const vq2 = await expectStatus(`/api/instructor/lessons/${LESSON}/video-questions`, 201, { method: 'POST', token: teacher.token,
    body: { timestamp_seconds: 20, type: 'single', prompt: 'Workers รันที่ไหน', options: ['Edge', 'Mainframe'], correct: [0] } });
  const miss1 = await expectStatus(`/api/student/video-questions/${vq2.question.id}/answer`, 200, { method: 'POST', token: classmate.token, body: { response: 1 } });
  assert.equal(miss1.final, false);
  const miss2 = await expectStatus(`/api/student/video-questions/${vq2.question.id}/answer`, 200, { method: 'POST', token: classmate.token, body: { response: 1 } });
  assert.equal(miss2.final, true);
  assert.deepEqual(miss2.correct_answer, [0]);
  await expectStatus(`/api/student/video-questions/${vq2.question.id}/answer`, 409, { method: 'POST', token: classmate.token, body: { response: 0 } });
  const third = await expectStatus(`/api/student/video-questions/${vq2.question.id}/answer`, 200, { method: 'POST', token: learner.token, body: { response: 0 } });
  assert.equal(third.final, true);

  // Scores use the first try only.
  const stats = await expectStatus(`/api/instructor/lessons/${LESSON}/video-questions`, 200, { token: teacher.token });
  assert.equal(stats.questions.find(q => q.id === vq.question.id).correct_count, 0);
  assert.equal(stats.questions.find(q => q.id === vq2.question.id).correct_count, 1);
  const book = await expectStatus(`/api/instructor/courses/${COURSE}/gradebook`, 200, { token: teacher.token });
  const row = book.rows.find(r => r.email === 'student1@netprime.com');
  assert.ok(row.video.correct >= 1);
  await expectStatus(`/api/instructor/courses/${COURSE}/gradebook`, 403, { token: otherTeacher.token });
});

test('exam report with item statistics and CSV export', async () => {
  const ids = await createBank(teacher.token, [
    { type: 'single', prompt: 'รายงาน ข้อ 1', options: ['ถูก', 'ผิด'], correct: [0] },
    { type: 'single', prompt: 'รายงาน ข้อ 2', options: ['ถูก', 'ผิด'], correct: [0] }
  ]);
  const exam = await createExam({ title: 'รายงานผลสอบ', question_ids: ids, pass_percent: 100 });
  for (const [who, picks] of [[learner, [0, 0]], [classmate, [0, 1]]]) {
    const a = (await expectStatus(`/api/student/exams/${exam.id}/start`, 201, { method: 'POST', token: who.token })).attempt;
    await expectStatus(`/api/student/exam-attempts/${a.id}/submit`, 200, { method: 'POST', token: who.token,
      body: { answers: Object.fromEntries(ids.map((id, i) => [id,
        toPublic(a.questions.find(q => q.id === id), { type: 'single', options: ['ถูก', 'ผิด'] }, picks[i])])) } });
  }
  const report = await expectStatus(`/api/instructor/exams/${exam.id}/report`, 200, { token: teacher.token });
  assert.equal(report.summary.attempts, 2);
  assert.equal(report.summary.average_percent, 75);
  assert.equal(report.summary.pass_rate, 50);
  const q2 = report.questions.find(q => q.question_id === ids[1]);
  assert.equal(q2.difficulty_index, 0.5);
  assert.equal(q2.discrimination, 1);
  await expectStatus(`/api/instructor/exams/${exam.id}/report`, 403, { token: otherTeacher.token });
  await expectStatus(`/api/instructor/exams/${exam.id}/report/export`, 403, { token: learner.token });

  const csv = await request(`/api/instructor/exams/${exam.id}/report/export`, { token: teacher.token });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.data.includes('ผู้เรียน'));
  assert.ok(csv.data.includes('student1@netprime.com'));

  const events = await request('/api/student/courses/' + COURSE + '/assessments', { token: learner.token });
  assert.equal(events.status, 200);
  assert.ok(events.data.exams.some(e => e.id === exam.id && e.passed === true));
});
