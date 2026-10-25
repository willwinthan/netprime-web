import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

// Local Workers have no AI binding: every assistant must answer through its deterministic mock path.

let admin, instructor, other, student1, student3;
const post = (path, token, body) => request(path, { method: 'POST', token, body });
const put = (path, token, body) => request(path, { method: 'PUT', token, body });

const LESSON_TEXT = `## Cloudflare Workers คืออะไร
Cloudflare Workers เป็นแพลตฟอร์ม serverless ที่รันโค้ด JavaScript บน edge network ใกล้ผู้ใช้
- Workers ใช้ V8 isolates แทน container จึงเริ่มทำงานเร็วมาก
- Hono เป็น framework ขนาดเล็กสำหรับกำหนด routing บน Workers
การผูก binding เช่น D1, KV และ R2 ทำผ่านไฟล์ wrangler.jsonc และเข้าถึงด้วย c.env ภายใน handler.
การ deploy ใช้คำสั่ง wrangler deploy ซึ่งอัปโหลดโค้ดไปทุก data center พร้อมกัน.`;

async function setAi(patch) {
  const res = await put('/api/admin/ai/settings', admin.token, patch);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.settings;
}

before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  instructor = await login('instructor@netprime.com', 'inst123');
  student1 = await login('student1@netprime.com', 'stud123');
  student3 = await login('student3@netprime.com', 'stud123');
  const created = await post('/api/admin/accounts', admin.token, {
    email: 'ai-other-instructor@example.invalid', name: 'ผู้สอนอีกคน', password: 'ai-other-instructor-1', roles: ['instructor']
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  other = await login('ai-other-instructor@example.invalid', 'ai-other-instructor-1');
});

after(async () => {
  await put('/api/admin/ai/settings', admin.token, {
    daily_quota: 50, chatbot_per_ip: 20, chatbot_daily_cap: 500,
    features: { tutor: true, outline: true, quiz: true, summary: true, writing: true, chatbot: true }
  });
});

test('outline generator returns a valid structure (mock) and only instructors may use it', async () => {
  const data = await expectStatus('/api/ai/outline', 200, { method: 'POST', token: instructor.token,
    body: { topic: 'Kubernetes', audience: 'ผู้ดูแลระบบ', level: 'beginner', duration_hours: 9, language: 'th' } });
  assert.equal(data.mock, true);
  assert.ok(data.outline.title.includes('Kubernetes'));
  assert.ok(Array.isArray(data.outline.objectives) && data.outline.objectives.length > 0);
  assert.ok(data.outline.sections.length >= 2);
  for (const section of data.outline.sections) {
    assert.equal(typeof section.title, 'string');
    assert.ok(section.lessons.length > 0);
    for (const lesson of section.lessons) {
      assert.ok(lesson.title);
      assert.equal(typeof lesson.description, 'string');
      assert.ok(Array.isArray(lesson.objectives));
    }
  }
  await expectStatus('/api/ai/outline', 400, { method: 'POST', token: instructor.token, body: { topic: '' } });
  await expectStatus('/api/ai/outline', 403, { method: 'POST', token: student1.token, body: { topic: 'x' } });
  await expectStatus('/api/ai/outline', 401, { method: 'POST', body: { topic: 'x' } });
});

test('applying an outline creates a draft structure only in the instructor’s own draft course', async () => {
  const { outline } = await expectStatus('/api/ai/outline', 200, { method: 'POST', token: instructor.token,
    body: { topic: 'Ansible', audience: 'วิศวกรเครือข่าย', level: 'intermediate', duration_hours: 6 } });
  // Instructors edit the preview before creating it.
  outline.sections[0].title = 'ส่วนแรกที่แก้ไขแล้ว';
  const expected = outline.sections.reduce((n, s) => n + s.lessons.length, 0);

  const created = await expectStatus('/api/ai/outline/apply', 201, { method: 'POST', token: instructor.token, body: { outline } });
  assert.equal(created.created_course, true);
  assert.equal(created.lessons_created, expected);
  const analytics = await expectStatus('/api/instructor/analytics', 200, { token: instructor.token });
  const course = analytics.courses.find(c => c.id === created.course_id);
  assert.ok(course, 'new course belongs to the instructor');
  assert.equal(course.status, 'draft');

  // Adding to the same (own, draft) course appends lessons.
  const again = await expectStatus('/api/ai/outline/apply', 201, { method: 'POST', token: instructor.token, body: { course_id: created.course_id, outline } });
  assert.equal(again.created_course, false);
  assert.equal(again.lessons_created, expected);

  // Someone else's course, a published course, invalid outlines and learners are rejected.
  await expectStatus('/api/ai/outline/apply', 403, { method: 'POST', token: other.token, body: { course_id: created.course_id, outline } });
  await expectStatus('/api/ai/outline/apply', 409, { method: 'POST', token: instructor.token, body: { course_id: 'course_cf_workers', outline } });
  await expectStatus('/api/ai/outline/apply', 400, { method: 'POST', token: instructor.token, body: { outline: { title: 'x', sections: [] } } });
  await expectStatus('/api/ai/outline/apply', 403, { method: 'POST', token: student1.token, body: { outline } });
});

