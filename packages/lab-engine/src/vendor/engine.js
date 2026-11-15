// @ts-nocheck
/* eslint-disable */
/*
 * NetPrime Virtual Lab engine. NetPrime owns and maintains this file.
 *
 * Origin:  extracted from the teammate's Virtual Lab build (https://netprime-virtual-lab.netlify.app/,
 *          assets/index-EzznCY2z.js, Alpha v0.1.1, SHA-256 fc7801c4b5ce859f79617d3abe66fac1b334ab6bd133193365e3063dbf98e6b2,
 *          lines 14287-17422 after prettier 3.3.3). That code only simulated routers cabled back to back.
 * NetPrime additions (marked "NetPrime:" below, readable names):
 *          - device kinds: router, switch (one VLAN, layer 2 only), pc and server (one NIC, IP/mask/default gateway)
 *          - layer 2 segments through switches, longest-prefix routing, multi-hop ping with the return path checked
 *          - router static routes (ip route / no ip route), PC commands (ipconfig, ping), check defaultGatewayEquals
 * Rules:   pure code only (no DOM, timers, storage, network or Math.random); the clock is injected (createEnv).
 *          Grading replays keystrokes with this file, so bump ENGINE_VERSION in ../index.ts whenever behaviour changes.
 *          The minified names come from the original build; ../index.ts stays the only importer.
 */
function d(e) {
  let t = 0,
    n = 0,
    r = 0,
    i = 0;
  for (let a = 0; a < e.length; a++) {
    let o = e.charCodeAt(a);
    if (o >= 48 && o <= 57) {
      if ((r++, (n = n * 10 + (o - 48)), r > 3 || n > 255))
        return { ok: !1, errorIndex: a };
    } else if (o === 46) {
      if (r === 0 || i === 3) return { ok: !1, errorIndex: a };
      (t = t * 256 + n), (n = 0), (r = 0), i++;
    } else return { ok: !1, errorIndex: a };
  }
  return i !== 3 || r === 0
    ? { ok: !1, errorIndex: e.length }
    : ((t = t * 256 + n), { ok: !0, value: t >>> 0 });
}
function f(e) {
  if (e.length === 0) return !0;
  if (!/^[0-9.]+$/.test(e)) return !1;
  let t = e.split(`.`);
  return t.length > 4
    ? !1
    : t.every((e, n) =>
        e.length === 0
          ? n === t.length - 1 && n > 0
          : e.length <= 3 && Number(e) <= 255,
      );
}
function p(e) {
  let t = e >>> 0;
  return `${t >>> 24}.${(t >>> 16) & 255}.${(t >>> 8) & 255}.${t & 255}`;
}
function m(e) {
  return e <= 0 ? 0 : e >= 32 ? 4294967295 : (4294967295 << (32 - e)) >>> 0;
}
function h(e) {
  let t = e >>> 0,
    n = ~t >>> 0;
  if ((n & (n + 1)) >>> 0) return null;
  let r = 0;
  for (let e = 31; e >= 0 && (t >>> e) & 1; e--) r++;
  return r;
}
function g(e, t) {
  return (e & m(t)) >>> 0;
}
function _(e, t) {
  return (g(e, t) | (~m(t) >>> 0)) >>> 0;
}
function v(e, t, n) {
  return g(e, n) === g(t, n);
}
function y(e) {
  let t = (e >>> 24) & 255;
  return t === 0
    ? `zero-network`
    : t === 127
      ? `loopback`
      : t >= 224 && t <= 239
        ? `multicast`
        : t >= 240
          ? `reserved`
          : `ok`;
}
function b(e) {
  let t = (e >>> 24) & 255;
  return t < 128 ? 8 : t < 192 ? 16 : t < 224 ? 24 : null;
}
function ee(e) {
  return `0x` + (e >>> 0).toString(16).toUpperCase().padStart(8, `0`);
}
function x(e, t) {
  return Object.hasOwn(e, t) ? e[t] : void 0;
}
function te(e, t) {
  return Object.hasOwn(e, t);
}
function ne(e) {
  return e === `__proto__` || e in Object.prototype;
}
function S(e) {
  return `${e.type}${e.number}`;
}
function C(e, t) {
  return x(e.devices, t);
}
function w(e, t, n) {
  let r = C(e, t);
  return r ? x(r.config.interfaces, n) : void 0;
}
function re(e, t) {
  return C(e, t)?.config.hostname ?? t;
}
// NetPrime: device kinds. Labs saved before kinds existed only hold routers.
var DEVICE_KINDS = [`router`, `switch`, `pc`, `server`];
function kindOf(device) {
  return device?.kind ?? `router`;
}
/** Unicast host address (named so the validator's local `y` does not shadow it). */
function isUnicast(address) {
  return y(address) === `ok`;
}
function isHostKind(kind) {
  return kind === `pc` || kind === `server`;
}
function initialModeOf(lab, deviceId) {
  return isHostKind(kindOf(C(lab, deviceId))) ? `host` : `user-exec`;
}
/** Static routes a device starts from: router `ip route`s, or a PC's default gateway as 0.0.0.0/0. */
function staticRoutesOf(device) {
  let kind = kindOf(device);
  if (isHostKind(kind))
    return device.config.gateway == null
      ? []
      : [{ network: 0, prefixLength: 0, nextHop: device.config.gateway }];
  return kind === `router` ? (device.config.routes ?? []) : [];
}
/** Layer 2 segments: cabled interfaces that are up share a segment, and a switch joins all of its up ports. */
function computeSegments(lab, interfaces) {
  let parent = new Map(),
    key = (deviceId, interfaceId) => `${deviceId}/${interfaceId}`,
    find = (k) => {
      for (; parent.get(k) !== k; ) {
        parent.set(k, parent.get(parent.get(k)));
        k = parent.get(k);
      }
      return k;
    },
    union = (a, b) => {
      let ra = find(a),
        rb = find(b);
      ra !== rb && parent.set(ra, rb);
    };
  for (let deviceId of lab.deviceOrder)
    for (let [interfaceId, state] of Object.entries(x(interfaces, deviceId) ?? {}))
      state.status === `up` && parent.set(key(deviceId, interfaceId), key(deviceId, interfaceId));
  for (let link of lab.links) {
    let a = key(link.a.deviceId, link.a.interfaceId),
      b = key(link.b.deviceId, link.b.interfaceId);
    parent.has(a) && parent.has(b) && union(a, b);
  }
  for (let deviceId of lab.deviceOrder) {
    if (kindOf(C(lab, deviceId)) !== `switch`) continue;
    let ports = Object.keys(x(interfaces, deviceId) ?? {})
      .map((interfaceId) => key(deviceId, interfaceId))
      .filter((k) => parent.has(k));
    for (let k of ports.slice(1)) union(ports[0], k);
  }
  let segments = {};
  for (let k of parent.keys()) {
    let [deviceId, interfaceId] = k.split(`/`);
    (segments[deviceId] ??= {})[interfaceId] = find(k);
  }
  return segments;
}
var ie = new WeakMap();
function ae(e) {
  let t = ie.get(e);
  if (t) return t;
  let n = T(e);
  return ie.set(e, n), n;
}
function oe(e, t) {
  for (let n of e.links) {
    if (n.a.deviceId === t.deviceId && n.a.interfaceId === t.interfaceId)
      return { link: n, peer: n.b };
    if (n.b.deviceId === t.deviceId && n.b.interfaceId === t.interfaceId)
      return { link: n, peer: n.a };
  }
  return null;
}
function se(e, t) {
  return w(e, t.deviceId, t.interfaceId)?.adminUp ?? !1;
}
function T(e) {
  let t = {},
    n = {};
  for (let r of e.deviceOrder) {
    let i = C(e, r);
    if (!i) continue;
    let a = {},
      o = [];
    for (let t of i.inventory) {
      let n = x(i.config.interfaces, t.id);
      if (!n) continue;
      let s = oe(e, { deviceId: r, interfaceId: t.id }),
        c,
        l = null;
      n.adminUp
        ? s
          ? se(e, s.peer)
            ? (c = `up`)
            : ((c = `down`), (l = `peer-admin-down`))
          : ((c = `down`), (l = `no-link`))
        : ((c = `administratively down`), (l = `admin-down`));
      let u = c === `up` ? `up` : `down`;
      (a[t.id] = {
        deviceId: r,
        interfaceId: t.id,
        adminUp: n.adminUp,
        status: c,
        protocol: u,
        ipv4: n.ipv4,
        peer: s ? s.peer : null,
        linkId: s ? s.link.id : null,
        downReason: l,
      }),
        c === `up` &&
          u === `up` &&
          n.ipv4 &&
          (o.push({
            code: `C`,
            network: g(n.ipv4.address, n.ipv4.prefixLength),
            prefixLength: n.ipv4.prefixLength,
            interfaceId: t.id,
          }),
          o.push({
            code: `L`,
            network: n.ipv4.address,
            prefixLength: 32,
            interfaceId: t.id,
          }));
    }
    // NetPrime: a static route (or a PC's default gateway) is installed when its next hop is in a connected subnet.
    for (let route of staticRoutesOf(i)) {
      let via = o.find(
        (c) => c.code === `C` && v(route.nextHop, c.network, c.prefixLength),
      );
      via &&
        o.push({
          code: `S`,
          network: route.network,
          prefixLength: route.prefixLength,
          nextHop: route.nextHop,
          interfaceId: via.interfaceId,
        });
    }
    o.sort((e, t) => e.network - t.network || e.prefixLength - t.prefixLength),
      (t[r] = a),
      (n[r] = o);
  }
  let r = {};
  for (let t of e.links) {
    let n = [t.a, t.b].filter((t) => !se(e, t));
    r[t.id] = { id: t.id, operUp: n.length === 0, adminDownEndpoints: n };
  }
  return { interfaces: t, links: r, routes: n, segments: computeSegments(e, t) };
}
function ce(e, t, n) {
  let r = x(e.interfaces, t);
  return r ? x(r, n) : void 0;
}
function le(e, t) {
  return x(e.routes, t) ?? [];
}
function ue(e, t) {
  return x(e.links, t);
}
var de = (e) => ({ ok: !0, value: e }),
  fe = (e) => ({ ok: !1, error: e });
function pe(e, t) {
  let n = h(t);
  return n === null
    ? fe({ code: `BAD_MASK`, address: e, mask: t, reason: `non-contiguous` })
    : y(e) === `ok`
      ? n === 0
        ? fe({ code: `BAD_MASK`, address: e, mask: t, reason: `zero` })
        : n > 30
          ? fe({ code: `PREFIX_NOT_SUPPORTED`, address: e, prefixLength: n })
          : e === g(e, n)
            ? fe({ code: `BAD_MASK`, address: e, mask: t, reason: `network` })
            : e === _(e, n)
              ? fe({
                  code: `BAD_MASK`,
                  address: e,
                  mask: t,
                  reason: `broadcast`,
                })
              : de({ address: e, prefixLength: n })
      : fe({ code: `NOT_HOST_ADDRESS`, address: e });
}
function me(e) {
  return e.length === 0
    ? fe({ code: `HOSTNAME_INVALID`, hostname: e, reason: `empty` })
    : e.length > 63
      ? fe({ code: `HOSTNAME_INVALID`, hostname: e, reason: `length` })
      : /^[A-Za-z0-9-]+$/.test(e)
        ? /^[A-Za-z]/.test(e)
          ? /[A-Za-z0-9]$/.test(e)
            ? de(e)
            : fe({ code: `HOSTNAME_INVALID`, hostname: e, reason: `end` })
          : fe({ code: `HOSTNAME_INVALID`, hostname: e, reason: `start` })
        : fe({ code: `HOSTNAME_INVALID`, hostname: e, reason: `chars` });
}
function he(e, t) {
  let n = [];
  for (let r of e.deviceOrder) {
    let i = C(e, r);
    if (i) {
      for (let e of Object.values(i.config.interfaces))
        if (e.ipv4 && e.ipv4.address === t) {
          n.push(r);
          break;
        }
    }
  }
  return n;
}
// NetPrime: packet walk. Each hop picks the longest matching route, finds the next hop's interface on the same
// layer 2 segment (through switches), and only routers forward. A ping also needs the reply to find its way back.
var MAX_HOPS = 16;
function ownsUpAddress(t, deviceId, address) {
  return Object.values(x(t.interfaces, deviceId) ?? {}).some(
    (i) => i.status === `up` && i.ipv4?.address === address,
  );
}
function lookupRoute(t, deviceId, address) {
  let best = null;
  for (let route of le(t, deviceId))
    route.code !== `L` &&
      v(address, route.network, route.prefixLength) &&
      (!best || route.prefixLength > best.prefixLength) &&
      (best = route);
  return best;
}
function neighborOnSegment(e, t, deviceId, interfaceId, address) {
  let segment = x(t.segments, deviceId)?.[interfaceId];
  if (segment === void 0) return null;
  for (let other of e.deviceOrder) {
    if (kindOf(C(e, other)) === `switch`) continue;
    for (let [otherIf, state] of Object.entries(x(t.interfaces, other) ?? {}))
      if (
        !(other === deviceId && otherIf === interfaceId) &&
        state.status === `up` &&
        state.ipv4?.address === address &&
        x(t.segments, other)?.[otherIf] === segment
      )
        return { deviceId: other, interfaceId: otherIf };
  }
  return null;
}
function walkPacket(e, t, n, r) {
  let current = n,
    visited = new Set([n]),
    first = null;
  for (let hop = 1; hop <= MAX_HOPS; hop++) {
    let route = lookupRoute(t, current, r);
    if (!route)
      return current === n
        ? { kind: `failure`, reason: `no-route` }
        : { kind: `failure`, reason: `no-route-hop`, at: current };
    let egress = ce(t, current, route.interfaceId),
      own = egress?.ipv4?.address;
    if (current === n && own !== void 0) {
      let owners = he(e, own);
      if (owners.length > 1)
        return {
          kind: `failure`,
          reason: `duplicate-address`,
          duplicates: owners,
          duplicateAddress: own,
          egress: route.interfaceId,
        };
    }
    if (!egress || !egress.peer)
      return current === n
        ? { kind: `failure`, reason: `no-link`, egress: route.interfaceId }
        : { kind: `failure`, reason: `no-route-hop`, at: current };
    let nextHop = route.code === `S` ? route.nextHop : r,
      neighbor = neighborOnSegment(e, t, current, route.interfaceId, nextHop);
    current === n &&
      (first = {
        egress: route.interfaceId,
        peer: neighbor ?? egress.peer,
        source: own,
      });
    if (!neighbor)
      return route.code === `S`
        ? { kind: `failure`, reason: `no-next-hop`, at: current, nextHop, ...first }
        : current === n
          ? { kind: `failure`, reason: `no-host`, ...first }
          : { kind: `failure`, reason: `no-host-hop`, at: current };
    if (nextHop === r || ownsUpAddress(t, neighbor.deviceId, r))
      return { kind: `success`, ...first, last: neighbor.deviceId, hops: hop };
    if (kindOf(C(e, neighbor.deviceId)) !== `router`)
      return { kind: `failure`, reason: `not-a-router`, at: neighbor.deviceId };
    if (visited.has(neighbor.deviceId))
      return { kind: `failure`, reason: `loop`, at: neighbor.deviceId };
    visited.add(neighbor.deviceId);
    current = neighbor.deviceId;
  }
  return { kind: `failure`, reason: `loop`, at: current };
}
function ge(e, t, n, r) {
  let i = he(e, r);
  if (i.includes(n) && i.length === 1) return { kind: `self` };
  if (i.length > 1)
    return {
      kind: `failure`,
      reason: `duplicate-address`,
      duplicates: i,
      duplicateAddress: r,
    };
  let there = walkPacket(e, t, n, r);
  if (there.kind !== `success` || there.source === void 0) return there;
  let back = walkPacket(e, t, there.last, there.source);
  return back.kind === `success`
    ? { ...there, returnHops: back.hops }
    : {
        kind: `failure`,
        reason: `no-return-route`,
        egress: there.egress,
        peer: there.peer,
        from: there.last,
      };
}
var _e = (e) => typeof e == `object` && !!e && !Array.isArray(e);
function ve(e, t, n, r) {
  if (!_e(e)) return r.push(`${t} must be an object`), null;
  for (let i of Object.keys(e))
    n.includes(i) || r.push(`${t}.${i} is not a recognised field`);
  for (let i of n) Object.hasOwn(e, i) || r.push(`${t}.${i} is required`);
  return e;
}
function ye(e, t, n, r) {
  let i = e.device;
  return typeof i != `string` || !n.hasDevice(i)
    ? (r.push(`${t}.device must reference an existing device`), null)
    : i;
}
function be(e, t, n, r, i) {
  let a = e.interface;
  return typeof a != `string` || n === null || !r.hasInterface(n, a)
    ? (i.push(
        `${t}.interface must reference an existing interface of that device`,
      ),
      null)
    : a;
}
function xe(e, t, n, r) {
  let i = e[t],
    a = typeof i == `string` ? d(i) : null;
  return a?.ok
    ? a.value
    : (r.push(`${n}.${t} must be a dotted-quad IPv4 value`), null);
}
function Se(e, t, n) {
  let r = C(e, t)?.inventory.find((e) => e.id === n);
  return `${re(e, t)} ${r ? S(r) : n}`;
}
var Ce = {
    parseParams(e, t) {
      let n = [],
        r = ve(e, `params`, [`device`, `interface`, `address`, `mask`], n);
      if (!r) return { ok: !1, errors: n };
      let i = ye(r, `params`, t, n),
        a = be(r, `params`, i, t, n),
        o = xe(r, `address`, `params`, n),
        s = xe(r, `mask`, `params`, n),
        c = null;
      i !== null &&
        t.deviceKind(i) === `switch` &&
        n.push(`params.device is a switch; switch ports have no IPv4 address in this lab`);
      if (o !== null && s !== null) {
        let e = pe(o, s);
        e.ok
          ? (c = e.value.prefixLength)
          : n.push(
              `params address/mask is not a valid interface address (${e.error.code})`,
            );
      }
      return n.length || i === null || a === null || o === null || c === null
        ? { ok: !1, errors: n }
        : {
            ok: !0,
            params: {
              deviceId: i,
              interfaceId: a,
              address: o,
              prefixLength: c,
            },
          };
    },
    run(e, t, n) {
      let r = w(e, n.deviceId, n.interfaceId),
        i = Se(e, n.deviceId, n.interfaceId),
        a = `${p(n.address)} ${p(m(n.prefixLength))}`;
      return r?.ipv4
        ? r.ipv4.address === n.address && r.ipv4.prefixLength === n.prefixLength
          ? { passed: !0, reasons: [`${i} is ${a}.`] }
          : {
              passed: !1,
              reasons: [
                `${i} is ${`${p(r.ipv4.address)} ${p(m(r.ipv4.prefixLength))}`}; expected ${a}.`,
              ],
            }
        : { passed: !1, reasons: [`${i} has no IPv4 address; expected ${a}.`] };
    },
  },
  we = {
    parseParams(e, t) {
      let n = [],
        r = ve(e, `params`, [`endpoints`], n);
      if (!r) return { ok: !1, errors: n };
      let i = r.endpoints;
      if (!Array.isArray(i) || i.length === 0)
        return (
          n.push(`params.endpoints must be a non-empty array`),
          { ok: !1, errors: n }
        );
      let a = [];
      return (
        i.forEach((e, r) => {
          let i = `params.endpoints[${r}]`,
            o = ve(e, i, [`device`, `interface`], n);
          if (!o) return;
          let s = ye(o, i, t, n),
            c = be(o, i, s, t, n);
          s !== null && c !== null && a.push({ deviceId: s, interfaceId: c });
        }),
        n.length ? { ok: !1, errors: n } : { ok: !0, params: { endpoints: a } }
      );
    },
    run(e, t, n) {
      let r = [],
        i = !0;
      for (let a of n.endpoints) {
        let n = ce(t, a.deviceId, a.interfaceId),
          o = Se(e, a.deviceId, a.interfaceId);
        n
          ? n.status === `up` && n.protocol === `up`
            ? r.push(`${o} is up/up.`)
            : ((i = !1),
              n.downReason === `admin-down`
                ? r.push(`${o} is administratively down (shutdown).`)
                : n.downReason === `peer-admin-down` && n.peer
                  ? r.push(
                      `${o} is down because its link peer ${Se(e, n.peer.deviceId, n.peer.interfaceId)} is administratively down.`,
                    )
                  : r.push(`${o} is down (no link).`))
          : ((i = !1), r.push(`${o} does not exist.`));
      }
      return { passed: i, reasons: r };
    },
  };
