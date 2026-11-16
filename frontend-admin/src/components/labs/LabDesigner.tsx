import React, { useMemo, useRef, useState } from "react";
import { Cable, Lock, MousePointer2, Plus, Sparkles, Trash2 } from "lucide-react";
import { validateSpec } from "@netprime/lab-engine";
import {
  BOARD, CHECK_LABEL, CheckId, DEVICE_KINDS, DeviceKind, LabSpecDoc, PlanRow, SpecDevice, SpecObjective, SpecRoute, addDevice,
  addPort, connect, edit, isHost, kindOf, linkOf, moveDevice, newObjective, removeDevice, removeLink, removePort, setLinkEnd,
  suggestedObjectives, updateDevice, updatePort
} from "./labSpec";
import { DeviceIcon } from "./DeviceIcon";
import "./labDesigner.css";

/**
 * Visual lab designer: drag equipment from the palette onto the board, connect it with LAN cables, set each
 * port's starting state, then write the addressing plan and the objectives the server will check.
 * It edits the same JSON definition the "JSON" tab shows (labSpec.ts), so both views stay in sync.
 */

type Tool = "select" | "cable";
type Selection = { kind: "device"; id: string } | { kind: "link"; id: string } | null;

interface Props { doc: LabSpecDoc; onChange: (doc: LabSpecDoc) => void }

