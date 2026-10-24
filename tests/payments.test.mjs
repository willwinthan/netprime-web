// Manual bank-transfer orders, staff confirmation, receipts, refunds and certificate revocation.
import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let admin, coord, student, other;
before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  coord = await login('coord@netprime.com', 'coord123');
  student = await login('student3@netprime.com', 'stud123');
  other = await login('student1@netprime.com', 'stud123');
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function uploadSlip(token, orderId, bytes = PNG, type = 'image/png', name = 'slip.png') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const response = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/student/orders/${orderId}/slip`, {
    method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

const createOrder = (token, course_id, voucher_code) =>
  request('/api/student/orders', { method: 'POST', token, body: { course_id, ...(voucher_code ? { voucher_code } : {}) } });

const enrollmentOf = async (token, courseId) => (await expectStatus(`/api/courses/${courseId}`, 200, { token })).enrollment;

test('card checkout is closed and the old webhook cannot activate anything', async () => {
  const session = await request('/api/student/checkout/session', { method: 'POST', token: student.token, body: { course_id: 'course_aws_net' } });
  assert.equal(session.status, 410);
  assert.match(session.data.error, /โอนเงิน/);
  const hook = await request('/api/payment/omise-webhook', { method: 'POST', body: { key: 'charge.complete', data: { id: 'chrg_test_1' } } });
  assert.equal(hook.status, 410);
  assert.equal(await enrollmentOf(student.token, 'course_aws_net'), null);
});

test('order is created with a reference and bank instructions; one open order per course', async () => {
  const created = await createOrder(student.token, 'course_cf_d1_r2');
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { order, instructions } = created.data;
  assert.match(order.reference, /^NP-\d{6}$/);
  assert.equal(order.status, 'pending');
  assert.equal(order.amount, 2065);
  assert.equal(order.has_slip, false);
  assert.ok(new Date(order.expires_at).getTime() > Date.now() + 2.9 * 86400000);
  assert.ok(instructions.account_number);
  assert.equal(order.slip_r2_key, undefined);

  const again = await createOrder(student.token, 'course_cf_d1_r2');
  assert.equal(again.status, 409);
  assert.equal(again.data.order.id, order.id);

  const mine = await expectStatus('/api/student/orders', 200, { token: student.token });
  assert.ok(mine.orders.some(o => o.id === order.id));

  // Cancelling frees the slot for a new order.
  await expectStatus(`/api/student/orders/${order.id}/cancel`, 200, { method: 'POST', token: student.token });
  const fresh = await createOrder(student.token, 'course_cf_d1_r2');
  assert.equal(fresh.status, 201);
  assert.notEqual(fresh.data.order.reference, order.reference);
});

test('paid course enrollment requires a confirmed order; free/already enrolled cases are refused', async () => {
  const direct = await request('/api/courses/course_cisco_ccnp/enroll', { method: 'POST', token: student.token });
  assert.equal(direct.status, 403);
  const enrolled = await createOrder(student.token, 'course_cisco_ccna');
  assert.equal(enrolled.status, 400, 'student3 already has active access to CCNA');
  assert.equal((await createOrder(student.token, 'course_missing')).status, 404);
});

test('vouchers: discount applied, exhausted voucher rejected on apply and on order', async () => {
  const usedUp = await request('/api/student/vouchers/apply', { method: 'POST', token: student.token, body: { code: 'DEMO-USEDUP', course_id: 'course_aws_csa' } });
  assert.equal(usedUp.status, 400);
  assert.equal((await createOrder(student.token, 'course_aws_csa', 'DEMO-USEDUP')).status, 400);

  const applied = await expectStatus('/api/student/vouchers/apply', 200, { method: 'POST', token: student.token, body: { code: 'demo-once20', course_id: 'course_aws_csa' } });
  assert.equal(applied.final_price, Math.round(5215 * 0.8));
  const order = await createOrder(student.token, 'course_aws_csa', 'DEMO-ONCE20');
  assert.equal(order.status, 201);
  assert.equal(order.data.order.amount, Math.round(5215 * 0.8));
  assert.equal(order.data.order.voucher_code, 'DEMO-ONCE20');
});

test('slip upload: owner and payments.manage can read it, another learner cannot', async () => {
  const { data } = await createOrder(student.token, 'course_aws_devops');
  const orderId = data.order.id;
  const badType = await uploadSlip(student.token, orderId, new TextEncoder().encode('hello'), 'text/plain', 'a.txt');
  assert.equal(badType.status, 400);
  const fakePng = await uploadSlip(student.token, orderId, new TextEncoder().encode('not a png'), 'image/png');
  assert.equal(fakePng.status, 400);
  assert.equal((await uploadSlip(other.token, orderId)).status, 404, 'another learner cannot attach a slip');

  const uploaded = await uploadSlip(student.token, orderId);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.order.has_slip, true);

  const own = await request(`/api/orders/${orderId}/slip`, { token: student.token });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/png');
  assert.equal((await request(`/api/orders/${orderId}/slip`, { token: other.token })).status, 403);
  assert.equal((await request(`/api/orders/${orderId}/slip`, { token: coord.token })).status, 200);
  assert.equal((await request(`/api/orders/${orderId}/slip`)).status, 401);
});

test('learners cannot use staff endpoints; coordinator confirms, enrollment opens and receipt is issued', async () => {
  const { data } = await createOrder(student.token, 'course_aws_sec');
  const orderId = data.order.id;
  for (const path of ['/api/manage/orders', '/api/manage/payment-settings']) {
    assert.equal((await request(path, { token: student.token })).status, 403);
  }
  const denied = await request(`/api/manage/orders/${orderId}/confirm`, { method: 'POST', token: student.token, body: { amount_received: 5915 } });
  assert.equal(denied.status, 403);
  assert.equal(await enrollmentOf(student.token, 'course_aws_sec'), null);

  const list = await expectStatus(`/api/manage/orders?status=pending&q=${data.order.reference}`, 200, { token: coord.token });
  assert.equal(list.orders.length, 1);
  assert.equal(list.orders[0].user_email, 'student3@netprime.com');
  assert.equal((await request('/api/manage/orders?q=student3@netprime', { token: coord.token })).data.orders.some(o => o.id === orderId), true);

  assert.equal((await request(`/api/manage/orders/${orderId}/confirm`, { method: 'POST', token: coord.token, body: {} })).status, 400);
  const confirmed = await expectStatus(`/api/manage/orders/${orderId}/confirm`, 200, { method: 'POST', token: coord.token, body: { amount_received: 5915 } });
  assert.equal(confirmed.order.status, 'paid');
  assert.match(confirmed.order.receipt_no, /^RC-\d{4}-\d{6}$/);
  assert.equal(confirmed.order.amount_received, 5915);
  assert.equal(confirmed.order.confirmed_by_name, 'Nok (Training Coordinator)');
  assert.ok(confirmed.order.paid_at);
  const enrollment = await enrollmentOf(student.token, 'course_aws_sec');
  assert.equal(enrollment.status, 'active');

  const twice = await request(`/api/manage/orders/${orderId}/confirm`, { method: 'POST', token: coord.token, body: { amount_received: 5915 } });
  assert.equal(twice.status, 400);

  const notifications = await expectStatus('/api/notifications', 200, { token: student.token });
  assert.ok(notifications.some(n => n.content.includes(confirmed.order.receipt_no)));
  const mine = await expectStatus(`/api/student/orders/${orderId}`, 200, { token: student.token });
  assert.equal(mine.order.receipt_no, confirmed.order.receipt_no);
});

test('exhausted voucher at confirmation still confirms but records a note', async () => {
  // DEMO-ONCE20 allows one use; two orders were placed before either was confirmed.
  const first = await createOrder(other.token, 'course_juniper_jncia', 'DEMO-ONCE20');
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const mineCsa = (await expectStatus('/api/student/orders', 200, { token: student.token })).orders.find(o => o.course_id === 'course_aws_csa' && o.status === 'pending');
  const a = await expectStatus(`/api/manage/orders/${mineCsa.id}/confirm`, 200, { method: 'POST', token: admin.token, body: { amount_received: mineCsa.amount } });
  assert.equal(a.voucher_note, null);
  const b = await expectStatus(`/api/manage/orders/${first.data.order.id}/confirm`, 200, { method: 'POST', token: admin.token, body: { amount_received: first.data.order.amount } });
  assert.equal(b.order.status, 'paid');
  assert.match(b.voucher_note, /DEMO-ONCE20/);
  // The voucher is now used up for new orders.
  assert.equal((await createOrder(other.token, 'course_juniper_jncip', 'DEMO-ONCE20')).status, 400);
});

test('reject requires a note and is shown to the learner', async () => {
  const { data } = await createOrder(other.token, 'course_aruba_acsa');
  const orderId = data.order.id;
  assert.equal((await request(`/api/manage/orders/${orderId}/reject`, { method: 'POST', token: coord.token, body: {} })).status, 400);
  const rejected = await expectStatus(`/api/manage/orders/${orderId}/reject`, 200, { method: 'POST', token: coord.token, body: { note: 'ยอดโอนไม่ตรง' } });
  assert.equal(rejected.order.status, 'rejected');
  const mine = await expectStatus(`/api/student/orders/${orderId}`, 200, { token: other.token });
  assert.equal(mine.order.staff_note, 'ยอดโอนไม่ตรง');
  assert.equal(await enrollmentOf(other.token, 'course_aruba_acsa'), null);
  assert.equal((await uploadSlip(other.token, orderId)).status, 400, 'no slip on a rejected order');
});

test('refund suspends the enrollment and blocks lessons', async () => {
  const { data } = await createOrder(other.token, 'course_huawei_hcia');
  const orderId = data.order.id;
  await expectStatus(`/api/manage/orders/${orderId}/confirm`, 200, { method: 'POST', token: coord.token, body: { amount_received: 3115 } });
  assert.equal((await enrollmentOf(other.token, 'course_huawei_hcia')).status, 'active');
  assert.equal((await request('/api/lessons/lesson_huawei_vrp/qa', { token: other.token })).status, 200);

  assert.equal((await request(`/api/manage/orders/${orderId}/refund`, { method: 'POST', token: coord.token, body: {} })).status, 400);
  const refunded = await expectStatus(`/api/manage/orders/${orderId}/refund`, 200, { method: 'POST', token: coord.token, body: { note: 'ลูกค้าขอยกเลิก' } });
  assert.equal(refunded.order.status, 'refunded');
  assert.ok(refunded.order.refunded_at);
  assert.equal((await enrollmentOf(other.token, 'course_huawei_hcia')).status, 'suspended');
  assert.equal((await request('/api/lessons/lesson_huawei_vrp/qa', { token: other.token })).status, 403);
  // A new order can reactivate access later.
  assert.equal((await createOrder(other.token, 'course_huawei_hcia')).status, 201);
});

test('a 100% voucher enrolls immediately with a zero-baht receipt', async () => {
  const free = await createOrder(student.token, 'course_nutanix_ncp', 'DEMO-FREE100');
  assert.equal(free.status, 201, JSON.stringify(free.data));
  assert.equal(free.data.enrolled, true);
  assert.equal(free.data.order.status, 'paid');
  assert.equal(free.data.order.amount, 0);
  assert.match(free.data.order.receipt_no, /^RC-/);
  assert.equal((await enrollmentOf(student.token, 'course_nutanix_ncp')).status, 'active');
});

async function freshLearner(tag) {
  const email = `${tag}-${Date.now()}@example.invalid`;
  const created = await request('/api/admin/accounts', { method: 'POST', token: admin.token,
    body: { email, name: `ผู้เรียน ${tag}`, role: 'student', password: 'payments-test-pass-1' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return login(email, 'payments-test-pass-1');
}

test('double confirmation issues one receipt and one enrollment', async () => {
  const learner = await freshLearner('double');
  const { data } = await createOrder(learner.token, 'course_aws_sec');
  const confirm = () => request(`/api/manage/orders/${data.order.id}/confirm`, { method: 'POST', token: coord.token, body: { amount_received: data.order.amount } });
  const results = await Promise.all([confirm(), confirm(), confirm()]);
  const ok = results.filter(r => r.status === 200);
  assert.equal(ok.length, 1, JSON.stringify(results.map(r => [r.status, r.data])));
  assert.ok(results.every(r => [200, 400, 409].includes(r.status)));
  assert.match(ok[0].data.order.receipt_no, /^RC-\d{4}-\d{6}$/);
  assert.ok(ok[0].data.enrollment.id);
  const mine = await expectStatus(`/api/student/orders/${data.order.id}`, 200, { token: learner.token });
  assert.equal(mine.order.receipt_no, ok[0].data.order.receipt_no);
  assert.equal(mine.order.enrollment_id, ok[0].data.enrollment.id);
  assert.equal((await enrollmentOf(learner.token, 'course_aws_sec')).status, 'active');
  // A completed order cannot be confirmed (or "repaired") again.
  assert.equal((await confirm()).status, 400);
});

test('concurrent free-voucher requests create one paid order and one enrollment', async () => {
  const learner = await freshLearner('freerace');
  const results = await Promise.all(Array.from({ length: 4 }, () => createOrder(learner.token, 'course_nutanix_ncm', 'DEMO-FREE100')));
  const created = results.filter(r => r.status === 201);
  assert.equal(created.length, 1, JSON.stringify(results.map(r => [r.status, r.data])));
  assert.ok(results.every(r => [201, 400, 409].includes(r.status)));
  const orders = (await expectStatus('/api/student/orders', 200, { token: learner.token })).orders.filter(o => o.course_id === 'course_nutanix_ncm');
  assert.equal(orders.filter(o => o.status === 'paid').length, 1);
  assert.equal(orders.filter(o => o.status === 'pending').length, 0);
  assert.ok(orders.find(o => o.status === 'paid').enrollment_id);
  assert.equal((await enrollmentOf(learner.token, 'course_nutanix_ncm')).status, 'active');
  assert.equal((await createOrder(learner.token, 'course_nutanix_ncm', 'DEMO-FREE100')).status, 400, 'already enrolled');
});

test('a single-use free voucher raced by two learners opens only one enrollment', async () => {
  const code = `RACE-${Date.now()}`;
  await expectStatus('/api/instructor/vouchers', 201, { method: 'POST', token: admin.token,
    body: { code, discount_type: 'percent', discount_value: 100, max_uses: 1 } });
  const [a, b] = [await freshLearner('race-a'), await freshLearner('race-b')];
  const results = await Promise.all([a, b].map(l => createOrder(l.token, 'course_arista_acep', code)));
  assert.equal(results.filter(r => r.status === 201).length, 1, JSON.stringify(results.map(r => [r.status, r.data])));
  const loser = results.findIndex(r => r.status !== 201);
  assert.equal(results[loser].status, 400);
  assert.equal(await enrollmentOf([a, b][loser].token, 'course_arista_acep'), null);
  const leftover = (await expectStatus('/api/student/orders', 200, { token: [a, b][loser].token })).orders;
  assert.ok(leftover.every(o => o.status !== 'pending' && o.status !== 'paid'), 'the losing order does not stay open');
});

test('payment instructions are editable only with payments.manage', async () => {
  assert.equal((await request('/api/manage/payment-settings', { method: 'PUT', token: student.token, body: { bank_name: 'X' } })).status, 403);
  const saved = await expectStatus('/api/manage/payment-settings', 200, { method: 'PUT', token: coord.token,
    body: { bank_name: 'ธนาคารทดสอบ', account_number: '123-4-56789-0' } });
  assert.equal(saved.instructions.bank_name, 'ธนาคารทดสอบ');
  assert.ok(saved.instructions.account_name, 'unspecified fields are kept');
  const learner = await expectStatus('/api/student/payment-instructions', 200, { token: student.token });
  assert.equal(learner.instructions.account_number, '123-4-56789-0');
  assert.equal((await request('/api/manage/payment-settings', { method: 'PUT', token: coord.token, body: { note: 7 } })).status, 400);
});

test('certificate revoke and reissue; public verification shows revoked', async () => {
  // Earn the Workers certificate: finish both lessons and answer each quiz correctly.
  for (const lesson of ['lesson_cf_workers_intro', 'lesson_cf_workers_hono']) {
    await expectStatus(`/api/student/lessons/${lesson}/progress`, 200, { method: 'POST', token: student.token, body: { resume_seconds: 10, completed: 1 } });
  }
  const quizzes = await expectStatus('/api/student/courses/course_cf_workers/quizzes', 200, { token: student.token });
  for (const quiz of quizzes) {
    for (let i = 0; i < quiz.options.length; i++) {
      const result = await expectStatus(`/api/student/quizzes/${quiz.id}/submit`, 200, { method: 'POST', token: student.token, body: { answer_index: i } });
      if (result.correct) break;
    }
  }
  const claim = await request('/api/student/courses/course_cf_workers/certificate', { method: 'POST', token: student.token });
  assert.ok([200, 201].includes(claim.status), JSON.stringify(claim.data));
  const cert = claim.data.certificate;
  assert.match(cert.certificate_code, /^NP-[A-Z0-9]+-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/, '64 random bits');
  assert.equal((await expectStatus(`/api/certificates/verify/${cert.certificate_code}`, 200)).verified, true);

  for (const token of [student.token, coord.token]) {
    assert.equal((await request(`/api/manage/certificates/${cert.id}/revoke`, { method: 'POST', token, body: { reason: 'x' } })).status, 403);
    assert.equal((await request('/api/manage/certificates', { token })).status, 403);
  }
  const listed = await expectStatus(`/api/manage/certificates?q=${cert.certificate_code}`, 200, { token: admin.token });
  assert.equal(listed.certificates.length, 1);
  assert.equal(listed.certificates[0].user_email, 'student3@netprime.com');

  assert.equal((await request(`/api/manage/certificates/${cert.id}/revoke`, { method: 'POST', token: admin.token, body: {} })).status, 400);
  await expectStatus(`/api/manage/certificates/${cert.id}/revoke`, 200, { method: 'POST', token: admin.token, body: { reason: 'ทุจริตการสอบ' } });
  const revoked = await expectStatus(`/api/certificates/verify/${cert.certificate_code}`, 200);
  assert.equal(revoked.verified, false);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.revoke_reason, undefined, 'internal reason is not public');
  const mine = await expectStatus('/api/student/courses/course_cf_workers/certificate', 200, { token: student.token });
  assert.ok(mine.revoked_at);
  assert.equal((await request('/api/student/courses/course_cf_workers/certificate', { method: 'POST', token: student.token })).status, 403,
    'learner cannot self-issue after revocation');

  const reissued = await expectStatus(`/api/manage/certificates/${cert.id}/reissue`, 201, { method: 'POST', token: admin.token, body: { reason: 'ตรวจสอบใหม่แล้ว' } });
  const fresh = reissued.certificate;
  assert.notEqual(fresh.certificate_code, cert.certificate_code);
  assert.equal(fresh.reissued_from, cert.id);
  assert.equal((await expectStatus(`/api/certificates/verify/${fresh.certificate_code}`, 200)).verified, true);
  assert.equal((await expectStatus(`/api/certificates/verify/${cert.certificate_code}`, 200)).revoked, true);
  assert.equal((await request(`/api/manage/certificates/${fresh.id}/reissue`, { method: 'POST', token: admin.token, body: {} })).status, 201,
    'reissuing the active certificate revokes it and issues another');
  assert.equal((await expectStatus(`/api/certificates/verify/${fresh.certificate_code}`, 200)).revoked, true);
});

test('public certificate verification is rate-limited per IP', async () => {
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) {
    const res = await request(`/api/certificates/verify/NP-GUESS-${String(i).padStart(4, '0')}-0000`);
    if (res.status === 429) limited = res;
    else assert.equal(res.status, 404);
  }
  assert.ok(limited, 'guessing codes is eventually refused');
  assert.ok(limited.headers.get('retry-after'));
});
