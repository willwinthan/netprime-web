import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

/**
 * Small SVG chart kit for the analysis dashboard (no chart library). Follows the data-viz rules:
 * one axis, thin 2px lines, rounded 4px bar ends anchored at the baseline, 2px gaps between cells,
 * round ticks, thinned labels, a crosshair + tooltip on hover, a legend when two series share a
 * plot, text in text colours (never the series colour), and status colours always with an icon.
 *
 * Palette (validated with the dataviz validator, light surface): current = orange #eb6834,
 * comparison = blue #2a78d6 (dashed), sequential = the blue ramp below.
 */
export const VIZ = {
  current: "#eb6834",
  previous: "#2a78d6",
  grid: "rgba(15, 23, 42, 0.07)",
  axis: "#8a8985",
  track: "#f0efec",
  text: "var(--text-primary)",
  muted: "var(--text-secondary)",
  good: "#006300",
  critical: "#d03b3b",
  ramp: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]
};

const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** "2026-11-05" → "5 พ.ย." · "2026-11" → "พ.ย. 69". */
export function bucketLabel(key: string, long = false): string {
  const [y, m, d] = key.split("-").map(Number);
  const month = THAI_MONTHS[(m || 1) - 1];
  const yy = String(((y || 0) + 543) % 100).padStart(2, "0");
  if (!d) return `${month} ${long ? y + 543 : yy}`;
  return long ? `${d} ${month} ${y + 543}` : `${d} ${month}`;
}

/** Up to ~5 round ticks from 0 (steps of 1, 2, 2.5 or 5 × 10ⁿ); counts never get fractional ticks. */
export function niceTicks(max: number, integer = true, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map(f => f * pow).find(s => s >= raw) ?? 10 * pow;
  if (integer) step = Math.max(1, Math.ceil(step));
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

/** Width of an element, kept in sync with ResizeObserver so SVG text never stretches. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const tooltipStyle: React.CSSProperties = {
  position: "absolute", pointerEvents: "none", background: "#fff", border: "1px solid rgba(15,23,42,0.1)", borderRadius: 8,
  boxShadow: "0 6px 18px rgba(15,23,42,0.12)", padding: "8px 10px", fontSize: 12, lineHeight: 1.5, whiteSpace: "nowrap", zIndex: 5, color: "var(--text-primary)"
};

export const LegendSwatch: React.FC<{ color: string; dashed?: boolean; label: string }> = ({ color, dashed, label }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
    <svg width="18" height="8" aria-hidden><line x1="1" y1="4" x2="17" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "4 3" : undefined} strokeLinecap="round" /></svg>
    {label}
  </span>
);

// ---------- Delta ----------

/** Change vs the previous period with an arrow icon and words, never colour alone. */
export const Delta: React.FC<{ current: number; previous: number; compact?: boolean }> = ({ current, previous, compact }) => {
  if (!previous) {
    return <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12, color: "var(--text-muted)" }}>
      <Minus size={13} aria-hidden />{current ? "ช่วงก่อนไม่มีข้อมูล" : "ไม่มีข้อมูลทั้งสองช่วง"}</span>;
  }
  const pct = ((current - previous) / previous) * 100;
  const flat = Math.abs(pct) < 0.5;
  const up = pct > 0;
  const color = flat ? "var(--text-muted)" : up ? VIZ.good : VIZ.critical;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const text = flat ? "เท่าเดิม" : `${up ? "เพิ่มขึ้น" : "ลดลง"} ${Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)).toLocaleString("th-TH") : Math.abs(pct).toFixed(1)}%`;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12, fontWeight: 600, color }}>
    <Icon size={14} aria-hidden />{text}{!compact && <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>&nbsp;จากช่วงก่อน</span>}</span>;
};

// ---------- Sparkline ----------

