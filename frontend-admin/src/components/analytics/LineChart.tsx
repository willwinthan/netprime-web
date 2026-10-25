import React, { useMemo, useState } from "react";

export interface ChartPoint { key: string; value: number }

const THAI_DAY = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", timeZone: "UTC" });
const THAI_MONTH = new Intl.DateTimeFormat("th-TH", { month: "short", year: "2-digit", timeZone: "UTC" });

/** "2026-10-25" → "25 ต.ค.", "2026-10" → "ต.ค. 69". */
export function bucketLabel(key: string): string {
  const date = new Date((key.length === 7 ? key + "-01" : key) + "T00:00:00Z");
  if (isNaN(date.getTime())) return key;
  return key.length === 7 ? THAI_MONTH.format(date) : THAI_DAY.format(date);
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const f = value / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

/**
 * Small dependency-free SVG line chart (one series) with gridlines, sparse axis labels and a hover readout.
 */
export const LineChart: React.FC<{
  data: ChartPoint[];
  format?: (value: number) => string;
  height?: number;
  label: string;
  color?: string;
}> = ({ data, format = v => v.toLocaleString("th-TH"), height = 240, label, color = "var(--primary)" }) => {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const pad = { top: 16, right: 16, bottom: 28, left: 56 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = useMemo(() => niceMax(Math.max(0, ...data.map(d => d.value))), [data]);
  const x = (i: number) => pad.left + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const path = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ");
  const area = data.length ? `${path} L${x(data.length - 1).toFixed(1)},${pad.top + innerH} L${x(0).toFixed(1)},${pad.top + innerH} Z` : "";
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => t * max);
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));
  const total = data.reduce((s, d) => s + d.value, 0);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    if (!data.length) return;
    const i = Math.round(((px - pad.left) / innerW) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };

  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={`${label}: รวม ${format(total)}`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block", overflow: "visible" }}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="rgba(15,23,42,0.08)" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">{format(Math.round(t * 100) / 100)}</text>
          </g>
        ))}
        {data.map((d, i) => i % labelEvery === 0 || i === data.length - 1 ? (
          <text key={d.key} x={x(i)} y={height - 8} textAnchor="middle" fontSize="11" fill="var(--text-muted)">{bucketLabel(d.key)}</text>
        ) : null)}
        {area && <path d={area} fill={color} opacity={0.08} />}
        {path && <path d={path} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />}
        {data.length <= 40 && data.map((d, i) => <circle key={d.key} cx={x(i)} cy={y(d.value)} r={hover === i ? 5 : 3} fill={color} />)}
        {hover !== null && data[hover] && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke={color} strokeDasharray="4 4" opacity={0.5} />
            <g transform={`translate(${Math.min(Math.max(x(hover) - 70, pad.left), width - pad.right - 140)}, ${pad.top})`}>
              <rect width="140" height="44" rx="8" fill="#fff" stroke="rgba(15,23,42,0.12)" />
              <text x="10" y="18" fontSize="11" fill="var(--text-muted)">{bucketLabel(data[hover].key)}</text>
              <text x="10" y="35" fontSize="14" fontWeight="700" fill="var(--text-primary)">{format(data[hover].value)}</text>
            </g>
          </g>
        )}
      </svg>
    </figure>
  );
};
