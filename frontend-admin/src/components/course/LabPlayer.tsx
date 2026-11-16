import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CheckCircle, Circle, RotateCcw } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { appendChunk, createSession, ipv4ToString, prefixToMask, TRANSCRIPT_LIMITS, validateSpec } from "@netprime/lab-engine";
import type { DerivedState, Lab, LabController, TranscriptChunk } from "@netprime/lab-engine";
import { useApi } from "../../hooks/useApi";
import { DeviceIcon } from "../labs/DeviceIcon";

/**
 * Virtual Lab player (lazy chunk). The lab runs in the browser for instant console output; what the learner typed
 * is sent to PUT /student/lessons/:id/lab, where the server replays it and decides pass/fail. Only that server
 * answer completes the lesson. Saved work is restored by replaying the saved keystrokes.
 */

export interface LabPayload {
  id: string;
  title: string;
  description: string | null;
  version: number;
  spec: unknown;
  progress: { transcript: unknown[]; passed_count: number; total: number; attempts: number; passed_at: string | null } | null;
}

interface GradeResponse {
  passed: boolean; passed_count: number; total: number; saved: boolean; completed?: boolean;
  passed_at?: string | null; progress_percent?: number | null;
}

interface Props {
  /** null: staff trying a lab from the library; nothing is sent to the server. */
  lessonId: string | null;
  lab: LabPayload;
  preview: boolean;
  completed: boolean;
  onCompleted: (progressPercent: number | null) => void;
  /** The lab was changed by staff while open: reload the lesson to get the new version. */
  onReload: () => void;
}

const SAVE_DELAY_MS = 1500;
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

export const LabPlayer: React.FC<Props> = ({ lessonId, lab: payload, preview, completed, onCompleted, onReload }) => {
  const parsed = useMemo(() => validateSpec(payload.spec), [payload.spec]);
  if (!parsed.ok) {
    return <p role="alert" style={{ color: "var(--danger)" }}>lab นี้ตั้งค่าไม่ถูกต้อง กรุณาแจ้งผู้สอน ({parsed.errors[0]?.path}: {parsed.errors[0]?.message})</p>;
  }
  return <LabSession key={`${payload.id}:${payload.version}`} lessonId={lessonId} payload={payload} lab={parsed.lab}
    preview={preview} completed={completed} onCompleted={onCompleted} onReload={onReload} />;
};

