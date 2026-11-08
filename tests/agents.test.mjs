// Agent platform suite (phase 1): agent keys (scopes, daily quota, time window, IP allowlist, pause),
// the v1 read endpoints for coordinators' work, the action queue (draft runs at once, act waits for
// approval; dry run and idempotency keys) and the pull-based event feed GET /v1/events.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request, login, expectStatus } from './helpers.mjs';

let admin, coord, student;
const agent = {};
const api = (path, key, options = {}) => request(path, { ...options, headers: { Authorization: `Bearer ${key}`, ...(options.headers || {}) } });
const day = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const AGENT_SCOPES = ['sessions:read', 'registrations:read', 'leads:read', 'inquiries:read', 'reports:read', 'events:read', 'orders:read',
  'inquiries:write', 'leads:write', 'orders:confirm', 'registrations:write', 'sessions:publish', 'messages:send', 'enrollments:write', 'users:write'];
const fixtures = {};

test('setup: sign in and create website activity', async () => {
  admin = (await login('admin@netprime.com', 'admin123')).token;
  coord = (await login('coord@netprime.com', 'coord123')).token;
  student = (await login('student3@netprime.com', 'stud123')).token;
  const { session } = await expectStatus('/api/admin/site/sessions', 201, { method: 'POST', token: admin, body: {
    title: 'Agent Test Round', vendor: 'Cisco', start_date: day(3), end_date: day(4), capacity: 5, price: 9900, status: 'open'
  } });
  fixtures.session = session.id;
  const { session: draft } = await expectStatus('/api/admin/site/sessions', 201, { method: 'POST', token: admin, body: {
    title: 'Agent Draft Round', vendor: 'Aruba', start_date: day(30), end_date: day(31), capacity: 10, price: 5000, status: 'draft'
  } });
  fixtures.draftSession = draft.id;
  const reg = await expectStatus(`/api/public/sessions/${session.id}/register`, 201, { method: 'POST',
    body: { name: 'ผู้สมัครเอเจนต์', email: 'agent-reg@example.invalid', phone: '0812345678', consent: true } });
  fixtures.registration = reg.registration.id;
  const inquiry = await expectStatus('/api/public/inquiries', 201, { method: 'POST',
    body: { name: 'ผู้ติดต่อเอเจนต์', email: 'agent-contact@example.invalid', message: 'สนใจอบรมแบบ In-house', consent: true } });
  fixtures.inquiry = inquiry.id;
});

// ==========================================
// Agent keys
// ==========================================

test('agent keys: validated settings, integration keys cannot take agent limits', async () => {
  const create = body => request('/api/admin/platform/api-keys', { method: 'POST', token: admin, body: { name: 'x', kind: 'agent', scopes: ['reports:read'], ...body } });
  assert.equal((await create({ kind: 'robot' })).status, 400);
  assert.equal((await create({ allowed_hours: '25:00-26:00' })).status, 400);
  assert.equal((await create({ allowed_hours: '09:00-09:00' })).status, 400);
  assert.equal((await create({ allowed_days: [0, 8] })).status, 400);
  assert.equal((await create({ allowed_ips: 'not-an-ip' })).status, 400);
  assert.equal((await create({ allowed_ips: '10.0.0.0/33' })).status, 400);
  assert.equal((await create({ daily_limit: 0 })).status, 400);
  assert.equal((await create({ kind: 'integration', daily_limit: 100 })).status, 400);

  const made = await expectStatus('/api/admin/platform/api-keys', 201, { method: 'POST', token: admin, body: {
    name: 'Hermes (DGX Spark)', kind: 'agent', description: 'ผู้ช่วยงานประสานงาน', scopes: AGENT_SCOPES, rate_limit_per_minute: 1000, daily_limit: 5000,
    allowed_days: [1, 2, 3, 4, 5, 6, 7], allowed_ips: '127.0.0.1, 10.0.0.0/8'
  } });
  assert.equal(made.key.kind, 'agent');
  assert.equal(made.key.allowed_days, null, 'all seven days = no restriction');
  agent.key = made.secret;
  agent.id = made.key.id;
  // The local Worker sees no CF-Connecting-IP; lift the IP rule again for the rest of the suite.
  await expectStatus(`/api/admin/platform/api-keys/${agent.id}`, 200, { method: 'PATCH', token: admin, body: { allowed_ips: null } });

  const list = await expectStatus('/api/admin/platform/api-keys', 200, { token: admin });
  const row = list.keys.find(k => k.id === agent.id);
  assert.equal(row.daily_limit, 5000);
  assert.equal(row.description, 'ผู้ช่วยงานประสานงาน');
  assert.ok(list.scopes.some(s => s.name === 'orders:confirm'));
});

