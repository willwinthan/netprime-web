import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';
import { coursePageMeta, headTags, missingCourseMeta, sitemapEntries } from '../frontend-admin/worker/meta.ts';

let admin, coord, student, instructor;
const stamp = Date.now().toString(36);

before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  coord = await login('coord@netprime.com', 'coord123');
  student = await login('student3@netprime.com', 'stud123');
  instructor = await login('instructor@netprime.com', 'inst123');
});

async function register(tag) {
  const res = await request('/api/auth/register', { method: 'POST', body: {
    email: `mkt-${tag}-${stamp}@example.invalid`, password: 'Marketing-Pass-123', name: `Marketing ${tag} Tester`
  } });
  assert.ok([200, 201].includes(res.status), JSON.stringify(res.data));
  return res.data;
}

// ---------- 1. Sales pages ----------

test('sales page data is public for published courses only; drafts look missing', async () => {
  const data = await expectStatus('/api/public/marketing/courses/course_cisco_ccna', 200);
  assert.equal(data.course.id, 'course_cisco_ccna');
  assert.equal(typeof data.course.price, 'number');
  assert.ok(data.course.instructor.name);
  assert.ok(data.outline.length >= 1 && data.outline[0].lessons.length >= 1);
  const lesson = data.outline[0].lessons[0];
  assert.deepEqual(Object.keys(lesson), ['title'], 'curriculum exposes titles only');
  assert.ok(Array.isArray(data.course.learning_outcomes) && Array.isArray(data.course.faq));
  assert.equal(JSON.stringify(data).includes('video_stream_uid'), false);
  assert.equal(JSON.stringify(data).includes('handout'), false);

  const draft = await expectStatus('/api/instructor/courses', 201, { method: 'POST', token: instructor.token,
    body: { title: `Draft sales ${stamp}`, description: 'ยังไม่เผยแพร่', price: 990 } });
  assert.equal(draft.course.status, 'draft');
  await expectStatus(`/api/public/marketing/courses/${draft.course.id}`, 404);
  await expectStatus(`/api/public/marketing/courses/${draft.course.id}/reviews`, 404);
  await expectStatus('/api/public/marketing/courses/course_missing', 404);
});

test('course sales pages get escaped share tags and sitemap entries (frontend Worker)', () => {
  const origin = 'https://www.netprime.example';
  const meta = coursePageMeta({ id: 'course_x', title: 'CCNA "Pro" <Lab>', subtitle: null, description: 'เรียน **CCNA** ครบ', cover_image_url: '/img/a.png' }, origin);
  assert.equal(meta.url, `${origin}/courses/course_x`);
  assert.equal(meta.image, `${origin}/img/a.png`);
  assert.equal(meta.description, 'เรียน CCNA ครบ');
  const html = headTags(meta);
  assert.ok(html.includes('CCNA &quot;Pro&quot; &lt;Lab&gt; | NetPrime'));
  assert.ok(!html.includes('<Lab>'));
  assert.match(headTags(missingCourseMeta('/courses/nope', origin)), /noindex/);
  const entries = sitemapEntries(origin, [], [{ id: 'course_x' }, { id: 'course_y', slug: 'ccna' }]);
  assert.ok(entries.some(e => e.loc === `${origin}/courses/course_x`));
  assert.ok(entries.some(e => e.loc === `${origin}/courses/ccna`));
});

// ---------- 4. Tracking settings ----------