const LabSession: React.FC<Omit<Props, "lab"> & { payload: LabPayload; lab: Lab }> = ({ lessonId, payload, lab, preview, completed, onCompleted, onReload }) => {
  const api = useApi();
  const [session, setSession] = useState(() => startSession(lab, payload.progress?.transcript));
  const { controller, transcript } = session;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const devices = controller.deviceIds;
  const [active, setActive] = useState(devices[0]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [done, setDone] = useState(completed || !!payload.progress?.passed_at);
  const [tooLong, setTooLong] = useState(false);
  const timer = useRef<number | null>(null);
  const dirty = useRef(false);
  const latest = useRef({ save: async () => {} });

  const save = async () => {
    if (!dirty.current || changed || !lessonId) return;
    dirty.current = false;
    setSaveState("saving");
    try {
      const res = await api.request<GradeResponse>(`/student/lessons/${lessonId}/lab`, { method: "PUT", body: JSON.stringify({ lab_version: payload.version, transcript }) });
      setSaveState(res.saved ? "saved" : "idle");
      setError(null);
      if (res.completed && !done) {
        setDone(true);
        onCompleted(res.progress_percent ?? null);
      }
    } catch (err: any) {
      if (/ถูกแก้ไข/.test(err?.message ?? "")) setChanged(true);
      else { setError(err.message); dirty.current = true; }
      setSaveState("error");
    }
  };
  latest.current.save = save;

  // Every keystroke is recorded, then sent to the server a moment after the learner stops typing.
  const record = (deviceId: string, data: string) => {
    const used = transcript.reduce((n, [, text]) => n + text.length, 0);
    if (used + data.length > TRANSCRIPT_LIMITS.maxChars) { setTooLong(true); return; }
    appendChunk(transcript, deviceId, data);
    controller.input(deviceId, data);
    dirty.current = true;
    if (!lessonId) return;
    setSaveState("pending");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => latest.current.save(), SAVE_DELAY_MS);
  };

  // Send unsaved work when the learner leaves the lesson.
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
    if (dirty.current) void latest.current.save();
  }, []);

  const restart = async () => {
    if (!window.confirm("เริ่ม lab ใหม่ทั้งหมด? อุปกรณ์จะกลับเป็นค่าเริ่มต้น (ถ้าเคยทำผ่านแล้ว ผลที่ผ่านยังอยู่)")) return;
    if (timer.current) window.clearTimeout(timer.current);
    dirty.current = false;
    try {
      if (!preview && lessonId) await api.post(`/student/lessons/${lessonId}/lab/reset`, {});
      setSession(startSession(lab, []));
      setTooLong(false);
      setSaveState("idle");
    } catch (err: any) {
      setError(err.message);
    }
  };

  const { assessment, derived } = snapshot;
  const withGateway = lab.instructions.addressingPlan?.some(row => row.gateway !== undefined) ?? false;
  return (
    <div className="np-lab">
      <div className="glass-card np-lab-brief">
        <p style={{ margin: 0 }}>{lab.instructions.summary}</p>
        {lab.instructions.addressingPlan?.length ? (
          <table className="np-lab-plan">
            <thead><tr><th>อุปกรณ์</th><th>อินเทอร์เฟซ</th><th>IP address</th><th>Subnet mask</th>{withGateway && <th>Default gateway</th>}</tr></thead>
            <tbody>{lab.instructions.addressingPlan.map(row => (
              <tr key={`${row.deviceId}-${row.interfaceId}`}>
                <td>{lab.initialState.devices[row.deviceId]?.config.hostname ?? row.deviceId.toUpperCase()}</td><td>{row.interfaceId}</td>
                <td>{ipv4ToString(row.address)}</td><td>{prefixToMask(row.prefixLength)}</td>
                {withGateway && <td>{row.gateway === undefined ? "" : ipv4ToString(row.gateway)}</td>}
              </tr>
            ))}</tbody>
          </table>
        ) : null}
        {lab.instructions.scopeNote && <p className="np-lab-note">{lab.instructions.scopeNote}</p>}
      </div>

      <div className="np-lab-grid">
        <div className="np-lab-consoles">
          <div className="np-lab-tabs" role="tablist">
            {devices.map(id => (
              <button key={id} type="button" role="tab" aria-selected={active === id} className={active === id ? "active" : ""} onClick={() => setActive(id)}>
                {hostname(snapshot.runtime, id)}
              </button>
            ))}
          </div>
          {devices.map(id => (
            <DeviceConsole key={`${session.id}-${id}`} controller={controller} output={session.output} deviceId={id} visible={active === id} onInput={record} />
          ))}
          <div className="np-lab-status">
            <span>{!lessonId ? "โหมดทดลอง: ไม่ส่งผลเข้าระบบ" : preview ? "โหมดดูตัวอย่าง: ตรวจผลได้แต่ไม่บันทึก" : SAVE_LABEL[saveState]}</span>
            <button type="button" className="tech-button-outline" onClick={restart}><RotateCcw size={14} /> เริ่มใหม่</button>
          </div>
        </div>

        <div className="np-lab-side">
          <Topology lab={lab} derived={derived} />
          <div className="glass-card np-lab-objectives">
            <h4>สิ่งที่ต้องทำ ({assessment.passedCount}/{assessment.total})</h4>
            <ul>
              {lab.objectives.map(objective => {
                const result = assessment.results.find(r => r.id === objective.id);
                return (
                  <li key={objective.id} className={result?.passed ? "passed" : ""}>
                    {result?.passed ? <CheckCircle size={16} /> : <Circle size={16} />}
                    <div>
                      <strong>{objective.title}</strong>
                      {objective.description && <p>{objective.description}</p>}
                      {!result?.passed && objective.hints?.length ? <details><summary>คำใบ้</summary><ul>{objective.hints.map(h => <li key={h}>{h}</li>)}</ul></details> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>

      {done && <div className="np-lab-done"><CheckCircle size={18} /> ระบบตรวจแล้ว: ทำ lab นี้ผ่านครบทุกข้อ บทเรียนนี้บันทึกว่าเรียนจบแล้ว</div>}
      {!done && !preview && lessonId && assessment.total > 0 && assessment.passedCount === assessment.total && saveState !== "saved" &&
        <div className="np-lab-note">ครบทุกข้อแล้ว กำลังส่งให้ระบบตรวจ...</div>}
      {tooLong && <p role="alert" style={{ color: "var(--danger)" }}>พิมพ์ใน lab นี้ยาวเกินที่ระบบเก็บได้ กด "เริ่มใหม่" แล้วทำอีกครั้ง</p>}
      {error && <p role="alert" style={{ color: "var(--danger)" }}>บันทึกไม่สำเร็จ: {error}</p>}
      {changed && (
        <div role="alert" className="np-lab-note">
          ผู้สอนเพิ่งแก้ lab นี้ งานที่ทำไว้ใช้กับ lab ใหม่ไม่ได้ <button type="button" className="tech-button-outline" onClick={onReload}>โหลด lab ใหม่</button>
        </div>
      )}
    </div>
  );
};

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "งานใน lab จะบันทึกอัตโนมัติ",
  pending: "กำลังรอบันทึก...",
  saving: "กำลังบันทึกและตรวจผล...",
  saved: "บันทึกแล้ว",
  error: "บันทึกไม่สำเร็จ จะลองใหม่เมื่อพิมพ์ต่อ"
};

let sessionCounter = 0;
const SCROLLBACK_CHARS = 200_000;

/**
 * Console output of one session, kept per device so a terminal that mounts later (or mounts twice, as in
 * React StrictMode) still shows everything, including the output of replayed saved work.
 */
class ConsoleOutput {
  private text = new Map<string, string>();
  private listeners = new Map<string, (text: string) => void>();
  constructor(controller: LabController) {
    for (const id of controller.deviceIds) controller.attachSink(id, chunk => this.push(id, chunk));
  }
  private push(deviceId: string, chunk: string) {
    const all = (this.text.get(deviceId) ?? "") + chunk;
    this.text.set(deviceId, all.length > SCROLLBACK_CHARS ? all.slice(-SCROLLBACK_CHARS) : all);
    this.listeners.get(deviceId)?.(chunk);
  }
  /** Writes what the device has printed so far, then every new chunk, until the returned function is called. */
  attach(deviceId: string, write: (text: string) => void): () => void {
    const existing = this.text.get(deviceId);
    if (existing) write(existing);
    this.listeners.set(deviceId, write);
    return () => { if (this.listeners.get(deviceId) === write) this.listeners.delete(deviceId); };
  }
}

/** A new live lab with saved work replayed (keystrokes in their original order across devices). */
function startSession(lab: Lab, saved: unknown[] | undefined): { id: number; controller: LabController; output: ConsoleOutput; transcript: TranscriptChunk[] } {
  const controller = createSession(lab);
  const output = new ConsoleOutput(controller);
  const transcript: TranscriptChunk[] = [];
  const devices = new Set(controller.deviceIds);
  for (const chunk of saved ?? []) {
    if (!Array.isArray(chunk) || typeof chunk[0] !== "string" || typeof chunk[1] !== "string" || !devices.has(chunk[0])) continue;
    appendChunk(transcript, chunk[0], chunk[1]);
    controller.input(chunk[0], chunk[1]);
  }
  return { id: ++sessionCounter, controller, output, transcript };
}

function hostname(runtime: { lab: unknown }, deviceId: string): string {
  const devices = (runtime.lab as { devices?: Record<string, { config?: { hostname?: string } }> }).devices;
  return devices?.[deviceId]?.config?.hostname ?? deviceId.toUpperCase();
}

const DeviceConsole: React.FC<{ controller: LabController; output: ConsoleOutput; deviceId: string; visible: boolean; onInput: (deviceId: string, data: string) => void }> =
  ({ controller, output, deviceId, visible, onInput }) => {
    const host = useRef<HTMLDivElement>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const inputRef = useRef(onInput);
    inputRef.current = onInput;

    useEffect(() => {
      const term = new Terminal({
        cursorBlink: true, fontSize: 14, convertEol: false, scrollback: 2000,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        theme: { background: "#0b1220", foreground: "#e5e7eb" }
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current!);
      termRef.current = term; fitRef.current = fit;
      const data = term.onData(text => inputRef.current(deviceId, text));
      const resize = term.onResize(({ cols, rows }) => controller.resize(deviceId, cols, rows));
      const detach = output.attach(deviceId, text => term.write(text));
      const observer = new ResizeObserver(() => fitNow(host.current, fit, term));
      observer.observe(host.current!);
      return () => { observer.disconnect(); data.dispose(); resize.dispose(); detach(); term.dispose(); };
    }, [controller, output, deviceId]);

    useEffect(() => {
      if (!visible) return;
      fitNow(host.current, fitRef.current, termRef.current);
      termRef.current?.focus();
    }, [visible]);

    // The padding sits on the wrapper: FitAddon measures the host element, which must have none.
    return <div className="np-lab-term" style={{ display: visible ? "block" : "none" }}><div ref={host} className="np-lab-term-host" /></div>;
  };

function fitNow(host: HTMLDivElement | null, fit: FitAddon | null, term: Terminal | null) {
  if (!host || !fit || !term || host.clientWidth === 0 || host.clientHeight === 0) return;
  const size = fit.proposeDimensions();
  if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows) || size.cols < 2 || size.rows < 2) return;
  if (size.cols !== term.cols || size.rows !== term.rows) term.resize(size.cols, size.rows);
}

/** Devices at their layout positions; each link is green when up, with interface addresses at its ends. */
export const Topology: React.FC<{ lab: Lab; derived: DerivedState }> = ({ lab, derived }) => {
  const ids = lab.initialState.deviceOrder;
  // The designer board can pack devices closely; spread them out (up to 1.8x) so the closest two are ~230 apart
  // and the port labels fit between them.
  const raw = ids.map(id => lab.layout[id] ?? { x: 0, y: 0 });
  let closest = Infinity;
  for (let i = 0; i < raw.length; i++) for (let j = i + 1; j < raw.length; j++)
    closest = Math.min(closest, Math.hypot(raw[i].x - raw[j].x, raw[i].y - raw[j].y));
  const spread = Number.isFinite(closest) && closest > 0 ? Math.min(1.8, Math.max(1, 230 / closest)) : 1;
  const at = (id: string) => { const p = lab.layout[id] ?? { x: 0, y: 0 }; return { x: p.x * spread, y: p.y * spread }; };
  const points = ids.map(at);
  const padX = 110, padTop = 60, padBottom = 75;
  const minX = Math.min(...points.map(p => p.x)) - padX, maxX = Math.max(...points.map(p => p.x)) + padX;
  const minY = Math.min(...points.map(p => p.y)) - padTop, maxY = Math.max(...points.map(p => p.y)) + padBottom;
  const label = (deviceId: string, interfaceId: string, x: number, y: number) => {
    const ip = derived.interfaces[deviceId]?.[interfaceId]?.ipv4;
    return (
      <text x={x} y={ip ? y - 8 : y} textAnchor="middle" className="np-lab-if">
        <tspan x={x}>{interfaceId}</tspan>
        {ip && <tspan x={x} dy={17}>{`${ipv4ToString(ip.address)}/${ip.prefixLength}`}</tspan>}
      </text>
    );
  };
  return (
    <div className="glass-card np-lab-topology">
      <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} role="img" aria-label="แผนผังเครือข่าย">
        {lab.initialState.links.map(link => {
          const a = at(link.a.deviceId), b = at(link.b.deviceId);
          const up = derived.links[link.id]?.operUp;
          // Port labels sit on the cable just outside each device box, nudged to one side of the line.
          const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const along = Math.min(0.4, 80 / length);
          const side = { x: (-(b.y - a.y) / length) * 18, y: ((b.x - a.x) / length) * 18 };
          const spot = (from: { x: number; y: number }, to: { x: number; y: number }) =>
            ({ x: from.x + (to.x - from.x) * along + side.x, y: from.y + (to.y - from.y) * along + side.y + 5 });
          const pa = spot(a, b), pb = spot(b, a);
          return (
            <g key={link.id}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={up ? "#16a34a" : "#dc2626"} strokeWidth={4} strokeDasharray={up ? undefined : "10 8"} />
              {label(link.a.deviceId, link.a.interfaceId, pa.x, pa.y)}
              {label(link.b.deviceId, link.b.interfaceId, pb.x, pb.y)}
            </g>
          );
        })}
        {ids.map(id => {
          const p = at(id);
          const device = lab.initialState.devices[id];
          return (
            <g key={id} transform={`translate(${p.x} ${p.y})`}>
              <rect x={-44} y={-30} width={88} height={60} rx={12} className="np-lab-node" />
              <g transform="scale(1.25)"><DeviceIcon kind={device?.kind ?? "router"} /></g>
              <text y={54} textAnchor="middle" className="np-lab-node-label">{device?.config.hostname ?? id.toUpperCase()}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

export default LabPlayer;
