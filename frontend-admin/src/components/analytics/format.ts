/** Shared formatting for the analytics dashboard and reports. */

export type NavTarget = { tab: string; id?: string };

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s} วินาที`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} ชม. ${m} นาที` : `${m} นาที`;
}

export const baht = (value: number) => `฿${Math.round(value || 0).toLocaleString("th-TH")}`;

/** Relative time in Thai ("3 นาทีที่แล้ว"); accepts ISO or D1 "YYYY-MM-DD HH:MM:SS" (UTC). */
export function timeAgo(value: string | null | undefined): string {
  if (!value) return "-";
  const t = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z").getTime();
  if (isNaN(t)) return value;
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return "เมื่อสักครู่";
  if (diff < 3600) return `${Math.floor(diff / 60)} นาทีที่แล้ว`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ชั่วโมงที่แล้ว`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)} วันที่แล้ว`;
  return new Date(t).toLocaleDateString("th-TH", { dateStyle: "medium" });
}

export type RangeKey = "7d" | "30d" | "90d" | "12m" | "custom";
export const RANGES: Array<[RangeKey, string]> = [["7d", "7 วัน"], ["30d", "30 วัน"], ["90d", "90 วัน"], ["12m", "12 เดือน"], ["custom", "กำหนดเอง"]];

export function rangeQuery(range: RangeKey, from: string, to: string): string {
  return range === "custom" ? `range=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : `range=${range}`;
}