export const LabDesigner: React.FC<Props> = ({ doc, onChange }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<Selection>(null);
  const [cableFrom, setCableFrom] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const check = useMemo(() => validateSpec(doc), [doc]);
  const errors = check.ok ? [] : check.errors;

  const toBoard = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: p.y };
  };

  const place = (kind: DeviceKind, x?: number, y?: number) => {
    const info = DEVICE_KINDS.find(k => k.kind === kind)!;
    if (!info.ready) { setNotice(`${info.label} ยังใช้ไม่ได้ในตัวจำลองรุ่นนี้`); return; }
    const spot = x === undefined || y === undefined ? freeSpot(doc) : { x, y };
    const { doc: next, id } = addDevice(doc, kind, spot.x, spot.y);
    onChange(next);
    setSelected({ kind: "device", id });
    setNotice(null);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData("application/x-netprime-device") as DeviceKind;
    if (!kind) return;
    const p = toBoard(event.clientX, event.clientY);
    place(kind, p.x, p.y);
  };

  const onDevicePointerDown = (event: React.PointerEvent, device: SpecDevice) => {
    event.stopPropagation();
    if (tool === "cable") {
      if (!cableFrom) { setCableFrom(device.id); setPointer(toBoard(event.clientX, event.clientY)); return; }
      const made = connect(doc, cableFrom, device.id);
      setCableFrom(null); setPointer(null);
      if (made && "error" in made) setNotice(made.error);
      else if (made) { onChange(made.doc); setSelected({ kind: "link", id: made.id }); setNotice(null); }
      return;
    }
    const p = toBoard(event.clientX, event.clientY);
    drag.current = { id: device.id, dx: p.x - device.layout.x, dy: p.y - device.layout.y, moved: false };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    setSelected({ kind: "device", id: device.id });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (cableFrom) setPointer(toBoard(event.clientX, event.clientY));
    const d = drag.current;
    if (!d) return;
    const p = toBoard(event.clientX, event.clientY);
    d.moved = true;
    onChange(moveDevice(doc, d.id, p.x - d.dx, p.y - d.dy));
  };

  const onPointerUp = () => { drag.current = null; };

  const deleteSelected = () => {
    if (!selected) return;
    onChange(selected.kind === "device" ? removeDevice(doc, selected.id) : removeLink(doc, selected.id));
    setSelected(null);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.key === "Delete" || event.key === "Backspace") && selected) { event.preventDefault(); deleteSelected(); }
    if (event.key === "Escape") { setCableFrom(null); setPointer(null); setTool("select"); }
  };

  const device = selected?.kind === "device" ? doc.devices.find(d => d.id === selected.id) : undefined;
  const link = selected?.kind === "link" ? doc.links.find(l => l.id === selected.id) : undefined;
  const at = (id: string) => doc.devices.find(d => d.id === id)?.layout ?? { x: 0, y: 0 };

  return (
    <div className="np-ld">
      <div className="np-ld-toolbar">
        <div className="np-ld-palette" aria-label="อุปกรณ์">
          {DEVICE_KINDS.map(k => (
            <button key={k.kind} type="button" className={`np-ld-item${k.ready ? "" : " soon"}`} draggable={k.ready}
              onDragStart={e => { e.dataTransfer.setData("application/x-netprime-device", k.kind); e.dataTransfer.effectAllowed = "copy"; }}
              onClick={() => place(k.kind)}
              title={k.ready ? `ลาก ${k.label} ไปวางบนบอร์ด หรือคลิกเพื่อเพิ่ม` : `${k.label}: รอตัวจำลองรองรับ`}>
              <svg viewBox="-30 -24 60 48" width={44} height={34} aria-hidden="true"><DeviceIcon kind={k.kind} /></svg>
              <span>{k.label}</span>
              {!k.ready && <Lock size={11} className="np-ld-lock" />}
            </button>
          ))}
        </div>
        <div className="np-ld-tools">
          <button type="button" className={tool === "select" ? "active" : ""} onClick={() => { setTool("select"); setCableFrom(null); setPointer(null); }} title="เลือกและลากย้าย">
            <MousePointer2 size={15} /> เลือก/ย้าย
          </button>
          <button type="button" className={tool === "cable" ? "active" : ""} onClick={() => { setTool("cable"); setSelected(null); }} title="คลิกอุปกรณ์ต้นทาง แล้วคลิกปลายทาง">
            <Cable size={15} /> สาย LAN
          </button>
          <button type="button" onClick={deleteSelected} disabled={!selected} title="ลบสิ่งที่เลือก (Delete)"><Trash2 size={15} /> ลบ</button>
        </div>
      </div>
      {notice && <div className="np-ld-notice">{notice}</div>}
      {tool === "cable" && <div className="np-ld-hint">{cableFrom ? `ต่อสายจาก ${hostOf(doc, cableFrom)}: คลิกอุปกรณ์ปลายทาง (Esc ยกเลิก)` : "คลิกอุปกรณ์ต้นทางของสาย"}</div>}

      <div className="np-ld-main">
        <div className="np-ld-board" tabIndex={0} onKeyDown={onKeyDown} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }} onDrop={onDrop}>
          <svg ref={svgRef} viewBox={`0 0 ${BOARD.width} ${BOARD.height}`} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onPointerDown={() => { if (tool === "select") setSelected(null); }} role="application" aria-label="บอร์ดออกแบบเครือข่าย">
            <defs>
              <pattern id="np-ld-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" className="np-ld-dot" /></pattern>
            </defs>
            <rect width={BOARD.width} height={BOARD.height} fill="url(#np-ld-grid)" />
            {doc.devices.length === 0 && (
              <text x={BOARD.width / 2} y={BOARD.height / 2} textAnchor="middle" className="np-ld-empty">ลากอุปกรณ์จากแถบด้านบนมาวางที่นี่</text>
            )}
            {doc.links.map(l => {
              const a = at(l.a.device), b = at(l.b.device);
              const active = selected?.kind === "link" && selected.id === l.id;
              const label = (p: { x: number; y: number }, q: { x: number; y: number }, text: string) => (
                <text x={p.x + (q.x - p.x) * 0.22} y={p.y + (q.y - p.y) * 0.22 - 8} textAnchor="middle" className="np-ld-port">{text}</text>
              );
              return (
                <g key={l.id} className={`np-ld-link${active ? " active" : ""}`}
                  onPointerDown={e => { e.stopPropagation(); if (tool === "select") setSelected({ kind: "link", id: l.id }); }}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="np-ld-hit" />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="np-ld-wire" />
                  {label(a, b, l.a.interface)}
                  {label(b, a, l.b.interface)}
                </g>
              );
            })}
            {cableFrom && pointer && (() => { const a = at(cableFrom); return <line x1={a.x} y1={a.y} x2={pointer.x} y2={pointer.y} className="np-ld-pending" />; })()}
            {doc.devices.map(d => {
              const active = (selected?.kind === "device" && selected.id === d.id) || cableFrom === d.id;
              return (
                <g key={d.id} transform={`translate(${d.layout.x} ${d.layout.y})`} className={`np-ld-device${active ? " active" : ""}${tool === "cable" ? " cable" : ""}`}
                  onPointerDown={e => onDevicePointerDown(e, d)}>
                  <rect x={-40} y={-30} width={80} height={60} rx={14} className="np-ld-halo" />
                  <DeviceIcon kind={kindOf(d)} />
                  <text y={46} textAnchor="middle" className="np-ld-name">{d.hostname}</text>
                </g>
              );
            })}
          </svg>
        </div>

        <aside className="np-ld-inspector">
          {device ? <DevicePanel doc={doc} device={device} onChange={onChange} />
            : link ? <LinkPanel doc={doc} linkId={link.id} onChange={onChange} onDelete={() => { onChange(removeLink(doc, link.id)); setSelected(null); }} />
            : (
              <div className="np-ld-help">
                <strong>วิธีใช้</strong>
                <ol>
                  <li>ลาก Router, Switch, PC หรือ Server จากแถบด้านบนมาวางบนบอร์ด (หรือคลิกเพื่อเพิ่ม)</li>
                  <li>กด <b>สาย LAN</b> แล้วคลิกอุปกรณ์สองตัวเพื่อต่อสาย ระบบเลือกพอร์ตว่างให้ และเปลี่ยนพอร์ตได้ภายหลัง</li>
                  <li>คลิกอุปกรณ์เพื่อตั้งชื่อ เพิ่มพอร์ต และกำหนดสถานะตั้งต้นของแต่ละพอร์ต</li>
                  <li>ใส่แผน IP ด้านล่าง แล้วกด <b>สร้างโจทย์จากแผน IP</b></li>
                </ol>
                <p>Switch ทำงานแบบ layer 2 (VLAN เดียว) ส่วน PC และ Server มีพอร์ตเดียว ตั้ง IP, mask และ default gateway ได้ ผู้เรียนตั้งค่าเองด้วยคำสั่ง <code>ipconfig</code></p>
                <p>อุปกรณ์ {doc.devices.length} · สาย {doc.links.length} · โจทย์ {doc.objectives.length}</p>
              </div>
            )}
        </aside>
      </div>

      <LabDetails doc={doc} onChange={onChange} />

      <div className={`np-ld-check${errors.length ? " bad" : ""}`} role="status">
        {errors.length === 0 ? "นิยาม lab ถูกต้อง พร้อมลองทำและบันทึก" : (
          <>
            <strong>ยังต้องแก้ {errors.length} จุด</strong>
            <ul>{errors.slice(0, 8).map((e, i) => <li key={i}><code>{e.path}</code> {e.message}</li>)}</ul>
            {errors.length > 8 && <div>และอีก {errors.length - 8} จุด</div>}
          </>
        )}
      </div>
    </div>
  );
};

