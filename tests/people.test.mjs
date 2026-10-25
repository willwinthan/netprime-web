import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const mail = label => `${label}.${run}@example.invalid`;
const tag = label => `${label}-${run}`;

const admin = await login('admin@netprime.com', 'admin123');
const coordLogin = () => login('coord@netprime.com', 'coord123');

async function preview(token, csv, options = {}) {
  return request('/api/admin/people/import/preview', { method: 'POST', token, body: { csv, filename: 'test.csv', ...options } });
}

async function importCsv(token, csv, options = {}) {
  const p = await preview(token, csv, options);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const commit = await expectStatus(`/api/admin/people/import/${p.data.import_id}/commit`, 200, { method: 'POST', token, body: { records: p.data.records } });
  return { preview: p.data, commit };
}

async function rolePermissions(role) {
  const roles = await expectStatus('/api/admin/roles', 200, { token: admin.token });
  return roles.roles.find(r => r.key === role).permissions;
}
const setRolePermissions = (role, permissions) =>
  expectStatus(`/api/admin/roles/${role}`, 200, { method: 'PUT', token: admin.token, body: { permissions } });

async function segmentIds(rules) {
  const created = await expectStatus('/api/admin/segments', 201, { method: 'POST', token: admin.token, body: { name: `seg ${run}`, rules } });
  const members = await expectStatus(`/api/admin/segments/${created.segment.id}/users?limit=200`, 200, { token: admin.token });
  assert.equal(members.total, created.segment.count, 'live count matches the member list');
  await expectStatus(`/api/admin/segments/${created.segment.id}`, 200, { method: 'DELETE', token: admin.token });
  return members.user_ids;
}

const userId = async email => {
  const list = await expectStatus(`/api/admin/accounts?q=${encodeURIComponent(email)}`, 200, { token: admin.token });
  return list.users.find(u => u.email === email)?.id;
};

// ---------- Custom profile fields ----------

const fieldKeys = { number: `emp_${run}`.slice(0, 40), select: `dept_${run}`.slice(0, 40), date: `start_${run}`.slice(0, 40), check: `consent_${run}`.slice(0, 40), secret: `risk_${run}`.slice(0, 40) };

