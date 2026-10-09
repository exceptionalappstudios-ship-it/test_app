import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword, REFERENCES } from '../src/references.js';

// Clock starts Thursday 2030-01-10, 09:00 in Kolkata (03:30 UTC).
let clock;
let server;
let base;
let db;
let app;
let sent; // WhatsApp API requests

const at = (iso) => { clock = new Date(iso); };
const IST = (date, time) => new Date(new Date(`${date}T${time}:00Z`).getTime() - 330 * 60000).toISOString();
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]);

beforeEach(async () => {
  at(IST('2030-01-10', '09:00'));
  sent = [];
  db = openDatabase(':memory:');
  db.prepare("INSERT INTO users (phone, name, photo, role) VALUES ('+919000000001', 'Seva Admin', NULL, 'admin')").run();
  app = createApp({
    db, now: () => clock,
    config: {
      adminPasswordHash: hashPassword('test-pass'),
      references: [...REFERENCES, { id: 'seva', name: 'Seva Admin', phones: ['9000000001'] }],
      whatsapp: { token: 't', phoneNumberId: '42', otpTemplate: 'login_code', template: 'appointment_update', passTemplate: 'entry_pass', language: 'en' },
      fetch: async (url, opts) => {
        const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : 'multipart';
        sent.push({ url, body });
        return { ok: true, json: async () => ({ id: url.endsWith('/media') ? 'media-1' : 'msg-1' }) };
      },
    },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => { server.closeAllConnections(); server.close(); });

const flush = () => app.locals.whatsapp.kick();
const messagesTo = (phone) => sent.filter((s) => s.body?.to === phone.replace('+', ''));
const templateText = (s) => s.body.template.components.find((c) => c.type === 'body').parameters.map((p) => p.text).join(' | ');

// A tiny browser: keeps the session cookie between requests.
function client() {
  let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(raw ? { 'Content-Type': 'image/jpeg' } : { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }), ...headers },
      body: raw ?? (body && JSON.stringify(body)),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.arrayBuffer() };
  };
  return call;
}