test('tracking ids are validated, staff-only, and only ids are exposed publicly', async () => {
  await expectStatus('/api/marketing/admin/tracking', 401);
  await expectStatus('/api/marketing/admin/tracking', 403, { token: student.token });
  for (const bad of [{ ga4_id: 'UA-1234-1' }, { gtm_id: 'GTM-<script>' }, { meta_pixel_id: '12ab' }, { tiktok_pixel_id: 'x' }, { ga4_id: 42 }]) {
    await expectStatus('/api/marketing/admin/tracking', 400, { method: 'PUT', token: coord.token, body: bad });
  }
  // GTM runs arbitrary JavaScript: only admins may set or change the container; marketing.manage keeps the pixel ids.
  await expectStatus('/api/marketing/admin/tracking', 403, { method: 'PUT', token: coord.token,
    body: { ga4_id: 'g-test12345', gtm_id: 'GTM-AB12CD', meta_pixel_id: '123456789012345', tiktok_pixel_id: '' } });
  const withGtm = await expectStatus('/api/marketing/admin/tracking', 200, { method: 'PUT', token: admin.token, body: { gtm_id: 'GTM-AB12CD' } });
  assert.equal(withGtm.tracking.gtm_id, 'GTM-AB12CD');
  await expectStatus('/api/marketing/admin/tracking', 403, { method: 'PUT', token: coord.token, body: { gtm_id: '' } });
  const saved = await expectStatus('/api/marketing/admin/tracking', 200, { method: 'PUT', token: coord.token,
    body: { ga4_id: 'g-test12345', gtm_id: 'GTM-AB12CD', meta_pixel_id: '123456789012345', tiktok_pixel_id: '' } });
  assert.equal(saved.tracking.ga4_id, 'G-TEST12345');
  assert.equal(saved.tracking.tiktok_pixel_id, null);
  assert.equal(saved.tracking.gtm_id, 'GTM-AB12CD', 'unchanged container is accepted from marketing staff');
  const omitted = await expectStatus('/api/marketing/admin/tracking', 200, { method: 'PUT', token: coord.token,
    body: { ga4_id: 'G-TEST12345', meta_pixel_id: '123456789012345' } });
  assert.equal(omitted.tracking.gtm_id, 'GTM-AB12CD', 'a non-admin save without gtm_id keeps the container');

  const config = await expectStatus('/api/public/marketing/config', 200);
  assert.deepEqual(Object.keys(config.tracking).sort(), ['ga4_id', 'gtm_id', 'meta_pixel_id', 'tiktok_pixel_id']);
  assert.equal(config.tracking.ga4_id, 'G-TEST12345');
  assert.equal(config.tracking.meta_pixel_id, '123456789012345');
  assert.ok(Array.isArray(config.popups));
  const site = await expectStatus('/api/public/site', 200);
  assert.equal(JSON.stringify(site).includes('G-TEST12345'), false, 'tracking settings stay out of other public payloads');
});

// ---------- 3. Lead forms + popups ----------

let form;
test('form builder validates fields and popup config; public config exposes popups without internals', async () => {
  await expectStatus('/api/marketing/admin/forms', 403, { method: 'POST', token: student.token, body: { name: 'x' } });
  await expectStatus('/api/marketing/admin/forms', 400, { method: 'POST', token: coord.token, body: { name: 'No fields', fields: [] } });
  await expectStatus('/api/marketing/admin/forms', 400, { method: 'POST', token: coord.token,
    body: { name: 'Bad key', fields: [{ key: 'Bad Key', label: 'x', type: 'text' }] } });
  await expectStatus('/api/marketing/admin/forms', 400, { method: 'POST', token: coord.token,
    body: { name: 'Bad popup', fields: [{ key: 'name' }], popup: { enabled: true, trigger: 'hover' } } });
  await expectStatus('/api/marketing/admin/forms', 400, { method: 'POST', token: coord.token,
    body: { name: 'Bad pages', fields: [{ key: 'name' }], popup: { enabled: true, pages: ['javascript:alert(1)'] } } });

  const created = await expectStatus('/api/marketing/admin/forms', 201, { method: 'POST', token: coord.token, body: {
    name: `Brochure ${stamp}`, title: 'รับโบรชัวร์หลักสูตร', auto_tag: `lead-${stamp}`, notify_emails: 'sales@example.invalid',
    fields: [
      { key: 'name', required: true }, { key: 'phone' }, { key: 'company' },
      { key: 'interest', label: 'หลักสูตรที่สนใจ', type: 'select', options: ['CCNA', 'AWS'], required: true }
    ],
    popup: { enabled: true, trigger: 'scroll', scroll_percent: 60, frequency_days: 3, pages: ['/courses', '/blog/*'] }
  } });
  form = created.form;
  assert.equal(form.fields[0].key, 'email', 'email is always collected');
  assert.equal(form.fields[0].required, true);
  assert.equal(form.popup.trigger, 'scroll');

  const config = await expectStatus('/api/public/marketing/config', 200);
  const popup = config.popups.find(p => p.id === form.id);
  assert.ok(popup, 'enabled popup is published');
  assert.deepEqual(popup.popup.pages, ['/courses', '/blog/*']);
  assert.equal(popup.notify_emails, undefined);
  assert.equal(popup.auto_tag, undefined);
  assert.equal(JSON.stringify(config).includes('sales@example.invalid'), false);

  // Turning the popup off removes it from the public config but keeps the embeddable form.
  await expectStatus(`/api/marketing/admin/forms/${form.id}`, 200, { method: 'PATCH', token: coord.token, body: { popup: { enabled: false } } });
  const after = await expectStatus('/api/public/marketing/config', 200);
  assert.ok(!after.popups.some(p => p.id === form.id));
  const embed = await expectStatus(`/api/public/marketing/forms/${form.id}`, 200);
  assert.equal(embed.form.title, 'รับโบรชัวร์หลักสูตร');
});

