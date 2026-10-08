import { nowInTimezone, minutesUntil, formatClock, formatVisit, PERIOD_LABELS } from './time.js';

export const MAX_PEOPLE = 5;

// Entry codes are 6 letters/digits without look-alikes (no 0/O, 1/I/L), so
// security can type them easily. The QR code contains the same 6 characters.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// Web Crypto works both on the server and in the browser preview.
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export function newCheckinCode(db) {
  for (;;) {
    const code = Array.from(randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    if (!db.prepare('SELECT 1 FROM appointments WHERE checkin_code = ?').get(code)) return code;
  }
}
export const normalizeCode = (code) => String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/gi, '');
// The pass link's secret: long and random, separate from the short entry code.
export const newPassToken = () => btoa(String.fromCharCode(...randomBytes(16))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Gives an approved appointment its entry code and pass link if it has none yet.
export function ensurePass(db, a) {
  if (a.checkin_code && a.pass_token) return a;
  const code = a.checkin_code ?? newCheckinCode(db);
  const token = a.pass_token ?? newPassToken();
  db.prepare('UPDATE appointments SET checkin_code = ?, pass_token = ? WHERE id = ?').run(code, token, a.id);
  return { ...a, checkin_code: code, pass_token: token };
}
export const peopleIn = (a) => a.checked_in_count ?? a.people_count;

// Text of the WhatsApp pass message (the link goes in the "View pass" button).
export const passMessage = (a, when) =>
  `${a.name}, your entry pass for ${when} for ${a.people_count} ${a.people_count === 1 ? 'person' : 'people'}. Entry code: ${a.checkin_code}. Tap "View pass" to open your QR code. It is valid only today and can be scanned only once. Security can also type the entry code.`;

export const ACTIVE = "('pending', 'hold', 'approved')";

export const PURPOSES = {
  blessings: 'Need blessings / Guidance',
  invitation: 'Invitation',
  project: 'Project proposal',
  donation: 'Donation',
  life_event: 'Life event (Marriage, Anniversary, Birthday, etc.)',
  other: 'Other',
};

export const APPOINTMENT_SELECT = `
  SELECT a.*, cu.name AS checked_in_by_name, ru.name AS reviewed_by_name, bu.name AS created_by_name
  FROM appointments a
  LEFT JOIN users cu ON cu.id = a.checked_in_by
  LEFT JOIN users ru ON ru.id = a.reviewed_by
  LEFT JOIN users bu ON bu.id = a.created_by`;

export function loadPeople(db, ids) {
  const byAppt = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return byAppt;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT appointment_id, name, phone FROM appointment_people WHERE is_booker = 0 AND appointment_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`).all(...chunk);
    for (const r of rows) byAppt.get(r.appointment_id).push({ name: r.name, phone: r.phone });
  }
  return byAppt;
}

export const getAppointment = (db, id) => db.prepare(`${APPOINTMENT_SELECT} WHERE a.id = ?`).get(id);

export function appointmentView(a, people = []) {
  return {
    id: a.id, status: a.status, name: a.name, phone: a.phone,
    photo: a.photo ? `/api/photos/${a.photo}` : null,
    reference: a.reference, refPhone: a.ref_phone ?? null, refDesignation: a.ref_designation ?? null,
    express: Boolean(a.express), createdBy: a.created_by_name ?? null,
    peopleCount: a.people_count, people, checkedInCount: a.checked_in_at ? (a.checked_in_count ?? a.people_count) : null,
    purposes: JSON.parse(a.purposes).map((p) => PURPOSES[p] ?? p), description: a.description,
    date: a.date, period: a.period, periodLabel: PERIOD_LABELS[a.period],
    adminNote: a.admin_note, reviewedBy: a.reviewed_by_name ?? null,
    checkedInAt: a.checked_in_at, checkedInBy: a.checked_in_by_name ?? null,
    passSent: Boolean(a.pass_sent_at), createdAt: a.created_at,
  };
}

export function viewsWithPeople(db, rows) {
  const people = loadPeople(db, rows.map((r) => r.id));
  return rows.map((r) => appointmentView(r, people.get(r.id)));
}

// Where an appointment's entry pass stands right now. The pass is valid only
// on the visit day, from the start of its session, and only once.
export function passState(a, { timeZone, periods, now }) {
  if (a.status !== 'approved') return { state: 'inactive' };
  if (a.checked_in_at) return { state: 'checked_in' };
  const today = nowInTimezone(timeZone, now).date;
  const start = periods[a.period].start;
  if (a.date < today) return { state: 'expired' };
  if (a.date > today || (!a.express && minutesUntil(a.date, start, timeZone, now) > 0)) {
    return { state: 'not_yet', opensAt: formatClock(start), opensOn: a.date };
  }
  return { state: 'ready' };
}

// The session that is on now (or the nearest one today), for express passes.
export function currentPeriod(periods, time) {
  for (const p of ['morning', 'afternoon', 'evening']) if (time < periods[p].end) return p;
  return 'evening';
}

// What security sees when scanning a pass.
export function scanResult(a, { timeZone, periods, now }) {
  if (a.status !== 'approved') {
    const word = { pending: 'not approved yet', hold: 'not approved yet', rejected: 'declined', cancelled: 'cancelled' }[a.status];
    return { result: 'inactive', canAdmit: false, message: `This appointment is ${word}. Do not allow entry.` };
  }
  if (a.checked_in_at) {
    return { result: 'used', canAdmit: false, message: 'Already checked in with this QR code.' };
  }
  const today = nowInTimezone(timeZone, now).date;
  if (a.date !== today) {
    return { result: 'wrong_day', canAdmit: false, adminOverride: true, message: `This pass is for ${formatVisit(a)}. It is not valid today.` };
  }
  const start = periods[a.period].start;
  if (!a.express && minutesUntil(a.date, start, timeZone, now) > 0) {
    return { result: 'early', canAdmit: false, adminOverride: true, message: `${PERIOD_LABELS[a.period]} passes open at ${formatClock(start)}.` };
  }
  return { result: 'ok', canAdmit: true, message: a.express ? 'Valid express pass' : 'Valid pass' };
}