async function login(phone, { signupAs, name, photo = true } = {}) {
  const c = client();
  const req = await c('/api/auth/otp/request', { method: 'POST', body: { phone } });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  await flush();
  const otp = sent.filter((s) => s.body?.template?.name === 'login_code' && s.body.to === req.body.phone.slice(1)).at(-1);
  const code = otp.body.template.components[0].parameters[0].text;
  const res = await c('/api/auth/otp/verify', { method: 'POST', body: { phone, code, signupAs } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  if (name) await c('/api/auth/me', { method: 'PATCH', body: { name, ...(signupAs === 'security' && { referenceId: 'seva' }) } });
  if (photo) await c('/api/auth/me/photo', { method: 'POST', raw: JPEG });
  return c;
}

async function admin(phone = '9000000001') {
  const c = client();
  assert.equal((await c('/api/auth/password', { method: 'POST', body: { phone, password: 'test-pass' } })).status, 200);
  return c;
}
const visitor = (phone = '9876543210', name = 'Asha Rao') => login(phone, { name });

async function openSessions(a, body = {}) {
  return a('/api/admin/sessions', { method: 'POST', body: { fromDate: '2030-01-10', toDate: '2030-01-12', periods: ['morning', 'evening'], capacity: 20, ...body } });
}
const sessionId = async (date, period) => (await client()('/api/availability')).body.days.find((d) => d.date === date)?.sessions.find((s) => s.period === period)?.id;

const booking = (sessionIdValue, extra = {}) => ({
  sessionId: sessionIdValue, referenceId: 'satish', refPhone: '98200 29858', peopleCount: 1, people: [],
  purposes: ['blessings'], description: 'Blessings for my family', ...extra,
});

// ---------------------------------------------------------------------------------

test('logging in with a WhatsApp code creates an account that must add name and photo', async () => {
  const c = client();
  for (const bad of ['98765 4321', '098765 43210', '987654321012', '+1 98765 43210']) {
    const r = await c('/api/auth/otp/request', { method: 'POST', body: { phone: bad } });
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, /10 digits/);
  }
  const req = await c('/api/auth/otp/request', { method: 'POST', body: { phone: '98765 43210' } });
  assert.deepEqual([req.body.phone, req.body.isNew, req.body.testCode], ['+919876543210', true, undefined]);
  await flush();
  const otp = sent.at(-1).body;
  assert.equal(otp.to, '919876543210');
  assert.equal(otp.template.name, 'login_code');
  const code = otp.template.components[0].parameters[0].text;
  assert.match(code, /^\d{6}$/);
  // The code never appears in the admin-readable log.
  assert.equal(db.prepare("SELECT preview, payload FROM outbound_messages WHERE kind = 'otp'").get().payload, '{}');

  assert.equal((await c('/api/auth/otp/request', { method: 'POST', body: { phone: '9876543210' } })).status, 429); // 30s cooldown
  assert.equal((await c('/api/auth/otp/verify', { method: 'POST', body: { phone: '9876543210', code: '000000' } })).status, 400);
  const ok = await c('/api/auth/otp/verify', { method: 'POST', body: { phone: '9876543210', code } });
  assert.deepEqual([ok.body.user.role, ok.body.user.profileComplete], ['visitor', false]);
  assert.equal((await c('/api/auth/otp/verify', { method: 'POST', body: { phone: '9876543210', code } })).status, 400); // single use

  assert.equal((await c('/api/appointments', { method: 'POST', body: booking(1) })).status, 403);
  await c('/api/auth/me', { method: 'PATCH', body: { name: 'Asha Rao' } });
  assert.equal((await c('/api/auth/me/photo', { method: 'POST', raw: Buffer.from('not a jpeg'.repeat(200)) })).status, 400);
  const photo = await c('/api/auth/me/photo', { method: 'POST', raw: JPEG });
  assert.equal(photo.body.user.profileComplete, true);
  assert.equal((await c(photo.body.user.photo)).status, 200);
});

test('wrong codes are limited', async () => {
  const c = client();
  await c('/api/auth/otp/request', { method: 'POST', body: { phone: '9876543210' } });
  for (let i = 0; i < 5; i++) await c('/api/auth/otp/verify', { method: 'POST', body: { phone: '9876543210', code: '111111' } });
  const res = await c('/api/auth/otp/verify', { method: 'POST', body: { phone: '9876543210', code: '111111' } });
  assert.equal(res.status, 429);
});

test('security staff sign up, wait for approval, and can be revoked', async () => {
  const fresh = await login('9822222222', { signupAs: 'security', photo: true });
  const half = (await fresh('/api/auth/me', { method: 'PATCH', body: { name: 'No Reference' } })).body.user;
  assert.equal(half.profileComplete, false); // a reference is needed too
  assert.equal((await fresh('/api/auth/me', { method: 'PATCH', body: { name: 'No Reference', referenceId: 'nobody' } })).status, 400);
  const s = await login('9811111111', { signupAs: 'security', name: 'Ramesh Guard' });
  assert.deepEqual([(await s('/api/auth/me')).body.user.role, (await s('/api/auth/me')).body.user.status], ['security', 'pending']);
  assert.deepEqual([(await s('/api/auth/me')).body.user.profileComplete, (await s('/api/auth/me')).body.user.referenceId], [true, 'seva']);
  assert.equal((await s('/api/staff/scan', { method: 'POST', body: { code: 'x' } })).status, 403);
  assert.equal((await s('/api/admin/dashboard')).status, 403);

  // Only the reference they chose sees and answers the request.
  db.prepare("INSERT INTO users (phone, name, role) VALUES ('+911234567890', 'Demo', 'admin')").run();
  const other = await admin('1234567890');
  assert.equal((await other('/api/admin/dashboard')).body.summary.securityPending, 0);
  assert.equal((await other('/api/admin/security')).body.staff.length, 0);
  const a = await admin();
  assert.equal((await a('/api/admin/dashboard')).body.summary.securityPending, 1);
  const list = (await a('/api/admin/security?q=ramesh')).body.staff;
  assert.equal(list.length, 1);
  assert.equal(list[0].reference, 'Seva Admin');
  const denied = await other(`/api/admin/security/${list[0].id}/approve`, { method: 'POST' });
  assert.deepEqual([denied.status, denied.body.error], [403, 'Only Seva Admin can approve this request.']);
  assert.equal((await a('/api/admin/security?q=98111')).body.staff.length, 1);
  await a(`/api/admin/security/${list[0].id}/approve`, { method: 'POST' });
  assert.equal((await s('/api/staff/scan', { method: 'POST', body: { code: 'nope' } })).status, 404);
  assert.equal((await other('/api/admin/security')).body.staff.length, 1); // approved staff are visible to every admin
  await other(`/api/admin/security/${list[0].id}/revoke`, { method: 'POST' });
  assert.equal((await s('/api/staff/scan', { method: 'POST', body: { code: 'nope' } })).status, 403);
  // Logging in again keeps the existing role; signupAs only applies to new numbers.
  const again = await login('9811111111', { signupAs: 'visitor' });
  assert.equal((await again('/api/auth/me')).body.user.role, 'security');
});

test('availability shows sessions without times and hides ended or full ones', async () => {
  const a = await admin();
  assert.deepEqual((await openSessions(a)).body, { created: 6, skipped: 0 });
  // An afternoon session left over from before is not offered any more.
  db.prepare("INSERT INTO visit_sessions (date, period, capacity) VALUES ('2030-01-11', 'afternoon', 20)").run();
  assert.deepEqual((await client()('/api/availability')).body.days[1].sessions.map((s) => s.label), ['Morning', 'Evening']);
  at(IST('2030-01-10', '14:00')); // morning has ended today
  const { days } = (await client()('/api/availability')).body;
  assert.deepEqual(days[0].sessions.map((s) => s.label), ['Evening']);
  assert.equal(days[0].sessions[0].start, undefined);
  assert.equal(days.length, 3);
  const sid = days[0].sessions[0].id;
  await a(`/api/admin/sessions/${sid}`, { method: 'PATCH', body: { closed: true } });
  assert.deepEqual((await client()('/api/availability')).body.days.map((d) => d.date), ['2030-01-11', '2030-01-12']);
  // Visitors see the reference names, never their numbers.
  const cfg = (await client()('/api/config')).body;
  assert.deepEqual(Object.keys(cfg.periods), ['morning', 'evening']);
  assert.equal(cfg.references[0].name, 'Demo');
  assert.doesNotMatch(JSON.stringify(cfg), /9820029858/);
});

test('booking asks for reference, people, purposes and checks everyone has only one appointment', async () => {
  const a = await admin();
  await openSessions(a);
  const sid = await sessionId('2030-01-11', 'morning');
  const v = await visitor();

  const bad = async (extra, pattern) => {
    const res = await v('/api/appointments', { method: 'POST', body: booking(sid, extra) });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, pattern);
  };
  await bad({ referenceId: '' }, /choose who referred you/);
  await bad({ referenceId: 'nobody' }, /choose who referred you/);
  await bad({ refPhone: '' }, /Satish Vithalani Ji's phone number \(10 digits\)/);
  await bad({ refPhone: '9988776655' }, /does not match Satish Vithalani Ji/);
  await bad({ referenceId: 'demo' }, /does not match Demo/);
  // Either of a reference's numbers works; the form checks it before the last step.
  assert.equal((await v('/api/reference/check', { method: 'POST', body: { referenceId: 'hari-hara', refPhone: '9405070710' } })).status, 200);
  assert.equal((await v('/api/reference/check', { method: 'POST', body: { referenceId: 'hari-hara', refPhone: '8618546110' } })).status, 200);
  assert.equal((await v('/api/reference/check', { method: 'POST', body: { referenceId: 'demo', refPhone: '1234567890' } })).status, 200);
  await bad({ purposes: [] }, /purpose/);
  await bad({ purposes: ['other'], description: '' }, /few words/);
  await bad({ peopleCount: 6 }, /between 1 and 5/);
  await bad({ peopleCount: 2, people: [] }, /1 other person/);
  await bad({ peopleCount: 2, people: [{ name: 'Me Again', phone: '9876543210' }] }, /same as you/);

  // Ravi books first, so he can't also be in Asha's group.
  const ravi = await visitor('9999988888', 'Ravi Kumar');
  assert.equal((await ravi('/api/appointments', { method: 'POST', body: booking(sid) })).status, 201);
  const check = await v('/api/appointments/check', { method: 'POST', body: { phones: ['99999 88888', '9000012345'] } });
  assert.equal(check.body.conflicts.length, 1);
  assert.match(check.body.conflicts[0].message, /Ravi Kumar \(\+919999988888\) already has an appointment on Friday, 11 January \(Morning\)/);
  const blocked = await v('/api/appointments', { method: 'POST', body: booking(sid, { peopleCount: 2, people: [{ name: 'Ravi', phone: '9999988888' }] }) });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.conflicts[0].phone, '+919999988888');

  const okRes = await v('/api/appointments', {
    method: 'POST',
    body: booking(sid, { peopleCount: 3, phone: '+91 98765 00000', people: [{ name: 'Meera Rao', phone: '9123456780' }, { name: 'Kiran Rao', phone: '9123456781' }], purposes: ['blessings', 'life_event'] }),
  });
  assert.equal(okRes.status, 201, JSON.stringify(okRes.body));
  const appt = okRes.body.appointment;
  assert.deepEqual([appt.reference, appt.refPhone, appt.refDesignation], ['Satish Vithalani Ji', '+919820029858', null]);
  assert.deepEqual([appt.peopleCount, appt.people.length, appt.phone, appt.periodLabel], [3, 2, '+919876500000', 'Morning']);
  assert.deepEqual(appt.purposes, ['Need blessings / Guidance', 'Life event (Marriage, Anniversary, Birthday, etc.)']);
  assert.ok(appt.photo);
  await flush();
  assert.match(templateText(messagesTo('+919876500000').at(-1)), /Request received/);

  // One appointment at a time, and group members are blocked too.
  assert.equal((await v('/api/appointments', { method: 'POST', body: booking(sid) })).status, 409);
  const meera = await visitor('9123456780', 'Meera Rao');
  const res = await meera('/api/appointments', { method: 'POST', body: booking(sid) });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /You already have an appointment in Asha Rao's group/);
  // After cancelling, the numbers are free again.
  await v(`/api/me/appointments/${appt.id}/cancel`, { method: 'POST' });
  assert.equal((await meera('/api/appointments', { method: 'POST', body: booking(sid) })).status, 201);
});

