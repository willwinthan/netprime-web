// Website builder suite: custom pages, menus, theme & branding, certificate templates (website.design).
import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { dangerCode, expectStatus, login, request } from './helpers.mjs';

let admin, coord, student;
const unique = () => Math.random().toString(36).slice(2, 8);

before(async () => {
  admin = (await login('admin@netprime.com', 'admin123')).token;
  coord = (await login('coord@netprime.com', 'coord123')).token;
  student = (await login('student3@netprime.com', 'stud123')).token;
});

const hero = (heading = 'หน้าทดสอบ') => ({ type: 'hero', heading, subheading: 'คำอธิบาย', cta_label: 'ลงทะเบียน', cta_href: '/schedule' });

// ---------- Permissions ----------

test('builder routes need website.design; public routes are open', async () => {
  await expectStatus('/api/website/pages', 401);
  await expectStatus('/api/website/pages', 403, { token: student });
  await expectStatus('/api/website/theme', 403, { token: student });
  await expectStatus('/api/website/certificate-templates', 403, { token: student });
  await expectStatus('/api/website/pages', 200, { token: coord });
  await expectStatus('/api/website/pages', 200, { token: admin });
  await expectStatus('/api/public/website/theme', 200);
  await expectStatus('/api/public/website/nav', 200);
});

// ---------- Pages ----------

test('pages: create draft (hidden publicly), publish, edit draft without leaking, unpublish, delete', async () => {
  const slug = `corp-${unique()}`;
  const created = await expectStatus('/api/website/pages', 201, { token: coord, method: 'POST', body: {
    title: 'อบรมองค์กร', title_en: 'Corporate training', slug, seo_title: 'อบรมองค์กร | NetPrime', seo_description: 'คำอธิบาย SEO',
    show_in_nav: true, blocks: [hero('ฉบับแรก'), { type: 'faq', heading: 'คำถาม', items: [{ q: 'ราคา?', a: 'ติดต่อเรา' }] }]
  } });
  const page = created.page;
  assert.equal(page.status, 'draft');
  assert.equal(page.blocks.length, 2);
  assert.ok(page.blocks.every(b => typeof b.id === 'string' && b.id.length > 0), 'server assigns block ids');

  // Drafts are invisible to visitors and absent from nav/sitemap listings.
  await expectStatus(`/api/public/website/pages/${slug}`, 404);
  let nav = await expectStatus('/api/public/website/nav', 200);
  assert.ok(!nav.pages.some(p => p.slug === slug));

  const published = await expectStatus(`/api/website/pages/${page.id}/publish`, 200, { token: coord, method: 'POST', body: {} });
  assert.equal(published.page.status, 'published');
  assert.equal(published.page.has_unpublished_changes, false);
  let pub = await expectStatus(`/api/public/website/pages/${slug}`, 200);
  assert.equal(pub.page.title, 'อบรมองค์กร');
  assert.equal(pub.page.title_en, 'Corporate training');
  assert.equal(pub.page.seo_description, 'คำอธิบาย SEO');
  assert.equal(pub.page.blocks[0].heading, 'ฉบับแรก');
  nav = await expectStatus('/api/public/website/nav', 200);
  assert.ok(nav.pages.some(p => p.slug === slug && p.show_in_nav && p.path === `/p/${slug}`));
  const listing = await expectStatus('/api/public/website/pages', 200);
  assert.ok(listing.pages.some(p => p.slug === slug), 'published pages are listed for the sitemap');

  // Editing a published page changes the draft only.
  const edited = await expectStatus(`/api/website/pages/${page.id}`, 200, { token: coord, method: 'PATCH', body: { blocks: [hero('ฉบับแก้ไข')], expected_updated_at: published.page.updated_at } });
  assert.equal(edited.page.has_unpublished_changes, true);
  pub = await expectStatus(`/api/public/website/pages/${slug}`, 200);
  assert.equal(pub.page.blocks[0].heading, 'ฉบับแรก', 'visitors keep seeing the published version');

  // Stale editor → 409.
  const stale = await request(`/api/website/pages/${page.id}`, { token: coord, method: 'PATCH', body: { title: 'x', expected_updated_at: published.page.updated_at } });
  assert.equal(stale.status, 409);

  await expectStatus(`/api/website/pages/${page.id}/publish`, 200, { token: coord, method: 'POST', body: {} });
  pub = await expectStatus(`/api/public/website/pages/${slug}`, 200);
  assert.equal(pub.page.blocks[0].heading, 'ฉบับแก้ไข');

  // A published page needs an emailed code (the coordinator created it, so their own address).
  await expectStatus(`/api/website/pages/${page.id}`, 428, { token: coord, method: 'DELETE' });
  const pageCode = await dangerCode(coord, 'page.delete', page.id);
  assert.equal(pageCode.sent_to, 'co***@netprime.com');
  await expectStatus(`/api/website/pages/${page.id}`, 403, { token: coord, method: 'DELETE', body: { confirmation_code: pageCode.debug_code === '123456' ? '654321' : '123456' } });

  await expectStatus(`/api/website/pages/${page.id}/unpublish`, 200, { token: coord, method: 'POST', body: {} });
  await expectStatus(`/api/public/website/pages/${slug}`, 404);

  await expectStatus(`/api/website/pages/${page.id}`, 200, { token: coord, method: 'DELETE' });
  await expectStatus(`/api/website/pages/${page.id}`, 404, { token: coord });
});

