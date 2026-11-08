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

/**
 * Asks for an email confirmation code for a dangerous delete (handlers/security.ts) and returns the
 * response body; the local Worker includes `debug_code` because email is only logged.
 */
export async function dangerCode(token, action, targetId, approver) {
  return expectStatus('/api/security/delete-codes', 200, { method: 'POST', token, body: { action, target_id: targetId, ...(approver ? { approver } : {}) } });
}

/** Requests a code as `token` and performs the DELETE (or other method) with it. */
export async function confirmedRequest(path, action, targetId, { token, method = 'DELETE', body = {}, approver } = {}) {
  const issued = await dangerCode(token, action, targetId, approver);
  return request(path, { token, method, body: { ...body, confirmation_code: issued.debug_code } });
}

/**
 * Completes a video lesson the legitimate way: player heartbeats spaced like real playback.
 * Seeded lessons have no stored length, so the first heartbeat reports a 2-second video
 * (utils/videoProgress.ts), and one heartbeat 2.1 s later credits the whole of it.
 */
export async function watchVideoLesson(token, lessonId) {
  const beat = resume_seconds => expectStatus(`/api/student/lessons/${lessonId}/progress`, 200,
    { method: 'POST', token, body: { resume_seconds, duration: 2 } });
  await beat(0);
  await new Promise(resolve => setTimeout(resolve, 2100));
  const done = await beat(2);
  assert.equal(done.completed, 1, `video lesson ${lessonId} did not complete: ${JSON.stringify(done)}`);
  return done;
}

/**
 * Confirms the account's email through the emailed-link flow (the local Worker returns the link as
 * debug_url). Needed before a new learner can order or upload a slip: see
 * signup.require_email_verification_for_payment in backend/src/utils/school.ts.
 */
export async function verifyEmail(token) {
  const sent = await expectStatus('/api/auth/resend-verification', 200, { method: 'POST', token });
  if (sent.email_verified) return;
  const link = new URL(sent.debug_url).searchParams.get('token');
  await expectStatus('/api/auth/verify-email', 200, { method: 'POST', body: { token: link } });
}