function E(e, t, n, r) {
  let i = re(e, t),
    a = p(n);
  switch (r.kind) {
    case `success`:
      return `${i} can reach ${a}.`;
    case `self`:
      return `${a} is configured on ${i} itself, so it is not a remote address.`;
    case `failure`:
      switch (r.reason) {
        case `duplicate-address`: {
          let t = (r.duplicates ?? []).map((t) => re(e, t)).join(` and `);
          return `${i} cannot reach ${a}: duplicate address ${p(r.duplicateAddress ?? n)} is configured on ${t}.`;
        }
        case `no-route`:
          return `${i} cannot reach ${a}: no connected route covers ${a} (the interface is down, unaddressed, or in a different subnet).`;
        case `no-link`:
          return `${i} cannot reach ${a}: the egress interface has no link.`;
        case `no-host`:
          return `${i} cannot reach ${a}: no interface on the connected segment owns ${a}.`;
        case `no-return-route`:
          return r.from && r.peer && r.from !== r.peer.deviceId
            ? `${i} cannot reach ${a}: the reply from ${re(e, r.from)} cannot find a route back to ${i}.`
            : `${i} cannot reach ${a}: the far end has no connected route back to ${i} (subnet mask mismatch).`;
        case `no-route-hop`:
          return `${i} cannot reach ${a}: ${re(e, r.at)} has no route to ${a}.`;
        case `no-host-hop`:
          return `${i} cannot reach ${a}: no interface on the segment connected to ${re(e, r.at)} owns ${a}.`;
        case `no-next-hop`:
          return `${i} cannot reach ${a}: next hop ${p(r.nextHop)} used by ${re(e, r.at)} is not on its connected segment.`;
        case `not-a-router`:
          return `${i} cannot reach ${a}: ${re(e, r.at)} is not a router, so it does not forward packets.`;
        case `loop`:
          return `${i} cannot reach ${a}: the packet loops back to ${re(e, r.at)} (routing loop).`;
      }
  }
}
var D = {
    interfaceIpv4Equals: Ce,
    interfacesOperUp: we,
    bidirectionalReachability: {
      parseParams(e, t) {
        let n = [],
          r = ve(e, `params`, [`a`, `b`], n);
        if (!r) return { ok: !1, errors: n };
        let i = (e) => {
            let i = `params.${e}`,
              a = ve(r[e], i, [`device`, `address`], n);
            if (!a) return null;
            let o = ye(a, i, t, n),
              s = xe(a, `address`, i, n);
            return (
              s !== null &&
                y(s) !== `ok` &&
                n.push(`${i}.address is not a unicast host address`),
              o !== null && s !== null ? { deviceId: o, address: s } : null
            );
          },
          a = i(`a`),
          o = i(`b`);
        return (
          a &&
            o &&
            a.deviceId === o.deviceId &&
            n.push(`params.a and params.b must reference different devices`),
          a &&
            o &&
            a.address === o.address &&
            n.push(`params.a and params.b must use different addresses`),
          n.length || !a || !o
            ? { ok: !1, errors: n }
            : { ok: !0, params: { a, b: o } }
        );
      },
      run(e, t, n) {
        let r = ge(e, t, n.a.deviceId, n.b.address),
          i = ge(e, t, n.b.deviceId, n.a.address);
        return {
          passed: r.kind === `success` && i.kind === `success`,
          reasons: [
            E(e, n.a.deviceId, n.b.address, r),
            E(e, n.b.deviceId, n.a.address, i),
          ],
        };
      },
    },
    // NetPrime: a PC or server has the expected default gateway.
    defaultGatewayEquals: {
      parseParams(e, t) {
        let n = [],
          r = ve(e, `params`, [`device`, `gateway`], n);
        if (!r) return { ok: !1, errors: n };
        let i = ye(r, `params`, t, n),
          a = xe(r, `gateway`, `params`, n);
        i !== null &&
          !isHostKind(t.deviceKind(i)) &&
          n.push(`params.device must be a PC or server`);
        a !== null &&
          !isUnicast(a) &&
          n.push(`params.gateway is not a unicast host address`);
        return n.length || i === null || a === null
          ? { ok: !1, errors: n }
          : { ok: !0, params: { deviceId: i, gateway: a } };
      },
      run(e, t, n) {
        let r = C(e, n.deviceId)?.config.gateway ?? null,
          i = re(e, n.deviceId);
        return r === n.gateway
          ? { passed: !0, reasons: [`${i} uses default gateway ${p(r)}.`] }
          : {
              passed: !1,
              reasons: [
                r === null
                  ? `${i} has no default gateway; expected ${p(n.gateway)}.`
                  : `${i} uses default gateway ${p(r)}; expected ${p(n.gateway)}.`,
              ],
            };
      },
    },
  },
  Te = new WeakMap();
function Ee(e, t) {
  let n = Te.get(e),
    r = n?.get(t);
  if (r) return r;
  let i = ae(e),
    a = t.map((t) => {
      let n = x(D, t.checkId);
      if (!n) throw Error(`Unknown check ${t.checkId}`);
      let r = n.run(e, i, t.params);
      return { id: t.id, title: t.title, passed: r.passed, reasons: r.reasons };
    }),
    o = {
      results: a,
      passedCount: a.filter((e) => e.passed).length,
      total: a.length,
    };
  return n || ((n = new WeakMap()), Te.set(e, n)), n.set(t, o), o;
}
function De(e, t) {
  let n = e;
  for (let e of t) {
    let t = Oe(n, e);
    if (!t.ok) return t;
    n = t.value;
  }
  return de(n);
}
function Oe(e, t) {
  let n = C(e, t.deviceId);
  if (!n) return fe({ code: `UNKNOWN_DEVICE`, deviceId: t.deviceId });
  if (t.op === `setHostname`) {
    let r = me(t.hostname);
    return r.ok
      ? n.config.hostname === t.hostname
        ? de(e)
        : de(ke(e, { ...n, config: { ...n.config, hostname: t.hostname } }))
      : r;
  }
  // NetPrime: default gateway (PCs, servers) and static routes (routers).
  if (t.op === `setGateway`)
    return n.config.gateway === t.gateway
      ? de(e)
      : de(ke(e, { ...n, config: { ...n.config, gateway: t.gateway } }));
  if (t.op === `addStaticRoute` || t.op === `removeStaticRoute`) {
    let routes = n.config.routes ?? [],
      same = (r) =>
        r.network === t.route.network &&
        r.prefixLength === t.route.prefixLength &&
        r.nextHop === t.route.nextHop;
    if (t.op === `addStaticRoute`) {
      if (routes.some(same)) return de(e);
      routes = [...routes, t.route].sort(
        (a, b) =>
          a.network - b.network ||
          a.prefixLength - b.prefixLength ||
          a.nextHop - b.nextHop,
      );
    } else {
      if (!routes.some(same)) return fe({ code: `ROUTE_NOT_FOUND` });
      routes = routes.filter((r) => !same(r));
    }
    return de(ke(e, { ...n, config: { ...n.config, routes } }));
  }
  let r = x(n.config.interfaces, t.interfaceId);
  if (!r)
    return fe({
      code: `UNKNOWN_INTERFACE`,
      deviceId: t.deviceId,
      interfaceId: t.interfaceId,
    });
  let i;
  switch (t.op) {
    case `setInterfaceIpv4`: {
      let n = pe(t.address, m(t.prefixLength));
      if (!n.ok) return n;
      if (
        r.ipv4 &&
        r.ipv4.address === t.address &&
        r.ipv4.prefixLength === t.prefixLength
      )
        return de(e);
      i = { ...r, ipv4: { address: t.address, prefixLength: t.prefixLength } };
      break;
    }
    case `clearInterfaceIpv4`:
      if (r.ipv4 === null) return de(e);
      i = { ...r, ipv4: null };
      break;
    case `setInterfaceAdmin`:
      if (r.adminUp === t.up) return de(e);
      i = { ...r, adminUp: t.up };
  }
  return de(
    ke(e, {
      ...n,
      config: {
        ...n.config,
        interfaces: { ...n.config.interfaces, [t.interfaceId]: i },
      },
    }),
  );
}
function ke(e, t) {
  return { ...e, devices: { ...e.devices, [t.id]: t } };
}
function Ae(e, t, n) {
  let r = [];
  for (let i of e.deviceOrder) {
    let a = C(e, i);
    if (a)
      for (let e of a.inventory) {
        let a = ce(t, i, e.id),
          o = ce(n, i, e.id);
        a &&
          o &&
          (a.status !== o.status &&
            r.push({
              deviceId: i,
              kind: `link`,
              interfaceId: e.id,
              state: o.status,
            }),
          a.protocol !== o.protocol &&
            r.push({
              deviceId: i,
              kind: `lineproto`,
              interfaceId: e.id,
              state: o.protocol,
            }));
      }
  }
  return r;
}
function je(e) {
  let t = new Set(e.device.inventory.map((e) => e.type.toLowerCase()));
  return e.profile.interfaceTypes.filter(
    (e) => e.support.kind === `unsupported` || t.has(e.name.toLowerCase()),
  );
}
function Me(e, t) {
  let n = e.toLowerCase(),
    r = je(t),
    i = r.find((e) => e.name.toLowerCase() === n);
  if (i) return { kind: `one`, entry: i };
  let a = r.filter((e) => e.name.toLowerCase().startsWith(n));
  return a.length === 1 && a[0]
    ? { kind: `one`, entry: a[0] }
    : a.length > 1
      ? { kind: `ambiguous`, entries: a }
      : { kind: `none` };
}
function Ne(e) {
  let t = /^([A-Za-z][A-Za-z-]*)(.*)$/.exec(e);
  return t ? { type: t[1] ?? ``, rest: t[2] ?? `` } : null;
}
function Pe(e, t) {
  return t.device.inventory
    .filter((t) => t.type.toLowerCase() === e.toLowerCase())
    .map((e) => e.number)
    .sort((e, t) => e - t);
}
function Fe(e, t) {
  let n = Pe(e, t),
    r = [],
    i,
    a;
  for (let e of n)
    i === void 0 || a === void 0
      ? (i = e)
      : e !== a + 1 && (r.push(`<${i}-${a}>`), (i = e)),
      (a = e);
  return i !== void 0 && a !== void 0 && r.push(`<${i}-${a}>`), r;
}
function Ie(e, t, n) {
  if (!/^\d+$/.test(t)) return null;
  let r = Number.parseInt(t, 10);
  return (
    n.device.inventory.find(
      (t) => t.type.toLowerCase() === e.toLowerCase() && t.number === r,
    ) ?? null
  );
}
function Le() {
  return {
    match(e, t, n) {
      let r = e[t];
      if (!r) return { ok: !1, kind: `incomplete`, consumed: 0 };
      let i = Ne(r.text);
      if (!i) return { ok: !1, kind: `invalid`, offset: r.start };
      let a = Me(i.type, n);
      if (a.kind === `none`)
        return { ok: !1, kind: `invalid`, offset: r.start };
      if (a.kind === `ambiguous`) return { ok: !1, kind: `ambiguous` };
      let o = a.entry;
      if (o.support.kind === `unsupported`)
        return {
          ok: !1,
          kind: `unsupported`,
          label: o.name,
          reason: o.support.reason,
        };
      let s, c, l;
      if (i.rest !== ``) (s = i.rest), (c = r.start + i.type.length), (l = 1);
      else {
        let n = e[t + 1];
        if (!n) return { ok: !1, kind: `incomplete`, consumed: 1 };
        (s = n.text), (c = n.start), (l = 2);
      }
      let u = Ie(o.name, s, n);
      if (!u) {
        let e = s.search(/\D/);
        return { ok: !1, kind: `invalid`, offset: c + (e > 0 ? e : 0) };
      }
      return { ok: !0, value: { interfaceId: u.id, name: S(u) }, consumed: l };
    },
    syntaxHelp(e) {
      return je(e).map((t) => ({
        label: t.name,
        help:
          t.help +
          (t.support.kind === `unsupported`
            ? e.profile.behaviour.unsupportedHelpSuffix
            : ``),
      }));
    },
    continuationHelp(e, t) {
      let n = e[0],
        r = n ? Ne(n.text) : null,
        i = r ? Me(r.type, t) : { kind: `none` };
      if (i.kind !== `one`) return [];
      let a = `${i.entry.name} ${x(t.profile.help, `param.ifaceNumber`) ?? `interface number`}`;
      return Fe(i.entry.name, t).map((e) => ({ label: e, help: a }));
    },
    wordHelp(e, t, n) {
      if (e.length === 0) {
        let e = Ne(t);
        if (!e) return [];
        if (e.rest === ``) {
          let t = e.type.toLowerCase();
          return je(n)
            .filter((e) => e.name.toLowerCase().startsWith(t))
            .map((e) => e.name);
        }
        let r = Me(e.type, n);
        return r.kind !== `one` || r.entry.support.kind === `unsupported`
          ? []
          : Pe(r.entry.name, n)
              .filter((t) => String(t).startsWith(e.rest))
              .map((e) => `${r.entry.name}${e}`);
      }
      let r = e[0],
        i = r ? Ne(r.text) : null,
        a = i ? Me(i.type, n) : { kind: `none` };
      return a.kind !== `one` || !/^\d*$/.test(t)
        ? []
        : Pe(a.entry.name, n).some((e) => String(e).startsWith(t))
          ? Fe(a.entry.name, n)
          : [];
    },
    complete(e, t, n) {
      if (e.length !== 0) return [];
      let r = Ne(t);
      if (!r) return [];
      if (r.rest === ``) {
        let e = Me(r.type, n);
        return e.kind === `one`
          ? [e.entry.name]
          : e.kind === `ambiguous`
            ? e.entries.map((e) => e.name)
            : [];
      }
      let i = Me(r.type, n);
      if (i.kind !== `one` || i.entry.support.kind === `unsupported`) return [];
      let a = Ie(i.entry.name, r.rest, n);
      return a ? [`${S(a)} `] : [];
    },
  };
}
function Re(e, t) {
  return {
    match(e, t) {
      let n = e[t];
      if (!n) return { ok: !1, kind: `incomplete`, consumed: 0 };
      let r = d(n.text);
      return r.ok
        ? { ok: !0, value: r.value, consumed: 1 }
        : {
            ok: !1,
            kind: `invalid`,
            offset:
              n.start + Math.min(r.errorIndex, Math.max(0, n.text.length - 1)),
          };
    },
    syntaxHelp: () => [{ label: e, help: t }],
    wordHelp: (t, n) => (f(n) ? [e] : []),
  };
}
function ze(e, t) {
  return {
    match(e, t) {
      let n = e[t];
      return n
        ? { ok: !0, value: n.text, consumed: 1 }
        : { ok: !1, kind: `incomplete`, consumed: 0 };
    },
    syntaxHelp: () => [{ label: e, help: t }],
    wordHelp: () => [e],
  };
}
function Be(e) {
  return {
    match(e, t) {
      let n = e[t];
      if (!n) return { ok: !1, kind: `incomplete`, consumed: 0 };
      let r = d(n.text);
      return {
        ok: !0,
        value: { text: n.text, address: r.ok ? r.value : null },
        consumed: 1,
      };
    },
    syntaxHelp: () => [{ label: `WORD`, help: e }],
    wordHelp: () => [`WORD`],
  };
}
var Ve = [`user-exec`, `priv-exec`, `global-config`, `interface-config`],
  He = (e) => e === `global-config` || e === `interface-config`,
  Ue = { kind: `supported` },
  O = {
    enable: `exec.enable`,
    disable: `exec.disable`,
    exitExec: `session.exit`,
    configureTerminal: `exec.configureTerminal`,
    ping: `exec.ping`,
    showIpInterfaceBrief: `show.ipInterfaceBrief`,
    showIpRoute: `show.ipRoute`,
    showInterfaces: `show.interfaces`,
    showRunningConfig: `show.runningConfig`,
    hostname: `config.hostname`,
    interface: `config.interface`,
    exit: `nav.exit`,
    end: `nav.end`,
    ipAddress: `if.ipAddress`,
    noIpAddress: `if.noIpAddress`,
    shutdown: `if.shutdown`,
    noShutdown: `if.noShutdown`,
    ipRoute: `config.ipRoute`,
    noIpRoute: `config.noIpRoute`,
    hostIpconfig: `host.ipconfig`,
    hostIpconfigSet: `host.ipconfigSet`,
    hostPing: `host.ping`,
  },
  We = (e) => ({ kind: `command`, id: e }),
  Ge = (e) => ({ kind: `unsupported`, reason: e });
