// Unit test (no Worker needed): labs built with the visual designer's edits are valid engine labs that can be passed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grade, validateSpec } from '../packages/lab-engine/src/index.ts';
import {
  addDevice, addPort, blankSpec, connect, edit, removeDevice, removePort, suggestedObjectives
} from '../frontend-admin/src/components/labs/labSpec.ts';

const configure = (device, iface, ip) =>
  [device, ['', 'enable', 'configure terminal', `interface ${iface}`, `ip address ${ip} 255.255.255.0`, 'no shutdown', 'end', ''].join('\r')];

/** Three routers in a line: R1 —— R2 —— R3, with a plan for both cables. */
function threeRouters() {
  let doc = blankSpec();
  for (const x of [150, 450, 750]) doc = addDevice(doc, 'router', x, 200).doc;
  doc = connect(doc, 'r1', 'r2').doc;
  doc = connect(doc, 'r2', 'r3').doc;
  return edit(doc, d => {
    d.instructions.addressingPlan = [
      { device: 'r1', interface: 'gi1', address: '10.0.12.1', mask: '255.255.255.0' },
      { device: 'r2', interface: 'gi1', address: '10.0.12.2', mask: '255.255.255.0' },
      { device: 'r2', interface: 'gi2', address: '10.0.23.2', mask: '255.255.255.0' },
      { device: 'r3', interface: 'gi1', address: '10.0.23.3', mask: '255.255.255.0' }
    ];
  });
}

test('designer edits build a valid lab whose generated objectives can be passed', () => {
  const doc = threeRouters();
  assert.deepEqual(doc.links.map(l => [l.a, l.b].map(e => `${e.device}/${e.interface}`)), [['r1/gi1', 'r2/gi1'], ['r2/gi2', 'r3/gi1']]);
  assert.equal(new Set(doc.devices.flatMap(d => d.interfaces.map(i => i.mac))).size, 6, 'every port gets its own MAC');

  const empty = validateSpec(doc);
  assert.equal(empty.ok, false, 'a lab needs objectives');
  const withObjectives = edit(doc, d => { d.objectives = suggestedObjectives(doc); });
  assert.equal(withObjectives.objectives.length, 4 + 2 + 2);
  const checked = validateSpec(withObjectives);
  assert.ok(checked.ok, JSON.stringify(checked.errors));

  const lab = checked.lab;
  assert.equal(grade(lab, []).passedCount, 0);
  const half = grade(lab, [configure('r1', 'gi1', '10.0.12.1'), configure('r2', 'gi1', '10.0.12.2')]);
  assert.equal(half.passed, false);
  const all = grade(lab, [configure('r1', 'gi1', '10.0.12.1'), configure('r2', 'gi1', '10.0.12.2'),
    configure('r2', 'gi2', '10.0.23.2'), configure('r3', 'gi1', '10.0.23.3')]);
  assert.equal(all.passed, true, JSON.stringify(all.results.filter(r => !r.passed)));
});

test('a device with every port cabled gets a new port; removing things cleans up what used them', () => {
  let doc = threeRouters();
  doc = edit(doc, d => { d.objectives = suggestedObjectives(doc); });
  const extra = connect(doc, 'r1', 'r3').doc;
  assert.deepEqual([extra.links[2].a, extra.links[2].b], [{ device: 'r1', interface: 'gi2' }, { device: 'r3', interface: 'gi2' }]);
  const busy = connect(extra, 'r1', 'r2').doc;
  assert.equal(busy.devices.find(d => d.id === 'r1').interfaces.length, 3, 'r1 had no free port, so gi3 was added');

  const noR3 = removeDevice(doc, 'r3');
  assert.equal(noR3.links.length, 1);
  assert.ok(!noR3.instructions.addressingPlan.some(r => r.device === 'r3'));
  assert.ok(validateSpec(noR3).ok, JSON.stringify(validateSpec(noR3).errors));

  const noPort = removePort(doc, 'r2', 'gi2');
  assert.equal(noPort.links.length, 1);
  assert.ok(validateSpec(noPort).ok, JSON.stringify(validateSpec(noPort).errors));
  assert.equal(addPort(noPort, 'r2').devices.find(d => d.id === 'r2').interfaces.at(-1).id, 'gi2');
});