test('pages: slug must be unique, well-formed and not reserved', async () => {
  const slug = `promo-${unique()}`;
  await expectStatus('/api/website/pages', 201, { token: coord, method: 'POST', body: { title: 'A', slug, blocks: [hero()] } });
  const dup = await request('/api/website/pages', { token: coord, method: 'POST', body: { title: 'B', slug, blocks: [] } });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /ถูกใช้แล้ว/);
  for (const bad of ['Has Space', '../etc', 'ไทย', '-lead', 'a--b', 'dashboard']) {
    const res = await request('/api/website/pages', { token: coord, method: 'POST', body: { title: 'C', slug: bad, blocks: [] } });
    assert.equal(res.status, 400, `slug "${bad}" must be rejected`);
  }
  const other = await expectStatus('/api/website/pages', 201, { token: coord, method: 'POST', body: { title: 'D', slug: `other-${unique()}`, blocks: [] } });
  const rename = await request(`/api/website/pages/${other.page.id}`, { token: coord, method: 'PATCH', body: { slug } });
  assert.equal(rename.status, 409, 'renaming onto a taken slug is refused');
  const empty = await request(`/api/website/pages/${other.page.id}/publish`, { token: coord, method: 'POST', body: {} });
  assert.equal(empty.status, 400, 'an empty page cannot be published');
});

