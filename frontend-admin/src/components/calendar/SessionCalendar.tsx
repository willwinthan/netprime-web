import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatDateRange } from "../site-admin/ui";
import {
  CalendarRange, YearMonth, THAI_MONTHS_SHORT, THAI_WEEKDAYS_SHORT, weekdayMon0, addDays, addMonths, coversDay, compareRanges, firstOfMonth,
  groupByFirstDay, lastOfMonth, layoutWeek, monthOf, monthWeeks, parseYmd, thaiLongDate, thaiMonthLabel, todayYmd
} from "./calendarDates";
import "./SessionCalendar.css";

// ==========================================
// Lightweight month calendar for training sessions (admin + public site).
// Month grid with multi-day bars on wide screens; agenda list below 640px.
// ==========================================

export interface CalendarTone { fg: string; bg: string; border?: string }

export interface CalendarEvent extends CalendarRange {
  title: string;
  color: CalendarTone;
  /** Short secondary text: time, mode, location. */
  meta?: string;
  badges?: Array<{ label: string; fg: string; bg: string }>;
  /** Extra text for screen readers on the bar (status, seats). */
  description?: string;
  /** Cancelled sessions: drawn struck through. */
  muted?: boolean;
}

interface Props {
  events: CalendarEvent[];
  onEventClick: (id: string) => void;
  /** Clicking/pressing Enter on a day (admin: start a new session on that date). */
  onDayClick?: (date: string) => void;
  /** Text for the day action inside the day popover, e.g. "เพิ่มรอบอบรมวันนี้". */
  dayActionLabel?: string;
  /** Rendered under each event in the day popover and agenda list (e.g. a seat bar). */
  renderExtra?: (event: CalendarEvent) => React.ReactNode;
  legend?: Array<{ label: string } & CalendarTone>;
  initialMonth?: YearMonth;
  /** Called whenever the visible month changes (lets a parent restore it after remounting). */
  onMonthChange?: (month: YearMonth) => void;
  loading?: boolean;
  emptyText?: string;
  /** Bars shown per day before "+N". */
  maxLanes?: number;
  /** Extra controls placed at the right of the toolbar. */
  toolbar?: React.ReactNode;
  label?: string;
}

const NARROW_QUERY = "(max-width: 639px)";

export function useNarrowScreen(query = NARROW_QUERY): boolean {
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);
  return narrow;
}

/** First month worth showing: the current month, or the month of the next session when it starts later. */
export function suggestMonth(events: CalendarRange[], today = todayYmd()): YearMonth {
  const current = monthOf(today)!;
  if (events.some(e => e.end >= firstOfMonth(current) && e.start <= lastOfMonth(current))) return current;
  const next = events.filter(e => e.start >= today).sort(compareRanges)[0];
  return (next && monthOf(next.start)) || current;
}

const sameMonth = (a: YearMonth, b: YearMonth) => a.year === b.year && a.month === b.month;

