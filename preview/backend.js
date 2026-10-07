// In-browser stand-in for the server, used only by the interactive preview.
// It mirrors the API in src/routes/*.js closely enough for every screen to
// work, keeps its data in the viewer's own browser, and records the emails and
// WhatsApp messages the real server would send.
import QRCode from 'qrcode';
import { nowInTimezone, minutesUntil, addDays, dayOfWeek, toHHMM, fromHHMM, formatSlot, DATE_RE, TIME_RE } from '../src/time.js';
import { passState } from '../src/appointments.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
const STORE_KEY = 'gurudev-preview-v1';
const CONFIG = {
  timeZone: TZ, qrLeadMinutes: 10, checkinEarlyMinutes: 30, checkinGraceMinutes: 60, maxActivePerUser: 3,
  contact: { phone: '+91 80 1234 5678', whatsapp: '+918012345678', email: 'visits@example.org', address: 'Main Ashram Office, Bengaluru' },
};
export const ADMIN_LOGIN = { email: 'admin@demo.org', password: 'demo1234' };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const code = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b % 64]).join('');
const today = () => nowInTimezone(TZ).date;
const nowTime = () => nowInTimezone(TZ).time;

let db;
const listeners = new Set();

function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch { /* preview still works without storage */ } }
function nextId(table) { db.seq[table] = (db.seq[table] ?? 0) + 1; return db.seq[table]; }

// ---- Seed data ------------------------------------------------------------------

function seed() {
  db = { seq: {}, users: [], slots: [], appointments: [], notifications: [], messages: [], outbox: [], sessions: {} };
  const user = (name, email, phone, role = 'visitor') => {
    const u = { id: nextId('users'), name, email, phone, password: 'demo1234', role, created_at: nowSql() };
    db.users.push(u);
    return u;
  };
  const admin = user('Seva Admin', ADMIN_LOGIN.email, '+919000000001', 'admin');
  const people = [
    ['Meera Iyer', '+919845012345'], ['Rahul Sharma', '+919810054321'], ['Priya Nair', '+919746098765'],
    ['Arjun Reddy', '+919849011223'], ['Kavita Joshi', '+919822033445'], ['Sanjay Gupta', '+919811077889'],
    ['Lakshmi Menon', '+919895066778'], ['Vikram Singh', '+919829044556'], ['Ananya Das', '+919830055667'],
  ].map(([n, p]) => user(n, `${n.split(' ')[0].toLowerCase()}@example.com`, p));
  db.sessions.admin = admin.id;

  const slot = (date, start, len = 15) => {
    const s = { id: nextId('slots'), date, start_time: start, end_time: toHHMM(fromHHMM(start) + len), is_blocked: 0 };
    db.slots.push(s);
    return s;
  };
  const t = today();
  const now = fromHHMM(nowTime());
  // Past week and coming week: mornings and afternoons, Monday to Saturday.
  for (let d = -6; d <= 7; d++) {
    const date = addDays(t, d);
    if (dayOfWeek(date) === 0 || d === 0) continue;
    for (const start of ['10:00', '10:20', '10:40', '11:00', '11:20', '16:00', '16:20', '16:40']) slot(date, start);
  }
  // Today: a few earlier slots, then one starting in ~5 minutes and more after it,
  // so the 10-minute QR pass can be tried right away.
  for (const back of [180, 150, 120]) if (now - back >= 0) slot(t, toHHMM(Math.floor((now - back) / 5) * 5));
  const first = Math.ceil((now + 5) / 5) * 5;
  for (let s = first; s + 15 <= 24 * 60 - 1 && s < first + 15 * 10; s += 15) slot(t, toHHMM(s));

  const purposes = ['Seeking guidance on meditation practice', 'Blessings for a new business', 'Family blessing before a wedding',
    'Guidance on seva and volunteering', 'Personal spiritual guidance', 'Gratitude visit after recovery', 'Questions about the advanced course'];
  let pi = 0;
  const book = (s, u, status, checkedIn = false) => {
    const a = {
      id: nextId('appointments'), slot_id: s.id, user_id: u.id, name: u.name, phone: u.phone, email: u.email,
      purpose: purposes[pi++ % purposes.length], status, admin_note: null,
      checkin_code: status === 'approved' ? code() : null,
      checked_in_at: checkedIn ? new Date(new Date(`${s.date}T${s.start_time}`).getTime() - 4 * 60000).toISOString().replace('T', ' ').slice(0, 19) : null, checked_in_by: checkedIn ? admin.id : null,
      reminded_24h: 1, reminded_1h: 1, reminded_qr: 1, created_at: nowSql(), updated_at: nowSql(),
    };
    db.appointments.push(a);
    return a;
  };
  // History: most past bookings checked in, a few no-shows.
  let ui = 0;
  for (const s of db.slots.filter((x) => x.date < t)) {
    const r = (s.id * 7) % 10;
    if (r < 6) book(s, people[ui++ % people.length], 'approved', r < 5);
  }
  // Today: earlier visitors checked in.
  db.slots.filter((x) => x.date === t && x.start_time < nowTime()).forEach((s, i) => book(s, people[i], 'approved', true));
  // Coming days: confirmed bookings and a few pending requests.
  for (const s of db.slots.filter((x) => x.date > t)) {
    const r = (s.id * 3) % 10;
    if (r < 3) book(s, people[ui++ % people.length], 'approved');
    else if (r === 3) book(s, people[ui++ % people.length], 'pending');
  }
  db.messages.push({ id: nextId('messages'), user_id: people[1].id, sender_id: people[1].id, from_admin: 0, body: 'Namaste, is parking available near the ashram?', read_at: null, created_at: nowSql() });
  save();
}