test('admins can stop all bookings, close a day, and change slots', async () => {
  const a = await admin();
  await openSessions(a);
  const v = await visitor();
  assert.deepEqual((await a('/api/admin/booking-status')).body, { open: true, message: '' });
  await a('/api/admin/booking-status', { method: 'POST', body: { open: false, message: 'Bookings reopen on Monday.' } });
  const closed = (await client()('/api/availability')).body;
  assert.deepEqual([closed.closed, closed.closedMessage, closed.days.length], [true, 'Bookings reopen on Monday.', 0]);
  const sid = db.prepare("SELECT id FROM visit_sessions WHERE date = '2030-01-11' AND period = 'morning'").get().id;
  const refused = await v('/api/appointments', { method: 'POST', body: booking(sid) });
  assert.deepEqual([refused.status, refused.body.error], [409, 'Bookings reopen on Monday.']);
  await a('/api/admin/booking-status', { method: 'POST', body: { open: true } });

  assert.equal((await a('/api/admin/sessions/day', { method: 'POST', body: { date: '2030-01-11', closed: true } })).body.updated, 2);
  assert.equal((await client()('/api/availability')).body.days.some((d) => d.date === '2030-01-11'), false);
  await a('/api/admin/sessions/day', { method: 'POST', body: { date: '2030-01-11', closed: false } });
  await a(`/api/admin/sessions/${sid}`, { method: 'PATCH', body: { capacity: 2 } });
  const morning = (await client()('/api/availability')).body.days.find((d) => d.date === '2030-01-11').sessions.find((x) => x.period === 'morning');
  assert.equal(morning.remaining, 2);
  assert.equal((await v('/api/appointments', { method: 'POST', body: booking(sid, { peopleCount: 3, people: [{ name: 'A', phone: '9700000001' }, { name: 'B', phone: '9700000002' }] }) })).status, 409);
});

