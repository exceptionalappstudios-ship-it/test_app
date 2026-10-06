import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transaction } from './db.js';
import { createNotifier } from './notify.js';
import {
  nowInTimezone, minutesUntil, addDays, dayOfWeek, toHHMM, fromHHMM, formatSlot,
  DATE_RE, TIME_RE,
} from './time.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ACTIVE = "('pending', 'approved')";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s()-]{7,20}$/;
const ADMIN_SESSION_DAYS = 7;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const newToken = () => crypto.randomBytes(24).toString('base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function text(value, field, max) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return v;
}

export function createApp({ db, timeZone, adminPassword, vapidSubject = 'mailto:admin@example.com', now = () => new Date() }) {
  const app = express();
  const notifier = createNotifier(db, { vapidSubject });
  app.locals.notifier = notifier;

  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(PUBLIC_DIR));

  const isFuture = (slot) => minutesUntil(slot.date, slot.start_time, timeZone, now()) > 0;

  // ---- Visitor identity -------------------------------------------------
  // Visitors don't create accounts; booking issues a private token that the
  // browser keeps and uses to see its appointments and notifications.

  function visitorFromRequest(req, { required = true } = {}) {
    const token = req.get('x-visitor-token') || req.query.token;
    const visitor = token && db.prepare('SELECT * FROM visitors WHERE token = ?').get(token);
    if (!visitor && required) throw new HttpError(401, 'Unknown visitor');
    return visitor;
  }

  function requireAdmin(req, _res, next) {
    const token = (req.get('authorization') || '').replace(/^Bearer /, '');
    const session = token && db.prepare(
      "SELECT * FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')"
    ).get(token);
    if (!session) return next(new HttpError(401, 'Admin login required'));
    next();
  }

  const appointmentView = (a) => ({
    id: a.id, status: a.status, name: a.name, phone: a.phone, email: a.email,
    purpose: a.purpose, admin_note: a.admin_note, created_at: a.created_at, updated_at: a.updated_at,
    slot: { id: a.slot_id, date: a.date, start_time: a.start_time, end_time: a.end_time },
  });

  const APPOINTMENT_SELECT = `
    SELECT a.*, s.date, s.start_time, s.end_time
    FROM appointments a JOIN slots s ON s.id = a.slot_id`;

  const getAppointment = (id) => db.prepare(`${APPOINTMENT_SELECT} WHERE a.id = ?`).get(id);

  // ---- Public API -------------------------------------------------------

  app.get('/api/config', (_req, res) => {
    res.json({ timeZone, vapidPublicKey: notifier.publicKey });
  });

  app.get('/api/slots', (req, res) => {
    const today = nowInTimezone(timeZone, now()).date;
    const from = DATE_RE.test(req.query.from ?? '') && req.query.from > today ? req.query.from : today;
    const to = DATE_RE.test(req.query.to ?? '') ? req.query.to : addDays(from, 60);
    const slots = db.prepare(`
      SELECT s.id, s.date, s.start_time, s.end_time FROM slots s
      WHERE s.date BETWEEN ? AND ? AND s.is_blocked = 0
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${ACTIVE})
      ORDER BY s.date, s.start_time
    `).all(from, to).filter(isFuture);
    res.json({ slots });
  });

  app.post('/api/appointments', (req, res) => {
    const body = req.body ?? {};
    const name = text(body.name, 'Name', 100);
    const phone = text(body.phone, 'Phone number', 20);
    const email = text(body.email, 'Email', 200).toLowerCase();
    const purpose = text(body.purpose, 'Purpose of meeting', 2000);
    if (!PHONE_RE.test(phone)) throw new HttpError(400, 'Please enter a valid phone number');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address');
    const slotId = Number(body.slotId);

    const result = transaction(db, () => {
      const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
      if (!slot || slot.is_blocked || !isFuture(slot)) throw new HttpError(409, 'This slot is no longer available');
      const taken = db.prepare(`SELECT 1 FROM appointments WHERE slot_id = ? AND status IN ${ACTIVE}`).get(slot.id);
      if (taken) throw new HttpError(409, 'This slot was just requested by someone else. Please choose another.');

      let visitor = visitorFromRequest(req, { required: false });
      if (!visitor) {
        const token = newToken();
        const { lastInsertRowid } = db.prepare('INSERT INTO visitors (token) VALUES (?)').run(token);
        visitor = { id: lastInsertRowid, token };
      }
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO appointments (slot_id, visitor_id, name, phone, email, purpose)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(slot.id, visitor.id, name, phone, email, purpose);
      return { visitor, appointmentId: lastInsertRowid, slot };
    });

    notifier.notify(
      result.visitor.id, result.appointmentId, 'Request received',
      `Your request to meet Gurudev on ${formatSlot(result.slot)} is awaiting approval. We'll notify you here once it's reviewed.`
    );
    res.status(201).json({
      visitorToken: result.visitor.token,
      appointment: appointmentView(getAppointment(result.appointmentId)),
    });
  });

  // ---- Visitor ("My appointments") API ---------------------------------

  app.get('/api/me', (req, res) => {
    const visitor = visitorFromRequest(req);
    const appointments = db.prepare(`${APPOINTMENT_SELECT} WHERE a.visitor_id = ? ORDER BY s.date DESC, s.start_time DESC`)
      .all(visitor.id).map(appointmentView);
    const notifications = db.prepare('SELECT * FROM notifications WHERE visitor_id = ? ORDER BY id DESC LIMIT 100')
      .all(visitor.id);
    res.json({ appointments, notifications, unread: notifications.filter((n) => !n.read_at).length });
  });

  app.post('/api/me/notifications/read', (req, res) => {
    const visitor = visitorFromRequest(req);
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE visitor_id = ? AND read_at IS NULL").run(visitor.id);
    res.json({ ok: true });
  });

  app.post('/api/me/appointments/:id/cancel', (req, res) => {
    const visitor = visitorFromRequest(req);
    const appt = getAppointment(Number(req.params.id));
    if (!appt || appt.visitor_id !== visitor.id) throw new HttpError(404, 'Appointment not found');
    if (!['pending', 'approved'].includes(appt.status)) throw new HttpError(409, 'This appointment cannot be cancelled');
    db.prepare("UPDATE appointments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(appt.id);
    notifier.notify(visitor.id, appt.id, 'Appointment cancelled', `You cancelled your appointment on ${formatSlot(appt)}.`);
    res.json({ appointment: appointmentView(getAppointment(appt.id)) });
  });

  app.post('/api/me/push-subscriptions', (req, res) => {
    const visitor = visitorFromRequest(req);
    const { endpoint, keys } = req.body ?? {};
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || !keys?.p256dh || !keys?.auth) {
      throw new HttpError(400, 'Invalid push subscription');
    }
    db.prepare(`
      INSERT INTO push_subscriptions (visitor_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET visitor_id = excluded.visitor_id, p256dh = excluded.p256dh, auth = excluded.auth
    `).run(visitor.id, endpoint, String(keys.p256dh), String(keys.auth));
    res.status(201).json({ ok: true });
  });

  // Live notification stream (Server-Sent Events) for the open app.
  app.get('/api/me/stream', (req, res) => {
    const visitor = visitorFromRequest(req);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(': connected\n\n');
    const remove = notifier.addStream(visitor.id, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); remove(); });
  });

  // ---- Admin API --------------------------------------------------------

  app.post('/api/admin/login', (req, res) => {
    if (!safeEqual(req.body?.password ?? '', adminPassword)) throw new HttpError(401, 'Incorrect password');
    const token = newToken();
    db.prepare("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')").run();
    db.prepare(`INSERT INTO admin_sessions (token, expires_at) VALUES (?, datetime('now', '+${ADMIN_SESSION_DAYS} days'))`).run(token);
    res.json({ token });
  });

  app.post('/api/admin/logout', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(req.get('authorization').replace(/^Bearer /, ''));
    res.json({ ok: true });
  });

  app.get('/api/admin/appointments', requireAdmin, (req, res) => {
    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(`
      ${APPOINTMENT_SELECT}
      ${status ? 'WHERE a.status = ?' : ''}
      ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, s.date, s.start_time
    `).all(...(status ? [status] : []));
    const counts = Object.fromEntries(
      db.prepare('SELECT status, COUNT(*) AS n FROM appointments GROUP BY status').all().map((r) => [r.status, r.n])
    );
    res.json({ appointments: rows.map(appointmentView), counts });
  });

  function decide(req, res, status) {
    const appt = getAppointment(Number(req.params.id));
    if (!appt) throw new HttpError(404, 'Appointment not found');
    const allowed = status === 'cancelled' ? ['approved', 'pending'] : ['pending'];
    if (!allowed.includes(appt.status)) throw new HttpError(409, `Appointment is already ${appt.status}`);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) || null : null;

    // An approval close to the meeting already tells the visitor everything,
    // so skip reminders that would otherwise fire immediately afterwards.
    const minsAway = minutesUntil(appt.date, appt.start_time, timeZone, now());
    db.prepare(`
      UPDATE appointments SET status = ?, admin_note = ?, updated_at = datetime('now'),
        reminded_24h = reminded_24h OR ?, reminded_1h = reminded_1h OR ?
      WHERE id = ?
    `).run(status, note, status === 'approved' && minsAway <= 24 * 60 ? 1 : 0, status === 'approved' && minsAway <= 60 ? 1 : 0, appt.id);

    const when = formatSlot(appt);
    const suffix = note ? `\nNote: ${note}` : '';
    const messages = {
      approved: ['Appointment confirmed 🙏', `Your meeting with Gurudev is confirmed for ${when}. Please arrive 15 minutes early.${suffix}`],
      rejected: ['Appointment request declined', `We're sorry, your request for ${when} could not be accommodated.${suffix}`],
      cancelled: ['Appointment cancelled', `Your appointment on ${when} has been cancelled by the ashram.${suffix}`],
    };
    notifier.notify(appt.visitor_id, appt.id, ...messages[status]);
    res.json({ appointment: appointmentView(getAppointment(appt.id)) });
  }

  app.post('/api/admin/appointments/:id/approve', requireAdmin, (req, res) => decide(req, res, 'approved'));
  app.post('/api/admin/appointments/:id/reject', requireAdmin, (req, res) => decide(req, res, 'rejected'));
  app.post('/api/admin/appointments/:id/cancel', requireAdmin, (req, res) => decide(req, res, 'cancelled'));

  app.get('/api/admin/slots', requireAdmin, (req, res) => {
    const from = DATE_RE.test(req.query.from ?? '') ? req.query.from : nowInTimezone(timeZone, now()).date;
    const slots = db.prepare(`
      SELECT s.*, a.id AS appointment_id, a.status AS appointment_status, a.name AS visitor_name
      FROM slots s
      LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ${ACTIVE}
      WHERE s.date >= ?
      ORDER BY s.date, s.start_time
    `).all(from);
    res.json({ slots });
  });

  // Creates slots for every matching day in [fromDate, toDate] between
  // startTime and endTime, each `duration` minutes long with `gap` minutes between.
  app.post('/api/admin/slots', requireAdmin, (req, res) => {
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
    res.status(201).json({ created, skipped });
  });

  app.patch('/api/admin/slots/:id', requireAdmin, (req, res) => {
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(Number(req.params.id));
    if (!slot) throw new HttpError(404, 'Slot not found');
    db.prepare('UPDATE slots SET is_blocked = ? WHERE id = ?').run(req.body?.blocked ? 1 : 0, slot.id);
    res.json({ slot: db.prepare('SELECT * FROM slots WHERE id = ?').get(slot.id) });
  });

  app.delete('/api/admin/slots/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'Slot not found');
    if (db.prepare('SELECT 1 FROM appointments WHERE slot_id = ?').get(id)) {
      throw new HttpError(409, 'This slot has appointment history. Block it instead of deleting it.');
    }
    db.prepare('DELETE FROM slots WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ---- Errors -----------------------------------------------------------

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use((err, _req, res, _next) => {
    const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  return app;
}

// Sends "tomorrow" and "in one hour" reminders for approved appointments.
export function sendDueReminders({ db, notifier, timeZone, now = new Date() }) {
  const upcoming = db.prepare(`
    SELECT a.*, s.date, s.start_time, s.end_time FROM appointments a JOIN slots s ON s.id = a.slot_id
    WHERE a.status = 'approved' AND (a.reminded_24h = 0 OR a.reminded_1h = 0) AND s.date BETWEEN ? AND ?
  `).all(addDays(nowInTimezone(timeZone, now).date, -1), addDays(nowInTimezone(timeZone, now).date, 2));

  let sent = 0;
  for (const a of upcoming) {
    const mins = minutesUntil(a.date, a.start_time, timeZone, now);
    if (mins <= 0) continue;
    if (mins <= 60 && !a.reminded_1h) {
      db.prepare('UPDATE appointments SET reminded_1h = 1, reminded_24h = 1 WHERE id = ?').run(a.id);
      notifier.notify(a.visitor_id, a.id, 'Your meeting is in 1 hour',
        `Reminder: your meeting with Gurudev starts at ${a.start_time} today. Please arrive 15 minutes early.`);
      sent++;
    } else if (mins <= 24 * 60 && mins > 60 && !a.reminded_24h) {
      db.prepare('UPDATE appointments SET reminded_24h = 1 WHERE id = ?').run(a.id);
      notifier.notify(a.visitor_id, a.id, 'Upcoming meeting reminder',
        `Reminder: your meeting with Gurudev is on ${formatSlot(a)}.`);
      sent++;
    }
  }
  return sent;
}
