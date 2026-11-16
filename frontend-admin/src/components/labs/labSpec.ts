// The lab definition (JSON) as staff write it, and the edits the visual designer makes to it.
// Shape and rules come from packages/lab-engine (validateSpec); see docs/VIRTUAL-LAB.md.

export interface SpecInterface {
  id: string; type: "GigabitEthernet"; number: number; mac: string; mtu: number; bandwidthKbps: number;
  adminUp: boolean; ipv4: { address: string; mask: string } | null;
}
export interface SpecRoute { network: string; mask: string; nextHop: string }
export interface SpecDevice {
  id: string; kind?: DeviceKind; hostname: string; layout: { x: number; y: number }; interfaces: SpecInterface[];
  /** PC / server only: default gateway at the start of the lab. */
  gateway?: string | null;
  /** Router only: static routes at the start of the lab. */
  routes?: SpecRoute[];
}
export interface SpecEndpoint { device: string; interface: string }
export interface SpecLink { id: string; kind: "ethernet"; a: SpecEndpoint; b: SpecEndpoint }
export interface PlanRow { device: string; interface: string; address: string; mask: string; gateway?: string }
export type CheckId = "interfaceIpv4Equals" | "interfacesOperUp" | "bidirectionalReachability" | "defaultGatewayEquals";
export interface SpecObjective { id: string; check: CheckId; title: string; description: string; hints: string[]; params: any }
export interface LabSpecDoc {
  schemaVersion: 1; id: string; version: string; title: string; profile: string;
  instructions: { summary: string; scopeNote: string; addressingPlan?: PlanRow[] };
  devices: SpecDevice[]; links: SpecLink[]; objectives: SpecObjective[];
}

/** Kinds of equipment on the palette (the engine simulates all of them; see packages/lab-engine). */
export type DeviceKind = "router" | "switch" | "pc" | "server";
export const DEVICE_KINDS: { kind: DeviceKind; label: string; ready: boolean }[] = [
  { kind: "router", label: "Router", ready: true },
  { kind: "switch", label: "Switch", ready: true },
  { kind: "pc", label: "PC", ready: true },
  { kind: "server", label: "Server", ready: true }
];

/** Devices without a kind are routers (labs written before kinds existed). */
export const kindOf = (device?: Pick<SpecDevice, "kind">): DeviceKind => device?.kind ?? "router";
export const isHost = (device?: Pick<SpecDevice, "kind">) => ["pc", "server"].includes(kindOf(device));

/** Per kind: id prefix, first port number and port count, and whether ports start switched on. */
const KIND_DEFAULTS: Record<DeviceKind, { prefix: string; first: number; ports: number; adminUp: boolean }> = {
  router: { prefix: "r", first: 1, ports: 2, adminUp: false },
  switch: { prefix: "sw", first: 1, ports: 8, adminUp: true },
  pc: { prefix: "pc", first: 0, ports: 1, adminUp: true },
  server: { prefix: "srv", first: 0, ports: 1, adminUp: true }
};

export const BOARD = { width: 960, height: 540 };

export const CHECK_LABEL: Record<CheckId, string> = {
  interfaceIpv4Equals: "ตั้ง IP ที่พอร์ตถูกต้อง",
  interfacesOperUp: "พอร์ตทำงาน (up/up)",
  bidirectionalReachability: "ping ถึงกันได้สองทาง",
  defaultGatewayEquals: "Default gateway ของ PC ถูกต้อง"
};

export function blankSpec(): LabSpecDoc {
  return {
    schemaVersion: 1, id: "LAB-NEW", version: "1.0.0", title: "Lab ใหม่", profile: "generic-iosxe-like-v0",
    instructions: { summary: "อธิบายโจทย์ให้ผู้เรียน", scopeNote: "ทำตามลำดับใดก็ได้ ระบบตรวจจากสถานะของอุปกรณ์ ไม่ได้ตรวจคำสั่งที่พิมพ์", addressingPlan: [] },
    devices: [], links: [], objectives: []
  };
}

/** Accepts any parsed JSON; fills the arrays the designer needs so it can show a partly written spec. */
export function asDoc(value: unknown): LabSpecDoc | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<LabSpecDoc>;
  return {
    ...blankSpec(), ...v,
    instructions: { ...blankSpec().instructions, ...(v.instructions ?? {}) },
    devices: Array.isArray(v.devices) ? v.devices : [],
    links: Array.isArray(v.links) ? v.links : [],
    objectives: Array.isArray(v.objectives) ? v.objectives : []
  } as LabSpecDoc;
}

