import React, { useEffect, useMemo, useState, useRef } from "react";
import { publicGet, PublicSession, RegisterModal } from "../components/site/PublicSections";
import { MODE_LABEL, formatBaht, formatDate, formatDateRange } from "../components/site-admin/ui";
import { SessionCalendar, CalendarEvent, suggestMonth } from "../components/calendar/SessionCalendar";
import { YearMonth } from "../components/calendar/calendarDates";
import { Dialog, seatsText, toneOf } from "./shared";

// ==========================================
// /schedule calendar view: public (open/closed, upcoming) sessions only.
// ==========================================

const vendorKey = (s: PublicSession) => s.vendor || "อื่น ๆ";

function toEvent(s: PublicSession): CalendarEvent {
  const tone = toneOf(s.vendor);
  const badges: CalendarEvent["badges"] = [];
  if (!s.registration_open) badges.push({ label: "ปิดรับ", fg: "#4a5775", bg: "#ffffff" });
  else if (s.seats_left === 0) badges.push({ label: "เต็ม · รอคิว", fg: "#b42318", bg: "#ffffff" });
  else if (s.seats_left <= 3) badges.push({ label: `เหลือ ${s.seats_left}`, fg: "#9a3f12", bg: "#ffffff" });
  return {
    id: s.id, start: s.start_date, end: s.end_date || s.start_date, title: s.title,
    color: { fg: tone.fg, bg: tone.bg },
    meta: [s.time_text, MODE_LABEL[s.mode], s.location].filter(Boolean).join(" · "),
    badges, description: `${vendorKey(s)} · ${MODE_LABEL[s.mode]} · ${formatBaht(s.price)} · ${seatsText(s)}`
  };
}

export const ScheduleCalendarView: React.FC = () => {
  const [data, setData] = useState<PublicSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vendor, setVendor] = useState("");
  const [month, setMonth] = useState<YearMonth | undefined>();
  const [open, setOpen] = useState<PublicSession | null>(null);
  // The calendar reports its first (current) month before data arrives; suggest a month only once, on first load.
  const suggested = useRef(false);
  const [registering, setRegistering] = useState<PublicSession | null>(null);

  const load = () => publicGet<{ sessions: PublicSession[] }>("/sessions?limit=100")
    .then(d => {
      setData(d.sessions);
      setError(null);
      // Start on the month of the next session the first time data arrives.
      if (!suggested.current) {
        suggested.current = true;
        setMonth(suggestMonth(d.sessions.map(s => ({ id: s.id, start: s.start_date, end: s.end_date }))));
      }
    })
    .catch(err => setError(err.message));
  useEffect(() => { load(); }, []);

  const vendors = useMemo(() => Array.from(new Set((data ?? []).map(vendorKey))).sort(), [data]);
  const shown = useMemo(() => (data ?? []).filter(s => !vendor || vendorKey(s) === vendor), [data, vendor]);
  const events = useMemo(() => shown.map(toEvent), [shown]);
  const byId = useMemo(() => new Map((data ?? []).map(s => [s.id, s])), [data]);

  return (
    <section aria-labelledby="schedule-calendar-title" className="ps-schedule-calendar">
      <div className="ps-section-head">
        <div>
          <span className="ps-kicker">ตารางอบรม</span>
          <h2 id="schedule-calendar-title">ปฏิทินรอบอบรม</h2>
        </div>
        {vendors.length > 1 && (
          <div className="ps-chips" role="group" aria-label="กรองตามแบรนด์">
            {["", ...vendors].map(v => (
              <button key={v || "all"} type="button" className="ps-chip" aria-pressed={vendor === v} onClick={() => setVendor(v)}>{v || "ทั้งหมด"}</button>
            ))}
          </div>
        )}
      </div>
      {error && <p role="alert" style={{ color: "#b42318" }}>{error}</p>}
      <div className="ps-card ps-calendar-card">
        <SessionCalendar
          label="ปฏิทินรอบอบรม"
          events={events}
          loading={!data && !error}
          initialMonth={month}
          onMonthChange={setMonth}
          onEventClick={id => { const s = byId.get(id); if (s) setOpen(s); }}
          legend={vendors.filter(v => !vendor || v === vendor).map(v => ({ label: v, ...toneOf(v === "อื่น ๆ" ? null : v) }))}
          emptyText="ไม่มีรอบอบรมในเดือนนี้ ลองดูเดือนถัดไป หรือติดต่อเจ้าหน้าที่เพื่อสอบถามรอบถัดไป"
        />
      </div>
      {open && (
        <Dialog label={open.title} onClose={() => setOpen(null)}>
          {open.vendor && <span className="ps-course-vendor">{open.vendor}</span>}
          <h2 style={{ margin: "6px 44px 10px 0", fontSize: 24, lineHeight: 1.3 }}>{open.title}</h2>
          {open.description && <p className="ps-muted" style={{ margin: 0, fontSize: 16 }}>{open.description}</p>}
          <dl className="ps-facts">
            <div><dt>วันที่</dt><dd>{formatDateRange(open.start_date, open.end_date)}</dd></div>
            {open.time_text && <div><dt>เวลา</dt><dd>{open.time_text}</dd></div>}
            <div><dt>รูปแบบ</dt><dd>{MODE_LABEL[open.mode]}{open.location ? ` · ${open.location}` : ""}</dd></div>
            {open.instructor_name && <div><dt>วิทยากร</dt><dd>{open.instructor_name}</dd></div>}
            <div><dt>ราคา</dt><dd>{formatBaht(open.price)}{open.price > 0 ? "/ท่าน" : ""}</dd></div>
            <div><dt>ที่นั่ง</dt><dd>{seatsText(open)}</dd></div>
          </dl>
          {open.registration_open
            ? <p className="ps-note">ปิดรับสมัคร {formatDate(open.registration_deadline)}</p>
            : <p className="ps-note">รอบนี้ปิดรับสมัครแล้ว ติดต่อเจ้าหน้าที่เพื่อสอบถามรอบถัดไป</p>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
            <button type="button" className="ps-btn ps-btn-primary" disabled={!open.registration_open}
              onClick={() => { setRegistering(open); setOpen(null); }}>
              {!open.registration_open ? "ปิดรับสมัคร" : open.waitlist ? "ลงชื่อรอคิว" : "ลงทะเบียน"}
            </button>
            <button type="button" className="ps-btn ps-btn-ghost" onClick={() => setOpen(null)}>ปิด</button>
          </div>
        </Dialog>
      )}
      {registering && <RegisterModal session={registering} onClose={() => setRegistering(null)} onDone={load} />}
    </section>
  );
};