test('quiz generator output matches the question bank bulk contract', async () => {
  const types = ['single', 'multiple', 'true_false', 'short', 'essay'];
  const data = await expectStatus('/api/ai/quiz', 200, { method: 'POST', token: instructor.token,
    body: { course_id: 'course_cf_workers', text: LESSON_TEXT, count: 10, types } });
  assert.equal(data.mock, true);
  assert.equal(data.bulk_endpoint, '/api/instructor/courses/course_cf_workers/questions/bulk');
  assert.ok(data.questions.length >= 5);
  const seen = new Set();
  for (const q of data.questions) {
    seen.add(q.type);
    assert.ok(types.includes(q.type));
    assert.equal(typeof q.prompt, 'string');
    assert.ok(q.prompt.length > 0);
    assert.ok(Number.isInteger(q.points) && q.points > 0);
    assert.ok(Array.isArray(q.tags) && q.tags.includes('ai'));
    if (q.type === 'essay') { assert.equal(q.options, undefined); assert.equal(q.correct, undefined); continue; }
    if (q.type === 'short') { assert.ok(q.correct.length > 0 && q.correct.every(a => typeof a === 'string')); continue; }
    assert.ok(Array.isArray(q.options) && q.options.length >= 2);
    assert.ok(q.correct.every(i => Number.isInteger(i) && i >= 0 && i < q.options.length));
    if (q.type !== 'multiple') assert.equal(q.correct.length, 1);
    if (q.type === 'true_false') assert.deepEqual(q.options, ['ถูก', 'ผิด']);
  }
  assert.equal(seen.size, 5, 'every requested type is produced');

  // The review screen posts the same shape to the question bank (assessments stream); 404 until it exists.
  const bulk = await post(data.bulk_endpoint, instructor.token, { questions: data.questions });
  assert.ok([200, 201, 404].includes(bulk.status), JSON.stringify(bulk.data));
  if (bulk.status !== 404) assert.ok(Array.isArray(bulk.data.ids));

  await expectStatus('/api/ai/quiz', 403, { method: 'POST', token: other.token, body: { course_id: 'course_cf_workers', text: LESSON_TEXT } });
  await expectStatus('/api/ai/quiz', 400, { method: 'POST', token: instructor.token, body: { course_id: 'course_cf_workers', text: 'สั้นไป' } });
  await expectStatus('/api/ai/quiz', 400, { method: 'POST', token: instructor.token, body: { course_id: 'course_cf_workers', text: LESSON_TEXT, types: ['matching'] } });
  await expectStatus('/api/ai/quiz', 404, { method: 'POST', token: instructor.token,
    body: { course_id: 'course_cf_workers', lesson_id: 'lesson_cisco_ccna_intro_missing', text: LESSON_TEXT } });
});

test('lesson summary is cached per version; only the course instructor regenerates', async () => {
  const lesson = 'lesson_cf_workers_intro';
  // Regenerate from pasted notes (video lesson without text).
  const made = await expectStatus(`/api/ai/lessons/${lesson}/summary`, 200, { method: 'POST', token: instructor.token, body: { source_text: LESSON_TEXT } });
  assert.equal(made.mock, true);
  assert.equal(made.cached, false);
  assert.equal(made.source, 'instructor');
  assert.ok(made.summary.length > 0);
  assert.ok(Array.isArray(made.key_points) && made.key_points.length > 0);

  // Enrolled learner reads the cached copy.
  const read = await expectStatus(`/api/ai/lessons/${lesson}/summary`, 200, { token: student1.token });
  assert.equal(read.cached, true);
  assert.equal(read.summary, made.summary);
  const readAgain = await expectStatus(`/api/ai/lessons/${lesson}/summary`, 200, { token: student1.token });
  assert.equal(readAgain.generated_at, read.generated_at, 'no regeneration on repeat views');

  // student3 completed course_cf_workers (still has access); the other instructor is not enrolled.
  await expectStatus(`/api/ai/lessons/${lesson}/summary`, 200, { token: student3.token });
  await expectStatus(`/api/ai/lessons/${lesson}/summary`, 403, { token: other.token });
  await expectStatus(`/api/ai/lessons/${lesson}/summary`, 403, { method: 'POST', token: student1.token, body: {} });
  await expectStatus(`/api/ai/lessons/${lesson}/summary`, 403, { method: 'POST', token: other.token, body: { source_text: LESSON_TEXT } });
  await expectStatus('/api/ai/lessons/lesson_missing/summary', 404, { token: student1.token });

  // Regenerating without new text reuses the stored notes.
  const regen = await expectStatus(`/api/ai/lessons/${lesson}/summary`, 200, { method: 'POST', token: instructor.token, body: {} });
  assert.equal(regen.source, 'instructor');
  assert.equal(regen.summary, made.summary, 'deterministic mock on the same text');
});