test('sessions fill up by number of people', async () => {
  const a = await admin();
  await openSessions(a, { capacity: 4 });
  const sid = await sessionId('2030-01-11', 'evening');
  const v1 = await visitor('9800000001', 'One');
  const group = (n) => booking(sid, { peopleCount: n, people: Array.from({ length: n - 1 }, (_, i) => ({ name: `P${i}`, phone: `97000000${String(i).padStart(2, '0')}` })) });
  assert.equal((await v1('/api/appointments', { method: 'POST', body: group(3) })).status, 201);
  const v2 = await visitor('9800000002', 'Two');
  const res = await v2('/api/appointments', { method: 'POST', body: booking(sid, { peopleCount: 2, people: [{ name: 'X', phone: '9600000000' }] }) });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Only 1 place is left/);
  const day = (await client()('/api/availability')).body.days.find((d) => d.date === '2030-01-11');
  assert.equal(day.sessions.find((s) => s.period === 'evening').remaining, 1);
});

test('hold, approve with the pass link, reminders, greeting, scan once any time that day', async () => {
  const a = await admin();
  await openSessions(a);
  const sid = await sessionId('2030-01-11', 'evening');
  const v = await visitor();
  const appt = (await v('/api/appointments', { method: 'POST', body: booking(sid, { peopleCount: 2, people: [{ name: 'Meera Rao', phone: '9123456780' }] }) })).body.appointment;

  await a(`/api/admin/appointments/${appt.id}/hold`, { method: 'POST', body: {} });
  assert.equal((await a('/api/admin/appointments?status=hold')).body.appointments.length, 1);
  assert.equal((await a('/api/admin/appointments?status=pending')).body.appointments.length, 0);
  await a(`/api/admin/appointments/${appt.id}/approve`, { method: 'POST', body: { note: 'Please bring an ID card' } });
  await flush();
  // The confirmation is the pass message: entry code plus a "View pass" link.
  const confirm = messagesTo('+919876543210').at(-1).body;
  assert.equal(confirm.template.name, 'entry_pass');
  const text = templateText(messagesTo('+919876543210').at(-1));
  assert.match(text, /^Appointment confirmed ✅ \| Asha Rao, your meeting with Gurudev is confirmed for Friday, 11 January \(Evening\) for 2 people\. Entry code: [A-HJ-NP-Z2-9]{6}\. Tap "View pass".*any time on the day of your visit.*scanned only once/);
  assert.match(text, /Note: Please bring an ID card/);
  const token = confirm.template.components.find((c) => c.type === 'button').parameters[0].text;
  assert.match(token, /^[\w-]{20,}$/);
  assert.equal(sent.filter((x) => x.url.endsWith('/media')).length, 0); // a link, not an image

  // The QR shows in the app straight away.
  const pass = async () => (await v(`/api/me/appointments/${appt.id}/pass`)).body.pass;
  const early = await pass();
  assert.deepEqual([early.state, early.today, early.validOn], ['ready', false, '2030-01-11']);
  const code = db.prepare('SELECT checkin_code FROM appointments WHERE id = ?').get(appt.id).checkin_code;
  assert.equal(early.code, code);
  assert.match(early.svg, /^<svg/);

  const { jobs } = app.locals;
  const runAt = async (date, time) => { at(IST(date, time)); const n = jobs.run(); await flush(); return n; };
  assert.equal(await runAt('2030-01-10', '17:59'), 0);
  assert.equal(await runAt('2030-01-10', '18:00'), 1);      // day before
  assert.match(templateText(messagesTo('+919876543210').at(-1)), new RegExp(`tomorrow.*entry code ${code}.*any time tomorrow`));
  assert.equal(await runAt('2030-01-11', '06:59'), 0);
  assert.equal(await runAt('2030-01-11', '07:00'), 1);      // greeting only; the pass went out already
  assert.match(templateText(messagesTo('+919876543210').at(-1)), new RegExp(`Today is your visit.*entry code ${code}`));
  assert.equal(sent.filter((x) => x.body?.template?.name === 'entry_pass').length, 1);

  // Security can let them in any time on the day, even in the morning.
  const sRes = await login('9811111111', { signupAs: 'security', name: 'Ramesh Guard' });
  const sid2 = (await a('/api/admin/security')).body.staff[0].id;
  await a(`/api/admin/security/${sid2}/approve`, { method: 'POST' });
  at(IST('2030-01-10', '20:00'));
  assert.equal((await sRes('/api/staff/scan', { method: 'POST', body: { code } })).body.result, 'wrong_day');
  assert.equal((await sRes('/api/staff/admit', { method: 'POST', body: { code } })).status, 409);
  at(IST('2030-01-11', '08:05'));
  assert.equal((await pass()).today, true);

  const scan = (await sRes('/api/staff/scan', { method: 'POST', body: { code: ` ${code.toLowerCase()} ` } })).body;
  assert.deepEqual([scan.result, scan.canAdmit, scan.appointment.name, scan.appointment.peopleCount], ['ok', true, 'Asha Rao', 2]);
  assert.equal(scan.appointment.people[0].name, 'Meera Rao');
  assert.ok(scan.appointment.photo);
  assert.equal((await sRes(scan.appointment.photo)).status, 200);
  assert.equal((await sRes('/api/staff/admit', { method: 'POST', body: { code, count: 3 } })).status, 400); // more than booked
  assert.equal((await sRes('/api/staff/admit', { method: 'POST', body: { code } })).status, 200);

  const again = (await sRes('/api/staff/scan', { method: 'POST', body: { code } })).body;
  assert.deepEqual([again.result, again.canAdmit, again.appointment.checkedInBy], ['used', false, 'Ramesh Guard']);
  assert.match(again.message, /Already checked in/);
  assert.equal((await sRes('/api/staff/admit', { method: 'POST', body: { code } })).status, 409);
  assert.equal((await pass()).state, 'checked_in');
  assert.equal((await sRes('/api/staff/recent')).body.people, 2);

  at(IST('2030-01-12', '13:30'));
  assert.equal((await pass()).state, 'checked_in');
});

