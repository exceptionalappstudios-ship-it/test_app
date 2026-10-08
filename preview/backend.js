// In-browser stand-in for the server, used only by the interactive preview.
// It mirrors the API in src/routes/*.js (reusing the same pass and scan rules),
// keeps its data in the viewer's own browser, and records the WhatsApp
// messages the real server would send. A preview clock can be moved forward
// to see reminders, the greeting and the QR pass arrive.
import QRCode from 'qrcode';
import { nowInTimezone, minutesUntil, addDays, dayOfWeek, formatVisit, formatClock, formatDay, parsePeriodTimes, PERIODS, PERIOD_LABELS, DATE_RE } from '../src/time.js';
import { PURPOSES, passState, scanResult } from '../src/appointments.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
const STORE_KEY = 'meet-gurudev-preview-v2';
const periods = parsePeriodTimes();
const CONFIG = { reminderTime: '18:00', greetingTime: '07:00' };
const CONTACT = { phone: '+91 80 1234 5678', whatsapp: '+918012345678', address: 'Main Ashram Office, Bengaluru' };

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

let db;
const listeners = new Set();
const now = () => new Date(Date.now() + (db?.offsetMs ?? 0));
const today = () => nowInTimezone(TZ, now()).date;
const clock = () => nowInTimezone(TZ, now()).time;
const sqlNow = () => now().toISOString().replace('T', ' ').slice(0, 19);
const sqlAt = (date, time) => new Date(`${date}T${time}`).toISOString().replace('T', ' ').slice(0, 19);
const opts = () => ({ timeZone: TZ, periods, now: now() });
const code = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b % 64]).join('');
const nextId = (t) => { db.seq[t] = (db.seq[t] ?? 0) + 1; return db.seq[t]; };
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch { /* the preview still works without storage */ } }

// Sample people get an initials avatar instead of a photo.
function avatar(name, hue) {
  const initials = name.split(' ').map((w) => w[0]).slice(0, 2).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,52%)"/><stop offset="1" stop-color="hsl(${hue + 30},60%,36%)"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><text x="50" y="62" font-family="system-ui,sans-serif" font-size="36" font-weight="700" fill="#fff" text-anchor="middle">${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// ---- Seed data ------------------------------------------------------------------

function seed() {
  db = { seq: {}, users: [], sessions: [], appointments: [], notifications: [], outbox: [], broadcasts: [], auth: {}, otps: {}, offsetMs: 0 };
  const user = (name, phone, role = 'visitor', status = 'active', hue = 210) => {
    const u = { id: nextId('users'), name, phone, photo: avatar(name, hue), role, status, created_at: sqlNow(), reviewed_by: null };
    db.users.push(u);
    return u;
  };
  const admin = user('Seva Admin', '+919000000001', 'admin', 'active', 220);
  const ramesh = user('Ramesh Kumar', '+919811100001', 'security', 'active', 150);
  const suresh = user('Suresh Patil', '+919811100002', 'security', 'active', 30);
  user('Vikram Singh', '+919811100003', 'security', 'pending', 280);
  ramesh.reviewed_by = suresh.reviewed_by = admin.id;
  db.auth.admin = admin.id;
  db.auth.security = ramesh.id;
  const names = ['Meera Iyer', 'Rahul Sharma', 'Priya Nair', 'Arjun Reddy', 'Kavita Joshi', 'Sanjay Gupta', 'Lakshmi Menon', 'Anil Verma',
    'Deepa Pillai', 'Rohit Mehta', 'Sunita Rao', 'Karan Malhotra', 'Neha Kulkarni', 'Vivek Bhat', 'Pooja Shah', 'Manoj Das'];
  const people = names.map((n, i) => user(n, `+9198450${String(10000 + i * 137).slice(-5)}`, 'visitor', 'active', (i * 47) % 360));

  const t = today();
  for (let d = -6; d <= 7; d++) {
    const date = addDays(t, d);
    for (const p of PERIODS) db.sessions.push({ id: nextId('sessions'), date, period: p, capacity: 40, is_closed: 0 });
  }
  const refs = ['Swami Ji, Bengaluru centre', 'Art of Living, Pune', 'Family friend', 'Satsang group, Delhi', 'Teacher: Anita Rao'];
  const purposeSets = [['blessings'], ['life_event', 'blessings'], ['invitation'], ['project'], ['donation'], ['blessings', 'other']];
  const descs = ['Blessings for the family', "Daughter's wedding next month", 'Invite Gurudev to our school function', 'Rural water project proposal', 'Annual donation', 'Gratitude after recovery'];
  let n = 0;
  const book = (session, u, status, checkedInBy = null) => {
    const size = 1 + (n % 4);
    const a = {
      id: nextId('appointments'), user_id: u.id, session_id: session.id, date: session.date, period: session.period,
      name: u.name, phone: u.phone, photo: u.photo, reference: refs[n % refs.length], people_count: size,
      people: Array.from({ length: size - 1 }, (_, i) => ({ name: `${['Anu', 'Ravi', 'Sita', 'Gopal'][i]} ${u.name.split(' ')[1]}`, phone: `+9199000${String(n * 10 + i).padStart(5, '0')}` })),
      purposes: purposeSets[n % purposeSets.length], description: descs[n % descs.length],
      status, admin_note: null, reviewed_by: status === 'pending' ? null : admin.id,
      checkin_code: status === 'approved' ? code() : null,
      checked_in_at: checkedInBy ? sqlAt(session.date, addMinutes(periods[session.period].start, 10 + (n % 50))) : null,
      checked_in_by: checkedInBy?.id ?? null,
      reminded_day_before: 1, greeted: 1, pass_sent_at: status === 'approved' && session.date <= t ? sqlNow() : null,
      created_at: sqlNow(), updated_at: sqlNow(),
    };
    n++;
    db.appointments.push(a);
    return a;
  };
  let ui = 0;
  const next = () => people[ui++ % people.length];
  for (const s of db.sessions) {
    const started = s.date < t || (s.date === t && minutesUntil(s.date, periods[s.period].start, TZ, now()) <= 0);
    const count = s.date < t ? 2 + (s.id % 3) : s.date === t ? 3 : s.id % 3 === 0 ? 1 : 0;
    for (let i = 0; i < count; i++) {
      const guard = (s.id + i) % 2 ? ramesh : suresh;
      if (s.date < t) book(s, next(), 'approved', (s.id + i) % 7 ? guard : null);
      else if (s.date === t) book(s, next(), 'approved', started && i < 2 ? guard : null);
      else book(s, next(), 'approved');
    }
  }
  // Requests waiting for review.
  const future = db.sessions.filter((s) => s.date > t);
  book(future[1], people[3], 'pending');
  book(future[4], people[7], 'pending');
  book(future[7], people[11], 'pending');
  book(future[9], people[14], 'hold');
  // Each sample person keeps at most one upcoming appointment.
  const seen = new Set();
  db.appointments = db.appointments.filter((a) => {
    if (a.date < t || a.checked_in_at) return true;
    if (seen.has(a.user_id)) return false;
    seen.add(a.user_id);
    return true;
  });
  save();
}

