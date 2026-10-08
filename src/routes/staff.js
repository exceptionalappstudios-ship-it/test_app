import express from 'express';
import { requireStaff } from '../auth.js';
import { HttpError } from '../http.js';
import { APPOINTMENT_SELECT, getAppointment, viewsWithPeople, scanResult, normalizeCode } from '../appointments.js';
import { nowInTimezone, formatVisit } from '../time.js';

// The scanner, used by approved security staff and by admins.
export function staffRoutes({ db, notifier, config, now }) {
  const router = express.Router();
  router.use(requireStaff);
  const opts = () => ({ timeZone: config.timeZone, periods: config.periods, now: now() });
  const byCode = db.prepare(`${APPOINTMENT_SELECT} WHERE a.checkin_code = ? COLLATE NOCASE`);
  const parseCount = (value, a) => {
    if (value === undefined || value === null || value === '') return a.people_count;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > a.people_count) throw new HttpError(400, `Choose between 1 and ${a.people_count} people`);
    return n;
  };

  function find(body) {
    const code = typeof body?.code === 'string' ? normalizeCode(body.code) : '';
    const appt = code ? byCode.get(code) : body?.appointmentId ? getAppointment(db, Number(body.appointmentId)) : null;
    if (!appt) throw new HttpError(404, 'This QR code is not a valid entry pass. Do not allow entry.');
    return appt;
  }

  router.get('/stream', (req, res) => notifier.openStaffStream(req, res));

  router.post('/scan', (req, res) => {
    const appt = find(req.body);
    const result = scanResult(appt, opts());
    // Only admins may let someone in on the wrong day or before the session opens.
    if (result.adminOverride && req.user.role !== 'admin') delete result.adminOverride;
    res.json({ ...result, appointment: viewsWithPeople(db, [appt])[0] });
  });

  router.post('/admit', (req, res) => {
    const appt = find(req.body);
    const result = scanResult(appt, opts());
    const override = req.user.role === 'admin' && result.adminOverride && req.body?.override;
    if (!result.canAdmit && !override) throw new HttpError(409, result.message, { result: result.result });
    const count = parseCount(req.body?.count, appt);
    const done = db.prepare(`
      UPDATE appointments SET checked_in_at = datetime('now'), checked_in_by = ?, checked_in_count = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'approved' AND checked_in_at IS NULL RETURNING id
    `).get(req.user.id, count, appt.id);
    if (!done) throw new HttpError(409, 'Already checked in with this QR code.', { result: 'used' });
    notifier.notify(appt.user_id, appt.id, 'Welcome 🙏', `You are checked in for ${formatVisit(appt)}. Please take a seat.`, { phone: false });
    notifier.emitToStaff('checkin', { id: appt.id });
    res.json({ appointment: viewsWithPeople(db, [getAppointment(db, appt.id)])[0] });
  });

  // Corrects how many of the group came in (e.g. 5 booked, 3 came).
  router.post('/count', (req, res) => {
    const appt = getAppointment(db, Number(req.body?.appointmentId));
    if (!appt || !appt.checked_in_at) throw new HttpError(404, 'This visitor has not checked in');
    if (req.user.role !== 'admin' && (appt.checked_in_by !== req.user.id || appt.date !== nowInTimezone(config.timeZone, now()).date)) {
      throw new HttpError(403, 'You can only change check-ins you made today');
    }
    db.prepare("UPDATE appointments SET checked_in_count = ?, updated_at = datetime('now') WHERE id = ?").run(parseCount(req.body?.count, appt), appt.id);
    notifier.emitToStaff('checkin', { id: appt.id });
    res.json({ appointment: viewsWithPeople(db, [getAppointment(db, appt.id)])[0] });
  });

  // This staff member's check-ins today.
  router.get('/recent', (req, res) => {
    const rows = db.prepare(`${APPOINTMENT_SELECT} WHERE a.checked_in_by = ? AND a.date = ? ORDER BY a.checked_in_at DESC LIMIT 30`)
      .all(req.user.id, nowInTimezone(config.timeZone, now()).date);
    const people = rows.reduce((n, r) => n + (r.checked_in_count ?? r.people_count), 0);
    res.json({ checkins: viewsWithPeople(db, rows), people });
  });

  return router;
}