test('writing helper: improve, shorten, translate and SEO suggestions', async () => {
  for (const action of ['improve', 'shorten', 'translate_en', 'translate_th']) {
    const data = await expectStatus('/api/ai/write', 200, { method: 'POST', token: instructor.token, body: { action, text: LESSON_TEXT } });
    assert.equal(data.mock, true);
    assert.ok(data.result.length > 0, action);
    assert.ok(!/<script/i.test(data.result));
  }
  const seo = await expectStatus('/api/ai/write', 200, { method: 'POST', token: instructor.token,
    body: { action: 'seo', title: 'เริ่มต้นกับ Cloudflare Workers', text: LESSON_TEXT } });
  assert.ok(seo.titles.length >= 1 && seo.titles.every(t => t.length <= 60));
  assert.ok(seo.excerpt.length > 0 && seo.excerpt.length <= 155);
  // HTML from the editor is treated as data
  const stripped = await expectStatus('/api/ai/write', 200, { method: 'POST', token: instructor.token,
    body: { action: 'improve', text: '<script>alert(1)</script><b>สวัสดี</b> ครับ   ทุกคน' } });
  assert.ok(!stripped.result.includes('<'));
  await expectStatus('/api/ai/write', 400, { method: 'POST', token: instructor.token, body: { action: 'hack', text: 'x' } });
  await expectStatus('/api/ai/write', 403, { method: 'POST', token: student1.token, body: { action: 'improve', text: 'x' } });
});

test('website chatbot answers from published data only and refuses off-topic questions', async () => {
  const keyword = 'Zyxquorp';
  await expectStatus('/api/instructor/courses', 201, { method: 'POST', token: instructor.token,
    body: { title: `${keyword} Secret Draft Course`, description: `ร่างลับ ${keyword} ราคา 99999`, price: 99999 } });

  const config = await expectStatus('/api/ai/public/config', 200);
  assert.equal(config.chatbot_enabled, true);

  const found = await expectStatus('/api/ai/public/chat', 200, { method: 'POST', body: { message: 'มีคอร์ส Cloudflare Workers ไหม ราคาเท่าไร' } });
  assert.equal(found.mock, true);
  assert.equal(found.refused, false);
  assert.ok(found.sources.some(s => s.title.includes('Cloudflare Workers') && s.url === '/courses'), JSON.stringify(found.sources));
  assert.match(found.reply, /Cloudflare Workers/);

  for (const message of [`${keyword} ราคาเท่าไร`, `มีคอร์ส ${keyword} ไหม`, `${keyword}`]) {
    const data = await expectStatus('/api/ai/public/chat', 200, { method: 'POST', body: { message } });
    assert.ok(!JSON.stringify(data.sources).includes(keyword), `draft course leaked for "${message}"`);
    assert.ok(!data.reply.includes(keyword), `draft course leaked in reply for "${message}"`);
    assert.ok(!data.reply.includes('99999'));
  }

  const offTopic = await expectStatus('/api/ai/public/chat', 200, { method: 'POST', body: { message: 'ช่วยแนะนำสูตรทำต้มยำกุ้งหน่อย' } });
  assert.equal(offTopic.refused, true);
  assert.deepEqual(offTopic.sources, []);

  const handoff = await expectStatus('/api/ai/public/chat', 200, { method: 'POST', body: { message: 'อยากให้เจ้าหน้าที่ติดต่อกลับเรื่องอบรมสำหรับองค์กร' } });
  assert.equal(handoff.handoff, true);
  await expectStatus('/api/ai/public/chat', 400, { method: 'POST', body: { message: '' } });
});

