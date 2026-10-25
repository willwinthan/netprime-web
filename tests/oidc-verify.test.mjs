// Pure unit tests (no Worker): OIDC ID token verification with locally generated keys,
// webhook signature format and destination URL guard, secret encryption.
// Run: node --test tests/oidc-verify.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyIdToken, pkceChallenge, validateDiscovery, assertedEmail, emailVerifiedClaim, OidcError, b64urlEncode } from '../backend/src/utils/oidc.ts';
import { signatureHeader, verifySignatureHeader, webhookUrlError, webhookEventFor, subscribed, nextAttemptAt, MAX_ATTEMPTS } from '../backend/src/utils/webhooks.ts';
import { encryptSecret, decryptSecret } from '../backend/src/utils/secretbox.ts';

const enc = value => b64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
const ISSUER = 'https://login.example.com/tenant/v2.0';
const CLIENT = 'client-123';
const NONCE = 'nonce-abc';
const now = Math.floor(Date.now() / 1000);

async function keyPair(alg) {
  const params = alg === 'RS256'
    ? { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
    : { name: 'ECDSA', namedCurve: 'P-256' };
  const pair = await crypto.subtle.generateKey(params, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { pair, jwk: { ...jwk, kid: `${alg}-key`, alg, use: 'sig' } };
}

async function sign(alg, privateKey, claims, header = {}) {
  const input = `${enc({ alg, kid: `${alg}-key`, typ: 'JWT', ...header })}.${enc(claims)}`;
  const params = alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
  const sig = await crypto.subtle.sign(params, privateKey, new TextEncoder().encode(input));
  return `${input}.${b64urlEncode(new Uint8Array(sig))}`;
}

const baseClaims = (extra = {}) => ({ iss: ISSUER, aud: CLIENT, sub: 'user-1', exp: now + 300, iat: now, nonce: NONCE, email: 'a@corp.example', email_verified: true, ...extra });

async function rejects(promise, code) {
  await assert.rejects(promise, err => err instanceof OidcError && err.code === code, `expected ${code}`);
}

for (const alg of ['RS256', 'ES256']) {
  test(`${alg} ID token: valid token verifies and wrong claims are rejected`, async () => {
    const { pair, jwk } = await keyPair(alg);
    const jwks = { keys: [jwk] };
    const opts = { issuer: ISSUER, clientId: CLIENT, nonce: NONCE, jwks };
    const claims = await verifyIdToken(await sign(alg, pair.privateKey, baseClaims()), opts);
    assert.equal(claims.sub, 'user-1');
    assert.equal(assertedEmail(claims), 'a@corp.example');

    await rejects(verifyIdToken(await sign(alg, pair.privateKey, baseClaims({ iss: 'https://evil.example' })), opts), 'issuer_mismatch');
    await rejects(verifyIdToken(await sign(alg, pair.privateKey, baseClaims({ aud: 'other' })), opts), 'audience_mismatch');
    await rejects(verifyIdToken(await sign(alg, pair.privateKey, baseClaims({ aud: [CLIENT, 'other'] })), opts), 'audience_mismatch');
    await rejects(verifyIdToken(await sign(alg, pair.privateKey, baseClaims({ exp: now - 600 })), opts), 'token_expired');
    await rejects(verifyIdToken(await sign(alg, pair.privateKey, baseClaims({ iat: now + 3600 })), opts), 'token_not_yet_valid');
    await rejects(verifyIdToken(await sign(alg, pair.privateKey, baseClaims({ nonce: 'replayed' })), opts), 'nonce_mismatch');
    await rejects(verifyIdToken(await sign(alg, pair.privateKey, baseClaims()), { ...opts, nonce: '' }), 'nonce_mismatch');

    // Signed by a different key with the same kid → bad signature.
    const other = await keyPair(alg);
    await rejects(verifyIdToken(await sign(alg, other.pair.privateKey, baseClaims()), opts), 'bad_signature');
    // Unknown kid.
    await rejects(verifyIdToken(await sign(alg, pair.privateKey, baseClaims(), { kid: 'rotated' }), opts), 'unknown_key');
    // Tampered payload.
    const token = await sign(alg, pair.privateKey, baseClaims());
    const [h, , s] = token.split('.');
    await rejects(verifyIdToken(`${h}.${enc(baseClaims({ sub: 'admin' }))}.${s}`, opts), 'bad_signature');
  });
}

test('alg none / HS256 and malformed tokens are rejected', async () => {
  const { jwk } = await keyPair('RS256');
  const opts = { issuer: ISSUER, clientId: CLIENT, nonce: NONCE, jwks: { keys: [jwk] } };
  await rejects(verifyIdToken(`${enc({ alg: 'none' })}.${enc(baseClaims())}.`, opts), 'unsupported_alg');
  await rejects(verifyIdToken(`${enc({ alg: 'HS256', kid: 'RS256-key' })}.${enc(baseClaims())}.abc`, opts), 'unsupported_alg');
  await rejects(verifyIdToken('not-a-jwt', opts), 'malformed_token');
});

test('email claim: explicit email_verified=false is refused; preferred_username is never used; missing claim is unverified', () => {
  assert.equal(assertedEmail({ email: 'x@corp.example', email_verified: false }), null);
  assert.equal(assertedEmail({ preferred_username: 'Y@Corp.Example' }), null);
  assert.equal(assertedEmail({ email: 'Y@Corp.Example' }), 'y@corp.example');
  assert.equal(emailVerifiedClaim({ email: 'y@corp.example' }), false);
  assert.equal(emailVerifiedClaim({ email: 'y@corp.example', email_verified: true }), true);
  assert.equal(emailVerifiedClaim({ email: 'y@corp.example', xms_edov: true }), true);
  assert.equal(emailVerifiedClaim({ email: 'y@corp.example', email_verified: false, xms_edov: false }), false);
});

test('PKCE S256 matches RFC 7636 appendix B and discovery is validated', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const doc = { issuer: ISSUER + '/', authorization_endpoint: 'https://login.example.com/a', token_endpoint: 'https://login.example.com/t', jwks_uri: 'https://login.example.com/k' };
  assert.equal(validateDiscovery(doc, ISSUER).token_endpoint, 'https://login.example.com/t');
  assert.throws(() => validateDiscovery({ ...doc, issuer: 'https://other' }, ISSUER), err => err.code === 'issuer_mismatch');
  assert.throws(() => validateDiscovery({ ...doc, token_endpoint: 'http://login.example.com/t' }, ISSUER), err => err.code === 'discovery_insecure');
  assert.throws(() => validateDiscovery({ ...doc, code_challenge_methods_supported: ['plain'] }, ISSUER), err => err.code === 'pkce_unsupported');
});

test('webhook signature header format and verification', async () => {
  const body = JSON.stringify({ event: 'user.created', id: 'evt_1' });
  const t = 1_700_000_000;
  const header = await signatureHeader('whsec_test', t, body);
  assert.match(header, /^t=1700000000,v1=[a-f0-9]{64}$/);
  // Independent HMAC with node:crypto over "<t>.<body>".
  const { createHmac } = await import('node:crypto');
  assert.equal(header.split('v1=')[1], createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex'));
  assert.equal(await verifySignatureHeader('whsec_test', header, body, t + 10), true);
  assert.equal(await verifySignatureHeader('wrong', header, body, t + 10), false);
  assert.equal(await verifySignatureHeader('whsec_test', header, body + ' ', t + 10), false);
  assert.equal(await verifySignatureHeader('whsec_test', header, body, t + 3600), false, 'old timestamps are rejected');
});

test('webhook URL guard blocks non-https, private, loopback and metadata destinations', () => {
  assert.equal(webhookUrlError('https://hooks.zapier.com/hooks/catch/1/abc'), null);
  assert.equal(webhookUrlError('https://hook.eu1.make.com/xyz'), null);
  for (const bad of [
    'http://hooks.zapier.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://2130706433/x', 'https://0x7f000001/x',
    'https://10.1.2.3/x', 'https://172.16.0.1/x', 'https://192.168.1.10/x', 'https://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal/computeMetadata', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://[::ffff:127.0.0.1]/x',
    'https://user:pass@example.com/x', 'https://example.com:22/x', 'https://intranet/x', 'https://app.internal/x', 'ftp://example.com',
    'https://hooks.mock.test/ok'
  ]) {
    assert.notEqual(webhookUrlError(bad), null, `${bad} must be blocked`);
  }
  assert.equal(webhookUrlError('https://hooks.mock.test/ok', { allowMock: true }), null);
});

test('event mapping, subscription filtering and retry schedule', () => {
  assert.equal(webhookEventFor('signup'), 'user.created');
  assert.equal(webhookEventFor('order_paid'), 'order.paid');
  assert.equal(webhookEventFor('lead.created'), 'lead.created');
  assert.equal(webhookEventFor('heartbeat'), null);
  assert.equal(subscribed(['order.paid'], 'order.paid'), true);
  assert.equal(subscribed(['order.paid'], 'user.created'), false);
  assert.equal(subscribed(['*'], 'user.created'), true);
  assert.equal(subscribed(['order.paid'], 'ping'), true);
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(nextAttemptAt(1, t0), '2026-01-01T00:05:00.000Z');
  assert.equal(nextAttemptAt(MAX_ATTEMPTS, t0), null);
});

test('secrets are AES-GCM encrypted per purpose and never stored in clear', async () => {
  const master = 'x'.repeat(40);
  const stored = await encryptSecret('whsec_value', master, 'webhook');
  assert.match(stored, /^v1\./);
  assert.ok(!stored.includes('whsec_value'));
  assert.equal(await decryptSecret(stored, master, 'webhook'), 'whsec_value');
  await assert.rejects(decryptSecret(stored, master, 'oidc-client'));
  await assert.rejects(decryptSecret(stored, 'y'.repeat(40), 'webhook'));
});
