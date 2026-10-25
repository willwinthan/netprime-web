// Commerce: tax invoices + VAT + credit notes, products (bundle / learning path / membership), installments,
// organization quotes, abandoned-order reminders and sales reports. All payments are bank transfers confirmed by staff.
import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let admin, coord, student;
let baseline;
let receivedTotal = 0;
let refundedTotal = 0;
const VALID_SCHOOL_TAX_ID = '0105556000009';
const VALID_BUYER_TAX_ID = '0105560123454';
const BUYER = { buyer_name: 'บริษัท ผู้ซื้อ จำกัด', buyer_tax_id: VALID_BUYER_TAX_ID, buyer_branch: 'สำนักงานใหญ่', buyer_address: '99 ถนนสาทร กรุงเทพฯ 10120' };

before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  coord = await login('coord@netprime.com', 'coord123');
  student = await login('student3@netprime.com', 'stud123');
  baseline = (await expectStatus('/api/manage/commerce/report', 200, { token: coord.token })).totals;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
async function uploadSlip(token, path) {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'slip.png');
  const response = await fetch(`${process.env.NETPRIME_TEST_BASE}/api${path}`, {
    method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

let learnerCount = 0;
async function freshLearner(tag, name = `ผู้เรียน ${tag}`) {
  const email = `commerce-${tag}-${Date.now()}-${learnerCount++}@example.invalid`;
  const created = await request('/api/admin/accounts', { method: 'POST', token: admin.token,
    body: { email, name, role: 'student', password: 'commerce-test-pass-1' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return login(email, 'commerce-test-pass-1');
}

const order = (token, body) => request('/api/student/orders', { method: 'POST', token, body });
const confirm = async (orderId, amount) => {
  const data = await expectStatus(`/api/manage/orders/${orderId}/confirm`, 200, { method: 'POST', token: coord.token, body: { amount_received: amount } });
  receivedTotal += amount;
  return data;
};
const confirmInstallment = async (orderId, seq, amount, status = 200) => {
  const res = await request(`/api/manage/orders/${orderId}/installments/${seq}/confirm`, { method: 'POST', token: coord.token, body: { amount_received: amount } });
  assert.equal(res.status, status, JSON.stringify(res.data));
  if (status === 200) receivedTotal += amount;
  return res.data;
};
const enrollmentOf = async (token, courseId) => (await expectStatus(`/api/courses/${courseId}`, 200, { token })).enrollment;
const runJobs = asOf => expectStatus('/api/manage/commerce/jobs/run', 200, { method: 'POST', token: admin.token, body: asOf ? { as_of: asOf } : {} });
const createProduct = body => expectStatus('/api/manage/products', 201, { method: 'POST', token: admin.token, body: { status: 'published', ...body } });

test('school tax profile: payments.manage only, 13-digit tax ID checksum enforced', async () => {
  assert.equal((await request('/api/manage/tax-profile', { method: 'PUT', token: student.token, body: { vat_registered: true } })).status, 403);
  const badId = await request('/api/manage/tax-profile', { method: 'PUT', token: coord.token,
    body: { company_name: 'บริษัท เน็ตไพรม์ จำกัด', tax_id: '0105556000001', address: '1 ถนนสีลม กรุงเทพฯ', vat_registered: true } });
  assert.equal(badId.status, 400);
  assert.match(badId.data.error, /เลขประจำตัวผู้เสียภาษี/);
  const incomplete = await request('/api/manage/tax-profile', { method: 'PUT', token: coord.token, body: { tax_id: VALID_SCHOOL_TAX_ID, vat_registered: true } });
  assert.equal(incomplete.status, 400, 'VAT registration needs name and address');
  const saved = await expectStatus('/api/manage/tax-profile', 200, { method: 'PUT', token: coord.token,
    body: { company_name: 'บริษัท เน็ตไพรม์ จำกัด', tax_id: '0-1055-56000-00-9', branch: '00000', address: '1 ถนนสีลม กรุงเทพฯ 10500', vat_registered: true } });
  assert.equal(saved.profile.tax_id, VALID_SCHOOL_TAX_ID);
  assert.equal(saved.profile.branch, 'สำนักงานใหญ่');
  assert.equal(saved.profile.vat_registered, true);
  const seller = (await expectStatus('/api/student/payment-instructions', 200, { token: student.token })).seller;
  assert.equal(seller.tax_id, VALID_SCHOOL_TAX_ID);
});

test('buyer tax invoice request is validated (13 digits + check digit, address, branch)', async () => {
  const learner = await freshLearner('taxbad');
  for (const [buyer, pattern] of [
    [{ ...BUYER, buyer_tax_id: '010556012345' }, /13 หลัก/],
    [{ ...BUYER, buyer_tax_id: '0105560123455' }, /ไม่ถูกต้อง/],
    [{ ...BUYER, buyer_address: '' }, /ที่อยู่/],
    [{ ...BUYER, buyer_branch: 'สาขา 12' }, /สาขา/]
  ]) {
    const res = await order(learner.token, { course_id: 'course_aws_csa', tax_invoice: buyer });
    assert.equal(res.status, 400, JSON.stringify(res.data));
    assert.match(res.data.error, pattern);
  }
});

let taxedOrder, taxedLearner;
test('confirmation issues sequential tax invoice numbers with a VAT 7% inclusive breakdown', async () => {
  taxedLearner = await freshLearner('taxok');
  const created = await order(taxedLearner.token, { course_id: 'course_aws_csa', tax_invoice: { ...BUYER, buyer_branch: '00012' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.order.tax_invoice_requested, 1);
  assert.equal(created.data.order.buyer_branch, '00012');
  const first = (await confirm(created.data.order.id, 5215)).order;
  assert.match(first.receipt_no, /^RC-\d{4}-\d{6}$/);
  assert.match(first.tax_invoice_no, /^TI-\d{4}-\d{6}$/);
  assert.equal(first.vat_rate, 7);
  // 5,215.00 incl. VAT → VAT = round(521500 × 7 / 107) satang = 341.17, base 4,873.83
  assert.deepEqual(first.vat, { total: 5215, base: 4873.83, vat: 341.17, rate: 7 });
  taxedOrder = first;

  const second = await freshLearner('taxok2');
  const o2 = await order(second.token, { course_id: 'course_aws_csa', voucher_code: 'DEMO-ONCE20', tax_invoice: BUYER });
  assert.equal(o2.status, 201, JSON.stringify(o2.data));
  assert.equal(o2.data.order.amount, Math.round(5215 * 0.8));
  const paid2 = (await confirm(o2.data.order.id, o2.data.order.amount)).order;
  const n = no => Number(no.split('-')[2]);
  assert.equal(n(paid2.tax_invoice_no), n(first.tax_invoice_no) + 1, 'tax invoices use their own sequence');
  assert.equal(Math.round((paid2.vat.base + paid2.vat.vat) * 100), paid2.vat.total * 100, 'base + VAT = paid amount');

  // No request: a receipt with the VAT breakdown but no full tax invoice; a late request issues the next number.
  const third = await freshLearner('taxlate');
  const o3 = await order(third.token, { course_id: 'course_aws_devops' });
  const paid3 = (await confirm(o3.data.order.id, 5565)).order;
  assert.equal(paid3.tax_invoice_no, null);
  assert.equal(paid3.vat.rate, 7);
  const late = await expectStatus(`/api/student/orders/${paid3.id}/tax-invoice`, 200, { method: 'PUT', token: third.token, body: BUYER });
  assert.equal(n(late.order.tax_invoice_no), n(paid2.tax_invoice_no) + 1);
  const again = await request(`/api/student/orders/${paid3.id}/tax-invoice`, { method: 'PUT', token: third.token, body: BUYER });
  assert.equal(again.status, 409, 'an issued tax invoice cannot be edited');
  assert.equal((await request(`/api/student/orders/${paid3.id}/tax-invoice`, { method: 'PUT', token: student.token, body: BUYER })).status, 404);
});

test('refund of a tax-invoiced order issues a credit note and suspends access', async () => {
  const refunded = await expectStatus(`/api/manage/orders/${taxedOrder.id}/refund`, 200, { method: 'POST', token: coord.token, body: { note: 'ลูกค้าขอยกเลิก' } });
  refundedTotal += 5215;
  assert.equal(refunded.order.status, 'refunded');
  assert.match(refunded.order.credit_note_no, /^CN-\d{4}-\d{6}$/);
  assert.equal(refunded.order.credit_note_amount, 5215);
  assert.equal((await enrollmentOf(taxedLearner.token, 'course_aws_csa')).status, 'suspended');
  const twice = await request(`/api/manage/orders/${taxedOrder.id}/refund`, { method: 'POST', token: coord.token, body: { note: 'ซ้ำ' } });
  assert.equal(twice.status, 400);
});

let bundle;
test('bundle: commerce.manage only, savings shown, purchase enrolls every course exactly once', async () => {
  assert.equal((await request('/api/manage/products', { method: 'POST', token: coord.token, body: { kind: 'bundle', title: 'x', price: 1 } })).status, 403);
  const invalid = await request('/api/manage/products', { method: 'POST', token: admin.token,
    body: { kind: 'bundle', title: 'ชุดเดียว', price: 100, course_ids: ['course_juniper_jncia'] } });
  assert.equal(invalid.status, 400, 'a bundle needs at least two courses');
  bundle = (await createProduct({ kind: 'bundle', title: 'เส้นทาง Juniper', price: 8000, is_path: true, path_certificate: true,
    course_ids: ['course_juniper_jncia', 'course_juniper_jncip'] })).product;
  assert.equal(bundle.separate_price, 3465 + 6615);
  assert.equal(bundle.savings, 3465 + 6615 - 8000);
  assert.deepEqual(bundle.courses.map(c => c.course_id), ['course_juniper_jncia', 'course_juniper_jncip']);
  const catalog = await expectStatus('/api/commerce/products', 200);
  assert.ok(catalog.products.some(p => p.id === bundle.id && p.savings === 2080));

  const learner = await freshLearner('bundle');
  const created = await order(learner.token, { product_id: bundle.id });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.order.kind, 'bundle');
  assert.equal(created.data.order.course_title, 'เส้นทาง Juniper');
  assert.equal((await order(learner.token, { product_id: bundle.id })).status, 409);

  const path = `/api/manage/orders/${created.data.order.id}/confirm`;
  const results = await Promise.all([1, 2, 3].map(() => request(path, { method: 'POST', token: coord.token, body: { amount_received: 8000 } })));
  assert.equal(results.filter(r => r.status === 200).length, 1, JSON.stringify(results.map(r => [r.status, r.data])));
  receivedTotal += 8000;
  for (const courseId of ['course_juniper_jncia', 'course_juniper_jncip']) {
    const e = await enrollmentOf(learner.token, courseId);
    assert.equal(e.status, 'active');
    assert.equal(e.expires_at, null, 'bundle without access_days is lifetime');
  }
  // Confirming again changes nothing; buying again is refused.
  assert.equal((await request(path, { method: 'POST', token: coord.token, body: { amount_received: 8000 } })).status, 400);
  assert.equal((await order(learner.token, { product_id: bundle.id })).status, 400);
  const mine = (await expectStatus('/api/student/orders', 200, { token: learner.token })).orders;
  assert.equal(mine.filter(o => o.status === 'paid').length, 1);

  // Learning path page: ordered steps with progress; the certificate waits for completion.
  const progress = await expectStatus(`/api/student/paths/${bundle.id}`, 200, { token: learner.token });
  assert.equal(progress.steps.length, 2);
  assert.ok(progress.steps.every(s => s.has_access));
  assert.equal(progress.steps[0].recommended_next, true);
  assert.equal(progress.completed, false);
  assert.equal((await request(`/api/student/paths/${bundle.id}/certificate`, { method: 'POST', token: learner.token })).status, 400);
  const paths = await expectStatus('/api/student/paths', 200, { token: learner.token });
  assert.ok(paths.paths.some(p => p.id === bundle.id && p.started));

  // Products with orders cannot be deleted (archive instead).
  assert.equal((await request(`/api/manage/products/${bundle.id}`, { method: 'DELETE', token: admin.token })).status, 409);
});

test('quote → organization order → seats added and courses sponsored on payment', async () => {
  const validUntil = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  assert.equal((await request('/api/manage/quotes', { token: coord.token })).status, 403);
  const before = (await expectStatus('/api/admin/organizations', 200, { token: admin.token })).organizations.find(o => o.id === 'partner_acme');
  const created = await expectStatus('/api/manage/quotes', 201, { method: 'POST', token: admin.token, body: {
    partner_id: 'partner_acme', title: 'อบรม Aruba สำหรับทีมเครือข่าย', seats: 5, course_ids: ['course_aruba_acsp'], price: 50000,
    valid_until: validUntil, contact_name: 'Sarah', contact_email: 'hr@netprime.com', buyer_address: '1 ถนนพระราม 9 กรุงเทพฯ' } });
  const quote = created.quote;
  assert.match(quote.quote_no, /^QT-\d{4}-\d{4}$/);
  assert.equal(quote.status, 'draft');
  assert.equal(quote.courses.length, 1);
  assert.equal((await expectStatus(`/api/manage/quotes/${quote.id}/send`, 200, { method: 'POST', token: admin.token })).quote.status, 'sent');

  const accepted = await expectStatus(`/api/manage/quotes/${quote.id}/accept`, 201, { method: 'POST', token: admin.token });
  assert.equal(accepted.quote.status, 'accepted');
  assert.equal(accepted.order.kind, 'organization');
  assert.equal(accepted.order.seats, 5);
  assert.equal(accepted.order.amount, 50000);
  assert.equal((await request(`/api/manage/quotes/${quote.id}/accept`, { method: 'POST', token: admin.token })).status, 400);
  // Not sponsored and no new seats until the transfer is confirmed.
  let sponsored = await expectStatus('/api/business/courses?partner_id=partner_acme', 200, { token: admin.token });
  assert.equal(sponsored.find(c => c.id === 'course_aruba_acsp').is_sponsored, 0);

  const paid = (await confirm(accepted.order.id, 50000)).order;
  assert.equal(paid.status, 'paid');
  assert.match(paid.receipt_no, /^RC-/);
  const after = (await expectStatus('/api/admin/organizations', 200, { token: admin.token })).organizations.find(o => o.id === 'partner_acme');
  assert.equal(after.total_seats, before.total_seats + 5);
  sponsored = await expectStatus('/api/business/courses?partner_id=partner_acme', 200, { token: admin.token });
  assert.equal(sponsored.find(c => c.id === 'course_aruba_acsp').is_sponsored, 1);
  // A second confirmation does not add the seats again.
  assert.equal((await request(`/api/manage/orders/${paid.id}/confirm`, { method: 'POST', token: coord.token, body: { amount_received: 50000 } })).status, 400);
  assert.equal((await expectStatus('/api/admin/organizations', 200, { token: admin.token })).organizations.find(o => o.id === 'partner_acme').total_seats, after.total_seats);

  // The organization's tax ID on file is not a valid 13-digit ID, so staff enter the buyer details afterwards.
  assert.equal(paid.tax_invoice_no, null);
  const invoiced = await expectStatus(`/api/manage/orders/${paid.id}/tax-invoice`, 200, { method: 'PUT', token: coord.token,
    body: { ...BUYER, buyer_name: 'Acme Corporation Ltd.' } });
  assert.match(invoiced.order.tax_invoice_no, /^TI-/);
});

let membership, member;
test('membership: grants access for N days, renewal extends from the current expiry, reminder once, then expires', async () => {
  membership = (await createProduct({ kind: 'membership', title: 'สมาชิก Huawei 30 วัน', price: 990, access_days: 30,
    course_ids: ['course_huawei_hcip'] })).product;
  assert.equal((await request('/api/manage/products', { method: 'POST', token: admin.token,
    body: { kind: 'membership', title: 'ไม่มีวัน', price: 10, course_ids: ['course_huawei_hcip'] } })).status, 400);
  member = await freshLearner('member');
  const first = await order(member.token, { product_id: membership.id });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const confirmed = await confirm(first.data.order.id, 990);
  let mine = (await expectStatus('/api/student/memberships', 200, { token: member.token })).memberships;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'active');
  const expiry1 = new Date(mine[0].expires_at).getTime();
  assert.ok(Math.abs(expiry1 - (Date.now() + 30 * 86400000)) < 120000);
  assert.equal(confirmed.enrollment.expires_at, mine[0].expires_at);
  let e = await enrollmentOf(member.token, 'course_huawei_hcip');
  assert.equal(e.status, 'active');
  assert.equal(e.expires_at, mine[0].expires_at, 'the enrollment ends with the membership');

  // Renewal is a new manual order; the new period starts at the current expiry.
  const renewal = await order(member.token, { product_id: membership.id });
  assert.equal(renewal.status, 201, JSON.stringify(renewal.data));
  await confirm(renewal.data.order.id, 990);
  mine = (await expectStatus('/api/student/memberships', 200, { token: member.token })).memberships;
  const expiry2 = new Date(mine[0].expires_at).getTime();
  assert.ok(Math.abs(expiry2 - expiry1 - 30 * 86400000) < 5000, 'extended by exactly 30 days');
  e = await enrollmentOf(member.token, 'course_huawei_hcip');
  assert.equal(e.expires_at, mine[0].expires_at);

  // 7-day reminder: sent once per expiry date.
  const nearEnd = new Date(expiry2 - 3 * 86400000).toISOString();
  const run1 = await runJobs(nearEnd);
  assert.ok(run1.membership_reminders >= 1, JSON.stringify(run1));
  const run2 = await runJobs(nearEnd);
  assert.equal(run2.membership_reminders, 0, 'no second reminder for the same expiry');

  // After the end date the membership is marked expired (enrollment.expires_at already closes the lessons).
  const run3 = await runJobs(new Date(expiry2 + 86400000).toISOString());
  assert.ok(run3.memberships_expired >= 1);
  mine = (await expectStatus('/api/student/memberships', 200, { token: member.token })).memberships;
  assert.equal(mine[0].status, 'expired');
});

test('installments: plan and due dates, first payment opens access, overdue suspends, paying resumes, one receipt per installment', async () => {
  const product = (await createProduct({ kind: 'course', title: 'AWS Networking ผ่อน 3 งวด', price: 6000, course_id: 'course_aws_net',
    max_installments: 3, installment_interval_days: 30, installment_access: 'first', overdue_grace_days: 5 })).product;
  const learner = await freshLearner('install');
  assert.equal((await order(learner.token, { product_id: product.id, installments: 4 })).status, 400);
  assert.equal((await order(learner.token, { course_id: 'course_aws_net', installments: 2 })).status, 400, 'plain course orders are paid in full');
  const created = await order(learner.token, { product_id: product.id, installments: 3 });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const o = created.data.order;
  assert.equal(o.installment_count, 3);
  assert.deepEqual(o.installments.map(i => i.amount), [2000, 2000, 2000]);
  const due2 = new Date(o.installments[1].due_at).getTime();
  assert.ok(Math.abs(due2 - (Date.now() + 30 * 86400000)) < 120000);
  assert.equal((await uploadSlip(learner.token, `/student/orders/${o.id}/slip`)).status, 400, 'slips go to an installment');
  const slip = await uploadSlip(learner.token, `/student/orders/${o.id}/installments/1/slip`);
  assert.equal(slip.status, 200, JSON.stringify(slip.data));
  assert.equal(slip.data.order.installments[0].has_slip, true);
  assert.equal((await request(`/api/orders/${o.id}/installments/1/slip`, { token: coord.token })).status, 200);
  assert.equal((await request(`/api/manage/orders/${o.id}/confirm`, { method: 'POST', token: coord.token, body: { amount_received: 6000 } })).status, 400);
  await confirmInstallment(o.id, 2, 2000, 400);
  assert.equal(await enrollmentOf(learner.token, 'course_aws_net'), null);

  const firstPaid = await confirmInstallment(o.id, 1, 2000);
  assert.equal(firstPaid.order.status, 'partial');
  assert.equal(firstPaid.access_open, true);
  assert.match(firstPaid.installment.receipt_no, /^RC-/);
  assert.equal((await enrollmentOf(learner.token, 'course_aws_net')).status, 'active');
  await confirmInstallment(o.id, 1, 2000, 409);

  // Installment 2 is overdue beyond the 5 grace days → access suspended by the daily job.
  const run = await runJobs(new Date(due2 + 6 * 86400000).toISOString());
  assert.ok(run.installments_suspended >= 1, JSON.stringify(run));
  assert.equal((await enrollmentOf(learner.token, 'course_aws_net')).status, 'suspended');
  const suspended = (await expectStatus(`/api/student/orders/${o.id}`, 200, { token: learner.token })).order;
  assert.ok(suspended.suspended_at);

  const second = await confirmInstallment(o.id, 2, 2000);
  assert.equal(second.order.suspended_at, null);
  assert.equal((await enrollmentOf(learner.token, 'course_aws_net')).status, 'active');
  const third = await confirmInstallment(o.id, 3, 2000);
  assert.equal(third.order.status, 'paid');
  assert.equal(third.order.total_received, 6000);
  const receipts = third.order.installments.map(i => i.receipt_no);
  assert.equal(new Set(receipts).size, 3);
  assert.ok(receipts.every(r => /^RC-/.test(r)));
});

test('installments with access after full payment keep the course closed until the last installment', async () => {
  const product = (await createProduct({ kind: 'bundle', title: 'Arista ผ่อนครบก่อนเรียน', price: 9000,
    course_ids: ['course_arista_acea', 'course_arista_acep'], max_installments: 2, installment_access: 'full' })).product;
  const learner = await freshLearner('installfull');
  const created = await order(learner.token, { product_id: product.id, installments: 2 });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const first = await confirmInstallment(created.data.order.id, 1, 4500);
  assert.equal(first.access_open, false);
  assert.equal(await enrollmentOf(learner.token, 'course_arista_acea'), null);
  const last = await confirmInstallment(created.data.order.id, 2, 4500);
  assert.equal(last.access_open, true);
  assert.equal((await enrollmentOf(learner.token, 'course_arista_acea')).status, 'active');
  assert.equal((await enrollmentOf(learner.token, 'course_arista_acep')).status, 'active');
});

test('abandoned orders without a slip get exactly one reminder after 24 hours', async () => {
  const learner = await freshLearner('abandon');
  const quiet = await order(learner.token, { course_id: 'course_cisco_sdwan' });
  assert.equal(quiet.status, 201);
  const withSlip = await order(learner.token, { course_id: 'course_cisco_ccnp' });
  assert.equal((await uploadSlip(learner.token, `/student/orders/${withSlip.data.order.id}/slip`)).status, 200);

  const now = await runJobs();
  const fresh = (await expectStatus(`/api/student/orders/${quiet.data.order.id}`, 200, { token: learner.token })).order;
  assert.equal(fresh.reminder_sent_at, null, 'not before 24 hours');
  void now;

  const later = new Date(Date.now() + 25 * 3600000).toISOString();
  const run1 = await runJobs(later);
  assert.ok(run1.abandoned_reminders >= 1, JSON.stringify(run1));
  const reminded = (await expectStatus(`/api/student/orders/${quiet.data.order.id}`, 200, { token: learner.token })).order;
  assert.ok(reminded.reminder_sent_at);
  const run2 = await runJobs(later);
  assert.equal(run2.abandoned_reminders, 0, 'only one reminder');
  const slipOrder = (await expectStatus(`/api/student/orders/${withSlip.data.order.id}`, 200, { token: learner.token })).order;
  assert.equal(slipOrder.reminder_sent_at, null, 'orders with a slip are waiting for staff, not the learner');
  // as_of is a test-only switch and admins only.
  assert.equal((await request('/api/manage/commerce/jobs/run', { method: 'POST', token: coord.token, body: {} })).status, 403);
});

test('sales report totals, voucher and product breakdowns, outstanding installments and CSV export', async () => {
  // A learner whose name looks like a spreadsheet formula.
  const tricky = await freshLearner('csv', '=HYPERLINK("http://x")');
  const created = await order(tricky.token, { course_id: 'course_nutanix_ncp' });
  await confirm(created.data.order.id, 4865);
  const outstandingOrder = await order(tricky.token, { product_id: (await createProduct({ kind: 'course', title: 'Nutanix NCM ผ่อน', price: 3000,
    course_id: 'course_nutanix_ncm', max_installments: 2 })).product.id, installments: 2 });
  assert.equal(outstandingOrder.status, 201, JSON.stringify(outstandingOrder.data));

  assert.equal((await request('/api/manage/commerce/report', { token: student.token })).status, 403);
  const report = await expectStatus('/api/manage/commerce/report', 200, { token: coord.token });
  const t = report.totals;
  assert.equal(Math.round((t.revenue - baseline.revenue) * 100), Math.round(receivedTotal * 100), JSON.stringify({ t, baseline, receivedTotal }));
  assert.equal(Math.round((t.refunded_amount - baseline.refunded_amount) * 100), Math.round(refundedTotal * 100));
  assert.equal(Math.round(t.net_revenue * 100), Math.round((t.revenue - t.refunded_amount) * 100));
  assert.ok(Math.abs(t.vat - t.revenue * 7 / 107) < 1, 'every receipt in this suite carries 7% VAT');
  assert.ok(report.by_product.some(p => p.title === 'เส้นทาง Juniper' && p.revenue === 8000 && p.orders === 1));
  assert.ok(report.by_voucher.some(v => v.code === 'DEMO-ONCE20' && v.orders === 1 && v.discount === 5215 - Math.round(5215 * 0.8)));
  assert.ok(report.by_day.length >= 1);
  assert.equal(Math.round(report.by_month.reduce((s, m) => s + m.revenue, 0) * 100), Math.round(t.revenue * 100));
  const pending = report.outstanding.filter(r => r.order_id === outstandingOrder.data.order.id);
  assert.equal(pending.length, 2);
  assert.equal(pending.reduce((s, r) => s + r.amount, 0), 3000);

  const csv = await fetch(`${process.env.NETPRIME_TEST_BASE}/api/manage/commerce/report.csv`, { headers: { Authorization: `Bearer ${coord.token}` } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const bytes = new Uint8Array(await csv.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /เลขที่ใบกำกับภาษี/);
  assert.ok(text.includes(`"'=HYPERLINK(""http://x"")"`), 'formulas are neutralised');
  assert.ok(!/(^|,)=HYPERLINK/m.test(text));
  assert.equal((await request('/api/manage/commerce/report?from=2026-13-01', { token: coord.token })).status, 400);
});

test('course prerequisites block orders; a bundle that contains the prerequisite is allowed', async () => {
  const instructor = await login('instructor@netprime.com', 'inst123');
  await expectStatus('/api/instructor/courses/course_cisco_ccie_sec/details', 200, { method: 'PUT', token: instructor.token,
    body: { prerequisite_ids: ['course_cisco_ccnp'] } });
  const learner = await freshLearner('prereq');
  const blocked = await order(learner.token, { course_id: 'course_cisco_ccie_sec' });
  assert.equal(blocked.status, 400, JSON.stringify(blocked.data));
  assert.match(blocked.data.error, /ต้องเรียนคอร์ส/);
  const pack = (await createProduct({ kind: 'bundle', title: 'Cisco CCNP + CCIE', price: 15000,
    course_ids: ['course_cisco_ccnp', 'course_cisco_ccie_sec'] })).product;
  assert.equal((await order(learner.token, { product_id: pack.id })).status, 201);
});

test('orders keep the product terms from when they were placed; refunds take back the days actually added', async () => {
  const stamp = Date.now();
  const product = (await createProduct({ kind: 'bundle', title: `ชุดสแนปช็อต ${stamp}`, price: 1200, access_days: 30,
    course_ids: ['course_juniper_jncia', 'course_juniper_jncip'] })).product;
  const learner = await freshLearner('snapshot');
  const created = await order(learner.token, { product_id: product.id });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  // Staff edit the product before the transfer is confirmed: the order still opens what was sold.
  await expectStatus(`/api/manage/products/${product.id}`, 200, { method: 'PUT', token: admin.token,
    body: { access_days: 365, course_ids: ['course_juniper_jncia', 'course_huawei_hcip'] } });
  await confirm(created.data.order.id, 1200);
  const jncip = await enrollmentOf(learner.token, 'course_juniper_jncip');
  assert.equal(jncip?.status, 'active');
  assert.ok(Math.abs(Date.parse(jncip.expires_at) - (Date.now() + 30 * 86400000)) < 120000, 'access days from the order, not the edited product');
  assert.equal(await enrollmentOf(learner.token, 'course_huawei_hcip'), null, 'a course added later is not part of this order');

  const plan = (await createProduct({ kind: 'membership', title: `สมาชิกสแนปช็อต ${stamp}`, price: 300, access_days: 10,
    course_ids: ['course_huawei_hcip'] })).product;
  const member = await freshLearner('snapshot-member');
  const placed = await order(member.token, { product_id: plan.id });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  await expectStatus(`/api/manage/products/${plan.id}`, 200, { method: 'PUT', token: admin.token, body: { access_days: 100 } });
  await confirm(placed.data.order.id, 300);
  let mine = (await expectStatus('/api/student/memberships', 200, { token: member.token })).memberships.find(m => m.product_id === plan.id);
  assert.ok(Math.abs(Date.parse(mine.expires_at) - (Date.now() + 10 * 86400000)) < 120000, 'membership days frozen at order time');
  // A later edit does not change what the refund takes back: all 10 days, so the membership ends.
  await expectStatus(`/api/manage/products/${plan.id}`, 200, { method: 'PUT', token: admin.token, body: { access_days: 1 } });
  await expectStatus(`/api/manage/orders/${placed.data.order.id}/refund`, 200, { method: 'POST', token: coord.token, body: { note: 'ทดสอบคืนเงิน' } });
  refundedTotal += 300;
  mine = (await expectStatus('/api/student/memberships', 200, { token: member.token })).memberships.find(m => m.product_id === plan.id);
  assert.equal(mine.status, 'cancelled');
});

test('path certificates need a purchased, non-draft path; the public catalog has no staff fields', async () => {
  const outsider = await freshLearner('path-outsider');
  const claim = await request(`/api/student/paths/${bundle.id}/certificate`, { method: 'POST', token: outsider.token });
  assert.equal(claim.status, 403, JSON.stringify(claim.data));
  const draft = (await createProduct({ kind: 'bundle', title: `เส้นทางร่าง ${Date.now()}`, price: 100, is_path: true, path_certificate: true,
    status: 'draft', course_ids: ['course_juniper_jncia', 'course_juniper_jncip'] })).product;
  assert.equal((await request(`/api/student/paths/${draft.id}/certificate`, { method: 'POST', token: outsider.token })).status, 404);

  const catalog = await expectStatus('/api/commerce/products', 200);
  assert.ok(catalog.products.length > 0);
  assert.ok(catalog.products.every(p => !('created_by' in p)), 'created_by is not public');
  const one = await expectStatus(`/api/commerce/products/${bundle.id}`, 200);
  assert.equal('created_by' in one.product, false);
});