test('passes are only valid on their day; admins can override, security cannot', async () => {
  const a = await admin();
  await openSessions(a);
  const sid = await sessionId('2030-01-11', 'morning');
  const v = await visitor();
  const appt = (await v('/api/appointments', { method: 'POST', body: booking(sid) })).body.appointment;
  await a(`/api/admin/appointments/${appt.id}/approve`, { method: 'POST', body: {} });
  const scan = (await a('/api/staff/scan', { method: 'POST', body: { appointmentId: appt.id } })).body;
  assert.deepEqual([scan.result, scan.adminOverride], ['wrong_day', true]);
  assert.equal((await a('/api/staff/admit', { method: 'POST', body: { appointmentId: appt.id } })).status, 409);
  assert.equal((await a('/api/staff/admit', { method: 'POST', body: { appointmentId: appt.id, override: true } })).status, 200);
});

test('approving on the day sends just the confirmation with the pass', async () => {
  const a = await admin();
  await openSessions(a);
  const sid = await sessionId('2030-01-10', 'morning'); // it is 09:00, morning is open
  const v = await visitor();
  const appt = (await v('/api/appointments', { method: 'POST', body: booking(sid) })).body.appointment;
  await a(`/api/admin/appointments/${appt.id}/approve`, { method: 'POST', body: {} });
  assert.equal(app.locals.jobs.run(), 0);
  await flush();
  const titles = sent.filter((s) => s.body?.to === '919876543210' && s.body.template.name !== 'login_code').map((s) => s.body.template.components.find((c) => c.type === 'body').parameters[0].text);
  assert.deepEqual(titles, ['Request received 🙏', 'Appointment confirmed ✅']);
});