function load() {
  try { db = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { db = null; }
  if (!db?.users) seed();
}

export function reset() { seed(); emit({ type: 'reset' }); }

// ---- Events (stand-in for Server-Sent Events) ----------------------------------

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(e) { for (const fn of [...listeners]) { try { fn(e); } catch { listeners.delete(fn); } } }
const emitToUser = (userId, event, data) => emit({ type: 'user', userId, event, data });
const emitToAdmins = (kind, data = {}) => emit({ type: 'admin', event: 'changed', data: { kind, ...data } });

function notify(userId, appointmentId, title, body, { email = true, whatsapp = true } = {}) {
  const n = { id: nextId('notifications'), user_id: userId, appointment_id: appointmentId, title, body, read_at: null, created_at: nowSql() };
  db.notifications.push(n);
  const u = db.users.find((x) => x.id === userId);
  if (email) db.outbox.push({ id: nextId('outbox'), channel: 'email', recipient: u.email, subject: title, body, created_at: nowSql() });
  if (whatsapp) db.outbox.push({ id: nextId('outbox'), channel: 'whatsapp', recipient: u.phone, subject: title, body, created_at: nowSql() });
  emitToUser(userId, 'notification', n);
  emit({ type: 'outbox' });
}

// ---- Queries --------------------------------------------------------------------

const ACTIVE = ['pending', 'approved'];
const slotById = (id) => db.slots.find((s) => s.id === id);
const userById = (id) => db.users.find((u) => u.id === id);
const activeFor = (slotId) => db.appointments.find((a) => a.slot_id === slotId && ACTIVE.includes(a.status));
const row = (a) => {
  const s = slotById(a.slot_id);
  return { ...a, date: s.date, start_time: s.start_time, end_time: s.end_time, checked_in_by_name: a.checked_in_by ? userById(a.checked_in_by)?.name : null };
};
const view = (a) => ({
  id: a.id, status: a.status, name: a.name, phone: a.phone, email: a.email, purpose: a.purpose, admin_note: a.admin_note,
  created_at: a.created_at, updated_at: a.updated_at, checked_in_at: a.checked_in_at, checked_in_by: a.checked_in_by_name ?? null,
  slot: { id: a.slot_id, date: a.date, start_time: a.start_time, end_time: a.end_time },
});
const bySlotTime = (x, y) => (x.date + x.start_time).localeCompare(y.date + y.start_time);
const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role };
const passOpts = () => ({ timeZone: TZ, now: new Date(), leadMinutes: CONFIG.qrLeadMinutes, graceMinutes: CONFIG.checkinGraceMinutes });
const isFuture = (s) => minutesUntil(s.date, s.start_time, TZ) > 0;

