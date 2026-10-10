import express from 'express';
import { transaction, getSetting, setSetting } from '../db.js';
import { requireAdmin, publicUser } from '../auth.js';
import { HttpError, text, phone as parsePhone, rateLimiter } from '../http.js';
import {
  ACTIVE, APPOINTMENT_SELECT, PURPOSES, MAX_PEOPLE, getAppointment, viewsWithPeople, currentPeriod, newCheckinCode, newPassToken, passMessage, confirmMessage, passAppMessage, sqlTime, parseSqlTime, VISIT_MINUTES,
} from '../appointments.js';
import { nowInTimezone, addDays, dayOfWeek, formatVisit, formatDay, PERIODS, DATE_RE } from '../time.js';
import { findReference, referenceOfPhone } from '../references.js';

export function adminRoutes({ db, notifier, config, now, photos }) {
  const router = express.Router();
  const { timeZone, periods } = config;
  const today = () => nowInTimezone(timeZone, now()).date;
  const dateParam = (v, fallback) => (DATE_RE.test(v ?? '') ? v : fallback);
  router.use(requireAdmin);
  // Each admin is one of the references; security staff ask one of them for approval.
  const myReference = (req) => referenceOfPhone(config.references, req.user.phone)?.id ?? null;

  // ---- Dashboard ----------------------------------------------------------------

  router.get('/dashboard', (req, res) => {
    const t = today();
    const date = dateParam(req.query.date, t);
    const perPeriod = db.prepare(`
      SELECT s.period, s.capacity,
        COUNT(a.id) AS bookings, COALESCE(SUM(a.people_count), 0) AS people,
        COUNT(a.checked_in_at) AS checkedInBookings,
        COALESCE(SUM(CASE WHEN a.checked_in_at IS NOT NULL THEN COALESCE(a.checked_in_count, a.people_count) END), 0) AS checkedInPeople
      FROM visit_sessions s LEFT JOIN appointments a ON a.session_id = s.id AND a.status = 'approved'
      WHERE s.date = ? GROUP BY s.id
    `).all(date);
    const byPeriod = new Map(perPeriod.map((p) => [p.period, p]));
    const sessions = PERIODS.filter((p) => byPeriod.has(p)).map((p) => ({ period: p, label: periods[p].label, ...byPeriod.get(p) }));
    const sum = (k) => sessions.reduce((n, s) => n + s[k], 0);

    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM appointments WHERE status = 'pending' AND date >= ?) AS pending,
        (SELECT COUNT(*) FROM appointments WHERE status = 'hold' AND date >= ?) AS hold,
        (SELECT COUNT(*) FROM users WHERE role = 'security' AND status = 'pending' AND name IS NOT NULL AND photo IS NOT NULL AND reference_id = ?) AS securityPending,
        (SELECT COUNT(*) FROM users WHERE role = 'security' AND status = 'active') AS securityActive
    `).get(t, t, myReference(req));

    const recent = db.prepare(`${APPOINTMENT_SELECT} WHERE a.date = ? AND a.checked_in_at IS NOT NULL ORDER BY a.checked_in_at DESC LIMIT 12`).all(date);

    const from = addDays(date, -6);
    const to = addDays(date, 7);
    const series = new Map(db.prepare(`
      SELECT date, SUM(people_count) AS people, SUM(CASE WHEN checked_in_at IS NOT NULL THEN COALESCE(checked_in_count, people_count) ELSE 0 END) AS checkedIn
      FROM appointments WHERE status = 'approved' AND date BETWEEN ? AND ? GROUP BY date
    `).all(from, to).map((r) => [r.date, r]));
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push({ date: d, people: series.get(d)?.people ?? 0, checkedIn: series.get(d)?.checkedIn ?? 0 });

    res.json({
      date, today: t,
      summary: {
        bookings: sum('bookings'), people: sum('people'), checkedInBookings: sum('checkedInBookings'),
        checkedInPeople: sum('checkedInPeople'), capacity: sum('capacity'),
        remainingPeople: db.prepare("SELECT COALESCE(SUM(people_count), 0) AS n FROM appointments WHERE date = ? AND status = 'approved' AND checked_in_at IS NULL").get(date).n,
        // Checked in during the last 30 minutes (taken as still inside).
        insideNow: db.prepare("SELECT COALESCE(SUM(COALESCE(checked_in_count, people_count)), 0) AS n FROM appointments WHERE status = 'approved' AND checked_in_at > ?")
          .get(sqlTime(new Date(now().getTime() - VISIT_MINUTES * 60000))).n,
        ...counts,
      },
      sessions,
      recent: viewsWithPeople(db, recent),
      days,
    });
  });

  // ---- Daily report and feedback ---------------------------------------------------
  // Everything about one day in one answer; the admin app draws it as a
  // shareable picture or a printable page.
  router.get('/report', (req, res) => {
    const date = dateParam(req.query.date, today());
    const all = db.prepare(`${APPOINTMENT_SELECT} WHERE a.date = ?`).all(date);
    const ok = all.filter((a) => a.status === 'approved');
    const came = ok.filter((a) => a.checked_in_at);
    const peopleOf = (a) => (a.checked_in_at ? (a.checked_in_count ?? a.people_count) : 0);
    const hourOf = (a) => Number(nowInTimezone(timeZone, parseSqlTime(a.checked_in_at)).time.slice(0, 2));
    const group = (rows, key) => {
      const m = new Map();
      for (const a of rows) {
        const k = key(a);
        if (!k) continue;
        const g = m.get(k) ?? { name: k, groups: 0, people: 0 };
        g.groups += 1;
        g.people += a.checked_in_at ? peopleOf(a) : a.people_count;
        m.set(k, g);
      }
      return [...m.values()].sort((x, y) => y.people - x.people);
    };
    const hours = new Map();
    for (const a of came) hours.set(hourOf(a), (hours.get(hourOf(a)) ?? 0) + peopleOf(a));
    const rated = all.filter((a) => a.feedback_rating);
    const stars = [1, 2, 3, 4, 5].map((n) => rated.filter((a) => a.feedback_rating === n).length);
    res.json({
      date,
      generatedAt: now().toISOString(),
      totals: {
        bookings: ok.length,
        peopleExpected: ok.reduce((n, a) => n + a.people_count, 0),
        groupsCame: came.length,
        peopleCame: came.reduce((n, a) => n + peopleOf(a), 0),
        noShowGroups: ok.length - came.length,
        noShowPeople: ok.filter((a) => !a.checked_in_at).reduce((n, a) => n + a.people_count, 0),
        express: ok.filter((a) => a.express).length,
        pending: all.filter((a) => ['pending', 'hold'].includes(a.status)).length,
        declined: all.filter((a) => a.status === 'rejected').length,
        cancelled: all.filter((a) => a.status === 'cancelled').length,
      },
      sessions: PERIODS.map((p) => ({
        label: periods[p].label,
        expected: ok.filter((a) => a.period === p).reduce((n, a) => n + a.people_count, 0),
        came: came.filter((a) => a.period === p).reduce((n, a) => n + peopleOf(a), 0),
      })),
      hours: [...hours].sort((x, y) => x[0] - y[0]).map(([hour, people]) => ({ hour, people })),
      staff: group(came, (a) => a.checked_in_by_name),
      references: group(ok, (a) => a.reference || null).slice(0, 6),
      feedback: {
        count: rated.length,
        average: rated.length ? Math.round((rated.reduce((n, a) => n + a.feedback_rating, 0) / rated.length) * 10) / 10 : null,
        stars,
        comments: rated.filter((a) => a.feedback_comment).slice(0, 5).map((a) => ({ name: a.name, rating: a.feedback_rating, comment: a.feedback_comment })),
      },
    });
  });

  // Visitor feedback, newest first, with the average and how many of each star.
  router.get('/feedback', (req, res) => {
    const rows = db.prepare(`${APPOINTMENT_SELECT} WHERE a.feedback_rating IS NOT NULL ORDER BY a.feedback_at DESC LIMIT 300`).all();
    const all = db.prepare('SELECT feedback_rating AS r, COUNT(*) AS n FROM appointments WHERE feedback_rating IS NOT NULL GROUP BY r').all();
    const count = all.reduce((n, x) => n + x.n, 0);
    res.json({
      count,
      average: count ? Math.round((all.reduce((n, x) => n + x.r * x.n, 0) / count) * 10) / 10 : null,
      stars: [1, 2, 3, 4, 5].map((r) => all.find((x) => x.r === r)?.n ?? 0),
      feedback: viewsWithPeople(db, rows).map((a) => ({ id: a.id, name: a.name, photo: a.photo, date: a.date, periodLabel: a.periodLabel, rating: a.feedbackRating, comment: a.feedbackComment, reference: a.reference })),
    });
  });

  // ---- Appointments ------------------------------------------------------------------

  // ?status=pending|hold  -> upcoming requests across all dates
  // ?date=YYYY-MM-DD      -> everything on that day (filter with status, period, checked, q)
  router.get('/appointments', (req, res) => {
    const where = [];
    const args = [];
    const { status, period, checked } = req.query;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
    if (DATE_RE.test(req.query.date ?? '')) { where.push('a.date = ?'); args.push(req.query.date); }
    else { where.push('a.date >= ?'); args.push(today()); }
    if (['pending', 'hold', 'approved', 'rejected', 'cancelled'].includes(status)) { where.push('a.status = ?'); args.push(status); }
    if (PERIODS.includes(period)) { where.push('a.period = ?'); args.push(period); }
    if (checked === 'in') where.push("a.status = 'approved' AND a.checked_in_at IS NOT NULL");
    if (checked === 'out') where.push("a.status = 'approved' AND a.checked_in_at IS NULL");
    if (q) {
      const digits = q.replace(/\D/g, '');
      where.push(`(a.name LIKE ? OR a.reference LIKE ? OR a.ref_designation LIKE ?${digits.length >= 3 ? ' OR a.ref_phone LIKE ? OR a.id IN (SELECT appointment_id FROM appointment_people WHERE phone LIKE ?)' : ''} OR a.id IN (SELECT appointment_id FROM appointment_people WHERE name LIKE ?))`);
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, ...(digits.length >= 3 ? [`%${digits}%`, `%${digits}%`] : []), `%${q}%`);
    }
    const rows = db.prepare(`
      ${APPOINTMENT_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY a.date, CASE a.period WHEN 'morning' THEN 0 WHEN 'afternoon' THEN 1 ELSE 2 END, a.checked_in_at IS NOT NULL, a.id
      LIMIT 1000
    `).all(...args);

    let stats = null;
    if (DATE_RE.test(req.query.date ?? '')) {
      stats = db.prepare(`
        SELECT
          SUM(status = 'approved') AS approved, SUM(status = 'pending') AS pending, SUM(status = 'hold') AS hold,
          COALESCE(SUM(CASE WHEN status = 'approved' THEN people_count END), 0) AS people,
          SUM(status = 'approved' AND checked_in_at IS NOT NULL) AS checkedIn,
          COALESCE(SUM(CASE WHEN status = 'approved' AND checked_in_at IS NOT NULL THEN COALESCE(checked_in_count, people_count) END), 0) AS checkedInPeople
        FROM appointments WHERE date = ?
      `).get(req.query.date);
      for (const k in stats) stats[k] ??= 0;
      stats.remaining = stats.approved - stats.checkedIn;
      stats.remainingPeople = db.prepare("SELECT COALESCE(SUM(people_count), 0) AS n FROM appointments WHERE date = ? AND status = 'approved' AND checked_in_at IS NULL").get(req.query.date).n;
    }
    res.json({ appointments: viewsWithPeople(db, rows), stats });
  });

  function review(req, res, status) {
    const appt = getAppointment(db, Number(req.params.id));
    if (!appt) throw new HttpError(404, 'Appointment not found');
    const allowed = { approved: ['pending', 'hold'], hold: ['pending'], rejected: ['pending', 'hold'], cancelled: ['approved', 'pending', 'hold'] }[status];
    if (!allowed.includes(appt.status)) throw new HttpError(409, `This appointment is already ${appt.status === 'hold' ? 'on hold' : appt.status}.`);
    if (appt.checked_in_at) throw new HttpError(409, 'This visitor has already checked in.');
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null;

    const t = today();
    const tomorrow = addDays(t, 1);
    const approved = status === 'approved';
    if (approved) {
      // Nobody in the group may already have another confirmed visit.
      const clash = db.prepare(`
        SELECT ap.name, a.date, a.period FROM appointment_people mine
        JOIN appointment_people ap ON ap.phone = mine.phone AND ap.appointment_id != mine.appointment_id
        JOIN appointments a ON a.id = ap.appointment_id
        WHERE mine.appointment_id = ? AND a.status = 'approved' AND a.date >= ? LIMIT 1
      `).get(appt.id, t);
      if (clash) throw new HttpError(409, `${clash.name} already has a confirmed visit on ${formatVisit(clash)}. Each person can have only one appointment.`);
    }
    // A late approval already says everything the earlier reminders would.
    const skipReminder = approved && (appt.date === t || (appt.date === tomorrow && nowInTimezone(timeZone, now()).time >= config.reminderTime));
    const skipGreeting = approved && appt.date === t;
    db.prepare(`
      UPDATE appointments SET status = ?, admin_note = COALESCE(?, admin_note), reviewed_by = ?, updated_at = datetime('now'),
        checkin_code = CASE WHEN ? THEN COALESCE(checkin_code, ?) ELSE checkin_code END,
        pass_token = CASE WHEN ? THEN COALESCE(pass_token, ?) ELSE pass_token END,
        reminded_day_before = reminded_day_before OR ?, greeted = greeted OR ?
      WHERE id = ?
    `).run(status, note, req.user.id, approved ? 1 : 0, approved ? newCheckinCode(db) : null, approved ? 1 : 0, approved ? newPassToken() : null,
      skipReminder ? 1 : 0, skipGreeting ? 1 : 0, appt.id);

    const when = formatVisit(appt);
    const suffix = note ? `\nNote: ${note}` : '';
    if (approved) {
      // The confirmation carries the pass link, so it can be opened any time.
      const a = getAppointment(db, appt.id);
      db.prepare("UPDATE appointments SET pass_sent_at = COALESCE(pass_sent_at, datetime('now')) WHERE id = ?").run(a.id);
      notifier.sendPass(a, 'Visit confirmed ✅', `${confirmMessage(a, when)}${suffix}`, `${passAppMessage(a, when)}${suffix}`);
    }
    const messages = {
      rejected: ['Sorry, request declined', `We could not give you a visit on ${when}.${suffix}`],
      cancelled: ['Visit cancelled', `Your visit on ${when} is cancelled by the ashram.${suffix}`],
    };
    if (messages[status]) notifier.notify(appt.user_id, appt.id, ...messages[status], { phone: appt.phone });
    notifier.emitToStaff('appointment', { id: appt.id });
    res.json({ appointment: viewsWithPeople(db, [getAppointment(db, appt.id)])[0] });
  }

  router.post('/appointments/:id/approve', (req, res) => review(req, res, 'approved'));
  router.post('/appointments/:id/hold', (req, res) => review(req, res, 'hold'));
  router.post('/appointments/:id/reject', (req, res) => review(req, res, 'rejected'));
  router.post('/appointments/:id/cancel', (req, res) => review(req, res, 'cancelled'));

  // ---- Express pass ----------------------------------------------------------------
  // An admin lets someone in today with just a name and WhatsApp number. The
  // pass is approved at once, valid for the rest of today, and sent on WhatsApp.

  // Photo taken by the admin for an express pass (optional).
  const photoLimit = rateLimiter({ max: 60, windowMs: 60 * 60_000, message: 'Too many photos. Please try again later.' });
  router.post('/photos', (req, _res, next) => { photoLimit(req.user.id); next(); }, express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '450kb' }), (req, res) => {
    res.status(201).json({ photo: photos.save(req.body) });
  });

  router.post('/express', (req, res) => {
    const body = req.body ?? {};
    const name = text(body.name, 'their name', 80);
    const phone = parsePhone(body.phone, config.defaultCountryCode, 'their WhatsApp number');
    const count = body.peopleCount === undefined || body.peopleCount === '' ? 1 : Number(body.peopleCount);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PEOPLE) throw new HttpError(400, `Please choose between 1 and ${MAX_PEOPLE} people`);
    const photo = typeof body.photo === 'string' && body.photo ? body.photo : null;
    if (photo && !photos.read(photo)) throw new HttpError(400, 'The photo was not saved. Please take it again.');
    // The reference is picked from the list; their number is filled in for the
    // admin calls page (the admin's own number when they are the reference).
    const ref = body.referenceId ? findReference(config.references, body.referenceId) : null;
    if (body.referenceId && !ref) throw new HttpError(400, 'Please choose the reference from the list');
    const reference = ref?.name ?? '';
    const refPhone = ref ? `+${config.defaultCountryCode}${referenceOfPhone([ref], req.user.phone) ? req.user.phone.slice(-10) : ref.phones[0]}` : null;
    const refDesignation = null;
    const purposes = (Array.isArray(body.purposes) ? body.purposes : []).filter((p) => p in PURPOSES);
    const description = text(body.description, 'the note', 500, { required: false });

    const t = today();
    const conflicts = db.prepare(`
      SELECT a.date, a.period FROM appointment_people ap JOIN appointments a ON a.id = ap.appointment_id
      WHERE ap.phone = ? AND a.status IN ${ACTIVE} AND a.date >= ?
    `).all(phone, t);
    if (conflicts.length && !body.force) {
      throw new HttpError(409, `${name} already has an appointment on ${formatVisit(conflicts[0])}. Create an express pass anyway?`, { conflicts: conflicts.map(formatVisit) });
    }

    const period = currentPeriod(periods, nowInTimezone(timeZone, now()).time);
    const id = transaction(db, () => {
      let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
      user ??= db.prepare("INSERT INTO users (phone, name, role, status) VALUES (?, ?, 'visitor', 'active') RETURNING *").get(phone, name);
      if (!user.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
      // Express passes don't use public places; a closed session is made if the day has none.
      const session = db.prepare('SELECT * FROM visit_sessions WHERE date = ? AND period = ?').get(t, period)
        ?? db.prepare('INSERT INTO visit_sessions (date, period, capacity, is_closed) VALUES (?, ?, 0, 1) RETURNING *').get(t, period);
      const appt = db.prepare(`
        INSERT INTO appointments (user_id, session_id, date, period, name, phone, photo, reference, ref_phone, ref_designation, people_count, purposes, description,
          status, express, created_by, reviewed_by, checkin_code, pass_token, reminded_day_before, greeted, pass_sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1, ?, ?, ?, ?, 1, 1, datetime('now')) RETURNING id
      `).get(user.id, session.id, t, period, name, phone, photo ?? user.photo, reference, refPhone, refDesignation || null, count,
        JSON.stringify(purposes), description || null, req.user.id, req.user.id, newCheckinCode(db), newPassToken());
      db.prepare('INSERT INTO appointment_people (appointment_id, name, phone, is_booker) VALUES (?, ?, ?, 1)').run(appt.id, name, phone);
      return appt.id;
    });

    const appt = getAppointment(db, id);
    notifier.sendPass(appt, 'Your express pass 🎟️', passMessage(appt, `today (${formatDay(t)})`), passAppMessage(appt, 'Today'));
    notifier.emitToStaff('appointment', { id });
    res.status(201).json({ appointment: viewsWithPeople(db, [appt])[0] });
  });

  // ---- Security staff ------------------------------------------------------------------

  const staffView = (u) => ({
    ...publicUser(u), createdAt: u.created_at, reviewedBy: u.reviewed_by_name ?? null, checkinsToday: u.checkins_today ?? 0,
    reference: findReference(config.references, u.reference_id)?.name ?? null,
  });

  router.get('/security', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
    const digits = q.replace(/\D/g, '');
    const rows = db.prepare(`
      SELECT u.*, r.name AS reviewed_by_name,
        (SELECT COUNT(*) FROM appointments a WHERE a.checked_in_by = u.id AND a.date = ?) AS checkins_today
      FROM users u LEFT JOIN users r ON r.id = u.reviewed_by
      WHERE u.role = 'security' AND u.name IS NOT NULL AND u.photo IS NOT NULL
        AND (u.status != 'pending' OR u.reference_id = ?)
      ${q ? `AND (u.name LIKE ?${digits ? ' OR u.phone LIKE ?' : ''})` : ''}
      ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, u.name
    `).all(today(), myReference(req), ...(q ? [`%${q}%`, ...(digits ? [`%${digits}%`] : [])] : []));
    res.json({ staff: rows.map(staffView) });
  });

  function setSecurity(req, res, status) {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'security'").get(Number(req.params.id));
    if (!u) throw new HttpError(404, 'Security staff member not found');
    // A new request can only be answered by the reference it was sent to.
    if (u.status === 'pending' && u.reference_id !== myReference(req)) {
      throw new HttpError(403, `Only ${findReference(config.references, u.reference_id)?.name ?? 'their reference'} can approve this request.`);
    }
    db.prepare("UPDATE users SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(status, req.user.id, u.id);
    const msg = {
      active: ['Approved ✅ You can scan now', 'Open the app to scan passes.'],
      revoked: ['Scanner access removed', 'Please speak to the admin.'],
      rejected: ['Sorry, not approved', 'Your scanner request was not approved.'],
    }[status];
    notifier.notify(u.id, null, ...msg, { path: '' });
    notifier.emitToUser(u.id, 'status', { status });
    notifier.emitToStaff('security');
    res.json({ staff: staffView({ ...u, status }) });
  }
  router.post('/security/:id/approve', (req, res) => setSecurity(req, res, 'active'));
  router.post('/security/:id/revoke', (req, res) => setSecurity(req, res, 'revoked'));
  router.post('/security/:id/reject', (req, res) => setSecurity(req, res, 'rejected'));

  // ---- Admin accounts -----------------------------------------------------------------

  // The admins are the people on the reference list (see src/references.js).
  router.get('/admins', (_req, res) => {
    res.json({ admins: db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY name").all().map(publicUser) });
  });

  // ---- Bookings on/off and slots -------------------------------------------------------

  router.get('/booking-status', (_req, res) => {
    res.json({ open: getSetting(db, 'bookings_open') !== '0', message: getSetting(db, 'bookings_closed_message') ?? '' });
  });

  // Stops (or restarts) all new bookings. Existing appointments are not affected.
  router.post('/booking-status', (req, res) => {
    const open = Boolean(req.body?.open);
    setSetting(db, 'bookings_open', open ? '1' : '0');
    setSetting(db, 'bookings_closed_message', text(req.body?.message, 'the message', 200, { required: false }));
    notifier.emitToStaff('sessions');
    res.json({ open, message: getSetting(db, 'bookings_closed_message') });
  });

  // Closes or opens every session on one day.
  router.post('/sessions/day', (req, res) => {
    const date = dateParam(req.body?.date, null);
    if (!date) throw new HttpError(400, 'Please choose a date');
    const { changes } = db.prepare('UPDATE visit_sessions SET is_closed = ? WHERE date = ? AND capacity > 0').run(req.body?.closed ? 1 : 0, date);
    notifier.emitToStaff('sessions');
    res.json({ updated: changes });
  });

  // ---- Visit sessions (which days are open, and how many people) ------------------------

  router.get('/sessions', (req, res) => {
    const from = dateParam(req.query.from, today());
    const to = dateParam(req.query.to, addDays(from, 30));
    const sessions = db.prepare(`
      SELECT s.*, COALESCE(SUM(a.people_count), 0) AS booked, COUNT(a.id) AS bookings
      FROM visit_sessions s LEFT JOIN appointments a ON a.session_id = s.id AND a.status IN ${ACTIVE}
      WHERE s.date BETWEEN ? AND ? GROUP BY s.id
      ORDER BY s.date, CASE s.period WHEN 'morning' THEN 0 WHEN 'afternoon' THEN 1 ELSE 2 END
    `).all(from, to).map((s) => ({ ...s, label: periods[s.period].label }));
    res.json({ sessions });
  });

  router.post('/sessions', (req, res) => {
    const fromDate = dateParam(req.body?.fromDate, null);
    const toDate = dateParam(req.body?.toDate ?? req.body?.fromDate, null);
    if (!fromDate || !toDate) throw new HttpError(400, 'Please choose the dates');
    if (toDate < fromDate) throw new HttpError(400, 'The end date must be after the start date');
    if (addDays(fromDate, 366) < toDate) throw new HttpError(400, 'Please choose at most one year at a time');
    const chosen = (Array.isArray(req.body?.periods) ? req.body.periods : []).filter((p) => PERIODS.includes(p));
    if (!chosen.length) throw new HttpError(400, 'Please choose Morning, Afternoon or Evening');
    const capacity = Number(req.body?.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) throw new HttpError(400, 'Please enter how many people each session can take');
    const weekdays = Array.isArray(req.body?.weekdays) ? req.body.weekdays.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    // Sessions made only for express passes (capacity 0) are opened up too.
    const insert = db.prepare(`
      INSERT INTO visit_sessions (date, period, capacity) VALUES (?, ?, ?)
      ON CONFLICT(date, period) DO UPDATE SET capacity = excluded.capacity, is_closed = 0 WHERE visit_sessions.capacity = 0
    `);
    let created = 0;
    let skipped = 0;
    transaction(db, () => {
      for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
        if (!weekdays.includes(dayOfWeek(d))) continue;
        for (const p of chosen) insert.run(d, p, capacity).changes ? created++ : skipped++;
      }
    });
    notifier.emitToStaff('sessions');
    res.status(201).json({ created, skipped });
  });

  router.patch('/sessions/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM visit_sessions WHERE id = ?').get(Number(req.params.id));
    if (!s) throw new HttpError(404, 'Session not found');
    const capacity = req.body?.capacity === undefined ? s.capacity : Number(req.body.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) throw new HttpError(400, 'Please enter how many people this session can take');
    const closed = req.body?.closed === undefined ? s.is_closed : req.body.closed ? 1 : 0;
    const updated = db.prepare('UPDATE visit_sessions SET capacity = ?, is_closed = ? WHERE id = ? RETURNING *').get(capacity, closed, s.id);
    notifier.emitToStaff('sessions');
    res.json({ session: updated });
  });

  router.delete('/sessions/:id', (req, res) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM appointments WHERE session_id = ?').get(id)) throw new HttpError(409, 'This session has bookings. Close it instead of deleting it.');
    if (!db.prepare('DELETE FROM visit_sessions WHERE id = ? RETURNING id').get(id)) throw new HttpError(404, 'Session not found');
    notifier.emitToStaff('sessions');
    res.json({ ok: true });
  });

  // ---- WhatsApp delivery log ----------------------------------------------------------

  router.get('/outbox', (_req, res) => {
    res.json({ messages: db.prepare('SELECT id, kind, recipient, preview, status, error, created_at, sent_at FROM outbound_messages ORDER BY id DESC LIMIT 100').all() });
  });

  return router;
}
