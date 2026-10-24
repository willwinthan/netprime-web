// Unit tests for the training-session calendar date helpers (pure functions, no browser).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays, addMonths, dayNumber, daysInMonth, groupByDay, groupByFirstDay, layoutWeek, monthWeeks, parseYmd,
  thaiLongDate, thaiMonthLabel, todayYmd, weekdayMon0
} from '../frontend-admin/src/components/calendar/calendarDates.ts';

test('parses YYYY-MM-DD and rejects invalid dates', () => {
  assert.deepEqual(parseYmd('2026-10-24'), { year: 2026, month: 10, day: 24 });
  assert.deepEqual(parseYmd('2026-10-24 09:00:00'), { year: 2026, month: 10, day: 24 });
  assert.equal(parseYmd('2026-02-30'), null);
  assert.equal(parseYmd('2026-13-01'), null);
  assert.equal(parseYmd(''), null);
  assert.equal(parseYmd(null), null);
});

test('day arithmetic crosses months, years and leap days', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(dayNumber('1970-01-02'), 1);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
});

test('weekday index is Monday-first and independent of the process timezone', () => {
  assert.equal(weekdayMon0('2026-10-24'), 5); // Saturday
  assert.equal(weekdayMon0('2026-10-26'), 0); // Monday
  assert.equal(weekdayMon0('2026-11-01'), 6); // Sunday
  const tz = process.env.TZ;
  try {
    for (const zone of ['Asia/Bangkok', 'America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      process.env.TZ = zone;
      assert.equal(weekdayMon0('2026-10-24'), 5, zone);
      assert.equal(addDays('2026-10-31', 1), '2026-11-01', zone);
    }
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test('todayYmd uses the local calendar day', () => {
  assert.equal(todayYmd(new Date(2026, 9, 24, 23, 59)), '2026-10-24');
  assert.equal(todayYmd(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
});

test('months: navigation and Thai labels with Buddhist year', () => {
  assert.deepEqual(addMonths({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
  assert.deepEqual(addMonths({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
  assert.deepEqual(addMonths({ year: 2026, month: 10 }, -22), { year: 2024, month: 12 });
  assert.equal(thaiMonthLabel({ year: 2026, month: 10 }), 'ตุลาคม 2569');
  assert.equal(thaiLongDate('2026-10-24'), 'วันเสาร์ที่ 24 ตุลาคม 2569');
});

test('month grid starts on Monday and covers the whole month', () => {
  const weeks = monthWeeks({ year: 2026, month: 10 }); // 1 Oct 2026 is a Thursday
  assert.equal(weeks[0][0], '2026-09-28');
  assert.equal(weeks.at(-1)[6], '2026-11-01');
  assert.equal(weeks.length, 5);
  assert.ok(weeks.every(w => w.length === 7 && weekdayMon0(w[0]) === 0));
  assert.equal(monthWeeks({ year: 2027, month: 2 }).length, 4); // Feb 2027 starts on Monday, 28 days
  assert.equal(monthWeeks({ year: 2026, month: 8 }).length, 6); // Aug 2026 starts Saturday, 31 days
});

test('layoutWeek splits multi-day sessions per week and stacks overlaps', () => {
  const events = [
    { id: 'a', start: '2026-10-21', end: '2026-10-27' }, // Wed → next Tue
    { id: 'b', start: '2026-10-22', end: '2026-10-22' },
    { id: 'c', start: '2026-10-24', end: '2026-10-25' },
    { id: 'z', start: '2026-11-10', end: '2026-11-11' }  // other week
  ];
  const week = layoutWeek('2026-10-19', events);
  const byId = Object.fromEntries(week.map(s => [s.event.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['a', 'b', 'c']);
  assert.deepEqual({ ...byId.a, event: undefined }, { event: undefined, startCol: 2, span: 5, lane: 0, continuesBefore: false, continuesAfter: true });
  assert.equal(byId.b.lane, 1);
  assert.equal(byId.c.lane, 1); // b ended on Thursday, so lane 1 is free again on Saturday
  const next = layoutWeek('2026-10-26', events);
  assert.equal(next.length, 1);
  assert.deepEqual([next[0].startCol, next[0].span, next[0].continuesBefore, next[0].continuesAfter], [0, 2, true, false]);
});

test('end before start is treated as a single day', () => {
  const [seg] = layoutWeek('2026-10-19', [{ id: 'x', start: '2026-10-21', end: '2026-10-20' }]);
  assert.equal(seg.span, 1);
});

test('agenda groups each session once under its first visible day', () => {
  const events = [
    { id: 'late', start: '2026-10-28', end: '2026-11-02' },
    { id: 'early', start: '2026-09-29', end: '2026-10-02' },
    { id: 'mid', start: '2026-10-15', end: '2026-10-15' }
  ];
  const groups = groupByFirstDay(events, '2026-10-01', '2026-10-31');
  assert.deepEqual(groups.map(g => [g.date, g.events.map(e => e.id)]), [
    ['2026-10-01', ['early']], ['2026-10-15', ['mid']], ['2026-10-28', ['late']]
  ]);
  const days = groupByDay(events, '2026-10-01', '2026-10-03');
  assert.deepEqual(days.map(g => g.date), ['2026-10-01', '2026-10-02']);
});