test('v1 /me and /tools describe the key and the three tool tiers', async () => {
  const me = await api('/api/v1/me', agent.key);
  assert.equal(me.status, 200);
  assert.equal(me.data.data.kind, 'agent');
  assert.equal(me.data.data.timezone, 'Asia/Bangkok');
  const tools = (await api('/api/v1/tools', agent.key)).data.data;
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  assert.equal(byName.get_daily_ops_summary.tier, 'read');
  assert.equal(byName.update_inquiry.tier, 'draft');
  assert.equal(byName.confirm_order.tier, 'act');
  assert.equal(byName.confirm_order.requires_approval, true);
  assert.equal(byName.confirm_order.approver_permission, 'payments.manage');
  assert.deepEqual(byName.confirm_order.input_schema.required.sort(), ['amount_received', 'order_id']);
  assert.equal(byName.publish_article.available, false, 'articles:publish was not granted');
  const doc = await expectStatus('/api/v1/openapi.json', 200);
  assert.ok(doc.paths['/actions'].post && doc.paths['/events'].get && doc.paths['/ops/daily-summary'].get);
});

test('agent keys cannot write directly: changes go through the queue', async () => {
  const enroll = await api('/api/v1/enrollments', agent.key, { method: 'POST', body: { course_id: 'course_cisco_ccna', email: 'student3@netprime.com' } });
  assert.equal(enroll.status, 403);
  assert.equal(enroll.data.code, 'approval_required');
  assert.equal(enroll.data.tool, 'grant_enrollment');
  const user = await api('/api/v1/users', agent.key, { method: 'POST', body: { email: 'agent-made@example.invalid', name: 'x' } });
  assert.equal(user.data.code, 'approval_required');
  const scoped = await api('/api/v1/courses', agent.key);
  assert.equal(scoped.status, 403);
  assert.equal(scoped.data.code, 'insufficient_scope');
});

// ==========================================
// Read endpoints
// ==========================================

test('v1 reads: training rounds with seats, registrants, inquiries, leads, reports and the daily summary', async () => {
  const sessions = (await api(`/api/v1/training-sessions?status=open&from=${day(0)}&limit=200`, agent.key)).data.data;
  const round = sessions.find(s => s.id === fixtures.session);
  assert.equal(round.seats_taken, 1);
  assert.equal(round.seats_left, 4);
  assert.equal(round.pending_registrations, 1);
  assert.equal((await api(`/api/v1/training-sessions/${fixtures.session}`, agent.key)).data.data.title, 'Agent Test Round');
  assert.equal((await api('/api/v1/training-sessions/ses_nope', agent.key)).status, 404);
  assert.equal((await api('/api/v1/training-sessions?from=tomorrow', agent.key)).status, 400);

  const regs = (await api(`/api/v1/registrations?session_id=${fixtures.session}`, agent.key)).data.data;
  assert.equal(regs.length, 1);
  assert.equal(regs[0].email, 'agent-reg@example.invalid');
  assert.equal(regs[0].slip_uploaded, false);
  assert.equal((await api('/api/v1/registrations?since=yesterday', agent.key)).status, 400);
  const future = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal((await api(`/api/v1/registrations?since=${future}`, agent.key)).data.data.length, 0);

  const inquiries = (await api('/api/v1/inquiries?status=new&limit=200', agent.key)).data.data;
  assert.ok(inquiries.some(i => i.id === fixtures.inquiry));
  assert.equal((await api('/api/v1/leads', agent.key)).status, 200);

  const report = (await api(`/api/v1/reports/summary?from=${day(-1)}&to=${day(1)}`, agent.key)).data.data;
  assert.ok(report.registrations >= 1 && report.inquiries >= 1);
  assert.equal((await api(`/api/v1/reports/summary?from=${day(1)}&to=${day(-1)}`, agent.key)).status, 400);

  const ops = (await api('/api/v1/ops/daily-summary', agent.key)).data.data;
  assert.ok(ops.upcoming_sessions.some(s => s.id === fixtures.session));
  assert.ok(ops.counts.registrations_pending >= 1);
  assert.ok(ops.highlights.some(h => h.includes('ข้อความติดต่อ')));
});