test('lead submissions validate input, require consent, block honeypot, tag matching users, and are rate limited', async () => {
  const path = `/api/public/marketing/forms/${form.id}/submit`;
  const ok = { values: { name: 'คุณลีด', email: 'Student3@netprime.com', phone: '081-234-5678', interest: 'CCNA' }, consent: true,
    page_path: '/courses', utm_source: 'facebook', utm_campaign: 'ccna-nov' };
  const created = await expectStatus(path, 201, { method: 'POST', body: ok });
  assert.ok(created.id);

  const noConsent = await expectStatus(path, 400, { method: 'POST', body: { ...ok, consent: false } });
  assert.match(noConsent.error, /ยินยอม/);
  await expectStatus(path, 400, { method: 'POST', body: { ...ok, values: { ...ok.values, email: 'not-an-email' } } });
  await expectStatus(path, 400, { method: 'POST', body: { ...ok, values: { ...ok.values, interest: 'Hacking' } } });
  await expectStatus(path, 400, { method: 'POST', body: { ...ok, values: { email: 'x@example.invalid' } } }); // name required
  await expectStatus(path, 400, { method: 'POST', body: { ...ok, website: 'http://spam.example' } });

  const leads = await expectStatus(`/api/marketing/admin/leads?form_id=${form.id}`, 200, { token: coord.token });
  assert.equal(leads.total, 1, 'invalid submissions are not stored');
  const lead = leads.leads[0];
  assert.equal(lead.email, 'student3@netprime.com');
  assert.equal(lead.user_id, 'usr_student3');
  assert.equal(lead.utm_source, 'facebook');
  assert.equal(lead.consent, 1);
  assert.ok(lead.consent_text);
  assert.equal(lead.data.interest, 'CCNA');

  // An anonymous submission with someone's email records the lead but never tags that account;
  // the auto-tag is applied only when the submitter is signed in as that account.
  const tagsOf = async () => (await expectStatus('/api/admin/people/usr_student3', 200, { token: admin.token })).user.tags || [];
  assert.ok(!(await tagsOf()).includes(`lead-${stamp}`), 'anonymous submission does not tag the existing user');
  await expectStatus(path, 201, { method: 'POST', body: ok, token: coord.token });
  assert.ok(!(await tagsOf()).includes(`lead-${stamp}`), 'another signed-in user cannot tag the account');
  await expectStatus(path, 201, { method: 'POST', body: ok, token: student.token });
  assert.ok((await tagsOf()).includes(`lead-${stamp}`), 'signed-in owner gets the auto-tag');

  await expectStatus(`/api/marketing/admin/leads/${lead.id}`, 400, { method: 'PATCH', token: coord.token, body: { status: 'won' } });
  const updated = await expectStatus(`/api/marketing/admin/leads/${lead.id}`, 200, { method: 'PATCH', token: coord.token,
    body: { status: 'contacted', notes: 'โทรแล้ว ส่งใบเสนอราคา' } });
  assert.equal(updated.lead.status, 'contacted');

  const csv = await request(`/api/marketing/admin/leads.csv?form_id=${form.id}`, { token: coord.token });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(String(csv.data).includes('student3@netprime.com'));
  await expectStatus('/api/marketing/admin/leads.csv', 403, { token: student.token });

  // The 10-per-10-minutes per-IP limit applies to every submission attempt.
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    const res = await request(path, { method: 'POST', body: { ...ok, values: { ...ok.values, email: `lead-${i}-${stamp}@example.invalid` } } });
    if (res.status === 429) limited = true;
    else assert.equal(res.status, 201, JSON.stringify(res.data));
  }
  assert.ok(limited, 'lead form is rate limited');
});

