import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { createHmac, createECDH, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expectStatus, login, request } from './helpers.mjs';

let admin, coord, inst, s1, s2, s3;
before(async () => {
  [admin, coord, inst, s1, s2, s3] = await Promise.all([
    login('admin@netprime.com', 'admin123'), login('coord@netprime.com', 'coord123'), login('instructor@netprime.com', 'inst123'),
    login('student1@netprime.com', 'stud123'), login('student2@netprime.com', 'stud123'), login('student3@netprime.com', 'stud123')
  ]);
});

const b64url = buf => Buffer.from(buf).toString('base64url');
async function poll(fn, check, tries = 40) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (check(last)) return last;
    await delay(150);
  }
  return last;
}

test('notification preferences default on and validate input', async () => {
  const prefs = await expectStatus('/api/me/notification-preferences', 200, { token: s2.token });
  assert.deepEqual(prefs.preferences, { email_marketing: true, email_course: true, push: true, line: true });
  assert.equal(prefs.push.configured, false, 'no VAPID keys in the local harness');
  assert.equal(prefs.line.linked, false);
  await expectStatus('/api/me/notification-preferences', 400, { token: s2.token, method: 'PUT', body: { push: 'no' } });
  const saved = await expectStatus('/api/me/notification-preferences', 200, { token: s2.token, method: 'PUT', body: { push: false } });
  assert.equal(saved.preferences.push, false);
  assert.equal(saved.preferences.email_marketing, true);
  await expectStatus('/api/me/notification-preferences', 401, {});
});

test('broadcast audience, chunked delivery and unsubscribe preference', async () => {
  // student3 opted out of marketing email
  await expectStatus('/api/me/notification-preferences', 200, { token: s3.token, method: 'PUT', body: { email_marketing: false } });
  const audience = { rules: { roles: ['student'], enrolled_course_ids: ['course_cf_workers'] } };
  const preview = await expectStatus('/api/communication/audience/preview', 200, { token: coord.token, method: 'POST', body: { audience } });
  assert.equal(preview.count, 3, 'student1, student3 and the MIT student take course_cf_workers');
  await expectStatus('/api/communication/audience/preview', 400, { token: coord.token, method: 'POST', body: { audience: { rules: { roles: ['wizard'] } } } });
  await expectStatus('/api/communication/broadcasts', 403, { token: s1.token, method: 'POST', body: { title: 'x', body: 'y', channels: ['email'] } });
  await expectStatus('/api/communication/broadcasts', 400, { token: coord.token, method: 'POST', body: { title: 'x', body: 'y', channels: [] } });

  const created = await expectStatus('/api/communication/broadcasts', 201, { token: coord.token, method: 'POST', body: {
    title: 'ข่าวสารประจำเดือน', body: '**สวัสดี** ทุกคน <script>alert(1)</script> [ลิงก์](javascript:alert(1))',
    channels: ['email', 'in_app', 'push', 'line'], category: 'marketing', audience
  } });
  const id = created.broadcast.id;
  assert.equal(created.broadcast.status, 'draft');
  assert.match(created.broadcast.body_html, /<strong>สวัสดี<\/strong>/);
  assert.doesNotMatch(created.broadcast.body_html, /<script|javascript:/);

  const testSend = await expectStatus(`/api/communication/broadcasts/${id}/test`, 200, { token: coord.token, method: 'POST', body: {} });
  assert.equal(testSend.sent.email, 1);
  assert.equal(testSend.sent.in_app, 1);
  assert.equal(testSend.sent.push, 0, 'push is a no-op without VAPID');

  const queued = await expectStatus(`/api/communication/broadcasts/${id}/send`, 200, { token: coord.token, method: 'POST', body: { defer: true } });
  assert.equal(queued.status, 'sending');
  assert.equal(queued.recipient_count, 3);
  await expectStatus(`/api/communication/broadcasts/${id}/send`, 409, { token: coord.token, method: 'POST', body: {} });

  const first = await expectStatus(`/api/communication/broadcasts/${id}/process`, 200, { token: coord.token, method: 'POST', body: { limit: 2 } });
  assert.equal(first.processed, 2);
  assert.equal(first.remaining, 10, '3 recipients × 4 channels minus the first chunk');
  assert.equal(first.status, 'sending');
  let last = first;
  for (let i = 0; i < 10 && last.status !== 'sent'; i++) {
    last = await expectStatus(`/api/communication/broadcasts/${id}/process`, 200, { token: coord.token, method: 'POST', body: { limit: 5 } });
  }
  assert.equal(last.status, 'sent');
  const { delivery } = last;
  assert.equal(delivery.total, 12);
  assert.equal(delivery.by_channel.in_app.sent, 3);
  assert.equal(delivery.by_channel.email.sent, 2);
  assert.equal(delivery.by_channel.email.skipped, 1, 'opted-out learner is skipped');
  assert.equal(delivery.by_channel.push.skipped, 3);
  assert.equal(delivery.by_channel.line.skipped, 3);

  const detail = await expectStatus(`/api/communication/broadcasts/${id}`, 200, { token: coord.token });
  assert.ok(detail.issues.some(i => i.email === 'student3@netprime.com' && i.channel === 'email' && i.detail === 'unsubscribed'));
  assert.ok(detail.issues.some(i => i.channel === 'push' && i.detail === 'not_configured'));
  const inbox = await expectStatus('/api/notifications', 200, { token: s1.token });
  assert.ok(inbox.some(n => n.title === 'ข่าวสารประจำเดือน' && n.category === 'broadcast'));
  const history = await expectStatus('/api/communication/broadcasts', 200, { token: coord.token });
  assert.equal(history.broadcasts.find(b => b.id === id).delivery.by_status.sent, 5);
  await expectStatus(`/api/communication/broadcasts/${id}`, 404, { token: inst.token });
  await expectStatus(`/api/communication/broadcasts/${id}`, 409, { token: coord.token, method: 'DELETE' });
});