test('a switched lab with PCs built on the board validates, and its generated objectives need routing to pass', () => {
  // PC1 ── SW1 ── R1 ── R2 ── SRV1
  let doc = blankSpec();
  for (const [kind, x] of [['pc', 100], ['switch', 250], ['router', 400], ['router', 600], ['server', 800]]) doc = addDevice(doc, kind, x, 200).doc;
  assert.deepEqual(doc.devices.map(d => [d.id, d.kind, d.interfaces.length, d.interfaces[0].adminUp]),
    [['pc1', 'pc', 1, true], ['sw1', 'switch', 8, true], ['r1', 'router', 2, false], ['r2', 'router', 2, false], ['srv1', 'server', 1, true]]);
  for (const [a, b] of [['pc1', 'sw1'], ['sw1', 'r1'], ['r1', 'r2'], ['r2', 'srv1']]) doc = connect(doc, a, b).doc;
  assert.match(connect(doc, 'pc1', 'r2').error, /PC1 มีพอร์ตเดียว/);
  assert.equal(addPort(doc, 'pc1'), doc, 'a PC keeps its single port');

  doc = edit(doc, d => {
    d.instructions.addressingPlan = [
      { device: 'pc1', interface: 'gi0', address: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' },
      { device: 'r1', interface: 'gi1', address: '192.168.1.1', mask: '255.255.255.0' },
      { device: 'r1', interface: 'gi2', address: '10.0.12.1', mask: '255.255.255.252' },
      { device: 'r2', interface: 'gi1', address: '10.0.12.2', mask: '255.255.255.252' },
      { device: 'r2', interface: 'gi2', address: '192.168.2.1', mask: '255.255.255.0' },
      { device: 'srv1', interface: 'gi0', address: '192.168.2.10', mask: '255.255.255.0', gateway: '192.168.2.1' }
    ];
  });
  doc = edit(doc, d => { d.objectives = suggestedObjectives(doc); });
  const ids = doc.objectives.map(o => o.id);
  for (const id of ['pc1_gateway', 'srv1_gateway', 'l2_up', 'l3_up', 'l4_up', 'l3_ping', 'pc1_srv1_ping']) assert.ok(ids.includes(id), `${id} in ${ids}`);
  assert.ok(!ids.includes('l1_up'), 'a cable whose ports start up and are not planned needs no objective');
  const checked = validateSpec(doc);
  assert.ok(checked.ok, JSON.stringify(checked.errors));

  const lines = (device, ...cmds) => [device, cmds.join('\r') + '\r'];
  const router = (device, a, b, route) => lines(device, '', 'enable', 'configure terminal', 'interface gi1', `ip address ${a}`, 'no shutdown',
    'interface gi2', `ip address ${b}`, 'no shutdown', 'exit', `ip route ${route}`, 'end');
  const work = [
    lines('pc1', 'ipconfig 192.168.1.10 255.255.255.0 192.168.1.1'), lines('srv1', 'ipconfig 192.168.2.10 255.255.255.0 192.168.2.1'),
    router('r1', '192.168.1.1 255.255.255.0', '10.0.12.1 255.255.255.252', '192.168.2.0 255.255.255.0 10.0.12.2')
  ];
  const partial = grade(checked.lab, work);
  assert.equal(partial.results.find(r => r.id === 'pc1_srv1_ping').passed, false, 'R2 is not configured yet');
  const all = grade(checked.lab, [...work, router('r2', '10.0.12.2 255.255.255.252', '192.168.2.1 255.255.255.0', '192.168.1.0 255.255.255.0 10.0.12.1')]);
  assert.equal(all.passed, true, JSON.stringify(all.results.filter(r => !r.passed)));
});