export const SessionCalendar: React.FC<Props> = ({
  events, onEventClick, onDayClick, dayActionLabel, renderExtra, legend, initialMonth, onMonthChange, loading, emptyText,
  maxLanes = 3, toolbar, label = "ปฏิทินรอบอบรม"
}) => {
  const today = todayYmd();
  const narrow = useNarrowScreen();
  const [month, setMonth] = useState<YearMonth>(() => initialMonth ?? monthOf(today)!);
  const [focusDate, setFocusDate] = useState<string>(() => firstOfMonth(initialMonth ?? monthOf(today)!));
  const [popover, setPopover] = useState<{ date: string; trigger: HTMLElement | null } | null>(null);
  const focusPending = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // The parent may learn a better starting month after data loads.
  const initialKey = initialMonth ? `${initialMonth.year}-${initialMonth.month}` : "";
  useEffect(() => { if (initialMonth && !sameMonth(initialMonth, month)) goTo(initialMonth); }, [initialKey]);
  useEffect(() => { onMonthChange?.(month); }, [month.year, month.month]);

  const weeks = useMemo(() => monthWeeks(month), [month]);
  const valid = useMemo(() => events.filter(e => parseYmd(e.start)), [events]);
  const monthStart = firstOfMonth(month), monthEnd = lastOfMonth(month);
  const inMonth = (date: string) => date >= monthStart && date <= monthEnd;
  const monthEvents = useMemo(() => valid.filter(e => e.start <= monthEnd && (e.end || e.start) >= monthStart), [valid, monthStart, monthEnd]);
  // The grid also shows the leading/trailing days of the neighbouring months.
  const gridStart = weeks[0][0], gridEnd = weeks[weeks.length - 1][6];
  const gridEvents = useMemo(() => valid.filter(e => e.start <= gridEnd && (e.end || e.start) >= gridStart), [valid, gridStart, gridEnd]);

  function goTo(next: YearMonth, focus?: string) {
    setMonth(next);
    setPopover(null);
    const today0 = todayYmd();
    setFocusDate(focus ?? (sameMonth(monthOf(today0)!, next) ? today0 : firstOfMonth(next)));
  }

  // Keep the roving focus target inside the visible month.
  useEffect(() => { if (!inMonth(focusDate)) setFocusDate(firstOfMonth(month)); }, [month]);

  useLayoutEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${focusDate}"]`)?.focus();
  });

  const moveFocus = (date: string) => {
    focusPending.current = true;
    const target = monthOf(date)!;
    if (!sameMonth(target, month)) goTo(target, date);
    else setFocusDate(date);
  };

  const onDayKey = (event: React.KeyboardEvent<HTMLElement>, date: string) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in steps) { event.preventDefault(); moveFocus(addDays(date, steps[event.key])); return; }
    if (event.key === "Home") { event.preventDefault(); moveFocus(addDays(date, -weekdayMon0(date))); return; }
    if (event.key === "End") { event.preventDefault(); moveFocus(addDays(date, 6 - weekdayMon0(date))); return; }
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const target = addMonths(month, event.key === "PageUp" ? -1 : 1);
      const day = Math.min(parseYmd(date)!.day, parseYmd(lastOfMonth(target))!.day);
      moveFocus(`${firstOfMonth(target).slice(0, 8)}${String(day).padStart(2, "0")}`);
    }
  };

  const dayEvents = (date: string) => valid.filter(e => coversDay(e, date)).sort(compareRanges);

  const activateDay = (date: string, trigger: HTMLElement) => {
    if (onDayClick) onDayClick(date);
    else if (dayEvents(date).length) setPopover({ date, trigger });
  };

  const header = (
    <div className="scal-toolbar">
      <div className="scal-nav">
        <button type="button" className="scal-btn" onClick={() => goTo(addMonths(month, -1))} aria-label="เดือนก่อนหน้า">‹</button>
        <button type="button" className="scal-btn scal-btn-today" onClick={() => goTo(monthOf(today)!)}>วันนี้</button>
        <button type="button" className="scal-btn" onClick={() => goTo(addMonths(month, 1))} aria-label="เดือนถัดไป">›</button>
        <h3 className="scal-title" aria-live="polite">{thaiMonthLabel(month)}</h3>
      </div>
      {toolbar && <div className="scal-tools">{toolbar}</div>}
    </div>
  );

  const legendView = legend && legend.length > 0 && (
    <ul className="scal-legend" aria-label="คำอธิบายสี">
      {legend.map(item => (
        <li key={item.label}><span className="scal-swatch" style={{ background: item.bg, borderColor: item.border || item.fg }} />{item.label}</li>
      ))}
    </ul>
  );

  if (narrow) {
    const groups = groupByFirstDay(monthEvents, monthStart, monthEnd);
    return (
      <section className="scal scal-agenda-mode" aria-label={label}>
        {header}
        {legendView}
        {loading ? <p className="scal-empty">กำลังโหลด…</p> : groups.length === 0 ? (
          <p className="scal-empty">{emptyText || `ไม่มีรอบอบรมในเดือน${thaiMonthLabel(month)}`}</p>
        ) : (
          <ol className="scal-agenda">
            {groups.map(group => (
              <li key={group.date} className="scal-agenda-day">
                <h4 className={group.date === today ? "scal-agenda-date is-today" : "scal-agenda-date"}>{thaiLongDate(group.date)}{group.date === today ? " · วันนี้" : ""}</h4>
                <ul className="scal-list">
                  {group.events.map(e => <EventRow key={e.id} event={e as CalendarEvent} onClick={() => onEventClick(e.id)} renderExtra={renderExtra} />)}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>
    );
  }

  return (
    <section className="scal" aria-label={label}>
      {header}
      {legendView}
      <div className="scal-month" ref={gridRef} aria-busy={loading || undefined}>
        <div className="scal-weekdays" aria-hidden="true">
          {THAI_WEEKDAYS_SHORT.map((d, i) => <div key={d} className={i >= 5 ? "scal-weekday is-weekend" : "scal-weekday"}>{d}</div>)}
        </div>
        {weeks.map(week => {
          const segments = layoutWeek(week[0], gridEvents);
          const hidden = week.map((date, col) => segments.filter(s => s.lane >= maxLanes && s.startCol <= col && s.startCol + s.span - 1 >= col).length);
          const counts = week.map(date => segments.filter(s => coversDay(s.event, date)).length);
          return (
            <div key={week[0]} className="scal-week" style={{ gridTemplateRows: `30px repeat(${maxLanes}, 24px) 22px` }}>
              {week.map((date, col) => {
                const day = parseYmd(date)!.day;
                const classes = ["scal-day"];
                if (!inMonth(date)) classes.push("is-outside");
                if (date === today) classes.push("is-today");
                if (col >= 5) classes.push("is-weekend");
                const count = counts[col];
                const ariaLabel = `${thaiLongDate(date)}${date === today ? " (วันนี้)" : ""}${count ? ` · ${count} รอบอบรม` : ""}${onDayClick ? ` · ${dayActionLabel || "เพิ่มรายการ"}` : ""}`;
                return (
                  <button key={date} type="button" data-date={date} className={classes.join(" ")}
                    style={{ gridColumn: col + 1 }} tabIndex={date === focusDate ? 0 : -1} aria-label={ariaLabel}
                    aria-current={date === today ? "date" : undefined}
                    onFocus={() => { if (inMonth(date) && date !== focusDate) setFocusDate(date); }}
                    onClick={e => activateDay(date, e.currentTarget)} onKeyDown={e => onDayKey(e, date)}>
                    <span className="scal-daynum" aria-hidden="true">{day === 1 ? `${day} ${THAI_MONTHS_SHORT[parseYmd(date)!.month - 1]}` : day}</span>
                  </button>
                );
              })}
              {segments.filter(s => s.lane < maxLanes).map(s => {
                const e = s.event as CalendarEvent;
                const classes = ["scal-bar"];
                if (s.continuesBefore) classes.push("cont-before");
                if (s.continuesAfter) classes.push("cont-after");
                if (e.muted) classes.push("is-muted");
                return (
                  <button key={`${e.id}-${week[0]}`} type="button" className={classes.join(" ")}
                    style={{ gridColumn: `${s.startCol + 1} / span ${s.span}`, gridRow: s.lane + 2, color: e.color.fg, background: e.color.bg, borderColor: e.color.border || e.color.fg }}
                    title={`${e.title} · ${formatDateRange(e.start, e.end)}${e.meta ? ` · ${e.meta}` : ""}`}
                    aria-label={`${e.title}, ${formatDateRange(e.start, e.end)}${e.description ? `, ${e.description}` : ""}`}
                    onClick={() => onEventClick(e.id)}>
                    {s.continuesBefore && <span aria-hidden="true">← </span>}
                    <span className="scal-bar-text">{e.title}</span>
                    {e.badges?.map(b => <span key={b.label} className="scal-bar-badge" style={{ color: b.fg, background: b.bg }} aria-hidden="true">{b.label}</span>)}
                    {s.continuesAfter && <span aria-hidden="true" className="scal-bar-arrow"> →</span>}
                  </button>
                );
              })}
              {week.map((date, col) => hidden[col] > 0 && (
                <button key={`more-${date}`} type="button" className="scal-more" style={{ gridColumn: col + 1, gridRow: maxLanes + 2 }}
                  aria-haspopup="dialog" aria-label={`ดูอีก ${hidden[col]} รอบ ${thaiLongDate(date)}`}
                  onClick={e => setPopover({ date, trigger: e.currentTarget })}>+{hidden[col]} รอบ</button>
              ))}
              {popover && week.includes(popover.date) && (
                <DayPopover date={popover.date} col={week.indexOf(popover.date)} events={dayEvents(popover.date) as CalendarEvent[]}
                  onEventClick={id => { setPopover(null); onEventClick(id); }}
                  onDayAction={onDayClick ? () => { const d = popover.date; setPopover(null); onDayClick(d); } : undefined}
                  dayActionLabel={dayActionLabel} renderExtra={renderExtra}
                  onClose={() => { const t = popover.trigger; setPopover(null); t?.focus(); }} />
              )}
            </div>
          );
        })}
        {loading && <div className="scal-loading" role="status">กำลังโหลด…</div>}
      </div>
      {!loading && monthEvents.length === 0 && <p className="scal-empty">{emptyText || `ไม่มีรอบอบรมในเดือน${thaiMonthLabel(month)}`}</p>}
    </section>
  );
};

const EventRow: React.FC<{ event: CalendarEvent; onClick: () => void; renderExtra?: (e: CalendarEvent) => React.ReactNode }> = ({ event, onClick, renderExtra }) => (
  <li className="scal-item">
    <button type="button" className={event.muted ? "scal-item-btn is-muted" : "scal-item-btn"} onClick={onClick}
      style={{ borderLeftColor: event.color.border || event.color.fg }}>
      <span className="scal-item-title">{event.title}</span>
      <span className="scal-item-meta">{formatDateRange(event.start, event.end)}{event.meta ? ` · ${event.meta}` : ""}</span>
      {event.badges && event.badges.length > 0 && (
        <span className="scal-item-badges">
          {event.badges.map(b => <span key={b.label} className="scal-chip" style={{ color: b.fg, background: b.bg }}>{b.label}</span>)}
        </span>
      )}
      {event.description && <span className="scal-sr">{event.description}</span>}
    </button>
    {renderExtra && <div className="scal-item-extra">{renderExtra(event)}</div>}
  </li>
);

const DayPopover: React.FC<{
  date: string; col: number; events: CalendarEvent[]; onEventClick: (id: string) => void; onClose: () => void;
  onDayAction?: () => void; dayActionLabel?: string; renderExtra?: (e: CalendarEvent) => React.ReactNode;
}> = ({ date, col, events, onEventClick, onClose, onDayAction, dayActionLabel, renderExtra }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("mousedown", onDown); };
  }, []);
  // Anchor under the day; flip toward the left on the last columns so it stays inside the grid.
  const style: React.CSSProperties = col >= 4 ? { right: `${((6 - col) / 7) * 100}%` } : { left: `${(col / 7) * 100}%` };
  return (
    <div ref={ref} className="scal-popover" role="dialog" aria-label={`รอบอบรม${thaiLongDate(date)}`} style={style}>
      <div className="scal-popover-head">
        <strong>{thaiLongDate(date)}</strong>
        <button type="button" className="scal-btn scal-close" onClick={onClose} aria-label="ปิด">×</button>
      </div>
      <ul className="scal-list">
        {events.map(e => <EventRow key={e.id} event={e} onClick={() => onEventClick(e.id)} renderExtra={renderExtra} />)}
      </ul>
      {onDayAction && <button type="button" className="scal-btn scal-day-action" onClick={onDayAction}>+ {dayActionLabel || "เพิ่มรายการ"}</button>}
    </div>
  );
};
