// Pure, timezone-safe date helpers for the training-session calendar.
//
// Sessions store calendar dates as "YYYY-MM-DD". They are local calendar days, so every
// calculation here works on whole-day numbers (days since 1970-01-01 computed with
// Date.UTC) and never constructs a Date from the string in the browser's local zone.
// No imports: tests/calendar-dates.test.mjs loads this file directly with Node type stripping.

export interface YearMonth { year: number; month: number } // month: 1-12

export interface CalendarRange { id: string; start: string; end: string }

export interface WeekSegment<T extends CalendarRange = CalendarRange> {
  event: T;
  /** 0 = Monday … 6 = Sunday, inclusive. */
  startCol: number;
  span: number;
  lane: number;
  /** The session started before / continues after this week row. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];
export const THAI_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
/** Monday-first, matching the grid columns. */
export const THAI_WEEKDAYS_SHORT = ["จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส.", "อา."];
export const THAI_WEEKDAYS = ["วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์", "วันอาทิตย์"];

const MS_PER_DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** Parses "YYYY-MM-DD" (extra time parts are ignored). Returns null for invalid dates. */
export function parseYmd(value: string | null | undefined): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || "");
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

/** Whole days since 1970-01-01 for a calendar date (no timezone involved). */
export function dayNumber(value: string): number {
  const p = parseYmd(value);
  if (!p) return NaN;
  return Math.round(Date.UTC(p.year, p.month - 1, p.day) / MS_PER_DAY);
}

export function fromDayNumber(n: number): string {
  const d = new Date(n * MS_PER_DAY);
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addDays(value: string, days: number): string {
  return fromDayNumber(dayNumber(value) + days);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayMon0(value: string): number {
  // 1970-01-01 was a Thursday (index 3 when Monday = 0).
  return (((dayNumber(value) + 3) % 7) + 7) % 7;
}

export function addMonths(ym: YearMonth, delta: number): YearMonth {
  const index = ym.year * 12 + (ym.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function monthOf(value: string): YearMonth | null {
  const p = parseYmd(value);
  return p ? { year: p.year, month: p.month } : null;
}

export function firstOfMonth(ym: YearMonth): string { return ymd(ym.year, ym.month, 1); }
export function lastOfMonth(ym: YearMonth): string { return ymd(ym.year, ym.month, daysInMonth(ym.year, ym.month)); }

/** Today's date in the viewer's local calendar (not UTC), as "YYYY-MM-DD". */
export function todayYmd(now: Date = new Date()): string {
  return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** "ตุลาคม 2569" (Buddhist Era year). */
export function thaiMonthLabel(ym: YearMonth): string {
  return `${THAI_MONTHS[ym.month - 1]} ${ym.year + 543}`;
}

/** "วันพุธที่ 14 ตุลาคม 2569" */
export function thaiLongDate(value: string): string {
  const p = parseYmd(value);
  if (!p) return value;
  return `${THAI_WEEKDAYS[weekdayMon0(value)]}ที่ ${p.day} ${THAI_MONTHS[p.month - 1]} ${p.year + 543}`;
}

/**
 * Monday-first weeks covering the month. Each week is 7 dates; days outside the month
 * are included so bars can run across the edges. 4–6 rows depending on the month.
 */
export function monthWeeks(ym: YearMonth): string[][] {
  const first = firstOfMonth(ym);
  let cursor = addDays(first, -weekdayMon0(first));
  const last = dayNumber(lastOfMonth(ym));
  const weeks: string[][] = [];
  while (dayNumber(cursor) <= last) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) week.push(addDays(cursor, i));
    weeks.push(week);
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

/** A range with end before start (bad data) is treated as a single day. */
function bounds(event: CalendarRange): [number, number] | null {
  const s = dayNumber(event.start);
  if (isNaN(s)) return null;
  const e = dayNumber(event.end);
  return [s, isNaN(e) || e < s ? s : e];
}

export function overlaps(event: CalendarRange, from: string, to: string): boolean {
  const b = bounds(event);
  return !!b && b[0] <= dayNumber(to) && b[1] >= dayNumber(from);
}

export function coversDay(event: CalendarRange, day: string): boolean {
  return overlaps(event, day, day);
}

/** Stable order: earlier start first, then longer sessions, then id. */
export function compareRanges(a: CalendarRange, b: CalendarRange): number {
  const ba = bounds(a), bb = bounds(b);
  if (!ba || !bb) return ba ? -1 : bb ? 1 : 0;
  return ba[0] - bb[0] || (bb[1] - bb[0]) - (ba[1] - ba[0]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Bars for one week row (weekStart must be a Monday). Each event gets the lowest lane
 * free for all of its days in this week, so multi-day sessions never overlap.
 */
export function layoutWeek<T extends CalendarRange>(weekStart: string, events: T[]): WeekSegment<T>[] {
  const ws = dayNumber(weekStart);
  const we = ws + 6;
  const lanes: boolean[][] = []; // lanes[lane][col] = taken
  const segments: WeekSegment<T>[] = [];
  for (const event of events.filter(e => overlaps(e, weekStart, fromDayNumber(we))).sort(compareRanges)) {
    const [s, e] = bounds(event)!;
    const startCol = Math.max(s, ws) - ws;
    const endCol = Math.min(e, we) - ws;
    let lane = 0;
    for (; ; lane++) {
      lanes[lane] ??= Array(7).fill(false);
      let free = true;
      for (let c = startCol; c <= endCol; c++) if (lanes[lane][c]) { free = false; break; }
      if (free) break;
    }
    for (let c = startCol; c <= endCol; c++) lanes[lane][c] = true;
    segments.push({ event, startCol, span: endCol - startCol + 1, lane, continuesBefore: s < ws, continuesAfter: e > we });
  }
  return segments;
}

/** Events active on each date between from..to (inclusive), sorted. Only dates with events. */
export function groupByDay<T extends CalendarRange>(events: T[], from: string, to: string): Array<{ date: string; events: T[] }> {
  const start = dayNumber(from), end = dayNumber(to);
  const groups: Array<{ date: string; events: T[] }> = [];
  const sorted = events.filter(e => overlaps(e, from, to)).sort(compareRanges);
  for (let n = start; n <= end; n++) {
    const date = fromDayNumber(n);
    const active = sorted.filter(e => coversDay(e, date));
    if (active.length) groups.push({ date, events: active });
  }
  return groups;
}

/**
 * Agenda grouping: each event listed once, under its first day inside from..to
 * (a session that began last month appears on the 1st).
 */
export function groupByFirstDay<T extends CalendarRange>(events: T[], from: string, to: string): Array<{ date: string; events: T[] }> {
  const map = new Map<string, T[]>();
  const from0 = dayNumber(from);
  for (const event of events.filter(e => overlaps(e, from, to)).sort(compareRanges)) {
    const date = fromDayNumber(Math.max(bounds(event)![0], from0));
    if (!map.has(date)) map.set(date, []);
    map.get(date)!.push(event);
  }
  return Array.from(map.entries()).sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, list]) => ({ date, events: list }));
}

/** Number of calendar days a range covers (1 for a single-day session). */
export function rangeLength(event: CalendarRange): number {
  const b = bounds(event);
  return b ? b[1] - b[0] + 1 : 0;
}
