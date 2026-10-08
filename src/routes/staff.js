import express from 'express';
import { requireStaff } from '../auth.js';
import { HttpError } from '../http.js';
import { APPOINTMENT_SELECT, getAppointment, viewsWithPeople, scanResult } from '../appointments.js';
import { nowInTimezone, formatVisit } from '../time.js';

// The scanner, used by approved security staff and by admins.
export function staffRoutes({ db, notifier, config, now }) {
  const router = express.Router();
  router.use(requireStaff);
  const opts = () => ({ timeZone: config.timeZone, periods: config.periods, now: now() });
  const byCode = db.prepare(`${APPOINTMENT_SELECT} WHERE a.checkin_code = ?`);

  function find(body) {
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
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
    const done = db.prepare(`
      UPDATE appointments SET checked_in_at = datetime('now'), checked_in_by = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'approved' AND checked_in_at IS NULL RETURNING id
    `).get(req.user.id, appt.id);
    if (!done) throw new HttpError(409, 'Already checked in with this QR code.', { result: 'used' });
    notifier.notify(appt.user_id, appt.id, 'Welcome 🙏', `You are checked in for ${formatVisit(appt)}. Please take a seat.`, { phone: false });
    notifier.emitToStaff('checkin', { id: appt.id });
    res.json({ appointment: viewsWithPeople(db, [getAppointment(db, appt.id)])[0] });
  });

  // This staff member's check-ins today.
  router.get('/recent', (req, res) => {
    const rows = db.prepare(`${APPOINTMENT_SELECT} WHERE a.checked_in_by = ? AND a.date = ? ORDER BY a.checked_in_at DESC LIMIT 30`)
      .all(req.user.id, nowInTimezone(config.timeZone, now()).date);
    const people = rows.reduce((n, r) => n + r.people_count, 0);
    res.json({ checkins: viewsWithPeople(db, rows), people });
  });

  return router;
}