// ==========================================
// Event feed
// ==========================================

test('events: pull feed of new registrations and inquiries with a since cursor', async () => {
  const first = await api('/api/v1/events?types=registration.created,inquiry.created', agent.key);
  assert.equal(first.status, 200);
  const events = first.data.data;
  const reg = events.find(e => e.event === 'registration.created' && e.data.registration_id === fixtures.registration);
  assert.ok(reg, JSON.stringify(events));
  assert.equal(reg.data.session_id, fixtures.session);
  assert.ok(events.some(e => e.event === 'inquiry.created' && e.data.inquiry_id === fixtures.inquiry));
  agent.since = first.data.next_since;
  const again = await api(`/api/v1/events?since=${agent.since}&types=registration.created,inquiry.created`, agent.key);
  assert.equal(again.data.data.length, 0);
  assert.equal(again.data.next_since, agent.since);
  assert.equal((await api('/api/v1/events?types=nope.happened', agent.key)).status, 400);
  assert.equal((await api('/api/v1/events?since=abc', agent.key)).status, 400);
});

// ==========================================
// Action queue
// ==========================================

test('draft tool: dry run changes nothing, then runs at once and is audited as the agent', async () => {
  const body = { tool: 'update_inquiry', input: { inquiry_id: fixtures.inquiry, status: 'in_progress', note: 'ลูกค้าต้องการใบเสนอราคา 10 คน' } };
  const dry = await api('/api/v1/actions', agent.key, { method: 'POST', body: { ...body, dry_run: true } });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.dry_run, true);
  assert.equal(dry.data.requires_approval, false);
  assert.match(dry.data.preview.summary, /new → in_progress/);
  let row = (await api(`/api/v1/inquiries?status=new&limit=200`, agent.key)).data.data.find(i => i.id === fixtures.inquiry);
  assert.ok(row, 'still new after a dry run');

  assert.equal((await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'update_inquiry', input: { inquiry_id: fixtures.inquiry } } })).status, 400);
  assert.equal((await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'update_inquiry', input: { inquiry_id: fixtures.inquiry, extra: 1, note: 'x' } } })).status, 400);
  assert.equal((await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'update_inquiry', input: { inquiry_id: 'inq_nope', note: 'x' } } })).status, 404);
  assert.equal((await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'list_leads', input: {} } })).data.code, 'read_tool');
  assert.equal((await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'rm_rf', input: {} } })).status, 404);
  assert.equal((await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'publish_article', input: { article_id: 'x' } } })).data.code, 'insufficient_scope');

  const done = await api('/api/v1/actions', agent.key, { method: 'POST', body });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.data.data.status, 'executed');
  assert.equal(done.data.data.tier, 'draft');
  row = (await api(`/api/v1/inquiries?status=in_progress&limit=200`, agent.key)).data.data.find(i => i.id === fixtures.inquiry);
  assert.match(row.admin_note, /\[agent Hermes \(DGX Spark\)/);
  assert.match(row.admin_note, /ใบเสนอราคา/);

  const audit = await expectStatus('/api/admin/site/audit?limit=50', 200, { token: admin });
  const entry = audit.entries.find(e => e.entity === 'inquiry' && e.entity_id === fixtures.inquiry && e.api_key_id === agent.id);
  assert.ok(entry, 'audit entry names the agent key');
  assert.equal(entry.agent_name, 'Hermes (DGX Spark)');
});