test('immediate send delivers after the response; scheduled send can be cancelled', async () => {
  const created = await expectStatus('/api/communication/broadcasts', 201, { token: admin.token, method: 'POST', body: {
    title: 'แจ้งปิดปรับปรุงระบบ', body: 'ระบบจะปิดปรับปรุงคืนนี้', channels: ['in_app'], category: 'system',
    audience: { rules: { partner_ids: ['partner_acme'], roles: ['student'] } }
  } });
  const sent = await expectStatus(`/api/communication/broadcasts/${created.broadcast.id}/send`, 200, { token: admin.token, method: 'POST', body: {} });
  assert.equal(sent.recipient_count, 2, 'student1 and student2 belong to Acme');
  const done = await poll(() => expectStatus(`/api/communication/broadcasts/${created.broadcast.id}`, 200, { token: admin.token }), d => d.broadcast.status === 'sent');
  assert.equal(done.broadcast.status, 'sent');
  assert.equal(done.broadcast.delivery.by_channel.in_app.sent, 2);

  const later = await expectStatus('/api/communication/broadcasts', 201, { token: coord.token, method: 'POST', body: {
    title: 'โปรโมชั่นปีใหม่', body: 'ลด 20%', channels: ['email'], audience: { rules: {} }
  } });
  const when = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const scheduled = await expectStatus(`/api/communication/broadcasts/${later.broadcast.id}/send`, 200, { token: coord.token, method: 'POST', body: { scheduled_at: when } });
  assert.equal(scheduled.status, 'scheduled');
  await expectStatus(`/api/communication/broadcasts/${later.broadcast.id}/send`, 400, { token: coord.token, method: 'POST', body: { scheduled_at: 'tomorrow-ish' } });
  const edited = await expectStatus(`/api/communication/broadcasts/${later.broadcast.id}`, 200, { token: coord.token, method: 'PUT', body: {
    title: 'โปรโมชั่นปีใหม่ 2570', body: 'ลด 25%', channels: ['email'], audience: { rules: {} }
  } });
  assert.equal(edited.broadcast.title, 'โปรโมชั่นปีใหม่ 2570');
  const cancelled = await expectStatus(`/api/communication/broadcasts/${later.broadcast.id}`, 200, { token: coord.token, method: 'DELETE' });
  assert.equal(cancelled.cancelled, true);
});

