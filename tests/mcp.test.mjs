// MCP suite (agent platform phases 2–3): /mcp with a raw agent key and with OAuth (dynamic client
// registration + PKCE + the agent-key consent page), read-only vs write MCP access, and act tools
// reaching the approval queue through MCP.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { request, login, expectStatus } from './helpers.mjs';

const base = process.env.NETPRIME_TEST_BASE;
let admin, student;
const keys = {};
let rpcId = 1;

/** One JSON-RPC call over Streamable HTTP; accepts a JSON or an SSE answer. */
async function mcp(token, method, params = {}, { notify = false } = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18', ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: rpcId++, method, params }),
    signal: AbortSignal.timeout(10000)
  });
  const text = await res.text();
  let body = null;
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
    body = data.length ? JSON.parse(data[data.length - 1]) : null;
  } else {
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  }
  return { status: res.status, headers: res.headers, body };
}

async function session(token) {
  const init = await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'netprime-test', version: '1.0.0' } });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  return init.body.result;
}

const toolNames = async token => (await mcp(token, 'tools/list')).body.result.tools.map(t => t.name).sort();
const callTool = async (token, name, args = {}) => {
  const res = await mcp(token, 'tools/call', { name, arguments: args });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const result = res.body.result;
  const text = result.content[0].text;
  return { isError: !!result.isError, data: JSON.parse(text.replace(/^HTTP \d+\n/, '')), text };
};

test('setup: agent keys with read and write MCP access', async () => {
  admin = (await login('admin@netprime.com', 'admin123')).token;
  student = (await login('student3@netprime.com', 'stud123')).token;
  const make = async (name, body) => expectStatus('/api/admin/platform/api-keys', 201, { method: 'POST', token: admin, body: { name, kind: 'agent', rate_limit_per_minute: 1000, ...body } });
  const reader = await make('MCP reader', { scopes: ['reports:read', 'sessions:read', 'inquiries:read', 'events:read', 'orders:confirm'], mcp_access: 'read' });
  keys.reader = reader.secret; keys.readerId = reader.key.id;
  assert.equal(reader.key.mcp_access, 'read');
  const writer = await make('MCP writer', { scopes: ['reports:read', 'inquiries:read', 'inquiries:write', 'orders:confirm', 'orders:read'], mcp_access: 'write' });
  keys.writer = writer.secret; keys.writerId = writer.key.id;
  const off = await make('No MCP', { scopes: ['reports:read'], mcp_access: 'off' });
  keys.off = off.secret;
  const integration = await expectStatus('/api/admin/platform/api-keys', 201, { method: 'POST', token: admin, body: { name: 'Zapier', scopes: ['reports:read'] } });
  keys.integration = integration.secret;
  assert.equal((await request('/api/admin/platform/api-keys', { method: 'POST', token: admin, body: { name: 'x', scopes: ['reports:read'], mcp_access: 'write' } })).status, 400);
});