test('daily quota is enforced per user; admins are not limited', async () => {
  const me = await expectStatus('/api/ai/me', 200, { token: instructor.token });
  assert.equal(me.unlimited, false);
  await setAi({ daily_quota: me.used + 1 });
  await expectStatus('/api/ai/outline', 200, { method: 'POST', token: instructor.token, body: { topic: 'Quota test' } });
  const blocked = await post('/api/ai/outline', instructor.token, { topic: 'Quota test' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.quota_exceeded, true);
  const after = await expectStatus('/api/ai/me', 200, { token: instructor.token });
  assert.equal(after.used, me.used + 1);
  await expectStatus('/api/ai/outline', 200, { method: 'POST', token: admin.token, body: { topic: 'Admin is unlimited' } });
  await setAi({ daily_quota: 50 });
  await expectStatus('/api/ai/outline', 200, { method: 'POST', token: instructor.token, body: { topic: 'Quota restored' } });
});

test('admin settings toggle features; only managers may change settings', async () => {
  await expectStatus('/api/admin/ai/settings', 403, { method: 'PUT', token: instructor.token, body: { daily_quota: 1 } });
  await expectStatus('/api/admin/ai/settings', 403, { token: student1.token });
  await expectStatus('/api/admin/ai/settings', 400, { method: 'PUT', token: admin.token, body: { daily_quota: -1 } });

  let settings = await setAi({ features: { outline: false, chatbot: false } });
  assert.equal(settings.features.outline, false);
  assert.equal(settings.features.quiz, true, 'other switches are kept');
  const off = await post('/api/ai/outline', instructor.token, { topic: 'Disabled' });
  assert.equal(off.status, 403);
  assert.equal(off.data.disabled, true);
  assert.equal((await expectStatus('/api/ai/public/config', 200)).chatbot_enabled, false);
  await expectStatus('/api/ai/public/chat', 403, { method: 'POST', body: { message: 'มีคอร์ส AWS ไหม' } });
  const me = await expectStatus('/api/ai/me', 200, { token: instructor.token });
  assert.equal(me.features.outline, false);

  settings = await setAi({ features: { outline: true, chatbot: true } });
  assert.equal(settings.features.outline, true);
  await expectStatus('/api/ai/outline', 200, { method: 'POST', token: instructor.token, body: { topic: 'Enabled again' } });

  const read = await expectStatus('/api/admin/ai/settings', 200, { token: admin.token });
  assert.equal(read.ai_available, false);
  assert.equal(read.features.length, 6);
});

test('usage report lists feature totals and mock flags without storing prompt text', async () => {
  const usage = await expectStatus('/api/admin/ai/usage?days=7', 200, { token: admin.token });
  const outline = usage.by_feature.find(r => r.feature === 'outline');
  assert.ok(outline && outline.requests >= 3);
  assert.equal(outline.mock_requests, outline.requests);
  assert.ok(usage.by_feature.find(r => r.feature === 'chatbot').refused >= 1);
  assert.ok(usage.by_user.some(r => r.email === 'instructor@netprime.com'));
  assert.ok(usage.recent.length > 0);
  for (const row of usage.recent) {
    assert.deepEqual(Object.keys(row).sort(), ['created_at', 'feature', 'id', 'input_chars', 'mock', 'output_chars', 'status', 'tokens', 'user_id', 'user_name']);
  }
  await expectStatus('/api/admin/ai/usage', 403, { token: instructor.token });
});

test('existing learner tutor still answers with the local mock', async () => {
  const data = await expectStatus('/api/ai/chat', 200, { method: 'POST', token: student1.token, body: { message: 'Hono คืออะไร', history: [] } });
  assert.match(data.reply, /โหมดจำลองในเครื่อง/);
  assert.equal(data.mock, true);
});

test('public chatbot has a global daily cap: past it, no model call (answers from site data)', async () => {
  await expectStatus('/api/admin/ai/settings', 400, { method: 'PUT', token: admin.token, body: { chatbot_daily_cap: -1 } });
  const defaults = await expectStatus('/api/admin/ai/settings', 200, { token: admin.token });
  assert.equal(typeof defaults.settings.chatbot_daily_cap, 'number');
  const settings = await setAi({ chatbot_daily_cap: 0 });
  assert.equal(settings.chatbot_daily_cap, 0);
  try {
    const capped = await expectStatus('/api/ai/public/chat', 200, { method: 'POST', body: { message: 'มีคอร์ส AWS ไหม' } });
    assert.equal(capped.capped, true);
    assert.equal(capped.mock, true);
    assert.ok(capped.reply.length > 0);
  } finally {
    await setAi({ chatbot_daily_cap: 500 });
  }
});

test('public chatbot is rate limited per IP', async () => {
  await setAi({ chatbot_per_ip: 3 });
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await post('/api/ai/public/chat', null, { message: 'มีคอร์ส AWS ไหม' })).status);
  }
  assert.ok(statuses.includes(429), JSON.stringify(statuses));
  await setAi({ chatbot_per_ip: 20 });
});
