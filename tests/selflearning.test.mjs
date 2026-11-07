// Self-learning suite: lessons, HTML uploads, versions, preview links and how files are served (site.self_learning).
import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { confirmedRequest, expectStatus, login, request } from './helpers.mjs';

const base = process.env.NETPRIME_TEST_BASE;
let admin, coord, student, instructor;
const unique = () => Math.random().toString(36).slice(2, 8);

before(async () => {
  admin = (await login('admin@netprime.com', 'admin123')).token;
  coord = (await login('coord@netprime.com', 'coord123')).token;
  student = (await login('student3@netprime.com', 'stud123')).token;
  instructor = (await login('instructor@netprime.com', 'inst123')).token;
});

const lessonHtml = (marker = 'v1') => `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><title>บทเรียน ${marker}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anuphan"></head>
<body><h1>${marker}</h1><script>parent.postMessage({ type: 'netprime-lesson:height', height: 800 }, '*');</script></body></html>`;

async function upload(token, id, content, { name = 'lesson.html', type = 'text/html' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  const res = await fetch(`${base}/api/self-learning/lessons/${id}/file`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, data: await res.json() };
}

async function createLesson(token = coord, extra = {}) {
  const slug = `lesson-${unique()}`;
  const { lesson } = await expectStatus('/api/self-learning/lessons', 201, { method: 'POST', token, body: { slug, title: `บทเรียน ${slug}`, level: 'beginner', ...extra } });
  return lesson;
}

test('console needs site.self_learning; coordinators have it by default', async () => {
  await expectStatus('/api/self-learning/lessons', 401);
  await expectStatus('/api/self-learning/lessons', 403, { token: student });
  await expectStatus('/api/self-learning/lessons', 403, { token: instructor });
  await expectStatus('/api/self-learning/lessons', 200, { token: coord });
  await expectStatus('/api/self-learning/lessons', 200, { token: admin });
  await expectStatus('/api/public/self-learning', 200);
});

test('lesson fields are validated and slugs are unique', async () => {
  const bad = await expectStatus('/api/self-learning/lessons', 400, { method: 'POST', token: coord, body: { slug: 'Bad Slug!', title: 'x' } });
  assert.match(bad.error, /slug/);
  await expectStatus('/api/self-learning/lessons', 400, { method: 'POST', token: coord, body: { slug: 'ok-slug' } });
  await expectStatus('/api/self-learning/lessons', 400, { method: 'POST', token: coord, body: { slug: `l-${unique()}`, title: 'x', level: 'expert' } });
  await expectStatus('/api/self-learning/lessons', 400, { method: 'POST', token: coord, body: { slug: `l-${unique()}`, title: 'x', cover_url: 'javascript:alert(1)' } });
  const lesson = await createLesson();
  const dup = await expectStatus('/api/self-learning/lessons', 409, { method: 'POST', token: coord, body: { slug: lesson.slug, title: 'ซ้ำ' } });
  assert.match(dup.error, /slug/);
  const edited = await expectStatus(`/api/self-learning/lessons/${lesson.id}`, 200, { method: 'PATCH', token: coord, body: { summary: 'สรุปสั้น', level: null } });
  assert.equal(edited.lesson.summary, 'สรุปสั้น');
  assert.equal(edited.lesson.level, null);
  assert.equal(edited.lesson.title, lesson.title, 'PATCH keeps fields that were not sent');
});

test('uploads accept UTF-8 HTML only and report what the file loads', async () => {
  const lesson = await createLesson();
  assert.equal((await upload(coord, lesson.id, 'not html at all', { name: 'x.html' })).status, 400);
  assert.equal((await upload(coord, lesson.id, lessonHtml(), { name: 'x.js', type: 'text/javascript' })).status, 400);
  assert.equal((await upload(coord, lesson.id, new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0xff, 0xfe]), { name: 'x.html' })).status, 400, 'invalid UTF-8');
  assert.equal((await upload(student, lesson.id, lessonHtml())).status, 403);

  const first = await upload(coord, lesson.id, lessonHtml('v1'));
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.file.version, 1);
  assert.equal(first.data.file.uses_kit, true);
  assert.deepEqual(first.data.file.external_hosts, ['fonts.googleapis.com']);
  assert.equal(first.data.lesson.current_file_id, first.data.file.id);

  const plain = await upload(coord, lesson.id, '<!doctype html><html><body>plain</body></html>');
  assert.equal(plain.data.file.version, 2);
  assert.equal(plain.data.file.uses_kit, false);
});

