import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { expectStatus, login, request } from './helpers.mjs';

let acme, mit, student, otherStudent, admin;
before(async () => {
  acme = await login('hr@netprime.com', 'partner123');
  mit = await login('coordinator@mit.edu', 'univ123');
  student = await login('student3@netprime.com', 'stud123');
  otherStudent = await login('student1@netprime.com', 'stud123');
  admin = await login('admin@netprime.com', 'admin123');
});

const details = { title: 'Build local test gateway', description: 'A test-only project', scopeOfWork: 'Deliver an isolated demo', budgetType: 'fixed', budgetRange: '1000', minLevel: 1 };

test('organization-bound project creation and cross-organization project access', async () => {
  const created = await expectStatus('/api/outsource/projects', 200, { method: 'POST', token: acme.token, body: details });
  const projectId = created.projectId;
  const all = await expectStatus('/api/outsource/projects', 200, { token: student.token });
  assert.equal(all.find(project => project.id === projectId)?.partner_id, 'partner_acme');
  await expectStatus(`/api/outsource/projects/${projectId}/candidates`, 403, { token: mit.token });
  await expectStatus(`/api/outsource/projects/${projectId}/candidates`, 200, { token: acme.token });
  await expectStatus(`/api/outsource/projects/${projectId}/candidates`, 200, { token: admin.token });
  await expectStatus('/api/outsource/projects', 400, { method: 'POST', token: admin.token, body: details });
  const adminCreated = await expectStatus('/api/outsource/projects', 200, { method: 'POST', token: admin.token, body: { ...details, partner_id: 'partner_mit' } });
  const after = await expectStatus('/api/outsource/projects', 200, { token: student.token });
  assert.equal(after.find(project => project.id === adminCreated.projectId)?.partner_id, 'partner_mit');
});

test('bid → accept → submit → approve obeys owner, state, and EXP rules', async () => {
  const project = await expectStatus('/api/outsource/projects', 200, { method: 'POST', token: acme.token, body: details });
  const projectId = project.projectId;
  const application = await expectStatus(`/api/outsource/projects/${projectId}/apply`, 200, { method: 'POST', token: student.token, body: { proposal: 'Local proposal', bidAmount: '1000' } });
  await expectStatus(`/api/outsource/projects/${projectId}/apply`, 409, { method: 'POST', token: student.token, body: { proposal: 'Duplicate', bidAmount: '1000' } });
  await expectStatus(`/api/outsource/applications/${application.applicationId}/accept`, 403, { method: 'POST', token: mit.token, body: {} });
  await expectStatus(`/api/outsource/applications/${application.applicationId}/milestones`, 403, { token: otherStudent.token });
  const candidates = await expectStatus(`/api/outsource/projects/${projectId}/candidates`, 200, { token: acme.token });
  assert.ok(candidates.some(candidate => candidate.id === application.applicationId && candidate.studentEmail === 'student3@netprime.com'));
  const accepted = await expectStatus(`/api/outsource/applications/${application.applicationId}/accept`, 200, { method: 'POST', token: acme.token, body: {} });
  assert.equal(accepted.success, true);
  const repeat = await expectStatus(`/api/outsource/applications/${application.applicationId}/accept`, 200, { method: 'POST', token: acme.token, body: {} });
  assert.equal(repeat.alreadyAccepted, true);
  const milestones = await expectStatus(`/api/outsource/applications/${application.applicationId}/milestones`, 200, { token: student.token });
  assert.equal(milestones.length, 1);
  const milestoneId = milestones[0].id;
  await expectStatus(`/api/outsource/applications/${application.applicationId}/milestones`, 403, { token: mit.token });
  await expectStatus(`/api/outsource/milestones/${milestoneId}/approve`, 403, { method: 'POST', token: mit.token, body: {} });
  await expectStatus(`/api/outsource/milestones/${milestoneId}/approve`, 409, { method: 'POST', token: acme.token, body: {} });
  await expectStatus(`/api/outsource/milestones/${milestoneId}/submit`, 403, { method: 'POST', token: otherStudent.token, body: { deliverables: 'Wrong owner' } });
  await expectStatus(`/api/outsource/milestones/${milestoneId}/submit`, 200, { method: 'POST', token: student.token, body: { deliverables: 'Test implementation' } });
  await expectStatus(`/api/outsource/milestones/${milestoneId}/submit`, 409, { method: 'POST', token: student.token, body: { deliverables: 'Duplicate' } });
  await expectStatus('/api/outsource/ai-pm-audit', 403, { method: 'POST', token: mit.token, body: { saveReport: true, milestoneId } });
  const before = await expectStatus('/api/gamification/profile', 200, { token: student.token });
  const approval = await expectStatus(`/api/outsource/milestones/${milestoneId}/approve`, 200, { method: 'POST', token: acme.token, body: {} });
  assert.equal(approval.gamification.expAwarded, 200);
  await expectStatus(`/api/outsource/milestones/${milestoneId}/approve`, 409, { method: 'POST', token: acme.token, body: {} });
  const after = await expectStatus('/api/gamification/profile', 200, { token: student.token });
  assert.equal(after.exp, before.exp + 200);
});