function text(v, field, max) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s;
}
function email(v) {
  const s = text(v, 'Email', 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, 'Please enter a valid email address');
  return s;
}
function phone(v) {
  const raw = text(v, 'Phone number', 25);
  if (!/^\+?[\d\s()-]+$/.test(raw)) throw new HttpError(400, 'Please enter a valid phone number');
  let digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) { digits = digits.replace(/^0+/, ''); if (digits.length <= 10) digits = '91' + digits; }
  if (digits.length < 8 || digits.length > 15) throw new HttpError(400, 'Please enter a valid phone number');
  return `+${digits}`;
}
function password(v) {
  if (typeof v !== 'string' || v.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  return v;
}

// ---- Routes ---------------------------------------------------------------------

const routes = [];
const on = (method, pattern, fn, auth) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:\w+/g, '(\\d+)')}$`), fn, auth });

on('GET', '/api/config', () => ({ timeZone: TZ, vapidPublicKey: '', qrLeadMinutes: CONFIG.qrLeadMinutes, contact: CONFIG.contact }));
on('GET', '/api/auth/me', ({ user }) => ({ user: publicUser(user) }));
on('POST', '/api/auth/signup', ({ body, frame }) => {
  const e = email(body.email);
  if (db.users.some((u) => u.email === e)) throw new HttpError(409, 'An account with this email already exists. Please log in instead.');
  const u = { id: nextId('users'), name: text(body.name, 'Name', 100), email: e, phone: phone(body.phone), password: password(body.password), role: 'visitor', created_at: nowSql() };
  db.users.push(u);
  db.sessions[frame] = u.id;
  return { user: publicUser(u), status: 201 };
});
on('POST', '/api/auth/login', ({ body, frame }) => {
  const u = db.users.find((x) => x.email === String(body.email ?? '').trim().toLowerCase());
  if (!u || u.password !== body.password) throw new HttpError(401, 'Incorrect email or password');
  db.sessions[frame] = u.id;
  return { user: publicUser(u) };
});
on('POST', '/api/auth/logout', ({ frame }) => { delete db.sessions[frame]; return { ok: true }; });
on('POST', '/api/auth/forgot', ({ body }) => {
  const u = db.users.find((x) => x.email === String(body.email ?? '').trim().toLowerCase());
  if (u) db.outbox.push({ id: nextId('outbox'), channel: 'email', recipient: u.email, subject: 'Reset your password', body: 'A password reset link would be here. (Password reset links are not active in this preview.)', created_at: nowSql() });
  emit({ type: 'outbox' });
  return { ok: true };
});
on('POST', '/api/auth/reset', () => { throw new HttpError(400, 'Password reset links are not active in this preview.'); });
on('PATCH', '/api/auth/me', ({ user, body }) => {
  user.name = text(body.name, 'Name', 100);
  user.phone = phone(body.phone);
  return { user: publicUser(user) };
}, 'user');
on('POST', '/api/auth/change-password', ({ user, body }) => {
  if (body.currentPassword !== user.password) throw new HttpError(400, 'Current password is incorrect');
  user.password = password(body.newPassword);
  return { ok: true };
}, 'user');

on('GET', '/api/slots', () => {
  const t = today();
  const slots = db.slots.filter((s) => s.date >= t && s.date <= addDays(t, 60) && !s.is_blocked && !activeFor(s.id) && isFuture(s))
    .sort(bySlotTime).map(({ id, date, start_time, end_time }) => ({ id, date, start_time, end_time }));
  return { slots };
});

on('POST', '/api/appointments', ({ user, body }) => {
  const name = text(body.name ?? user.name, 'Name', 100);
  const ph = phone(body.phone ?? user.phone);
  const em = email(body.email ?? user.email);
  const purpose = text(body.purpose, 'Purpose of meeting', 2000);
  const t = today();
  const active = db.appointments.filter((a) => a.user_id === user.id && ACTIVE.includes(a.status) && slotById(a.slot_id).date >= t).length;
  if (active >= CONFIG.maxActivePerUser) throw new HttpError(409, `You can have at most ${CONFIG.maxActivePerUser} upcoming appointments at a time.`);
  const s = slotById(Number(body.slotId));
  if (!s || s.is_blocked || !isFuture(s)) throw new HttpError(409, 'This slot is no longer available');
  if (activeFor(s.id)) throw new HttpError(409, 'This slot was just requested by someone else. Please choose another.');
  const a = { id: nextId('appointments'), slot_id: s.id, user_id: user.id, name, phone: ph, email: em, purpose, status: 'pending', admin_note: null, checkin_code: null, checked_in_at: null, checked_in_by: null, reminded_24h: 0, reminded_1h: 0, reminded_qr: 0, created_at: nowSql(), updated_at: nowSql() };
  db.appointments.push(a);
  notify(user.id, a.id, 'Request received', `Your request to meet Gurudev on ${formatSlot(row(a))} is awaiting approval. We'll notify you as soon as it's reviewed.`);
  emitToAdmins('appointment', { id: a.id });
  return { appointment: view(row(a)), status: 201 };
}, 'user');

on('GET', '/api/me', ({ user }) => {
  const appointments = db.appointments.filter((a) => a.user_id === user.id).map(row).sort((x, y) => -bySlotTime(x, y))
    .map((a) => ({ ...view(a), pass: passState(a, passOpts()), past: minutesUntil(a.date, a.end_time, TZ) < -CONFIG.checkinGraceMinutes }));
  const notifications = db.notifications.filter((n) => n.user_id === user.id).sort((x, y) => y.id - x.id).slice(0, 100);
  const unreadMessages = db.messages.filter((m) => m.user_id === user.id && m.from_admin && !m.read_at).length;
  return { appointments, notifications, unread: notifications.filter((n) => !n.read_at).length, unreadMessages };
}, 'user');
on('POST', '/api/me/notifications/read', ({ user }) => {
  db.notifications.filter((n) => n.user_id === user.id && !n.read_at).forEach((n) => { n.read_at = nowSql(); });
  return { ok: true };
}, 'user');
const own = (user, id) => {
  const a = db.appointments.find((x) => x.id === Number(id));
  if (!a || a.user_id !== user.id) throw new HttpError(404, 'Appointment not found');
  return a;
};
on('POST', '/api/me/appointments/:id/cancel', ({ user, params }) => {
  const a = own(user, params[0]);
  if (!ACTIVE.includes(a.status) || a.checked_in_at) throw new HttpError(409, 'This appointment cannot be cancelled');
  a.status = 'cancelled';
  notify(user.id, a.id, 'Appointment cancelled', `You cancelled your appointment on ${formatSlot(row(a))}.`, { whatsapp: false });
  emitToAdmins('appointment', { id: a.id });
  return { appointment: view(row(a)) };
}, 'user');
on('GET', '/api/me/appointments/:id/pass', async ({ user, params }) => {
  const a = row(own(user, params[0]));
  const pass = passState(a, passOpts());
  if (pass.state === 'ready') {
    pass.code = a.checkin_code;
    pass.svg = await QRCode.toString(a.checkin_code, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  }
  return { appointment: view(a), pass };
}, 'user');
on('GET', '/api/me/messages', ({ user }) => {
  db.messages.filter((m) => m.user_id === user.id && m.from_admin && !m.read_at).forEach((m) => { m.read_at = nowSql(); });
  return { messages: db.messages.filter((m) => m.user_id === user.id).map((m) => ({ ...m, sender_name: userById(m.sender_id)?.name })) };
}, 'user');
on('POST', '/api/me/messages', ({ user, body }) => {
  const m = { id: nextId('messages'), user_id: user.id, sender_id: user.id, from_admin: 0, body: text(body.body, 'Message', 2000), read_at: null, created_at: nowSql() };
  db.messages.push(m);
  emitToAdmins('message', { userId: user.id });
  return { message: m, status: 201 };
}, 'user');

// ---- Admin -------------------------------------------------------------------------

on('GET', '/api/admin/summary', () => ({
  pending: db.appointments.filter((a) => a.status === 'pending').length,
  unreadMessages: db.messages.filter((m) => !m.from_admin && !m.read_at).length,
}), 'admin');

on('GET', '/api/admin/stats', ({ query }) => {
  const t = today();
  const from = DATE_RE.test(query.from ?? '') ? query.from : addDays(t, -6);
  let to = DATE_RE.test(query.to ?? '') ? query.to : addDays(t, 13);
  if (to < from) to = from;
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = { date: d, slots: 0, open: 0, pending: 0, booked: 0, checkedIn: 0 };
    for (const s of db.slots.filter((x) => x.date === d)) {
      const a = activeFor(s.id);
      day.slots++;
      if (!a && !s.is_blocked) day.open++;
      if (a?.status === 'pending') day.pending++;
      if (a?.status === 'approved') { day.booked++; if (a.checked_in_at) day.checkedIn++; }
    }
    days.push(day);
  }
  const tr = days.find((d) => d.date === t) ?? { booked: 0, checkedIn: 0, pending: 0, open: 0 };
  const todayList = db.appointments.filter((a) => a.status === 'approved' && slotById(a.slot_id).date === t).map(row).sort(bySlotTime).map(view);
  return { today: t, now: nowTime(), summary: { booked: tr.booked, checkedIn: tr.checkedIn, pending: tr.pending, awaiting: tr.booked - tr.checkedIn, open: tr.open }, days, todayList };
}, 'admin');

on('GET', '/api/admin/appointments', ({ query }) => {
  const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(query.status) ? query.status : null;
  const rows = db.appointments.filter((a) => !status || a.status === status).map(row)
    .sort((x, y) => (x.status === 'pending' ? 0 : 1) - (y.status === 'pending' ? 0 : 1) || bySlotTime(x, y));
  const counts = {};
  for (const a of db.appointments) counts[a.status] = (counts[a.status] ?? 0) + 1;
  return { appointments: rows.map(view), counts };
}, 'admin');

for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected'], ['cancel', 'cancelled']]) {
  on('POST', `/api/admin/appointments/:id/${action}`, ({ params, body }) => {
    const a = db.appointments.find((x) => x.id === Number(params[0]));
    if (!a) throw new HttpError(404, 'Appointment not found');
    const allowed = status === 'cancelled' ? ACTIVE : ['pending'];
    if (!allowed.includes(a.status)) throw new HttpError(409, `Appointment is already ${a.status}`);
    if (a.checked_in_at) throw new HttpError(409, 'This visitor has already checked in');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) || null : null;
    const r = row(a);
    const mins = minutesUntil(r.date, r.start_time, TZ);
    a.status = status;
    a.admin_note = note;
    a.updated_at = nowSql();
    if (status === 'approved') {
      a.checkin_code ??= code();
      if (mins <= 24 * 60) a.reminded_24h = 1;
      if (mins <= 60) a.reminded_1h = 1;
      if (mins <= CONFIG.qrLeadMinutes) a.reminded_qr = 1;
    }
    const when = formatSlot(r);
    const suffix = note ? `\nNote: ${note}` : '';
    const messages = {
      approved: ['Appointment confirmed 🙏', `Your meeting with Gurudev is confirmed for ${when}. Your entry QR code will appear in the app ${CONFIG.qrLeadMinutes} minutes before your meeting — please show it at the entrance.${suffix}`],
      rejected: ['Appointment request declined', `We're sorry, your request for ${when} could not be accommodated.${suffix}`],
      cancelled: ['Appointment cancelled', `Your appointment on ${when} has been cancelled by the ashram.${suffix}`],
    };
    notify(a.user_id, a.id, ...messages[status]);
    emitToAdmins('appointment', { id: a.id });
    return { appointment: view(row(a)) };
  }, 'admin');
}

