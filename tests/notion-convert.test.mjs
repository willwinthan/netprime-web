// Unit tests for Notion → editor block conversion (pure functions, no Notion account needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertBlocks, convertRichText, hostedImageUrls, notionEmbedUrl, notionPageId, pageTitle } from '../backend/src/utils/notion.ts';

const rt = (text, annotations = {}, href = null) => ({ plain_text: text, href, annotations });

test('page IDs come from notion.so / notion.site links or raw IDs', () => {
  const id = '0123456789abcdef0123456789abcdef';
  const dashed = '01234567-89ab-cdef-0123-456789abcdef';
  assert.equal(notionPageId(`https://www.notion.so/team/Study-Plan-${id}?pvs=4`), dashed);
  assert.equal(notionPageId(`https://acme.notion.site/${dashed}`), dashed);
  assert.equal(notionPageId(id), dashed);
  assert.equal(notionPageId(`https://evil.example/${id}`), null);
  assert.equal(notionPageId('https://www.notion.so/no-id-here'), null);
});

test('published notion.site pages become embed URLs; other hosts do not', () => {
  assert.equal(notionEmbedUrl('https://acme.notion.site/Lab-0123456789abcdef0123456789abcdef'), 'https://acme.notion.site/ebd/0123456789abcdef0123456789abcdef');
  assert.equal(notionEmbedUrl('http://acme.notion.site/Lab-0123456789abcdef0123456789abcdef'), null);
  assert.equal(notionEmbedUrl('https://notion.site.evil.example/0123456789abcdef0123456789abcdef'), null);
});

test('rich text keeps styles and safe links only', () => {
  const inline = convertRichText([rt('หนา', { bold: true, code: true }), rt('ลิงก์', {}, 'https://x.example'), rt('อันตราย', {}, 'javascript:alert(1)'), rt('หน้าอื่น', {}, '/abc')]);
  assert.deepEqual(inline[0], { type: 'text', text: 'หนา', styles: { bold: true, code: true } });
  assert.equal(inline[1].type, 'link');
  assert.equal(inline[2].type, 'text', 'unsafe links become plain text');
  assert.equal(inline[3].href, 'https://www.notion.so/abc');
});

test('blocks convert to editor blocks, with hosted images replaced', () => {
  const hosted = 'https://prod-files-secure.s3.amazonaws.com/a.png?X-Amz-Signature=1';
  const blocks = [
    { id: '1', type: 'heading_1', heading_1: { rich_text: [rt('หัวข้อ')] } },
    { id: '2', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [rt('ข้อ 1')] }, children: [
      { id: '2a', type: 'to_do', to_do: { rich_text: [rt('ย่อย')], checked: true } }] },
    { id: '3', type: 'code', code: { rich_text: [rt('vlan 10')], language: 'Plain Text' } },
    { id: '4', type: 'image', image: { type: 'file', file: { url: hosted }, caption: [rt('ผัง')] } },
    { id: '5', type: 'callout', callout: { rich_text: [rt('ระวัง')], icon: { type: 'emoji', emoji: '⚠️' } } },
    { id: '6', type: 'table', table: { has_column_header: true }, children: [
      { id: '6a', type: 'table_row', table_row: { cells: [[rt('A')], [rt('B')]] } }] },
    { id: '7', type: 'embed', embed: { url: 'https://acme.notion.site/Lab-0123456789abcdef0123456789abcdef', caption: [] } },
    { id: '8', type: 'divider', divider: {} },
    { id: '9', type: 'unsupported_thing', unsupported_thing: {} }
  ];
  assert.deepEqual(hostedImageUrls(blocks), [hosted]);
  const ctx = { warnings: [], images: new Map([[hosted, 'https://api.example/api/public/images/x.png']]) };
  const out = convertBlocks(blocks, ctx);
  assert.deepEqual(out.map(b => b.type), ['heading', 'bulletListItem', 'codeBlock', 'image', 'quote', 'table', 'notionEmbed', 'divider']);
  assert.equal(out[0].props.level, 1);
  assert.equal(out[1].children[0].props.checked, true);
  assert.equal(out[2].content[0].text, 'vlan 10');
  assert.equal(out[3].props.url, 'https://api.example/api/public/images/x.png');
  assert.equal(out[4].content[0].text, '⚠️ ');
  assert.equal(out[5].content.headerRows, 1);
  assert.equal(ctx.warnings.length, 1);

  const failed = convertBlocks([blocks[3]], { warnings: [], images: new Map([[hosted, null]]) });
  assert.equal(failed.length, 0, 'images that could not be copied are dropped, not linked to expiring URLs');
});

test('page title comes from the title property', () => {
  assert.equal(pageTitle({ properties: { Name: { type: 'title', title: [rt('แผนเตรียมสอบ')] } } }), 'แผนเตรียมสอบ');
});