test('instructors broadcast only to learners of their own course', async () => {
  await expectStatus('/api/communication/broadcasts', 400, { token: inst.token, method: 'POST', body: { title: 'x', body: 'y', channels: ['in_app'] } });
  const created = await expectStatus('/api/communication/broadcasts', 201, { token: inst.token, method: 'POST', body: {
    title: 'การบ้านสัปดาห์นี้', body: 'ส่งภายในวันศุกร์', channels: ['in_app'], course_id: 'course_cf_workers',
    category: 'marketing', audience: { rules: {} }
  } });
  assert.equal(created.broadcast.category, 'course', 'instructor messages are course updates');
  assert.deepEqual(created.broadcast.audience, { rules: { enrolled_course_ids: ['course_cf_workers'] } });
  const list = await expectStatus('/api/communication/broadcasts', 200, { token: inst.token });
  assert.ok(list.broadcasts.every(b => b.created_by === 'usr_inst'));
  const meta = await expectStatus('/api/communication/meta', 200, { token: inst.token });
  assert.equal(meta.access, 'instructor');
  assert.equal(meta.channels.push, false);
  await expectStatus('/api/communication/meta', 200, { token: s1.token });
});

test('signed unsubscribe link: confirm page, one-click POST, tampering rejected', async () => {
  const config = JSON.parse(await readFile(new URL('../backend/wrangler.local.jsonc', import.meta.url), 'utf8'));
  const secret = config.vars.JWT_SECRET;
  const sign = (userId, category) => `${userId}.${category}.${b64url(createHmac('sha256', secret).update(`unsubscribe:v1:${userId}:${category}`).digest().subarray(0, 18))}`;
  const token = sign('usr_student2', 'course');
  const page = await request(`/api/communication/unsubscribe?token=${encodeURIComponent(token)}`);
  assert.equal(page.status, 200);
  assert.match(page.data, /<form method="post"/);
  let prefs = await expectStatus('/api/me/notification-preferences', 200, { token: s2.token });
  assert.equal(prefs.preferences.email_course, true, 'GET never unsubscribes (link scanners)');

  const bad = await request(`/api/communication/unsubscribe?token=${encodeURIComponent(token.slice(0, -2) + 'xx')}`);
  assert.equal(bad.status, 400);
  const otherCategory = await request(`/api/communication/unsubscribe?token=${encodeURIComponent(token.replace('.course.', '.marketing.'))}`, { method: 'POST' });
  assert.equal(otherCategory.status, 400, 'signature covers the category');

  const res = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/communication/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click'
  });
  assert.equal(res.status, 200);
  prefs = await expectStatus('/api/me/notification-preferences', 200, { token: s2.token });
  assert.equal(prefs.preferences.email_course, false);
  assert.equal(prefs.preferences.email_marketing, true);
});

test('course announcements are visible to enrolled learners only', async () => {
  await expectStatus('/api/communication/courses/course_cf_workers/announcements', 403, { token: s1.token, method: 'POST', body: { title: 'x', body: 'y' } });
  await expectStatus('/api/communication/courses/course_cf_workers/announcements', 400, { token: inst.token, method: 'POST', body: { title: '', body: 'y' } });
  const posted = await expectStatus('/api/communication/courses/course_cf_workers/announcements', 201, { token: inst.token, method: 'POST', body: {
    title: 'เพิ่มบทเรียนใหม่', body: 'ดู *บทที่ 5* ได้แล้ว', send_email: true
  } });
  assert.equal(posted.recipients, 3);
  assert.match(posted.announcement.body_html, /<em>บทที่ 5<\/em>/);

  const seen = await expectStatus('/api/communication/courses/course_cf_workers/announcements', 200, { token: s1.token });
  assert.ok(seen.announcements.some(a => a.id === posted.announcement.id));
  assert.equal(seen.can_post, false);
  await expectStatus('/api/communication/courses/course_cf_workers/announcements', 403, { token: s2.token });
  const mine = await expectStatus('/api/communication/my-announcements', 200, { token: s3.token });
  assert.ok(mine.announcements.some(a => a.id === posted.announcement.id && a.course_title));
  const none = await expectStatus('/api/communication/my-announcements', 200, { token: s2.token });
  assert.ok(!none.announcements.some(a => a.id === posted.announcement.id));
  const notes = await expectStatus('/api/notifications', 200, { token: s1.token });
  assert.ok(notes.some(n => n.category === 'announcement' && n.title.includes('เพิ่มบทเรียนใหม่')));

  await expectStatus(`/api/communication/announcements/${posted.announcement.id}`, 403, { token: s1.token, method: 'DELETE' });
  await expectStatus(`/api/communication/announcements/${posted.announcement.id}`, 200, { token: inst.token, method: 'DELETE' });
});