function Ke(e) {
  let t = e.filter((e) => e.kind === `param`),
    n = e
      .filter((e) => e.kind === `keyword`)
      .sort((e, t) => e.word.localeCompare(t.word));
  return [...t, ...n];
}
function qe(e, kind = `router`) {
  let t = (t) => {
      let n = x(e.help, t);
      if (n === void 0)
        throw Error(`Profile ${e.id} has no help text for "${t}"`);
      return n;
    },
    n = (e, n, r = {}) => ({
      kind: `keyword`,
      word: e,
      help: t(n),
      support: Ue,
      ...(r.exec ? { exec: r.exec } : {}),
      children: Ke(r.children ?? []),
    }),
    r = (e, t, n = {}) => ({
      kind: `param`,
      name: e,
      matcher: t,
      support: n.support ?? Ue,
      ...(n.exec ? { exec: n.exec } : {}),
      children: Ke(n.children ?? []),
    }),
    i = (e) => ({
      kind: `keyword`,
      word: e.word,
      help: e.help,
      support: { kind: `unsupported`, reason: e.reason },
      children: [],
    }),
    a = Le(),
    o = e.knownUnsupported,
    s = n(`ip`, `show.ip`, {
      children: [
        n(`interface`, `show.ip.interface`, {
          exec: Ge(
            `The detailed per-interface IP view is not modeled; use "show ip interface brief".`,
          ),
          children: [
            n(`brief`, `show.ip.interface.brief`, {
              exec: We(O.showIpInterfaceBrief),
            }),
          ],
        }),
        kind === `switch`
          ? i({
              word: `route`,
              help: t(`show.ip.route`),
              reason: `This switch works at layer 2 only, so it has no routing table.`,
            })
          : n(`route`, `show.ip.route`, { exec: We(O.showIpRoute) }),
      ],
    }),
    c = n(`interfaces`, `show.interfaces`, {
      exec: We(O.showInterfaces),
      children: [r(`interface`, a, { exec: We(O.showInterfaces) })],
    }),
    l = n(`running-config`, `show.running-config`, {
      exec: We(O.showRunningConfig),
    }),
    u = n(`show`, `show`, { children: [s, ...o.showUser.map(i)] }),
    d = n(`show`, `show`, { children: [c, s, l, ...o.showPriv.map(i)] }),
    f = n(`ping`, `ping`, {
      exec: Ge(
        `Extended (interactive) ping is not modeled; use "ping A.B.C.D".`,
      ),
      children: [
        r(`target`, Be(t(`param.pingTarget`)), {
          exec: We(O.ping),
          children: o.pingOptions.map(i),
        }),
      ],
    }),
    p = Ke([
      n(`enable`, `enable`, { exec: We(O.enable) }),
      n(`exit`, `exit.exec`, { exec: We(O.exitExec) }),
      f,
      u,
      ...o.exec.map(i),
    ]),
    m = Ke([
      n(`configure`, `configure`, {
        exec: Ge(
          `The interactive configuration-source prompt is not modeled; use "configure terminal".`,
        ),
        children: [
          n(`terminal`, `configure.terminal`, {
            exec: We(O.configureTerminal),
          }),
        ],
      }),
      n(`disable`, `disable`, { exec: We(O.disable) }),
      n(`enable`, `enable`, { exec: We(O.enable) }),
      n(`exit`, `exit.exec`, { exec: We(O.exitExec) }),
      f,
      d,
      ...o.exec.map(i),
      ...o.privExec.map(i),
    ]),
    h = n(`do`, `do`, { children: [f, d] }),
    g = Ke([
      h,
      n(`end`, `end`, { exec: We(O.end) }),
      n(`exit`, `exit.config`, { exec: We(O.exit) }),
      n(`hostname`, `hostname`, {
        children: [
          r(`hostname`, ze(`WORD`, t(`param.hostname`)), {
            exec: We(O.hostname),
          }),
        ],
      }),
      n(`interface`, `interface`, {
        children: [r(`interface`, a, { exec: We(O.interface) })],
      }),
      ...o.globalConfig.map(i),
    ]),
    _ = Re(`A.B.C.D`, t(`param.address`)),
    v = Re(`A.B.C.D`, t(`param.mask`));
  // NetPrime: PCs and servers have one command prompt mode.
  if (isHostKind(kind)) {
    let gw = Re(`A.B.C.D`, t(`param.gateway`));
    return {
      host: Ke([
        n(`ipconfig`, `host.ipconfig`, {
          exec: We(O.hostIpconfig),
          children: [
            r(`address`, Re(`A.B.C.D`, t(`param.address`)), {
              children: [
                r(`mask`, Re(`A.B.C.D`, t(`param.mask`)), {
                  exec: We(O.hostIpconfigSet),
                  children: [r(`gateway`, gw, { exec: We(O.hostIpconfigSet) })],
                }),
              ],
            }),
          ],
        }),
        n(`ping`, `host.ping`, {
          children: [r(`target`, Be(t(`param.pingTarget`)), { exec: We(O.hostPing) })],
        }),
      ]),
    };
  }
  // NetPrime: routers get real static routes; a switch keeps "ip" and "no" as known-but-unsupported.
  if (kind === `router`) {
    let route = (id) =>
      n(`route`, `ip.route`, {
        children: [
          r(`prefix`, Re(`A.B.C.D`, t(`param.prefix`)), {
            children: [
              r(`prefixMask`, Re(`A.B.C.D`, t(`param.prefixMask`)), {
                children: [r(`nextHop`, Re(`A.B.C.D`, t(`param.nextHop`)), { exec: We(id) })],
              }),
            ],
          }),
        ],
      });
    g = Ke([
      ...g.filter((node) => !(node.kind === `keyword` && (node.word === `ip` || node.word === `no`) && node.support.kind === `unsupported`)),
      n(`ip`, `ip.global`, { children: [route(O.ipRoute)] }),
      n(`no`, `no`, { children: [n(`ip`, `ip.global`, { children: [route(O.noIpRoute)] })] }),
    ]);
  }
  let switchIp = i({
    word: `ip`,
    help: t(`ip.interface`),
    reason: `Switch ports work at layer 2 only; IP addresses go on routers, PCs and servers in this lab.`,
  });
  return {
    "user-exec": p,
    "priv-exec": m,
    "global-config": g,
    "interface-config": kind === `switch` ? Ke([
      h,
      n(`end`, `end`, { exec: We(O.end) }),
      n(`exit`, `exit.interface`, { exec: We(O.exit) }),
      switchIp,
      n(`no`, `no`, {
        children: [switchIp, n(`shutdown`, `shutdown`, { exec: We(O.noShutdown) })],
      }),
      n(`shutdown`, `shutdown`, { exec: We(O.shutdown) }),
      ...o.interfaceConfig.map(i),
    ]) : Ke([
      h,
      n(`end`, `end`, { exec: We(O.end) }),
      n(`exit`, `exit.interface`, { exec: We(O.exit) }),
      n(`ip`, `ip.interface`, {
        children: [
          n(`address`, `ip.address`, {
            children: [
              r(`address`, _, {
                children: [r(`mask`, v, { exec: We(O.ipAddress) })],
              }),
            ],
          }),
        ],
      }),
      n(`no`, `no`, {
        children: [
          n(`ip`, `ip.interface`, {
            children: [
              n(`address`, `ip.address`, {
                exec: We(O.noIpAddress),
                children: [
                  r(`address`, _, {
                    support: {
                      kind: `unsupported`,
                      reason: `Removing a specific address is not modeled; use "no ip address".`,
                    },
                  }),
                ],
              }),
            ],
          }),
          n(`shutdown`, `shutdown`, { exec: We(O.noShutdown) }),
        ],
      }),
      n(`shutdown`, `shutdown`, { exec: We(O.shutdown) }),
      ...o.interfaceConfig.map(i),
    ]),
  };
}
var Je = new WeakMap();
function Ye(e, kind = `router`) {
  let t = Je.get(e);
  t || ((t = {}), Je.set(e, t));
  return t[kind] ?? (t[kind] = qe(e, kind));
}
function grammarFor(builder, deviceId) {
  return Ye(builder.env.profile, kindOf(C(builder.lab, deviceId)));
}
var Xe = (e, t) => (e.length >= t ? `${e} ` : e.padEnd(t));
function Ze(e) {
  let t = Math.max(0, ...e.map((e) => e.label.length));
  return e.map((e) =>
    (e.help ? `  ${e.label.padEnd(t)}  ${e.help}` : `  ${e.label}`).trimEnd(),
  );
}
function Qe(e, t) {
  let n = [],
    r = ``;
  for (let i of e) {
    let e = `${i}  `;
    r.length > 0 &&
      r.length + e.length > Math.max(20, t) &&
      (n.push(r.trimEnd()), (r = ``)),
      (r += e);
  }
  return r && n.push(r.trimEnd()), n;
}
function $e(e, t, n, r) {
  let i = C(e, n);
  if (!i) return [];
  let [a, o, s, c, l] = r.formats.ipIntBriefColumns,
    u = [
      `${Xe(`Interface`, a)}${Xe(`IP-Address`, o)}${Xe(`OK?`, s)}${Xe(`Method`, c)}${Xe(`Status`, l)}Protocol`,
    ];
  for (let e of i.inventory) {
    let r = ce(t, n, e.id);
    if (!r) continue;
    let i = r.ipv4 ? p(r.ipv4.address) : `unassigned`,
      d = r.ipv4 ? `manual` : `unset`;
    u.push(
      `${Xe(S(e), a)}${Xe(i, o)}${Xe(`YES`, s)}${Xe(d, c)}${Xe(r.status, l)}${r.protocol}`,
    );
  }
  return u;
}
function et(e, t, n) {
  let r = C(e, t)?.inventory.find((e) => e.id === n);
  return r ? S(r) : n;
}
function tt(e, t, n, r) {
  let a = le(t, n),
    defaultRoute = a.find((t) => t.code === `S` && t.prefixLength === 0),
    i = [
      ...r.formats.routeLegend,
      ``,
      defaultRoute
        ? `Gateway of last resort is ${p(defaultRoute.nextHop)} to network 0.0.0.0`
        : `Gateway of last resort is not set`,
      ``,
    ],
    o = [],
    s = new Map(),
    code = (t) => (t.code === `S` && t.prefixLength === 0 ? `S*` : t.code),
    tail = (t) =>
      t.code === `S`
        ? `[1/0] via ${p(t.nextHop)}`
        : `is directly connected, ${et(e, n, t.interfaceId)}`,
    c = (t) => `${code(t).padEnd(6)}${p(t.network)}/${t.prefixLength} ${tail(t)}`;
  for (let e of a) {
    let t = b(e.network);
    if (t === null || e.prefixLength < t) {
      o.push({ sortKey: e.network, lines: [c(e)] });
      continue;
    }
    let n = g(e.network, t),
      r = s.get(n) ?? { major: n, classful: t, routes: [] };
    r.routes.push(e), s.set(n, r);
  }
  for (let t of s.values()) {
    let r = t.routes[0];
    if (t.routes.length === 1 && r && r.prefixLength === t.classful) {
      o.push({ sortKey: t.major, lines: [c(r)] });
      continue;
    }
    let i = new Set(t.routes.map((e) => e.prefixLength)),
      a = t.routes.length,
      s = [];
    if (i.size === 1) {
      let r = [...i][0] ?? t.classful;
      s.push(`      ${p(t.major)}/${r} is subnetted, ${a} subnets`);
      for (let r of t.routes)
        s.push(`${code(r).padEnd(9)}${p(r.network)} ${tail(r)}`);
    } else {
      s.push(
        `      ${p(t.major)}/${t.classful} is variably subnetted, ${a} subnets, ${i.size} masks`,
      );
      for (let r of t.routes)
        s.push(`${code(r).padEnd(9)}${p(r.network)}/${r.prefixLength} ${tail(r)}`);
    }
    o.push({ sortKey: t.major, lines: s });
  }
  o.sort((e, t) => e.sortKey - t.sortKey);
  for (let e of o) i.push(...e.lines);
  return i;
}
function nt(e, t) {
  let n = C(e, t);
  if (!n) return [];
  let r = [`!`, `hostname ${n.config.hostname}`, `!`];
  for (let e of n.inventory) {
    let t = x(n.config.interfaces, e.id);
    t &&
      (r.push(`interface ${S(e)}`),
      kindOf(n) === `switch` ||
        r.push(
          t.ipv4
            ? ` ip address ${p(t.ipv4.address)} ${p(m(t.ipv4.prefixLength))}`
            : ` no ip address`,
        ),
      t.adminUp || r.push(` shutdown`),
      r.push(`!`));
  }
  let routes = kindOf(n) === `router` ? (n.config.routes ?? []) : [];
  for (let route of routes)
    r.push(`ip route ${p(route.network)} ${p(m(route.prefixLength))} ${p(route.nextHop)}`);
  routes.length && r.push(`!`);
  return (
    r.push(`end`),
    [
      `Building configuration...`,
      ``,
      `Current configuration : ${
        r.join(`
`).length + 1
      } bytes`,
      ...r,
      ``,
    ]
  );
}
function rt(e, t, n, r, i) {
  let a = C(e, n);
  if (!a) return [];
  let o = [];
  for (let e of a.inventory) {
    if (i && e.id !== i) continue;
    let a = ce(t, n, e.id);
    a &&
      (o.push(`${S(e)} is ${a.status}, line protocol is ${a.protocol}`),
      o.push(
        `  Hardware is ${r.formats.hardwareDescription}, address is ${e.mac} (bia ${e.mac})`,
      ),
      a.ipv4 &&
        o.push(
          `  Internet address is ${p(a.ipv4.address)}/${a.ipv4.prefixLength}`,
        ),
      o.push(`  MTU ${e.mtu} bytes, BW ${e.bandwidthKbps} Kbit/sec`),
      o.push(`  ${r.formats.encapsulation}`),
      o.push(r.messages.interfacesNotModeled));
  }
  return o;
}
function it(e, t, n) {
  if (t === `unrecognized-host`) return [n.messages.unrecognizedHost];
  if (t.kind === `self`) return [n.messages.selfPing(e)];
  let r = n.formats.ping,
    i = t.kind === `success`,
    a = [
      `Type escape sequence to abort.`,
      `Sending ${r.count}, ${r.size}-byte ICMP Echos to ${e}, timeout is ${r.timeoutSec} seconds:`,
      (i ? `!` : `.`).repeat(r.count),
    ],
    [o, s, c] = r.rttMs;
  return [
    ...a,
    i
      ? `Success rate is 100 percent (${r.count}/${r.count}), round-trip min/avg/max = ${o}/${s}/${c} ms`
      : `Success rate is 0 percent (0/${r.count})`,
  ];
}
var at = (e) => {
    if (!e.interfaceId)
      throw Error(
        `interface configuration command executed without an interface context`,
      );
    return e.interfaceId;
  },
  ot = {
    [O.enable]: () => ({ mode: `priv-exec` }),
    [O.disable]: () => ({ mode: `user-exec` }),
    [O.exitExec]: () => ({ endSession: !0 }),
    [O.configureTerminal]: (e) => ({
      output: [e.profile.messages.configBanner],
      mode: `global-config`,
      interfaceId: null,
    }),
    [O.exit]: (e) =>
      e.mode === `interface-config`
        ? { mode: `global-config`, interfaceId: null }
        : { mode: `priv-exec`, interfaceId: null },
    [O.end]: () => ({ mode: `priv-exec`, interfaceId: null }),
    [O.hostname]: (e) => ({
      ops: [
        {
          op: `setHostname`,
          deviceId: e.deviceId,
          hostname: String(e.args.hostname),
        },
      ],
    }),
    [O.interface]: (e) => ({
      mode: `interface-config`,
      interfaceId: e.args.interface.interfaceId,
    }),
    [O.ipAddress]: (e) => {
      let t = at(e),
        n = e.args.address,
        r = e.args.mask,
        i = pe(n, r);
      if (!i.ok) return { engineError: i.error };
      let a = h(r) ?? 0;
      return {
        ops: [
          {
            op: `setInterfaceIpv4`,
            deviceId: e.deviceId,
            interfaceId: t,
            address: n,
            prefixLength: a,
          },
        ],
      };
    },
    [O.noIpAddress]: (e) => ({
      ops: [
        { op: `clearInterfaceIpv4`, deviceId: e.deviceId, interfaceId: at(e) },
      ],
    }),
    [O.shutdown]: (e) => ({
      ops: [
        {
          op: `setInterfaceAdmin`,
          deviceId: e.deviceId,
          interfaceId: at(e),
          up: !1,
        },
      ],
    }),
    [O.noShutdown]: (e) => ({
      ops: [
        {
          op: `setInterfaceAdmin`,
          deviceId: e.deviceId,
          interfaceId: at(e),
          up: !0,
        },
      ],
    }),
    [O.ping]: (e) => {
      let t = e.args.target;
      if (t.address === null)
        return { output: it(t.text, `unrecognized-host`, e.profile) };
      let n = ge(e.lab, e.derived, e.deviceId, t.address);
      return { output: it(p(t.address), n, e.profile) };
    },
    [O.ipRoute]: (e) => {
      let route = parseStaticRoute(e.args);
      if (!route.ok) return { engineError: route.error };
      let device = C(e.lab, e.deviceId);
      return Object.values(device?.config.interfaces ?? {}).some(
        (i) => i.ipv4?.address === route.value.nextHop,
      )
        ? { engineError: { code: `ROUTE_NEXTHOP_SELF` } }
        : {
            ops: [
              { op: `addStaticRoute`, deviceId: e.deviceId, route: route.value },
            ],
          };
    },
    [O.noIpRoute]: (e) => {
      let route = parseStaticRoute(e.args);
      return route.ok
        ? {
            ops: [
              { op: `removeStaticRoute`, deviceId: e.deviceId, route: route.value },
            ],
          }
        : { engineError: route.error };
    },
    [O.hostIpconfig]: (e) => ({ output: hostIpconfigLines(e.lab, e.deviceId) }),
    [O.hostIpconfigSet]: (e) => {
      let device = C(e.lab, e.deviceId),
        nic = device?.inventory[0],
        address = pe(e.args.address, e.args.mask);
      if (!nic) return { engineError: { code: `UNKNOWN_INTERFACE` } };
      if (!address.ok) return { engineError: address.error };
      let gateway = e.args.gateway;
      if (gateway !== void 0 && !isUnicast(gateway))
        return { engineError: { code: `BAD_GATEWAY`, address: gateway } };
      let ops = [
        {
          op: `setInterfaceIpv4`,
          deviceId: e.deviceId,
          interfaceId: nic.id,
          address: address.value.address,
          prefixLength: address.value.prefixLength,
        },
      ];
      gateway !== void 0 &&
        ops.push({ op: `setGateway`, deviceId: e.deviceId, gateway });
      return { ops };
    },
    [O.hostPing]: (e) => {
      let target = e.args.target;
      if (target.address === null)
        return {
          output: [
            `Ping request could not find host ${target.text}. Please check the name and try again.`,
          ],
        };
      return {
        output: hostPingLines(
          e.lab,
          p(target.address),
          ge(e.lab, e.derived, e.deviceId, target.address),
        ),
      };
    },
    [O.showIpInterfaceBrief]: (e) => ({
      output: $e(e.lab, e.derived, e.deviceId, e.profile),
    }),
    [O.showIpRoute]: (e) => ({
      output: tt(e.lab, e.derived, e.deviceId, e.profile),
    }),
    [O.showRunningConfig]: (e) => ({ output: nt(e.lab, e.deviceId) }),
    [O.showInterfaces]: (e) => {
      let t = e.args.interface;
      return {
        output: rt(e.lab, e.derived, e.deviceId, e.profile, t?.interfaceId),
      };
    },
  };