test('admins define custom profile fields and values are validated', async () => {
  const student = await login('student3@netprime.com', 'stud123');
  await expectStatus('/api/admin/profile-fields', 403, { method: 'POST', token: student.token, body: { key: 'x_field', label: 'X', type: 'text' } });
  await expectStatus('/api/admin/profile-fields', 400, { method: 'POST', token: admin.token, body: { key: 'Bad Key', label: 'X', type: 'text' } });
  await expectStatus('/api/admin/profile-fields', 400, { method: 'POST', token: admin.token, body: { key: 'email', label: 'X', type: 'text' } });
  await expectStatus('/api/admin/profile-fields', 400, { method: 'POST', token: admin.token, body: { key: 'opt_none', label: 'X', type: 'select', options: [] } });
  await expectStatus('/api/admin/profile-fields', 201, { method: 'POST', token: admin.token, body: { key: fieldKeys.number, label: 'รหัสพนักงาน', type: 'number', required: true, visibility: 'signup' } });
  await expectStatus('/api/admin/profile-fields', 409, { method: 'POST', token: admin.token, body: { key: fieldKeys.number, label: 'ซ้ำ', type: 'text' } });
  await expectStatus('/api/admin/profile-fields', 201, { method: 'POST', token: admin.token, body: { key: fieldKeys.select, label: 'แผนก', type: 'select', options: ['IT', 'HR'] } });
  await expectStatus('/api/admin/profile-fields', 201, { method: 'POST', token: admin.token, body: { key: fieldKeys.date, label: 'วันเริ่มงาน', type: 'date' } });
  await expectStatus('/api/admin/profile-fields', 201, { method: 'POST', token: admin.token, body: { key: fieldKeys.check, label: 'ยินยอมรับข่าวสาร', type: 'checkbox' } });
  const secret = await expectStatus('/api/admin/profile-fields', 201, { method: 'POST', token: admin.token, body: { key: fieldKeys.secret, label: 'ระดับความเสี่ยง', type: 'text', visibility: 'admin' } });

  const signup = await expectStatus('/api/profile-fields/signup', 200);
  assert.ok(signup.fields.some(f => f.key === fieldKeys.number));
  assert.ok(!signup.fields.some(f => f.key === fieldKeys.select), 'profile-only fields are not on the signup form');

  const mine = await expectStatus('/api/me/profile-fields', 200, { token: student.token });
  assert.ok(!mine.fields.some(f => f.key === fieldKeys.secret), 'admin-only fields are hidden from the user');
  const put = values => request('/api/me/profile-fields', { method: 'PUT', token: student.token, body: { values } });
  assert.equal((await put({ [fieldKeys.select]: 'IT' })).status, 400, 'required field must be filled');
  assert.equal((await put({ [fieldKeys.number]: 'abc' })).status, 400);
  assert.equal((await put({ [fieldKeys.number]: '12', [fieldKeys.select]: 'Sales' })).status, 400);
  assert.equal((await put({ [fieldKeys.number]: '12', [fieldKeys.date]: '2026-02-30' })).status, 400);
  assert.equal((await put({ [fieldKeys.number]: '12', [fieldKeys.check]: 'maybe' })).status, 400);
  assert.equal((await put({ [fieldKeys.secret]: 'high' })).status, 400, 'users cannot write admin-only fields');
  assert.equal((await put({ [fieldKeys.number]: '1,024', [fieldKeys.select]: 'IT', [fieldKeys.date]: '2026-02-01', [fieldKeys.check]: 'ใช่' })).status, 200);
  const after = await expectStatus('/api/me/profile-fields', 200, { token: student.token });
  const value = key => after.fields.find(f => f.key === key).value;
  assert.equal(value(fieldKeys.number), '1024');
  assert.equal(value(fieldKeys.check), '1');
  assert.equal((await put({ [fieldKeys.number]: '' })).status, 400, 'a required field cannot be cleared');

  // Staff edit admin-only fields; the user detail page shows every field.
  const student3 = await userId('student3@netprime.com');
  await expectStatus(`/api/admin/people/${student3}/profile-fields`, 200, { method: 'PUT', token: admin.token, body: { values: { [fieldKeys.secret]: 'ต่ำ' } } });
  const detail = await expectStatus(`/api/admin/people/${student3}`, 200, { token: admin.token });
  assert.equal(detail.profile_fields.find(f => f.id === secret.field.id).value, 'ต่ำ');
  assert.equal(detail.profile_fields.find(f => f.key === fieldKeys.select).value, 'IT');
});

// ---------- CSV import ----------