test('blocks: XSS-safe validation (no javascript:/data: links, no unknown types, video allowlist)', async () => {
  const slug = `xss-${unique()}`;
  const bad = [
    { type: 'script', html: '<script>alert(1)</script>' },
    { type: 'cta', label: 'คลิก', href: 'javascript:alert(1)' },
    { type: 'cta', label: 'คลิก', href: 'JaVaScRiPt:alert(1)' },
    { type: 'cta', label: 'คลิก', href: '//evil.example' },
    { type: 'cta', label: 'คลิก', href: '/\\evil.example' },
    { type: 'image', url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    { type: 'image', url: 'javascript:alert(1)' },
    { type: 'hero', heading: 'x', cta_label: 'go', cta_href: 'data:text/html,<b>x</b>' },
    { type: 'video', url: 'https://evil.example/embed/abc' },
    { type: 'video', url: 'http://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { type: 'features', items: [{ title: 'x', link: 'vbscript:msgbox' }] },
    { type: 'lead_form', form_id: '"><img src=x onerror=alert(1)>' },
    { type: 'richtext', doc: '<p>html</p>' },
    { type: 'hero', heading: 'a'.repeat(161) }
  ];
  for (const block of bad) {
    const res = await request('/api/website/pages', { token: coord, method: 'POST', body: { title: 'XSS', slug, blocks: [block] } });
    assert.equal(res.status, 400, `must reject ${JSON.stringify(block).slice(0, 80)}`);
    assert.equal(typeof res.data.error, 'string');
  }
  // Markup in plain text fields is stored as text (rendered escaped by React), extra keys are dropped.
  const ok = await expectStatus('/api/website/pages', 201, { token: coord, method: 'POST', body: { title: 'XSS ok', slug, blocks: [
    { type: 'hero', heading: '<img src=x onerror=alert(1)>', onclick: 'alert(1)', dangerouslySetInnerHTML: { __html: '<b>' } },
    { type: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' },
    { type: 'video', url: 'https://vimeo.com/76979871' },
    { type: 'richtext', doc: [{ type: 'paragraph', content: [{ type: 'text', text: 'สวัสดี', styles: {} }] }] },
    { type: 'lead_form', form_id: 'form_abc-123' }
  ] } });
  const heroBlock = ok.page.blocks[0];
  assert.equal(heroBlock.heading, '<img src=x onerror=alert(1)>');
  assert.ok(!('onclick' in heroBlock) && !('dangerouslySetInnerHTML' in heroBlock), 'unknown block keys are dropped');
});

test('courses block resolves only published courses on the public page', async () => {
  const slug = `courses-${unique()}`;
  const options = await expectStatus('/api/website/course-options', 200, { token: coord });
  assert.ok(Array.isArray(options.courses) && Array.isArray(options.categories));
  const ids = options.courses.slice(0, 2).map(c => c.id);
  const created = await expectStatus('/api/website/pages', 201, { token: coord, method: 'POST', body: { title: 'คอร์ส', slug, blocks: [
    { type: 'courses', heading: 'เลือกเอง', mode: 'ids', course_ids: [...ids, 'course_does_not_exist'], limit: 6 },
    { type: 'courses', heading: 'ทั้งหมด', mode: 'all', limit: 3 }
  ] } });
  const bad = await request('/api/website/pages', { token: coord, method: 'POST', body: { title: 'x', slug: `c-${unique()}`, blocks: [{ type: 'courses', mode: 'category' }] } });
  assert.equal(bad.status, 400, 'category mode needs a category');
  await expectStatus(`/api/website/pages/${created.page.id}/publish`, 200, { token: coord, method: 'POST', body: {} });
  const pub = await expectStatus(`/api/public/website/pages/${slug}`, 200);
  assert.deepEqual(pub.page.blocks[0].courses.map(c => c.id), ids, 'chosen order kept, unknown ids dropped');
  assert.ok(pub.page.blocks[1].courses.length <= 3);
  // Stored blocks never contain resolved course data.
  const admin = await expectStatus(`/api/website/pages/${created.page.id}`, 200, { token: coord });
  assert.ok(!('courses' in admin.page.blocks[0]));
});

test('english variant is served alongside the Thai blocks', async () => {
  const slug = `bilingual-${unique()}`;
  const created = await expectStatus('/api/website/pages', 201, { token: coord, method: 'POST', body: {
    title: 'สองภาษา', title_en: 'Bilingual', slug, blocks: [hero('ภาษาไทย')], blocks_en: [hero('English')]
  } });
  await expectStatus(`/api/website/pages/${created.page.id}/publish`, 200, { token: coord, method: 'POST', body: {} });
  const pub = await expectStatus(`/api/public/website/pages/${slug}`, 200);
  assert.equal(pub.page.blocks[0].heading, 'ภาษาไทย');
  assert.equal(pub.page.blocks_en[0].heading, 'English');
});

test('pages can be reordered', async () => {
  const a = await expectStatus('/api/website/pages', 201, { token: coord, method: 'POST', body: { title: 'A', slug: `ord-a-${unique()}`, blocks: [] } });
  const b = await expectStatus('/api/website/pages', 201, { token: coord, method: 'POST', body: { title: 'B', slug: `ord-b-${unique()}`, blocks: [] } });
  await expectStatus('/api/website/pages/reorder', 200, { token: coord, method: 'POST', body: { ids: [b.page.id, a.page.id] } });
  const list = await expectStatus('/api/website/pages', 200, { token: coord });
  const order = list.pages.map(p => p.id);
  assert.ok(order.indexOf(b.page.id) < order.indexOf(a.page.id));
});

// ---------- Navigation ----------

test('nav editor: validates links and labels, public nav reflects saves', async () => {
  const before = await expectStatus('/api/website/nav', 200, { token: coord });
  assert.ok(before.nav.header.length > 0, 'default menu is returned');
  for (const href of ['javascript:alert(1)', '//evil.example', 'data:text/html,x']) {
    const res = await request('/api/website/nav', { token: coord, method: 'PUT', body: { header: [{ label: 'x', href }], footer: [] } });
    assert.equal(res.status, 400, href);
  }
  const missing = await request('/api/website/nav', { token: coord, method: 'PUT', body: { header: [{ label: '', href: '/' }], footer: [] } });
  assert.equal(missing.status, 400);
  const tooMany = await request('/api/website/nav', { token: coord, method: 'PUT', body: { header: Array.from({ length: 9 }, (_, i) => ({ label: `m${i}`, href: '/' })), footer: [] } });
  assert.equal(tooMany.status, 400);
  const nav = { header: [{ label: 'หลักสูตร', label_en: 'Courses', href: '/courses' }, { label: 'พาร์ตเนอร์', href: 'https://partner.example/', new_tab: true }],
    footer: [{ label: 'ร่วมงานกับเรา', label_en: 'Careers', href: '/p/careers' }] };
  const saved = await expectStatus('/api/website/nav', 200, { token: coord, method: 'PUT', body: nav });
  assert.equal(saved.nav.header[1].new_tab, true);
  assert.equal(saved.nav.header[1].label_en, null);
  const pub = await expectStatus('/api/public/website/nav', 200);
  assert.deepEqual(pub.nav.footer.map(i => i.href), ['/p/careers']);
  await expectStatus('/api/website/nav', 200, { token: coord, method: 'PUT', body: before.nav });
});

// ---------- Theme ----------

test('theme: hex colors, contrast and font allowlist are enforced; public endpoint is cached', async () => {
  const initial = await expectStatus('/api/public/website/theme', 200);
  assert.equal(initial.theme.font, 'Anuphan');
  assert.ok(initial.fonts.includes('IBM Plex Sans Thai'));
  const base = { school_name: 'โรงเรียนทดสอบ', primary_color: '#1d4ea8', secondary_color: '#182443', font: 'Sarabun', radius: 8 };
  const cases = [
    [{ ...base, primary_color: 'red' }, /#RRGGBB/],
    [{ ...base, primary_color: '#fff' }, /#RRGGBB/],
    [{ ...base, primary_color: '#ffd166' }, /คอนทราสต์/],
    [{ ...base, secondary_color: '#cccccc' }, /คอนทราสต์/],
    [{ ...base, font: 'Comic Sans MS' }, /ฟอนต์/],
    [{ ...base, radius: 99 }, /ความมน/],
    [{ ...base, school_name: '' }, /ชื่อโรงเรียน/],
    [{ ...base, logo_url: 'javascript:alert(1)' }, /โลโก้/],
    [{ ...base, favicon_url: 'data:image/png;base64,AAAA' }, /favicon/]
  ];
  for (const [body, message] of cases) {
    const res = await request('/api/website/theme', { token: coord, method: 'PUT', body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.data.error, message);
  }
  const saved = await expectStatus('/api/website/theme', 200, { token: coord, method: 'PUT', body: { ...base, primary_color: '#1D4EA8', extra: 'ignored' } });
  assert.equal(saved.theme.primary_color, '#1d4ea8');
  assert.ok(!('extra' in saved.theme));
  const pub = await request('/api/public/website/theme');
  assert.equal(pub.status, 200);
  assert.equal(pub.data.theme.school_name, 'โรงเรียนทดสอบ');
  assert.equal(pub.data.theme.font, 'Sarabun');
  assert.ok(pub.data.updated_at, 'a saved theme reports updated_at');
  assert.match(pub.headers.get('cache-control') || '', /public, max-age=\d+/);
  const consoleRes = await request('/api/website/theme', { token: coord });
  assert.match(consoleRes.headers.get('cache-control') || '', /no-store/);
  // Restore defaults for other suites.
  await expectStatus('/api/website/theme', 200, { token: coord, method: 'PUT', body: consoleRes.data.defaults });
});

// ---------- Certificate templates ----------

test('certificate templates: CRUD, default handling, validation and per-course override', async () => {
  // No template yet → the built-in design is returned for any course.
  let resolved = await expectStatus('/api/public/website/certificate-template?course_id=course_cisco_ccna', 200);
  assert.equal(resolved.template.source, 'builtin');

  const badColor = await request('/api/website/certificate-templates', { token: coord, method: 'POST', body: { name: 'x', config: { colors: { primary: 'orange' } } } });
  assert.equal(badColor.status, 400);
  const badBg = await request('/api/website/certificate-templates', { token: coord, method: 'POST', body: { name: 'x', config: { background_url: 'javascript:alert(1)' } } });
  assert.equal(badBg.status, 400);
  const badPos = await request('/api/website/certificate-templates', { token: coord, method: 'POST', body: { name: 'x', config: { slots: { name: { x: 150 } } } } });
  assert.equal(badPos.status, 400);
  const tooManySigs = await request('/api/website/certificate-templates', { token: coord, method: 'POST', body: { name: 'x', config: { signatures: [1, 2, 3, 4].map(i => ({ name: `s${i}` })) } } });
  assert.equal(tooManySigs.status, 400);

  const first = await expectStatus('/api/website/certificate-templates', 201, { token: coord, method: 'POST', body: {
    name: 'มาตรฐานใหม่', config: { orientation: 'landscape', font: 'Sarabun', colors: { primary: '#1d4ea8' }, signatures: [{ name: 'ผู้อำนวยการ', title: 'NetPrime' }] }
  } });
  assert.equal(first.template.is_default, true, 'the first template becomes the default');
  assert.equal(first.template.config.colors.primary, '#1d4ea8');
  assert.equal(first.template.config.slots.name.size, 32, 'unspecified fields take the built-in defaults');

  const portrait = await expectStatus('/api/website/certificate-templates', 201, { token: coord, method: 'POST', body: {
    name: 'แนวตั้ง', config: { orientation: 'portrait', qr: { x: 80, y: 88, size: 30, visible: true } }
  } });
  assert.equal(portrait.template.is_default, false);

  resolved = await expectStatus('/api/public/website/certificate-template?course_id=course_cisco_ccna', 200);
  assert.equal(resolved.template.id, first.template.id);
  assert.equal(resolved.template.source, 'default');

  await expectStatus('/api/website/certificate-templates/courses/course_cisco_ccna', 200, { token: coord, method: 'PUT', body: { template_id: portrait.template.id } });
  resolved = await expectStatus('/api/public/website/certificate-template?course_id=course_cisco_ccna', 200);
  assert.equal(resolved.template.id, portrait.template.id);
  assert.equal(resolved.template.config.orientation, 'portrait');
  const other = await expectStatus('/api/public/website/certificate-template?course_id=course_cf_workers', 200);
  assert.equal(other.template.id, first.template.id, 'other courses keep the default');
  const unknownCode = await expectStatus('/api/public/website/certificate-template?code=NP-NOPE-0000', 200);
  assert.equal(unknownCode.template.id, first.template.id);

  await expectStatus('/api/website/certificate-templates/courses/course_missing', 404, { token: coord, method: 'PUT', body: { template_id: portrait.template.id } });
  await expectStatus('/api/website/certificate-templates/courses/course_cf_workers', 404, { token: coord, method: 'PUT', body: { template_id: 'ctpl_missing' } });
  const courses = await expectStatus('/api/website/certificate-templates/courses', 200, { token: coord });
  assert.equal(courses.courses.find(c => c.id === 'course_cisco_ccna').template_id, portrait.template.id);

  // The default cannot be deleted while others exist; switching the default moves the flag.
  const delDefault = await request(`/api/website/certificate-templates/${first.template.id}`, { token: coord, method: 'DELETE' });
  assert.equal(delDefault.status, 400);
  const unset = await request(`/api/website/certificate-templates/${first.template.id}`, { token: coord, method: 'PATCH', body: { is_default: false } });
  assert.equal(unset.status, 400);
  await expectStatus(`/api/website/certificate-templates/${portrait.template.id}`, 200, { token: coord, method: 'PATCH', body: { is_default: true, name: 'แนวตั้ง (หลัก)' } });
  const list = await expectStatus('/api/website/certificate-templates', 200, { token: coord });
  assert.deepEqual(list.templates.filter(t => t.is_default).map(t => t.id), [portrait.template.id]);

  // Deleting a template removes its course overrides.
  await expectStatus(`/api/website/certificate-templates/${first.template.id}`, 200, { token: coord, method: 'DELETE' });
  await expectStatus('/api/website/certificate-templates/courses/course_cisco_ccna', 200, { token: coord, method: 'PUT', body: { template_id: null } });
  resolved = await expectStatus('/api/public/website/certificate-template?course_id=course_cisco_ccna', 200);
  assert.equal(resolved.template.id, portrait.template.id);
  await expectStatus(`/api/website/certificate-templates/${portrait.template.id}`, 200, { token: coord, method: 'DELETE' });
  resolved = await expectStatus('/api/public/website/certificate-template?course_id=course_cisco_ccna', 200);
  assert.equal(resolved.template.source, 'builtin');
});

test('image upload: website.design only, images only', async () => {
  const form = new FormData();
  form.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/svg+xml' }), 'x.svg');
  const base = process.env.NETPRIME_TEST_BASE;
  const svg = await fetch(`${base}/api/website/images`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${coord}` } });
  assert.equal(svg.status, 400, 'SVG uploads are refused');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const ok = new FormData();
  ok.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
  const denied = await fetch(`${base}/api/website/images`, { method: 'POST', body: ok, headers: { Authorization: `Bearer ${student}` } });
  assert.equal(denied.status, 403);
  const ok2 = new FormData();
  ok2.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
  const res = await fetch(`${base}/api/website/images`, { method: 'POST', body: ok2, headers: { Authorization: `Bearer ${coord}` } });
  assert.equal(res.status, 201);
  const { url } = await res.json();
  assert.match(url, /\/api\/public\/images\/[a-f0-9]{32}\.png$/);
});