// ---------- 2. Affiliates ----------

test('referral attribution, self-referral block and commission math', async () => {
  // Referrer joins the default program (10%, auto-approved).
  const before = await expectStatus('/api/marketing/me/affiliate', 200, { token: student.token });
  assert.equal(before.affiliate, null);
  const joined = await expectStatus('/api/marketing/me/affiliate', 201, { method: 'POST', token: student.token });
  assert.equal(joined.status, 'approved');
  await expectStatus('/api/marketing/me/affiliate', 409, { method: 'POST', token: student.token });
  const code = joined.code;

  // Clicks are counted once per visitor per day; unknown codes are ignored.
  assert.equal((await expectStatus('/api/public/marketing/ref/click', 200, { method: 'POST', body: { code, path: '/courses' } })).valid, true);
  await expectStatus('/api/public/marketing/ref/click', 200, { method: 'POST', body: { code, path: '/courses' } });
  assert.equal((await expectStatus('/api/public/marketing/ref/click', 200, { method: 'POST', body: { code: 'NOPE0000' } })).valid, false);

  // New learner signs up from the referral link with UTM tags.
  const buyer = await register('buyer');
  const attributed = await expectStatus('/api/marketing/attribution', 200, { method: 'POST', token: buyer.token,
    body: { ref: code.toLowerCase(), utm_source: 'line', utm_medium: 'social', utm_campaign: `spring-${stamp}`, landing_path: '/courses/course_aws_csa' } });
  assert.equal(attributed.attributed, true);
  const again = await expectStatus('/api/marketing/attribution', 200, { method: 'POST', token: buyer.token, body: { ref: code } });
  assert.equal(again.attributed, false, 'first touch wins');

  // Self-referral: a new account using its own code is recorded without an affiliate.
  const selfie = await register('self');
  const own = await expectStatus('/api/marketing/me/affiliate', 201, { method: 'POST', token: selfie.token });
  const blocked = await expectStatus('/api/marketing/attribution', 200, { method: 'POST', token: selfie.token, body: { ref: own.code } });
  assert.equal(blocked.attributed, false);
  assert.equal(blocked.blocked, 'self_referral');

  // Buyer purchases a 5,215-baht course; staff confirm the transfer.
  const created = await expectStatus('/api/student/orders', 201, { method: 'POST', token: buyer.token, body: { course_id: 'course_aws_csa' } });
  const order = created.order;
  await expectStatus(`/api/manage/orders/${order.id}/confirm`, 200, { method: 'POST', token: admin.token, body: { amount_received: order.amount } });

  // orders.ts may call recordAffiliateConversion directly; the sync backfill covers it either way and is idempotent.
  await expectStatus('/api/marketing/admin/conversions/sync', 200, { method: 'POST', token: coord.token });
  await expectStatus('/api/marketing/admin/conversions/sync', 200, { method: 'POST', token: coord.token });
  const { conversions } = await expectStatus(`/api/marketing/admin/conversions`, 200, { token: coord.token });
  const mine = conversions.filter(cv => cv.order_id === order.id);
  assert.equal(mine.length, 1, 'one conversion per order');
  assert.equal(mine[0].commission_percent, 10);
  assert.equal(mine[0].commission_amount, Math.round(order.amount * 10) / 100);
  assert.equal(mine[0].status, 'pending');

  const dash = await expectStatus('/api/marketing/me/affiliate', 200, { token: student.token });
  assert.equal(dash.stats.clicks, 1);
  assert.equal(dash.stats.signups, 1);
  assert.equal(dash.stats.conversions, 1);
  assert.equal(dash.stats.commission.pending, mine[0].commission_amount);
  assert.match(dash.affiliate.link, new RegExp(`\\?ref=${code}$`));

  // Approve → payout (mark paid manually).
  const affiliateId = mine[0].affiliate_id;
  await expectStatus(`/api/marketing/admin/affiliates/${affiliateId}/payouts`, 400, { method: 'POST', token: coord.token, body: {} });
  await expectStatus(`/api/marketing/admin/conversions/${mine[0].id}/status`, 200, { method: 'POST', token: coord.token, body: { status: 'approved' } });
  const payout = await expectStatus(`/api/marketing/admin/affiliates/${affiliateId}/payouts`, 201, { method: 'POST', token: coord.token,
    body: { reference: 'TRF-001' } });
  assert.equal(payout.payout.amount, mine[0].commission_amount);
  await expectStatus(`/api/marketing/admin/conversions/${mine[0].id}/status`, 400, { method: 'POST', token: coord.token, body: { status: 'rejected' } });
  const paid = await expectStatus('/api/marketing/me/affiliate', 200, { token: student.token });
  assert.equal(paid.stats.commission.paid, mine[0].commission_amount);
  assert.equal(paid.stats.commission.approved, 0);

  // Program commission is validated; staff-only.
  await expectStatus('/api/marketing/admin/programs/aff_default', 400, { method: 'PATCH', token: coord.token, body: { commission_percent: 150 } });
  await expectStatus('/api/marketing/admin/programs', 403, { token: student.token });

  // UTM first-touch shows up in the analytics report.
  const report = await expectStatus('/api/marketing/admin/analytics', 200, { token: coord.token });
  const row = report.sources.find(s => s.campaign === `spring-${stamp}`);
  assert.ok(row, JSON.stringify(report.sources));
  assert.equal(row.source, 'line');
  assert.equal(row.signups, 1);
  assert.equal(row.paid_orders, 1);
  assert.ok(report.referrals.blocked_self >= 1);
  await expectStatus('/api/marketing/admin/analytics?from=2026-13-01', 400, { token: coord.token });
});