function eligibility(a) {
  if (a.status !== 'approved') return { canAdmit: false, reason: `This appointment is ${a.status}.` };
  if (a.checked_in_at) return { canAdmit: false, reason: 'Already checked in.' };
  if (a.date !== today()) return { canAdmit: true, needsOverride: true, reason: `This pass is for ${formatSlot(a)}, not today.` };
  if (minutesUntil(a.date, a.start_time, TZ) > CONFIG.checkinEarlyMinutes) return { canAdmit: true, needsOverride: true, reason: `Early: the meeting starts at ${a.start_time}.` };
  if (minutesUntil(a.date, a.end_time, TZ) < -CONFIG.checkinGraceMinutes) return { canAdmit: true, needsOverride: true, reason: `Late: the slot ended at ${a.end_time}.` };
  return { canAdmit: true, needsOverride: false };
}
function findForCheckin(body) {
  const a = body.code
    ? db.appointments.find((x) => x.checkin_code === String(body.code).trim())
    : db.appointments.find((x) => x.id === Number(body.appointmentId));
  if (!a) throw new HttpError(404, body.code ? 'This QR code is not a valid entry pass.' : 'Appointment not found');
  return a;
}
on('POST', '/api/admin/checkin/lookup', ({ body }) => {
  const a = findForCheckin(body);
  return { appointment: view(row(a)), ...eligibility(row(a)) };
}, 'admin');
on('POST', '/api/admin/checkin', ({ body, user }) => {
  const a = findForCheckin(body);
  const check = eligibility(row(a));
  if (!check.canAdmit || (check.needsOverride && !body.override)) throw new HttpError(409, check.reason);
  a.checked_in_at = nowSql();
  a.checked_in_by = user.id;
  notify(a.user_id, a.id, 'Welcome 🙏', "You're checked in. Please take a seat; you'll be called shortly.", { email: false, whatsapp: false });
  emitToAdmins('checkin', { id: a.id });
  return { appointment: view(row(a)) };
}, 'admin');