// NetPrime: static route arguments, checked the way IOS does before the route is stored.
function parseStaticRoute(args) {
  let prefixLength = h(args.prefixMask);
  if (prefixLength === null || g(args.prefix, prefixLength) !== args.prefix)
    return fe({ code: `ROUTE_INCONSISTENT` });
  if (!isUnicast(args.nextHop)) return fe({ code: `ROUTE_BAD_NEXTHOP` });
  return de({ network: args.prefix, prefixLength, nextHop: args.nextHop });
}
// NetPrime: PC / server command prompt output (Windows-style, as in Packet Tracer).
function hostIpconfigLines(lab, deviceId) {
  let device = C(lab, deviceId),
    nic = device?.inventory[0];
  if (!nic) return [];
  let state = x(device.config.interfaces, nic.id),
    gateway = device.config.gateway;
  return [
    ``,
    `${S(nic)} Connection:(default port)`,
    ``,
    `   IPv4 Address....................: ${state?.ipv4 ? p(state.ipv4.address) : `0.0.0.0`}`,
    `   Subnet Mask.....................: ${state?.ipv4 ? p(m(state.ipv4.prefixLength)) : `0.0.0.0`}`,
    `   Default Gateway.................: ${gateway == null ? `0.0.0.0` : p(gateway)}`,
    ``,
  ];
}
function hostPingLines(lab, target, result) {
  let ok = result.kind === `success` || result.kind === `self`,
    ttl =
      result.kind === `success`
        ? Math.max(1, (isHostKind(kindOf(C(lab, result.last))) ? 128 : 255) - ((result.returnHops ?? 1) - 1))
        : 128,
    lines = [``, `Pinging ${target} with 32 bytes of data:`, ``];
  for (let k = 0; k < 4; k++)
    lines.push(ok ? `Reply from ${target}: bytes=32 time<1ms TTL=${ttl}` : `Request timed out.`);
  lines.push(
    ``,
    `Ping statistics for ${target}:`,
    ok
      ? `    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),`
      : `    Packets: Sent = 4, Received = 0, Lost = 4 (100% loss),`,
  );
  ok &&
    lines.push(
      `Approximate round trip times in milli-seconds:`,
      `    Minimum = 0ms, Maximum = 0ms, Average = 0ms`,
    );
  lines.push(``);
  return lines;
}
function st(e) {
  let t = [],
    n = /[^ \t]+/g,
    r;
  for (; (r = n.exec(e)) !== null; )
    t.push({ text: r[0], start: r.index, end: r.index + r[0].length });
  return t;
}
function ct(e, t, n, r) {
  let i = t[n];
  if (!i) return { kind: `invalid`, offset: 0 };
  let a = i.text.toLowerCase(),
    o = e.filter((e) => e.kind === `keyword`),
    s = o.find((e) => e.word.toLowerCase() === a);
  if (s) return { kind: `keyword`, node: s };
  let c = o.filter((e) => e.word.toLowerCase().startsWith(a));
  if (c.length === 1 && c[0]) return { kind: `keyword`, node: c[0] };
  if (c.length > 1) return { kind: `ambiguous` };
  let l = i.start;
  for (let i of e) {
    if (i.kind !== `param`) continue;
    let e = i.matcher.match(t, n, r);
    if (e.ok)
      return { kind: `param`, node: i, value: e.value, consumed: e.consumed };
    switch (e.kind) {
      case `incomplete`:
        return { kind: `incomplete-param`, node: i, consumed: e.consumed };
      case `ambiguous`:
        return { kind: `ambiguous` };
      case `unsupported`:
        return { kind: `unsupported-param`, label: e.label, reason: e.reason };
      case `invalid`:
        l = Math.max(l, e.offset);
    }
  }
  return { kind: `invalid`, offset: l };
}
function lt(e, t) {
  let n = e.filter((e) => e.kind === `keyword`).map((e) => e.word);
  return t && n.push(t), n.join(` `);
}
function ut(e, t) {
  for (let n of e) if (t >= n.start && t < n.end) return n.start;
  let n = e[e.length - 1];
  return n && t >= n.end ? n.start : t;
}
function dt(e, t, n) {
  let r = t,
    i = null,
    a = [],
    o = {},
    s = 0;
  for (; s < e.length; ) {
    let t = ct(r, e, s, n);
    switch (t.kind) {
      case `keyword`:
        if ((a.push(t.node), t.node.support.kind === `unsupported`))
          return {
            kind: `error`,
            error: {
              kind: `unsupported`,
              path: lt(a),
              reason: t.node.support.reason,
            },
            tokenIndex: s,
          };
        (i = t.node), (r = t.node.children), (s += 1);
        break;
      case `param`:
        if ((a.push(t.node), t.node.support.kind === `unsupported`))
          return {
            kind: `error`,
            error: {
              kind: `unsupported`,
              path: lt(a, `<arguments>`),
              reason: t.node.support.reason,
            },
            tokenIndex: s,
          };
        (o[t.node.name] = t.value),
          (i = t.node),
          (r = t.node.children),
          (s += t.consumed);
        break;
      case `incomplete-param`:
        return {
          kind: `inside-param`,
          param: t.node,
          prior: e.slice(s),
          path: a,
          args: o,
        };
      case `ambiguous`:
        return { kind: `error`, error: { kind: `ambiguous` }, tokenIndex: s };
      case `unsupported-param`:
        return {
          kind: `error`,
          error: {
            kind: `unsupported`,
            path: lt(a, t.label),
            reason: t.reason,
          },
          tokenIndex: s,
        };
      case `invalid`:
        return {
          kind: `error`,
          error: {
            kind: `invalid`,
            offset: t.offset,
            tokenStart: ut(e, t.offset),
          },
          tokenIndex: s,
        };
    }
  }
  return { kind: `node`, node: i, children: r, path: a, args: o };
}
var ft = { "interface-config": `global-config` };
function pt(e, t, n, r) {
  let i = n[t];
  if (e.length > 0) {
    let a = ft[t];
    if (
      a &&
      ct(i, e, 0, r).kind === `invalid` &&
      ct(n[a], e, 0, r).kind !== `invalid`
    )
      return { mode: a, viaParent: !0, walk: dt(e, n[a], r) };
  }
  let walk = dt(e, i, r),
    parentMode = ft[t];
  // NetPrime: a global command whose first word also exists in interface mode (ip route, no ip route).
  if (e.length > 0 && walk.kind === `error` && parentMode) {
    let parentWalk = dt(e, n[parentMode], r);
    if (parentWalk.kind !== `error`)
      return { mode: parentMode, viaParent: !0, walk: parentWalk };
  }
  return { mode: t, viaParent: !1, walk };
}
function mt(e, t, n) {
  let r = n(t[e]);
  if (r.length > 0) return r;
  let i = ft[e];
  return i ? n(t[i]) : [];
}
function ht(e, t, n, r) {
  let i = n.toLowerCase(),
    a = e.filter((e) => e.kind === `keyword`),
    o = a.find((e) => e.word.toLowerCase() === i);
  if (o) return [`${o.word} `];
  let s = a
    .filter((e) => e.word.toLowerCase().startsWith(i))
    .map((e) => `${e.word} `);
  for (let i of e)
    i.kind === `param` &&
      i.matcher.complete &&
      s.push(...i.matcher.complete(t, n, r));
  return [...new Set(s)];
}
function gt(e, t, n, r, i) {
  if (t !== e.length || e.length === 0 || /[ \t]$/.test(e))
    return { kind: `none` };
  let a = st(e),
    o = a[a.length - 1];
  if (!o) return { kind: `none` };
  let s = a.slice(0, -1),
    c;
  if (s.length === 0) c = mt(n, r, (e) => ht(e, [], o.text, i));
  else {
    let e = pt(s, n, r, i).walk;
    if (e.kind === `error`) return { kind: `none` };
    c =
      e.kind === `inside-param`
        ? (e.param.matcher.complete?.(e.prior, o.text, i) ?? [])
        : ht(e.children, [], o.text, i);
  }
  if (c.length !== 1 || c[0] === void 0) return { kind: `none` };
  let l = e.slice(0, o.start) + c[0];
  return l === e
    ? { kind: `none` }
    : { kind: `completed`, line: l, cursor: l.length };
}
function _t(e, t, n) {
  let r = t.toLowerCase(),
    i = [];
  for (let a of e)
    a.kind === `keyword`
      ? a.word.toLowerCase().startsWith(r) && i.push(a.word)
      : i.push(...a.matcher.wordHelp([], t, n));
  return [...new Set(i)];
}
function vt(e, t, n) {
  let r = n.profile.behaviour.unsupportedHelpSuffix,
    i = [];
  for (let e of t)
    if (e.kind === `keyword`)
      i.push({
        label: e.word,
        help: e.help + (e.support.kind === `unsupported` ? r : ``),
      });
    else
      for (let t of e.matcher.syntaxHelp(n))
        i.push(
          e.support.kind === `unsupported`
            ? { label: t.label, help: t.help + r }
            : t,
        );
  return (
    e?.exec?.kind === `command` &&
      i.push({ label: n.profile.behaviour.crLabel, help: `` }),
    i
  );
}
function yt(e, t, n, r) {
  let i = e.length > 0 && !/[ \t]$/.test(e),
    a = st(e),
    o = i ? a[a.length - 1] : void 0,
    s = i ? a.slice(0, -1) : a,
    c = o?.text ?? ``;
  if (s.length === 0) {
    if (i) {
      let e = mt(t, n, (e) => _t(e, c, r));
      return e.length ? { kind: `word`, words: e } : { kind: `unrecognized` };
    }
    return { kind: `syntax`, entries: vt(null, n[t], r) };
  }
  let l = pt(s, t, n, r).walk;
  if (l.kind === `error`) return { kind: `error`, error: l.error };
  if (l.kind === `inside-param`) {
    if (i) {
      let e = l.param.matcher.wordHelp(l.prior, c, r);
      return e.length ? { kind: `word`, words: e } : { kind: `unrecognized` };
    }
    let e = l.param.matcher.continuationHelp?.(l.prior, r) ?? [];
    return e.length
      ? { kind: `syntax`, entries: e }
      : { kind: `error`, error: { kind: `incomplete` } };
  }
  if (i) {
    let e = _t(l.children, c, r);
    return e.length ? { kind: `word`, words: e } : { kind: `unrecognized` };
  }
  return { kind: `syntax`, entries: vt(l.node, l.children, r) };
}
var bt = (e) => e === `user-exec` || e === `priv-exec`;
function xt(e, t, n, r) {
  let i = st(e);
  if (i.length === 0) return { kind: `empty` };
  let a = pt(i, t, n, r),
    o = a.walk;
  switch (o.kind) {
    case `error`: {
      let e = i[0];
      return o.error.kind === `invalid` &&
        o.tokenIndex === 0 &&
        i.length === 1 &&
        e &&
        bt(t) &&
        r.profile.behaviour.unknownExecWordMessage
        ? { kind: `error`, error: { kind: `unknown-exec-word`, word: e.text } }
        : { kind: `error`, error: o.error };
    }
    case `inside-param`:
      return { kind: `error`, error: { kind: `incomplete` } };
    case `node`: {
      let e = o.node;
      return !e || !e.exec
        ? { kind: `error`, error: { kind: `incomplete` } }
        : e.exec.kind === `unsupported`
          ? {
              kind: `error`,
              error: {
                kind: `unsupported`,
                path: lt(o.path),
                reason: e.exec.reason,
              },
            }
          : {
              kind: `command`,
              commandId: e.exec.id,
              args: o.args,
              path: o.path,
              resolvedMode: a.mode,
              viaParent: a.viaParent,
            };
    }
  }
}
function St(e, t, n, r) {
  let i = r.messages;
  switch (e.kind) {
    case `invalid`: {
      let t = r.behaviour.caretPolicy === `precise` ? e.offset : e.tokenStart;
      return [`${` `.repeat(n + t)}^`, i.invalidInput, ``];
    }
    case `incomplete`:
      return [i.incomplete, ``];
    case `ambiguous`:
      return [i.ambiguous(t.trim()), ``];
    case `unsupported`:
      return [i.unsupported(e.path, e.reason)];
    case `unknown-exec-word`:
      return [i.unknownExecWord];
  }
}
var Ct = {
  empty: `a hostname is required`,
  length: `at most 63 characters are allowed`,
  chars: `only letters, digits and hyphens are allowed`,
  start: `it must start with a letter`,
  end: `it must end with a letter or digit`,
};
function wt(e, t) {
  let n = t.messages;
  switch (e.code) {
    case `BAD_MASK`:
      return e.reason === `non-contiguous` || e.reason === `zero`
        ? [n.badMaskHex(p(e.address), ee(e.mask))]
        : [n.badMaskPrefix(p(e.address), Tt(e.mask))];
    case `NOT_HOST_ADDRESS`:
      return [n.notHostAddress(p(e.address))];
    case `PREFIX_NOT_SUPPORTED`:
      return [n.prefixNotSupported(e.prefixLength)];
    case `HOSTNAME_INVALID`:
      return [n.hostnameInvalid(e.hostname, Ct[e.reason] ?? e.reason)];
    case `ROUTE_INCONSISTENT`:
      return [`%Inconsistent address and mask`];
    case `ROUTE_BAD_NEXTHOP`:
      return [`%Invalid next hop address`];
    case `ROUTE_NEXTHOP_SELF`:
      return [`%Invalid next hop address (it's this router)`];
    case `ROUTE_NOT_FOUND`:
      return [`%No matching route to delete`];
    case `BAD_GATEWAY`:
      return [n.badGateway(p(e.address))];
    default:
      return [`% NetPrime: internal error (${e.code}).`];
  }
}
function Tt(e) {
  let t = 0;
  for (let n = 31; n >= 0 && ((e >>> n) & 1) == 1; n--) t++;
  return t;
}
var Et = `\x1B[`;
`${Et}`;
var Dt = `\x1Bc\x1B[3J`;
function Ot(e, t) {
  let n = Math.floor(e / t);
  return (n > 0 ? `${Et}${n}A` : ``) + `\r`;
}
function kt(e, t, n) {
  let r = Math.floor(e / n),
    i = Math.floor(t / n),
    a = t % n,
    o = ``;
  return (
    i < r ? (o += `${Et}${r - i}A`) : i > r && (o += `${Et}${i - r}B`),
    (o += `\r`),
    a > 0 && (o += `${Et}${a}C`),
    o
  );
}
function At(e, t) {
  return e > 0 && e % t === 0 ? ` \b` : ``;
}
function jt(e, t, n) {
  let r = e.length + t.buffer.length,
    i = e.length + t.cursor;
  return `\x1B[J` + e + t.buffer + At(r, n) + (i === r ? `` : kt(r, i, n));
}
function Mt(e, t, n, r) {
  return Ot(e, r) + jt(t, n, r);
}
function Nt(e, t, n, r = ``) {
  let i = e.length + t.buffer.length,
    a = e.length + t.cursor,
    o = a === i ? `` : kt(a, i, n);
  o += r;
  let s = i + r.length,
    c = s > 0 && s % n === 0;
  return (
    r.length > 0 && c && (o += ` \b`),
    o +
      (c
        ? `\r`
        : `\r
`)
  );
}
var Pt = { pending: ``, lastWasCR: !1 },
  Ft = {
    "": `A`,
    "": `B`,
    "": `C`,
    "": `D`,
    "": `E`,
    "": `F`,
    "\v": `K`,
    "": `N`,
    "": `P`,
    "": `U`,
    "": `W`,
    "": `Z`,
  };
