// Unit test (no Worker needed): the Virtual Lab engine grades a keystroke transcript the same way the browser runs it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendChunk, createSession, grade, parseTranscript, sampleSpec, TRANSCRIPT_LIMITS, validateSpec
} from '../packages/lab-engine/src/index.ts';

const lab = (() => {
  const v = validateSpec(sampleSpec());
  assert.equal(v.ok, true);
  return v.lab;
})();

/** Keystrokes for one router: Enter wakes the console, then configure Gi1. */
const configure = (device, ip, { shut = 'no shutdown' } = {}) =>
  [device, ['', 'enable', 'configure terminal', 'interface gi1', `ip address ${ip} 255.255.255.0`, shut, 'end', ''].join('\r')];
const solved = () => [configure('r1', '10.12.12.1'), configure('r2', '10.12.12.2')];

test('the sample lab validates and starts with nothing passed', () => {
  assert.equal(lab.id, 'LAB-001');
  assert.deepEqual(lab.initialState.deviceOrder, ['r1', 'r2']);
  const result = grade(lab, []);
  assert.equal(result.passed, false);
  assert.equal(result.passedCount, 0);
  assert.equal(result.total, 4);
});

test('a full keystroke transcript passes every objective', () => {
  const result = grade(lab, solved());
  assert.equal(result.passed, true);
  assert.deepEqual(result.results.map(r => r.passed), [true, true, true, true]);
});

test('mistakes leave objectives unmet, with reasons', () => {
  const shut = grade(lab, [configure('r1', '10.12.12.1'), configure('r2', '10.12.12.2', { shut: 'shutdown' })]);
  assert.equal(shut.passed, false);
  assert.equal(shut.passedCount, 2);
  const subnet = grade(lab, [configure('r1', '10.12.12.1'), configure('r2', '10.12.13.2')]);
  assert.equal(subnet.passed, false);
  assert.ok(subnet.results.find(r => !r.passed).reasons.length > 0);
});

test('grading matches the live browser session, whatever the terminal size', () => {
  const session = createSession(lab, { cols: 37, rows: 9 });
  const transcript = [];
  // Type one key at a time, alternating devices, the way xterm sends data.
  const [a, b] = solved();
  const keys = [...[...a[1]].map(k => ['r1', k]), ...[...b[1]].map(k => ['r2', k])];
  for (const [device, key] of keys) {
    appendChunk(transcript, device, key);
    session.input(device, key);
    if (key === '\r') session.resize(device, 120, 40);
  }
  assert.equal(session.getSnapshot().assessment.passedCount, 4);
  assert.equal(grade(lab, transcript).passed, true);
  assert.equal(transcript.length, 2, 'consecutive keys for one device merge into one chunk');
});

test('keystrokes that are not command lines replay too (exit, Return to resume, history, Ctrl-Z)', () => {
  const result = grade(lab, [
    ['r1', 'exit\r'],          // ends the console session: "Press RETURN to get started"
    ['r1', '\r'],              // this Return is not a command line, it only resumes the session
    ['r1', 'enable\rconf t\rint gi1\rip address 10.12.12.1 255.255.255.0\rno shut\r\x1a'],
    ['r2', 'en\rconf t\rint gi1\rip address 10.12.12.2 255.255.255.0\rno shut\rend\r'],
    ['r2', '\x1b[A\x1b[B\r']   // history up/down, then an empty line
  ]);
  assert.equal(result.passed, true);
});

test('transcripts from clients are checked before grading', () => {
  assert.equal(parseTranscript('nope', lab).ok, false);
  assert.equal(parseTranscript([['r9', 'enable\r']], lab).ok, false);
  assert.equal(parseTranscript([['r1', 5]], lab).ok, false);
  assert.equal(parseTranscript([['r1', 'x'.repeat(TRANSCRIPT_LIMITS.maxChars + 1)]], lab).ok, false);
  const merged = parseTranscript([['r1', 'en'], ['r1', 'able\r'], ['r2', '\r']], lab);
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.transcript, [['r1', 'enable\r'], ['r2', '\r']]);
});

test('a lab written as JSON only needs its own answers', () => {
  const spec = JSON.parse(JSON.stringify(sampleSpec()).split('10.12.12.').join('192.168.50.'));
  spec.id = 'LAB-T01';
  const v = validateSpec(spec);
  assert.equal(v.ok, true);
  assert.equal(grade(v.lab, solved()).passed, false);
  assert.equal(grade(v.lab, [configure('r1', '192.168.50.1'), configure('r2', '192.168.50.2')]).passed, true);
});

test('a broken spec is refused with the path of each problem', () => {
  const spec = sampleSpec();
  spec.links[0].b.interface = 'gi7';
  spec.objectives[0].params.device = 'r9';
  const v = validateSpec(spec);
  assert.equal(v.ok, false);
  const paths = v.errors.map(e => e.path);
  assert.ok(paths.includes('$.links[0].b'), paths.join(', '));
  assert.ok(paths.some(p => p.startsWith('$.objectives[0]')), paths.join(', '));
  assert.equal(validateSpec(null).ok, false);
  assert.equal(validateSpec([]).ok, false);
});

test('IPv4 helpers turn engine integers back into dotted addresses and masks', async () => {
  const { ipv4ToString, prefixToMask } = await import('../packages/lab-engine/src/index.ts');
  assert.equal(ipv4ToString(168561665), '10.12.12.1');
  assert.equal(prefixToMask(24), '255.255.255.0');
  assert.equal(prefixToMask(30), '255.255.255.252');
  assert.equal(prefixToMask(0), '0.0.0.0');
  assert.equal(prefixToMask(32), '255.255.255.255');
});
