// Unit test (no Worker needed): every public-site i18n key has a Thai and an English text with the same placeholders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { dictionary, LANGS, translate } from '../frontend-admin/src/i18n/dictionary.ts';

const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('Thai and English have exactly the same keys', () => {
  assert.deepEqual(LANGS, ['th', 'en']);
  const th = Object.keys(dictionary.th).sort();
  const en = Object.keys(dictionary.en).sort();
  assert.deepEqual(en.filter(k => !th.includes(k)), [], 'keys only in English');
  assert.deepEqual(th.filter(k => !en.includes(k)), [], 'keys only in Thai');
});

test('every text is non-empty and uses the same placeholders in both languages', () => {
  for (const key of Object.keys(dictionary.th)) {
    for (const lang of LANGS) {
      const text = dictionary[lang][key];
      assert.equal(typeof text, 'string', `${lang}.${key}`);
      assert.ok(text.trim().length > 0, `${lang}.${key} is empty`);
    }
    assert.deepEqual(placeholders(dictionary.en[key]), placeholders(dictionary.th[key]), `placeholders differ for ${key}`);
  }
});

test('English texts are not left in Thai', () => {
  const thaiChars = /[฀-๿]/;
  const leftovers = Object.entries(dictionary.en).filter(([, text]) => thaiChars.test(text)).map(([key]) => key);
  assert.deepEqual(leftovers, []);
});

test('translate fills placeholders and falls back to Thai, then the key', () => {
  assert.equal(translate('en', 'catalog.count', { count: 3 }), '3 courses');
  assert.equal(translate('th', 'catalog.count', { count: 3 }), '3 คอร์ส');
  assert.equal(translate('en', 'no.such.key'), 'no.such.key');
});

test('every t("…") key used in the source exists in the dictionary', async () => {
  const root = new URL('../frontend-admin/src/', import.meta.url);
  const files = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) await walk(url);
      else if (/\.tsx?$/.test(entry.name)) files.push(url);
    }
  };
  await walk(root);
  const missing = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (!/useI18n|from "(\.\.\/)+i18n"|from "\.\/i18n"/.test(source)) continue;
    for (const match of source.matchAll(/\bt\("([a-zA-Z]+\.[a-zA-Z.]+)"/g)) {
      if (!(match[1] in dictionary.th)) missing.push(`${file.pathname.split('/src/')[1]}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});