function It(e, t) {
  if (e === `` || e === `1`)
    switch (t) {
      case `A`:
        return { k: `up` };
      case `B`:
        return { k: `down` };
      case `C`:
        return { k: `right` };
      case `D`:
        return { k: `left` };
      case `H`:
        return { k: `home` };
      case `F`:
        return { k: `end` };
    }
  if (t === `~`)
    switch (e) {
      case `1`:
      case `7`:
        return { k: `home` };
      case `4`:
      case `8`:
        return { k: `end` };
      case `3`:
        return { k: `delete` };
    }
  return null;
}
function Lt(e, t) {
  let n = e.pending + t,
    r = [],
    i = e.lastWasCR,
    a = ``,
    o = () => {
      a &&= (r.push({ k: `insert`, text: a }), ``);
    },
    s = 0;
  for (; s < n.length; ) {
    let e = n[s],
      t = e.charCodeAt(0);
    if (e === `\x1B`) {
      o();
      let e = n[s + 1];
      if (e === void 0)
        return { state: { pending: n.slice(s), lastWasCR: !1 }, actions: r };
      if (e === `[`) {
        let e = s + 2;
        for (; e < n.length && /[0-9;?]/.test(n[e]); ) e++;
        if (e >= n.length)
          return { state: { pending: n.slice(s), lastWasCR: !1 }, actions: r };
        let t = n[e],
          i = It(n.slice(s + 2, e), t);
        r.push(i ?? { k: `ignored`, raw: n.slice(s, e + 1) }), (s = e + 1);
      } else if (e === `O`) {
        let e = n[s + 2];
        if (e === void 0)
          return { state: { pending: n.slice(s), lastWasCR: !1 }, actions: r };
        let t = It(``, e);
        r.push(t ?? { k: `ignored`, raw: n.slice(s, s + 3) }), (s += 3);
      } else
        e === `` || e === `\b`
          ? (r.push({ k: `delete-word` }), (s += 2))
          : (r.push({ k: `ignored`, raw: n.slice(s, s + 2) }), (s += 2));
      i = !1;
    } else
      e === `\r`
        ? (o(), r.push({ k: `enter` }), (i = !0), s++)
        : e ===
            `
`
          ? (o(), i || r.push({ k: `enter` }), (i = !1), s++)
          : ((i = !1),
            e === `` || e === `\b`
              ? (o(), r.push({ k: `backspace` }))
              : e === `	`
                ? (o(), r.push({ k: `tab` }))
                : e === `?`
                  ? (o(), r.push({ k: `help` }))
                  : Ft[e]
                    ? (o(), r.push({ k: `ctrl`, key: Ft[e] }))
                    : t >= 32 && t <= 126
                      ? (a += e)
                      : (o(), r.push({ k: `ignored`, raw: e })),
            s++);
  }
  return o(), { state: { pending: ``, lastWasCR: i }, actions: r };
}
var Rt = { buffer: ``, cursor: 0 };
function zt(e, t, n) {
  let r = Math.max(0, n - e.buffer.length),
    i = t.slice(0, r);
  return i
    ? {
        buffer: e.buffer.slice(0, e.cursor) + i + e.buffer.slice(e.cursor),
        cursor: e.cursor + i.length,
      }
    : e;
}
function Bt(e) {
  return e.cursor === 0
    ? e
    : {
        buffer: e.buffer.slice(0, e.cursor - 1) + e.buffer.slice(e.cursor),
        cursor: e.cursor - 1,
      };
}
function Vt(e) {
  return e.cursor >= e.buffer.length
    ? e
    : {
        buffer: e.buffer.slice(0, e.cursor) + e.buffer.slice(e.cursor + 1),
        cursor: e.cursor,
      };
}
var Ht = (e) => (e.cursor > 0 ? { ...e, cursor: e.cursor - 1 } : e),
  Ut = (e) => (e.cursor < e.buffer.length ? { ...e, cursor: e.cursor + 1 } : e),
  Wt = (e) => (e.cursor === 0 ? e : { ...e, cursor: 0 }),
  Gt = (e) =>
    e.cursor === e.buffer.length ? e : { ...e, cursor: e.buffer.length };
