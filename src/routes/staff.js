import express from 'express';
import { requireStaff } from '../auth.js';
import { HttpError, rateLimiter } from '../http.js';
import { APPOINTMENT_SELECT, getAppointment, viewsWithPeople, scanResult, normalizeCode, sqlTime, VISIT_MINUTES } from '../appointments.js';
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

  // Security staff find a pass only by its code; looking one up by number is
  // for admins (from the visitor list). Repeated wrong codes are limited so
  // codes can't be guessed.
  const wrongCodes = rateLimiter({ max: 30, windowMs: 10 * 60_000, message: 'Too many wrong codes. Please wait a few minutes.' });
  function find(req) {
    const body = req.body;
    const code = typeof body?.code === 'string' ? normalizeCode(body.code) : '';
    const byId = !code && body?.appointmentId && req.user.role === 'admin';
    if (code) wrongCodes.check(req.user.id);
    const appt = code ? byCode.get(code) : byId ? getAppointment(db, Number(body.appointmentId)) : null;
    if (!appt) {
      if (code) wrongCodes(req.user.id);
      throw new HttpError(404, 'This QR code is not a valid entry pass. Do not allow entry.');
    }
    return appt;
  }

  // Security see only what they need at the gate: photo, names, group size and
  // visit, and who checked them in. Phone numbers, references and notes are for admins.
  const view = (req, rows) => viewsWithPeople(db, rows).map((a) => (req.user.role === 'admin' ? a : {
    id: a.id, status: a.status, name: a.name, photo: a.photo, express: a.express,
    peopleCount: a.peopleCount, people: a.people.map((p) => ({ name: p.name })), checkedInCount: a.checkedInCount,
    date: a.date, period: a.period, periodLabel: a.periodLabel, checkedInAt: a.checkedInAt, checkedInBy: a.checkedInBy, visitEndsAt: a.visitEndsAt,
  }));

  router.get('/stream', (req, res) => notifier.openStaffStream(req, res));

  router.post('/scan', (req, res) => {
    const appt = find(req);
    const result = scanResult(appt, opts());
    // Only admins may let someone in on the wrong day or before the session opens.
    if (result.adminOverride && req.user.role !== 'admin') delete result.adminOverride;
    res.json({ ...result, appointment: view(req, [appt])[0] });
  });

  router.post('/admit', (req, res) => {
    const appt = find(req);
    const result = scanResult(appt, opts());
    const override = req.user.role === 'admin' && result.adminOverride && req.body?.override;
    if (!result.canAdmit && !override) throw new HttpError(409, result.message, { result: result.result });
    const count = parseCount(req.body?.count, appt);
    const done = db.prepare(`
      UPDATE appointments SET checked_in_at = ?, checked_in_by = ?, checked_in_count = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'approved' AND checked_in_at IS NULL RETURNING id
    `).get(sqlTime(now()), req.user.id, count, appt.id);
    if (!done) throw new HttpError(409, 'Already checked in with this QR code.', { result: 'used' });
    notifier.notify(appt.user_id, appt.id, 'Welcome 🙏 You are checked in', `Please take a seat. Your visit time is ${VISIT_MINUTES} minutes.`, { phone: false });
    notifier.emitToStaff('checkin', { id: appt.id });
    res.json({ appointment: view(req, [getAppointment(db, appt.id)])[0] });
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
    res.json({ appointment: view(req, [getAppointment(db, appt.id)])[0] });
  });

  // This staff member's check-ins today.
  router.get('/recent', (req, res) => {
    const rows = db.prepare(`${APPOINTMENT_SELECT} WHERE a.checked_in_by = ? AND a.date = ? ORDER BY a.checked_in_at DESC LIMIT 30`)
      .all(req.user.id, nowInTimezone(config.timeZone, now()).date);
    const people = rows.reduce((n, r) => n + (r.checked_in_count ?? r.people_count), 0);
    res.json({ checkins: view(req, rows), people });
  });

  return router;
}
