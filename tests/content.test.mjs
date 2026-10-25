import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { expectStatus, login, request } from './helpers.mjs';

// Course structure & content: chapters, categories, lesson types, drip/sequential locks,
// prerequisites and SCORM 1.2 packages.

let admin, coord, instructor, other, student, outsider;
const base = process.env.NETPRIME_TEST_BASE;
const post = (path, token, body) => request(path, { method: 'POST', token, body });
const put = (path, token, body) => request(path, { method: 'PUT', token, body });
const patch = (path, token, body) => request(path, { method: 'PATCH', token, body });

/** Raw request (binary bodies, non-JSON responses). */
async function raw(path, { token, method = 'GET', body, contentType } = {}) {
  const response = await fetch(path.startsWith('http') ? path : `${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(contentType ? { 'Content-Type': contentType } : {}) },
    body,
    signal: AbortSignal.timeout(20000)
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, buffer, text: buffer.toString('utf8') };
}

/** Minimal ZIP writer: [{ name, data, deflate }] → Buffer (stored or deflate entries). */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const body = file.deflate ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(file.deflate ? 8 : 0, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="netprime.test" version="1.0" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org1">
    <organization identifier="org1"><title>Test</title>
      <item identifier="item1" identifierref="res1"><title>บทที่ 1</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res1" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/><file href="js/app.js"/>
    </resource>
  </resources>
</manifest>`;

async function newCourse(token, title, extra = {}) {
  const created = await expectStatus('/api/instructor/courses', 201, { method: 'POST', token, body: { title, description: 'Content suite fixture', price: 0, ...extra } });
  return created.course.id;
}

async function addLesson(token, courseId, body, status = 201) {
  const res = await post(`/api/instructor/courses/${courseId}/lessons`, token, body);
  assert.equal(res.status, status, JSON.stringify(res.data));
  return res.data.lesson;
}

const doc = text => JSON.stringify([{ id: 'b1', type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] }]);

before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  coord = await login('coord@netprime.com', 'coord123');
  instructor = await login('instructor@netprime.com', 'inst123');
  student = await login('student3@netprime.com', 'stud123');
  outsider = await login('student1@netprime.com', 'stud123');
  const created = await post('/api/admin/accounts', admin.token, {
    email: 'content-instructor@example.invalid', name: 'ผู้สอนอีกคน', password: 'content-instructor-1', roles: ['instructor']
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  other = await login('content-instructor@example.invalid', 'content-instructor-1');
});

let courseId; // instructor course with chapters, categories, text/embed/pdf/SCORM lessons
let textLesson, embedLesson, chapterLesson;

test('chapters: create, reorder lessons across chapters, ownership enforced', async () => {
  courseId = await newCourse(instructor.token, 'Content Builder Course');
  const s1 = (await expectStatus(`/api/instructor/courses/${courseId}/sections`, 201, { method: 'POST', token: instructor.token, body: { title: 'บทที่ 1' } })).section;
  const s2 = (await expectStatus(`/api/instructor/courses/${courseId}/sections`, 201, { method: 'POST', token: instructor.token, body: { title: 'บทที่ 2' } })).section;
  await expectStatus(`/api/instructor/courses/${courseId}/sections`, 400, { method: 'POST', token: instructor.token, body: { title: '  ' } });

  textLesson = await addLesson(instructor.token, courseId, { title: 'อ่านก่อนเรียน', type: 'text', content_json: doc('สวัสดี'), content_md: 'สวัสดี' });
  embedLesson = await addLesson(instructor.token, courseId, { title: 'สไลด์', type: 'embed', embed_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', section_id: s1.id });
  chapterLesson = await addLesson(instructor.token, courseId, { title: 'สรุป', type: 'text', content_md: '# สรุป', section_id: s2.id });

  // Move chapter 2 first and put the loose text lesson into it
  await expectStatus(`/api/instructor/courses/${courseId}/structure`, 200, { method: 'PUT', token: instructor.token,
    body: { unsectioned: [], sections: [{ id: s2.id, lesson_ids: [chapterLesson.id, textLesson.id] }, { id: s1.id, lesson_ids: [embedLesson.id] }] } });
  const outline = await expectStatus(`/api/instructor/courses/${courseId}/outline`, 200, { token: instructor.token });
  assert.deepEqual(outline.sections.map(s => s.id), [s2.id, s1.id]);
  assert.deepEqual(outline.lessons.map(l => l.id), [chapterLesson.id, textLesson.id, embedLesson.id]);
  assert.equal(outline.lessons[1].section_id, s2.id);

  // Every lesson must be listed exactly once
  await expectStatus(`/api/instructor/courses/${courseId}/structure`, 409, { method: 'PUT', token: instructor.token,
    body: { unsectioned: [], sections: [{ id: s2.id, lesson_ids: [chapterLesson.id] }, { id: s1.id, lesson_ids: [embedLesson.id] }] } });
  await expectStatus(`/api/instructor/courses/${courseId}/structure`, 409, { method: 'PUT', token: instructor.token,
    body: { unsectioned: [textLesson.id], sections: [{ id: s2.id, lesson_ids: [chapterLesson.id, textLesson.id] }, { id: s1.id, lesson_ids: [embedLesson.id] }] } });

  // Another instructor cannot touch this course
  await expectStatus(`/api/instructor/courses/${courseId}/structure`, 403, { method: 'PUT', token: other.token,
    body: { unsectioned: [], sections: [{ id: s2.id, lesson_ids: [chapterLesson.id, textLesson.id] }, { id: s1.id, lesson_ids: [embedLesson.id] }] } });
  await expectStatus(`/api/instructor/courses/${courseId}/sections`, 403, { method: 'POST', token: other.token, body: { title: 'x' } });
  await expectStatus(`/api/instructor/sections/${s1.id}`, 403, { method: 'PATCH', token: other.token, body: { title: 'x' } });
  await expectStatus(`/api/instructor/sections/${s1.id}`, 403, { method: 'DELETE', token: other.token });
  await expectStatus(`/api/instructor/lessons/${textLesson.id}/settings`, 403, { method: 'PATCH', token: other.token, body: { title: 'x' } });
  await expectStatus(`/api/instructor/courses/${courseId}/lessons`, 403, { method: 'POST', token: other.token, body: { title: 'x', type: 'text' } });
  // Lessons cannot be moved into another course's chapter
  const foreignCourse = await newCourse(other.token, 'Other Course');
  const foreignSection = (await expectStatus(`/api/instructor/courses/${foreignCourse}/sections`, 201, { method: 'POST', token: other.token, body: { title: 'อื่น' } })).section;
  await expectStatus(`/api/instructor/lessons/${textLesson.id}/settings`, 400, { method: 'PATCH', token: instructor.token, body: { section_id: foreignSection.id } });

  await expectStatus(`/api/instructor/sections/${s1.id}`, 200, { method: 'PATCH', token: instructor.token, body: { title: 'บทนำ' } });
});

test('categories: managed by approvers/designers, assigned to courses and filter the catalog', async () => {
  await expectStatus('/api/admin/course-categories', 403, { method: 'POST', token: instructor.token, body: { name: 'Cloud' } });
  await expectStatus('/api/admin/course-categories', 401, { method: 'POST', body: { name: 'Cloud' } });
  const cloud = (await expectStatus('/api/admin/course-categories', 201, { method: 'POST', token: admin.token, body: { name: 'Cloud', slug: 'cloud' } })).category;
  // Coordinators hold website.design
  const net = (await expectStatus('/api/admin/course-categories', 201, { method: 'POST', token: coord.token, body: { name: 'เครือข่าย' } })).category;
  assert.match(net.slug, /^cat-/);
  await expectStatus('/api/admin/course-categories', 409, { method: 'POST', token: admin.token, body: { name: 'Cloud 2', slug: 'cloud' } });
  await expectStatus('/api/admin/course-categories', 400, { method: 'POST', token: admin.token, body: { name: 'Bad', slug: 'Not A Slug' } });
  await expectStatus(`/api/admin/course-categories/${net.id}`, 200, { method: 'PATCH', token: coord.token, body: { sort_order: 9 } });

  await expectStatus(`/api/instructor/courses/${courseId}/details`, 400, { method: 'PUT', token: instructor.token, body: { category_id: 'cat_missing' } });
  await expectStatus(`/api/instructor/courses/${courseId}/details`, 403, { method: 'PUT', token: other.token, body: { category_id: cloud.id } });
  await expectStatus(`/api/instructor/courses/${courseId}/details`, 200, { method: 'PUT', token: instructor.token, body: { category_id: cloud.id } });
  await expectStatus(`/api/admin/courses/${courseId}/approve`, 200, { method: 'POST', token: admin.token });

  const filtered = await expectStatus('/api/courses?category=cloud', 200);
  assert.deepEqual(filtered.map(c => c.id), [courseId]);
  assert.equal(filtered[0].category_slug, 'cloud');
  assert.equal((await expectStatus(`/api/courses?category=${cloud.id}`, 200, { token: student.token })).length, 1);
  assert.equal((await expectStatus('/api/courses?category=nothing-here', 200)).length, 0);
  const all = await expectStatus('/api/courses', 200);
  assert.ok(all.length > 1);
  const categories = (await expectStatus('/api/course-categories', 200)).categories;
  assert.equal(categories.find(c => c.id === cloud.id).course_count, 1);
  assert.equal(categories.find(c => c.id === net.id).course_count, 0);

  // Deleting a category leaves courses uncategorized
  await expectStatus(`/api/admin/course-categories/${net.id}`, 200, { method: 'DELETE', token: admin.token });
  await expectStatus(`/api/admin/course-categories/${net.id}`, 404, { method: 'DELETE', token: admin.token });
});

test('sales-page fields are validated, saved and returned by the public overview', async () => {
  await expectStatus(`/api/instructor/courses/${courseId}/details`, 400, { method: 'PUT', token: instructor.token, body: { level: 'expert' } });
  await expectStatus(`/api/instructor/courses/${courseId}/details`, 400, { method: 'PUT', token: instructor.token, body: { promo_video_url: 'https://evil.example.com/v.mp4' } });
  await expectStatus(`/api/instructor/courses/${courseId}/details`, 400, { method: 'PUT', token: instructor.token, body: { faq: [{ question: 'ถาม' }] } });
  await expectStatus(`/api/instructor/courses/${courseId}/details`, 200, { method: 'PUT', token: instructor.token, body: {
    subtitle: 'เรียนรู้ Cloud แบบลงมือทำ', learning_outcomes: ['Deploy Worker', 'ใช้ D1'], requirements: ['พื้นฐาน JavaScript'],
    target_audience: ['นักพัฒนา'], level: 'beginner', language: 'ไทย', duration_hours: 4.5,
    promo_video_url: 'https://youtu.be/dQw4w9WgXcQ', faq: [{ question: 'ได้ใบประกาศไหม', answer: 'ได้' }]
  } });
  const overview = await expectStatus(`/api/courses/${courseId}/overview`, 200);
  assert.equal(overview.course.subtitle, 'เรียนรู้ Cloud แบบลงมือทำ');
  assert.deepEqual(overview.course.learning_outcomes, ['Deploy Worker', 'ใช้ D1']);
  assert.equal(overview.course.level, 'beginner');
  assert.equal(overview.course.duration_hours, 4.5);
  assert.equal(overview.course.promo_video_embed, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(overview.course.faq[0].answer, 'ได้');
  assert.equal(overview.course.category.slug, 'cloud');
  assert.equal(overview.course.lesson_count, 3);
  assert.deepEqual(overview.curriculum.map(s => s.title), ['บทที่ 2', 'บทนำ']);
  assert.equal(overview.curriculum[0].lessons[0].title, 'สรุป');
  assert.equal(overview.curriculum[0].lessons[0].content_md, undefined, 'overview never includes lesson content');
  // Drafts are not public
  const draft = await newCourse(instructor.token, 'Draft only');
  await expectStatus(`/api/courses/${draft}/overview`, 404);
});

test('text and embed lessons: allowlisted embeds only, content behind enrollment, mark as read', async () => {
  for (const url of ['https://evil.example.com/page', 'http://www.youtube.com/watch?v=dQw4w9WgXcQ', 'javascript:alert(1)',
    'https://notion.site/x', 'https://docs.google.com/spreadsheets-fake/d/abc']) {
    const res = await post(`/api/instructor/courses/${courseId}/lessons`, instructor.token, { title: 'Bad embed', type: 'embed', embed_url: url });
    assert.equal(res.status, 400, url);
  }
  await addLesson(instructor.token, courseId, { title: 'No URL', type: 'embed' }, 400);
  await expectStatus(`/api/instructor/lessons/${embedLesson.id}/settings`, 400, { method: 'PATCH', token: instructor.token, body: { embed_url: 'https://example.com/x' } });
  await expectStatus(`/api/instructor/lessons/${embedLesson.id}/settings`, 200, { method: 'PATCH', token: instructor.token,
    body: { embed_url: 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit#slide=id.p' } });

  // Not enrolled yet
  await expectStatus(`/api/student/lessons/${textLesson.id}/content`, 403, { token: student.token });
  await expectStatus(`/api/courses/${courseId}/enroll`, 201, { method: 'POST', token: student.token });

  const text = await expectStatus(`/api/student/lessons/${textLesson.id}/content`, 200, { token: student.token });
  assert.equal(text.lesson.type, 'text');
  assert.equal(JSON.parse(text.content_json)[0].content[0].text, 'สวัสดี');
  assert.equal(text.completed, false);
  const embed = await expectStatus(`/api/student/lessons/${embedLesson.id}/content`, 200, { token: student.token });
  assert.equal(embed.embed_src, 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/embed');
  assert.equal(embed.content_json, null);

  const done = await expectStatus(`/api/student/lessons/${textLesson.id}/complete`, 200, { method: 'POST', token: student.token });
  assert.equal(done.progress_percent, 33);
  const detail = await expectStatus(`/api/courses/${courseId}`, 200, { token: student.token });
  assert.equal(detail.lessons.find(l => l.id === textLesson.id).completed, 1);
  assert.equal(detail.sections.length, 2);
  assert.equal(detail.lessons[0].type, 'text');
  // Instructors preview without enrolling
  const preview = await expectStatus(`/api/student/lessons/${chapterLesson.id}/content`, 200, { token: instructor.token });
  assert.equal(preview.preview, true);
  await expectStatus(`/api/student/lessons/${chapterLesson.id}/content`, 403, { token: other.token });
});

test('PDF lessons: owner-prefixed uploads only, streamed inline to enrolled learners', async () => {
  const pdf = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
  const ticket = await expectStatus('/api/instructor/upload/presign', 200, { method: 'POST', token: instructor.token,
    body: { filename: 'slides.pdf', type: 'handout', size: Buffer.byteLength(pdf), mimeType: 'application/pdf' } });
  const uploaded = await raw(`/api${ticket.uploadUrl}`, { token: instructor.token, method: 'PUT', body: pdf, contentType: 'application/pdf' });
  assert.equal(uploaded.status, 200, uploaded.text);

  await addLesson(instructor.token, courseId, { title: 'PDF ไม่มีไฟล์', type: 'pdf' }, 400);
  // Someone else's key cannot be attached
  const foreign = await newCourse(other.token, 'Foreign PDF');
  const stolen = await post(`/api/instructor/courses/${foreign}/lessons`, other.token, { title: 'ขโมย', type: 'pdf', pdf_r2_key: ticket.key });
  assert.equal(stolen.status, 403, JSON.stringify(stolen.data));
  await addLesson(instructor.token, courseId, { title: 'ไม่มีไฟล์จริง', type: 'pdf', pdf_r2_key: `uploads/${instructor.user.id}/handouts/missing.pdf` }, 403);

  const lesson = await addLesson(instructor.token, courseId, { title: 'เอกสาร PDF', type: 'pdf', pdf_r2_key: ticket.key });
  const anonymous = await raw(`/api/student/lessons/${lesson.id}/pdf`);
  assert.equal(anonymous.status, 401);
  const notEnrolled = await raw(`/api/student/lessons/${lesson.id}/pdf`, { token: outsider.token });
  assert.equal(notEnrolled.status, 403);
  const viewed = await raw(`/api/student/lessons/${lesson.id}/pdf`, { token: student.token });
  assert.equal(viewed.status, 200);
  assert.equal(viewed.headers.get('content-type'), 'application/pdf');
  assert.match(viewed.headers.get('content-disposition'), /^inline/);
  assert.match(viewed.headers.get('cache-control'), /no-store/);
  assert.ok(viewed.text.startsWith('%PDF-1.4'));
  const info = await expectStatus(`/api/student/lessons/${lesson.id}/content`, 200, { token: student.token });
  assert.equal(info.has_pdf, true);
  assert.equal(JSON.stringify(info).includes(ticket.key), false, 'the R2 key is never sent to learners');
  // PDF lessons are completed with "mark as read"
  await expectStatus(`/api/student/lessons/${lesson.id}/complete`, 200, { method: 'POST', token: student.token });
});

test('drip and sequential locks are enforced by the server', async () => {
  const course = await newCourse(instructor.token, 'Drip Course');
  const a = await addLesson(instructor.token, course, { title: 'A', type: 'text', content_md: 'A' });
  const b = await addLesson(instructor.token, course, { title: 'B', type: 'text', content_md: 'B' });
  const later = await addLesson(instructor.token, course, { title: 'C', type: 'text', content_md: 'C', available_after_days: 3 });
  const dated = await addLesson(instructor.token, course, { title: 'D', type: 'text', content_md: 'D', available_on: '2099-01-01' });
  await addLesson(instructor.token, course, { title: 'bad date', type: 'text', available_on: '01/01/2099' }, 400);
  await expectStatus(`/api/instructor/courses/${course}/details`, 400, { method: 'PUT', token: instructor.token, body: { sequential: 'yes' } });
  await expectStatus(`/api/instructor/courses/${course}/details`, 200, { method: 'PUT', token: instructor.token, body: { sequential: true } });
  await expectStatus(`/api/admin/courses/${course}/approve`, 200, { method: 'POST', token: admin.token });
  await expectStatus(`/api/courses/${course}/enroll`, 201, { method: 'POST', token: student.token });

  let detail = await expectStatus(`/api/courses/${course}`, 200, { token: student.token });
  const state = id => detail.lessons.find(l => l.id === id);
  assert.equal(state(a.id).locked, false);
  assert.equal(state(b.id).locked, true);
  assert.equal(state(b.id).lock_reason, 'sequence');
  assert.equal(state(later.id).lock_reason, 'drip');
  assert.ok(Date.parse(state(later.id).unlock_at) > Date.now() + 2 * 86400000);
  assert.equal(state(dated.id).lock_reason, 'date');
  assert.equal(state(dated.id).unlock_at, '2098-12-31T17:00:00.000Z');

  // Locked content, completion and progress are refused
  const blocked = await expectStatus(`/api/student/lessons/${b.id}/content`, 403, { token: student.token });
  assert.equal(blocked.lock_reason, 'sequence');
  await expectStatus(`/api/student/lessons/${b.id}/complete`, 403, { method: 'POST', token: student.token });
  await expectStatus(`/api/student/lessons/${b.id}/progress`, 403, { method: 'POST', token: student.token, body: { resume_seconds: 1, completed: 1 } });
  await expectStatus(`/api/lessons/${b.id}/video`, 403, { token: student.token });

  await expectStatus(`/api/student/lessons/${a.id}/complete`, 200, { method: 'POST', token: student.token });
  await expectStatus(`/api/student/lessons/${b.id}/content`, 200, { token: student.token });
  await expectStatus(`/api/student/lessons/${b.id}/complete`, 200, { method: 'POST', token: student.token });
  const drip = await expectStatus(`/api/student/lessons/${later.id}/content`, 403, { token: student.token });
  assert.equal(drip.lock_reason, 'drip');
  assert.ok(drip.unlock_at);
  await expectStatus(`/api/student/lessons/${dated.id}/content`, 403, { token: student.token });
  detail = await expectStatus(`/api/courses/${course}`, 200, { token: student.token });
  assert.equal(detail.lessons.find(l => l.id === b.id).locked, false);
  assert.equal(detail.enrollment.progress_percent, 50);

  // Course staff are never locked out
  await expectStatus(`/api/student/lessons/${dated.id}/content`, 200, { token: instructor.token });
  await expectStatus(`/api/student/lessons/${dated.id}/content`, 200, { token: admin.token });

  // Regression: exams, assignments and video questions attached to a locked lesson are locked too.
  const [qid] = (await expectStatus(`/api/instructor/courses/${course}/questions/bulk`, 201, { method: 'POST', token: instructor.token,
    body: { questions: [{ type: 'single', prompt: 'ล็อก', options: ['a', 'b'], correct: [0] }] } })).ids;
  const exam = await expectStatus(`/api/instructor/courses/${course}/exams`, 201, { method: 'POST', token: instructor.token,
    body: { title: 'สอบท้ายบท D', lesson_id: dated.id, question_ids: [qid], status: 'published' } });
  assert.equal((await expectStatus(`/api/student/exams/${exam.exam.id}/start`, 403, { method: 'POST', token: student.token })).locked, true);
  const task = await expectStatus(`/api/instructor/courses/${course}/assignments`, 201, { method: 'POST', token: instructor.token,
    body: { lesson_id: dated.id, title: 'งานบท D', status: 'published' } });
  assert.equal((await expectStatus(`/api/student/assignments/${task.assignment.id}`, 403, { token: student.token })).locked, true);
  await expectStatus(`/api/student/assignments/${task.assignment.id}/submit`, 403, { method: 'POST', token: student.token, body: { text: 'x' } });
  const vq = await expectStatus(`/api/instructor/lessons/${dated.id}/video-questions`, 201, { method: 'POST', token: instructor.token,
    body: { timestamp_seconds: 3, type: 'single', prompt: 'ล็อก', options: ['a', 'b'], correct: [0] } });
  assert.equal((await expectStatus(`/api/student/lessons/${dated.id}/video-questions`, 403, { token: student.token })).locked, true);
  await expectStatus(`/api/student/video-questions/${vq.question.id}/answer`, 403, { method: 'POST', token: student.token, body: { response: 0 } });

  // Regression: learners never get storage keys from the course page, and the R2 video proxy applies the same locks.
  const key = `videos/locked-${Date.now()}.mp4`;
  const video = await addLesson(admin.token, course, { title: 'E', type: 'video', video_provider: 'cloudflare', video_stream_uid: key,
    handout_r2_key: `handouts/locked-${Date.now()}.pdf`, available_on: '2099-01-01' });
  const learnerView = (await expectStatus(`/api/courses/${course}`, 200, { token: student.token })).lessons.find(l => l.id === video.id);
  assert.equal('video_stream_uid' in learnerView, false);
  assert.equal('handout_r2_key' in learnerView, false);
  assert.equal(learnerView.has_video, true);
  assert.equal(learnerView.has_handout, true);
  const staffView = (await expectStatus(`/api/courses/${course}`, 200, { token: instructor.token })).lessons.find(l => l.id === video.id);
  assert.equal(staffView.video_stream_uid, key);
  const proxied = await request(`/api/student/video?token=${encodeURIComponent(student.token)}&key=${encodeURIComponent(key)}`);
  assert.equal(proxied.status, 403, JSON.stringify(proxied.data));
  assert.equal(proxied.data.locked, true);
  // Staff pass the lock check (and then find no stored file in this test).
  assert.equal((await request(`/api/student/video?token=${encodeURIComponent(instructor.token)}&key=${encodeURIComponent(key)}`)).status, 404);
});

test('prerequisite courses block enrollment until completed', async () => {
  const basics = await newCourse(instructor.token, 'Basics');
  const basicsLesson = await addLesson(instructor.token, basics, { title: 'Intro', type: 'text', content_md: 'intro' });
  const advanced = await newCourse(instructor.token, 'Advanced');
  await addLesson(instructor.token, advanced, { title: 'Deep', type: 'text', content_md: 'deep' });
  const otherDraft = await newCourse(other.token, 'Someone else draft');

  await expectStatus(`/api/instructor/courses/${advanced}/details`, 400, { method: 'PUT', token: instructor.token, body: { prerequisite_ids: [advanced] } });
  await expectStatus(`/api/instructor/courses/${advanced}/details`, 400, { method: 'PUT', token: instructor.token, body: { prerequisite_ids: [otherDraft] } });
  await expectStatus(`/api/instructor/courses/${advanced}/details`, 200, { method: 'PUT', token: instructor.token, body: { prerequisite_ids: [basics] } });
  // No cycles
  await expectStatus(`/api/instructor/courses/${basics}/details`, 400, { method: 'PUT', token: instructor.token, body: { prerequisite_ids: [advanced] } });
  for (const id of [basics, advanced]) await expectStatus(`/api/admin/courses/${id}/approve`, 200, { method: 'POST', token: admin.token });

  const refused = await expectStatus(`/api/courses/${advanced}/enroll`, 403, { method: 'POST', token: student.token });
  assert.match(refused.error, /Basics/);
  assert.deepEqual(refused.missing_prerequisites.map(p => p.id), [basics]);
  const overview = await expectStatus(`/api/courses/${advanced}/overview`, 200);
  assert.deepEqual(overview.prerequisites.map(p => p.id), [basics]);

  await expectStatus(`/api/courses/${basics}/enroll`, 201, { method: 'POST', token: student.token });
  await expectStatus(`/api/student/lessons/${basicsLesson.id}/complete`, 200, { method: 'POST', token: student.token });
  const enrolled = await expectStatus(`/api/courses/${advanced}/enroll`, 201, { method: 'POST', token: student.token });
  assert.equal(enrolled.enrollment.course_id, advanced);
  const detail = await expectStatus(`/api/courses/${advanced}`, 200, { token: student.token });
  assert.equal(detail.prerequisites[0].completed, 1);
});

test('SCORM 1.2: upload, manifest launch, API commit completes the lesson, unsafe packages rejected', async () => {
  const lesson = await addLesson(instructor.token, courseId, { title: 'แบบฝึก SCORM', type: 'scorm' });
  const zip = makeZip([
    { name: 'imsmanifest.xml', data: MANIFEST, deflate: true },
    { name: 'index.html', data: '<!doctype html><html><body><h1>SCORM บทที่ 1</h1><script src="js/app.js"></script></body></html>', deflate: true },
    { name: 'js/app.js', data: 'window.parent.API.LMSInitialize("");' }
  ]);
  const upload = (body, token = instructor.token, id = lesson.id) =>
    raw(`/api/instructor/lessons/${id}/scorm`, { token, method: 'PUT', body, contentType: 'application/zip' });

  assert.equal((await upload(zip, other.token)).status, 403);
  const slip = await upload(makeZip([{ name: 'imsmanifest.xml', data: MANIFEST }, { name: '../evil.html', data: 'x' }, { name: 'index.html', data: 'x' }]));
  assert.equal(slip.status, 400, slip.text);
  assert.match(JSON.parse(slip.text).error, /ไม่ปลอดภัย/);
  assert.equal((await upload(makeZip([{ name: 'index.html', data: 'x' }]))).status, 400, 'manifest required');
  assert.equal((await upload(Buffer.from('not a zip at all, definitely'))).status, 400);
  const scorm2004 = MANIFEST.replace('<schemaversion>1.2</schemaversion>', '<schemaversion>2004 4th Edition</schemaversion>');
  assert.equal((await upload(makeZip([{ name: 'imsmanifest.xml', data: scorm2004 }, { name: 'index.html', data: 'x' }]))).status, 400);

  // Regression: one entry is capped at 20 MB uncompressed (Worker memory), even when it compresses to almost nothing.
  const huge = await upload(makeZip([{ name: 'imsmanifest.xml', data: MANIFEST }, { name: 'index.html', data: 'x' },
    { name: 'video.bin', data: Buffer.alloc(21 * 1024 * 1024), deflate: true }]));
  assert.equal(huge.status, 400, huge.text);
  assert.match(JSON.parse(huge.text).error, /20 MB/);

  const ok = await upload(zip);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(JSON.parse(ok.text).scorm_launch, 'index.html');

  // Launch: enrolled learners only (student3 enrolled earlier), never for outsiders
  await expectStatus(`/api/student/lessons/${lesson.id}/scorm/launch`, 403, { token: outsider.token });
  const { url } = await expectStatus(`/api/student/lessons/${lesson.id}/scorm/launch`, 200, { token: student.token });
  assert.ok(url.startsWith(`${base}/api/scorm/${lesson.id}/`), url);
  const player = await raw(url);
  assert.equal(player.status, 200);
  assert.match(player.headers.get('content-type'), /text\/html/);
  assert.match(player.headers.get('content-security-policy'), /frame-ancestors/);
  assert.match(player.text, /LMSInitialize/);
  assert.match(player.text, /"c\/" \+ "index.html"/);

  const root = url.replace(/\/player$/, '');
  const page = await raw(`${root}/c/index.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.text, /SCORM บทที่ 1/);
  const script = await raw(`${root}/c/js/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal((await raw(`${root}/c/%2e%2e/%2e%2e/imsmanifest.xml`)).status, 404);
  assert.equal((await raw(`${root}/c/missing.html`)).status, 404);
  const forged = root.replace(/\.[\w-]+$/, '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal((await raw(`${forged}/c/index.html`)).status, 401);

  // Progress cannot be faked through the video progress endpoint
  await expectStatus(`/api/student/lessons/${lesson.id}/progress`, 200, { method: 'POST', token: student.token, body: { resume_seconds: 0, completed: 1 } });
  assert.equal((await expectStatus(`/api/student/lessons/${lesson.id}/progress`, 200, { token: student.token })).completed, 0);
  await expectStatus(`/api/student/lessons/${lesson.id}/complete`, 400, { method: 'POST', token: student.token });

  const commit = body => raw(`${root}/commit`, { method: 'POST', body: JSON.stringify(body), contentType: 'application/json' });
  let saved = JSON.parse((await commit({ cmi: { lesson_status: 'incomplete', suspend_data: 'page=2', lesson_location: '2' } })).text);
  assert.equal(saved.saved, true);
  assert.equal(saved.completed, false);
  // Resume data comes back in the next launch
  const again = await raw(url);
  assert.match(again.text, /"cmi.core.entry":"resume"/);
  assert.match(again.text, /"cmi.suspend_data":"page=2"/);

  saved = JSON.parse((await commit({ cmi: { lesson_status: 'passed', score_raw: '90', session_time: '0000:01:30.00' }, finish: true })).text);
  assert.equal(saved.completed, true);
  assert.equal(saved.lesson_status, 'passed');
  assert.equal((await expectStatus(`/api/student/lessons/${lesson.id}/progress`, 200, { token: student.token })).completed, 1);
  // A later "incomplete" report does not undo a pass
  saved = JSON.parse((await commit({ cmi: { lesson_status: 'incomplete' } })).text);
  assert.equal(saved.lesson_status, 'passed');
  const third = await raw(url);
  assert.match(third.text, /"cmi.core.score.raw":"90"/);
  assert.match(third.text, /"cmi.core.total_time":"0000:01:30.00"/);

  assert.equal((await raw(`${forged}/commit`, { method: 'POST', body: '{"cmi":{}}', contentType: 'application/json' })).status, 401);
  // Staff preview launches but does not save
  const staffLaunch = await expectStatus(`/api/student/lessons/${lesson.id}/scorm/launch`, 200, { token: instructor.token });
  assert.equal(staffLaunch.preview, true);
  const staffSave = JSON.parse((await raw(`${staffLaunch.url.replace(/\/player$/, '')}/commit`, { method: 'POST', body: '{"cmi":{"lesson_status":"passed"}}', contentType: 'application/json' })).text);
  assert.equal(staffSave.saved, false);
});
