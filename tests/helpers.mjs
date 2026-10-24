import assert from 'node:assert/strict';

const base = process.env.NETPRIME_TEST_BASE;
if (!base || new URL(base).hostname !== '127.0.0.1') {
  throw new Error('Run tests via pnpm test or pnpm test:readiness; only an isolated loopback Worker is allowed.');
}

export async function request(path, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, headers: response.headers, data };
}

export async function login(email, password) {
  const response = await request('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(response.status, 200, `Login failed for local fixture ${email}`);
  assert.ok(response.data.token);
  return response.data;
}

export async function expectStatus(path, status, options) {
  const response = await request(path, options);
  assert.equal(response.status, status, `${path}: ${JSON.stringify(response.data)}`);
  return response.data;
}