test('drafts stay private; published lessons serve the current file to the site only', async () => {
  const lesson = await createLesson();
  await expectStatus(`/api/self-learning/lessons/${lesson.id}/publish`, 400, { method: 'POST', token: coord });
  const { data: { file } } = await upload(coord, lesson.id, lessonHtml('first'));

  await expectStatus(`/api/public/self-learning/${lesson.slug}`, 404);
  assert.equal((await fetch(`${base}/api/public/self-learning/files/${file.id}`)).status, 404, 'draft file needs a preview signature');

  const { url } = await expectStatus(`/api/self-learning/lessons/${lesson.id}/preview`, 200, { token: coord });
  const preview = await fetch(url);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('cache-control'), /no-store/);
  assert.match(await preview.text(), /first/);
  const tampered = url.replace(/sig=([a-f0-9])/, (_, ch) => `sig=${ch === 'a' ? 'b' : 'a'}`);
  assert.equal((await fetch(tampered)).status, 404);
  await expectStatus(`/api/self-learning/lessons/${lesson.id}/preview`, 403, { token: student });

  await expectStatus(`/api/self-learning/lessons/${lesson.id}/publish`, 200, { method: 'POST', token: coord });
  const listed = await expectStatus('/api/public/self-learning', 200);
  assert.ok(listed.lessons.some(l => l.slug === lesson.slug));
  assert.ok(!('current_file_id' in listed.lessons[0]));
  const { lesson: pub } = await expectStatus(`/api/public/self-learning/${lesson.slug}`, 200);
  assert.match(pub.content_url, new RegExp(`/api/public/self-learning/files/${file.id}$`));

  const served = await fetch(pub.content_url);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type'), /^text\/html/);
  assert.match(served.headers.get('content-security-policy'), /frame-ancestors http:\/\/localhost:5173 http:\/\/127\.0\.0\.1:5173/);
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');

  // A new upload replaces what learners see; the old version still exists and can be restored.
  const second = await upload(coord, lesson.id, lessonHtml('second'));
  const { lesson: after } = await expectStatus(`/api/public/self-learning/${lesson.slug}`, 200);
  assert.match(after.content_url, new RegExp(`${second.data.file.id}$`));
  assert.equal((await fetch(`${base}/api/public/self-learning/files/${file.id}`)).status, 404, 'an old version is not public');
  const detail = await expectStatus(`/api/self-learning/lessons/${lesson.id}`, 200, { token: coord });
  assert.deepEqual(detail.files.map(f => f.version), [2, 1]);
  await expectStatus(`/api/self-learning/lessons/${lesson.id}/files/${file.id}/restore`, 200, { method: 'POST', token: coord });
  const { lesson: restored } = await expectStatus(`/api/public/self-learning/${lesson.slug}`, 200);
  assert.match(restored.content_url, new RegExp(`${file.id}$`));

  await expectStatus(`/api/self-learning/lessons/${lesson.id}/unpublish`, 200, { method: 'POST', token: coord });
  await expectStatus(`/api/public/self-learning/${lesson.slug}`, 404);
  assert.equal((await fetch(`${base}/api/public/self-learning/files/${file.id}`)).status, 404);
});

test('reorder sets the public order', async () => {
  const a = await createLesson();
  const b = await createLesson();
  for (const l of [a, b]) {
    await upload(coord, l.id, lessonHtml());
    await expectStatus(`/api/self-learning/lessons/${l.id}/publish`, 200, { method: 'POST', token: coord });
  }
  await expectStatus('/api/self-learning/reorder', 200, { method: 'POST', token: coord, body: { ids: [b.id, a.id] } });
  const { lessons } = await expectStatus('/api/public/self-learning', 200);
  const order = lessons.map(l => l.slug).filter(s => s === a.slug || s === b.slug);
  assert.deepEqual(order, [b.slug, a.slug]);
});

