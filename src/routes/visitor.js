import express from 'express';
import QRCode from 'qrcode';
import { transaction, getSetting } from '../db.js';
import { requireUser, requireProfile } from '../auth.js';
import { HttpError, text, phone as parsePhone, normalizePhone, rateLimiter } from '../http.js';
import { findReference, referenceHasPhone } from '../references.js';
import {
  ACTIVE, APPOINTMENT_SELECT, PURPOSES, MAX_PEOPLE, getAppointment, appointmentView, viewsWithPeople, passState,
} from '../appointments.js';
import { nowInTimezone, minutesUntil, addDays, formatVisit, formatClock, PERIODS, DATE_RE } from '../time.js';

export function visitorRoutes({ db, notifier, config, now }) {
  const router = express.Router();
  const { timeZone, periods } = config;
  const today = () => nowInTimezone(timeZone, now()).date;
  const passOpts = () => ({ timeZone, now: now() });
  // A session can be booked until it ends.
  const stillOpen = (s) => s.date > today() || minutesUntil(s.date, periods[s.period].end, timeZone, now()) > 0;

  router.get('/config', (_req, res) => {
    res.json({
      timeZone,
      vapidPublicKey: notifier.publicKey,
      periods: Object.fromEntries(PERIODS.map((p) => [p, { label: periods[p].label, opensAt: formatClock(periods[p].start) }])),
      purposes: PURPOSES,
      maxPeople: MAX_PEOPLE,
      contact: config.contact,
      // Names only; the numbers are what the visitor must know.
      references: config.references.map((r) => ({ id: r.id, name: r.name })),
    });
  });

  const sessionLoad = db.prepare(`
    SELECT s.*, s.capacity - COALESCE((SELECT SUM(a.people_count) FROM appointments a WHERE a.session_id = s.id AND a.status IN ${ACTIVE}), 0) AS remaining
    FROM visit_sessions s WHERE s.date BETWEEN ? AND ? ORDER BY s.date
  `);

  // Dates with their morning / evening sessions. No times are shown
  // to visitors, only whether a session still has room.
  const bookingsClosed = () => (getSetting(db, 'bookings_open') === '0'
    ? { closed: true, closedMessage: getSetting(db, 'bookings_closed_message') || 'New bookings are closed right now. Please check again later.' } : null);

  router.get('/availability', (req, res) => {
    const closed = bookingsClosed();
    if (closed) return res.json({ days: [], ...closed });
    const t = today();
    const from = DATE_RE.test(req.query.from ?? '') && req.query.from > t ? req.query.from : t;
    const to = addDays(from, 60);
    const byDate = new Map();
    for (const s of sessionLoad.all(from, to)) {
      if (s.is_closed || !PERIODS.includes(s.period) || !stillOpen(s)) continue;
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date).push({ id: s.id, period: s.period, label: periods[s.period].label, remaining: Math.max(0, s.remaining) });
    }
    const days = [...byDate].map(([date, sessions]) => ({
      date, sessions: sessions.sort((a, b) => PERIODS.indexOf(a.period) - PERIODS.indexOf(b.period)),
    }));
    res.json({ days });
  });

  // ---- Booking ---------------------------------------------------------------

  // Each person can hold only one upcoming appointment, whether they booked
  // it or were added to someone else's group.
  const conflictsFor = (phones, self = null) => {
    if (!phones.length) return [];
    return db.prepare(`
      SELECT ap.phone, ap.name, ap.is_booker, a.name AS booked_by, a.date, a.period, a.status FROM appointment_people ap
      JOIN appointments a ON a.id = ap.appointment_id
      WHERE ap.phone IN (${phones.map(() => '?').join(',')}) AND a.status IN ${ACTIVE} AND a.date >= ?
    `).all(...phones, today()).map((c) => {
      const inGroup = c.is_booker ? '' : ` in ${c.booked_by}'s group`;
      const message = c.phone === self
        ? `You already have an appointment${inGroup} on ${formatVisit(c)}. Each person can have only one appointment. Ask ${c.is_booker ? 'the ashram' : c.booked_by} to remove you, or cancel it first.`
        : `${c.name} (${c.phone}) already has an appointment${inGroup} on ${formatVisit(c)}. Each person can have only one appointment. Cancel that one or remove this person.`;
      return { phone: c.phone, name: c.name, visit: formatVisit(c), message };
    });
  };

  function parsePeople(body, user) {
    const passPhone = parsePhone(body.phone ?? user.phone, config.defaultCountryCode, 'the WhatsApp number for your pass');
    const count = Number(body.peopleCount);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PEOPLE) throw new HttpError(400, `Please choose between 1 and ${MAX_PEOPLE} people`);
    const extra = Array.isArray(body.people) ? body.people : [];
    if (extra.length !== count - 1) throw new HttpError(400, `Please add the name and number of the ${count - 1} other ${count - 1 === 1 ? 'person' : 'people'}`);
    const people = extra.map((p, i) => {
      const name = text(p?.name, `the name of person ${i + 2}`, 80);
      const phone = normalizePhone(p?.phone, config.defaultCountryCode);
      if (!phone) throw new HttpError(400, `Please enter a valid phone number for ${name}`);
      return { name, phone };
    });
    const seen = new Map([[passPhone, 'you']]);
    for (const p of people) {
      if (seen.has(p.phone)) throw new HttpError(400, `${p.name}'s number is the same as ${seen.get(p.phone)}. Each person needs their own number.`);
      seen.set(p.phone, p.name);
    }
    return { passPhone, count, people };
  }

  // The visitor picks their reference from the list and types that person's
  // phone number; it must match. Wrong numbers are limited so the list can't
  // be guessed.
  const wrongReference = rateLimiter({ max: 10, windowMs: 60 * 60_000, message: 'Too many wrong reference numbers. Please check the number with your reference and try again in an hour.' });
  function checkReference(req) {
    const ref = findReference(config.references, req.body?.referenceId);
    if (!ref) throw new HttpError(400, 'Please choose who referred you from the list');
    const refPhone = parsePhone(req.body?.refPhone, config.defaultCountryCode, `${ref.name}'s phone number`);
    wrongReference.check(req.user.id);
    if (!referenceHasPhone(ref, refPhone)) {
      wrongReference(req.user.id);
      throw new HttpError(400, `This number does not match ${ref.name}. Please check the number with your reference. You can book only with the right number.`);
    }
    return { reference: ref.name, refPhone };
  }

  router.post('/reference/check', requireProfile, (req, res) => {
    checkReference(req);
    res.json({ ok: true });
  });

  // Lets the form warn about conflicts as soon as numbers are entered.
  router.post('/appointments/check', requireProfile, (req, res) => {
    const phones = [...new Set((req.body?.phones ?? []).map((p) => normalizePhone(p, config.defaultCountryCode)).filter(Boolean))];
    res.json({ conflicts: conflictsFor(phones, req.user.phone) });
  });

  router.post('/appointments', requireProfile, (req, res) => {
    const body = req.body ?? {};
    const user = req.user;
    const { reference, refPhone } = checkReference(req);
    const refDesignation = null;
    const purposes = [...new Set(Array.isArray(body.purposes) ? body.purposes : [])].filter((p) => p in PURPOSES);
    if (!purposes.length) throw new HttpError(400, 'Please choose the purpose of your meeting');
    const description = text(body.description, 'a few words about your visit', 500, { required: purposes.includes('other') });
    const { passPhone, count, people } = parsePeople(body, user);

    const closed = bookingsClosed();
    if (closed) throw new HttpError(409, closed.closedMessage);

    const appointmentId = transaction(db, () => {
      const mine = db.prepare(`SELECT date, period FROM appointments WHERE user_id = ? AND status IN ${ACTIVE} AND date >= ?`).get(user.id, today());
      if (mine) throw new HttpError(409, `You already have an appointment on ${formatVisit(mine)}. You can book a new one after cancelling it.`);
      const conflicts = conflictsFor([passPhone, user.phone, ...people.map((p) => p.phone)].filter((p, i, a) => a.indexOf(p) === i), user.phone);
      if (conflicts.length) throw new HttpError(409, conflicts[0].message, { conflicts });

      const session = db.prepare('SELECT * FROM visit_sessions WHERE id = ?').get(Number(body.sessionId));
      if (!session || session.is_closed || !stillOpen(session)) throw new HttpError(409, 'This session is no longer available. Please choose another.');
      const used = db.prepare(`SELECT COALESCE(SUM(people_count), 0) AS n FROM appointments WHERE session_id = ? AND status IN ${ACTIVE}`).get(session.id).n;
      if (used + count > session.capacity) {
        const left = Math.max(0, session.capacity - used);
        throw new HttpError(409, left ? `Only ${left} ${left === 1 ? 'place is' : 'places are'} left in this session.` : 'This session is full. Please choose another.');
      }

      const appt = db.prepare(`
        INSERT INTO appointments (user_id, session_id, date, period, name, phone, photo, reference, ref_phone, ref_designation, people_count, purposes, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
      `).get(user.id, session.id, session.date, session.period, user.name, passPhone, user.photo, reference, refPhone, refDesignation, count, JSON.stringify(purposes), description || null);
      const addPerson = db.prepare('INSERT INTO appointment_people (appointment_id, name, phone, is_booker) VALUES (?, ?, ?, ?)');
      addPerson.run(appt.id, user.name, passPhone, 1);
      if (user.phone !== passPhone) addPerson.run(appt.id, user.name, user.phone, 1);
      for (const p of people) addPerson.run(appt.id, p.name, p.phone, 0);
      return appt.id;
    });

    const appt = getAppointment(db, appointmentId);
    notifier.notify(user.id, appt.id, 'Request received 🙏',
      `We have received your request to meet Gurudev on ${formatVisit(appt)} for ${count} ${count === 1 ? 'person' : 'people'}. We will send you a confirmation after it is reviewed.`,
      { phone: appt.phone });
    notifier.emitToStaff('appointment', { id: appt.id });
    res.status(201).json({ appointment: viewsWithPeople(db, [appt])[0] });
  });

  // ---- My visit -------------------------------------------------------------------

  router.get('/me', requireUser, (req, res) => {
    const rows = db.prepare(`${APPOINTMENT_SELECT} WHERE a.user_id = ? ORDER BY a.date DESC, a.id DESC LIMIT 20`).all(req.user.id);
    const appointments = viewsWithPeople(db, rows).map((a, i) => ({
      ...a, pass: passState(rows[i], passOpts()), upcoming: ['pending', 'hold', 'approved'].includes(a.status) && a.date >= today(),
    }));
    const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
    res.json({ appointments, notifications, unread: notifications.filter((n) => !n.read_at).length });
  });

  router.post('/me/notifications/read', requireUser, (req, res) => {
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
    res.json({ ok: true });
  });

  const own = (req) => {
    const appt = getAppointment(db, Number(req.params.id));
    if (!appt || appt.user_id !== req.user.id) throw new HttpError(404, 'Appointment not found');
    return appt;
  };

  router.post('/me/appointments/:id/cancel', requireUser, (req, res) => {
    const appt = own(req);
    if (!['pending', 'hold', 'approved'].includes(appt.status) || appt.checked_in_at) throw new HttpError(409, 'This appointment cannot be cancelled');
    db.prepare("UPDATE appointments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(appt.id);
    notifier.notify(req.user.id, appt.id, 'Appointment cancelled', `Your appointment on ${formatVisit(appt)} has been cancelled.`, { phone: false });
    notifier.emitToStaff('appointment', { id: appt.id });
    res.json({ appointment: viewsWithPeople(db, [getAppointment(db, appt.id)])[0] });
  });

  // The QR code shows as soon as the visit is confirmed.
  router.get('/me/appointments/:id/pass', requireUser, async (req, res) => {
    const appt = own(req);
    const pass = passState(appt, passOpts());
    if (pass.state === 'ready') {
      pass.code = appt.checkin_code;
      pass.svg = await QRCode.toString(appt.checkin_code, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    }
    res.json({ appointment: appointmentView(appt), pass });
  });

  router.post('/me/push-subscriptions', requireUser, (req, res) => {
    const { endpoint, keys } = req.body ?? {};
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || !keys?.p256dh || !keys?.auth) throw new HttpError(400, 'Invalid push subscription');
    db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
    `).run(req.user.id, endpoint, String(keys.p256dh), String(keys.auth));
    res.status(201).json({ ok: true });
  });

  router.get('/me/stream', requireUser, (req, res) => notifier.openUserStream(req, res, req.user.id));

  return router;
}