// ---------- 5. Reviews ----------

test('reviews: eligibility, moderation and averages', async () => {
  // student3: completed course_cf_workers, 0% in course_cisco_ccna.
  const ineligible = await expectStatus('/api/marketing/courses/course_cisco_ccna/review', 200, { token: student.token });
  assert.equal(ineligible.eligible, false);
  await expectStatus('/api/marketing/courses/course_cisco_ccna/review', 403, { method: 'PUT', token: student.token, body: { rating: 5 } });
  await expectStatus('/api/marketing/courses/course_cf_workers/review', 400, { method: 'PUT', token: student.token, body: { rating: 6 } });
  await expectStatus('/api/marketing/courses/course_cf_workers/review', 401, { method: 'PUT', body: { rating: 5 } });
  const fresh = await register('reviewer');
  await expectStatus('/api/marketing/courses/course_cf_workers/review', 403, { method: 'PUT', token: fresh.token, body: { rating: 1 } });

  const saved = await expectStatus('/api/marketing/courses/course_cf_workers/review', 200, { method: 'PUT', token: student.token,
    body: { rating: 4, body: 'อธิบายชัดเจน แล็บใช้งานได้จริง' } });
  assert.equal(saved.review.status, 'pending');
  let page = await expectStatus('/api/public/marketing/courses/course_cf_workers', 200);
  assert.equal(page.rating.count, 0, 'pending reviews are not public');

  const queue = await expectStatus('/api/marketing/admin/reviews?status=pending', 200, { token: coord.token });
  const review = queue.reviews.find(r => r.id === saved.review.id);
  assert.ok(review);
  await expectStatus(`/api/marketing/admin/reviews/${review.id}`, 403, { method: 'PATCH', token: student.token, body: { status: 'approved' } });
  await expectStatus(`/api/marketing/admin/reviews/${review.id}`, 200, { method: 'PATCH', token: coord.token, body: { status: 'approved' } });

  // A second approved review (MIT student also completed the course) → average 4.5.
  const mit = await login('student_mit@mit.edu', 'stud123');
  const second = await expectStatus('/api/marketing/courses/course_cf_workers/review', 200, { method: 'PUT', token: mit.token, body: { rating: 5 } });
  await expectStatus(`/api/marketing/admin/reviews/${second.review.id}`, 200, { method: 'PATCH', token: admin.token, body: { status: 'approved' } });

  page = await expectStatus('/api/public/marketing/courses/course_cf_workers', 200);
  assert.equal(page.rating.count, 2);
  assert.equal(page.rating.average, 4.5);
  assert.ok(page.reviews.some(r => r.reviewer === 'Emma W.'), 'reviewers are shown by first name and initial');
  assert.equal(JSON.stringify(page.reviews).includes('@'), false, 'no emails on the public page');
  const { ratings } = await expectStatus('/api/public/marketing/ratings', 200);
  assert.deepEqual(ratings.course_cf_workers, { average: 4.5, count: 2 });

  // Hiding removes it from the average; editing sends it back to moderation.
  await expectStatus(`/api/marketing/admin/reviews/${second.review.id}`, 200, { method: 'PATCH', token: coord.token, body: { status: 'hidden' } });
  const edited = await expectStatus('/api/marketing/courses/course_cf_workers/review', 200, { method: 'PUT', token: student.token, body: { rating: 3 } });
  assert.equal(edited.review.status, 'pending');
  const after = await expectStatus('/api/public/marketing/ratings', 200);
  assert.equal(after.ratings.course_cf_workers, undefined);
});