test('act tool: confirm_order is queued with idempotency, approved by a person, then runs the staff flow', async () => {
  const created = await expectStatus('/api/student/orders', 201, { method: 'POST', token: student, body: { course_id: 'course_aws_net' } });
  const order = created.order;
  const input = { order_id: order.reference, amount_received: order.amount };

  const dry = await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'confirm_order', input, dry_run: true } });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.requires_approval, true);
  assert.equal(dry.data.preview.target.order_id, order.id);
  assert.ok(dry.data.preview.warnings.some(w => w.includes('สลิป')));

  const queued = await api('/api/v1/actions', agent.key, { method: 'POST', headers: { 'Idempotency-Key': `confirm-${order.id}` },
    body: { tool: 'confirm_order', input, reason: 'ยอดโอนตรงกับ statement ธนาคาร' } });
  assert.equal(queued.status, 202, JSON.stringify(queued.data));
  assert.equal(queued.data.data.status, 'pending');
  assert.equal(queued.data.data.reason, 'ยอดโอนตรงกับ statement ธนาคาร');
  const actionId = queued.data.data.id;
  const replay = await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'confirm_order', input, idempotency_key: `confirm-${order.id}` } });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.data.id, actionId);
  const conflict = await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'confirm_order', input: { ...input, amount_received: 1 }, idempotency_key: `confirm-${order.id}` } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'idempotency_conflict');
  assert.equal((await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'confirm_order', input, idempotency_key: 'bad key!' } })).status, 400);

  const pendingOrder = (await expectStatus(`/api/manage/orders?status=pending&q=${order.reference}`, 200, { token: admin })).orders[0];
  assert.equal(pendingOrder.status, 'pending', 'nothing happens before approval');

  // The coordinator role has no agents.approve by default.
  await expectStatus('/api/admin/agents/actions', 403, { token: coord });
  const queue = await expectStatus('/api/admin/agents/actions?status=pending', 200, { token: admin });
  const item = queue.actions.find(a => a.id === actionId);
  assert.equal(item.agent_name, 'Hermes (DGX Spark)');
  assert.equal(item.can_approve, true);
  const detail = await expectStatus(`/api/admin/agents/actions/${actionId}`, 200, { token: admin });
  assert.equal(detail.current.target.status, 'pending');

  const approved = await expectStatus(`/api/admin/agents/actions/${actionId}/approve`, 200, { method: 'POST', token: admin, body: { note: 'ตรวจ statement แล้ว' } });
  assert.equal(approved.action.status, 'executed', JSON.stringify(approved.action));
  assert.equal(approved.action.decided_by_name, 'System Administrator');
  assert.equal(approved.action.result.order.status, 'paid');
  assert.match(approved.action.result.order.receipt_no, /^RC-/);
  await expectStatus(`/api/admin/agents/actions/${actionId}/approve`, 409, { method: 'POST', token: admin });

  const seen = (await api(`/api/v1/actions/${actionId}`, agent.key)).data.data;
  assert.equal(seen.status, 'executed');
  assert.equal(seen.decision_note, 'ตรวจ statement แล้ว');
  const feed = await api(`/api/v1/events?since=${agent.since}&types=action.updated,order.paid`, agent.key);
  assert.ok(feed.data.data.some(e => e.event === 'action.updated' && e.data.action_id === actionId && e.data.status === 'executed'));
  assert.ok(feed.data.data.some(e => e.event === 'order.paid' && e.data.order_id === order.id));
  assert.ok(feed.data.data.every(e => !e.data || e.data.api_key_id === undefined));

  const audit = await expectStatus('/api/admin/site/audit?limit=50', 200, { token: admin });
  assert.ok(audit.entries.some(e => e.action === 'agent_approve' && e.entity_id === actionId && e.api_key_id === agent.id));
  assert.ok(audit.entries.some(e => e.action === 'confirm' && e.entity === 'course_order' && e.entity_id === order.id), 'the staff route wrote its usual audit');
});