function Kt(e) {
  return e.cursor === 0 ? e : { buffer: e.buffer.slice(e.cursor), cursor: 0 };
}
function qt(e) {
  return e.cursor === e.buffer.length
    ? e
    : { buffer: e.buffer.slice(0, e.cursor), cursor: e.cursor };
}
function Jt(e) {
  let t = e.cursor;
  for (; t > 0 && e.buffer[t - 1] === ` `; ) t--;
  for (; t > 0 && e.buffer[t - 1] !== ` `; ) t--;
  return t === e.cursor
    ? e
    : { buffer: e.buffer.slice(0, t) + e.buffer.slice(e.cursor), cursor: t };
}
function Yt(e, t = 80, n = 24, mode = `user-exec`) {
  return {
    deviceId: e,
    phase: `active`,
    mode,
    interfaceId: null,
    line: Rt,
    history: { exec: [], config: [] },
    historyNav: { index: null, draft: `` },
    cols: Math.max(1, t),
    rows: Math.max(1, n),
    decoder: Pt,
  };
}
function Xt(e, t, n) {
  return t === `host` ? n.prompts.host : e + n.prompts[t];
}
function Zt(e, t) {
  return t.behaviour.historyScope === `per-session`
    ? `exec`
    : He(e)
      ? `config`
      : `exec`;
}
function Qt(e, t = () => new Date()) {
  // NetPrime: build every device kind's grammar up front, so a missing help text fails here and not mid-lab.
  for (let kind of DEVICE_KINDS) Ye(e, kind);
  return { profile: e, grammar: Ye(e), clock: t };
}
function $t(e, t = {}) {
  let n = {};
  for (let r of e.deviceOrder) n[r] = Yt(r, t.cols, t.rows, initialModeOf(e, r));
  return { initial: e, lab: e, sessions: n, revision: 0, epoch: 0 };
}
function en(e, t, n) {
  let r = e.sessions[t],
    i = re(e.lab, t);
  return r ? Xt(i, r.mode, n.profile) : ``;
}
function tn(e, t) {
  let n = {};
  for (let r of e.lab.deviceOrder) n[r] = en(e, r, t);
  return n;
}
var k = class {
  lab;
  sessions;
  revision;
  out = {};
  executed = [];
  logs = new Map();
  rt;
  env;
  constructor(e, t) {
    (this.rt = e),
      (this.env = t),
      (this.lab = e.lab),
      (this.sessions = { ...e.sessions }),
      (this.revision = e.revision);
  }
  write(e, t) {
    t && (this.out[e] = (this.out[e] ?? ``) + t);
  }
  writeLines(e, t) {
    this.write(e, t.map((e) => `${e}\r\n`).join(``));
  }
  session(e) {
    let t = this.sessions[e];
    if (!t) throw Error(`Unknown device ${e}`);
    return t;
  }
  setSession(e, t) {
    this.sessions[e] = t;
  }
  prompt(e) {
    return Xt(re(this.lab, e), this.session(e).mode, this.env.profile);
  }
  ctx(e) {
    let t = C(this.lab, e);
    if (!t) throw Error(`Unknown device ${e}`);
    return { device: t, profile: this.env.profile };
  }
  commitLab(e) {
    if (e === this.lab) return;
    let t = Ae(e, ae(this.lab), ae(e));
    (this.lab = e), this.revision++;
    for (let e of t) this.queueLog(e.deviceId, this.renderEvent(e));
  }
  renderEvent(e) {
    let t = C(this.lab, e.deviceId)?.inventory.find(
        (t) => t.id === e.interfaceId,
      ),
      n = t ? S(t) : e.interfaceId,
      r = this.env.profile.formats;
    return e.kind === `link`
      ? r.logLink(n, e.state)
      : r.logLineProto(n, e.state);
  }
  queueLog(e, t) {
    if (!this.env.profile.behaviour.consoleLogs) return;
    if (isHostKind(kindOf(C(this.lab, e)))) return;
    let n = this.logs.get(e) ?? [];
    n.push(t), this.logs.set(e, n);
  }
  flushLogs() {
    for (let [e, t] of this.logs) {
      let n = this.session(e),
        r = t.map(
          (e) => this.env.profile.formats.logTimestamp(this.env.clock()) + e,
        );
      if (n.phase === `active`) {
        let t = this.prompt(e);
        this.write(e, Nt(t, n.line, n.cols)),
          this.writeLines(e, r),
          this.write(e, jt(t, n.line, n.cols));
      } else this.writeLines(e, r);
    }
    this.logs.clear();
  }
  finish() {
    return {
      rt: {
        ...this.rt,
        lab: this.lab,
        sessions: this.sessions,
        revision: this.revision,
      },
      out: this.out,
      executed: this.executed,
    };
  }
};
function nn(e, t, n, r) {
  let i = new k(e, r),
    a = i.session(t),
    o = Lt(a.decoder, n);
  i.setSession(t, { ...a, decoder: o.state });
  for (let e of o.actions) on(i, t, e), i.flushLogs();
  return i.finish();
}
function rn(e, t, n, r, i) {
  let a = new k(e, i),
    o = a.session(t),
    s = Math.max(1, Math.floor(n)),
    c = Math.max(1, Math.floor(r));
  if (o.cols === s && o.rows === c) return a.finish();
  if (
    (a.setSession(t, { ...o, cols: s, rows: c }),
    o.phase === `active` && s !== o.cols)
  ) {
    let e = a.prompt(t);
    a.write(t, Mt(e.length + o.line.cursor, e, o.line, s));
  }
  return a.finish();
}
function an(e, t) {
  let n = {},
    r = {};
  for (let t of e.initial.deviceOrder) {
    let r = e.sessions[t];
    n[t] = Yt(t, r?.cols, r?.rows, initialModeOf(e.initial, t));
  }
  let i = {
    initial: e.initial,
    lab: e.initial,
    sessions: n,
    revision: e.revision + 1,
    epoch: e.epoch + 1,
  };
  for (let n of e.initial.deviceOrder) r[n] = Dt + en(i, n, t);
  return { rt: i, out: r, executed: [] };
}
function on(e, t, n) {
  let r = e.session(t);
  if (r.phase === `awaiting-return`) {
    n.k === `enter` &&
      (e.setSession(t, {
        ...r,
        phase: `active`,
        mode: `user-exec`,
        interfaceId: null,
        line: Rt,
        historyNav: { index: null, draft: `` },
      }),
      e.write(t, `\r\n${e.prompt(t)}`));
    return;
  }
  let i = e.prompt(t),
    a = r.cols,
    o = i.length + r.line.cursor,
    s = (n) => {
      n !== r.line &&
        (e.setSession(t, { ...r, line: n }), e.write(t, Mt(o, i, n, a)));
    };
  switch (n.k) {
    case `insert`: {
      let s = zt(r.line, n.text, e.env.profile.behaviour.maxLineLength);
      if (s === r.line) return;
      e.setSession(t, { ...r, line: s }),
        r.line.cursor === r.line.buffer.length
          ? e.write(
              t,
              s.buffer.slice(r.line.cursor) + At(i.length + s.buffer.length, a),
            )
          : e.write(t, Mt(o, i, s, a));
      return;
    }
    case `backspace`:
      return s(Bt(r.line));
    case `delete`:
      return s(Vt(r.line));
    case `left`:
      return s(Ht(r.line));
    case `right`:
      return s(Ut(r.line));
    case `home`:
      return s(Wt(r.line));
    case `end`:
      return s(Gt(r.line));
    case `delete-word`:
      return s(Jt(r.line));
    case `up`:
    case `down`:
      return sn(e, t, n.k);
    case `tab`:
      return cn(e, t);
    case `help`:
      return ln(e, t);
    case `enter`: {
      let n = r.mode;
      return (
        e.write(t, Nt(i, r.line, a)),
        fn(e, t, r.line.buffer, `enter`),
        pn(e, t, n)
      );
    }
    case `ctrl`:
      switch (n.key) {
        case `A`:
          return s(Wt(r.line));
        case `E`:
          return s(Gt(r.line));
        case `B`:
          return s(Ht(r.line));
        case `F`:
          return s(Ut(r.line));
        case `D`:
          return s(Vt(r.line));
        case `K`:
          return s(qt(r.line));
        case `U`:
          return s(Kt(r.line));
        case `W`:
          return s(Jt(r.line));
        case `P`:
          return sn(e, t, `up`);
        case `N`:
          return sn(e, t, `down`);
        case `Z`:
          return dn(e, t);
        case `C`:
          return un(e, t);
      }
      return;
    case `ignored`:
      return;
  }
}
function sn(e, t, n) {
  let r = e.session(t),
    i = r.history[Zt(r.mode, e.env.profile)];
  if (i.length === 0) return;
  let { index: a, draft: o } = r.historyNav,
    s;
  if (n === `up`) {
    if (a === null) (o = r.line.buffer), (a = i.length - 1);
    else if (a > 0) a--;
    else return;
    s = i[a] ?? ``;
  } else {
    if (a === null) return;
    a < i.length - 1 ? (a++, (s = i[a] ?? ``)) : ((a = null), (s = o));
  }
  let c = e.prompt(t),
    l = { buffer: s, cursor: s.length };
  e.setSession(t, { ...r, line: l, historyNav: { index: a, draft: o } }),
    e.write(t, Mt(c.length + r.line.cursor, c, l, r.cols));
}
function cn(e, t) {
  let n = e.session(t),
    r = e.prompt(t),
    i = gt(n.line.buffer, n.line.cursor, n.mode, grammarFor(e, t), e.ctx(t));
  if (i.kind === `completed`) {
    let a = { buffer: i.line, cursor: i.cursor };
    e.setSession(t, { ...n, line: a }),
      e.write(t, Mt(r.length + n.line.cursor, r, a, n.cols));
  } else
    e.env.profile.behaviour.tabFailure === `reecho-line`
      ? e.write(t, Nt(r, n.line, n.cols) + jt(r, n.line, n.cols))
      : e.write(t, `\x07`);
}
function ln(e, t) {
  let n = e.session(t),
    r = e.prompt(t),
    i = e.env.profile,
    a = n.line.buffer.slice(0, n.line.cursor),
    o = yt(a, n.mode, grammarFor(e, t), e.ctx(t)),
    s;
  switch (o.kind) {
    case `word`:
      s = [...Qe(o.words, n.cols), ``];
      break;
    case `syntax`:
      s = [...Ze(o.entries), ``];
      break;
    case `unrecognized`:
      s = [i.messages.unrecognized, ``];
      break;
    case `error`:
      (s = St(o.error, a, r.length, i)), s[s.length - 1] !== `` && s.push(``);
  }
  e.write(t, Nt(r, n.line, n.cols, `?`)),
    e.writeLines(t, s),
    e.write(t, jt(r, n.line, n.cols));
}
function un(e, t) {
  let n = e.session(t),
    r = e.prompt(t);
  e.write(t, Nt(r, n.line, n.cols, `^C`)),
    e.setSession(t, { ...n, line: Rt, historyNav: { index: null, draft: `` } }),
    e.write(t, r);
}
function dn(e, t) {
  let n = e.session(t);
  if (!He(n.mode)) return;
  let r = n.mode,
    i = e.prompt(t);
  e.write(t, Nt(i, n.line, n.cols, `^Z`)), fn(e, t, n.line.buffer, `ctrl-z`);
  let a = e.session(t);
  a.phase === `active` &&
    He(a.mode) &&
    e.setSession(t, { ...a, mode: `priv-exec`, interfaceId: null }),
    pn(e, t, r);
}
function fn(e, t, n, r) {
  let i = e.env.profile,
    a = e.session(t),
    o = e.prompt(t).length,
    s = n.trim(),
    c = a.history;
  if (s) {
    let e = Zt(a.mode, i),
      t = c[e];
    t[t.length - 1] !== n &&
      (c = { ...c, [e]: [...t, n].slice(-i.behaviour.historySize) });
  }
  if (
    ((a = {
      ...a,
      line: Rt,
      history: c,
      historyNav: { index: null, draft: `` },
    }),
    e.setSession(t, a),
    !s)
  ) {
    e.executed.push({ deviceId: t, line: n, via: r, outcome: `empty` });
    return;
  }
  if (s.startsWith(i.behaviour.commentPrefix)) {
    e.executed.push({ deviceId: t, line: n, via: r, outcome: `comment` });
    return;
  }
  let l = xt(n, a.mode, grammarFor(e, t), e.ctx(t));
  if (l.kind === `empty`) {
    e.executed.push({ deviceId: t, line: n, via: r, outcome: `empty` });
    return;
  }
  if (l.kind === `error`) {
    e.writeLines(
      t,
      a.mode === `host` && l.error.kind !== `unsupported`
        ? [i.messages.hostInvalid, ``]
        : St(l.error, n, o, i),
    ),
      e.executed.push({ deviceId: t, line: n, via: r, outcome: `error` });
    return;
  }
  let u = x(ot, l.commandId);
  if (!u) throw Error(`No handler bound to ${l.commandId}`);
  let d = e.lab,
    f = u({
      deviceId: t,
      lab: d,
      derived: ae(d),
      mode: l.resolvedMode,
      interfaceId: l.viaParent ? null : a.interfaceId,
      args: l.args,
      profile: i,
    });
  if (f.engineError) {
    e.writeLines(t, wt(f.engineError, i)),
      e.executed.push({
        deviceId: t,
        line: n,
        via: r,
        outcome: `error`,
        commandId: l.commandId,
      });
    return;
  }
  let p = d;
  if (f.ops && f.ops.length > 0) {
    let a = De(d, f.ops);
    if (!a.ok) {
      e.writeLines(t, wt(a.error, i)),
        e.executed.push({
          deviceId: t,
          line: n,
          via: r,
          outcome: `error`,
          commandId: l.commandId,
        });
      return;
    }
    p = a.value;
  }
  f.output && e.writeLines(t, f.output);
  let m = a.mode,
    h = a.interfaceId;
  l.viaParent && ((m = l.resolvedMode), (h = null)),
    f.mode !== void 0 && (m = f.mode),
    f.interfaceId !== void 0 && (h = f.interfaceId);
  let g = a.phase;
  f.endSession && ((g = `awaiting-return`), (m = `user-exec`), (h = null)),
    e.setSession(t, { ...e.session(t), mode: m, interfaceId: h, phase: g }),
    e.commitLab(p),
    e.executed.push({
      deviceId: t,
      line: n,
      via: r,
      outcome: `command`,
      commandId: l.commandId,
      labChanged: p !== d,
    });
}
function pn(e, t, n) {
  let r = e.session(t);
  if (
    (He(n) && !He(r.mode) && e.queueLog(t, e.env.profile.formats.logConfigExit),
    r.phase === `awaiting-return`)
  ) {
    let n = re(e.lab, t);
    e.writeLines(t, e.env.profile.messages.sessionEnded(n));
  } else e.write(t, e.prompt(t));
}
var mn = class {
    rt;
    snapshot;
    sinks = new Map();
    pending = new Map();
    listeners = new Set();
    executionListeners = new Set();
    lab;
    env;
    constructor(e, t, n = {}) {
      (this.lab = e),
        (this.env = t),
        (this.rt = $t(e.initialState, n)),
        (this.snapshot = this.makeSnapshot());
      let r = tn(this.rt, t);
      for (let [e, t] of Object.entries(r)) this.emit(e, t);
    }
    get deviceIds() {
      return this.rt.lab.deviceOrder;
    }
    getSnapshot = () => this.snapshot;
    subscribe = (e) => (this.listeners.add(e), () => this.listeners.delete(e));
    onExecution(e) {
      return (
        this.executionListeners.add(e), () => this.executionListeners.delete(e)
      );
    }
    attachSink(e, t) {
      this.sinks.set(e, t);
      let n = this.pending.get(e);
      return (
        n?.length && (this.pending.delete(e), t(n.join(``))),
        () => {
          this.sinks.get(e) === t && this.sinks.delete(e);
        }
      );
    }
    input(e, t) {
      this.apply(nn(this.rt, e, t, this.env));
    }
    resize(e, t, n) {
      this.apply(rn(this.rt, e, t, n, this.env));
    }
    reset() {
      this.apply(an(this.rt, this.env));
    }
    apply(e) {
      let t = e.rt !== this.rt;
      this.rt = e.rt;
      for (let [t, n] of Object.entries(e.out)) this.emit(t, n);
      if (e.executed.length)
        for (let t of this.executionListeners) t(e.executed);
      if (t) {
        this.snapshot = this.makeSnapshot();
        for (let e of this.listeners) e();
      }
    }
    emit(e, t) {
      if (!t) return;
      let n = this.sinks.get(e);
      n ? n(t) : this.pending.set(e, [...(this.pending.get(e) ?? []), t]);
    }
    makeSnapshot() {
      return {
        runtime: this.rt,
        derived: ae(this.rt.lab),
        assessment: Ee(this.rt.lab, this.lab.objectives),
      };
    }
  },
  hn = {
    schemaVersion: 1,
    id: `LAB-001`,
    version: `0.1.0`,
    title: `Basic IPv4 Connectivity`,
    profile: `generic-iosxe-like-v0`,
    instructions: {
      summary: `R1 and R2 are connected by one Ethernet link between their GigabitEthernet1 interfaces. Both interfaces start shut down with no IPv4 address. Configure the link so that the two routers can reach each other.`,
      scopeNote: `Work in any order; results are checked against device state, not against the commands you typed.`,
      addressingPlan: [
        {
          device: `r1`,
          interface: `gi1`,
          address: `10.12.12.1`,
          mask: `255.255.255.0`,
        },
        {
          device: `r2`,
          interface: `gi1`,
          address: `10.12.12.2`,
          mask: `255.255.255.0`,
        },
      ],
    },
    devices: [
      {
        id: `r1`,
        hostname: `R1`,
        layout: { x: 210, y: 95 },
        interfaces: [
          {
            id: `gi1`,
            type: `GigabitEthernet`,
            number: 1,
            mac: `0200.0001.0001`,
            mtu: 1500,
            bandwidthKbps: 1e6,
            adminUp: !1,
            ipv4: null,
          },
        ],
      },
      {
        id: `r2`,
        hostname: `R2`,
        layout: { x: 590, y: 95 },
        interfaces: [
          {
            id: `gi1`,
            type: `GigabitEthernet`,
            number: 1,
            mac: `0200.0002.0001`,
            mtu: 1500,
            bandwidthKbps: 1e6,
            adminUp: !1,
            ipv4: null,
          },
        ],
      },
    ],
    links: [
      {
        id: `l1`,
        kind: `ethernet`,
        a: { device: `r1`, interface: `gi1` },
        b: { device: `r2`, interface: `gi1` },
      },
    ],
    objectives: [
      {
        id: `r1_target_address`,
        check: `interfaceIpv4Equals`,
        title: `R1 interface address`,
        description: `R1 GigabitEthernet1 has IPv4 address 10.12.12.1 with mask 255.255.255.0.`,
        hints: [
          `Enter interface configuration for GigabitEthernet1 on R1 and assign the address with its subnet mask.`,
        ],
        params: {
          device: `r1`,
          interface: `gi1`,
          address: `10.12.12.1`,
          mask: `255.255.255.0`,
        },
      },
      {
        id: `r2_target_address`,
        check: `interfaceIpv4Equals`,
        title: `R2 interface address`,
        description: `R2 GigabitEthernet1 has IPv4 address 10.12.12.2 with mask 255.255.255.0.`,
        hints: [
          `Repeat the addressing step on R2 with its own address in the same subnet.`,
        ],
        params: {
          device: `r2`,
          interface: `gi1`,
          address: `10.12.12.2`,
          mask: `255.255.255.0`,
        },
      },
      {
        id: `both_interfaces_oper_up`,
        check: `interfacesOperUp`,
        title: `Link operational`,
        description: `Both GigabitEthernet1 interfaces are up/up.`,
        hints: [
          `An interface stays down until both ends of the link are enabled. Check "show ip interface brief" on each router.`,
        ],
        params: {
          endpoints: [
            { device: `r1`, interface: `gi1` },
            { device: `r2`, interface: `gi1` },
          ],
        },
      },
      {
        id: `target_bidirectional_reachability`,
        check: `bidirectionalReachability`,
        title: `Two-way reachability`,
        description: `R1 can reach 10.12.12.2 and R2 can reach 10.12.12.1.`,
        hints: [
          `Verify with ping from each router. Both addresses must be unique and in the same subnet, and the link must be up.`,
        ],
        params: {
          a: { device: `r1`, address: `10.12.12.1` },
          b: { device: `r2`, address: `10.12.12.2` },
        },
      },
    ],
  },
  gn = [
    `Jan`,
    `Feb`,
    `Mar`,
    `Apr`,
    `May`,
    `Jun`,
    `Jul`,
    `Aug`,
    `Sep`,
    `Oct`,
    `Nov`,
    `Dec`,
  ],
  _n = (e) => String(e).padStart(2, `0`),
  vn = {
    id: `generic-iosxe-like-v0`,
    label: `Generic IOS-XE-like teaching profile v0 (unvalidated)`,
    validated: !1,
    reference: null,
    prompts: {
      "user-exec": `>`,
      "priv-exec": `#`,
      "global-config": `(config)#`,
      "interface-config": `(config-if)#`,
      host: `C:\\>`,
    },
    help: {
      enable: `Turn on privileged commands`,
      disable: `Turn off privileged commands`,
      "exit.exec": `Exit from the EXEC`,
      "exit.config": `Exit from configure mode`,
      "exit.interface": `Exit from interface configuration mode`,
      end: `Exit from configure mode`,
      ping: `Send echo messages`,
      show: `Show running system information`,
      configure: `Enter configuration mode`,
      "configure.terminal": `Configure from the terminal`,
      "show.interfaces": `Interface status and configuration`,
      "show.ip": `IP information`,
      "show.ip.interface": `IP interface status and configuration`,
      "show.ip.interface.brief": `Brief summary of IP status and configuration`,
      "show.ip.route": `IP routing table`,
      "show.running-config": `Current operating configuration`,
      hostname: `Set system's network name`,
      interface: `Select an interface to configure`,
      "ip.interface": `Interface Internet Protocol config commands`,
      "ip.address": `Set the IP address of an interface`,
      no: `Negate a command or set its defaults`,
      shutdown: `Shutdown the selected interface`,
      do: `To run exec commands in config mode`,
      "param.address": `IP address`,
      "param.mask": `IP subnet mask`,
      "param.hostname": `This system's network name`,
      "param.pingTarget": `Ping destination address or hostname`,
      "param.ifaceNumber": `interface number`,
      "ip.global": `Global IP configuration subcommands`,
      "ip.route": `Establish static routes`,
      "param.prefix": `Destination prefix`,
      "param.prefixMask": `Destination prefix mask`,
      "param.nextHop": `Forwarding router's address`,
      "host.ipconfig": `Display or set the IP configuration`,
      "host.ping": `Send echo requests`,
      "param.gateway": `Default gateway`,
    },
    messages: {
      invalidInput: `% Invalid input detected at '^' marker.`,
      incomplete: `% Incomplete command.`,
      ambiguous: (e) => `% Ambiguous command:  "${e}"`,
      unrecognized: `% Unrecognized command`,
      unknownExecWord: `% Unknown command or computer name, or unable to find computer address`,
      configBanner: `Enter configuration commands, one per line.  End with CNTL/Z.`,
      sessionEnded: (e) => [
        ``,
        `${e} con0 is now available`,
        ``,
        ``,
        ``,
        ``,
        ``,
        `Press RETURN to get started.`,
        ``,
      ],
      unsupported: (e, t) =>
        `% NetPrime: "${e}" is recognized but not supported in this lab. ${t}`,
      badMaskPrefix: (e, t) => `Bad mask /${t} for address ${e}`,
      badMaskHex: (e, t) => `Bad mask ${t} for address ${e}`,
      notHostAddress: (e) => `Not a valid host address - ${e}`,
      prefixNotSupported: (e) =>
        `% NetPrime: /${e} masks are not supported in this lab (supported prefix lengths: /1 to /30).`,
      hostnameInvalid: (e, t) => `% NetPrime: invalid hostname "${e}": ${t}`,
      unrecognizedHost: `% Unrecognized host or address, or protocol not running.`,
      selfPing: (e) =>
        `% NetPrime: pinging a local interface address (${e}) is not modeled in this lab.`,
      interfacesNotModeled: `  % NetPrime: counters, queueing, timers and duplex/speed details are not modeled.`,
      hostInvalid: `Invalid Command.`,
      badGateway: (e) => `Invalid default gateway ${e}.`,
    },
    behaviour: {
      caretPolicy: `token-start`,
      tabFailure: `reecho-line`,
      crLabel: `<cr>`,
      unsupportedHelpSuffix: ` (not supported in this lab)`,
      historyScope: `per-mode-class`,
      historySize: 20,
      maxLineLength: 512,
      ctrlZ: `execute-then-end`,
      ctrlC: `discard-line`,
      commentPrefix: `!`,
      unknownExecWordMessage: !0,
      consoleLogs: !0,
    },
    interfaceTypes: [
      {
        name: `GigabitEthernet`,
        help: `GigabitEthernet IEEE 802.3z`,
        support: { kind: `supported` },
      },
      {
        name: `Loopback`,
        help: `Loopback interface`,
        support: {
          kind: `unsupported`,
          reason: `Loopback interfaces are not part of this lab.`,
        },
      },
      {
        name: `Port-channel`,
        help: `Ethernet Channel of interfaces`,
        support: {
          kind: `unsupported`,
          reason: `EtherChannel is not part of this lab.`,
        },
      },
      {
        name: `Tunnel`,
        help: `Tunnel interface`,
        support: {
          kind: `unsupported`,
          reason: `Tunnel interfaces are not part of this lab.`,
        },
      },
    ],
    knownUnsupported: {
      exec: [
        {
          word: `terminal`,
          help: `Set terminal line parameters`,
          reason: `Terminal line settings (such as paging) are not modeled; output is never paginated.`,
        },
      ],
      privExec: [
        {
          word: `copy`,
          help: `Copy from one file to another`,
          reason: `Saving or copying configuration is not modeled (there is no startup-config in this lab).`,
        },
        {
          word: `reload`,
          help: `Halt and perform a cold restart`,
          reason: `Reload is not modeled.`,
        },
        {
          word: `write`,
          help: `Write running configuration to memory, network, or terminal`,
          reason: `Saving configuration is not modeled (there is no startup-config in this lab).`,
        },
      ],
      showUser: [
        {
          word: `version`,
          help: `System hardware and software status`,
          reason: `Platform and software release are not modeled (reference platform not yet decided).`,
        },
      ],
      showPriv: [
        {
          word: `startup-config`,
          help: `Contents of startup configuration`,
          reason: `There is no startup-config in this lab.`,
        },
        {
          word: `version`,
          help: `System hardware and software status`,
          reason: `Platform and software release are not modeled (reference platform not yet decided).`,
        },
      ],
      globalConfig: [
        {
          word: `enable`,
          help: `Modify enable password parameters`,
          reason: `Enable passwords and secrets are not modeled.`,
        },
        {
          word: `ip`,
          help: `Global IP configuration subcommands`,
          reason: `Global IP settings (including static routes) are not part of this lab.`,
        },
        {
          word: `line`,
          help: `Configure a terminal line`,
          reason: `Line configuration is not modeled.`,
        },
        {
          word: `no`,
          help: `Negate a command or set its defaults`,
          reason: `Negating global configuration commands is not supported in this lab.`,
        },
        {
          word: `router`,
          help: `Enable a routing process`,
          reason: `Dynamic routing is not part of this lab.`,
        },
      ],
      interfaceConfig: [
        {
          word: `description`,
          help: `Interface specific description`,
          reason: `Interface descriptions are not modeled in this lab.`,
        },
      ],
      pingOptions: [
        {
          word: `repeat`,
          help: `specify repeat count`,
          reason: `Extended ping options are not modeled.`,
        },
        {
          word: `size`,
          help: `specify datagram size`,
          reason: `Extended ping options are not modeled.`,
        },
        {
          word: `source`,
          help: `specify source address or name`,
          reason: `Extended ping options are not modeled.`,
        },
        {
          word: `timeout`,
          help: `specify timeout interval`,
          reason: `Extended ping options are not modeled.`,
        },
      ],
    },
    formats: {
      ipIntBriefColumns: [23, 16, 4, 7, 22],
      routeLegend: [
        `Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP`,
        `       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area`,
        `       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2`,
        `       E1 - OSPF external type 1, E2 - OSPF external type 2`,
        `       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2`,
        `       ia - IS-IS inter area, * - candidate default, U - per-user static route`,
        `       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP`,
        `       a - application route`,
        `       + - replicated route, % - next hop override, p - overrides from PfR`,
      ],
      hardwareDescription: `NetPrime virtual Ethernet`,
      encapsulation: `Encapsulation ARPA`,
      logTimestamp: (e) =>
        `*${gn[e.getUTCMonth()]} ${String(e.getUTCDate()).padStart(2, ` `)} ${_n(e.getUTCHours())}:${_n(e.getUTCMinutes())}:${_n(e.getUTCSeconds())}.${String(e.getUTCMilliseconds()).padStart(3, `0`)}: `,
      logLink: (e, t) =>
        t === `administratively down`
          ? `%LINK-5-CHANGED: Interface ${e}, changed state to administratively down`
          : `%LINK-3-UPDOWN: Interface ${e}, changed state to ${t}`,
      logLineProto: (e, t) =>
        `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${e}, changed state to ${t}`,
      logConfigExit: `%SYS-5-CONFIG_I: Configured from console by console`,
      ping: { count: 5, size: 100, timeoutSec: 2, rttMs: [1, 1, 1] },
    },
    provenance: {
      "link-model": {
        kind: `simulation-policy`,
        note: `Link is up/up only when both endpoints are administratively up (blueprint §6). Some virtual IOS-XE platforms keep carrier up when the peer shuts down.`,
      },
      "prefix-range": {
        kind: `simulation-policy`,
        note: `Only /1–/30 accepted on interfaces (blueprint §6); /31 and /32 get a NetPrime marker.`,
      },
      "duplicate-address": {
        kind: `simulation-policy`,
        note: `Duplicate addresses across devices make reachability fail (blueprint §6); no ARP emulation.`,
      },
      "self-ping": {
        kind: `simulation-policy`,
        note: `Pinging a local address is not modeled (blueprint §6) and is marked unsupported.`,
      },
      "ping-model": {
        kind: `simulation-policy`,
        note: `Deterministic single-hop reachability; no ARP first-packet loss, no timing, fixed RTT.`,
      },
      reset: {
        kind: `simulation-policy`,
        note: `Reset restores the initial snapshot for all devices and clears sessions and history (blueprint §6).`,
      },
      "error-texts": {
        kind: `unverified-ios-behavior`,
        ref: `REF-04`,
        note: `Invalid/incomplete/ambiguous message texts and trailing blank lines.`,
      },
      "caret-policy": {
        kind: `unverified-ios-behavior`,
        ref: `REF-03`,
        note: `Caret placed at the start of the offending token.`,
      },
      "help-format": {
        kind: `unverified-ios-behavior`,
        ref: `REF-05/REF-08`,
        note: `Help columns, ordering (parameters then keywords alphabetically) and <cr> label; output modifiers omitted.`,
      },
      "help-strings": {
        kind: `unverified-ios-behavior`,
        ref: `REF-02`,
        note: `Keyword help text.`,
      },
      "tab-failure": {
        kind: `unverified-ios-behavior`,
        ref: `REF-06`,
        note: `Ambiguous/no-match Tab re-echoes the prompt and line.`,
      },
      history: {
        kind: `unverified-ios-behavior`,
        ref: `REF-09`,
        note: `Separate EXEC and configuration history buffers, 20 entries, kept across exit.`,
      },
      "ctrl-z": {
        kind: `unverified-ios-behavior`,
        ref: `REF-10`,
        note: `Execute-then-end is Cisco-documented for valid commands (AR-001); behaviour after an invalid line is unverified.`,
      },
      "ctrl-c": {
        kind: `unverified-ios-behavior`,
        ref: `REF-10`,
        note: `Ctrl+C discards the pending line and stays in mode; whether IOS also leaves configuration mode is unverified.`,
      },
      "interface-catalog": {
        kind: `unverified-ios-behavior`,
        ref: `REF-11`,
        note: `Interface type catalog and abbreviation ambiguity.`,
      },
      "address-errors": {
        kind: `unverified-ios-behavior`,
        ref: `REF-12`,
        note: `"Bad mask" and "Not a valid host address" texts.`,
      },
      "hostname-policy": {
        kind: `simulation-policy`,
        ref: `REF-14`,
        note: `Hostname rules; messages are NetPrime-marked until captured.`,
      },
      "show-formats": {
        kind: `unverified-ios-behavior`,
        ref: `REF-15/18/19/20`,
        note: `Layouts of show ip route, show ip interface brief, show running-config, show interfaces.`,
      },
      "ping-texts": {
        kind: `unverified-ios-behavior`,
        ref: `REF-16`,
        note: `Ping output lines and unrecognized-host message.`,
      },
      "console-logs": {
        kind: `unverified-ios-behavior`,
        ref: `REF-17`,
        note: `Log formats/timestamps; delivered immediately (no carrier delay).`,
      },
      "session-end": {
        kind: `unverified-ios-behavior`,
        ref: `REF-01`,
        note: `"con0 is now available / Press RETURN to get started." after exit.`,
      },
      "unknown-exec-word": {
        kind: `unverified-ios-behavior`,
        ref: `REF-22`,
        note: `Single unknown word in EXEC, as with no ip domain-lookup.`,
      },
      comments: {
        kind: `unverified-ios-behavior`,
        ref: `REF-22`,
        note: `Lines starting with ! are ignored in all modes.`,
      },
      "parent-resolution": {
        kind: `unverified-ios-behavior`,
        ref: `REF-23`,
        note: `Global commands accepted from interface configuration; help on an empty line lists the current mode only.`,
      },
      "unsupported-markers": {
        kind: `netprime-convention`,
        note: `Known-but-unsupported commands print a "% NetPrime:" marker and never change state.`,
      },
      "hardware-strings": {
        kind: `netprime-convention`,
        note: `Neutral hardware description and synthetic locally administered MAC addresses; no platform claim.`,
      },
      "logging-synchronous": {
        kind: `netprime-convention`,
        note: `Console messages are printed on their own line and the prompt plus pending input are redrawn.`,
      },
      "line-wrap": {
        kind: `netprime-convention`,
        note: `Long command lines wrap at the terminal width (IOS horizontal scrolling not modeled, D-9).`,
      },
      "ascii-input": {
        kind: `netprime-convention`,
        note: `Only printable ASCII is accepted on the console line.`,
      },
    },
  },
  yn = (e) => typeof e == `object` && !!e && !Array.isArray(e),
  bn = /^[a-z][a-z0-9_-]{0,31}$/,
  xn = /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/;
