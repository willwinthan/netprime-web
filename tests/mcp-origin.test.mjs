import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalApiOrigin } from '../backend/src/utils/publicOrigin.ts';

test('production signed-slip origins require a canonical HTTPS origin', () => {
  assert.equal(canonicalApiOrigin('https://api.example.com', false, 'https://internal.invalid', undefined), 'https://api.example.com');
  assert.equal(canonicalApiOrigin('https://api.example.com/', false, 'https://internal.invalid', undefined), 'https://api.example.com');
  for (const value of ['http://api.example.com', 'https://api.example.com/path', 'https://user@api.example.com', 'not-a-url']) {
    assert.equal(canonicalApiOrigin(value, false, 'https://internal.invalid', undefined), null, value);
  }
});

test('local signed-slip origins accept only HTTP loopback', () => {
  assert.equal(canonicalApiOrigin('', true, 'https://internal.invalid', 'http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(canonicalApiOrigin('', true, 'http://localhost:8787', undefined), 'http://localhost:8787');
  for (const value of ['http://example.com', 'https://127.0.0.1:8787', 'http://127.0.0.1:8787/path']) {
    assert.equal(canonicalApiOrigin('', true, 'https://internal.invalid', value), null, value);
  }
  assert.equal(canonicalApiOrigin('', false, 'http://127.0.0.1:8787', undefined), null);
});