test('import preview validates every row', async () => {
  const header = `email,name,roles,organization,tags,courses,${fieldKeys.number},${fieldKeys.select}`;
  const csv = '\ufeff' + [header,
    `${mail('ok')},สมชาย ใจดี,student,,${tag('imp')},course_cisco_ccna,7,IT`,
    `${mail('ok').toUpperCase()},ซ้ำ,student,,,,,`,
    `${mail('badrole')},Bad Role,wizard,,,,,`,
    `${mail('badorg')},Bad Org,student,Nowhere Ltd,,,,`,
    `${mail('badcourse')},Bad Course,student,,,course_missing,,`,
    `${mail('badfield')},Bad Field,student,,,,ten,Finance`,
    `not-an-email,X,student,,,,,`,
    `${mail('noname')},,student,,,,,`,
    `${mail('staffOrg')},Staff Org,instructor,Globex Industries Inc.,,,,`,
    `"${mail('quoted')}","ชื่อ, มีจุลภาค",ผู้เรียน,partner_mit,"${tag('a')}|${tag('b')}",,,`,
    `student1@netprime.com,Existing,student,,,,,`
  ].join('\r\n');
  const p = await preview(admin.token, csv);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const byRow = Object.fromEntries(p.data.rows.map(r => [r.row_no, r]));
  assert.equal(byRow[2].action, 'create');
  assert.deepEqual(byRow[2].tags, [tag('imp')]);
  assert.match(byRow[3].errors.join(), /ซ้ำ/);
  assert.match(byRow[4].errors.join(), /บทบาท/);
  assert.match(byRow[5].errors.join(), /องค์กร/);
  assert.match(byRow[6].errors.join(), /คอร์ส/);
  assert.equal(byRow[7].errors.length, 2, 'number and select both invalid');
  assert.match(byRow[8].errors.join(), /อีเมล/);
  assert.match(byRow[9].errors.join(), /ชื่อ/);
  assert.match(byRow[10].errors.join(), /องค์กร/, 'instructors cannot belong to an organization');
  assert.equal(byRow[11].action, 'create', JSON.stringify(byRow[11]));
  assert.equal(byRow[11].name, 'ชื่อ, มีจุลภาค');
  assert.deepEqual(byRow[11].roles, ['student'], 'Thai role labels are accepted');
  assert.equal(byRow[11].tags.length, 2);
  assert.equal(byRow[12].action, 'skip', 'existing accounts are skipped by default');
  assert.equal(p.data.summary.error, 8);

  // The courses column only enrolls into published courses.
  const teacher = await login('instructor@netprime.com', 'inst123');
  const draft = await expectStatus('/api/instructor/courses', 201, { method: 'POST', token: teacher.token,
    body: { title: `Draft ${run}`, description: 'draft', price: 0 } });
  const draftRow = await preview(admin.token, `email,name,courses\n${mail('draftcourse')},Draft,${draft.course.id}`);
  assert.equal(draftRow.status, 200);
  assert.match(draftRow.data.rows[0].errors.join(), /ยังไม่เผยแพร่/);

  // Row and size limits.
  const big = ['email,name', ...Array.from({ length: 2001 }, (_, i) => `u${i}.${run}@example.invalid,U`)].join('\n');
  assert.equal((await preview(admin.token, big)).status, 400);
  assert.equal((await preview(admin.token, 'name\nX')).status, 400, 'email column is required');
});

test('organization seats are enforced in preview and commit', async () => {
  const globex = (await expectStatus('/api/admin/accounts/meta', 200, { token: admin.token })).partners.find(p => p.id === 'partner_globex');
  const free = globex.total_seats - globex.allocated_seats;
  const rows = Array.from({ length: free + 1 }, (_, i) => `${mail('seat' + i)},Seat ${i},student,partner_globex`);
  const p = await preview(admin.token, ['email,name,roles,organization', ...rows].join('\n'));
  assert.equal(p.data.summary.create, free);
  assert.match(p.data.rows.at(-1).errors.join(), /ที่นั่งเต็ม/);
  // Commit everything, including the over-capacity row, in one batch: exactly `free` accounts are created.
  const commit = await expectStatus(`/api/admin/people/import/${p.data.import_id}/commit`, 200, { method: 'POST', token: admin.token, body: { records: p.data.records } });
  assert.equal(commit.counts.created, free);
  assert.equal(commit.counts.failed, 1);
  const after = (await expectStatus('/api/admin/accounts/meta', 200, { token: admin.token })).partners.find(p => p.id === 'partner_globex');
  assert.equal(after.allocated_seats, after.total_seats);
});