test('deleting a published lesson needs an emailed code and removes its files', async () => {
  const lesson = await createLesson();
  const { data: { file } } = await upload(coord, lesson.id, lessonHtml());
  await expectStatus(`/api/self-learning/lessons/${lesson.id}/publish`, 200, { method: 'POST', token: coord });
  const blocked = await request(`/api/self-learning/lessons/${lesson.id}`, { method: 'DELETE', token: coord });
  assert.equal(blocked.status, 428);
  const done = await confirmedRequest(`/api/self-learning/lessons/${lesson.id}`, 'self_learning.delete', lesson.id, { token: coord });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  await expectStatus(`/api/self-learning/lessons/${lesson.id}`, 404, { token: coord });
  assert.equal((await fetch(`${base}/api/public/self-learning/files/${file.id}`)).status, 404);

  // A draft goes with a plain confirm.
  const draft = await createLesson();
  await expectStatus(`/api/self-learning/lessons/${draft.id}`, 200, { method: 'DELETE', token: coord });
});

test('signed-in learners save and resume progress on published lessons only', async () => {
  const lesson = await createLesson();
  await upload(coord, lesson.id, lessonHtml());
  const path = `/api/me/self-learning/${lesson.slug}`;
  await expectStatus(path, 401);
  await expectStatus(path, 404, { token: student }, 'drafts take no progress');
  await expectStatus(path, 404, { method: 'PUT', token: student, body: { percent: 10 } });
  await expectStatus(`/api/self-learning/lessons/${lesson.id}/publish`, 200, { method: 'POST', token: coord });

  assert.equal((await expectStatus(path, 200, { token: student })).progress, null);
  await expectStatus(path, 400, { method: 'PUT', token: student, body: { percent: 101 } });
  await expectStatus(path, 400, { method: 'PUT', token: student, body: { percent: 5, state: { blob: 'x'.repeat(70 * 1024) } } });
  await expectStatus(path, 200, { method: 'PUT', token: student, body: { percent: 40, state: { seen: [0, 1] } } });
  let saved = (await expectStatus(path, 200, { token: student })).progress;
  assert.equal(saved.percent, 40);
  assert.deepEqual(saved.state, { seen: [0, 1] });
  assert.equal(saved.completed_at, null);

  await expectStatus(path, 200, { method: 'PUT', token: student, body: { percent: 100, completed: true, state: { seen: [0, 1, 2] } } });
  // Completion sticks even if the lesson later reports less (a reset, another device).
  await expectStatus(path, 200, { method: 'PUT', token: student, body: { percent: 30, completed: false, state: { seen: [0] } } });
  saved = (await expectStatus(path, 200, { token: student })).progress;
  assert.equal(saved.percent, 30);
  assert.ok(saved.completed_at);

  // Each account has its own progress; the list feeds the lesson cards.
  assert.equal((await expectStatus(path, 200, { token: instructor })).progress, null);
  const mine = await expectStatus('/api/me/self-learning', 200, { token: student });
  assert.ok(mine.progress.some(p => p.slug === lesson.slug && p.completed_at));

  // Staff see how many learners opened and finished it.
  const listed = (await expectStatus('/api/self-learning/lessons', 200, { token: coord })).lessons.find(l => l.id === lesson.id);
  assert.equal(listed.learners, 1);
  assert.equal(listed.completed, 1);

  // A draft with learner progress needs an emailed code to delete, and the progress goes with it.
  await expectStatus(`/api/self-learning/lessons/${lesson.id}/unpublish`, 200, { method: 'POST', token: coord });
  assert.equal((await request(`/api/self-learning/lessons/${lesson.id}`, { method: 'DELETE', token: coord })).status, 428);
  const done = await confirmedRequest(`/api/self-learning/lessons/${lesson.id}`, 'self_learning.delete', lesson.id, { token: coord });
  assert.equal(done.status, 200);
  assert.ok(!(await expectStatus('/api/me/self-learning', 200, { token: student })).progress.some(p => p.slug === lesson.slug));
});