on('GET', '/api/admin/slots', () => {
  const t = today();
  return {
    slots: db.slots.filter((s) => s.date >= t).sort(bySlotTime).map((s) => {
      const a = activeFor(s.id);
      return { ...s, appointment_id: a?.id ?? null, appointment_status: a?.status ?? null, visitor_name: a?.name ?? null, checked_in_at: a?.checked_in_at ?? null };
    }),
  };
}, 'admin');
on('POST', '/api/admin/slots', ({ body }) => {
  const { fromDate, toDate = fromDate, startTime, endTime } = body;
  const duration = Number(body.duration ?? 15);
  const gap = Number(body.gap ?? 0);
  const weekdays = Array.isArray(body.weekdays) ? body.weekdays.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  if (!DATE_RE.test(fromDate ?? '') || !DATE_RE.test(toDate ?? '')) throw new HttpError(400, 'Valid dates are required');
  if (!TIME_RE.test(startTime ?? '') || !TIME_RE.test(endTime ?? '')) throw new HttpError(400, 'Valid start and end times are required');
  if (toDate < fromDate) throw new HttpError(400, 'End date must not be before start date');
  if (addDays(fromDate, 366) < toDate) throw new HttpError(400, 'Date range can be at most one year');
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) throw new HttpError(400, 'Duration must be 5–480 minutes');
  if (!Number.isInteger(gap) || gap < 0 || gap > 240) throw new HttpError(400, 'Gap must be 0–240 minutes');
  const start = fromHHMM(startTime);
  const end = fromHHMM(endTime);
  if (end - start < duration) throw new HttpError(400, 'End time must leave room for at least one slot');
  let created = 0;
  let skipped = 0;
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    if (!weekdays.includes(dayOfWeek(d))) continue;
    for (let t = start; t + duration <= end; t += duration + gap) {
      if (db.slots.some((s) => s.date === d && s.start_time === toHHMM(t))) { skipped++; continue; }
      db.slots.push({ id: nextId('slots'), date: d, start_time: toHHMM(t), end_time: toHHMM(t + duration), is_blocked: 0 });
      created++;
    }
  }
  emitToAdmins('slots');
  return { created, skipped, status: 201 };
}, 'admin');
on('PATCH', '/api/admin/slots/:id', ({ params, body }) => {
  const s = slotById(Number(params[0]));
  if (!s) throw new HttpError(404, 'Slot not found');
  s.is_blocked = body.blocked ? 1 : 0;
  emitToAdmins('slots');
  return { slot: s };
}, 'admin');
on('DELETE', '/api/admin/slots/:id', ({ params }) => {
  const id = Number(params[0]);
  if (!slotById(id)) throw new HttpError(404, 'Slot not found');
  if (db.appointments.some((a) => a.slot_id === id)) throw new HttpError(409, 'This slot has appointment history. Block it instead of deleting it.');
  db.slots = db.slots.filter((s) => s.id !== id);
  emitToAdmins('slots');
  return { ok: true };
}, 'admin');