export const Sparkline: React.FC<{ values: number[]; color?: string; height?: number; label: string }> = ({ values, color = VIZ.current, height = 34, label }) => {
  const [ref, width] = useWidth<HTMLDivElement>();
  const max = Math.max(...values, 0);
  const pts = values.map((v, i) => [values.length > 1 ? (i / (values.length - 1)) * (width - 4) + 2 : width / 2, height - 3 - (max ? (v / max) * (height - 8) : 0)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return (
    <div ref={ref} style={{ width: "100%", height }} role="img" aria-label={label}>
      {width > 0 && values.length > 0 && (
        <svg width={width} height={height}>
          <line x1={0} x2={width} y1={height - 3} y2={height - 3} stroke={VIZ.grid} />
          <path d={`${d}L${last[0]},${height - 3}L${pts[0][0]},${height - 3}Z`} fill={color} opacity={0.08} />
          <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={last[0]} cy={last[1]} r={3} fill={color} stroke="#fff" strokeWidth={2} />
        </svg>
      )}
    </div>
  );
};

// ---------- Trend (current vs previous) ----------

export interface TrendPoint { key: string; value: number; previous_key: string | null; previous: number | null }

export const TrendChart: React.FC<{
  data: TrendPoint[]; format: (v: number) => string; integer?: boolean; height?: number;
  currentLabel: string; previousLabel: string; showPrevious: boolean;
}> = ({ data, format, integer = true, height = 280, currentLabel, previousLabel, showPrevious }) => {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 12, right: 16, bottom: 30, left: 56 };
  const max = Math.max(...data.map(p => Math.max(p.value, showPrevious ? p.previous ?? 0 : 0)), 0);
  const ticks = niceTicks(max, integer);
  const top = ticks[ticks.length - 1] || 1;
  const innerW = Math.max(1, width - pad.left - pad.right), innerH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (data.length > 1 ? (i / (data.length - 1)) * innerW : innerW / 2);
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  const path = (get: (p: TrendPoint) => number | null) => data.map((p, i) => {
    const v = get(p);
    return v === null ? "" : `${i && get(data[i - 1]) !== null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  }).join("");
  // Room for one label per ~72px; the last point always gets its own label when it fits.
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 72))));
  const labelIdx = data.map((_, i) => i).filter(i => i % every === 0 && (data.length - 1 - i >= every * 0.6 || i === data.length - 1));
  if (data.length > 1 && !labelIdx.includes(data.length - 1) && (data.length - 1) % every >= every * 0.6) labelIdx.push(data.length - 1);

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = (e.target as SVGRectElement).getBoundingClientRect();
    const rel = (e.clientX - box.left) / Math.max(1, box.width);
    setHover(Math.max(0, Math.min(data.length - 1, Math.round(rel * (data.length - 1)))));
  };
  const h = hover !== null ? data[hover] : null;

  return (
    <div ref={ref} style={{ position: "relative", width: "100%", height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${currentLabel}${showPrevious ? ` เทียบ ${previousLabel}` : ""}`}>
          {ticks.map(t => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "rgba(15,23,42,0.18)" : VIZ.grid} />
              <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={VIZ.axis}>{format(t)}</text>
            </g>
          ))}
          {labelIdx.map(i => (
            <text key={i} x={x(i)} y={height - 8} textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"} fontSize={11} fill={VIZ.axis}>{bucketLabel(data[i].key)}</text>
          ))}
          <path d={`${path(p => p.value)}L${x(data.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={VIZ.current} opacity={0.07} />
          {showPrevious && <path d={path(p => p.previous)} fill="none" stroke={VIZ.previous} strokeWidth={1.75} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />}
          <path d={path(p => p.value)} fill="none" stroke={VIZ.current} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {data.length === 1 && <circle cx={x(0)} cy={y(data[0].value)} r={4} fill={VIZ.current} />}
          {h && (
            <g aria-hidden>
              <line x1={x(hover!)} x2={x(hover!)} y1={pad.top} y2={pad.top + innerH} stroke="rgba(15,23,42,0.25)" strokeDasharray="3 3" />
              {showPrevious && h.previous !== null && <circle cx={x(hover!)} cy={y(h.previous)} r={4} fill={VIZ.previous} stroke="#fff" strokeWidth={2} />}
              <circle cx={x(hover!)} cy={y(h.value)} r={4.5} fill={VIZ.current} stroke="#fff" strokeWidth={2} />
            </g>
          )}
          <rect x={pad.left} y={pad.top} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {h && (
        <div style={{ ...tooltipStyle, top: pad.top, left: Math.min(Math.max(x(hover!) + 12, 0), Math.max(0, width - 210)) }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{bucketLabel(h.key, true)}</div>
          <div><LegendSwatch color={VIZ.current} label={currentLabel} /> <strong style={{ marginLeft: 6 }}>{format(h.value)}</strong></div>
          {showPrevious && h.previous_key && h.previous !== null && <>
            <div><LegendSwatch color={VIZ.previous} dashed label={`${bucketLabel(h.previous_key, true)}`} /> <strong style={{ marginLeft: 6 }}>{format(h.previous)}</strong></div>
            <Delta current={h.value} previous={h.previous} compact />
          </>}
        </div>
      )}
    </div>
  );
};

// ---------- Horizontal bars ----------

export interface BarItem { label: string; value: number; hint?: string }

/** Ranked horizontal bars; identity is the label, so one colour for all bars. */
export const HBarList: React.FC<{ items: BarItem[]; format: (v: number) => string; color?: string; empty: string }> = ({ items, format, color = VIZ.current, empty }) => {
  const max = Math.max(...items.map(i => i.value), 0);
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!items.length || !max) return <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "16px 0" }}>{empty}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {items.map(item => (
        <div key={item.label} title={item.hint} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "4px 12px", alignItems: "center" }}>
          <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>{format(item.value)} <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>{total ? `${Math.round((item.value / total) * 100)}%` : ""}</span></span>
          <div style={{ gridColumn: "1 / -1", height: 8, background: VIZ.track, borderRadius: 4 }}>
            <div style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, height: "100%", background: color, borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  );
};

// ---------- Funnel ----------

export const Funnel: React.FC<{ stages: Array<{ label: string; count: number }> }> = ({ stages }) => {
  const first = stages[0]?.count ?? 0;
  if (!first) return <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "16px 0" }}>ยังไม่มีผู้สมัครใหม่ในช่วงนี้</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {stages.map((s, i) => {
        const prev = i ? stages[i - 1].count : s.count;
        const ofFirst = (s.count / first) * 100;
        return (
          <div key={s.label}>
            {i > 0 && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "2px 0 4px 8px" }}>
                ↓ ไปต่อ {prev ? Math.round((s.count / prev) * 100) : 0}% · หลุด {Math.max(0, prev - s.count).toLocaleString("th-TH")} คน
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "4px 12px", alignItems: "baseline" }}>
              <span style={{ fontSize: 13 }}>{s.label}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{s.count.toLocaleString("th-TH")} <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>{Math.round(ofFirst)}%</span></span>
            </div>
            <div style={{ height: 14, background: VIZ.track, borderRadius: 4, marginTop: 4 }}>
              <div style={{ width: `${Math.max(1, ofFirst)}%`, height: "100%", background: VIZ.ramp[Math.min(VIZ.ramp.length - 1, 5 - i)], borderRadius: 4 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ---------- Heatmap ----------

const DAYS = [[1, "จ."], [2, "อ."], [3, "พ."], [4, "พฤ."], [5, "ศ."], [6, "ส."], [0, "อา."]] as const;
const DAY_NAMES: Record<number, string> = { 0: "อาทิตย์", 1: "จันทร์", 2: "อังคาร", 3: "พุธ", 4: "พฤหัสบดี", 5: "ศุกร์", 6: "เสาร์" };

/** Weekday × hour (Thai time) on the sequential ramp; empty cells stay the neutral track colour. */
export const Heatmap: React.FC<{ cells: Array<{ dow: number; hour: number; events: number; users: number }> }> = ({ cells }) => {
  const [hover, setHover] = useState<{ dow: number; hour: number; x: number; y: number } | null>(null);
  const map = useMemo(() => new Map(cells.map(c => [`${c.dow}-${c.hour}`, c])), [cells]);
  const max = Math.max(...cells.map(c => c.events), 0);
  const step = (v: number) => v <= 0 || !max ? -1 : Math.min(VIZ.ramp.length - 1, Math.floor((v / max) * VIZ.ramp.length - 1e-9));
  const peak = cells.reduce<typeof cells[number] | null>((best, c) => !best || c.events > best.events ? c : best, null);
  const hc = hover ? map.get(`${hover.dow}-${hover.hour}`) : null;
  if (!max) return <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "16px 0" }}>ยังไม่มีกิจกรรมการเรียนในช่วงนี้</div>;
  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "grid", gridTemplateColumns: "32px repeat(24, minmax(0, 1fr))", gap: 2, alignItems: "center" }} onMouseLeave={() => setHover(null)}>
        {DAYS.map(([dow, label]) => (
          <React.Fragment key={dow}>
            <span style={{ fontSize: 11, color: VIZ.axis }}>{label}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const cell = map.get(`${dow}-${hour}`);
              const s = step(cell?.events ?? 0);
              return <div key={hour} aria-label={`${DAY_NAMES[dow]} ${hour}:00 กิจกรรม ${cell?.events ?? 0}`}
                onMouseEnter={e => { const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect(); setHover({ dow, hour, x: b.left - r.left, y: b.top - r.top }); }}
                style={{ aspectRatio: "1 / 1", minHeight: 10, borderRadius: 2, background: s < 0 ? VIZ.track : VIZ.ramp[s],
                  outline: hover?.dow === dow && hover?.hour === hour ? "2px solid #0b0b0b" : undefined }} />;
            })}
          </React.Fragment>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ fontSize: 10, color: VIZ.axis, textAlign: "center" }}>{hour % 3 === 0 ? hour : ""}</span>)}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap", fontSize: 12, color: "var(--text-secondary)" }}>
        <span>{peak && `ช่วงที่ใช้งานมากที่สุด: วัน${DAY_NAMES[peak.dow]} ${peak.hour}:00–${peak.hour + 1}:00 น.`}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>น้อย
          {VIZ.ramp.map(c => <span key={c} style={{ width: 12, height: 12, borderRadius: 2, background: c, display: "inline-block" }} />)}มาก</span>
      </div>
      {hover && (
        <div style={{ ...tooltipStyle, top: hover.y - 54, left: Math.max(0, hover.x - 60) }}>
          <div style={{ fontWeight: 600 }}>วัน{DAY_NAMES[hover.dow]} {hover.hour}:00–{hover.hour + 1}:00 น.</div>
          <div>กิจกรรมการเรียน {(hc?.events ?? 0).toLocaleString("th-TH")} ครั้ง · ผู้เรียน {(hc?.users ?? 0).toLocaleString("th-TH")} คน</div>
        </div>
      )}
    </div>
  );
};

// ---------- Capacity bars ----------

export const CapacityBars: React.FC<{ rows: Array<{ id: string; title: string; start_date: string; capacity: number; taken: number; confirmed: number; waitlist: number }> }> = ({ rows }) => {
  if (!rows.length) return <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "16px 0" }}>ไม่มีรอบอบรมที่กำลังจะมาถึง</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {rows.map(r => {
        const pct = r.capacity ? Math.min(100, (r.taken / r.capacity) * 100) : 0;
        const confirmedPct = r.capacity ? Math.min(100, (r.confirmed / r.capacity) * 100) : 0;
        const full = r.taken >= r.capacity;
        return (
          <div key={r.id}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title} <span style={{ color: "var(--text-muted)" }}>· {bucketLabel(r.start_date)}</span></span>
              <span style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{r.taken}/{r.capacity} ที่{full ? " · เต็ม" : ""}{r.waitlist ? <span style={{ fontWeight: 400, color: "var(--text-muted)" }}> · รอคิว {r.waitlist}</span> : null}</span>
            </div>
            <div style={{ position: "relative", height: 10, background: VIZ.track, borderRadius: 4, marginTop: 4 }} title={`ยืนยันแล้ว ${r.confirmed} · รอตรวจ ${r.taken - r.confirmed}`}>
              <div style={{ position: "absolute", inset: 0, width: `${pct}%`, background: VIZ.ramp[2], borderRadius: 4 }} />
              <div style={{ position: "absolute", inset: 0, width: `${confirmedPct}%`, background: VIZ.ramp[5], borderRadius: 4 }} />
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 14, fontSize: 12, color: "var(--text-secondary)" }}>
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><span style={{ width: 12, height: 8, borderRadius: 2, background: VIZ.ramp[5] }} />ยืนยัน/ชำระแล้ว</span>
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><span style={{ width: 12, height: 8, borderRadius: 2, background: VIZ.ramp[2] }} />รอตรวจ</span>
      </div>
    </div>
  );
};
