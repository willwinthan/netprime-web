import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let admin, coord, instructor;
const PASSWORD = 'access-test-pass-1';
const post = (path, token, body) => request(path, { method: 'POST', token, body });
const patch = (path, token, body) => request(path, { method: 'PATCH', token, body });
const put = (path, token, body) => request(path, { method: 'PUT', token, body });

before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  coord = await login('coord@netprime.com', 'coord123');
  instructor = await login('instructor@netprime.com', 'inst123');
});

async function createUser(body) {
  const res = await post('/api/admin/accounts', admin.token, { password: PASSWORD, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.user;
}

test('sign-in returns the permissions of each role', async () => {
  assert.ok(admin.user.permissions.includes('roles.manage'));
  assert.ok(coord.user.permissions.includes('site.sessions') && !coord.user.permissions.includes('users.view'));
  assert.deepEqual([...instructor.user.permissions].sort(), ['articles.import_notion', 'articles.write', 'community.moderate', 'site.media']);
  const student = await login('student3@netprime.com', 'stud123');
  assert.deepEqual(student.user.permissions, []);
  const me = await expectStatus('/api/auth/me', 200, { token: instructor.token });
  assert.ok(me.user.permissions.includes('articles.write'));
});

test('admins create accounts of every role with organization rules', async () => {
  await expectStatus('/api/admin/accounts', 403, { token: coord.token });
  const list = await expectStatus('/api/admin/accounts?role=instructor', 200, { token: admin.token });
  assert.ok(list.users.length > 0 && list.users.every(u => u.roles.includes('instructor')));
  const found = await expectStatus(`/api/admin/accounts?q=${encodeURIComponent('Nok')}`, 200, { token: admin.token });
  assert.ok(found.users.some(u => u.email === 'coord@netprime.com' && u.role === 'coordinator'));

  const teacher = await createUser({ email: 'teacher2@example.invalid', name: 'ผู้สอนสอง', role: 'instructor' });
  assert.equal(teacher.role, 'instructor');
  const staff = await createUser({ email: 'staff2@example.invalid', name: 'เจ้าหน้าที่สอง', role: 'coordinator' });
  assert.equal(staff.role, 'coordinator');
  assert.equal((await post('/api/admin/accounts', admin.token, { email: 'p@example.invalid', name: 'P', password: PASSWORD, role: 'partner' })).status, 400);
  const hr = await createUser({ email: 'globex-hr@example.invalid', name: 'HR Globex', role: 'partner', partner_id: 'partner_globex' });
  assert.equal(hr.company_name, 'Globex Industries Inc.');
  const learner = await createUser({ email: 'globex-learner@example.invalid', name: 'ผู้เรียน Globex', role: 'student', partner_id: 'partner_globex' });
  assert.equal(learner.partner_id, 'partner_globex');
  assert.equal((await post('/api/admin/accounts', admin.token, { email: 'x@example.invalid', name: 'X', password: PASSWORD, role: 'instructor', partner_id: 'partner_globex' })).status, 400);
  assert.equal((await post('/api/admin/accounts', admin.token, { email: 'teacher2@example.invalid', name: 'Dup', password: PASSWORD, role: 'student' })).status, 409);
  assert.equal((await post('/api/admin/accounts', admin.token, { email: 'weak@example.invalid', name: 'Weak', password: 'short', role: 'student' })).status, 400);
  const hrLogin = await login('globex-hr@example.invalid', PASSWORD);
  assert.equal(hrLogin.user.role, 'partner');
});

test('one account can hold several roles: a coordinator who also studies', async () => {
  const user = await createUser({ email: 'coord-learner@example.invalid', name: 'เจ้าหน้าที่ที่เรียนด้วย', roles: ['student', 'coordinator'] });
  assert.equal(user.role, 'coordinator', 'primary role is the highest one');
  assert.deepEqual(user.roles, ['coordinator', 'student']);
  const session = await login('coord-learner@example.invalid', PASSWORD);
  assert.deepEqual(session.user.roles, ['coordinator', 'student']);
  assert.ok(session.user.permissions.includes('site.sessions'));

  // Both consoles work with the same token; other roles stay closed.
  await expectStatus('/api/admin/site/summary', 200, { token: session.token });
  await expectStatus('/api/student/stats', 200, { token: session.token });
  await expectStatus('/api/instructor/analytics', 403, { token: session.token });
  const course = await expectStatus('/api/instructor/courses', 201, { method: 'POST', token: instructor.token,
    body: { title: 'Free multi-role fixture', description: 'Enrollment by staff', price: 0 } });
  await expectStatus(`/api/admin/courses/${course.course.id}/approve`, 200, { method: 'POST', token: admin.token });
  await expectStatus(`/api/courses/${course.course.id}/enroll`, 403, { method: 'POST', token: coord.token });
  const enrolled = await request(`/api/courses/${course.course.id}/enroll`, { method: 'POST', token: session.token });
  assert.ok([200, 201].includes(enrolled.status), JSON.stringify(enrolled.data));

  // Staff who study are not counted as ordinary learners.
  const students = await expectStatus('/api/instructor/students', 200, { token: admin.token });
  assert.ok(!students.some(s => s.id === user.id));
  const learners = await expectStatus('/api/admin/accounts?role=student&q=coord-learner', 200, { token: admin.token });
  assert.equal(learners.users.length, 1, 'role filter matches any held role');

  // Removing a role applies at once; an empty role list is rejected.
  assert.equal((await patch(`/api/admin/accounts/${user.id}`, admin.token, { roles: ['student'] })).status, 200);
  await expectStatus('/api/admin/site/summary', 403, { token: session.token });
  await expectStatus('/api/student/stats', 200, { token: session.token });
  assert.equal((await patch(`/api/admin/accounts/${user.id}`, admin.token, { roles: [] })).status, 400);
  assert.equal((await patch(`/api/admin/accounts/${user.id}`, admin.token, { roles: ['student', 'superuser'] })).status, 400);

  // Instructors keep their course access when they also become coordinators.
  assert.equal((await patch('/api/admin/accounts/usr_inst', admin.token, { roles: ['instructor', 'coordinator'] })).status, 200);
  await expectStatus('/api/instructor/analytics', 200, { token: instructor.token });
  await expectStatus('/api/lessons/lesson_cf_workers_intro/qa', 200, { token: instructor.token });
  await expectStatus('/api/admin/site/summary', 200, { token: instructor.token });
  assert.equal((await patch('/api/admin/accounts/usr_inst', admin.token, { roles: ['instructor'] })).status, 200);
  await expectStatus('/api/admin/site/summary', 403, { token: instructor.token });
});

test('organization accounts may only be partners or students', async () => {
  const both = await createUser({ email: 'globex-lead@example.invalid', name: 'หัวหน้าที่เรียนด้วย', roles: ['partner', 'student'], partner_id: 'partner_globex' });
  assert.deepEqual(both.roles, ['partner', 'student']);
  assert.equal((await post('/api/admin/accounts', admin.token, { email: 'mix@example.invalid', name: 'Mix', password: PASSWORD,
    roles: ['instructor', 'student'], partner_id: 'partner_globex' })).status, 400);
  assert.equal((await patch(`/api/admin/accounts/${both.id}`, admin.token, { roles: ['partner', 'coordinator'] })).status, 400);
});

test('admins may add roles to themselves but never drop their own admin role', async () => {
  assert.equal((await patch('/api/admin/accounts/usr_admin', admin.token, { roles: ['admin', 'student'] })).status, 200);
  const me = await expectStatus('/api/auth/me', 200, { token: admin.token });
  assert.deepEqual(me.user.roles, ['admin', 'student']);
  assert.equal((await patch('/api/admin/accounts/usr_admin', admin.token, { roles: ['student'] })).status, 400);
  assert.equal((await patch('/api/admin/accounts/usr_admin', admin.token, { roles: ['admin'] })).status, 200);
});

test('role changes take effect immediately and guard against lockout', async () => {
  const user = await createUser({ email: 'switch@example.invalid', name: 'สลับบทบาท', role: 'student' });
  const session = await login('switch@example.invalid', PASSWORD);
  await expectStatus('/api/instructor/analytics', 403, { token: session.token });
  assert.equal((await patch(`/api/admin/accounts/${user.id}`, admin.token, { role: 'instructor' })).status, 200);
  await expectStatus('/api/instructor/analytics', 200, { token: session.token });
  assert.equal((await patch(`/api/admin/accounts/${user.id}`, admin.token, { role: 'coordinator' })).status, 200);
  await expectStatus('/api/admin/site/summary', 200, { token: session.token });
  await expectStatus('/api/instructor/analytics', 403, { token: session.token });

  assert.equal((await patch('/api/admin/accounts/usr_admin', admin.token, { role: 'student' })).status, 400, 'no self demotion');
  assert.equal((await patch('/api/admin/accounts/usr_admin', admin.token, { status: 'suspended' })).status, 400, 'no self suspension');
  assert.equal((await patch(`/api/admin/accounts/${user.id}`, admin.token, { role: 'partner' })).status, 400, 'partner needs an organization');
  assert.equal((await patch(`/api/admin/accounts/${user.id}`, admin.token, { role: 'superuser' })).status, 400);
  await expectStatus('/api/admin/accounts/usr_missing', 404, { method: 'PATCH', token: admin.token, body: { name: 'x' } });
});

test('suspension, password reset and sign-out revoke access', async () => {
  const user = await createUser({ email: 'suspend@example.invalid', name: 'ระงับ', role: 'student' });
  const session = await login('suspend@example.invalid', PASSWORD);
  assert.equal((await patch(`/api/admin/accounts/${user.id}`, admin.token, { status: 'suspended' })).status, 200);
  await expectStatus('/api/auth/me', 401, { token: session.token });
  assert.equal((await post('/api/auth/login', null, { email: 'suspend@example.invalid', password: PASSWORD })).status, 403);
  assert.equal((await patch(`/api/admin/accounts/${user.id}`, admin.token, { status: 'active' })).status, 200);
  const again = await login('suspend@example.invalid', PASSWORD);

  assert.equal((await post(`/api/admin/accounts/${user.id}/password`, admin.token, { password: 'brand-new-password-2' })).status, 200);
  await expectStatus('/api/auth/me', 401, { token: again.token });
  assert.equal((await post('/api/auth/login', null, { email: 'suspend@example.invalid', password: PASSWORD })).status, 401);
  const fresh = await login('suspend@example.invalid', 'brand-new-password-2');
  await expectStatus('/api/auth/me', 200, { token: fresh.token });

  assert.equal((await post(`/api/admin/accounts/${user.id}/sign-out`, admin.token, {})).status, 200);
  await expectStatus('/api/auth/me', 401, { token: fresh.token });
  const after = await login('suspend@example.invalid', 'brand-new-password-2');
  await expectStatus('/api/auth/me', 200, { token: after.token });
});

test('only admins manage admins, and the last active admin stays', async () => {
  await createUser({ email: 'admin2@example.invalid', name: 'Admin Two', role: 'admin' });
  const admin2 = await login('admin2@example.invalid', PASSWORD);
  assert.equal((await patch('/api/admin/accounts/usr_admin', admin2.token, { status: 'suspended' })).status, 200);
  await expectStatus('/api/auth/me', 401, { token: admin.token });
  assert.equal((await patch('/api/admin/accounts/usr_admin', admin2.token, { status: 'active' })).status, 200);
  admin = await login('admin@netprime.com', 'admin123');

  // A coordinator given users.manage still cannot touch admins or create one.
  assert.equal((await put('/api/admin/roles/coordinator', admin.token, { permissions: [...coord.user.permissions, 'users.view', 'users.manage'] })).status, 200);
  assert.equal((await post('/api/admin/accounts', coord.token, { email: 'sneaky@example.invalid', name: 'Sneaky', password: PASSWORD, role: 'admin' })).status, 403);
  assert.equal((await patch('/api/admin/accounts/usr_coord', coord.token, { role: 'admin' })).status, 400, 'own role');
  assert.equal((await patch('/api/admin/accounts/usr_admin', coord.token, { name: 'renamed' })).status, 403);

  // users.manage cannot hand out or take over more access than the actor holds.
  const instructorPerms = (await expectStatus('/api/admin/roles', 200, { token: admin.token })).roles.find(r => r.key === 'instructor').permissions;
  assert.equal((await put('/api/admin/roles/instructor', admin.token, { permissions: [...instructorPerms, 'courses.approve'] })).status, 200);
  assert.equal((await post('/api/admin/accounts', coord.token, { email: 'approver@example.invalid', name: 'Approver', password: PASSWORD, roles: ['instructor'] })).status, 403);
  assert.equal((await post('/api/admin/accounts/usr_inst/password', coord.token, { password: 'takeover-password-1' })).status, 403);
  assert.equal((await post('/api/admin/accounts/usr_inst/sign-out', coord.token, {})).status, 403);
  assert.equal((await patch('/api/admin/accounts/usr_student3', coord.token, { roles: ['student', 'instructor'] })).status, 403);
  assert.equal((await post('/api/admin/accounts', coord.token, { email: 'learner-by-coord@example.invalid', name: 'Learner', password: PASSWORD, roles: ['student'] })).status, 201);
  assert.equal((await put('/api/admin/roles/instructor', admin.token, { permissions: instructorPerms })).status, 200);

  assert.equal((await put('/api/admin/roles/coordinator', admin.token, { permissions: coord.user.permissions })).status, 200);
});

test('the role permission matrix is editable by admins only', async () => {
  const roles = await expectStatus('/api/admin/roles', 200, { token: admin.token });
  assert.equal(roles.canEdit, true);
  assert.ok(roles.roles.find(r => r.key === 'admin').locked);
  await expectStatus('/api/admin/roles', 403, { token: instructor.token });
  assert.equal((await put('/api/admin/roles/admin', admin.token, { permissions: [] })).status, 400);
  assert.equal((await put('/api/admin/roles/coordinator', admin.token, { permissions: ['roles.manage'] })).status, 400);
  assert.equal((await put('/api/admin/roles/coordinator', admin.token, { permissions: ['not.a.permission'] })).status, 400);

  // Removing a permission closes that area at once; restoring reopens it.
  const original = coord.user.permissions;
  assert.equal((await put('/api/admin/roles/coordinator', admin.token, { permissions: original.filter(p => p !== 'site.promotions') })).status, 200);
  await expectStatus('/api/admin/site/promotions', 403, { token: coord.token });
  await expectStatus('/api/admin/site/sessions', 200, { token: coord.token });
  assert.equal((await put('/api/admin/roles/coordinator', instructor.token, { permissions: original })).status, 403);
  assert.equal((await put('/api/admin/roles/coordinator', admin.token, { permissions: original })).status, 200);
  await expectStatus('/api/admin/site/promotions', 200, { token: coord.token });
  const log = await expectStatus('/api/admin/site/audit', 200, { token: admin.token });
  assert.ok(log.entries.some(e => e.entity === 'role' && e.entity_id === 'coordinator'));
});

test('instructors write articles that reviewers approve or send back', async () => {
  // Instructors reach only the article area of the content console.
  await expectStatus('/api/admin/site/sessions', 403, { token: instructor.token });
  const blocks = JSON.stringify([{ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'บทนำ', styles: {} }] }]);
  const created = await post('/api/admin/site/articles', instructor.token, { title: 'Lab OSPF จากผู้สอน', body: '## บทนำ', content_json: blocks, category: 'Cisco' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.article.id;
  const slug = created.data.article.slug;
  assert.equal((await post('/api/admin/site/articles', instructor.token, { title: 'x', body: 'x', status: 'published' })).status, 403);
  assert.equal((await post('/api/admin/site/articles', instructor.token, { title: 'x', body: 'x', content_json: '{bad' })).status, 400);
  assert.equal((await patch(`/api/admin/site/articles/${id}`, instructor.token, { status: 'published' })).status, 403);

  const mine = await expectStatus('/api/admin/site/articles', 200, { token: instructor.token });
  assert.ok(mine.articles.every(a => a.author_id === 'usr_inst'), 'authors only see their own articles');

  assert.equal((await patch(`/api/admin/site/articles/${id}`, instructor.token, { status: 'review' })).status, 200);
  const queue = await expectStatus('/api/admin/site/articles?status=review', 200, { token: coord.token });
  assert.ok(queue.articles.some(a => a.id === id) && queue.reviewCount >= 1);
  const coordNotes = await expectStatus('/api/notifications', 200, { token: coord.token });
  assert.ok(coordNotes.some(n => n.content.includes('Lab OSPF')));

  // Reviewers may comment and move the status but not rewrite someone else's text (that needs articles.manage).
  const sentBack = await patch(`/api/admin/site/articles/${id}`, coord.token, { status: 'draft', review_note: 'เพิ่มรูปผัง Lab' });
  assert.equal(sentBack.status, 200, JSON.stringify(sentBack.data));
  const instNotes = await expectStatus('/api/notifications', 200, { token: instructor.token });
  assert.ok(instNotes.some(n => n.content.includes('เพิ่มรูปผัง Lab')));
  assert.equal((await patch(`/api/admin/site/articles/${id}`, instructor.token, { review_note: 'ok' })).status, 403);
  assert.equal((await patch(`/api/admin/site/articles/${id}`, instructor.token, { body: '## บทนำ\n\nมีรูปแล้ว', status: 'review' })).status, 200);
  assert.equal((await patch(`/api/admin/site/articles/${id}`, coord.token, { status: 'published' })).status, 200);

  const pub = await expectStatus(`/api/public/articles/${slug}`, 200);
  assert.equal(pub.article.content_json, blocks);
  assert.equal((await patch(`/api/admin/site/articles/${id}`, instructor.token, { title: 'แก้หลังเผยแพร่' })).status, 403);
  assert.equal((await request(`/api/admin/site/articles/${id}`, { method: 'DELETE', token: instructor.token })).status, 403);

  // Another instructor cannot see or change it.
  await createUser({ email: 'teacher3@example.invalid', name: 'ผู้สอนสาม', role: 'instructor' });
  const other = await login('teacher3@example.invalid', PASSWORD);
  await expectStatus(`/api/admin/site/articles/${id}`, 404, { token: other.token });
  assert.equal((await patch(`/api/admin/site/articles/${id}`, other.token, { title: 'hijack' })).status, 404);
});

test('granting articles.publish lets instructors publish directly', async () => {
  const original = instructor.user.permissions;
  assert.equal((await put('/api/admin/roles/instructor', admin.token, { permissions: [...original, 'articles.publish'] })).status, 200);
  const res = await post('/api/admin/site/articles', instructor.token, { title: 'เผยแพร่ทันที', body: 'เนื้อหา', status: 'published' });
  assert.equal(res.status, 201);
  await expectStatus(`/api/public/articles/${res.data.article.slug}`, 200);
  assert.equal((await put('/api/admin/roles/instructor', admin.token, { permissions: original })).status, 200);
});

test('Notion import validates links and reports missing configuration', async () => {
  const student = await login('student3@netprime.com', 'stud123');
  assert.equal((await post('/api/admin/site/articles/import-notion', student.token, { url: 'https://www.notion.so/x-0123456789abcdef0123456789abcdef' })).status, 403);
  assert.equal((await post('/api/admin/site/articles/import-notion', instructor.token, { url: 'https://example.com/page' })).status, 400);
  const res = await post('/api/admin/site/articles/import-notion', instructor.token, { url: 'https://www.notion.so/team/Lab-0123456789abcdef0123456789abcdef' });
  assert.equal(res.status, 503);
  assert.match(res.data.error, /NOTION_TOKEN/);
});