on('GET', '/api/admin/threads', () => {
  const byUser = new Map();
  for (const m of db.messages) byUser.set(m.user_id, m);
  const threads = [...byUser.values()].sort((x, y) => y.id - x.id).map((m) => {
    const u = userById(m.user_id);
    return { user_id: u.id, name: u.name, phone: u.phone, email: u.email, last_body: m.body, last_from_admin: m.from_admin, last_at: m.created_at,
      unread: db.messages.filter((x) => x.user_id === u.id && !x.from_admin && !x.read_at).length };
  });
  return { threads };
}, 'admin');
on('GET', '/api/admin/threads/:id', ({ params }) => {
  const u = userById(Number(params[0]));
  if (!u) throw new HttpError(404, 'User not found');
  db.messages.filter((m) => m.user_id === u.id && !m.from_admin && !m.read_at).forEach((m) => { m.read_at = nowSql(); });
  return {
    user: publicUser(u),
    messages: db.messages.filter((m) => m.user_id === u.id).map((m) => ({ ...m, sender_name: userById(m.sender_id)?.name })),
    appointments: db.appointments.filter((a) => a.user_id === u.id).map(row).sort((x, y) => -bySlotTime(x, y)).slice(0, 10).map(view),
  };
}, 'admin');
on('POST', '/api/admin/threads/:id', ({ params, body, user }) => {
  const u = userById(Number(params[0]));
  if (!u) throw new HttpError(404, 'User not found');
  const m = { id: nextId('messages'), user_id: u.id, sender_id: user.id, from_admin: 1, body: text(body.body, 'Message', 2000), read_at: null, created_at: nowSql() };
  db.messages.push(m);
  notify(u.id, null, 'New message from the ashram', m.body, { whatsapp: false });
  emitToUser(u.id, 'message', {});
  emitToAdmins('message', { userId: u.id });
  return { message: m, status: 201 };
}, 'admin');

