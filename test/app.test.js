import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { sendDueReminders } from '../src/jobs.js';

// Clock starts at 2030-01-10 09:00 in Kolkata (UTC+5:30), a Thursday.
let clock;
let server;
let base;
let db;
let app;
const waRequests = [];

const config = {
  timeZone: 'Asia/Kolkata',
  whatsapp: { token: 't', phoneNumberId: '123', template: 'appointment_update', language: 'en' },
  fetch: async (url, opts) => { waRequests.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; },
};

beforeEach(async () => {
  clock = new Date('2030-01-10T03:30:00Z');
  waRequests.length = 0;
  db = openDatabase(':memory:');
  createUser(db, { name: 'Seva Admin', email: 'admin@ashram.org', phone: '+919000000000', password: 'adminpass1', role: 'admin' });
  app = createApp({ db, config, now: () => clock });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
});

const at = (iso) => { clock = new Date(iso); };

// A tiny browser: keeps the session cookie between requests.
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...headers },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

async function admin() {
  const c = client();
  assert.equal((await c('/api/auth/login', { method: 'POST', body: { email: 'admin@ashram.org', password: 'adminpass1' } })).status, 200);
  return c;
}

async function visitor(overrides = {}) {
  const c = client();
  const res = await c('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Asha Rao', email: `asha${Math.random()}@example.com`, phone: '98765 43210', password: 'password1', ...overrides },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return c;
}

async function makeSlots(a, body = { fromDate: '2030-01-11', startTime: '10:00', endTime: '10:30', duration: 15 }) {
  return a('/api/admin/slots', { method: 'POST', body });
}

const outbox = (channel) => db.prepare('SELECT * FROM outbound_messages WHERE channel = ? ORDER BY id').all(channel);

test('signup normalises the phone for WhatsApp and rejects duplicates and weak passwords', async () => {
  const c = client();
  const res = await c('/api/auth/signup', { method: 'POST', body: { name: 'Asha', email: 'Asha@Example.com', phone: '098765 43210', password: 'password1' } });
  assert.equal(res.status, 201);
  assert.deepEqual([res.body.user.email, res.body.user.phone, res.body.user.role], ['asha@example.com', '+919876543210', 'visitor']);
  assert.equal((await c('/api/auth/me')).body.user.name, 'Asha');

  const dup = await client()('/api/auth/signup', { method: 'POST', body: { name: 'X', email: 'asha@example.com', phone: '9876543210', password: 'password1' } });
  assert.equal(dup.status, 409);
  const weak = await client()('/api/auth/signup', { method: 'POST', body: { name: 'X', email: 'x@example.com', phone: '9876543210', password: 'short' } });
  assert.equal(weak.status, 400);
});

test('login, logout and role checks', async () => {
  const c = client();
  assert.equal((await c('/api/auth/login', { method: 'POST', body: { email: 'admin@ashram.org', password: 'wrong' } })).status, 401);
  const v = await visitor();
  assert.equal((await v('/api/admin/stats')).status, 403);
  assert.equal((await client()('/api/me')).status, 401);
  const a = await admin();
  assert.equal((await a('/api/admin/stats')).status, 200);
  await a('/api/auth/logout', { method: 'POST' });
  assert.equal((await a('/api/admin/stats')).status, 401);
});

test('cross-site requests are blocked', async () => {
  const a = await admin();
  const res = await a('/api/admin/slots', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: {} });
  assert.equal(res.status, 403);
});