test('dashboard, date list with search, and who checked people in', async () => {
  const a = await admin();
  await openSessions(a);
  const morning = await sessionId('2030-01-10', 'morning');
  const evening = await sessionId('2030-01-10', 'evening');
  const v1 = await visitor('9800000001', 'Asha Rao');
  const v2 = await visitor('9800000002', 'Ravi Kumar');
  const a1 = (await v1('/api/appointments', { method: 'POST', body: booking(morning, { peopleCount: 3, people: [{ name: 'A', phone: '9700000001' }, { name: 'B', phone: '9700000002' }] }) })).body.appointment;
  const a2 = (await v2('/api/appointments', { method: 'POST', body: booking(evening, { referenceId: 'demo', refPhone: '1234567890' }) })).body.appointment;
  await a(`/api/admin/appointments/${a1.id}/approve`, { method: 'POST', body: {} });
  await a(`/api/admin/appointments/${a2.id}/approve`, { method: 'POST', body: {} });
  const s = await login('9811111111', { signupAs: 'security', name: 'Ramesh Guard' });
  await a(`/api/admin/security/${(await a('/api/admin/security')).body.staff[0].id}/approve`, { method: 'POST' });
  await s('/api/staff/admit', { method: 'POST', body: { appointmentId: a1.id } });

  const d = (await a('/api/admin/dashboard')).body;
  assert.deepEqual(
    [d.summary.bookings, d.summary.people, d.summary.checkedInPeople, d.summary.remainingPeople, d.summary.securityActive],
    [2, 4, 3, 1, 1],
  );
  assert.deepEqual(d.sessions.map((x) => [x.label, x.people, x.checkedInPeople]), [['Morning', 3, 3], ['Evening', 1, 0]]);
  assert.equal(d.recent[0].checkedInBy, 'Ramesh Guard');
  assert.equal(d.days.find((x) => x.date === '2030-01-10').checkedIn, 3);

  const list = (await a('/api/admin/appointments?date=2030-01-10')).body;
  assert.deepEqual([list.stats.approved, list.stats.checkedIn, list.stats.remaining, list.stats.remainingPeople], [2, 1, 1, 1]);
  assert.equal((await a('/api/admin/appointments?date=2030-01-10&checked=out')).body.appointments[0].name, 'Ravi Kumar');
  assert.equal((await a('/api/admin/appointments?date=2030-01-10&q=98000 00002')).body.appointments[0].name, 'Ravi Kumar');
  assert.equal((await a('/api/admin/appointments?date=2030-01-10&q=demo')).body.appointments.length, 1);
  assert.equal((await a('/api/admin/appointments?date=2030-01-10&q=satish')).body.appointments.length, 1);
});

test('the WhatsApp pass link opens a small secure pass page', async () => {
  const a = await admin();
  await openSessions(a);
  const sid = await sessionId('2030-01-11', 'evening');
  const v = await visitor();
  const appt = (await v('/api/appointments', { method: 'POST', body: booking(sid) })).body.appointment;
  await a(`/api/admin/appointments/${appt.id}/approve`, { method: 'POST', body: {} });
  const { pass_token: token, checkin_code: code } = db.prepare('SELECT pass_token, checkin_code FROM appointments WHERE id = ?').get(appt.id);
  const page = async () => { const r = await fetch(`${base}/p/${token}`); return { status: r.status, html: await r.text(), headers: r.headers }; };

  let p = await page(); // the day before: the QR shows, with the day it works
  assert.equal(p.status, 200);
  assert.match(p.html, /Valid on Friday, 11 January · scan once/);
  assert.match(p.html, new RegExp(`class="code">${code}<`));
  assert.equal(p.headers.get('cache-control'), 'no-store');
  assert.match(p.headers.get('content-security-policy'), /default-src 'none'/);

  at(IST('2030-01-11', '08:05'));
  p = await page();
  assert.match(p.html, /<svg/);
  assert.match(p.html, new RegExp(`class="code">${code}<`));
  assert.match(p.html, /Valid today · scan once/);
  assert.ok(Buffer.byteLength(p.html) < 12000, `page is ${Buffer.byteLength(p.html)} bytes`);

  await a('/api/staff/admit', { method: 'POST', body: { code } });
  p = await page();
  assert.match(p.html, /Checked in/);
  assert.doesNotMatch(p.html, /<svg/);
  assert.equal((await fetch(`${base}/p/not-a-real-token-1234567`)).status, 404);
  // The broadcast feature is gone.
  assert.equal((await a('/api/admin/broadcast', { method: 'POST', body: {} })).status, 404);
});