test('email template override renders variables escaped and falls back to built-in', async () => {
  await expectStatus('/api/communication/templates', 403, { token: inst.token });
  await expectStatus('/api/communication/templates', 403, { token: s1.token });
  const list = await expectStatus('/api/communication/templates', 200, { token: coord.token });
  for (const key of ['welcome', 'verification', 'invite', 'reset', 'receipt', 'reminder', 'certificate', 'broadcast']) {
    assert.ok(list.templates.some(t => t.key === key), key);
  }
  await expectStatus('/api/communication/templates/unknown', 404, { token: coord.token, method: 'PUT', body: { subject: 'x', body: 'y' } });
  const saved = await expectStatus('/api/communication/templates/welcome', 200, { token: coord.token, method: 'PUT', body: {
    subject: 'สวัสดี {{name}}',
    body: '<p onclick="steal()">ยินดีต้อนรับ {{name}}</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><a href="{{link}}" style="color:red">เข้าสู่ระบบ</a><img src="x" onerror="alert(1)">'
  } });
  assert.doesNotMatch(saved.template.body_html, /<script|onclick|onerror|javascript:/i);
  assert.match(saved.template.body_html, /href="\{\{link\}\}"/);

  const evil = '<img src=x onerror=alert(1)>';
  const preview = await expectStatus('/api/communication/templates/welcome/preview', 200, { token: coord.token, method: 'POST', body: { vars: { name: evil, link: 'https://example.com/a?b=1&c="2"' } } });
  assert.equal(preview.overridden, true);
  assert.equal(preview.subject, `สวัสดี ${evil}`, 'subjects are plain text');
  assert.ok(preview.html.includes('ยินดีต้อนรับ &lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!preview.html.includes('<img src=x'));
  assert.ok(preview.html.includes('href="https://example.com/a?b=1&amp;c=&quot;2&quot;"'));

  const unsaved = await expectStatus('/api/communication/templates/broadcast/preview', 200, { token: coord.token, method: 'POST', body: {
    subject: '{{title}}', body: '<h1>{{title}}</h1>', vars: { title: 'หัวข้อ', content: '<p>เนื้อหา</p><script>x()</script>' }
  } });
  assert.ok(unsaved.html.includes('<p>เนื้อหา</p>'), 'layout without {{content}} still carries the message');
  assert.doesNotMatch(unsaved.html, /<script/);

  await expectStatus('/api/communication/templates/welcome', 200, { token: coord.token, method: 'DELETE' });
  const fallback = await expectStatus('/api/communication/templates/welcome/preview', 200, { token: coord.token, method: 'POST', body: {} });
  assert.equal(fallback.overridden, false);
  assert.match(fallback.subject, /ยินดีต้อนรับ/);
});

test('security email templates are admin-only and {{link}} may only be a whole href', async () => {
  const ok = { subject: 'ตั้งรหัสผ่านใหม่', body: '<p>สวัสดี {{name}}</p><p><a href="{{link}}">ตั้งรหัสผ่าน</a></p>' };
  for (const key of ['reset', 'invite', 'verification', 'password_changed']) {
    await expectStatus(`/api/communication/templates/${key}`, 403, { token: coord.token, method: 'PUT', body: ok });
    await expectStatus(`/api/communication/templates/${key}`, 403, { token: coord.token, method: 'DELETE' });
  }
  for (const body of [
    '<p><a href="https://evil.example/?next={{link}}">x</a></p>',
    '<p>คัดลอกลิงก์: {{link}}</p>',
    '<p><a href="{{link}}" title="{{link}}">x</a></p>',
    '<p><img src="{{link}}"></p>',
    '<p><a href="https://example.com/{{unsubscribe_link}}">x</a></p>'
  ]) {
    const res = await request('/api/communication/templates/welcome', { token: coord.token, method: 'PUT', body: { subject: 'x', body } });
    assert.equal(res.status, 400, body);
  }
  assert.equal((await request('/api/communication/templates/welcome', { token: coord.token, method: 'PUT', body: { subject: 'ลิงก์ {{link}}', body: ok.body } })).status, 400, 'no link in subject');
  await expectStatus('/api/communication/templates/reset', 200, { token: admin.token, method: 'PUT', body: ok });
  await expectStatus('/api/communication/templates/reset', 200, { token: admin.token, method: 'DELETE' });
});

test('community visibility, moderation, reports and follower notifications', async () => {
  const s1Spaces = await expectStatus('/api/community/spaces', 200, { token: s1.token });
  assert.ok(s1Spaces.spaces.some(s => s.id === 'space_general'));
  const courseSpace = await expectStatus('/api/community/courses/course_cf_workers/space', 200, { token: s1.token });
  const spaceId = courseSpace.space.id;
  assert.equal(courseSpace.space.can_moderate, false);
  await expectStatus('/api/community/courses/course_cf_workers/space', 403, { token: s2.token });
  const s2Spaces = await expectStatus('/api/community/spaces', 200, { token: s2.token });
  assert.ok(!s2Spaces.spaces.some(s => s.id === spaceId), 'not enrolled → course space hidden');
  await expectStatus(`/api/community/spaces/${spaceId}/posts`, 403, { token: s2.token });

  const created = await expectStatus(`/api/community/spaces/${spaceId}/posts`, 201, { token: s1.token, method: 'POST', body: {
    title: 'ถามเรื่อง D1', body: 'ใช้ `prepare()` ยังไงครับ <script>x</script> ![รูป](https://example.com/a.png)'
  } });
  const postId = created.post.id;
  assert.doesNotMatch(created.post.body_html, /<script/);
  assert.match(created.post.body_html, /<code>prepare\(\)<\/code>/);
  assert.match(created.post.body_html, /<img src="https:\/\/example.com\/a.png"/);
  await expectStatus(`/api/community/posts/${postId}`, 404, { token: s2.token });

  // Follower notification: student1 follows the post as author; student3 comments.
  const comment = await expectStatus(`/api/community/posts/${postId}/comments`, 201, { token: s3.token, method: 'POST', body: { body: 'ใช้ bind() ต่อครับ' } });
  const notified = await poll(() => expectStatus('/api/notifications', 200, { token: s1.token }), n => n.some(x => x.category === 'community'));
  assert.ok(notified.some(n => n.category === 'community' && n.title.includes('ถามเรื่อง D1')));

  const reacted = await expectStatus('/api/community/reactions', 200, { token: s3.token, method: 'POST', body: { target_type: 'post', target_id: postId, reaction: 'like' } });
  assert.deepEqual(reacted, { reacted: true, count: 1 });
  const unreacted = await expectStatus('/api/community/reactions', 200, { token: s3.token, method: 'POST', body: { target_type: 'post', target_id: postId, reaction: 'like' } });
  assert.equal(unreacted.reacted, false);
  await expectStatus('/api/community/reactions', 400, { token: s3.token, method: 'POST', body: { target_type: 'post', target_id: postId, reaction: 'angry' } });

  // Course instructor moderates own course space.
  await expectStatus(`/api/community/posts/${postId}/moderate`, 403, { token: s3.token, method: 'POST', body: { pinned: true } });
  const locked = await expectStatus(`/api/community/posts/${postId}/moderate`, 200, { token: inst.token, method: 'POST', body: { pinned: true, locked: true } });
  assert.equal(locked.post.locked, 1);
  await expectStatus(`/api/community/posts/${postId}/comments`, 409, { token: s3.token, method: 'POST', body: { body: 'อีกคำถาม' } });
  await expectStatus(`/api/community/posts/${postId}/comments`, 201, { token: inst.token, method: 'POST', body: { body: 'ปิดกระทู้แล้วนะครับ' } });
  await expectStatus(`/api/community/comments/${comment.comment.id}/moderate`, 200, { token: inst.token, method: 'POST', body: { hidden: true } });
  const asS1 = await expectStatus(`/api/community/posts/${postId}`, 200, { token: s1.token });
  assert.ok(!asS1.comments.some(c => c.id === comment.comment.id), 'hidden comment invisible to others');
  await expectStatus(`/api/community/posts/${postId}/moderate`, 200, { token: inst.token, method: 'POST', body: { hidden: true } });
  await expectStatus(`/api/community/posts/${postId}`, 404, { token: s3.token });
  await expectStatus(`/api/community/posts/${postId}`, 200, { token: s1.token });

  // School-wide space: instructors may not moderate; coordinators may. Reports.
  const general = await expectStatus('/api/community/spaces/space_general/posts', 201, { token: s3.token, method: 'POST', body: { title: 'ขายคอร์สถูก', body: 'สแปม' } });
  await expectStatus(`/api/community/posts/${general.post.id}/moderate`, 403, { token: inst.token, method: 'POST', body: { hidden: true } });
  await expectStatus('/api/community/reports', 400, { token: s1.token, method: 'POST', body: { target_type: 'post', target_id: general.post.id, reason: '' } });
  const report = await expectStatus('/api/community/reports', 201, { token: s1.token, method: 'POST', body: { target_type: 'post', target_id: general.post.id, reason: 'สแปมขายของ' } });
  await expectStatus('/api/community/reports', 409, { token: s1.token, method: 'POST', body: { target_type: 'post', target_id: general.post.id, reason: 'ซ้ำ' } });
  await expectStatus('/api/community/reports', 403, { token: s1.token });
  const instReports = await expectStatus('/api/community/reports', 200, { token: inst.token });
  assert.ok(!instReports.reports.some(r => r.id === report.report.id), 'instructors only see reports from their courses');
  const coordReports = await expectStatus('/api/community/reports', 200, { token: coord.token });
  assert.ok(coordReports.reports.some(r => r.id === report.report.id && r.target_excerpt === 'ขายคอร์สถูก'));
  await expectStatus(`/api/community/reports/${report.report.id}`, 403, { token: inst.token, method: 'PATCH', body: { status: 'resolved', hide: true } });
  await expectStatus(`/api/community/reports/${report.report.id}`, 200, { token: coord.token, method: 'PATCH', body: { status: 'resolved', hide: true } });
  await expectStatus(`/api/community/posts/${general.post.id}`, 200, { token: s3.token });
  await expectStatus(`/api/community/posts/${general.post.id}`, 404, { token: s1.token });

  // Spaces: learners cannot create; instructors can create a space for their course only.
  await expectStatus('/api/community/spaces', 403, { token: s1.token, method: 'POST', body: { name: 'ห้องของฉัน' } });
  await expectStatus('/api/community/spaces', 403, { token: inst.token, method: 'POST', body: { name: 'ห้องรวมใหม่' } });
  await expectStatus('/api/community/spaces', 201, { token: inst.token, method: 'POST', body: { name: 'ห้องแลป', course_id: 'course_cf_workers', posting: 'staff' } });
});

test('direct messages: permissions, unread counts, attachments and rate limit', async () => {
  const contacts = await expectStatus('/api/inbox/contacts', 200, { token: s1.token });
  assert.ok(contacts.contacts.some(c => c.id === 'usr_inst'), 'own course instructor is a contact');
  const thread = await expectStatus('/api/inbox/threads', 201, { token: s1.token, method: 'POST', body: { user_id: 'usr_inst' } });
  await expectStatus(`/api/inbox/threads/${thread.thread.id}/messages`, 400, { token: s1.token, method: 'POST', body: { body: '   ' } });
  await expectStatus(`/api/inbox/threads/${thread.thread.id}/messages`, 201, { token: s1.token, method: 'POST', body: { body: 'อาจารย์ครับ ขอถามเรื่องการบ้าน' } });
  const unread = await expectStatus('/api/inbox/unread', 200, { token: inst.token });
  assert.equal(unread.unread, 1);
  const list = await expectStatus('/api/inbox/threads', 200, { token: inst.token });
  assert.equal(list.threads.find(t => t.id === thread.thread.id).unread_count, 1);
  const opened = await expectStatus(`/api/inbox/threads/${thread.thread.id}/messages`, 200, { token: inst.token });
  assert.equal(opened.messages.length, 1);
  assert.equal((await expectStatus('/api/inbox/unread', 200, { token: inst.token })).unread, 0);
  await expectStatus(`/api/inbox/threads/${thread.thread.id}/messages`, 404, { token: s3.token });

  // Learner ↔ learner is off by default and controlled by a setting.
  await expectStatus('/api/inbox/threads', 403, { token: s1.token, method: 'POST', body: { user_id: 'usr_student3' } });
  await expectStatus('/api/communication/settings', 403, { token: s1.token, method: 'PUT', body: { dm_learner_to_learner: true } });
  await expectStatus('/api/communication/settings', 200, { token: coord.token, method: 'PUT', body: { dm_learner_to_learner: true } });
  const peer = await expectStatus('/api/inbox/threads', 201, { token: s1.token, method: 'POST', body: { user_id: 'usr_student3' } });
  await expectStatus(`/api/inbox/threads/${peer.thread.id}/messages`, 201, { token: s1.token, method: 'POST', body: { body: 'สวัสดี' } });
  await expectStatus('/api/communication/settings', 200, { token: coord.token, method: 'PUT', body: { dm_learner_to_learner: false } });
  await expectStatus(`/api/inbox/threads/${peer.thread.id}/messages`, 403, { token: s3.token, method: 'POST', body: { body: 'ตอบกลับ' } });

  // Instructor of a course the learner does not take → no; staff → yes; staff can start from a user.
  await expectStatus('/api/inbox/threads', 403, { token: s2.token, method: 'POST', body: { user_id: 'usr_inst' } });
  await expectStatus('/api/inbox/threads', 201, { token: s2.token, method: 'POST', body: { user_id: 'usr_coord' } });
  const staffFound = await expectStatus('/api/inbox/contacts?q=student2', 200, { token: coord.token });
  assert.ok(staffFound.contacts.some(c => c.id === 'usr_student2'));
  // Instructors find only learners of their own courses (and staff), never by email and never with emails.
  const own = await expectStatus('/api/inbox/contacts?q=Alex', 200, { token: inst.token });
  assert.ok(own.contacts.some(c => c.id === 'usr_student1'), 'own learner is found');
  assert.ok(own.contacts.every(c => c.email === undefined), 'no emails for instructors');
  assert.equal((await expectStatus('/api/inbox/contacts?q=Bob', 200, { token: inst.token })).contacts.some(c => c.id === 'usr_student2'), false, 'other learners are hidden');
  assert.equal((await expectStatus('/api/inbox/contacts?q=student2@', 200, { token: inst.token })).contacts.length, 0, 'no email search');
  await expectStatus('/api/inbox/threads', 403, { token: inst.token, method: 'POST', body: { user_id: 'usr_student2' } });
  await expectStatus('/api/inbox/threads', 201, { token: inst.token, method: 'POST', body: { user_id: 'usr_coord' } });
  const fromStaff = await expectStatus('/api/inbox/threads', 201, { token: coord.token, method: 'POST', body: { user_id: 'usr_student3' } });

  // Private image attachment
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(32)]);
  const form = new FormData();
  form.append('body', 'ภาพหน้าจอ error');
  form.append('file', new Blob([png], { type: 'image/png' }), 'shot.png');
  const upload = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/inbox/threads/${fromStaff.thread.id}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${coord.token}` }, body: form
  });
  assert.equal(upload.status, 201);
  const sentMsg = (await upload.json()).message;
  assert.equal(sentMsg.has_attachment, 1);
  const file = await request(`/api/inbox/messages/${sentMsg.id}/attachment`, { token: s3.token });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('cache-control'), 'private, no-store');
  await expectStatus(`/api/inbox/messages/${sentMsg.id}/attachment`, 404, { token: s1.token });

  // Rate limit: learners send at most 20 messages per 10 minutes.
  let status = 0;
  let sent = 0;
  for (let i = 0; i < 25; i++) {
    const res = await request(`/api/inbox/threads/${fromStaff.thread.id}/messages`, { token: s3.token, method: 'POST', body: { body: `ข้อความ ${i}` } });
    status = res.status;
    if (status === 429) break;
    assert.equal(status, 201);
    sent++;
  }
  assert.equal(status, 429);
  assert.equal(sent, 20);
});

test('web push subscription CRUD (sending is a no-op without VAPID keys)', async () => {
  const key = await expectStatus('/api/push/public-key', 200);
  assert.deepEqual(key, { configured: false, public_key: null });
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) };
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('hex')}`;
  await expectStatus('/api/push/subscriptions', 400, { token: s1.token, method: 'POST', body: { endpoint: 'http://127.0.0.1:8787/x', keys } });
  await expectStatus('/api/push/subscriptions', 400, { token: s1.token, method: 'POST', body: { endpoint: 'https://evil.example.com/push', keys } });
  await expectStatus('/api/push/subscriptions', 400, { token: s1.token, method: 'POST', body: { endpoint, keys: { p256dh: 'abc', auth: keys.auth } } });
  await expectStatus('/api/push/subscriptions', 201, { token: s1.token, method: 'POST', body: { endpoint, keys } });
  await expectStatus('/api/push/subscriptions', 201, { token: s1.token, method: 'POST', body: { endpoint, keys } });
  const mine = await expectStatus('/api/push/subscriptions', 200, { token: s1.token });
  assert.equal(mine.subscriptions.length, 1, 'same endpoint is upserted');
  assert.equal(mine.subscriptions[0].service, 'fcm.googleapis.com');
  const sent = await expectStatus('/api/push/test', 200, { token: s1.token, method: 'POST', body: {} });
  assert.deepEqual(sent, { configured: false, delivered: 0 });
  const removed = await expectStatus('/api/push/subscriptions', 200, { token: s1.token, method: 'DELETE', body: { endpoint } });
  assert.equal(removed.removed, 1);
});