test('raw agent key: initialize, tools follow scopes, read-only access hides write tools', async () => {
  assert.equal((await mcp(null, 'initialize', {})).status, 401);
  assert.equal((await mcp('npk_' + 'x'.repeat(43), 'tools/list')).status, 401);
  assert.equal((await mcp(keys.integration, 'tools/list')).status, 401, 'only agent keys may use MCP');
  assert.equal((await mcp(keys.off, 'tools/list')).status, 403);

  const info = await session(keys.reader);
  assert.equal(info.serverInfo.name, 'netprime-lms');
  assert.match(info.instructions, /get_daily_ops_summary/);
  const names = await toolNames(keys.reader);
  for (const n of ['whoami', 'get_action', 'list_my_actions', 'get_daily_ops_summary', 'list_training_sessions', 'list_inquiries', 'get_events']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('confirm_order'), 'read access: no act tools even with the scope');
  assert.ok(!names.includes('list_leads'), 'no scope, no tool');
  const listed = (await mcp(keys.reader, 'tools/list')).body.result.tools.find(t => t.name === 'list_training_sessions');
  assert.equal(listed.annotations.readOnlyHint, true);
  assert.ok(listed.inputSchema.properties.status.enum.includes('open'));

  const me = await callTool(keys.reader, 'whoami');
  assert.equal(me.data.data.name, 'MCP reader');
  const ops = await callTool(keys.reader, 'get_daily_ops_summary', {});
  assert.equal(ops.isError, false);
  assert.ok(Array.isArray(ops.data.data.highlights));
  const sessions = await callTool(keys.reader, 'list_training_sessions', { status: 'open', limit: 5 });
  assert.ok(sessions.data.data.length >= 1);
  const bad = await mcp(keys.reader, 'tools/call', { name: 'list_training_sessions', arguments: { status: 'nope' } });
  assert.ok(bad.body.error || bad.body.result?.isError, 'schema rejects bad enum');

  const log = await expectStatus(`/api/admin/agents/activity?key_id=${keys.readerId}&limit=50`, 200, { token: admin });
  assert.ok(log.activity.some(a => a.method === 'MCP GET' && a.path.startsWith('/api/v1/ops/daily-summary')), 'MCP calls are logged as the agent');
});

test('MCP calls obey the kill switch and read-only mode on the v1 side too', async () => {
  await expectStatus(`/api/admin/agents/keys/${keys.readerId}/pause`, 200, { method: 'POST', token: admin });
  const paused = await callTool(keys.reader, 'whoami');
  assert.equal(paused.isError, true);
  assert.equal(paused.data.code, 'key_paused');
  await expectStatus(`/api/admin/agents/keys/${keys.readerId}/resume`, 200, { method: 'POST', token: admin });
  assert.equal((await callTool(keys.reader, 'whoami')).isError, false);
  // A forged assertion header from outside is ignored (it is an HMAC with the server secret).
  const forged = await request('/api/v1/me', { headers: { 'X-NetPrime-Agent-Assertion': `${keys.readerId}~write~local~${Date.now()}~${'0'.repeat(64)}` } });
  assert.equal(forged.status, 401);
});

test('write access: draft runs at once, act goes to the approval queue', async () => {
  const inquiry = await expectStatus('/api/public/inquiries', 201, { method: 'POST',
    body: { name: 'ลูกค้า MCP', email: 'mcp-contact@example.invalid', message: 'ขอใบเสนอราคา', consent: true } });
  const names = await toolNames(keys.writer);
  assert.ok(names.includes('update_inquiry') && names.includes('confirm_order') && names.includes('cancel_action'));
  const tool = (await mcp(keys.writer, 'tools/list')).body.result.tools.find(t => t.name === 'confirm_order');
  assert.equal(tool.annotations.destructiveHint, true);
  assert.match(tool.description, /อนุมัติ/);
  assert.ok(tool.inputSchema.properties.idempotency_key);

  const draft = await callTool(keys.writer, 'update_inquiry', { inquiry_id: inquiry.id, status: 'in_progress', note: 'โทรกลับแล้ว', idempotency_key: `inq-${inquiry.id}` });
  assert.equal(draft.isError, false, draft.text);
  assert.equal(draft.data.data.status, 'executed');

  const order = (await expectStatus('/api/student/orders', 201, { method: 'POST', token: student, body: { course_id: 'course_aws_net' } })).order;
  const dry = await callTool(keys.writer, 'confirm_order', { order_id: order.reference, amount_received: order.amount, dry_run: true });
  assert.equal(dry.data.dry_run, true);
  const queued = await callTool(keys.writer, 'confirm_order', { order_id: order.reference, amount_received: order.amount, idempotency_key: `mcp-${order.id}`, reason: 'ตรวจ statement แล้ว' });
  assert.equal(queued.isError, false, queued.text);
  assert.equal(queued.data.data.status, 'pending');
  const again = await callTool(keys.writer, 'confirm_order', { order_id: order.reference, amount_received: order.amount, idempotency_key: `mcp-${order.id}` });
  assert.equal(again.data.replayed, true);

  await expectStatus(`/api/admin/agents/actions/${queued.data.data.id}/approve`, 200, { method: 'POST', token: admin, body: {} });
  const status = await callTool(keys.writer, 'get_action', { action_id: queued.data.data.id });
  assert.equal(status.data.data.status, 'executed');

  // Switching the key to read-only takes effect on the next request.
  await expectStatus(`/api/admin/platform/api-keys/${keys.writerId}`, 200, { method: 'PATCH', token: admin, body: { mcp_access: 'read' } });
  assert.ok(!(await toolNames(keys.writer)).includes('confirm_order'));
  await expectStatus(`/api/admin/platform/api-keys/${keys.writerId}`, 200, { method: 'PATCH', token: admin, body: { mcp_access: 'write' } });
});

