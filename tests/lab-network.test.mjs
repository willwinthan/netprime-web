// Unit test (no Worker needed): switches, PCs/servers, static routes and multi-hop ping in the lab engine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSession, grade, validateSpec } from '../packages/lab-engine/src/index.ts';

let macSeq = 0;
const port = (n, extra = {}) => ({
  id: `gi${n}`, type: 'GigabitEthernet', number: n, mac: `0200.00aa.${(++macSeq).toString(16).padStart(4, '0')}`,
  mtu: 1500, bandwidthKbps: 1000000, adminUp: false, ipv4: null, ...extra
});
const up = n => port(n, { adminUp: true });
const link = (id, a, ai, b, bi) => ({ id, kind: 'ethernet', a: { device: a, interface: ai }, b: { device: b, interface: bi } });

/**
 *  pc1 ─┐                                   ┌─ pc2
 *       sw1 ── r1 ══ 10.0.12.0/30 ══ r2 ── sw2
 *  pc3 ─┘  192.168.1.0/24      192.168.2.0/24
 */
function topology(overrides = {}) {
  return {
    schemaVersion: 1, id: 'NET-001', version: '1.0.0', title: 'Two LANs', profile: 'generic-iosxe-like-v0',
    instructions: {
      summary: 'Connect two LANs through two routers.', scopeNote: 'Static routes only.',
      addressingPlan: [
        { device: 'pc1', interface: 'gi0', address: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' }
      ]
    },
    devices: [
      { id: 'pc1', kind: 'pc', hostname: 'PC1', layout: { x: 60, y: 100 }, interfaces: [port(0, { adminUp: true })] },
      { id: 'pc3', kind: 'pc', hostname: 'PC3', layout: { x: 60, y: 300 }, interfaces: [port(0, { adminUp: true })],
        gateway: '192.168.1.1' },
      { id: 'sw1', kind: 'switch', hostname: 'SW1', layout: { x: 200, y: 200 }, interfaces: [up(1), up(2), up(3)] },
      { id: 'r1', hostname: 'R1', layout: { x: 350, y: 200 }, interfaces: [port(1), port(2)] },
      { id: 'r2', kind: 'router', hostname: 'R2', layout: { x: 550, y: 200 }, interfaces: [port(1), port(2)] },
      { id: 'sw2', kind: 'switch', hostname: 'SW2', layout: { x: 700, y: 200 }, interfaces: [up(1), up(2)] },
      { id: 'pc2', kind: 'server', hostname: 'SRV1', layout: { x: 850, y: 200 },
        interfaces: [port(0, { adminUp: true, ipv4: { address: '192.168.2.10', mask: '255.255.255.0' } })], gateway: '192.168.2.1' }
    ],
    links: [
      link('l1', 'pc1', 'gi0', 'sw1', 'gi1'), link('l2', 'pc3', 'gi0', 'sw1', 'gi2'), link('l3', 'sw1', 'gi3', 'r1', 'gi1'),
      link('l4', 'r1', 'gi2', 'r2', 'gi1'), link('l5', 'r2', 'gi2', 'sw2', 'gi1'), link('l6', 'sw2', 'gi2', 'pc2', 'gi0')
    ],
    objectives: [
      { id: 'pc1_gw', check: 'defaultGatewayEquals', title: 'PC1 gateway', description: 'd', hints: [],
        params: { device: 'pc1', gateway: '192.168.1.1' } },
      { id: 'lan1', check: 'bidirectionalReachability', title: 'PC1 ↔ PC3', description: 'd', hints: [],
        params: { a: { device: 'pc1', address: '192.168.1.10' }, b: { device: 'pc3', address: '192.168.1.11' } } },
      { id: 'end_to_end', check: 'bidirectionalReachability', title: 'PC1 ↔ SRV1', description: 'd', hints: [],
        params: { a: { device: 'pc1', address: '192.168.1.10' }, b: { device: 'pc2', address: '192.168.2.10' } } }
    ],
    ...overrides
  };
}

const lines = (device, ...cmds) => [device, cmds.join('\r') + '\r'];
const router = (device, ifaces, routes = []) => lines(device, '', 'enable', 'configure terminal',
  ...ifaces.flatMap(([name, ip, mask = '255.255.255.0']) => [`interface ${name}`, `ip address ${ip} ${mask}`, 'no shutdown', 'exit']),
  ...routes.map(r => `ip route ${r}`), 'end');
const pcs = [lines('pc1', 'ipconfig 192.168.1.10 255.255.255.0 192.168.1.1'), lines('pc3', 'ipconfig 192.168.1.11 255.255.255.0')];
const r1 = (routes = ['192.168.2.0 255.255.255.0 10.0.12.2']) =>
  router('r1', [['gi1', '192.168.1.1'], ['gi2', '10.0.12.1', '255.255.255.252']], routes);
const r2 = (routes = ['0.0.0.0 0.0.0.0 10.0.12.1']) =>
  router('r2', [['gi1', '10.0.12.2', '255.255.255.252'], ['gi2', '192.168.2.1']], routes);

function labOf(spec) {
  const v = validateSpec(spec);
  assert.ok(v.ok, JSON.stringify(v.errors));
  return v.lab;
}
const byId = (result, id) => result.results.find(r => r.id === id);

/** Runs a live session and returns what one device's console printed. */
function consoleOf(lab, transcript, device) {
  const session = createSession(lab);
  let text = '';
  session.attachSink(device, t => { text += t; });
  for (const [d, keys] of transcript) session.input(d, keys);
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
}

test('device kinds validate with their own rules', () => {
  const lab = labOf(topology());
  const devices = lab.initialState.devices;
  assert.deepEqual(lab.initialState.deviceOrder.map(id => devices[id].kind), ['pc', 'pc', 'switch', 'router', 'router', 'switch', 'server']);
  assert.equal(devices.pc2.config.gateway, (192 << 24 >>> 0) + (168 << 16) + (2 << 8) + 1);
  assert.equal(devices.pc1.config.gateway, null);
  assert.deepEqual(devices.r1.config.routes, []);
  assert.equal(lab.instructions.addressingPlan[0].gateway, devices.pc2.config.gateway - 256);

  const broken = topology();
  broken.devices[2].interfaces[0].ipv4 = { address: '10.0.0.1', mask: '255.0.0.0' };
  broken.devices[0].interfaces.push(port(1));
  broken.devices[3].gateway = '192.168.1.254';
  broken.devices[5].routes = [];
  broken.devices[4].routes = [{ network: '10.0.0.1', mask: '255.0.0.0', nextHop: '10.0.12.1' }];
  broken.devices[1].kind = 'firewall';
  broken.instructions.addressingPlan.push({ device: 'r1', interface: 'gi1', address: '192.168.1.1', mask: '255.255.255.0', gateway: '1.1.1.1' });
  broken.objectives.push({ id: 'bad', check: 'defaultGatewayEquals', title: 't', description: 'd', hints: [], params: { device: 'r1', gateway: '1.1.1.1' } });
  broken.objectives.push({ id: 'bad2', check: 'interfaceIpv4Equals', title: 't', description: 'd', hints: [],
    params: { device: 'sw1', interface: 'gi1', address: '10.0.0.1', mask: '255.0.0.0' } });
  const v = validateSpec(broken);
  assert.equal(v.ok, false);
  const paths = v.errors.map(e => e.path);
  for (const path of ['$.devices[2].interfaces[0].ipv4', '$.devices[0].interfaces', '$.devices[3].gateway', '$.devices[5].routes',
    '$.devices[4].routes[0]', '$.devices[1].kind', '$.instructions.addressingPlan[1].gateway', '$.objectives[3].params.device',
    '$.objectives[4].params.device'])
    assert.ok(paths.includes(path), `${path} in ${JSON.stringify(v.errors)}`);
});

test('PCs on one switch reach each other once they have addresses; a shut switch port breaks it', () => {
  const lab = labOf(topology());
  assert.equal(byId(grade(lab, []), 'lan1').passed, false);
  const result = grade(lab, pcs);
  assert.equal(byId(result, 'lan1').passed, true, JSON.stringify(byId(result, 'lan1')));
  assert.equal(byId(result, 'pc1_gw').passed, true);

  const shut = grade(lab, [...pcs, lines('sw1', '', 'enable', 'configure terminal', 'interface gi2', 'shutdown', 'end')]);
  assert.equal(byId(shut, 'lan1').passed, false);
});

test('ping across two routers needs a route both ways', () => {
  const lab = labOf(topology());
  const connectedOnly = grade(lab, [...pcs, r1([]), r2([])]);
  const e2e = byId(connectedOnly, 'end_to_end');
  assert.equal(e2e.passed, false);
  assert.match(e2e.reasons[0], /R1 has no route to 192\.168\.2\.10/);

  const oneWay = byId(grade(lab, [...pcs, r1(), r2([])]), 'end_to_end');
  assert.equal(oneWay.passed, false);
  assert.match(oneWay.reasons[0], /reply from SRV1 cannot find a route back/);

  const full = grade(lab, [...pcs, r1(), r2()]);
  assert.equal(full.passed, true, JSON.stringify(full.results.filter(r => !r.passed)));

  const noGateway = grade(lab, [lines('pc1', 'ipconfig 192.168.1.10 255.255.255.0'), pcs[1], r1(), r2()]);
  assert.equal(byId(noGateway, 'end_to_end').passed, false);
  assert.match(byId(noGateway, 'end_to_end').reasons[0], /PC1 cannot reach/);
});

test('routing loops and non-routers as next hop fail with a reason', () => {
  const spec = topology();
  spec.objectives.push({ id: 'nowhere', check: 'bidirectionalReachability', title: 'R1 ↔ 172.16.0.10', description: 'd', hints: [],
    params: { a: { device: 'r1', address: '192.168.1.1' }, b: { device: 'pc2', address: '172.16.0.10' } } });
  const lab = labOf(spec);
  const loop = grade(lab, [...pcs, r1(['0.0.0.0 0.0.0.0 10.0.12.2']), r2(['0.0.0.0 0.0.0.0 10.0.12.1'])]);
  assert.equal(byId(loop, 'end_to_end').passed, true, 'default routes both ways still deliver to a real host');
  assert.match(byId(loop, 'nowhere').reasons[0], /R1 cannot reach 172\.16\.0\.10: the packet loops back to R1/);

  const viaPc = grade(lab, [...pcs, r1(['192.168.2.0 255.255.255.0 192.168.1.11']), r2()]);
  assert.match(byId(viaPc, 'end_to_end').reasons[0], /PC3 is not a router/);
});

test('router CLI: static routes, the default route and ip route typed in interface mode', () => {
  const lab = labOf(topology());
  const out = consoleOf(lab, [r2([]), r1([]), lines('r1', 'configure terminal', 'interface gi2',
    'ip route 192.168.2.0 255.255.255.0 10.0.12.2', 'ip route 0.0.0.0 0.0.0.0 10.0.12.2', 'ip route 10.9.9.1 255.255.255.0 10.0.12.2',
    'ip route 10.9.9.0 255.255.255.0 10.0.12.1', 'no ip route 172.16.0.0 255.255.0.0 10.0.12.2', 'end',
    'show ip route', 'show running-config')], 'r1');
  assert.match(out, /%Inconsistent address and mask/);
  assert.match(out, /%Invalid next hop address \(it's this router\)/);
  assert.match(out, /%No matching route to delete/);
  assert.match(out, /Gateway of last resort is 10\.0\.12\.2 to network 0\.0\.0\.0/);
  assert.match(out, /S\*    0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.12\.2/);
  assert.match(out, /\nS     192\.168\.2\.0\/24 \[1\/0\] via 10\.0\.12\.2\n/);
  assert.match(out, /\nip route 0\.0\.0\.0 0\.0\.0\.0 10\.0\.12\.2\nip route 192\.168\.2\.0 255\.255\.255\.0 10\.0\.12\.2\n!\nend/);

  const removed = grade(lab, [...pcs, r1(), r2(), lines('r1', 'configure terminal', 'no ip route 192.168.2.0 255.255.255.0 10.0.12.2', 'end')]);
  assert.equal(byId(removed, 'end_to_end').passed, false);
});

test('PC command prompt and switch CLI', () => {
  const lab = labOf(topology());
  const pc = consoleOf(lab, [...pcs, r1(), r2(), lines('pc1', 'ipconfig', 'ping 192.168.2.10', 'ping 192.168.9.9', 'ping nowhere', 'enable')], 'pc1');
  assert.match(pc, /^C:\\>/);
  assert.match(pc, /IPv4 Address\.+: 192\.168\.1\.10\n {3}Subnet Mask\.+: 255\.255\.255\.0\n {3}Default Gateway\.+: 192\.168\.1\.1/);
  assert.match(pc, /Reply from 192\.168\.2\.10: bytes=32 time<1ms TTL=126/);
  assert.match(pc, /Request timed out\.[\s\S]*Lost = 4 \(100% loss\)/);
  assert.match(pc, /Ping request could not find host nowhere/);
  assert.match(pc, /C:\\>enable\nInvalid Command\./);
  assert.doesNotMatch(pc, /%LINK/, 'PCs print no console log messages');

  const sw = consoleOf(lab, [lines('sw1', '', 'enable', 'show ip route', 'configure terminal', 'interface gi1', 'ip address 10.0.0.1 255.0.0.0',
    'shutdown', 'end', 'show running-config')], 'sw1');
  assert.match(sw, /SW1#show ip route\n% NetPrime: "show ip route" is recognized but not supported/);
  assert.match(sw, /Switch ports work at layer 2 only/);
  assert.match(sw, /interface GigabitEthernet1\n shutdown\n!/);
  assert.doesNotMatch(sw, /no ip address/);
});