on('GET', '/api/admin/admins', () => ({ admins: db.users.filter((u) => u.role === 'admin').map(publicUser) }), 'admin');
on('POST', '/api/admin/admins', ({ body }) => {
  const e = email(body.email);
  const existing = db.users.find((u) => u.email === e);
  if (existing) { existing.role = 'admin'; return { admin: publicUser(existing), promoted: true }; }
  const u = { id: nextId('users'), name: text(body.name, 'Name', 100), email: e, phone: phone(body.phone), password: password(body.password), role: 'admin', created_at: nowSql() };
  db.users.push(u);
  return { admin: publicUser(u), promoted: false, status: 201 };
}, 'admin');
on('DELETE', '/api/admin/admins/:id', ({ params, user }) => {
  const id = Number(params[0]);
  if (id === user.id) throw new HttpError(400, "You can't remove your own admin access");
  const u = userById(id);
  if (!u || u.role !== 'admin') throw new HttpError(404, 'Admin not found');
  u.role = 'visitor';
  return { ok: true };
}, 'admin');

// ---- Entry point used by each app frame ----------------------------------------------

export async function handle(frame, method, url, body) {
  const u = new URL(url, 'http://preview');
  const route = routes.find((r) => r.method === method && r.re.test(u.pathname));
  if (!route) return { status: 404, body: { error: 'Not found' } };
  const user = userById(db.sessions[frame]) ?? null;
  try {
    if (route.auth && !user) throw new HttpError(401, 'Please log in to continue');
    if (route.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admins only');
    const result = await route.fn({ frame, user, body: body ?? {}, query: Object.fromEntries(u.searchParams), params: u.pathname.match(route.re).slice(1) });
    save();
    const { status = 200, ...rest } = result;
    return { status, body: rest };
  } catch (err) {
    save();
    if (!err.status) console.error(err);
    return { status: err.status ?? 500, body: { error: err.status ? err.message : 'Something went wrong' } };
  }
}

export const currentUser = (frame) => publicUser(userById(db.sessions[frame]));
export const outbox = () => [...db.outbox].reverse();

// Passes a visitor could show right now (used by the preview's scan helper).
export const readyPasses = () => db.appointments.map(row)
  .filter((a) => passState(a, passOpts()).state === 'ready' || (a.status === 'approved' && !a.checked_in_at && a.date === today()))
  .sort(bySlotTime).map((a) => ({ name: a.name, time: a.start_time, code: a.checkin_code }));

// Reminders and "entry pass ready", like src/jobs.js.
export function runReminders() {
  let sent = 0;
  for (const a of db.appointments.filter((x) => x.status === 'approved' && !x.checked_in_at)) {
    const r = row(a);
    const mins = minutesUntil(r.date, r.start_time, TZ);
    if (mins <= -15) continue;
    if (mins <= CONFIG.qrLeadMinutes && !a.reminded_qr) {
      a.reminded_qr = a.reminded_1h = a.reminded_24h = 1;
      notify(a.user_id, a.id, 'Your entry pass is ready 🎟️', `Your meeting with Gurudev starts at ${r.start_time}. Open the app and show your QR code at the entrance.`);
      sent++;
    } else if (mins > CONFIG.qrLeadMinutes && mins <= 60 && !a.reminded_1h) {
      a.reminded_1h = a.reminded_24h = 1;
      notify(a.user_id, a.id, 'Your meeting is in 1 hour', `Reminder: your meeting with Gurudev starts at ${r.start_time} today. Your entry QR code will appear in the app ${CONFIG.qrLeadMinutes} minutes before.`);
      sent++;
    } else if (mins > 60 && mins <= 24 * 60 && !a.reminded_24h) {
      a.reminded_24h = 1;
      notify(a.user_id, a.id, 'Upcoming meeting reminder', `Reminder: your meeting with Gurudev is on ${formatSlot(r)}.`);
      sent++;
    }
  }
  if (sent) save();
}

load();
