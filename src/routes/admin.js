import express from 'express';
import crypto from 'node:crypto';
import { transaction } from '../db.js';
import { requireAdmin, createUser, publicUser, validatePassword } from '../auth.js';
import { HttpError, text, email as parseEmail, phone as parsePhone } from '../http.js';
import { ACTIVE, APPOINTMENT_SELECT, getAppointment, appointmentView } from '../appointments.js';
import {
  nowInTimezone, minutesUntil, addDays, dayOfWeek, toHHMM, fromHHMM, formatSlot, DATE_RE, TIME_RE,
} from '../time.js';
import { openStream } from '../sse.js';

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

export function adminRoutes({ db, notifier, config, now }) {
  const router = express.Router();
  const { timeZone } = config;
  const today = () => nowInTimezone(timeZone, now()).date;
  router.use(requireAdmin);

  router.get('/stream', (req, res) => openStream(req, res, (stream) => notifier.addAdminStream(stream)));

  // Badge counts for the admin navigation.
  router.get('/summary', (_req, res) => {
    res.json({
      pending: db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE status = 'pending'").get().n,
      unreadMessages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE from_admin = 0 AND read_at IS NULL').get().n,
    });
  });

  // ---- Live dashboard ----------------------------------------------------

  router.get('/stats', (req, res) => {
    const t = today();
    const from = DATE_RE.test(req.query.from ?? '') ? req.query.from : addDays(t, -6);
    let to = DATE_RE.test(req.query.to ?? '') ? req.query.to : addDays(t, 13);
    if (to < from) to = from;
    if (addDays(from, 92) < to) to = addDays(from, 92);

    const rows = db.prepare(`
      SELECT s.date,
        COUNT(s.id) AS slots,
        SUM(CASE WHEN s.is_blocked = 0 AND a.id IS NULL THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END) AS booked,
        SUM(CASE WHEN a.status = 'approved' AND a.checked_in_at IS NOT NULL THEN 1 ELSE 0 END) AS checkedIn
      FROM slots s
      LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ${ACTIVE}
      WHERE s.date BETWEEN ? AND ?
      GROUP BY s.date
    `).all(from, to);
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = byDate.get(d);
      days.push({ date: d, slots: r?.slots ?? 0, open: r?.open ?? 0, pending: r?.pending ?? 0, booked: r?.booked ?? 0, checkedIn: r?.checkedIn ?? 0 });
    }

    const todayList = db.prepare(`${APPOINTMENT_SELECT} WHERE s.date = ? AND a.status = 'approved' ORDER BY s.start_time`)
      .all(t).map(appointmentView);
    const todayRow = byDate.get(t) ?? { booked: 0, checkedIn: 0, pending: 0, open: 0 };
    res.json({
      today: t,
      now: nowInTimezone(timeZone, now()).time,
      summary: {
        booked: todayRow.booked, checkedIn: todayRow.checkedIn, pending: todayRow.pending,
        awaiting: todayRow.booked - todayRow.checkedIn, open: todayRow.open,
      },
      days,
      todayList,
    });
  });

  // ---- Requests ----------------------------------------------------------

  router.get('/appointments', (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(`
      ${APPOINTMENT_SELECT}
      ${status ? 'WHERE a.status = ?' : ''}
      ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, s.date, s.start_time
      LIMIT 500
    `).all(...(status ? [status] : []));
    const counts = Object.fromEntries(
      db.prepare('SELECT status, COUNT(*) AS n FROM appointments GROUP BY status').all().map((r) => [r.status, r.n])
    );
    res.json({ appointments: rows.map(appointmentView), counts });
  });

  function decide(req, res, status) {
    const appt = getAppointment(db, Number(req.params.id));
    if (!appt) throw new HttpError(404, 'Appointment not found');
    const allowed = status === 'cancelled' ? ['approved', 'pending'] : ['pending'];
    if (!allowed.includes(appt.status)) throw new HttpError(409, `Appointment is already ${appt.status}`);
    if (appt.checked_in_at) throw new HttpError(409, 'This visitor has already checked in');
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) || null : null;

    // Skip reminders that would otherwise fire right after a late approval.
    const minsAway = minutesUntil(appt.date, appt.start_time, timeZone, now());
    const approved = status === 'approved';
    db.prepare(`
      UPDATE appointments SET status = ?, admin_note = ?, updated_at = datetime('now'),
        checkin_code = COALESCE(checkin_code, ?),
        reminded_24h = reminded_24h OR ?, reminded_1h = reminded_1h OR ?, reminded_qr = reminded_qr OR ?
      WHERE id = ?
    `).run(status, note, approved ? crypto.randomBytes(18).toString('base64url') : null,
      approved && minsAway <= 24 * 60 ? 1 : 0, approved && minsAway <= 60 ? 1 : 0,
      approved && minsAway <= config.qrLeadMinutes ? 1 : 0, appt.id);

    const when = formatSlot(appt);
    const suffix = note ? `\nNote: ${note}` : '';
    const messages = {
      approved: ['Appointment confirmed 🙏', `Your meeting with Gurudev is confirmed for ${when}. Your entry QR code will appear in the app ${config.qrLeadMinutes} minutes before your meeting — please show it at the entrance.${suffix}`],
      rejected: ['Appointment request declined', `We're sorry, your request for ${when} could not be accommodated.${suffix}`],
      cancelled: ['Appointment cancelled', `Your appointment on ${when} has been cancelled by the ashram.${suffix}`],
    };
    notifier.notify(appt.user_id, appt.id, ...messages[status]);
    notifier.emitToAdmins('appointment', { id: appt.id });
    res.json({ appointment: appointmentView(getAppointment(db, appt.id)) });
  }

  router.post('/appointments/:id/approve', (req, res) => decide(req, res, 'approved'));
  router.post('/appointments/:id/reject', (req, res) => decide(req, res, 'rejected'));
  router.post('/appointments/:id/cancel', (req, res) => decide(req, res, 'cancelled'));

  // ---- Check-in ----------------------------------------------------------

  // Whether the visitor can be admitted now. Timing problems can be
  // overridden by the admin at the door; status problems cannot.
  function eligibility(appt) {
    if (appt.status !== 'approved') return { canAdmit: false, reason: `This appointment is ${appt.status}.` };
    if (appt.checked_in_at) return { canAdmit: false, reason: 'Already checked in.' };
    if (appt.date !== today()) return { canAdmit: true, needsOverride: true, reason: `This pass is for ${formatSlot(appt)}, not today.` };
    const toStart = minutesUntil(appt.date, appt.start_time, timeZone, now());
    const toEnd = minutesUntil(appt.date, appt.end_time, timeZone, now());
    if (toStart > config.checkinEarlyMinutes) return { canAdmit: true, needsOverride: true, reason: `Early: the meeting starts at ${appt.start_time}.` };
    if (toEnd < -config.checkinGraceMinutes) return { canAdmit: true, needsOverride: true, reason: `Late: the slot ended at ${appt.end_time}.` };
    return { canAdmit: true, needsOverride: false };
  }

  function findForCheckin(body) {
    let appt;
    if (body?.code) {
      const code = String(body.code).trim();
      const row = db.prepare('SELECT id FROM appointments WHERE checkin_code = ?').get(code);
      appt = row && getAppointment(db, row.id);
      if (!appt) throw new HttpError(404, 'This QR code is not a valid entry pass.');
    } else {
      appt = getAppointment(db, Number(body?.appointmentId));
      if (!appt) throw new HttpError(404, 'Appointment not found');
    }
    return appt;
  }

  router.post('/checkin/lookup', (req, res) => {
    const appt = findForCheckin(req.body);
    res.json({ appointment: appointmentView(appt), ...eligibility(appt) });
  });

  router.post('/checkin', (req, res) => {
    const appt = findForCheckin(req.body);
    const check = eligibility(appt);
    if (!check.canAdmit) throw new HttpError(409, check.reason);
    if (check.needsOverride && !req.body?.override) throw new HttpError(409, check.reason);
    const { changes } = db.prepare(`
      UPDATE appointments SET checked_in_at = datetime('now'), checked_in_by = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'approved' AND checked_in_at IS NULL
    `).run(req.user.id, appt.id);
    if (!changes) throw new HttpError(409, 'Already checked in.');
    notifier.notify(appt.user_id, appt.id, 'Welcome 🙏', "You're checked in. Please take a seat; you'll be called shortly.",
      { email: false, whatsapp: false });
    notifier.emitToAdmins('checkin', { id: appt.id });
    res.json({ appointment: appointmentView(getAppointment(db, appt.id)) });
  });

  // ---- Slots -------------------------------------------------------------

  router.get('/slots', (req, res) => {
    const from = DATE_RE.test(req.query.from ?? '') ? req.query.from : today();
    const slots = db.prepare(`
      SELECT s.*, a.id AS appointment_id, a.status AS appointment_status, a.name AS visitor_name, a.checked_in_at
      FROM slots s
      LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ${ACTIVE}
      WHERE s.date >= ?
      ORDER BY s.date, s.start_time
      LIMIT 1000
    `).all(from);
    res.json({ slots });
  });

  // Creates slots for every matching day in [fromDate, toDate] between
  // startTime and endTime, each `duration` minutes long with `gap` minutes between.
  router.post('/slots', (req, res) => {
    const { fromDate, toDate = fromDate, startTime, endTime } = req.body ?? {};
    const duration = Number(req.body?.duration ?? 15);
    const gap = Number(req.body?.gap ?? 0);
    const weekdays = Array.isArray(req.body?.weekdays) ? req.body.weekdays.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    if (!DATE_RE.test(fromDate ?? '') || !DATE_RE.test(toDate ?? '')) throw new HttpError(400, 'Valid dates are required');
    if (!TIME_RE.test(startTime ?? '') || !TIME_RE.test(endTime ?? '')) throw new HttpError(400, 'Valid start and end times are required');
    if (toDate < fromDate) throw new HttpError(400, 'End date must not be before start date');
    if (addDays(fromDate, 366) < toDate) throw new HttpError(400, 'Date range can be at most one year');
    if (!Number.isInteger(duration) || duration < 5 || duration > 480) throw new HttpError(400, 'Duration must be 5–480 minutes');
    if (!Number.isInteger(gap) || gap < 0 || gap > 240) throw new HttpError(400, 'Gap must be 0–240 minutes');
    const start = fromHHMM(startTime);
    const end = fromHHMM(endTime);
    if (end - start < duration) throw new HttpError(400, 'End time must leave room for at least one slot');

    const insert = db.prepare('INSERT OR IGNORE INTO slots (date, start_time, end_time) VALUES (?, ?, ?)');
    let created = 0;
    let skipped = 0;
    transaction(db, () => {
      for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
        if (!weekdays.includes(dayOfWeek(date))) continue;
        for (let t = start; t + duration <= end; t += duration + gap) {
          const { changes } = insert.run(date, toHHMM(t), toHHMM(t + duration));
          changes ? created++ : skipped++;
        }
      }
    });
    notifier.emitToAdmins('slots');
    res.status(201).json({ created, skipped });
  });

  router.patch('/slots/:id', (req, res) => {
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(Number(req.params.id));
    if (!slot) throw new HttpError(404, 'Slot not found');
    db.prepare('UPDATE slots SET is_blocked = ? WHERE id = ?').run(req.body?.blocked ? 1 : 0, slot.id);
    notifier.emitToAdmins('slots');
    res.json({ slot: db.prepare('SELECT * FROM slots WHERE id = ?').get(slot.id) });
  });

  router.delete('/slots/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM slots WHERE id = ?').get(id)) throw new HttpError(404, 'Slot not found');
    if (db.prepare('SELECT 1 FROM appointments WHERE slot_id = ?').get(id)) {
      throw new HttpError(409, 'This slot has appointment history. Block it instead of deleting it.');
    }
    db.prepare('DELETE FROM slots WHERE id = ?').run(id);
    notifier.emitToAdmins('slots');
    res.json({ ok: true });
  });

  // ---- Messages ----------------------------------------------------------

  router.get('/threads', (_req, res) => {
    const threads = db.prepare(`
      SELECT u.id AS user_id, u.name, u.phone, u.email, m.body AS last_body, m.from_admin AS last_from_admin,
        m.created_at AS last_at,
        (SELECT COUNT(*) FROM messages x WHERE x.user_id = u.id AND x.from_admin = 0 AND x.read_at IS NULL) AS unread
      FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.id = (SELECT MAX(id) FROM messages y WHERE y.user_id = m.user_id)
      ORDER BY m.id DESC
    `).all();
    res.json({ threads });
  });

  router.get('/threads/:userId', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.userId));
    if (!user) throw new HttpError(404, 'User not found');
    db.prepare("UPDATE messages SET read_at = datetime('now') WHERE user_id = ? AND from_admin = 0 AND read_at IS NULL").run(user.id);
    const messages = db.prepare(`
      SELECT m.id, m.body, m.from_admin, m.created_at, s.name AS sender_name
      FROM messages m JOIN users s ON s.id = m.sender_id WHERE m.user_id = ? ORDER BY m.id
    `).all(user.id);
    const appointments = db.prepare(`${APPOINTMENT_SELECT} WHERE a.user_id = ? ORDER BY s.date DESC LIMIT 10`).all(user.id).map(appointmentView);
    res.json({ user: publicUser(user), messages, appointments });
  });

  router.post('/threads/:userId', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.userId));
    if (!user) throw new HttpError(404, 'User not found');
    const body = text(req.body?.body, 'Message', 2000);
    const { lastInsertRowid } = db.prepare('INSERT INTO messages (user_id, sender_id, from_admin, body) VALUES (?, ?, 1, ?)')
      .run(user.id, req.user.id, body);
    notifier.notify(user.id, null, 'New message from the ashram', body, { path: '#/contact', whatsapp: false });
    notifier.emitToUser(user.id, 'message', {});
    notifier.emitToAdmins('message', { userId: user.id });
    res.status(201).json({ message: db.prepare('SELECT id, body, from_admin, created_at FROM messages WHERE id = ?').get(lastInsertRowid) });
  });

  // ---- Admin accounts ----------------------------------------------------

  router.get('/admins', (_req, res) => {
    res.json({ admins: db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY name").all().map(publicUser) });
  });

  // Adds a new admin, or promotes an existing account with that email.
  router.post('/admins', (req, res) => {
    const email = parseEmail(req.body?.email);
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (existing) {
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
      return res.json({ admin: publicUser({ ...existing, role: 'admin' }), promoted: true });
    }
    const user = createUser(db, {
      name: text(req.body?.name, 'Name', 100),
      email,
      phone: parsePhone(req.body?.phone, config.defaultCountryCode),
      password: validatePassword(req.body?.password),
      role: 'admin',
    });
    res.status(201).json({ admin: publicUser(user), promoted: false });
  });

  router.delete('/admins/:id', (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw new HttpError(400, "You can't remove your own admin access");
    const { changes } = db.prepare("UPDATE users SET role = 'visitor' WHERE id = ? AND role = 'admin'").run(id);
    if (!changes) throw new HttpError(404, 'Admin not found');
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    res.json({ ok: true });
  });

  return router;
}
