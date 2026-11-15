// Virtual Lab suite: staff lab library (labs.manage), lab lessons in courses, and server-side grading by replay.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { expectStatus, login, request, verifyEmail, watchVideoLesson } from './helpers.mjs';
import { sampleSpec } from '../packages/lab-engine/src/index.ts';

const COURSE = 'course_cf_workers';
const PASSWORD = 'labs-test-pass-1';
let admin, coord, instructor, student;

async function account(tag, { enroll = true } = {}) {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`;
  const created = await request('/api/admin/accounts', { method: 'POST', token: admin,
    body: { email, name: `บัญชี ${tag}`, roles: ['student'], password: PASSWORD } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const session = await login(email, PASSWORD);
  if (enroll) {
    await verifyEmail(session.token);
    const order = await request('/api/student/orders', { method: 'POST', token: session.token, body: { course_id: COURSE, voucher_code: 'DEMO-FREE100' } });
    assert.equal(order.status, 201, JSON.stringify(order.data));
  }
  return session.token;
}

before(async () => {
  admin = (await login('admin@netprime.com', 'admin123')).token;
  coord = (await login('coord@netprime.com', 'coord123')).token;
  instructor = (await login('instructor@netprime.com', 'inst123')).token;
  student = (await login('student3@netprime.com', 'stud123')).token;
});

/** Keystrokes that configure one router's Gi1 (Enter first to wake the console). */
const configure = (device, ip, shut = 'no shutdown') =>
  [device, ['', 'enable', 'configure terminal', 'interface gi1', `ip address ${ip} 255.255.255.0`, shut, 'end', ''].join('\r')];
const SOLVED = [configure('r1', '10.12.12.1'), configure('r2', '10.12.12.2')];

async function createLab(token = coord, extra = {}) {
  const { lab } = await expectStatus('/api/labs', 201, { method: 'POST', token, body: { title: 'ทดสอบ IPv4 พื้นฐาน', spec: sampleSpec(), ...extra } });
  return lab;
}

test('only staff with labs.manage use the lab library; specs are validated with paths', async () => {
  await expectStatus('/api/labs', 401);
  await expectStatus('/api/labs', 403, { token: student });
  await expectStatus('/api/labs', 403, { token: instructor });
  await expectStatus('/api/labs', 200, { token: coord });
  await expectStatus('/api/labs', 200, { token: admin });

  const broken = sampleSpec();
  broken.links[0].b.interface = 'gi7';
  const refused = await expectStatus('/api/labs', 400, { method: 'POST', token: coord, body: { spec: broken } });
  assert.ok(refused.errors.some(e => e.path === '$.links[0].b'), JSON.stringify(refused.errors));
  await expectStatus('/api/labs', 400, { method: 'POST', token: coord, body: { spec: '{not json' } });
  const checked = await expectStatus('/api/labs/validate', 200, { method: 'POST', token: coord, body: { spec: JSON.stringify(sampleSpec()) } });
  assert.deepEqual(checked.summary, { title: 'Basic IPv4 Connectivity', devices: 2, objectives: 4 });

  const lab = await createLab();
  assert.equal(lab.status, 'draft');
  assert.equal(lab.version, 1);
  const same = await expectStatus(`/api/labs/${lab.id}`, 200, { method: 'PATCH', token: coord, body: { spec: sampleSpec(), title: 'ชื่อใหม่' } });
  assert.equal(same.lab.version, 1, 'an unchanged spec keeps the version');
  const changed = sampleSpec();
  changed.instructions.summary = 'โจทย์ที่แก้แล้ว';
  const edited = await expectStatus(`/api/labs/${lab.id}`, 200, { method: 'PATCH', token: coord, body: { spec: changed } });
  assert.equal(edited.lab.version, 2);
  const detail = await expectStatus(`/api/labs/${lab.id}`, 200, { token: coord });
  assert.deepEqual(detail.versions.map(v => v.version), [2, 1]);
  assert.equal(detail.lab.spec.instructions.summary, 'โจทย์ที่แก้แล้ว');
  await expectStatus(`/api/labs/${lab.id}`, 200, { method: 'DELETE', token: coord });
  await expectStatus(`/api/labs/${lab.id}`, 404, { token: coord });
});

test('a passed lab lesson is graded on the server and gates course completion and the certificate', async () => {
  const lab = await createLab();
  // Instructors can only pick published labs.
  assert.ok(!(await expectStatus('/api/instructor/lab-options', 200, { token: instructor })).labs.some(l => l.id === lab.id));
  await expectStatus('/api/instructor/lab-options', 403, { token: student });
  await expectStatus(`/api/instructor/courses/${COURSE}/lessons`, 400, { method: 'POST', token: instructor, body: { title: 'Lab', type: 'lab', lab_id: lab.id } });
  await expectStatus(`/api/labs/${lab.id}/publish`, 200, { method: 'POST', token: coord });
  assert.ok((await expectStatus('/api/instructor/lab-options', 200, { token: instructor })).labs.some(l => l.id === lab.id));
  const missing = await expectStatus(`/api/instructor/courses/${COURSE}/lessons`, 400, { method: 'POST', token: instructor, body: { title: 'Lab', type: 'lab' } });
  assert.match(missing.error, /Virtual Lab/);
  const { lesson } = await expectStatus(`/api/instructor/courses/${COURSE}/lessons`, 201, {
    method: 'POST', token: instructor, body: { title: 'Lab: เชื่อม R1 กับ R2', type: 'lab', lab_id: lab.id } });
  assert.equal(lesson.type, 'lab');
  assert.equal(lesson.lab_id, lab.id);

  // Labs in use stay published and cannot be deleted.
  await expectStatus(`/api/labs/${lab.id}/unpublish`, 409, { method: 'POST', token: coord });
  await expectStatus(`/api/labs/${lab.id}`, 409, { method: 'DELETE', token: coord });

  // Someone outside the course gets nothing.
  const outsider = await account('lab-outsider', { enroll: false });
  await expectStatus(`/api/student/lessons/${lesson.id}/content`, 403, { token: outsider });
  await expectStatus(`/api/student/lessons/${lesson.id}/lab`, 403, { method: 'PUT', token: outsider, body: { transcript: SOLVED } });

  const learner = await account('lab-learner');
  const course = await expectStatus(`/api/courses/${COURSE}`, 200, { token: learner });
  assert.equal(course.lessons.find(l => l.id === lesson.id)?.type, 'lab');
  const content = await expectStatus(`/api/student/lessons/${lesson.id}/content`, 200, { token: learner });
  assert.equal(content.lesson.type, 'lab');
  assert.equal(content.lab.id, lab.id);
  assert.equal(content.lab.spec.id, 'LAB-001');
  assert.equal(content.lab.progress, null);

  // Marking it done by hand is refused; only a passing replay completes it.
  const manual = await expectStatus(`/api/student/lessons/${lesson.id}/complete`, 400, { method: 'POST', token: learner });
  assert.match(manual.error, /Virtual Lab/);

  // Finish every other lesson: the certificate still waits for the lab.
  await Promise.all(['lesson_cf_workers_intro', 'lesson_cf_workers_hono'].map(id => watchVideoLesson(learner, id)));
  const cert = `/api/student/courses/${COURSE}/certificate`;
  await expectStatus(cert, 400, { method: 'POST', token: learner });

  const path = `/api/student/lessons/${lesson.id}/lab`;
  const partial = await expectStatus(path, 200, { method: 'PUT', token: learner, body: { lab_version: 1, transcript: [SOLVED[0]] } });
  assert.equal(partial.passed, false);
  assert.equal(partial.passed_count, 1);
  assert.equal(partial.saved, true);
  assert.equal(partial.completed, false);

  // A client's own verdict is ignored: the server replays the keystrokes.
  const forged = await expectStatus(path, 200, { method: 'PUT', token: learner,
    body: { transcript: [configure('r1', '10.12.12.1'), configure('r2', '10.12.12.2', 'shutdown')], passed: true, passed_count: 4, results: [] } });
  assert.equal(forged.passed, false);
  assert.equal(forged.passed_count, 2);
  await expectStatus(cert, 400, { method: 'POST', token: learner });

  // Bad transcripts and stale lab versions are refused.
  await expectStatus(path, 400, { method: 'PUT', token: learner, body: { transcript: [['r9', 'enable\r']] } });
  await expectStatus(path, 400, { method: 'PUT', token: learner, body: { transcript: 'enable' } });
  await expectStatus(path, 400, { method: 'PUT', token: learner, body: { transcript: [['r1', 'x'.repeat(140 * 1024)]] } });
  const stale = await expectStatus(path, 409, { method: 'PUT', token: learner, body: { lab_version: 99, transcript: SOLVED } });
  assert.equal(stale.code, 'lab_changed');

  // Saved work comes back for the player to replay.
  const resumed = await expectStatus(`/api/student/lessons/${lesson.id}/content`, 200, { token: learner });
  assert.equal(resumed.lab.progress.passed_count, 2);
  assert.equal(resumed.lab.progress.transcript.length, 2);
  assert.equal(resumed.completed, false);

  const passed = await expectStatus(path, 200, { method: 'PUT', token: learner, body: { lab_version: 1, transcript: SOLVED } });
  assert.equal(passed.passed, true);
  assert.equal(passed.completed, true);
  assert.ok(passed.passed_at);
  assert.equal(passed.progress_percent, 100);
  assert.equal((await expectStatus(`/api/student/lessons/${lesson.id}/content`, 200, { token: learner })).completed, true);
  const issued = await expectStatus(cert, 201, { method: 'POST', token: learner });
  assert.ok(issued.certificate.certificate_code);

  // Starting again keeps the pass; later failing work does not undo it.
  await expectStatus(`/api/student/lessons/${lesson.id}/lab/reset`, 200, { method: 'POST', token: learner });
  const reset = await expectStatus(`/api/student/lessons/${lesson.id}/content`, 200, { token: learner });
  assert.deepEqual(reset.lab.progress.transcript, []);
  assert.equal(reset.lab.progress.attempts, 2);
  assert.ok(reset.lab.progress.passed_at);
  assert.equal(reset.completed, true);
  const after = await expectStatus(path, 200, { method: 'PUT', token: learner, body: { transcript: [SOLVED[0]] } });
  assert.equal(after.passed, false);
  assert.equal(after.completed, true);

  // Staff previewing the lesson are graded but nothing is stored.
  const preview = await expectStatus(path, 200, { method: 'PUT', token: instructor, body: { transcript: SOLVED } });
  assert.equal(preview.passed, true);
  assert.equal(preview.saved, false);

  // Staff see who passed, with the lab and engine versions that graded them.
  const { progress } = await expectStatus(`/api/labs/${lab.id}/progress`, 200, { token: coord });
  const row = progress.find(p => p.lesson_id === lesson.id && p.passed_at);
  assert.ok(row, JSON.stringify(progress));
  assert.equal(row.passed_lab_version, 1);
  assert.ok(row.passed_engine_version);
  assert.ok(!progress.some(p => p.name === 'บัญชี lab-outsider'));

  // The learner's PDPA export includes lab work.
  const exported = await expectStatus('/api/me/export', 200, { token: learner });
  assert.ok(JSON.stringify(exported).includes(lesson.id));

  // Switching the lesson to another type drops the lab; then the lab may be unpublished but not deleted (results exist).
  const switched = await expectStatus(`/api/instructor/lessons/${lesson.id}/settings`, 200, { method: 'PATCH', token: instructor, body: { type: 'text', content_md: 'ข้อความ' } });
  assert.equal(switched.lesson.type, 'text');
  assert.equal(switched.lesson.lab_id, null);
  await expectStatus(`/api/student/lessons/${lesson.id}/lab`, 400, { method: 'PUT', token: learner, body: { transcript: SOLVED } });
  await expectStatus(`/api/labs/${lab.id}/unpublish`, 200, { method: 'POST', token: coord });
  await expectStatus(`/api/labs/${lab.id}`, 409, { method: 'DELETE', token: coord });
});
