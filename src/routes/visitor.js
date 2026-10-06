import express from 'express';
import QRCode from 'qrcode';
import { transaction } from '../db.js';
import { requireUser } from '../auth.js';
import { HttpError, text, email as parseEmail, phone as parsePhone } from '../http.js';
import { ACTIVE, APPOINTMENT_SELECT, getAppointment, appointmentView, passState } from '../appointments.js';
import { nowInTimezone, minutesUntil, addDays, formatSlot, DATE_RE } from '../time.js';
import { openStream } from '../sse.js';

export function visitorRoutes({ db, notifier, config, now }) {
  const router = express.Router();
  const { timeZone } = config;
  const isFuture = (slot) => minutesUntil(slot.date, slot.start_time, timeZone, now()) > 0;
  const passOpts = () => ({ timeZone, now: now(), leadMinutes: config.qrLeadMinutes, graceMinutes: config.checkinGraceMinutes });

  router.get('/config', (_req, res) => {
    res.json({
      timeZone,
      vapidPublicKey: notifier.publicKey,
      qrLeadMinutes: config.qrLeadMinutes,
      contact: config.contact,
    });
  });

  router.get('/slots', (req, res) => {
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

  // ---- Everything below needs an account --------------------------------
  router.use(requireUser);

  router.post('/appointments', (req, res) => {
    const body = req.body ?? {};
    const name = text(body.name ?? req.user.name, 'Name', 100);
    const phone = parsePhone(body.phone ?? req.user.phone, config.defaultCountryCode);
    const email = parseEmail(body.email ?? req.user.email);
    const purpose = text(body.purpose, 'Purpose of meeting', 2000);
    const slotId = Number(body.slotId);

    const appointmentId = transaction(db, () => {
      const active = db.prepare(`
        SELECT COUNT(*) AS n FROM appointments a JOIN slots s ON s.id = a.slot_id
        WHERE a.user_id = ? AND a.status IN ${ACTIVE} AND s.date >= ?
      `).get(req.user.id, nowInTimezone(timeZone, now()).date).n;
      if (active >= config.maxActivePerUser) {
        throw new HttpError(409, `You can have at most ${config.maxActivePerUser} upcoming appointments at a time.`);
      }
      const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
      if (!slot || slot.is_blocked || !isFuture(slot)) throw new HttpError(409, 'This slot is no longer available');
      if (db.prepare(`SELECT 1 FROM appointments WHERE slot_id = ? AND status IN ${ACTIVE}`).get(slot.id)) {
        throw new HttpError(409, 'This slot was just requested by someone else. Please choose another.');
      }
      return db.prepare(`
        INSERT INTO appointments (slot_id, user_id, name, phone, email, purpose) VALUES (?, ?, ?, ?, ?, ?)
      `).run(slot.id, req.user.id, name, phone, email, purpose).lastInsertRowid;
    });

    const appt = getAppointment(db, appointmentId);
    notifier.notify(req.user.id, appt.id, 'Request received',
      `Your request to meet Gurudev on ${formatSlot(appt)} is awaiting approval. We'll notify you as soon as it's reviewed.`);
    notifier.emitToAdmins('appointment', { id: appt.id });
    if (config.adminNotifyEmail) {
      notifier.sendEmail(config.adminNotifyEmail, `New appointment request: ${name}`,
        `${name} (${phone}, ${email}) requested ${formatSlot(appt)}.\n\nPurpose: ${purpose}\n\nReview: ${config.appUrl}/admin.html#/requests`);
    }
    res.status(201).json({ appointment: appointmentView(appt) });
  });

  router.get('/me', (req, res) => {
    const appointments = db.prepare(`${APPOINTMENT_SELECT} WHERE a.user_id = ? ORDER BY s.date DESC, s.start_time DESC`)
      .all(req.user.id).map((a) => ({
        ...appointmentView(a),
        pass: passState(a, passOpts()),
        past: minutesUntil(a.date, a.end_time, timeZone, now()) < -config.checkinGraceMinutes,
      }));
    const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
    const unreadMessages = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND from_admin = 1 AND read_at IS NULL')
      .get(req.user.id).n;
    res.json({ appointments, notifications, unread: notifications.filter((n) => !n.read_at).length, unreadMessages });
  });

  router.post('/me/notifications/read', (req, res) => {
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
    res.json({ ok: true });
  });

  const ownAppointment = (req) => {
    const appt = getAppointment(db, Number(req.params.id));
    if (!appt || appt.user_id !== req.user.id) throw new HttpError(404, 'Appointment not found');
    return appt;
  };

  router.post('/me/appointments/:id/cancel', (req, res) => {
    const appt = ownAppointment(req);
    if (!['pending', 'approved'].includes(appt.status) || appt.checked_in_at) {
      throw new HttpError(409, 'This appointment cannot be cancelled');
    }
    db.prepare("UPDATE appointments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(appt.id);
    notifier.notify(req.user.id, appt.id, 'Appointment cancelled', `You cancelled your appointment on ${formatSlot(appt)}.`,
      { whatsapp: false });
    notifier.emitToAdmins('appointment', { id: appt.id });
    res.json({ appointment: appointmentView(getAppointment(db, appt.id)) });
  });

  // The entry pass. The QR code (and the secret inside it) is only sent
  // once the pass window has opened.
  router.get('/me/appointments/:id/pass', async (req, res) => {
    const appt = ownAppointment(req);
    const pass = passState(appt, passOpts());
    if (pass.state === 'ready') {
      pass.code = appt.checkin_code;
      pass.svg = await QRCode.toString(appt.checkin_code, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    }
    if (pass.state === 'checked_in') pass.checked_in_at = appt.checked_in_at;
    res.json({ appointment: appointmentView(appt), pass });
  });

  router.post('/me/push-subscriptions', (req, res) => {
    const { endpoint, keys } = req.body ?? {};
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || !keys?.p256dh || !keys?.auth) {
      throw new HttpError(400, 'Invalid push subscription');
    }
    db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
    `).run(req.user.id, endpoint, String(keys.p256dh), String(keys.auth));
    res.status(201).json({ ok: true });
  });

  // ---- Contact the admin team -------------------------------------------

  router.get('/me/messages', (req, res) => {
    db.prepare("UPDATE messages SET read_at = datetime('now') WHERE user_id = ? AND from_admin = 1 AND read_at IS NULL").run(req.user.id);
    const messages = db.prepare(`
      SELECT m.id, m.body, m.from_admin, m.created_at, u.name AS sender_name
      FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.user_id = ? ORDER BY m.id
    `).all(req.user.id);
    res.json({ messages });
  });

  router.post('/me/messages', (req, res) => {
    const body = text(req.body?.body, 'Message', 2000);
    const { lastInsertRowid } = db.prepare('INSERT INTO messages (user_id, sender_id, from_admin, body) VALUES (?, ?, 0, ?)')
      .run(req.user.id, req.user.id, body);
    notifier.emitToAdmins('message', { userId: req.user.id });
    if (config.adminNotifyEmail) {
      notifier.sendEmail(config.adminNotifyEmail, `New message from ${req.user.name}`,
        `${req.user.name} (${req.user.phone}) wrote:\n\n${body}\n\nReply: ${config.appUrl}/admin.html#/messages/${req.user.id}`);
    }
    res.status(201).json({ message: db.prepare('SELECT id, body, from_admin, created_at FROM messages WHERE id = ?').get(lastInsertRowid) });
  });

  router.get('/me/stream', (req, res) => {
    openStream(req, res, (stream) => notifier.addUserStream(req.user.id, stream));
  });

  return router;
}