test('act tools through staff routes: registration status, round publishing and course access', async () => {
  const submit = async body => {
    const res = await api('/api/v1/actions', agent.key, { method: 'POST', body });
    assert.equal(res.status, 202, JSON.stringify(res.data));
    return res.data.data.id;
  };
  const approve = id => expectStatus(`/api/admin/agents/actions/${id}/approve`, 200, { method: 'POST', token: admin, body: {} });

  const same = await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'update_registration', input: { registration_id: fixtures.registration, status: 'pending' } } });
  assert.equal(same.data.code, 'no_change');
  const regAction = await submit({ tool: 'update_registration', input: { registration_id: fixtures.registration, status: 'confirmed', admin_note: 'โทรยืนยันแล้ว' } });
  const reg = await approve(regAction);
  assert.equal(reg.action.status, 'executed', JSON.stringify(reg.action));
  const regs = (await api(`/api/v1/registrations?session_id=${fixtures.session}`, agent.key)).data.data;
  assert.equal(regs[0].status, 'confirmed');
  assert.match(regs[0].admin_note, /โทรยืนยันแล้ว/);

  const pubAction = await submit({ tool: 'publish_session', input: { session_id: fixtures.draftSession, status: 'open' } });
  assert.equal((await approve(pubAction)).action.status, 'executed');
  assert.equal((await api(`/api/v1/training-sessions/${fixtures.draftSession}`, agent.key)).data.data.status, 'open');

  const already = await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'grant_enrollment', dry_run: true, input: { course_id: 'course_cisco_ccna', email: 'student3@netprime.com' } } });
  assert.ok(already.data.preview.warnings.some(w => w.includes('อยู่แล้ว')));
  const enrAction = await submit({ tool: 'grant_enrollment', input: { course_id: 'course_cisco_ccna', email: 'student2@netprime.com' } });
  const enr = await approve(enrAction);
  assert.equal(enr.action.status, 'executed', JSON.stringify(enr.action));
  assert.equal(enr.action.result.created, true);
  const learner = (await login('student2@netprime.com', 'stud123')).token;
  const course = await expectStatus('/api/courses/course_cisco_ccna', 200, { token: learner });
  assert.ok(course.enrollment, 'learner can open the course');
});

test('state changes after submission fail the action instead of acting on stale data', async () => {
  const created = await expectStatus('/api/student/orders', 201, { method: 'POST', token: student, body: { course_id: 'course_aws_sec' } });
  const queued = await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'confirm_order', input: { order_id: created.order.id, amount_received: created.order.amount } } });
  assert.equal(queued.status, 202);
  await expectStatus(`/api/manage/orders/${created.order.id}/confirm`, 200, { method: 'POST', token: admin, body: { amount_received: created.order.amount } });
  const approved = await expectStatus(`/api/admin/agents/actions/${queued.data.data.id}/approve`, 200, { method: 'POST', token: admin, body: {} });
  assert.equal(approved.action.status, 'failed');
  assert.match(approved.action.error, /ข้อมูลเปลี่ยนไป/);
});

test('reject and cancel: the agent sees the decision; email only goes to known contacts', async () => {
  const stranger = await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'send_email', input: { to: 'stranger@example.invalid', subject: 'hi', body: 'x' } } });
  assert.equal(stranger.status, 422);
  assert.equal(stranger.data.code, 'unknown_recipient');
  const mail = await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'send_email',
    input: { to: 'agent-contact@example.invalid', subject: 'ใบเสนอราคาอบรม', body: 'เรียนคุณผู้ติดต่อ\n\nแนบใบเสนอราคา' } } });
  assert.equal(mail.status, 202, JSON.stringify(mail.data));
  const mailId = mail.data.data.id;
  await expectStatus(`/api/admin/agents/actions/${mailId}/reject`, 400, { method: 'POST', token: admin, body: {} });
  const rejected = await expectStatus(`/api/admin/agents/actions/${mailId}/reject`, 200, { method: 'POST', token: admin, body: { note: 'ราคาไม่ถูกต้อง' } });
  assert.equal(rejected.action.status, 'rejected');
  const seen = (await api(`/api/v1/actions/${mailId}`, agent.key)).data.data;
  assert.equal(seen.status, 'rejected');
  assert.equal(seen.decision_note, 'ราคาไม่ถูกต้อง');
  await expectStatus(`/api/admin/agents/actions/${mailId}/approve`, 409, { method: 'POST', token: admin });

  const line = await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'send_line', input: { user_id: 'usr_student3', text: 'x' } } });
  assert.equal(line.data.code, 'line_not_linked');

  const mail2 = await api('/api/v1/actions', agent.key, { method: 'POST', body: { tool: 'send_email', input: { to: 'student3@netprime.com', subject: 'แจ้งเตือน', body: 'x' } } });
  const cancelled = await api(`/api/v1/actions/${mail2.data.data.id}/cancel`, agent.key, { method: 'POST' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.data.status, 'cancelled');
  assert.equal((await api(`/api/v1/actions/${mail2.data.data.id}/cancel`, agent.key, { method: 'POST' })).status, 409);
  const mine = (await api('/api/v1/actions?status=cancelled', agent.key)).data.data;
  assert.ok(mine.some(a => a.id === mail2.data.data.id));
});