test('LINE linking code and webhook signature verification', async () => {
  const code = await expectStatus('/api/line/link-code', 200, { token: s1.token, method: 'POST', body: {} });
  assert.match(code.code, /^NP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
  const body = JSON.stringify({ events: [{ type: 'message', replyToken: 'r', source: { userId: 'U1234567890abcdef' }, message: { type: 'text', text: code.code } }] });
  const unsigned = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/line/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!code.configured) {
    assert.equal(unsigned.status, 503, 'webhook is disabled until LINE_CHANNEL_SECRET is set');
    const prefs = await expectStatus('/api/me/notification-preferences', 200, { token: s1.token });
    assert.equal(prefs.line.linked, false);
    return;
  }
  // Only reached when a test secret is configured for the local Worker (LINE_TEST_SECRET must match it).
  assert.equal(unsigned.status, 401);
  const secret = process.env.LINE_TEST_SECRET;
  if (!secret) return;
  const signature = createHmac('sha256', secret).update(body).digest('base64');
  const signed = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/line/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signature }, body });
  assert.equal(signed.status, 200);
  assert.equal((await signed.json()).linked, 1);
  assert.equal((await expectStatus('/api/me/notification-preferences', 200, { token: s1.token })).line.linked, true);
  // Brute-force guard: at most 5 code attempts per LINE user per 15 minutes.
  const guesses = JSON.stringify({ events: Array.from({ length: 7 }, (_, i) => ({ type: 'message', source: { userId: 'Uguess0000000000' }, message: { type: 'text', text: `NP-AAAAAAA${'23456789'[i]}` } })) });
  const guessed = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/line/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': createHmac('sha256', secret).update(guesses).digest('base64') }, body: guesses });
  assert.equal((await guessed.json()).limited, 2);
});

test('notification unread count and single read', async () => {
  const before = await expectStatus('/api/notifications/unread-count', 200, { token: s1.token });
  assert.ok(before.unread > 0);
  const list = await expectStatus('/api/notifications', 200, { token: s1.token });
  const target = list.find(n => !n.is_read);
  await expectStatus(`/api/notifications/${target.id}/read`, 200, { token: s1.token, method: 'POST', body: {} });
  const after = await expectStatus('/api/notifications/unread-count', 200, { token: s1.token });
  assert.equal(after.unread, before.unread - 1);
});