function Sn(e, t) {
  try {
    return Cn(e, t);
  } catch (e) {
    return {
      ok: !1,
      errors: [
        {
          path: `$`,
          message: `internal validator error: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }
}
function Cn(e, t) {
  let n = [],
    r = (e, t) => n.push({ path: e, message: t }),
    i = (e, t, n) => {
      for (let i of Object.keys(e))
        n.includes(i) || r(`${t}.${i}`, `unknown field`);
    },
    a = (e, t, n) => {
      let i = e[t];
      return typeof i != `string` || i.length === 0
        ? (r(`${n}.${t}`, `must be a non-empty string`), ``)
        : i;
    },
    o = (e, t, n) => {
      let i = a(e, t, n);
      return (
        i && !bn.test(i)
          ? r(`${n}.${t}`, `must match ^[a-z][a-z0-9_-]{0,31}$`)
          : i && ne(i) && r(`${n}.${t}`, `"${i}" is a reserved identifier`),
        i
      );
    };
  if (!yn(e))
    return {
      ok: !1,
      errors: [{ path: `$`, message: `lab definition must be an object` }],
    };
  i(e, `$`, [
    `schemaVersion`,
    `id`,
    `version`,
    `title`,
    `profile`,
    `instructions`,
    `devices`,
    `links`,
    `objectives`,
  ]),
    e.schemaVersion !== 1 &&
      r(`$.schemaVersion`, `unsupported schema version (expected 1)`);
  let s = a(e, `id`, `$`),
    c = a(e, `version`, `$`),
    l = a(e, `title`, `$`),
    u = a(e, `profile`, `$`),
    f = u ? x(t, u) : void 0;
  u && !f && r(`$.profile`, `unknown device profile "${u}"`);
  let p = {},
    m = [],
    h = {},
    g = e.devices;
  (Array.isArray(g) && g.length !== 0) ||
    r(`$.devices`, `must be a non-empty array`),
    (Array.isArray(g) ? g : []).forEach((e, t) => {
      let n = `$.devices[${t}]`;
      if (!yn(e)) return r(n, `must be an object`);
      i(e, n, [`id`, `kind`, `hostname`, `layout`, `interfaces`, `gateway`, `routes`]);
      // NetPrime: device kind (router when left out) and kind-specific settings.
      let kind = e.kind === void 0 ? `router` : e.kind;
      DEVICE_KINDS.includes(kind) ||
        r(`${n}.kind`, `must be one of ${DEVICE_KINDS.join(`, `)}`);
      let gateway = null;
      if (e.gateway !== void 0 && e.gateway !== null) {
        let parsed = typeof e.gateway == `string` ? d(e.gateway) : null;
        !isHostKind(kind)
          ? r(`${n}.gateway`, `only a PC or server has a default gateway`)
          : parsed?.ok && isUnicast(parsed.value)
            ? (gateway = parsed.value)
            : r(`${n}.gateway`, `must be a dotted-quad unicast IPv4 address`);
      }
      let routes = [];
      if (e.routes !== void 0)
        kind !== `router`
          ? r(`${n}.routes`, `only a router has static routes`)
          : Array.isArray(e.routes)
            ? e.routes.forEach((route, k) => {
                let rp = `${n}.routes[${k}]`;
                if (!yn(route)) return r(rp, `must be {network, mask, nextHop}`);
                i(route, rp, [`network`, `mask`, `nextHop`]);
                let parts = [`network`, `mask`, `nextHop`].map((f) =>
                  typeof route[f] == `string` ? d(route[f]) : null,
                );
                if (!parts.every((part) => part?.ok))
                  return r(rp, `network, mask and nextHop must be dotted-quad values`);
                let parsed = parseStaticRoute({
                  prefix: parts[0].value,
                  prefixMask: parts[1].value,
                  nextHop: parts[2].value,
                });
                parsed.ok
                  ? routes.push(parsed.value)
                  : r(rp, `invalid static route (${parsed.error.code})`);
              })
            : r(`${n}.routes`, `must be an array`);
      let s = o(e, `id`, n);
      s && te(p, s) && r(`${n}.id`, `duplicate device id "${s}"`);
      let c = a(e, `hostname`, n);
      c && !me(c).ok && r(`${n}.hostname`, `invalid hostname`);
      let l = e.layout;
      !yn(l) ||
      typeof l.x != `number` ||
      typeof l.y != `number` ||
      !Number.isFinite(l.x) ||
      !Number.isFinite(l.y)
        ? r(`${n}.layout`, `must be {x:number, y:number}`)
        : (i(l, `${n}.layout`, [`x`, `y`]), s && (h[s] = { x: l.x, y: l.y }));
      let u = [],
        g = {},
        _ = e.interfaces;
      (Array.isArray(_) && _.length !== 0) ||
        r(`${n}.interfaces`, `must be a non-empty array`),
        (Array.isArray(_) ? _ : []).forEach((e, t) => {
          let s = `${n}.interfaces[${t}]`;
          if (!yn(e)) return r(s, `must be an object`);
          i(e, s, [
            `id`,
            `type`,
            `number`,
            `mac`,
            `mtu`,
            `bandwidthKbps`,
            `adminUp`,
            `ipv4`,
          ]);
          let c = o(e, `id`, s);
          c && te(g, c) && r(`${s}.id`, `duplicate interface id "${c}"`);
          let l = a(e, `type`, s),
            p = f?.interfaceTypes.find((e) => e.name === l);
          f &&
            (!p || p.support.kind !== `supported`) &&
            r(
              `${s}.type`,
              `interface type "${l}" is not a supported type of profile ${f.id}`,
            );
          let m = e.number;
          (typeof m != `number` || !Number.isInteger(m) || m < 0) &&
            r(`${s}.number`, `must be a non-negative integer`),
            u.some((e) => e.type === l && e.number === m) &&
              r(`${s}.number`, `duplicate interface ${l}${String(m)}`);
          let h = a(e, `mac`, s);
          h && !xn.test(h) && r(`${s}.mac`, `must be in xxxx.xxxx.xxxx form`);
          for (let t of [`mtu`, `bandwidthKbps`]) {
            let n = e[t];
            (typeof n != `number` || !Number.isInteger(n) || n <= 0) &&
              r(`${s}.${t}`, `must be a positive integer`);
          }
          typeof e.adminUp != `boolean` &&
            r(`${s}.adminUp`, `must be a boolean`);
          let _ = null,
            v = e.ipv4;
          kind === `switch` &&
            v !== null &&
            r(`${s}.ipv4`, `switch ports cannot have an IPv4 address (layer 2 only)`);
          if (v !== null) {
            if (!yn(v)) r(`${s}.ipv4`, `must be null or {address, mask}`);
            else {
              i(v, `${s}.ipv4`, [`address`, `mask`]);
              let e = typeof v.address == `string` ? d(v.address) : null,
                t = typeof v.mask == `string` ? d(v.mask) : null;
              if (
                (e?.ok ||
                  r(`${s}.ipv4.address`, `must be a dotted-quad IPv4 address`),
                t?.ok || r(`${s}.ipv4.mask`, `must be a dotted-quad mask`),
                e?.ok && t?.ok)
              ) {
                let n = pe(e.value, t.value);
                n.ok
                  ? (_ = n.value)
                  : r(
                      `${s}.ipv4`,
                      `invalid interface address (${n.error.code})`,
                    );
              }
            }
          }
          u.push({
            id: c,
            type: l,
            number: typeof m == `number` ? m : 0,
            mac: h,
            mtu: Number(e.mtu),
            bandwidthKbps: Number(e.bandwidthKbps),
          }),
            c && (g[c] = { adminUp: e.adminUp === !0, ipv4: _ });
        }),
        isHostKind(kind) &&
          Array.isArray(_) &&
          _.length !== 1 &&
          r(`${n}.interfaces`, `a PC or server has exactly one network interface`);
      let config = { hostname: c, interfaces: g };
      isHostKind(kind) && (config.gateway = gateway);
      kind === `router` &&
        (config.routes = routes.sort(
          (a, b) =>
            a.network - b.network ||
            a.prefixLength - b.prefixLength ||
            a.nextHop - b.nextHop,
        ));
      s &&
          ((p[s] = {
            id: s,
            kind,
            inventory: u,
            config,
          }),
          m.push(s));
    });
  let _ = {
      hasDevice: (e) => typeof e == `string` && te(p, e),
      hasInterface: (e, t) => {
        let n = typeof e == `string` ? x(p, e) : void 0;
        return (
          n !== void 0 && typeof t == `string` && te(n.config.interfaces, t)
        );
      },
      deviceKind: (e) => kindOf(typeof e == `string` ? x(p, e) : void 0),
    },
    v = e.instructions,
    y = { summary: ``, scopeNote: ``, addressingPlan: [] };
  if (!yn(v)) r(`$.instructions`, `must be an object`);
  else {
    i(v, `$.instructions`, [`summary`, `scopeNote`, `addressingPlan`]);
    let e = [],
      t = v.addressingPlan;
    t !== void 0 &&
      (Array.isArray(t)
        ? t.forEach((t, n) => {
            let a = `$.instructions.addressingPlan[${n}]`;
            if (!yn(t)) return r(a, `must be an object`);
            i(t, a, [`device`, `interface`, `address`, `mask`, `gateway`]);
            let o = t.device,
              s = t.interface;
            if (typeof o != `string` || !_.hasDevice(o))
              return r(`${a}.device`, `must reference an existing device`);
            if (typeof s != `string` || !_.hasInterface(o, s))
              return r(
                `${a}.interface`,
                `must reference an existing interface of that device`,
              );
            let c = typeof t.address == `string` ? d(t.address) : null,
              l = typeof t.mask == `string` ? d(t.mask) : null;
            if (!c?.ok || !l?.ok)
              return r(a, `address and mask must be dotted-quad values`);
            let u = pe(c.value, l.value);
            if (!u.ok)
              return r(a, `invalid interface address (${u.error.code})`);
            let row = {
              deviceId: o,
              interfaceId: s,
              address: u.value.address,
              prefixLength: u.value.prefixLength,
            };
            // NetPrime: a PC or server row may also give the default gateway.
            if (t.gateway !== void 0 && t.gateway !== null && t.gateway !== ``) {
              let gw = typeof t.gateway == `string` ? d(t.gateway) : null;
              if (!isHostKind(_.deviceKind(o)))
                return r(`${a}.gateway`, `only a PC or server row has a default gateway`);
              if (!gw?.ok || !isUnicast(gw.value))
                return r(`${a}.gateway`, `must be a dotted-quad unicast IPv4 address`);
              row.gateway = gw.value;
            }
            e.push(row);
          })
        : r(`$.instructions.addressingPlan`, `must be an array`)),
      (y = {
        summary: a(v, `summary`, `$.instructions`),
        scopeNote: a(v, `scopeNote`, `$.instructions`),
        addressingPlan: e,
      });
  }
  let b = [],
    ee = new Set(),
    S = e.links;
  Array.isArray(S) || r(`$.links`, `must be an array`),
    (Array.isArray(S) ? S : []).forEach((e, t) => {
      let n = `$.links[${t}]`;
      if (!yn(e)) return r(n, `must be an object`);
      i(e, n, [`id`, `kind`, `a`, `b`]);
      let a = o(e, `id`, n);
      b.some((e) => e.id === a) && r(`${n}.id`, `duplicate link id "${a}"`),
        e.kind !== `ethernet` && r(`${n}.kind`, `must be "ethernet"`);
      let s = [];
      for (let t of [`a`, `b`]) {
        let a = e[t];
        if (
          !yn(a) ||
          typeof a.device != `string` ||
          typeof a.interface != `string`
        ) {
          r(`${n}.${t}`, `must be {device, interface}`);
          continue;
        }
        if (
          (i(a, `${n}.${t}`, [`device`, `interface`]),
          !_.hasInterface(a.device, a.interface))
        ) {
          r(
            `${n}.${t}`,
            `references unknown interface ${a.device}/${a.interface}`,
          );
          continue;
        }
        let o = `${a.device}/${a.interface}`;
        ee.has(o) &&
          r(`${n}.${t}`, `interface ${o} is already used by another link`),
          ee.add(o),
          s.push({ deviceId: a.device, interfaceId: a.interface });
      }
      let [c, l] = s;
      c &&
        l &&
        (c.deviceId === l.deviceId &&
          c.interfaceId === l.interfaceId &&
          r(n, `a link cannot connect an interface to itself`),
        a && b.push({ id: a, kind: `ethernet`, a: c, b: l }));
    });
  let C = [],
    w = e.objectives;
  return (
    (Array.isArray(w) && w.length !== 0) ||
      r(`$.objectives`, `must be a non-empty array`),
    (Array.isArray(w) ? w : []).forEach((e, t) => {
      let n = `$.objectives[${t}]`;
      if (!yn(e)) return r(n, `must be an object`);
      i(e, n, [`id`, `check`, `title`, `description`, `hints`, `params`]);
      let o = a(e, `id`, n);
      C.some((e) => e.id === o) &&
        r(`${n}.id`, `duplicate objective id "${o}"`);
      let s = a(e, `check`, n),
        c = s ? x(D, s) : void 0;
      s && !c && r(`${n}.check`, `unknown check "${s}"`);
      let l = e.hints;
      (Array.isArray(l) && l.every((e) => typeof e == `string`)) ||
        r(`${n}.hints`, `must be an array of strings`);
      let u = null;
      if (c) {
        let t = c.parseParams(e.params, _);
        if (t.ok) u = t.params;
        else
          for (let e of t.errors)
            r(`${n}.${e.split(` `)[0]}`, e.slice(e.indexOf(` `) + 1));
      }
      C.push({
        id: o,
        checkId: s,
        title: a(e, `title`, n),
        description: a(e, `description`, n),
        hints: Array.isArray(l) ? l.filter((e) => typeof e == `string`) : [],
        params: u,
      });
    }),
    n.length > 0
      ? { ok: !1, errors: n }
      : {
          ok: !0,
          lab: {
            id: s,
            version: c,
            title: l,
            profileId: u,
            instructions: y,
            layout: h,
            initialState: {
              labId: s,
              labVersion: c,
              deviceOrder: m,
              devices: p,
              links: b,
            },
            objectives: C,
          },
        }
  );
}
var wn = { [vn.id]: vn },
  Tn = { "LAB-001": hn };
function En(e) {
  let t = x(Tn, e);
  return t === void 0
    ? { ok: !1, errors: [{ path: `$`, message: `unknown lab ${e}` }] }
    : Sn(t, wn);
}

export { En as findBuiltinLab, Sn as validateLab, Qt as createEnv, $t as createRuntime, nn as inputRuntime, Ee as assess, ae as deriveState, mn as LabController, wn as PROFILES, hn as LAB_001 };
