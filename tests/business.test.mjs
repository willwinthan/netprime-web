import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let admin, acme;
before(async () => {
  admin = await login('admin@netprime.com', 'admin123');
  acme = await login('hr@netprime.com', 'partner123');
});

test('seat creation requires a password and binds partner to their own organization', async () => {
  await expectStatus('/api/business/seats/assign', 400, { method: 'POST', token: acme.token,
    body: { email: 'no-password@example.invalid', name: 'No Password' } });
  const created = await expectStatus('/api/business/seats/assign', 201, { method: 'POST', token: acme.token,
    body: { email: 'acme-local@example.invalid', name: 'Acme Test', password: 'local-strong-123', partner_id: 'partner_mit' } });
  assert.equal(created.student.partner_id, 'partner_acme');
  const roster = await expectStatus('/api/business/analytics', 200, { token: acme.token });
  assert.equal(roster.usedSeats, 3);
  await expectStatus('/api/business/seats/assign', 400, { method: 'POST', token: acme.token,
    body: { email: 'acme-local@example.invalid', name: 'Duplicate', password: 'local-strong-123' } });
  const user = await login('acme-local@example.invalid', 'local-strong-123');
  assert.equal(user.user.role, 'student');
});

test('concurrent seat requests cannot exceed organization capacity', async () => {
  const attempts = await Promise.all(Array.from({ length: 7 }, (_, index) =>
    request('/api/business/seats/assign', { method: 'POST', token: admin.token,
      body: { email: `globex-seat-${index}@example.invalid`, name: `Seat ${index}`,
        password: 'local-strong-123', partner_id: 'partner_globex' } })));
  assert.equal(attempts.filter(response => response.status === 201).length, 5);
  assert.equal(attempts.filter(response => response.status === 400).length, 2);
  const roster = await expectStatus('/api/business/analytics?partner_id=partner_globex', 200, { token: admin.token });
  assert.equal(roster.usedSeats, 5);
  assert.equal(roster.roster.length, 5);
});
