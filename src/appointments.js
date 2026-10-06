import { minutesUntil } from './time.js';

export const ACTIVE = "('pending', 'approved')";

export const APPOINTMENT_SELECT = `
  SELECT a.*, s.date, s.start_time, s.end_time, cu.name AS checked_in_by_name
  FROM appointments a
  JOIN slots s ON s.id = a.slot_id
  LEFT JOIN users cu ON cu.id = a.checked_in_by`;

export const getAppointment = (db, id) => db.prepare(`${APPOINTMENT_SELECT} WHERE a.id = ?`).get(id);

export const appointmentView = (a) => ({
  id: a.id, status: a.status, name: a.name, phone: a.phone, email: a.email,
  purpose: a.purpose, admin_note: a.admin_note, created_at: a.created_at, updated_at: a.updated_at,
  checked_in_at: a.checked_in_at, checked_in_by: a.checked_in_by_name ?? null,
  slot: { id: a.slot_id, date: a.date, start_time: a.start_time, end_time: a.end_time },
});

// Where an appointment's entry pass stands right now. The QR code is only
// revealed from `leadMinutes` before the start until `graceMinutes` after the end.
export function passState(a, { timeZone, now, leadMinutes, graceMinutes }) {
  if (a.status !== 'approved') return { state: 'inactive' };
  if (a.checked_in_at) return { state: 'checked_in' };
  const toStart = minutesUntil(a.date, a.start_time, timeZone, now);
  const toEnd = minutesUntil(a.date, a.end_time, timeZone, now);
  if (toStart > leadMinutes) return { state: 'not_yet', opensInMinutes: toStart - leadMinutes };
  if (toEnd < -graceMinutes) return { state: 'expired' };
  return { state: 'ready' };
}