test('other keys cannot see this agent’s actions', async () => {
  const other = await expectStatus('/api/admin/platform/api-keys', 201, { method: 'POST', token: admin, body: { name: 'Other agent', kind: 'agent', scopes: ['reports:read'] } });
  const list = (await api('/api/v1/actions', other.secret)).data.data;
  assert.equal(list.length, 0);
  const anyId = (await api('/api/v1/actions', agent.key)).data.data[0].id;
  assert.equal((await api(`/api/v1/actions/${anyId}`, other.secret)).status, 404);
  assert.equal((await api(`/api/v1/actions/${anyId}/cancel`, other.secret, { method: 'POST' })).status, 404);
});

// ==========================================
// Limits and the kill switch
// ==========================================

test('pause stops an agent at once; resume needs integrations.manage; refusals are logged', async () => {
  await expectStatus(`/api/admin/agents/keys/${agent.id}/pause`, 200, { method: 'POST', token: admin });
  const paused = await api('/api/v1/me', agent.key);
  assert.equal(paused.status, 403);
  assert.equal(paused.data.code, 'key_paused');
  await expectStatus(`/api/admin/agents/keys/${agent.id}/pause`, 404, { method: 'POST', token: admin });
  await expectStatus(`/api/admin/agents/keys/${agent.id}/resume`, 200, { method: 'POST', token: admin });
  assert.equal((await api('/api/v1/me', agent.key)).status, 200);

  const log = await expectStatus(`/api/admin/agents/activity?key_id=${agent.id}&limit=500`, 200, { token: admin });
  assert.ok(log.activity.some(a => a.path === '/api/v1/me' && a.status === 403), 'the refused call is in the log');
  assert.ok(log.activity.some(a => a.path === '/api/v1/actions' && a.method === 'POST' && a.action_id), 'queued actions link to the request');
  const row = log.agents.find(a => a.id === agent.id);
  assert.ok(row.requests_24h > 10);
});

test('time window, IP allowlist and daily quota', async () => {
  // A one-minute window twelve hours away from now (Bangkok time) is always closed.
  const bkk = new Date(Date.now() + 7 * 3_600_000 + 12 * 3_600_000);
  const hh = String(bkk.getUTCHours()).padStart(2, '0');
  await expectStatus(`/api/admin/platform/api-keys/${agent.id}`, 200, { method: 'PATCH', token: admin, body: { allowed_hours: `${hh}:00-${hh}:01` } });
  const closed = await api('/api/v1/me', agent.key);
  assert.equal(closed.status, 403);
  assert.equal(closed.data.code, 'outside_allowed_hours');
  await expectStatus(`/api/admin/platform/api-keys/${agent.id}`, 200, { method: 'PATCH', token: admin, body: { allowed_hours: null } });
  assert.equal((await api('/api/v1/me', agent.key)).status, 200);

  await expectStatus(`/api/admin/platform/api-keys/${agent.id}`, 200, { method: 'PATCH', token: admin, body: { allowed_ips: '203.0.113.7' } });
  const blocked = await api('/api/v1/me', agent.key);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'ip_not_allowed');
  await expectStatus(`/api/admin/platform/api-keys/${agent.id}`, 200, { method: 'PATCH', token: admin, body: { allowed_ips: null } });

  const small = await expectStatus('/api/admin/platform/api-keys', 201, { method: 'POST', token: admin, body: { name: 'Tiny agent', kind: 'agent', scopes: ['reports:read'], daily_limit: 2 } });
  assert.equal((await api('/api/v1/me', small.secret)).status, 200);
  assert.equal((await api('/api/v1/me', small.secret)).status, 200);
  const over = await api('/api/v1/me', small.secret);
  assert.equal(over.status, 429);
  assert.equal(over.data.code, 'daily_quota_exceeded');

  await expectStatus(`/api/admin/platform/api-keys/${agent.id}`, 400, { method: 'PATCH', token: admin, body: { allowed_hours: 'always' } });
  await expectStatus(`/api/admin/platform/api-keys/${agent.id}`, 403, { method: 'PATCH', token: coord, body: { daily_limit: 1 } });
});