test('commit creates accounts in batches and is idempotent on retry', async () => {
  const csv = [`email,name,roles,tags,courses,password,${fieldKeys.number}`,
    `${mail('pw1')},ผู้เรียน หนึ่ง,student,${tag('batch')},course_cisco_ccna,temporary-pass-123,42`,
    `${mail('pw2')},ผู้เรียน สอง,student,${tag('batch')},,short,`,
    `${mail('pw3')},ผู้เรียน สาม,student,${tag('batch')},,temporary-pass-456,`
  ].join('\n');
  const p = await preview(admin.token, csv, { setup: 'password' });
  assert.equal(p.status, 200);
  assert.match(p.data.rows[1].errors.join(), /รหัสผ่าน/);
  const [first, ...rest] = p.data.records;
  const url = `/api/admin/people/import/${p.data.import_id}/commit`;
  const a = await expectStatus(url, 200, { method: 'POST', token: admin.token, body: { records: [first] } });
  assert.equal(a.counts.created, 1);
  const b = await expectStatus(url, 200, { method: 'POST', token: admin.token, body: { records: rest } });
  assert.equal(b.counts.created, 1);
  assert.equal(b.counts.failed, 1);
  // Retrying the same batches does not apply anything twice.
  const again = await expectStatus(url, 200, { method: 'POST', token: admin.token, body: { records: p.data.records } });
  assert.equal(again.repeated, 2);
  assert.equal(again.counts.created, 0);
  assert.equal(again.results.filter(r => r.result === 'created').length, 2);
  // The same email sent under another row number is a duplicate, not an update.
  const dup = await expectStatus(url, 200, { method: 'POST', token: admin.token, body: { records: [{ row_no: 50, cells: first.cells }] } });
  assert.equal(dup.results.find(r => r.row_no === 50).result, 'failed');

  const learner = await login(mail('pw1'), 'temporary-pass-123');
  const course = await expectStatus('/api/courses/course_cisco_ccna', 200, { token: learner.token });
  assert.equal(course.enrollment?.status, 'active');
  const detail = await expectStatus(`/api/admin/people/${learner.user.id}`, 200, { token: admin.token });
  assert.deepEqual(detail.user.tags, [tag('batch')]);
  assert.equal(detail.profile_fields.find(f => f.key === fieldKeys.number).value, '42');

  const report = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/admin/people/import/${p.data.import_id}/report`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-type'), /text\/csv/);
  const bytes = new Uint8Array(await report.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  const text = new TextDecoder().decode(bytes);
  assert.match(text, new RegExp(mail('pw1').replace(/\./g, '\\.')));
  assert.match(text, /failed/);
});

test('invite mode emails set-password links; update mode only adds and never downgrades admins', async () => {
  const { commit } = await importCsv(admin.token, `email,name\n${mail('invitee')},ผู้ได้รับเชิญ`);
  assert.equal(commit.counts.created, 1);
  assert.match(commit.results[0].debug_url, /\/reset-password\?token=.*&invite=1/);

  const adminEmail = mail('admin2');
  await expectStatus('/api/admin/accounts', 201, { method: 'POST', token: admin.token,
    body: { email: adminEmail, name: 'Second Admin', roles: ['admin'], password: 'second-admin-pass-1' } });
  const update = await importCsv(admin.token, `email,name,roles,tags\n${adminEmail},Renamed,student,${tag('upd')}`, { mode: 'update' });
  assert.equal(update.commit.counts.updated, 1);
  const id = await userId(adminEmail);
  const detail = await expectStatus(`/api/admin/people/${id}`, 200, { token: admin.token });
  assert.deepEqual(detail.user.roles, ['admin', 'student']);
  assert.equal(detail.user.name, 'Second Admin', 'names are not overwritten');
  assert.deepEqual(detail.user.tags, [tag('upd')]);
});

test('importers can only grant roles within their own permissions', async () => {
  const coordinatorBefore = await rolePermissions('coordinator');
  const instructorBefore = await rolePermissions('instructor');
  let coord = await coordLogin();
  assert.equal((await preview(coord.token, `email,name\n${mail('nope')},X`)).status, 403, 'users.import is required');
  try {
    await setRolePermissions('coordinator', [...coordinatorBefore, 'users.import']);
    await setRolePermissions('instructor', [...instructorBefore, 'courses.approve']);
    coord = await coordLogin();
    const p = await preview(coord.token, ['email,name,roles',
      `${mail('c-student')},Student,student`,
      `${mail('c-inst')},Instructor,instructor`,
      `${mail('c-admin')},Admin,admin`,
      `${mail('c-coord')},Coordinator,coordinator`,
      'admin@netprime.com,Admin,student'
    ].join('\n'), { mode: 'update' });
    assert.equal(p.status, 200, JSON.stringify(p.data));
    const rows = p.data.rows;
    assert.equal(rows[0].action, 'create');
    assert.match(rows[1].errors.join(), /สิทธิ์มากกว่า/, 'instructor now holds courses.approve, which coordinators lack');
    assert.match(rows[2].errors.join(), /ผู้ดูแลระบบ/);
    assert.equal(rows[3].action, 'create', 'coordinators may import coordinators');
    assert.match(rows[4].errors.join(), /ผู้ดูแลระบบ/, 'non-admins cannot update admin accounts');
    const commit = await expectStatus(`/api/admin/people/import/${p.data.import_id}/commit`, 200, { method: 'POST', token: coord.token, body: { records: p.data.records } });
    assert.equal(commit.counts.created, 2);
    assert.equal(commit.counts.failed, 3);
    // Someone else's import cannot be committed.
    await expectStatus(`/api/admin/people/import/${p.data.import_id}/commit`, 403, { method: 'POST', token: admin.token, body: { records: p.data.records } });

    // Regression: users.import alone cannot grant instructor/partner roles or enroll through the courses column.
    const elevated = await preview(coord.token, ['email,name,roles,organization,courses',
      `${mail('c-course')},Learner,student,,course_cisco_ccna`,
      `${mail('c-partner')},Partner,partner,partner_mit,`
    ].join('\n'));
    assert.equal(elevated.status, 200, JSON.stringify(elevated.data));
    assert.match(elevated.data.rows[0].errors.join(), /users\.manage/);
    assert.match(elevated.data.rows[1].errors.join(), /users\.manage/);
  } finally {
    await setRolePermissions('coordinator', coordinatorBefore);
    await setRolePermissions('instructor', instructorBefore);
  }
});

// ---------- Tags, segments, bulk actions ----------

test('segment rules match the right users for every rule type', async () => {
  const t1 = tag('seg1');
  const t2 = tag('seg2');
  const t3 = tag('seg3');
  const csv = ['email,name,roles,organization,tags,courses,password',
    `${mail('sa')},Seg A,student,,${t1},course_cisco_ccna,segment-pass-123`,
    `${mail('sb')},Seg B,instructor,,${t1}|${t2},,segment-pass-123`,
    `${mail('sc')},Seg C,student,partner_mit,${t3},,segment-pass-123`
  ].join('\n');
  const { commit } = await importCsv(admin.token, csv, { setup: 'password' });
  assert.equal(commit.counts.created, 3, JSON.stringify(commit.results));
  const [A, B, C] = commit.results.map(r => r.user_id);
  const same = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort());

  same(await segmentIds({ tags: [t1] }), [A, B]);
  same(await segmentIds({ tags_all: [t1, t2] }), [B]);
  same(await segmentIds({ tags: [t1], exclude_tags: [t2] }), [A]);
  same(await segmentIds({ tags: [t1], roles: ['instructor'] }), [B]);
  same(await segmentIds({ tags: [t1, t3], partner_ids: ['partner_mit'] }), [C]);
  same(await segmentIds({ tags: [t1, t2, t3], enrolled_course_ids: ['course_cisco_ccna'] }), [A]);
  const completed = await segmentIds({ completed_course_ids: ['course_cf_workers'] });
  assert.ok(completed.includes('usr_student3') && !completed.includes('usr_student1'));
  same(await segmentIds({ tags: [t1], signed_up_after: new Date(Date.now() - 3600000).toISOString() }), [A, B]);
  same(await segmentIds({ tags: [t1], signed_up_before: '2000-01-01' }), []);

  // Activity: A signs in and buys a free course; B never signs in.
  const a = await login(mail('sa'), 'segment-pass-123');
  same(await segmentIds({ tags: [t1], last_active_after: new Date(Date.now() - 600000).toISOString() }), [A]);
  same(await segmentIds({ tags: [t1], last_active_before: new Date(Date.now() - 600000).toISOString() }), [B]);
  const order = await request('/api/student/orders', { method: 'POST', token: a.token, body: { course_id: 'course_nutanix_ncp', voucher_code: 'DEMO-FREE100' } });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  same(await segmentIds({ tags: [t1], has_paid_order: true }), [A]);
  same(await segmentIds({ tags: [t1], has_paid_order: false }), [B]);

  // Suspended accounts are excluded unless status is "any".
  await expectStatus('/api/admin/people/bulk', 200, { method: 'POST', token: admin.token, body: { action: 'suspend', user_ids: [B] } });
  same(await segmentIds({ tags: [t1] }), [A]);
  same(await segmentIds({ tags: [t1], status: 'any' }), [A, B]);
  same(await segmentIds({ tags: [t1], status: 'suspended' }), [B]);

  // Live preview and validation.
  const live = await expectStatus('/api/admin/segments/preview', 200, { method: 'POST', token: admin.token, body: { rules: { tags: [t1, t2, t3], status: 'any' } } });
  assert.equal(live.count, 3);
  await expectStatus('/api/admin/segments/preview', 400, { method: 'POST', token: admin.token, body: { rules: { roles: ['wizard'] } } });
  await expectStatus('/api/admin/segments/preview', 400, { method: 'POST', token: admin.token, body: { rules: { signed_up_after: 'yesterday-ish' } } });

  // Saved segments filter the users list too.
  const saved = await expectStatus('/api/admin/segments', 201, { method: 'POST', token: admin.token, body: { name: 'ทดสอบ', rules: { tags: [t3] } } });
  const list = await expectStatus(`/api/admin/accounts?segment_id=${saved.segment.id}`, 200, { token: admin.token });
  assert.deepEqual(list.users.map(u => u.id), [C]);
  const byTag = await expectStatus(`/api/admin/accounts?tag=${encodeURIComponent(t2)}`, 200, { token: admin.token });
  assert.deepEqual(byTag.users.map(u => u.id), [B]);
  assert.deepEqual(byTag.users[0].tags, [t1, t2].sort());
  const segments = await expectStatus('/api/admin/segments', 200, { token: admin.token });
  assert.equal(segments.segments.find(s => s.id === saved.segment.id).count, 1);
  const student = await login('student3@netprime.com', 'stud123');
  await expectStatus(`/api/admin/segments/${saved.segment.id}/users`, 403, { token: student.token });
});

test('bulk actions tag, enroll, suspend, activate and export selected users', async () => {
  const { commit } = await importCsv(admin.token, `email,name\n${mail('bulk1')},Bulk One\n${mail('bulk2')},Bulk Two`);
  const ids = commit.results.map(r => r.user_id);
  const bulk = (token, body) => request('/api/admin/people/bulk', { method: 'POST', token, body });
  const t = tag('bulk');

  assert.equal((await bulk(admin.token, { action: 'add_tag', user_ids: ids, tag: t })).data.done, 2);
  assert.equal((await expectStatus(`/api/admin/accounts?tag=${encodeURIComponent(t)}`, 200, { token: admin.token })).total, 2);
  assert.equal((await bulk(admin.token, { action: 'add_tag', user_ids: ids, tag: 'bad,tag' })).status, 400);
  assert.equal((await bulk(admin.token, { action: 'remove_tag', user_ids: [ids[0]], tag: t })).data.done, 1);
  assert.equal((await expectStatus(`/api/admin/accounts?tag=${encodeURIComponent(t)}`, 200, { token: admin.token })).total, 1);

  const enrolled = await bulk(admin.token, { action: 'enroll', user_ids: ids, course_id: 'course_aws_csa' });
  assert.equal(enrolled.data.done, 2);
  assert.equal((await bulk(admin.token, { action: 'enroll', user_ids: ids, course_id: 'course_missing' })).status, 400);
  const detail = await expectStatus(`/api/admin/people/${ids[0]}`, 200, { token: admin.token });
  assert.ok(detail.enrollments.some(e => e.course_id === 'course_aws_csa' && e.status === 'active'));

  const suspended = await bulk(admin.token, { action: 'suspend', user_ids: [...ids, 'usr_admin', 'usr_missing'] });
  assert.equal(suspended.data.done, 2);
  assert.equal(suspended.data.failed.length, 2, 'own account and unknown ids are reported, not applied');
  assert.equal((await expectStatus(`/api/admin/people/${ids[1]}`, 200, { token: admin.token })).user.status, 'suspended');
  assert.equal((await bulk(admin.token, { action: 'activate', user_ids: ids })).data.done, 2);

  // A coordinator with only users.import may tag but not suspend; nobody else may act.
  const before = await rolePermissions('coordinator');
  try {
    await setRolePermissions('coordinator', [...before, 'users.import']);
    const coord = await coordLogin();
    assert.equal((await bulk(coord.token, { action: 'add_tag', user_ids: ids, tag: t })).status, 200);
    assert.equal((await bulk(coord.token, { action: 'suspend', user_ids: ids })).status, 403);
  } finally {
    await setRolePermissions('coordinator', before);
  }
  const student = await login('student3@netprime.com', 'stud123');
  assert.equal((await bulk(student.token, { action: 'add_tag', user_ids: ids, tag: t })).status, 403);

  const exported = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/admin/people/export`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ user_ids: ids })
  });
  assert.equal(exported.status, 200);
  const text = await exported.text();
  const lines = text.replace(/^\ufeff/, '').trim().split('\r\n');
  assert.match(lines[0], /^email,name,roles,organization,tags,courses,status/);
  assert.equal(lines.length, 3);
  assert.ok(lines.some(l => l.startsWith(mail('bulk2')) && l.includes(t) && l.includes('course_aws_csa')));
});