test('password reset by email link', async () => {
  const v = await visitor({ email: 'reset@example.com' });
  await v('/api/auth/logout', { method: 'POST' });
  await client()('/api/auth/forgot', { method: 'POST', body: { email: 'reset@example.com' } });
  await client()('/api/auth/forgot', { method: 'POST', body: { email: 'nobody@example.com' } });
  await app.locals.notifier.settle();
  const emails = outbox('email');
  assert.equal(emails.length, 1);
  const token = emails[0].body.match(/#\/reset\/([\w-]+)/)[1];
  const c = client();
  assert.equal((await c('/api/auth/reset', { method: 'POST', body: { token, password: 'newpassword' } })).status, 200);
  assert.equal((await c('/api/auth/reset', { method: 'POST', body: { token, password: 'again12345' } })).status, 400);
  assert.equal((await client()('/api/auth/login', { method: 'POST', body: { email: 'reset@example.com', password: 'newpassword' } })).status, 200);
});

test('bulk slot creation respects weekdays, duration and gap', async () => {
  const a = await admin();
  const res = await makeSlots(a, { fromDate: '2030-01-10', toDate: '2030-01-16', startTime: '10:00', endTime: '11:00', duration: 15, gap: 5, weekdays: [4, 5] });
  assert.deepEqual(res.body, { created: 6, skipped: 0 });
  const { body } = await client()('/api/slots');
  assert.equal(body.slots.length, 6);
  assert.equal(body.slots[1].start_time, '10:20');
});

test('booking requires an account and is prefilled from it', async () => {
  const a = await admin();
  await makeSlots(a);
  const slotId = (await client()('/api/slots')).body.slots[0].id;
  assert.equal((await client()('/api/appointments', { method: 'POST', body: { slotId, purpose: 'x' } })).status, 401);
  const v = await visitor();
  const res = await v('/api/appointments', { method: 'POST', body: { slotId, purpose: 'Seeking guidance' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.appointment.name, 'Asha Rao');
  assert.equal(res.body.appointment.phone, '+919876543210');
  assert.equal((await v('/api/appointments', { method: 'POST', body: { slotId, purpose: 'again' } })).status, 409);
});

test('full journey: email + WhatsApp confirmations, reminders, QR pass and check-in', async () => {
  const a = await admin();
  await makeSlots(a);
  const v = await visitor();
  const slotId = (await client()('/api/slots')).body.slots[0].id; // 2030-01-11 10:00–10:15
  const { body: { appointment } } = await v('/api/appointments', { method: 'POST', body: { slotId, purpose: 'Seeking guidance' } });

  // Approval: in-app, email and WhatsApp.
  await a(`/api/admin/appointments/${appointment.id}/approve`, { method: 'POST', body: { note: 'Bring photo ID' } });
  await app.locals.notifier.settle();
  let me = (await v('/api/me')).body;
  assert.equal(me.notifications[0].title, 'Appointment confirmed 🙏');
  assert.match(me.notifications[0].body, /Friday, 11 January 2030, 10:00–10:15/);
  const emails = outbox('email').map((e) => e.subject);
  assert.deepEqual(emails, ['Request received', 'Appointment confirmed 🙏']);
  const wa = waRequests.at(-1).body;
  assert.equal(wa.to, '919876543210');
  assert.equal(wa.template.name, 'appointment_update');
  assert.equal(wa.template.components[0].parameters[0].text, 'Appointment confirmed 🙏');
  assert.doesNotMatch(wa.template.components[0].parameters[1].text, /\n/);
  assert.equal(outbox('whatsapp').at(-1).status, 'sent');

  // The QR pass is hidden until 10 minutes before.
  let pass = (await v(`/api/me/appointments/${appointment.id}/pass`)).body.pass;
  assert.equal(pass.state, 'not_yet');
  assert.equal(pass.code, undefined);

  // Reminders: 24h, 1h, then "pass ready" at 10 minutes before.
  const remind = (iso) => sendDueReminders({ db, notifier: app.locals.notifier, config: app.locals.config, now: new Date(iso) });
  assert.equal(remind('2030-01-10T03:30:00Z'), 0);  // 25h before
  assert.equal(remind('2030-01-10T05:30:00Z'), 1);  // 23h before
  assert.equal(remind('2030-01-11T03:40:00Z'), 1);  // 50 min before
  assert.equal(remind('2030-01-11T04:21:00Z'), 1);  // 9 min before
  assert.equal(remind('2030-01-11T04:22:00Z'), 0);
  me = (await v('/api/me')).body;
  assert.deepEqual(me.notifications.slice(0, 3).map((n) => n.title),
    ['Your entry pass is ready 🎟️', 'Your meeting is in 1 hour', 'Upcoming meeting reminder']);

  at('2030-01-11T04:21:00Z');
  pass = (await v(`/api/me/appointments/${appointment.id}/pass`)).body.pass;
  assert.equal(pass.state, 'ready');
  assert.match(pass.svg, /^<svg/);

  // Admin scans the QR code and admits the visitor.
  assert.equal((await a('/api/admin/checkin/lookup', { method: 'POST', body: { code: 'bogus' } })).status, 404);
  const lookup = (await a('/api/admin/checkin/lookup', { method: 'POST', body: { code: pass.code } })).body;
  assert.deepEqual([lookup.canAdmit, lookup.needsOverride, lookup.appointment.name], [true, false, 'Asha Rao']);
  const admitted = await a('/api/admin/checkin', { method: 'POST', body: { code: pass.code } });
  assert.equal(admitted.status, 200);
  assert.equal(admitted.body.appointment.checked_in_by, 'Seva Admin');
  const again = await a('/api/admin/checkin', { method: 'POST', body: { code: pass.code } });
  assert.equal(again.status, 409);

  pass = (await v(`/api/me/appointments/${appointment.id}/pass`)).body.pass;
  assert.equal(pass.state, 'checked_in');
  assert.equal(pass.code, undefined);

  // Dashboard reflects it.
  const stats = (await a('/api/admin/stats')).body;
  assert.equal(stats.today, '2030-01-11');
  assert.deepEqual(stats.summary, { booked: 1, checkedIn: 1, pending: 0, awaiting: 0, open: 1 });
  assert.equal(stats.todayList[0].checked_in_at !== null, true);
});

test('check-in on the wrong day needs an override; cancelled passes are refused', async () => {
  const a = await admin();
  await makeSlots(a);
  const v = await visitor();
  const [s1, s2] = (await client()('/api/slots')).body.slots;
  const one = (await v('/api/appointments', { method: 'POST', body: { slotId: s1.id, purpose: 'x' } })).body.appointment;
  const two = (await v('/api/appointments', { method: 'POST', body: { slotId: s2.id, purpose: 'y' } })).body.appointment;
  await a(`/api/admin/appointments/${one.id}/approve`, { method: 'POST', body: {} });
  await a(`/api/admin/appointments/${two.id}/approve`, { method: 'POST', body: {} });
  await a(`/api/admin/appointments/${two.id}/cancel`, { method: 'POST', body: {} });

  // It's the day before.
  const early = (await a('/api/admin/checkin/lookup', { method: 'POST', body: { appointmentId: one.id } })).body;
  assert.equal(early.needsOverride, true);
  assert.match(early.reason, /not today/);
  assert.equal((await a('/api/admin/checkin', { method: 'POST', body: { appointmentId: one.id } })).status, 409);
  assert.equal((await a('/api/admin/checkin', { method: 'POST', body: { appointmentId: one.id, override: true } })).status, 200);

  const cancelled = (await a('/api/admin/checkin/lookup', { method: 'POST', body: { appointmentId: two.id } })).body;
  assert.equal(cancelled.canAdmit, false);
  assert.equal((await a('/api/admin/checkin', { method: 'POST', body: { appointmentId: two.id, override: true } })).status, 409);
});

test('dashboard counts are per date', async () => {
  const a = await admin();
  await makeSlots(a, { fromDate: '2030-01-10', toDate: '2030-01-12', startTime: '10:00', endTime: '11:00', duration: 15 });
  const v = await visitor();
  const slots = (await client()('/api/slots')).body.slots;
  const byDate = (d) => slots.filter((s) => s.date === d);
  const book = async (slot) => (await v('/api/appointments', { method: 'POST', body: { slotId: slot.id, purpose: 'x' } })).body.appointment;
  const a1 = await book(byDate('2030-01-10')[0]);
  const a2 = await book(byDate('2030-01-11')[0]);
  await book(byDate('2030-01-11')[1]);
  await a(`/api/admin/appointments/${a1.id}/approve`, { method: 'POST', body: {} });
  await a(`/api/admin/appointments/${a2.id}/approve`, { method: 'POST', body: {} });
  at('2030-01-10T04:25:00Z'); // 09:55, a1 is at 10:00
  await a('/api/admin/checkin', { method: 'POST', body: { appointmentId: a1.id } });

  const { days } = (await a('/api/admin/stats?from=2030-01-10&to=2030-01-12')).body;
  assert.deepEqual(days.map(({ date, booked, checkedIn, pending, slots: n }) => ({ date, booked, checkedIn, pending, n })), [
    { date: '2030-01-10', booked: 1, checkedIn: 1, pending: 0, n: 4 },
    { date: '2030-01-11', booked: 1, checkedIn: 0, pending: 1, n: 4 },
    { date: '2030-01-12', booked: 0, checkedIn: 0, pending: 0, n: 4 },
  ]);
});

test('visitors can message the admin team and get replies', async () => {
  const a = await admin();
  const v = await visitor();
  assert.equal((await v('/api/me/messages', { method: 'POST', body: { body: 'Can I bring my mother?' } })).status, 201);
  assert.equal((await a('/api/admin/summary')).body.unreadMessages, 1);
  const { threads } = (await a('/api/admin/threads')).body;
  assert.equal(threads[0].unread, 1);
  const thread = (await a(`/api/admin/threads/${threads[0].user_id}`)).body;
  assert.equal(thread.messages[0].body, 'Can I bring my mother?');
  assert.equal((await a('/api/admin/summary')).body.unreadMessages, 0);

  await a(`/api/admin/threads/${threads[0].user_id}`, { method: 'POST', body: { body: 'Yes, of course.' } });
  const me = (await v('/api/me')).body;
  assert.equal(me.unreadMessages, 1);
  assert.equal(me.notifications[0].title, 'New message from the ashram');
  const msgs = (await v('/api/me/messages')).body.messages;
  assert.deepEqual(msgs.map((m) => [m.from_admin, m.body]), [[0, 'Can I bring my mother?'], [1, 'Yes, of course.']]);
  assert.equal((await v('/api/me')).body.unreadMessages, 0);
});

test('admins can add, promote and remove admins', async () => {
  const a = await admin();
  const created = await a('/api/admin/admins', { method: 'POST', body: { name: 'Second', email: 'second@ashram.org', phone: '9000000001', password: 'secondpass' } });
  assert.equal(created.status, 201);
  await visitor({ email: 'helper@example.com' });
  const promoted = await a('/api/admin/admins', { method: 'POST', body: { email: 'helper@example.com' } });
  assert.equal(promoted.body.promoted, true);
  assert.equal((await a('/api/admin/admins')).body.admins.length, 3);
  assert.equal((await a(`/api/admin/admins/${created.body.admin.id}`, { method: 'DELETE' })).status, 200);
  const self = db.prepare("SELECT id FROM users WHERE email = 'admin@ashram.org'").get().id;
  assert.equal((await a(`/api/admin/admins/${self}`, { method: 'DELETE' })).status, 400);
});

test('visitors can hold at most three upcoming appointments', async () => {
  const a = await admin();
  await makeSlots(a, { fromDate: '2030-01-11', startTime: '10:00', endTime: '11:00', duration: 15 });
  const v = await visitor();
  const slots = (await client()('/api/slots')).body.slots;
  for (const s of slots.slice(0, 3)) {
    assert.equal((await v('/api/appointments', { method: 'POST', body: { slotId: s.id, purpose: 'x' } })).status, 201);
  }
  const res = await v('/api/appointments', { method: 'POST', body: { slotId: slots[3].id, purpose: 'x' } });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /at most 3/);
});