function hostOf(doc: LabSpecDoc, id: string) {
  return doc.devices.find(d => d.id === id)?.hostname ?? id;
}

/** A free spot near the middle of the board for a device added by click. */
function freeSpot(doc: LabSpecDoc) {
  const taken = (x: number, y: number) => doc.devices.some(d => Math.abs(d.layout.x - x) < 110 && Math.abs(d.layout.y - y) < 90);
  for (let ring = 0; ring < 6; ring++) {
    for (let i = 0; i < 8; i++) {
      const x = BOARD.width / 2 + Math.round(Math.cos((i / 8) * Math.PI * 2) * ring * 130);
      const y = BOARD.height / 2 + Math.round(Math.sin((i / 8) * Math.PI * 2) * ring * 100);
      if (x > 60 && x < BOARD.width - 60 && y > 60 && y < BOARD.height - 60 && !taken(x, y)) return { x, y };
      if (ring === 0) break;
    }
  }
  return { x: 120, y: 100 };
}

const KIND_TITLE: Record<DeviceKind, string> = { router: "Router", switch: "Switch", pc: "PC", server: "Server" };

const DevicePanel: React.FC<{ doc: LabSpecDoc; device: SpecDevice; onChange: (doc: LabSpecDoc) => void }> = ({ doc, device, onChange }) => {
  const kind = kindOf(device);
  const host = isHost(device);
  return (
    <div className="np-ld-panel">
      <div className="np-ld-panel-head">{KIND_TITLE[kind]} <code>{device.id}</code></div>
      <label className="np-ld-field">ชื่อเครื่อง (hostname)
        <input className="form-input" value={device.hostname} onChange={e => onChange(updateDevice(doc, device.id, { hostname: e.target.value }))} maxLength={63} />
      </label>
      {kind === "switch" && <div className="np-ld-hint">Switch ส่งต่อข้อมูลระหว่างทุกพอร์ตที่เปิดอยู่ (VLAN เดียว) พอร์ตไม่มี IP</div>}
      <div className="np-ld-subhead">{host ? "การ์ดเครือข่าย" : "พอร์ต"} <span>สถานะตอนเริ่ม lab</span></div>
      {device.interfaces.map(port => {
        const cable = linkOf(doc, device.id, port.id);
        const peer = cable ? (cable.a.device === device.id ? cable.b : cable.a) : null;
        return (
          <div key={port.id} className="np-ld-port-row">
            <div className="np-ld-port-name">
              <code>{port.id}</code>
              <span>{peer ? `ต่อกับ ${hostOf(doc, peer.device)} ${peer.interface}` : "ว่าง"}</span>
              {!host && <button type="button" className="np-ld-icon-btn" title="ลบพอร์ต" disabled={device.interfaces.length <= 1}
                onClick={() => onChange(removePort(doc, device.id, port.id))}><Trash2 size={13} /></button>}
            </div>
            {!host && (
              <label className="np-ld-check-row">
                <input type="checkbox" checked={port.adminUp} onChange={e => onChange(updatePort(doc, device.id, port.id, { adminUp: e.target.checked }))} />
                เปิดพอร์ตไว้แล้ว (no shutdown)
              </label>
            )}
            {kind !== "switch" && (
              <div className="np-ld-ip">
                <input className="form-input" placeholder="IP ตั้งต้น (เว้นว่าง = ไม่มี)" value={port.ipv4?.address ?? ""}
                  onChange={e => onChange(updatePort(doc, device.id, port.id, { ipv4: e.target.value ? { address: e.target.value, mask: port.ipv4?.mask ?? "255.255.255.0" } : null }))} />
                <input className="form-input" placeholder="mask" value={port.ipv4?.mask ?? ""} disabled={!port.ipv4}
                  onChange={e => onChange(updatePort(doc, device.id, port.id, { ipv4: port.ipv4 ? { ...port.ipv4, mask: e.target.value } : null }))} />
              </div>
            )}
          </div>
        );
      })}
      {host ? (
        <label className="np-ld-field">Default gateway ตั้งต้น
          <input className="form-input" placeholder="เว้นว่าง = ไม่มี" value={device.gateway ?? ""}
            onChange={e => onChange(updateDevice(doc, device.id, { gateway: e.target.value || null }))} />
        </label>
      ) : (
        <button type="button" className="tech-button-outline np-ld-small" onClick={() => onChange(addPort(doc, device.id))}><Plus size={13} /> เพิ่มพอร์ต</button>
      )}
      {kind === "router" && <RoutesEditor routes={device.routes ?? []} onChange={routes => onChange(updateDevice(doc, device.id, { routes }))} />}
    </div>
  );
};

