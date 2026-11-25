// Tests the frame-forwarding logic of the VLAN self-learning lesson (the ENGINE block in vlan.html).
// Run: node --test scripts/self-learning/vlan.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('./vlan.html', import.meta.url), 'utf8');
const engine = html.slice(html.indexOf('/* ENGINE START'), html.indexOf('/* ENGINE END */'));
assert.ok(engine.length > 100, 'ENGINE block not found in vlan.html');
const { broadcast, dot1qTag, routeAtoB, labGoals, FLAT, SPLIT, NATIVE_BAD } = new Function(
  `${engine}; return { broadcast, dot1qTag, routeAtoB, labGoals, FLAT, SPLIT, NATIVE_BAD };`)();

const clone = cfg => JSON.parse(JSON.stringify(cfg));

test('a flat LAN delivers a broadcast to every other PC', () => {
  assert.deepEqual(broadcast(FLAT, 'A').receivers, ['B', 'C', 'D']);
});

test('VLANs over a trunk deliver only within the same VLAN, tagged on the trunk', () => {
  const a = broadcast(SPLIT, 'A');
  assert.deepEqual(a.receivers, ['C']);
  assert.equal(a.trunkTag, 10);
  assert.deepEqual(broadcast(SPLIT, 'B').receivers, ['D']);
});

test('a VLAN not allowed on the trunk stays on its own switch', () => {
  const cfg = clone(SPLIT);
  cfg.link.allowed = [1, 20];
  assert.deepEqual(broadcast(cfg, 'A').receivers, []);
  assert.equal(broadcast(cfg, 'A').crossed, false);
  assert.deepEqual(broadcast(cfg, 'B').receivers, ['D']);
});

test('the native VLAN crosses untagged, and a mismatch lands it in the other VLAN', () => {
  const cfg = clone(SPLIT);
  cfg.link.native1 = 10; cfg.link.native2 = 10;
  const same = broadcast(cfg, 'A');
  assert.equal(same.trunkTag, null);
  assert.deepEqual(same.receivers, ['C']);
  const bad = broadcast(NATIVE_BAD, 'A');
  assert.equal(bad.trunkTag, null);
  assert.equal(bad.arrivesIn, 20);
  assert.deepEqual(bad.receivers, ['D']);
});

test('an access link between switches carries only its own VLAN, untagged', () => {
  const cfg = clone(SPLIT);
  cfg.link = { mode: 'access', access: 10, allowed: [], native1: 1, native2: 1 };
  assert.deepEqual(broadcast(cfg, 'A').receivers, ['C']);
  assert.equal(broadcast(cfg, 'A').trunkTag, null);
  assert.deepEqual(broadcast(cfg, 'B').receivers, []);
});

test('the 802.1Q tag bytes follow TPID, PCP, DEI, VID', () => {
  assert.deepEqual(dot1qTag(10), [0x81, 0x00, 0x00, 0x0a]);
  assert.deepEqual(dot1qTag(4094, 7), [0x81, 0x00, 0xef, 0xfe]);
  assert.deepEqual(dot1qTag(1, 0, 1), [0x81, 0x00, 0x10, 0x01]);
  for (const bad of [0, 4095, -1, 1.5]) assert.throws(() => dot1qTag(bad), RangeError);
  assert.throws(() => dot1qTag(10, 8), RangeError);
});

test('routing between VLANs changes the tag and rewrites MACs, but keeps the IPs', () => {
  const hops = routeAtoB();
  assert.deepEqual(hops.map(h => h.tag), [null, 10, 20, null]);
  assert.equal(new Set(hops.map(h => h.srcIp)).size, 1);
  assert.equal(new Set(hops.map(h => h.dstIp)).size, 1);
  assert.notEqual(hops[1].srcMac, hops[2].srcMac);
  assert.notEqual(hops[1].dstMac, hops[2].dstMac);
});

test('the lab goals pass only for VLANs 10 and 20 carried over a trunk', () => {
  assert.deepEqual(labGoals(FLAT), { aToC: false, bToD: false });
  assert.deepEqual(labGoals(SPLIT), { aToC: true, bToD: true });
  const onlyTen = clone(SPLIT);
  onlyTen.link.allowed = [10];
  assert.deepEqual(labGoals(onlyTen), { aToC: true, bToD: false });
});