// ---------- 6. Voucher campaigns ----------

test('bulk voucher codes are unique, expire, export as CSV and are single-use', async () => {
  const base = { name: `Campaign ${stamp}`, prefix: 'mkt', discount_type: 'percent', discount_value: 100, quantity: 60, expires_on: '2099-12-31' };
  await expectStatus('/api/marketing/admin/campaigns', 403, { method: 'POST', token: student.token, body: base });
  await expectStatus('/api/marketing/admin/campaigns', 400, { method: 'POST', token: coord.token, body: { ...base, quantity: 5000 } });
  await expectStatus('/api/marketing/admin/campaigns', 400, { method: 'POST', token: coord.token, body: { ...base, expires_on: '2020-01-01' } });
  await expectStatus('/api/marketing/admin/campaigns', 400, { method: 'POST', token: coord.token, body: { ...base, discount_value: 120 } });
  await expectStatus('/api/marketing/admin/campaigns', 400, { method: 'POST', token: coord.token, body: { ...base, prefix: 'bad-prefix!' } });

  const created = await expectStatus('/api/marketing/admin/campaigns', 201, { method: 'POST', token: coord.token, body: base });
  assert.equal(created.created, 60);
  const csv = await request(`/api/marketing/admin/campaigns/${created.campaign.id}/codes.csv`, { token: coord.token });
  assert.equal(csv.status, 200);
  const codes = String(csv.data).split('\r\n').slice(1).map(line => line.split(',')[0].replace(/"/g, ''));
  assert.equal(codes.length, 60);
  assert.equal(new Set(codes).size, 60, 'codes are unique');
  assert.ok(codes.every(code => /^MKT-[A-Z2-9]{8}$/.test(code)), codes[0]);

  const { campaigns } = await expectStatus('/api/marketing/admin/campaigns', 200, { token: coord.token });
  const listed = campaigns.find(cmp => cmp.id === created.campaign.id);
  assert.equal(listed.code_count, 60);
  assert.equal(listed.used_count, 0);

  // First learner redeems a code (100% → enrolled at once); a second learner cannot reuse it.
  const first = await register('voucher1');
  const redeemed = await expectStatus('/api/student/orders', 201, { method: 'POST', token: first.token, body: { course_id: 'course_juniper_jncia', voucher_code: codes[0] } });
  assert.equal(redeemed.enrolled, true);
  const second = await register('voucher2');
  await expectStatus('/api/student/orders', 400, { method: 'POST', token: second.token, body: { course_id: 'course_juniper_jncia', voucher_code: codes[0] } });
  const stillValid = await expectStatus('/api/student/vouchers/apply', 200, { method: 'POST', token: second.token, body: { code: codes[1], course_id: 'course_juniper_jncia' } });
  assert.ok(stillValid);

  const after = await expectStatus('/api/marketing/admin/campaigns', 200, { token: coord.token });
  assert.equal(after.campaigns.find(cmp => cmp.id === created.campaign.id).used_count, 1);

  // Deactivating the campaign switches off the remaining codes.
  await expectStatus(`/api/marketing/admin/campaigns/${created.campaign.id}`, 200, { method: 'PATCH', token: coord.token, body: { active: false } });
  await expectStatus('/api/student/vouchers/apply', 400, { method: 'POST', token: second.token, body: { code: codes[1], course_id: 'course_juniper_jncia' } });
});