test('course-only lessons stay off the public site and open only through a course that uses them', async () => {
  const lesson = await createLesson(coord, { visibility: 'course' });
  const { data: { file } } = await upload(coord, lesson.id, lessonHtml('in-course'));
  await expectStatus(`/api/self-learning/lessons/${lesson.id}/publish`, 200, { method: 'POST', token: coord });
  const listed = (await expectStatus('/api/self-learning/lessons', 200, { token: coord })).lessons.find(l => l.id === lesson.id);
  assert.equal(listed.visibility, 'course');

  // Not listed, no public page, no unsigned file, no progress for someone outside the course.
  assert.ok(!(await expectStatus('/api/public/self-learning', 200)).lessons.some(l => l.slug === lesson.slug));
  await expectStatus(`/api/public/self-learning/${lesson.slug}`, 404);
  assert.equal((await fetch(`${base}/api/public/self-learning/files/${file.id}`)).status, 404);
  await expectStatus(`/api/me/self-learning/${lesson.slug}`, 404, { token: student });
  await expectStatus('/api/self-learning/lessons/x', 400, { method: 'PATCH', token: coord, body: { visibility: 'hidden' } });

  // Instructors pick it from the library and add it to their course.
  const { lessons: options } = await expectStatus('/api/instructor/self-learning-options', 200, { token: instructor });
  assert.ok(options.some(o => o.id === lesson.id && o.visibility === 'course'));
  await expectStatus('/api/instructor/self-learning-options', 403, { token: student });
  const missing = await expectStatus('/api/instructor/courses/course_cisco_ccna/lessons', 400, { method: 'POST', token: instructor, body: { title: 'ไม่มีบท', type: 'self_learning' } });
  assert.match(missing.error, /Self-learning/);
  const created = await expectStatus('/api/instructor/courses/course_cisco_ccna/lessons', 201, {
    method: 'POST', token: instructor, body: { title: 'ฝึก DHCP ด้วยตัวเอง', type: 'self_learning', self_learning_id: lesson.id }
  });
  assert.equal(created.lesson.type, 'self_learning');
  assert.equal(created.lesson.self_learning_id, lesson.id);
  const courseLesson = created.lesson.id;

  // The learner's course shows the type; the player gets a signed link that works.
  const course = await expectStatus('/api/courses/course_cisco_ccna', 200, { token: student });
  assert.equal(course.lessons.find(l => l.id === courseLesson)?.type, 'self_learning');
  const content = await expectStatus(`/api/student/lessons/${courseLesson}/content`, 200, { token: student });
  assert.equal(content.lesson.type, 'self_learning');
  assert.equal(content.self_learning.slug, lesson.slug);
  const opened = await fetch(content.self_learning.content_url);
  assert.equal(opened.status, 200);
  assert.match(await opened.text(), /in-course/);

  // Enrolled learners may now save progress; reporting it complete completes the course lesson.
  await expectStatus(`/api/me/self-learning/${lesson.slug}`, 200, { token: student });
  const saved = await expectStatus(`/api/me/self-learning/${lesson.slug}`, 200, { method: 'PUT', token: student, body: { percent: 100, completed: true } });
  assert.equal(saved.completed_in_courses, 1);
  assert.equal((await expectStatus(`/api/student/lessons/${courseLesson}/content`, 200, { token: student })).completed, true);
  const again = await expectStatus(`/api/me/self-learning/${lesson.slug}`, 200, { method: 'PUT', token: student, body: { percent: 100, completed: true } });
  assert.equal(again.completed_in_courses, 0, 'an already completed course lesson is left alone');
  // Course-only progress is not listed with the public lessons.
  assert.ok(!(await expectStatus('/api/me/self-learning', 200, { token: student })).progress.some(p => p.slug === lesson.slug));

  // Switching the course lesson to another type drops the link; deleting the library lesson leaves the course lesson empty.
  const switched = await expectStatus(`/api/instructor/lessons/${courseLesson}/settings`, 200, { method: 'PATCH', token: instructor, body: { type: 'text' } });
  assert.equal(switched.lesson.type, 'text');
  assert.equal(switched.lesson.self_learning_id, null);
  await expectStatus(`/api/instructor/lessons/${courseLesson}/settings`, 200, { method: 'PATCH', token: instructor, body: { type: 'self_learning', self_learning_id: lesson.id } });
  assert.equal((await request(`/api/self-learning/lessons/${lesson.id}`, { method: 'DELETE', token: coord })).status, 428);
  const done = await confirmedRequest(`/api/self-learning/lessons/${lesson.id}`, 'self_learning.delete', lesson.id, { token: coord });
  assert.equal(done.status, 200);
  const orphan = await expectStatus(`/api/student/lessons/${courseLesson}/content`, 200, { token: student });
  assert.equal(orphan.self_learning, null);
});