test('security can correct how many people came in', async () => {
  const a = await admin();
  await openSessions(a);
  const sid = await sessionId('2030-01-10', 'morning');
  const v = await visitor();
  const people = [1, 2, 3, 4].map((i) => ({ name: `P${i}`, phone: `970000000${i}` }));
  const appt = (await v('/api/appointments', { method: 'POST', body: booking(sid, { peopleCount: 5, people }) })).body.appointment;
  await a(`/api/admin/appointments/${appt.id}/approve`, { method: 'POST', body: {} });
  const s = await login('9811111111', { signupAs: 'security', name: 'Ramesh Guard' });
  await a(`/api/admin/security/${(await a('/api/admin/security')).body.staff[0].id}/approve`, { method: 'POST' });
  const admitted = (await s('/api/staff/admit', { method: 'POST', body: { appointmentId: appt.id, count: 3 } })).body.appointment;
  assert.deepEqual([admitted.peopleCount, admitted.checkedInCount], [5, 3]);
  let d = (await a('/api/admin/dashboard')).body.summary;
  assert.deepEqual([d.people, d.checkedInPeople, d.remainingPeople], [5, 3, 0]);
  assert.equal((await s('/api/staff/count', { method: 'POST', body: { appointmentId: appt.id, count: 4 } })).body.appointment.checkedInCount, 4);
  assert.equal((await s('/api/staff/count', { method: 'POST', body: { appointmentId: appt.id, count: 6 } })).status, 400);
  assert.equal((await s('/api/staff/recent')).body.people, 4);
  d = (await a('/api/admin/dashboard')).body.summary;
  assert.equal(d.checkedInPeople, 4);
});

test('photos are private to their owner and staff', async () => {
  const v1 = await visitor('9800000001', 'Asha');
  const v2 = await visitor('9800000002', 'Ravi');
  const photo = (await v1('/api/auth/me')).body.user.photo;
  assert.equal((await v1(photo)).status, 200);
  assert.equal((await v2(photo)).status, 404);
  assert.equal((await client()(photo)).status, 401);
  assert.equal((await (await admin())(photo)).status, 200);
});

test('admins log in with their number and the admin password', async () => {
  const c = client();
  const tryLogin = (phone, password) => c('/api/auth/password', { method: 'POST', body: { phone, password } });
  assert.equal((await tryLogin('9000000001', 'wrong')).status, 400);
  // Not an admin: same answer, so the admin numbers can't be found this way.
  const v = await visitor();
  const notAdmin = await tryLogin('9876543210', 'test-pass');
  assert.deepEqual([notAdmin.status, notAdmin.body.error], [400, 'Wrong number or password.']);
  // Admin numbers can't use WhatsApp codes (codes may be shown on screen before WhatsApp is set up).
  const otp = await c('/api/auth/otp/request', { method: 'POST', body: { phone: '9000000001' } });
  assert.deepEqual([otp.status, otp.body.error], [400, 'This is an admin number. Please log in on the admin page with your password.']);
  const ok = await tryLogin('90000 00001', 'test-pass');
  assert.deepEqual([ok.status, ok.body.user.role, ok.body.user.profileComplete], [200, 'admin', true]); // no photo needed
  assert.equal((await c('/api/admin/dashboard')).status, 200);
  assert.equal((await v('/api/admin/dashboard')).status, 403);
  // Many logins are fine; only wrong passwords are limited.
  for (let i = 0; i < 10; i++) assert.equal((await tryLogin('9000000001', 'test-pass')).status, 200);
  for (let i = 0; i < 7; i++) assert.equal((await tryLogin('9000000001', 'guess')).status, 400); // 8 wrong in all
  assert.equal((await tryLogin('9000000001', 'test-pass')).status, 429);
  // The admin list is fixed; it can't be changed from the app.
  assert.equal((await c('/api/admin/admins', { method: 'POST', body: { phone: '9000000002' } })).status, 404);
  assert.equal((await c('/api/admin/admins')).body.admins.length, 1);
});