const clone = (doc: LabSpecDoc): LabSpecDoc => JSON.parse(JSON.stringify(doc));
const hex4 = (n: number) => n.toString(16).padStart(4, "0").slice(-4);

function nextId(prefix: string, used: string[]): string {
  for (let n = 1; ; n++) if (!used.includes(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** The middle part of a device's MACs (0200.XXXX.port), unique per device. */
function macPrefix(doc: LabSpecDoc, device?: SpecDevice): string {
  const existing = device?.interfaces[0]?.mac?.split(".")[1];
  if (existing) return existing;
  const used = new Set(doc.devices.flatMap(d => d.interfaces.map(i => i.mac?.split(".")[1])));
  for (let n = 1; ; n++) if (!used.has(hex4(n))) return hex4(n);
}

function makeInterface(doc: LabSpecDoc, device: SpecDevice | undefined, number: number, prefix?: string, adminUp = false): SpecInterface {
  return {
    id: `gi${number}`, type: "GigabitEthernet", number, mac: `0200.${prefix ?? macPrefix(doc, device)}.${hex4(number)}`,
    mtu: 1500, bandwidthKbps: 1000000, adminUp, ipv4: null
  };
}

export function addDevice(source: LabSpecDoc, kind: DeviceKind, x: number, y: number): { doc: LabSpecDoc; id: string } {
  const doc = clone(source);
  const defaults = KIND_DEFAULTS[kind];
  const id = nextId(defaults.prefix, doc.devices.map(d => d.id));
  const prefix = macPrefix(doc);
  const interfaces = Array.from({ length: defaults.ports }, (_, i) => makeInterface(doc, undefined, defaults.first + i, prefix, defaults.adminUp));
  const device: SpecDevice = { id, kind, hostname: id.toUpperCase(), layout: clampPoint(x, y), interfaces };
  if (kind === "pc" || kind === "server") device.gateway = null;
  doc.devices.push(device);
  return { doc, id };
}

export function clampPoint(x: number, y: number) {
  const snap = (v: number) => Math.round(v / 10) * 10;
  return { x: snap(Math.min(BOARD.width - 50, Math.max(50, x))), y: snap(Math.min(BOARD.height - 40, Math.max(50, y))) };
}

export function moveDevice(source: LabSpecDoc, id: string, x: number, y: number): LabSpecDoc {
  const doc = clone(source);
  const device = doc.devices.find(d => d.id === id);
  if (device) device.layout = clampPoint(x, y);
  return doc;
}

export function updateDevice(source: LabSpecDoc, id: string, patch: Partial<Pick<SpecDevice, "hostname" | "gateway" | "routes">>): LabSpecDoc {
  const doc = clone(source);
  const device = doc.devices.find(d => d.id === id);
  if (device) Object.assign(device, patch);
  return doc;
}

/** Removes a device with its cables, plan rows and every objective that refers to it. */
export function removeDevice(source: LabSpecDoc, id: string): LabSpecDoc {
  const doc = clone(source);
  doc.devices = doc.devices.filter(d => d.id !== id);
  doc.links = doc.links.filter(l => l.a.device !== id && l.b.device !== id);
  if (doc.instructions.addressingPlan) doc.instructions.addressingPlan = doc.instructions.addressingPlan.filter(r => r.device !== id);
  doc.objectives = doc.objectives.filter(o => !JSON.stringify(o.params ?? {}).includes(`"device":"${id}"`));
  return doc;
}

export function linkOf(doc: LabSpecDoc, device: string, iface: string): SpecLink | undefined {
  return doc.links.find(l => (l.a.device === device && l.a.interface === iface) || (l.b.device === device && l.b.interface === iface));
}

/** First port of a device with no cable; adds a port when every one is taken (a PC or server has only one). */
function freePort(doc: LabSpecDoc, device: SpecDevice): string | null {
  const free = device.interfaces.find(i => !linkOf(doc, device.id, i.id));
  if (free) return free.id;
  if (isHost(device)) return null;
  const number = Math.max(0, ...device.interfaces.map(i => i.number)) + 1;
  device.interfaces.push(makeInterface(doc, device, number, undefined, KIND_DEFAULTS[kindOf(device)].adminUp));
  return `gi${number}`;
}

/** Cables two devices. Fails (with the reason) when a PC or server already has its one cable. */
export function connect(source: LabSpecDoc, from: string, to: string): { doc: LabSpecDoc; id: string } | { error: string } | null {
  if (from === to) return null;
  const doc = clone(source);
  const a = doc.devices.find(d => d.id === from), b = doc.devices.find(d => d.id === to);
  if (!a || !b) return null;
  const pa = freePort(doc, a), pb = freePort(doc, b);
  const full = !pa ? a : !pb ? b : null;
  if (full || !pa || !pb) return { error: `${full?.hostname ?? ""} มีพอร์ตเดียวและต่อสายไปแล้ว ถอดสายเดิมก่อน` };
  const id = nextId("l", doc.links.map(l => l.id));
  doc.links.push({ id, kind: "ethernet", a: { device: a.id, interface: pa }, b: { device: b.id, interface: pb } });
  return { doc, id };
}

export function setLinkEnd(source: LabSpecDoc, linkId: string, end: "a" | "b", iface: string): LabSpecDoc {
  const doc = clone(source);
  const link = doc.links.find(l => l.id === linkId);
  if (link) link[end].interface = iface;
  return doc;
}

export function removeLink(source: LabSpecDoc, linkId: string): LabSpecDoc {
  const doc = clone(source);
  doc.links = doc.links.filter(l => l.id !== linkId);
  return doc;
}

export function addPort(source: LabSpecDoc, deviceId: string): LabSpecDoc {
  const doc = clone(source);
  const device = doc.devices.find(d => d.id === deviceId);
  if (!device || isHost(device)) return source;
  device.interfaces.push(makeInterface(doc, device, Math.max(0, ...device.interfaces.map(i => i.number)) + 1, undefined,
    KIND_DEFAULTS[kindOf(device)].adminUp));
  return doc;
}

/** Removes a port and its cable, plan rows and objectives that use it. */
export function removePort(source: LabSpecDoc, deviceId: string, iface: string): LabSpecDoc {
  const doc = clone(source);
  const device = doc.devices.find(d => d.id === deviceId);
  if (!device || device.interfaces.length <= 1) return source;
  device.interfaces = device.interfaces.filter(i => i.id !== iface);
  const uses = (e: SpecEndpoint) => e.device === deviceId && e.interface === iface;
  doc.links = doc.links.filter(l => !uses(l.a) && !uses(l.b));
  if (doc.instructions.addressingPlan) doc.instructions.addressingPlan = doc.instructions.addressingPlan.filter(r => !uses(r));
  doc.objectives = doc.objectives.filter(o => {
    const p = o.params ?? {};
    if (o.check === "interfaceIpv4Equals") return !uses(p);
    if (o.check === "interfacesOperUp") return !(p.endpoints ?? []).some(uses);
    return true;
  });
  return doc;
}

export function updatePort(source: LabSpecDoc, deviceId: string, iface: string, patch: Partial<Pick<SpecInterface, "adminUp" | "ipv4">>): LabSpecDoc {
  const doc = clone(source);
  const port = doc.devices.find(d => d.id === deviceId)?.interfaces.find(i => i.id === iface);
  if (port) Object.assign(port, patch);
  return doc;
}

export function edit(source: LabSpecDoc, change: (doc: LabSpecDoc) => void): LabSpecDoc {
  const doc = clone(source);
  change(doc);
  return doc;
}

/**
 * Objectives the plan implies:
 * - each planned address (and each planned PC/server default gateway)
 * - each cable up/up when both ends are planned or a port on it starts shut down
 * - ping both ways across each cable between two planned ports, and between every two planned PCs/servers
 *   (the engine walks the packet through switches and routers, so those pings need routing to be right)
 */
export function suggestedObjectives(doc: LabSpecDoc): SpecObjective[] {
  const plan = doc.instructions.addressingPlan ?? [];
  const device = (id: string) => doc.devices.find(d => d.id === id);
  const host = (id: string) => device(id)?.hostname ?? id.toUpperCase();
  const planFor = (e: SpecEndpoint) => plan.find(r => r.device === e.device && r.interface === e.interface);
  const startsShut = (e: SpecEndpoint) => device(e.device)?.interfaces.find(i => i.id === e.interface)?.adminUp === false;
  const out: SpecObjective[] = [];
  for (const row of plan) {
    const pc = isHost(device(row.device));
    out.push({
      id: `${row.device}_${row.interface}_address`, check: "interfaceIpv4Equals",
      title: `ตั้ง IP ที่ ${host(row.device)} ${row.interface}`,
      description: `${host(row.device)} ${row.interface} มี IP ${row.address} mask ${row.mask}`,
      hints: [pc ? `ที่ command prompt ของ ${host(row.device)} ใช้คำสั่ง ipconfig <IP> <mask> <gateway>`
        : `เข้า interface configuration ของ ${row.interface} บน ${host(row.device)} แล้วใช้คำสั่ง ip address`],
      params: { device: row.device, interface: row.interface, address: row.address, mask: row.mask }
    });
    if (pc && row.gateway) out.push({
      id: `${row.device}_gateway`, check: "defaultGatewayEquals", title: `ตั้ง default gateway ของ ${host(row.device)}`,
      description: `${host(row.device)} ใช้ default gateway ${row.gateway}`,
      hints: [`ipconfig <IP> <mask> ${row.gateway}`], params: { device: row.device, gateway: row.gateway }
    });
  }
  for (const link of doc.links) {
    const a = planFor(link.a), b = planFor(link.b);
    const name = `${host(link.a.device)}–${host(link.b.device)}`;
    if ((a && b) || startsShut(link.a) || startsShut(link.b)) out.push({
      id: `${link.id}_up`, check: "interfacesOperUp", title: `สาย ${name} ทำงาน`,
      description: `พอร์ตทั้งสองฝั่งของสาย ${name} เป็น up/up`, hints: ["อย่าลืม no shutdown ทั้งสองฝั่ง"],
      params: { endpoints: [link.a, link.b] }
    });
    if (a && b) out.push({
      id: `${link.id}_ping`, check: "bidirectionalReachability", title: `${name} ping ถึงกัน`,
      description: `${host(link.a.device)} ping ${b.address} ได้ และ ${host(link.b.device)} ping ${a.address} ได้`, hints: [],
      params: { a: { device: link.a.device, address: a.address }, b: { device: link.b.device, address: b.address } }
    });
  }
  const hosts = plan.filter(r => isHost(device(r.device)));
  for (let i = 0; i < hosts.length; i++) for (let j = i + 1; j < hosts.length; j++) {
    const [a, b] = [hosts[i], hosts[j]];
    if (a.device === b.device) continue;
    const id = `${a.device}_${b.device}_ping`;
    if (out.some(o => o.id === id)) continue;
    out.push({
      id, check: "bidirectionalReachability", title: `${host(a.device)} ping ${host(b.device)} ได้`,
      description: `${host(a.device)} ping ${b.address} ได้ และ ${host(b.device)} ping ${a.address} ได้`,
      hints: ["ตรวจ IP และ default gateway ของทั้งสองเครื่อง", "ถ้าอยู่คนละเครือข่าย router ทุกตัวระหว่างทางต้องมี route ไปและกลับ (ip route)"],
      params: { a: { device: a.device, address: a.address }, b: { device: b.device, address: b.address } }
    });
  }
  return out;
}

export function newObjective(doc: LabSpecDoc, check: CheckId): SpecObjective {
  const id = nextId("obj", doc.objectives.map(o => o.id));
  const [d1, d2] = doc.devices;
  const ep = (d?: SpecDevice) => ({ device: d?.id ?? "", interface: d?.interfaces[0]?.id ?? "" });
  const pc = doc.devices.find(d => isHost(d));
  const params = check === "interfaceIpv4Equals" ? { ...ep(d1), address: "", mask: "255.255.255.0" }
    : check === "interfacesOperUp" ? { endpoints: [ep(d1)] }
    : check === "defaultGatewayEquals" ? { device: pc?.id ?? "", gateway: "" }
    : { a: { device: d1?.id ?? "", address: "" }, b: { device: d2?.id ?? "", address: "" } };
  return { id, check, title: CHECK_LABEL[check], description: CHECK_LABEL[check], hints: [], params };
}