function addMinutes(hhmm, m) { const [h, mm] = hhmm.split(':').map(Number); const t = Math.min(h * 60 + mm + m, 23 * 60 + 59); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }

function load() {
  try { db = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { db = null; }
  if (!db?.users) seed();
}

export function reset() { seed(); emit({ type: 'reset' }); }

// ---- Events ----------------------------------------------------------------------

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(e) { for (const fn of [...listeners]) { try { fn(e); } catch { listeners.delete(fn); } } }
const emitToUser = (userId, event, data = {}) => emit({ type: 'user', userId, event, data });
const emitToStaff = (kind) => emit({ type: 'staff', event: 'changed', data: { kind } });

function whatsapp(kind, phone, preview) {
  db.outbox.push({ id: nextId('outbox'), kind, recipient: phone, preview, status: 'logged', error: null, created_at: sqlNow(), sent_at: null });
  emit({ type: 'outbox' });
}
function notify(userId, apptId, title, body, { phone, kind = 'update' } = {}) {
  const n = { id: nextId('notifications'), user_id: userId, appointment_id: apptId, title, body, read_at: null, created_at: sqlNow() };
  db.notifications.push(n);
  emitToUser(userId, 'notification', n);
  if (phone !== false) whatsapp(kind, phone ?? userById(userId).phone, `${title}\n${body}`);
}

// ---- Views ------------------------------------------------------------------------

const ACTIVE = ['pending', 'hold', 'approved'];
const userById = (id) => db.users.find((u) => u.id === id);
const isComplete = (u) => Boolean(u?.name && u?.photo);
const publicUser = (u) => u && { id: u.id, name: u.name, phone: u.phone, role: u.role, status: u.status, photo: u.photo, profileComplete: isComplete(u) };
const periodOrder = (p) => PERIODS.indexOf(p);
const bySession = (a, b) => a.date.localeCompare(b.date) || periodOrder(a.period) - periodOrder(b.period);
const view = (a) => ({
  id: a.id, status: a.status, name: a.name, phone: a.phone, photo: a.photo, reference: a.reference,
  peopleCount: a.people_count, people: a.people.map(({ name, phone }) => ({ name, phone })),
  purposes: a.purposes.map((p) => PURPOSES[p] ?? p), description: a.description,
  date: a.date, period: a.period, periodLabel: PERIOD_LABELS[a.period], adminNote: a.admin_note,
  reviewedBy: a.reviewed_by ? userById(a.reviewed_by)?.name : null,
  checkedInAt: a.checked_in_at, checkedInBy: a.checked_in_by ? userById(a.checked_in_by)?.name : null,
  passSent: Boolean(a.pass_sent_at), createdAt: a.created_at,
});
const used = (sessionId) => db.appointments.filter((a) => a.session_id === sessionId && ACTIVE.includes(a.status)).reduce((s, a) => s + a.people_count, 0);
const stillOpen = (s) => s.date > today() || minutesUntil(s.date, periods[s.period].end, TZ, now()) > 0;

function text(v, field, max, { required = true } = {}) {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s && required) throw new HttpError(400, `Please enter ${field}`);
  if (s.length > max) throw new HttpError(400, `Too long: ${field}`);
  return s;
}
function normalizePhone(v) {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw || !/^\+?[\d\s()-]+$/.test(raw)) return null;
  let d = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) { d = d.replace(/^0+/, ''); if (d.length <= 10) d = `91${d}`; }
  return d.length < 10 || d.length > 15 ? null : `+${d}`;
}
const phone = (v, field = 'a valid WhatsApp number') => { const p = normalizePhone(v); if (!p) throw new HttpError(400, `Please enter ${field}`); return p; };