// ==========================================
// OAuth for MCP clients
// ==========================================

test('OAuth: discovery, dynamic registration, agent-key consent, PKCE token, MCP call', async () => {
  const meta = await request('/.well-known/oauth-authorization-server');
  assert.equal(meta.status, 200, JSON.stringify(meta.data));
  assert.ok(meta.data.authorization_endpoint.endsWith('/oauth/authorize'));
  assert.ok(meta.data.token_endpoint.endsWith('/oauth/token'));
  const unauth = await mcp(null, 'tools/list');
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') || '', /Bearer/);

  const redirect = 'https://client.example/callback';
  const reg = await request('/oauth/register', { method: 'POST', body: { client_name: 'Claude Test', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  const clientId = reg.data.client_id;

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'xyz', scope: 'agent', resource: `${base}/mcp` }).toString();
  const page = await fetch(`${base}/oauth/authorize?${query}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Claude Test/);
  assert.match(html, /agent key/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  // Browsers check form-action against the redirect after the POST: the client's callback origin must be allowed.
  assert.match(page.headers.get('content-security-policy') || '', /form-action 'self' https:\/\/client\.example[;\s]/);

  const post = body => fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  assert.equal((await post({ oauth_query: query, agent_key: 'npk_wrong' })).status, 400);
  assert.equal((await post({ oauth_query: query, agent_key: keys.integration })).status, 400, 'integration keys cannot be connected');
  const ok = await post({ oauth_query: query, agent_key: keys.writer });
  assert.equal(ok.status, 302);
  const location = new URL(ok.headers.get('location'));
  assert.equal(location.origin + location.pathname, redirect);
  assert.equal(location.searchParams.get('state'), 'xyz');
  const code = location.searchParams.get('code');

  const tokenRes = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: `${base}/mcp` }) });
  const token = await tokenRes.json();
  assert.equal(tokenRes.status, 200, JSON.stringify(token));
  assert.ok(token.access_token);

  await session(token.access_token);
  const me = await callTool(token.access_token, 'whoami');
  assert.equal(me.data.data.name, 'MCP writer', 'the OAuth connection acts as the pasted agent key');
  assert.ok((await toolNames(token.access_token)).includes('update_inquiry'));

  // Revoking the key cuts off the OAuth connection too.
  const { debug_code } = await expectStatus('/api/security/delete-codes', 200, { method: 'POST', token: admin, body: { action: 'api_key.revoke', target_id: keys.writerId } });
  await expectStatus(`/api/admin/platform/api-keys/${keys.writerId}`, 200, { method: 'DELETE', token: admin, headers: { 'X-Confirmation-Code': debug_code } });
  assert.equal((await mcp(token.access_token, 'tools/list')).status, 401);
});

test('the rest of the API is unaffected by the MCP gateway', async () => {
  const site = await request('/api/public/site');
  assert.equal(site.status, 200);
  assert.ok([400, 404].includes((await request('/oauth/nothing-here')).status));
});