test('cross-site requests are blocked', async () => {
  const a = await admin();
  const res = await a('/api/admin/sessions', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: {} });
  assert.equal(res.status, 403);
});

test('admins can create an express pass that is sent at once and valid all day', async () => {
  const a = await admin();
  at(IST('2030-01-10', '07:30')); // before the morning session opens
  const missing = await a('/api/admin/express', { method: 'POST', body: { name: 'Gopal Rao' } });
  assert.equal(missing.status, 400);

  const photo = (await a('/api/admin/photos', { method: 'POST', raw: JPEG })).body.photo;
  assert.equal((await a('/api/admin/express', { method: 'POST', body: { name: 'Gopal Rao', phone: '9845011111', peopleCount: 6 } })).status, 400);
  assert.equal((await a('/api/admin/express', { method: 'POST', body: { name: 'Gopal Rao', phone: '9845011111', referenceId: 'nobody' } })).status, 400);
  const res = await a('/api/admin/express', { method: 'POST', body: { name: 'Gopal Rao', phone: '9845011111', peopleCount: 3, photo, referenceId: 'satish' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const appt = res.body.appointment;
  assert.deepEqual([appt.status, appt.express, appt.peopleCount, appt.period, appt.createdBy, appt.passSent], ['approved', true, 3, 'morning', 'Seva Admin', true]);
  assert.deepEqual([appt.reference, appt.refPhone], ['Satish Vithalani Ji', '+919820029858']);
  assert.ok(appt.photo);
  await flush();
  const pass = sent.filter((x) => x.body?.template?.name === 'entry_pass').at(-1).body;
  assert.equal(pass.to, '919845011111');
  assert.match(templateText(sent.at(-1)), /entry pass for today .* for 3 people\. Entry code: [A-HJ-NP-Z2-9]{6}/);

  // Valid straight away, even before the session opens; still only once.
  const code = db.prepare('SELECT checkin_code FROM appointments WHERE id = ?').get(appt.id).checkin_code;
  const scan = (await a('/api/staff/scan', { method: 'POST', body: { code } })).body;
  assert.deepEqual([scan.result, scan.canAdmit, scan.message], ['ok', true, 'Valid express pass']);
  assert.equal((await a('/api/staff/admit', { method: 'POST', body: { code } })).status, 200);
  assert.equal((await a('/api/staff/scan', { method: 'POST', body: { code } })).body.result, 'used');

  // The person can log in later and sees the pass in the app.
  const gopal = await login('9845011111', { photo: false });
  assert.equal((await gopal('/api/me')).body.appointments[0].express, true);

  // Someone who already has an appointment needs confirmation.
  const v = await visitor();
  await openSessions(a);
  await v('/api/appointments', { method: 'POST', body: booking(await sessionId('2030-01-11', 'morning')) });
  const clash = await a('/api/admin/express', { method: 'POST', body: { name: 'Asha Rao', phone: '9876543210' } });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /already has an appointment on Friday, 11 January \(Morning\)/);
  assert.equal((await a('/api/admin/express', { method: 'POST', body: { name: 'Asha Rao', phone: '9876543210', force: true } })).status, 201);
  // Opening the day later still opens the morning to the public.
  assert.ok((await client()('/api/availability')).body.days.find((d) => d.date === '2030-01-10').sessions.some((x) => x.period === 'morning'));
  // Visitors can't make express passes.
  assert.equal((await v('/api/admin/express', { method: 'POST', body: { name: 'X', phone: '9000099999' } })).status, 403);
});

test('a database from the previous version is upgraded in place', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-')), 'v3.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE appointments (id INTEGER PRIMARY KEY, user_id INTEGER, session_id INTEGER, date TEXT, period TEXT, name TEXT, phone TEXT,
    photo TEXT, reference TEXT NOT NULL, people_count INTEGER, purposes TEXT, description TEXT, status TEXT, admin_note TEXT, reviewed_by INTEGER,
    checkin_code TEXT, checked_in_at TEXT, checked_in_by INTEGER, reminded_day_before INTEGER DEFAULT 0, greeted INTEGER DEFAULT 0, pass_sent_at TEXT,
    created_at TEXT, updated_at TEXT); INSERT INTO appointments (id, reference, name) VALUES (1, 'Kept', 'Old booking'); PRAGMA user_version = 3;`);
  old.close();
  const upgraded = openDatabase(file);
  assert.equal(upgraded.prepare('SELECT reference, express, ref_phone FROM appointments').get().reference, 'Kept');
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 5);
  assert.ok(upgraded.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'reference_id'));
  assert.ok(fs.existsSync(file));
});