function conflictsFor(phones, self) {
  const out = [];
  for (const a of db.appointments) {
    if (!ACTIVE.includes(a.status) || a.date < today()) continue;
    const all = [{ name: a.name, phone: a.phone, booker: true }, { name: a.name, phone: userById(a.user_id).phone, booker: true }, ...a.people.map((p) => ({ ...p, booker: false }))];
    for (const p of all) {
      if (!phones.includes(p.phone) || out.some((c) => c.phone === p.phone)) continue;
      const inGroup = p.booker ? '' : ` in ${a.name}'s group`;
      out.push({
        phone: p.phone, name: p.name, visit: formatVisit(a),
        message: p.phone === self
          ? `You already have an appointment${inGroup} on ${formatVisit(a)}. Each person can have only one appointment. Ask ${p.booker ? 'the ashram' : a.name} to remove you, or cancel it first.`
          : `${p.name} (${p.phone}) already has an appointment${inGroup} on ${formatVisit(a)}. Each person can have only one appointment. Cancel that one or remove this person.`,
      });
    }
  }
  return out;
}

// ---- Routes --------------------------------------------------------------------------

const routes = [];
const on = (method, pattern, fn, auth) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:\w+/g, '(\\d+)')}$`), fn, auth });

on('GET', '/api/config', () => ({
  timeZone: TZ, vapidPublicKey: '', purposes: PURPOSES, maxPeople: 10, contact: CONTACT,
  periods: Object.fromEntries(PERIODS.map((p) => [p, { label: periods[p].label, opensAt: formatClock(periods[p].start) }])),
}));

on('POST', '/api/auth/otp/request', ({ body }) => {
  const p = phone(body.phone);
  const c = String(Math.floor(100000 + Math.random() * 900000));
  db.otps[p] = c;
  whatsapp('otp', p, `Login code: ${c}`);
  return { phone: p, isNew: !db.users.some((u) => u.phone === p), testCode: c };
});
on('POST', '/api/auth/otp/verify', ({ body, frame }) => {
  const p = phone(body.phone);
  if (!db.otps[p] || db.otps[p] !== String(body.code ?? '').replace(/\D/g, '')) throw new HttpError(400, 'That code is not right. Please check the WhatsApp message and try again.');
  delete db.otps[p];
  let u = db.users.find((x) => x.phone === p);
  if (!u) {
    const security = body.signupAs === 'security';
    u = { id: nextId('users'), phone: p, name: null, photo: null, role: security ? 'security' : 'visitor', status: security ? 'pending' : 'active', created_at: sqlNow(), reviewed_by: null };
    db.users.push(u);
  }
  db.auth[frame] = u.id;
  return { user: publicUser(u) };
});
on('POST', '/api/auth/logout', ({ frame }) => { delete db.auth[frame]; return { ok: true }; });
on('GET', '/api/auth/me', ({ user }) => ({ user: publicUser(user) }));
on('PATCH', '/api/auth/me', ({ user, body }) => {
  const name = text(body.name, 'your full name', 80);
  if (name.length < 2) throw new HttpError(400, 'Please enter your full name');
  user.name = name;
  if (user.role === 'security') emitToStaff('security');
  return { user: publicUser(user) };
}, 'user');
on('POST', '/api/auth/me/photo', ({ user, body }) => {
  if (typeof body !== 'string' || !body.startsWith('data:image/jpeg')) throw new HttpError(400, 'Please upload a JPEG photo');
  user.photo = body;
  if (user.role === 'security') emitToStaff('security');
  return { user: publicUser(user) };
}, 'user');

on('GET', '/api/availability', () => {
  const byDate = new Map();
  for (const s of db.sessions.filter((x) => x.date >= today() && !x.is_closed && stillOpen(x))) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push({ id: s.id, period: s.period, label: periods[s.period].label, remaining: Math.max(0, s.capacity - used(s.id)) });
  }
  return { days: [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, sessions]) => ({ date, sessions: sessions.sort((a, b) => periodOrder(a.period) - periodOrder(b.period)) })) };
});

on('POST', '/api/appointments/check', ({ body, user }) => {
  const phones = [...new Set((body.phones ?? []).map(normalizePhone).filter(Boolean))];
  return { conflicts: conflictsFor(phones, user.phone) };
}, 'profile');

on('POST', '/api/appointments', ({ body, user }) => {
  const reference = text(body.reference, 'who referred you (reference)', 120);
  const purposes = [...new Set(Array.isArray(body.purposes) ? body.purposes : [])].filter((p) => p in PURPOSES);
  if (!purposes.length) throw new HttpError(400, 'Please choose the purpose of your meeting');
  const description = text(body.description, 'a few words about your visit', 500, { required: purposes.includes('other') });
  const passPhone = phone(body.phone ?? user.phone, 'the WhatsApp number for your pass');
  const count = Number(body.peopleCount);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new HttpError(400, 'Please choose between 1 and 10 people');
  const extra = Array.isArray(body.people) ? body.people : [];
  if (extra.length !== count - 1) throw new HttpError(400, 'Please add everyone who is coming');
  const people = extra.map((p, i) => ({ name: text(p?.name, `the name of person ${i + 2}`, 80), phone: phone(p?.phone, `a valid phone number for person ${i + 2}`) }));
  const mine = db.appointments.find((a) => a.user_id === user.id && ACTIVE.includes(a.status) && a.date >= today());
  if (mine) throw new HttpError(409, `You already have an appointment on ${formatVisit(mine)}. You can book a new one after cancelling it.`);
  const conflicts = conflictsFor([...new Set([passPhone, user.phone, ...people.map((p) => p.phone)])], user.phone);
  if (conflicts.length) throw new HttpError(409, conflicts[0].message, { conflicts });
  const s = db.sessions.find((x) => x.id === Number(body.sessionId));
  if (!s || s.is_closed || !stillOpen(s)) throw new HttpError(409, 'This session is no longer available. Please choose another.');
  const left = s.capacity - used(s.id);
  if (count > left) throw new HttpError(409, left > 0 ? `Only ${left} places are left in this session.` : 'This session is full. Please choose another.');
  const a = {
    id: nextId('appointments'), user_id: user.id, session_id: s.id, date: s.date, period: s.period, name: user.name, phone: passPhone, photo: user.photo,
    reference, people_count: count, people, purposes, description: description || null, status: 'pending', admin_note: null, reviewed_by: null,
    checkin_code: null, checked_in_at: null, checked_in_by: null, reminded_day_before: 0, greeted: 0, pass_sent_at: null, created_at: sqlNow(), updated_at: sqlNow(),
  };
  db.appointments.push(a);
  notify(user.id, a.id, 'Request received 🙏', `We have received your request to meet Gurudev on ${formatVisit(a)} for ${count} ${count === 1 ? 'person' : 'people'}. We will send you a confirmation after it is reviewed.`, { phone: passPhone });
  emitToStaff('appointment');
  return { appointment: view(a), status: 201 };
}, 'profile');

on('GET', '/api/me', ({ user }) => {
  const mine = db.appointments.filter((a) => a.user_id === user.id).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 20);
  const notifications = db.notifications.filter((x) => x.user_id === user.id).sort((a, b) => b.id - a.id).slice(0, 50);
  return {
    appointments: mine.map((a) => ({ ...view(a), pass: passState(a, opts()), upcoming: ACTIVE.includes(a.status) && a.date >= today() })),
    notifications, unread: notifications.filter((x) => !x.read_at).length,
  };
}, 'user');
on('POST', '/api/me/notifications/read', ({ user }) => { db.notifications.filter((x) => x.user_id === user.id && !x.read_at).forEach((x) => { x.read_at = sqlNow(); }); return { ok: true }; }, 'user');
const own = (user, id) => { const a = db.appointments.find((x) => x.id === Number(id)); if (!a || a.user_id !== user.id) throw new HttpError(404, 'Appointment not found'); return a; };
on('POST', '/api/me/appointments/:id/cancel', ({ user, params }) => {
  const a = own(user, params[0]);
  if (!ACTIVE.includes(a.status) || a.checked_in_at) throw new HttpError(409, 'This appointment cannot be cancelled');
  a.status = 'cancelled';
  notify(user.id, a.id, 'Appointment cancelled', `Your appointment on ${formatVisit(a)} has been cancelled.`, { phone: false });
  emitToStaff('appointment');
  return { appointment: view(a) };
}, 'user');
on('GET', '/api/me/appointments/:id/pass', async ({ user, params }) => {
  const a = own(user, params[0]);
  const pass = passState(a, opts());
  if (pass.state === 'ready') { pass.code = a.checkin_code; pass.svg = await QRCode.toString(a.checkin_code, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }); }
  return { appointment: view(a), pass };
}, 'user');

// ---- Scanner -----------------------------------------------------------------------

const findPass = (body) => {
  const a = body.code ? db.appointments.find((x) => x.checkin_code === String(body.code).trim()) : db.appointments.find((x) => x.id === Number(body.appointmentId));
  if (!a) throw new HttpError(404, 'This QR code is not a valid entry pass. Do not allow entry.');
  return a;
};
on('POST', '/api/staff/scan', ({ body, user }) => {
  const a = findPass(body);
  const r = scanResult(a, opts());
  if (r.adminOverride && user.role !== 'admin') delete r.adminOverride;
  return { ...r, appointment: view(a) };
}, 'staff');
on('POST', '/api/staff/admit', ({ body, user }) => {
  const a = findPass(body);
  const r = scanResult(a, opts());
  if (!r.canAdmit && !(user.role === 'admin' && r.adminOverride && body.override)) throw new HttpError(409, r.message, { result: r.result });
  a.checked_in_at = sqlNow();
  a.checked_in_by = user.id;
  notify(a.user_id, a.id, 'Welcome 🙏', `You are checked in for ${formatVisit(a)}. Please take a seat.`, { phone: false });
  emitToStaff('checkin');
  return { appointment: view(a) };
}, 'staff');
on('GET', '/api/staff/recent', ({ user }) => {
  const rows = db.appointments.filter((a) => a.checked_in_by === user.id && a.date === today()).sort((a, b) => b.checked_in_at.localeCompare(a.checked_in_at));
  return { checkins: rows.map(view), people: rows.reduce((s, a) => s + a.people_count, 0) };
}, 'staff');

// ---- Admin ---------------------------------------------------------------------------

on('GET', '/api/admin/dashboard', ({ query }) => {
  const t = today();
  const date = DATE_RE.test(query.date ?? '') ? query.date : t;
  const sessions = PERIODS.map((p) => db.sessions.find((s) => s.date === date && s.period === p)).filter(Boolean).map((s) => {
    const appts = db.appointments.filter((a) => a.session_id === s.id && a.status === 'approved');
    const inn = appts.filter((a) => a.checked_in_at);
    return { period: s.period, label: periods[s.period].label, capacity: s.capacity, bookings: appts.length, people: appts.reduce((n, a) => n + a.people_count, 0), checkedInBookings: inn.length, checkedInPeople: inn.reduce((n, a) => n + a.people_count, 0) };
  });
  const sum = (k) => sessions.reduce((n, s) => n + s[k], 0);
  const days = [];
  for (let d = addDays(date, -6); d <= addDays(date, 7); d = addDays(d, 1)) {
    const appts = db.appointments.filter((a) => a.date === d && a.status === 'approved');
    days.push({ date: d, people: appts.reduce((n, a) => n + a.people_count, 0), checkedIn: appts.filter((a) => a.checked_in_at).reduce((n, a) => n + a.people_count, 0) });
  }
  return {
    date, today: t,
    summary: {
      bookings: sum('bookings'), people: sum('people'), checkedInBookings: sum('checkedInBookings'), checkedInPeople: sum('checkedInPeople'),
      remainingPeople: sum('people') - sum('checkedInPeople'), capacity: sum('capacity'),
      pending: db.appointments.filter((a) => a.status === 'pending' && a.date >= t).length,
      hold: db.appointments.filter((a) => a.status === 'hold' && a.date >= t).length,
      securityPending: db.users.filter((u) => u.role === 'security' && u.status === 'pending' && isComplete(u)).length,
      securityActive: db.users.filter((u) => u.role === 'security' && u.status === 'active').length,
    },
    sessions,
    recent: db.appointments.filter((a) => a.date === date && a.checked_in_at).sort((a, b) => b.checked_in_at.localeCompare(a.checked_in_at)).slice(0, 12).map(view),
    days,
  };
}, 'admin');

on('GET', '/api/admin/appointments', ({ query }) => {
  const date = DATE_RE.test(query.date ?? '') ? query.date : null;
  const q = String(query.q ?? '').trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  let rows = db.appointments.filter((a) => (date ? a.date === date : a.date >= today()));
  if (query.status) rows = rows.filter((a) => a.status === query.status);
  if (query.checked === 'in') rows = rows.filter((a) => a.status === 'approved' && a.checked_in_at);
  if (query.checked === 'out') rows = rows.filter((a) => a.status === 'approved' && !a.checked_in_at);
  if (q) rows = rows.filter((a) => a.name.toLowerCase().includes(q) || a.reference.toLowerCase().includes(q) || a.people.some((p) => p.name.toLowerCase().includes(q))
    || (digits.length >= 3 && [a.phone, ...a.people.map((p) => p.phone)].some((p) => p.includes(digits))));
  rows.sort((a, b) => bySession(a, b) || Number(Boolean(a.checked_in_at)) - Number(Boolean(b.checked_in_at)) || a.id - b.id);
  let stats = null;
  if (date) {
    const day = db.appointments.filter((a) => a.date === date);
    const ok = day.filter((a) => a.status === 'approved');
    const inn = ok.filter((a) => a.checked_in_at);
    const people = ok.reduce((n, a) => n + a.people_count, 0);
    const inPeople = inn.reduce((n, a) => n + a.people_count, 0);
    stats = { approved: ok.length, pending: day.filter((a) => a.status === 'pending').length, hold: day.filter((a) => a.status === 'hold').length, people, checkedIn: inn.length, checkedInPeople: inPeople, remaining: ok.length - inn.length, remainingPeople: people - inPeople };
  }
  return { appointments: rows.map(view), stats };
}, 'admin');

for (const [action, status] of [['approve', 'approved'], ['hold', 'hold'], ['reject', 'rejected'], ['cancel', 'cancelled']]) {
  on('POST', `/api/admin/appointments/:id/${action}`, ({ params, body, user }) => {
    const a = db.appointments.find((x) => x.id === Number(params[0]));
    if (!a) throw new HttpError(404, 'Appointment not found');
    const allowed = { approved: ['pending', 'hold'], hold: ['pending'], rejected: ['pending', 'hold'], cancelled: ACTIVE }[status];
    if (!allowed.includes(a.status)) throw new HttpError(409, `This appointment is already ${a.status}.`);
    if (a.checked_in_at) throw new HttpError(409, 'This visitor has already checked in.');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
    a.status = status;
    a.admin_note = note ?? a.admin_note;
    a.reviewed_by = user.id;
    if (status === 'approved') {
      a.checkin_code ??= code();
      if (a.date === today() || (a.date === addDays(today(), 1) && clock() >= CONFIG.reminderTime)) a.reminded_day_before = 1;
      if (a.date === today()) a.greeted = 1;
    }
    const when = formatVisit(a);
    const suffix = note ? `\nNote: ${note}` : '';
    const msg = {
      approved: ['Appointment confirmed ✅', `Your meeting with Gurudev is confirmed for ${when} for ${a.people_count} ${a.people_count === 1 ? 'person' : 'people'}. Your QR entry pass will be sent on WhatsApp on ${formatDay(a.date)} at ${formatClock(periods[a.period].start)}.${suffix}`],
      rejected: ['Appointment request declined', `We are sorry, your request for ${when} could not be accommodated.${suffix}`],
      cancelled: ['Appointment cancelled', `Your appointment on ${when} has been cancelled by the ashram.${suffix}`],
    }[status];
    if (msg) notify(a.user_id, a.id, ...msg, { phone: a.phone });
    emitToStaff('appointment');
    if (status === 'approved') setTimeout(() => { runJobs(); save(); }, 800);
    return { appointment: view(a) };
  }, 'admin');
}

on('POST', '/api/admin/broadcast', ({ body, user }) => {
  const date = DATE_RE.test(body.date ?? '') ? body.date : null;
  if (!date) throw new HttpError(400, 'Please choose a date');
  const period = PERIODS.includes(body.period) ? body.period : null;
  const message = text(body.message, 'the message', 600);
  const rows = db.appointments.filter((a) => a.date === date && a.status === 'approved' && (!period || a.period === period));
  if (!rows.length) throw new HttpError(400, 'There are no confirmed visitors for this day.');
  for (const a of rows) notify(a.user_id, a.id, 'Message from the ashram', message, { phone: a.phone, kind: 'broadcast' });
  db.broadcasts.push({ id: nextId('broadcasts'), date, period, body: message, recipients: rows.length, sent_by_name: user.name, created_at: sqlNow() });
  return { recipients: rows.length };
}, 'admin');
on('GET', '/api/admin/broadcasts', ({ query }) => ({ broadcasts: db.broadcasts.filter((b) => b.date === (query.date ?? today())).reverse() }), 'admin');

on('GET', '/api/admin/security', ({ query }) => {
  const q = String(query.q ?? '').trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const order = { pending: 0, active: 1 };
  const staff = db.users.filter((u) => u.role === 'security' && isComplete(u) && (!q || u.name.toLowerCase().includes(q) || (digits && u.phone.includes(digits))))
    .sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || a.name.localeCompare(b.name))
    .map((u) => ({ ...publicUser(u), createdAt: u.created_at, reviewedBy: u.reviewed_by ? userById(u.reviewed_by)?.name : null, checkinsToday: db.appointments.filter((a) => a.checked_in_by === u.id && a.date === today()).length }));
  return { staff };
}, 'admin');
for (const [action, status] of [['approve', 'active'], ['revoke', 'revoked'], ['reject', 'rejected']]) {
  on('POST', `/api/admin/security/:id/${action}`, ({ params, user }) => {
    const u = db.users.find((x) => x.id === Number(params[0]) && x.role === 'security');
    if (!u) throw new HttpError(404, 'Security staff member not found');
    u.status = status;
    u.reviewed_by = user.id;
    const msg = { active: ['Scanner access approved ✅', 'You can now open the app and scan visitor passes.'], revoked: ['Scanner access removed', 'Your access to the visitor scanner has been removed by the admin.'], rejected: ['Security registration not approved', 'Your request for scanner access was not approved.'] }[status];
    notify(u.id, null, ...msg);
    emitToUser(u.id, 'status', { status });
    emitToStaff('security');
    return { staff: publicUser(u) };
  }, 'admin');
}

on('GET', '/api/admin/admins', () => ({ admins: db.users.filter((u) => u.role === 'admin').map(publicUser) }), 'admin');
on('POST', '/api/admin/admins', ({ body }) => {
  const p = phone(body.phone);
  let u = db.users.find((x) => x.phone === p);
  if (u) { u.role = 'admin'; u.status = 'active'; } else {
    u = { id: nextId('users'), phone: p, name: text(body.name, 'their name', 80, { required: false }) || null, photo: null, role: 'admin', status: 'active', created_at: sqlNow() };
    db.users.push(u);
  }
  return { admin: publicUser(u) };
}, 'admin');
on('DELETE', '/api/admin/admins/:id', ({ params, user }) => {
  const id = Number(params[0]);
  if (id === user.id) throw new HttpError(400, "You can't remove your own admin access");
  const u = userById(id);
  if (!u || u.role !== 'admin') throw new HttpError(404, 'Admin not found');
  u.role = 'visitor';
  return { ok: true };
}, 'admin');

on('GET', '/api/admin/sessions', ({ query }) => {
  const from = DATE_RE.test(query.from ?? '') ? query.from : today();
  const to = DATE_RE.test(query.to ?? '') ? query.to : addDays(from, 30);
  return { sessions: db.sessions.filter((s) => s.date >= from && s.date <= to).sort(bySession).map((s) => ({ ...s, label: periods[s.period].label, booked: used(s.id), bookings: db.appointments.filter((a) => a.session_id === s.id && ACTIVE.includes(a.status)).length })) };
}, 'admin');
on('POST', '/api/admin/sessions', ({ body }) => {
  const { fromDate, toDate = fromDate } = body;
  if (!DATE_RE.test(fromDate ?? '') || !DATE_RE.test(toDate ?? '') || toDate < fromDate) throw new HttpError(400, 'Please choose the dates');
  const chosen = (body.periods ?? []).filter((p) => PERIODS.includes(p));
  if (!chosen.length) throw new HttpError(400, 'Please choose Morning, Afternoon or Evening');
  const capacity = Number(body.capacity);
  if (!Number.isInteger(capacity) || capacity < 1) throw new HttpError(400, 'Please enter how many people each session can take');
  const weekdays = Array.isArray(body.weekdays) ? body.weekdays.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  let created = 0;
  let skipped = 0;
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    if (!weekdays.includes(dayOfWeek(d))) continue;
    for (const p of chosen) {
      if (db.sessions.some((s) => s.date === d && s.period === p)) { skipped++; continue; }
      db.sessions.push({ id: nextId('sessions'), date: d, period: p, capacity, is_closed: 0 });
      created++;
    }
  }
  return { created, skipped, status: 201 };
}, 'admin');
on('PATCH', '/api/admin/sessions/:id', ({ params, body }) => {
  const s = db.sessions.find((x) => x.id === Number(params[0]));
  if (!s) throw new HttpError(404, 'Session not found');
  if (body.capacity !== undefined) s.capacity = Math.max(1, Number(body.capacity) || s.capacity);
  if (body.closed !== undefined) s.is_closed = body.closed ? 1 : 0;
  return { session: s };
}, 'admin');
on('DELETE', '/api/admin/sessions/:id', ({ params }) => {
  const id = Number(params[0]);
  if (db.appointments.some((a) => a.session_id === id)) throw new HttpError(409, 'This session has bookings. Close it instead of deleting it.');
  db.sessions = db.sessions.filter((s) => s.id !== id);
  return { ok: true };
}, 'admin');
on('GET', '/api/admin/outbox', () => ({ messages: [...db.outbox].reverse().slice(0, 100).map((m) => ({ ...m, preview: m.kind === 'otp' ? 'Login code' : m.preview.replace('\n', ': ') })) }), 'admin');

// ---- Entry point used by each app frame ----------------------------------------------------

export async function handle(frame, method, url, body) {
  const u = new URL(url, 'http://preview');
  const route = routes.find((r) => r.method === method && r.re.test(u.pathname));
  if (!route) return { status: 404, body: { error: 'Not found' } };
  const user = userById(db.auth[frame]) ?? null;
  try {
    if (route.auth && !user) throw new HttpError(401, 'Please log in to continue');
    if (route.auth === 'profile' && !isComplete(user)) throw new HttpError(403, 'Please add your name and photo first');
    if (route.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admins only');
    if (route.auth === 'staff' && !(user.role === 'admin' || (user.role === 'security' && user.status === 'active'))) throw new HttpError(403, 'You do not have scanner access');
    const result = await route.fn({ frame, user, body: body ?? {}, query: Object.fromEntries(u.searchParams), params: u.pathname.match(route.re).slice(1) });
    save();
    const { status = 200, ...rest } = result;
    return { status, body: rest };
  } catch (err) {
    save();
    if (!err.status) console.error(err);
    return { status: err.status ?? 500, body: { error: err.status ? err.message : 'Something went wrong', ...err.extra } };
  }
}

export const currentUser = (frame) => publicUser(userById(db.auth[frame]));
export const outbox = () => [...db.outbox].reverse();

// Passes the scan helper offers in the preview (instead of a camera).
export function scannablePasses() {
  // Valid passes first (by session), then used ones, most recent first.
  return db.appointments.filter((a) => a.status === 'approved' && a.date === today())
    .sort((a, b) => Number(Boolean(a.checked_in_at)) - Number(Boolean(b.checked_in_at)) || (a.checked_in_at ? b.checked_in_at.localeCompare(a.checked_in_at) : bySession(a, b)))
    .map((a) => ({ name: a.name, label: PERIOD_LABELS[a.period], people: a.people_count, code: a.checkin_code, used: Boolean(a.checked_in_at), state: scanResult(a, opts()).result }));
}

// ---- Scheduled messages and the preview clock -------------------------------------------

export function runJobs() {
  const t = today();
  const tomorrow = addDays(t, 1);
  const time = clock();
  let sent = 0;
  for (const a of db.appointments.filter((x) => x.status === 'approved' && !x.checked_in_at)) {
    if (a.date === tomorrow && !a.reminded_day_before && time >= CONFIG.reminderTime) {
      a.reminded_day_before = 1;
      notify(a.user_id, a.id, 'Your visit is tomorrow 🙏', `Reminder: your meeting with Gurudev is tomorrow, ${formatVisit(a)}, for ${a.people_count} ${a.people_count === 1 ? 'person' : 'people'}. Your QR entry pass will be sent on WhatsApp tomorrow at ${formatClock(periods[a.period].start)}.`, { phone: a.phone });
      sent++;
    }
    if (a.date !== t) continue;
    if (!a.greeted && time >= CONFIG.greetingTime) {
      a.greeted = 1;
      a.reminded_day_before = 1;
      const opens = periods[a.period].start;
      notify(a.user_id, a.id, 'Jai Gurudev 🙏 Today is your visit', `Good day, ${a.name}! Today is your meeting with Gurudev (${PERIOD_LABELS[a.period]}). ${minutesUntil(t, opens, TZ, now()) > 0 ? `Your QR entry pass will be sent at ${formatClock(opens)}.` : 'Your QR entry pass is being sent now.'}`, { phone: a.phone });
      sent++;
    }
    if (!a.pass_sent_at && minutesUntil(t, periods[a.period].start, TZ, now()) <= 0) {
      a.pass_sent_at = sqlNow();
      a.greeted = 1;
      const body = `${a.name}, this is your QR pass for today (${formatDay(t)}, ${PERIOD_LABELS[a.period]}) for ${a.people_count} ${a.people_count === 1 ? 'person' : 'people'}. Show it at the entrance. It is valid only today and can be scanned only once.`;
      const n = { id: nextId('notifications'), user_id: a.user_id, appointment_id: a.id, title: 'Your entry pass 🎟️', body, read_at: null, created_at: sqlNow() };
      db.notifications.push(n);
      emitToUser(a.user_id, 'notification', n);
      whatsapp('pass', a.phone, `[QR code image] Your entry pass 🎟️\n${body}`);
      sent++;
    }
  }
  if (sent) { save(); emitToStaff('appointment'); }
  return sent;
}

// The next moment a scheduled message is due, for "skip ahead". Follows the
// person using the visitor phone when they have a confirmed visit.
export function nextEvent() {
  const times = [];
  const visitorId = db.auth.visitor;
  let pool = db.appointments.filter((x) => x.status === 'approved' && !x.checked_in_at && x.date >= today());
  if (pool.some((a) => a.user_id === visitorId)) pool = pool.filter((a) => a.user_id === visitorId);
  else if (db.appointments.some((a) => a.user_id === visitorId && ['pending', 'hold'].includes(a.status))) pool = [];
  for (const a of pool) {
    if (!a.reminded_day_before) times.push({ at: new Date(`${addDays(a.date, -1)}T${CONFIG.reminderTime}`), what: 'the day-before reminder' });
    if (!a.greeted) times.push({ at: new Date(`${a.date}T${CONFIG.greetingTime}`), what: 'the morning greeting' });
    if (!a.pass_sent_at) times.push({ at: new Date(`${a.date}T${periods[a.period].start}`), what: 'the QR entry pass' });
  }
  return times.filter((x) => x.at > now()).sort((a, b) => a.at - b.at)[0] ?? null;
}
export function waitingForApproval() {
  return db.appointments.some((a) => a.user_id === db.auth.visitor && ['pending', 'hold'].includes(a.status));
}

export function skipTo(date) {
  db.offsetMs = Math.max(0, date.getTime() - Date.now() + 1000);
  runJobs();
  save();
  emit({ type: 'clock' });
  emitToStaff('clock');
}
export function backToNow() { db.offsetMs = 0; save(); emit({ type: 'clock' }); emitToStaff('clock'); }
export const previewNow = () => now();
export const timeShifted = () => db.offsetMs > 0;

load();