test('user detail is limited to users.view and staff notes to users.manage', async () => {
  const student = await login('student3@netprime.com', 'stud123');
  const coord = await coordLogin();
  await expectStatus('/api/admin/people/usr_student3', 403, { token: student.token });
  await expectStatus('/api/admin/people/usr_student3', 403, { token: coord.token });
  await expectStatus('/api/admin/people/usr_nobody', 404, { token: admin.token });

  const note = await expectStatus('/api/admin/people/usr_student3/notes', 201, { method: 'POST', token: admin.token, body: { body: 'โทรติดตามแล้ว สนใจคอร์ส CCNP' } });
  await expectStatus('/api/admin/people/usr_student3/notes', 400, { method: 'POST', token: admin.token, body: { body: '  ' } });
  await expectStatus('/api/admin/people/usr_student3/notes', 403, { method: 'POST', token: student.token, body: { body: 'x' } });
  const detail = await expectStatus('/api/admin/people/usr_student3', 200, { token: admin.token });
  assert.equal(detail.user.email, 'student3@netprime.com');
  assert.ok(detail.enrollments.some(e => e.course_id === 'course_cf_workers' && e.progress_percent === 100));
  assert.ok(Array.isArray(detail.orders) && Array.isArray(detail.payments) && Array.isArray(detail.certificates) && Array.isArray(detail.events));
  assert.ok(detail.notes.some(n => n.id === note.note.id));

  const before = await rolePermissions('coordinator');
  try {
    await setRolePermissions('coordinator', [...before, 'users.view']);
    const viewer = await coordLogin();
    const seen = await expectStatus('/api/admin/people/usr_student3', 200, { token: viewer.token });
    assert.equal(seen.notes, null, 'notes need users.manage');
    assert.equal(seen.canManage, false);
    await expectStatus('/api/admin/people/usr_student3/tags', 403, { method: 'POST', token: viewer.token, body: { tag: 'x' } });
    const meta = await expectStatus('/api/admin/people-meta', 200, { token: viewer.token });
    assert.ok(meta.courses.length > 0 && Array.isArray(meta.fields));
  } finally {
    await setRolePermissions('coordinator', before);
  }
  await expectStatus(`/api/admin/people/usr_student3/notes/${note.note.id}`, 200, { method: 'DELETE', token: admin.token });

  const tagged = await expectStatus('/api/admin/people/usr_student3/tags', 200, { method: 'POST', token: admin.token, body: { tag: ` VIP ${run} ` } });
  assert.ok(tagged.tags.includes(`vip ${run}`), 'tags are trimmed and lower-cased');
  const untagged = await expectStatus(`/api/admin/people/usr_student3/tags/${encodeURIComponent(`vip ${run}`)}`, 200, { method: 'DELETE', token: admin.token });
  assert.ok(!untagged.tags.includes(`vip ${run}`));
  const all = await expectStatus('/api/admin/tags', 200, { token: admin.token });
  assert.ok(Array.isArray(all.tags));
});