/** Static routes a router starts with (most labs leave this empty and have learners add them with ip route). */
const RoutesEditor: React.FC<{ routes: SpecRoute[]; onChange: (routes: SpecRoute[]) => void }> = ({ routes, onChange }) => (
  <>
    <div className="np-ld-subhead">Static route ตั้งต้น <span>ปกติเว้นว่าง ให้ผู้เรียนใส่เอง</span></div>
    {routes.map((r, i) => (
      <div key={i} className="np-ld-port-row">
        <div className="np-ld-ip">
          <input className="form-input" placeholder="network" value={r.network} onChange={e => onChange(routes.map((x, j) => j === i ? { ...x, network: e.target.value } : x))} />
          <input className="form-input" placeholder="mask" value={r.mask} onChange={e => onChange(routes.map((x, j) => j === i ? { ...x, mask: e.target.value } : x))} />
        </div>
        <div className="np-ld-port-name">
          <input className="form-input" placeholder="next hop" value={r.nextHop} onChange={e => onChange(routes.map((x, j) => j === i ? { ...x, nextHop: e.target.value } : x))} />
          <button type="button" className="np-ld-icon-btn" title="ลบ route" onClick={() => onChange(routes.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
        </div>
      </div>
    ))}
    <button type="button" className="tech-button-outline np-ld-small" onClick={() => onChange([...routes, { network: "", mask: "255.255.255.0", nextHop: "" }])}><Plus size={13} /> เพิ่ม route</button>
  </>
);

const LinkPanel: React.FC<{ doc: LabSpecDoc; linkId: string; onChange: (doc: LabSpecDoc) => void; onDelete: () => void }> = ({ doc, linkId, onChange, onDelete }) => {
  const link = doc.links.find(l => l.id === linkId)!;
  const end = (side: "a" | "b") => {
    const e = link[side];
    const device = doc.devices.find(d => d.id === e.device);
    const options = device?.interfaces.filter(i => i.id === e.interface || !linkOf(doc, e.device, i.id)) ?? [];
    return (
      <label className="np-ld-field" key={side}>{hostOf(doc, e.device)}
        <select className="form-input" value={e.interface} onChange={ev => onChange(setLinkEnd(doc, link.id, side, ev.target.value))}>
          {options.map(i => <option key={i.id} value={i.id}>{i.id}</option>)}
        </select>
      </label>
    );
  };
  return (
    <div className="np-ld-panel">
      <div className="np-ld-panel-head">สาย LAN <code>{link.id}</code></div>
      {end("a")}{end("b")}
      <button type="button" className="tech-button-outline np-ld-small" onClick={onDelete}><Trash2 size={13} /> ถอดสาย</button>
    </div>
  );
};

/** Lab info, the addressing plan shown to learners, and the objectives the server checks. */
const LabDetails: React.FC<Props> = ({ doc, onChange }) => {
  const plan = doc.instructions.addressingPlan ?? [];
  const ports = doc.devices.flatMap(d => d.interfaces.map(i => ({ device: d.id, interface: i.id, label: `${d.hostname} ${i.id}` })));
  const setPlan = (rows: PlanRow[]) => onChange(edit(doc, d => { d.instructions.addressingPlan = rows; }));
  const setObjective = (index: number, next: SpecObjective) => onChange(edit(doc, d => { d.objectives[index] = next; }));
  const portValue = (device: string, iface: string) => `${device}/${iface}`;
  const splitPort = (value: string) => { const [device, iface] = value.split("/"); return { device, interface: iface }; };

  const generate = () => {
    const suggested = suggestedObjectives(doc);
    if (!suggested.length) return;
    if (doc.objectives.length && !window.confirm("แทนที่โจทย์เดิมทั้งหมดด้วยโจทย์ที่สร้างจากแผน IP?")) return;
    onChange(edit(doc, d => { d.objectives = suggested; }));
  };

  return (
    <div className="np-ld-details">
      <section>
        <h4>ข้อมูล lab</h4>
        <div className="np-ld-grid3">
          <label className="np-ld-field">รหัส lab<input className="form-input" value={doc.id} onChange={e => onChange(edit(doc, d => { d.id = e.target.value; }))} /></label>
          <label className="np-ld-field">ชื่อ lab (ที่ผู้เรียนเห็น)<input className="form-input" value={doc.title} onChange={e => onChange(edit(doc, d => { d.title = e.target.value; }))} /></label>
          <label className="np-ld-field">เวอร์ชันของโจทย์<input className="form-input" value={doc.version} onChange={e => onChange(edit(doc, d => { d.version = e.target.value; }))} /></label>
        </div>
        <label className="np-ld-field">โจทย์
          <textarea className="form-input" rows={3} value={doc.instructions.summary} onChange={e => onChange(edit(doc, d => { d.instructions.summary = e.target.value; }))} />
        </label>
        <label className="np-ld-field">หมายเหตุใต้โจทย์
          <input className="form-input" value={doc.instructions.scopeNote} onChange={e => onChange(edit(doc, d => { d.instructions.scopeNote = e.target.value; }))} />
        </label>
      </section>

      <section>
        <h4>แผน IP ที่ให้ผู้เรียน</h4>
        {plan.length > 0 && (
          <table className="np-ld-table">
            <thead><tr><th>อุปกรณ์ / พอร์ต</th><th>IP address</th><th>Subnet mask</th><th>Default gateway (PC/Server)</th><th /></tr></thead>
            <tbody>
              {plan.map((row, i) => (
                <tr key={i}>
                  <td><select className="form-input" value={portValue(row.device, row.interface)}
                    onChange={e => setPlan(plan.map((r, j) => { if (j !== i) return r; const next = { ...r, ...splitPort(e.target.value) }; if (!isHost(doc.devices.find(d => d.id === next.device))) delete next.gateway; return next; }))}>
                    {!ports.some(p => p.device === row.device && p.interface === row.interface) && <option value={portValue(row.device, row.interface)}>{row.device} {row.interface} (ไม่มีแล้ว)</option>}
                    {ports.map(p => <option key={portValue(p.device, p.interface)} value={portValue(p.device, p.interface)}>{p.label}</option>)}
                  </select></td>
                  <td><input className="form-input" value={row.address} placeholder="10.0.0.1" onChange={e => setPlan(plan.map((r, j) => j === i ? { ...r, address: e.target.value } : r))} /></td>
                  <td><input className="form-input" value={row.mask} onChange={e => setPlan(plan.map((r, j) => j === i ? { ...r, mask: e.target.value } : r))} /></td>
                  <td>{isHost(doc.devices.find(d => d.id === row.device))
                    ? <input className="form-input" value={row.gateway ?? ""} placeholder="ไม่บังคับ"
                        onChange={e => setPlan(plan.map((r, j) => { if (j !== i) return r; const { gateway: _old, ...rest } = r; return e.target.value ? { ...rest, gateway: e.target.value } : rest; }))} />
                    : <span className="np-ld-hint">-</span>}</td>
                  <td><button type="button" className="np-ld-icon-btn" title="ลบแถว" onClick={() => setPlan(plan.filter((_, j) => j !== i))}><Trash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="np-ld-row">
          <button type="button" className="tech-button-outline np-ld-small" disabled={!ports.length}
            onClick={() => { const used = new Set(plan.map(r => portValue(r.device, r.interface))); const p = ports.find(x => !used.has(portValue(x.device, x.interface))) ?? ports[0]; setPlan([...plan, { device: p.device, interface: p.interface, address: "", mask: "255.255.255.0" }]); }}>
            <Plus size={13} /> เพิ่มแถว
          </button>
        </div>
      </section>

      <section>
        <h4>โจทย์ที่ระบบตรวจ ({doc.objectives.length})</h4>
        <div className="np-ld-row">
          <button type="button" className="tech-button-primary np-ld-small" onClick={generate} disabled={!plan.length}><Sparkles size={13} /> สร้างโจทย์จากแผน IP</button>
          {(Object.keys(CHECK_LABEL) as CheckId[]).map(c => (
            <button key={c} type="button" className="tech-button-outline np-ld-small" disabled={!doc.devices.length}
              onClick={() => onChange(edit(doc, d => { d.objectives.push(newObjective(doc, c)); }))}><Plus size={13} /> {CHECK_LABEL[c]}</button>
          ))}
        </div>
        {doc.objectives.map((o, i) => (
          <div key={i} className="np-ld-objective">
            <div className="np-ld-objective-head">
              <span className="np-ld-badge">{CHECK_LABEL[o.check] ?? o.check}</span>
              <code>{o.id}</code>
              <button type="button" className="np-ld-icon-btn" title="ลบโจทย์" onClick={() => onChange(edit(doc, d => { d.objectives.splice(i, 1); }))}><Trash2 size={13} /></button>
            </div>
            <div className="np-ld-grid2">
              <label className="np-ld-field">หัวข้อ<input className="form-input" value={o.title} onChange={e => setObjective(i, { ...o, title: e.target.value })} /></label>
              <label className="np-ld-field">รายละเอียด<input className="form-input" value={o.description} onChange={e => setObjective(i, { ...o, description: e.target.value })} /></label>
            </div>
            <ParamsEditor objective={o} doc={doc} ports={ports} onChange={next => setObjective(i, next)} />
            <label className="np-ld-field">คำใบ้ (บรรทัดละข้อ)
              <textarea className="form-input" rows={2} value={o.hints.join("\n")} onChange={e => setObjective(i, { ...o, hints: e.target.value.split("\n").filter(h => h.trim()) })} />
            </label>
          </div>
        ))}
      </section>
    </div>
  );
};

const ParamsEditor: React.FC<{
  objective: SpecObjective; doc: LabSpecDoc; ports: { device: string; interface: string; label: string }[]; onChange: (o: SpecObjective) => void;
}> = ({ objective: o, doc, ports, onChange }) => {
  const p = o.params ?? {};
  const set = (params: any) => onChange({ ...o, params });
  const portSelect = (value: { device: string; interface: string }, change: (v: { device: string; interface: string }) => void) => (
    <select className="form-input" value={`${value.device}/${value.interface}`} onChange={e => { const [device, iface] = e.target.value.split("/"); change({ device, interface: iface }); }}>
      {!ports.some(x => x.device === value.device && x.interface === value.interface) && <option value={`${value.device}/${value.interface}`}>เลือกพอร์ต</option>}
      {ports.map(x => <option key={`${x.device}/${x.interface}`} value={`${x.device}/${x.interface}`}>{x.label}</option>)}
    </select>
  );
  const deviceSelect = (value: string, change: (v: string) => void) => (
    <select className="form-input" value={value} onChange={e => change(e.target.value)}>
      {!doc.devices.some(d => d.id === value) && <option value={value}>เลือกอุปกรณ์</option>}
      {doc.devices.map(d => <option key={d.id} value={d.id}>{d.hostname}</option>)}
    </select>
  );
  if (o.check === "interfaceIpv4Equals") return (
    <div className="np-ld-grid3">
      <label className="np-ld-field">พอร์ต{portSelect(p, v => set({ ...p, ...v }))}</label>
      <label className="np-ld-field">IP ที่ต้องเป็น<input className="form-input" value={p.address ?? ""} onChange={e => set({ ...p, address: e.target.value })} /></label>
      <label className="np-ld-field">mask<input className="form-input" value={p.mask ?? ""} onChange={e => set({ ...p, mask: e.target.value })} /></label>
    </div>
  );
  if (o.check === "interfacesOperUp") {
    const endpoints: { device: string; interface: string }[] = p.endpoints ?? [];
    return (
      <div className="np-ld-field">พอร์ตที่ต้อง up/up
        <div className="np-ld-chips">
          {endpoints.map((e, i) => (
            <span key={i} className="np-ld-chip">
              {portSelect(e, v => set({ endpoints: endpoints.map((x, j) => j === i ? v : x) }))}
              <button type="button" className="np-ld-icon-btn" title="เอาออก" onClick={() => set({ endpoints: endpoints.filter((_, j) => j !== i) })}><Trash2 size={12} /></button>
            </span>
          ))}
          <button type="button" className="tech-button-outline np-ld-small" disabled={!ports.length} onClick={() => set({ endpoints: [...endpoints, { device: ports[0].device, interface: ports[0].interface }] })}><Plus size={12} /> พอร์ต</button>
        </div>
      </div>
    );
  }
  if (o.check === "defaultGatewayEquals") return (
    <div className="np-ld-grid2">
      <label className="np-ld-field">PC / Server
        <select className="form-input" value={p.device ?? ""} onChange={e => set({ ...p, device: e.target.value })}>
          {!doc.devices.some(d => d.id === p.device && isHost(d)) && <option value={p.device ?? ""}>เลือกเครื่อง</option>}
          {doc.devices.filter(d => isHost(d)).map(d => <option key={d.id} value={d.id}>{d.hostname}</option>)}
        </select>
      </label>
      <label className="np-ld-field">Default gateway ที่ต้องเป็น<input className="form-input" value={p.gateway ?? ""} onChange={e => set({ ...p, gateway: e.target.value })} /></label>
    </div>
  );
  const a = p.a ?? { device: "", address: "" }, b = p.b ?? { device: "", address: "" };
  return (
    <div className="np-ld-grid2">
      <label className="np-ld-field">ฝั่ง A: อุปกรณ์ และ IP ของมัน
        <span className="np-ld-pair">{deviceSelect(a.device, v => set({ a: { ...a, device: v }, b }))}<input className="form-input" value={a.address} onChange={e => set({ a: { ...a, address: e.target.value }, b })} /></span>
      </label>
      <label className="np-ld-field">ฝั่ง B: อุปกรณ์ และ IP ของมัน
        <span className="np-ld-pair">{deviceSelect(b.device, v => set({ a, b: { ...b, device: v } }))}<input className="form-input" value={b.address} onChange={e => set({ a, b: { ...b, address: e.target.value } })} /></span>
      </label>
    </div>
  );
};

export default LabDesigner;
