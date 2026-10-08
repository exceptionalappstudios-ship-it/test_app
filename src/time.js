// All slot times are stored as wall-clock times in the app's timezone, so we
// only ever need "what time is it now over there" and minute arithmetic.

export function nowInTimezone(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// Minutes since the epoch for a wall-clock date/time, treating it as UTC.
// Only meaningful for differences between two values in the same timezone.
export function wallMinutes(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) / 60000;
}

export function minutesUntil(date, time, timeZone, now = new Date()) {
  const n = nowInTimezone(timeZone, now);
  return wallMinutes(date, time) - wallMinutes(n.date, n.time);
}

export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function dayOfWeek(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function toHHMM(totalMinutes) {
  const h = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const m = String(totalMinutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

export function fromHHMM(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function formatSlot(slot) {
  const [y, m, d] = slot.date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  return `${day}, ${slot.start_time}–${slot.end_time}`;
}

export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---- Visit sessions ----------------------------------------------------------

export const PERIODS = ['morning', 'afternoon', 'evening'];
export const PERIOD_LABELS = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };

// "08:00-13:00,13:00-16:00,16:00-20:00" -> { morning: { start, end }, ... }
export function parsePeriodTimes(spec = '08:00-13:00,13:00-16:00,16:00-20:00') {
  const parts = spec.split(',').map((p) => p.trim().split('-'));
  if (parts.length !== 3 || parts.some(([s, e]) => !TIME_RE.test(s ?? '') || !TIME_RE.test(e ?? '') || s >= e)) {
    throw new Error(`SESSION_TIMES must look like 08:00-13:00,13:00-16:00,16:00-20:00 (got "${spec}")`);
  }
  return Object.fromEntries(PERIODS.map((p, i) => [p, { start: parts[i][0], end: parts[i][1], label: PERIOD_LABELS[p] }]));
}

// "13:00" -> "1:00 PM"
export function formatClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function formatDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

export const formatVisit = (a) => `${formatDay(a.date)} (${PERIOD_LABELS[a.period]})`;
