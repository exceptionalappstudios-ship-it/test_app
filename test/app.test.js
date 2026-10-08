import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

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
  if (name) await c('/api/auth/me', { method: 'PATCH', body: { name } });
  if (photo) await c('/api/auth/me/photo', { method: 'POST', raw: JPEG });
  return c;
}

const admin = () => login('+919000000001');
const visitor = (phone = '9876543210', name = 'Asha Rao') => login(phone, { name });

async function openSessions(a, body = {}) {
  return a('/api/admin/sessions', { method: 'POST', body: { fromDate: '2030-01-10', toDate: '2030-01-12', periods: ['morning', 'afternoon', 'evening'], capacity: 20, ...body } });
}
const sessionId = async (date, period) => (await client()('/api/availability')).body.days.find((d) => d.date === date)?.sessions.find((s) => s.period === period)?.id;

const booking = (sessionIdValue, extra = {}) => ({
  sessionId: sessionIdValue, reference: 'Swami Ji', refPhone: '9988776655', refDesignation: 'Centre coordinator, Bengaluru', peopleCount: 1, people: [],
  purposes: ['blessings'], description: 'Blessings for my family', ...extra,
});

// ---------------------------------------------------------------------------------

test('logging in with a WhatsApp code creates an account that must add name and photo', async () => {
  const c = client();
  const req = await c('/api/auth/otp/request', { method: 'POST', body: { phone: '098765 43210' } });
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
  const s = await login('9811111111', { signupAs: 'security', name: 'Ramesh Guard' });
  assert.deepEqual([(await s('/api/auth/me')).body.user.role, (await s('/api/auth/me')).body.user.status], ['security', 'pending']);
  assert.equal((await s('/api/staff/scan', { method: 'POST', body: { code: 'x' } })).status, 403);
  assert.equal((await s('/api/admin/dashboard')).status, 403);

  const a = await admin();
  assert.equal((await a('/api/admin/dashboard')).body.summary.securityPending, 1);
  const list = (await a('/api/admin/security?q=ramesh')).body.staff;
  assert.equal(list.length, 1);
  assert.equal((await a('/api/admin/security?q=98111')).body.staff.length, 1);
  await a(`/api/admin/security/${list[0].id}/approve`, { method: 'POST' });
  assert.equal((await s('/api/staff/scan', { method: 'POST', body: { code: 'nope' } })).status, 404);
  await a(`/api/admin/security/${list[0].id}/revoke`, { method: 'POST' });
  assert.equal((await s('/api/staff/scan', { method: 'POST', body: { code: 'nope' } })).status, 403);
  // Logging in again keeps the existing role; signupAs only applies to new numbers.
  const again = await login('9811111111', { signupAs: 'visitor' });
  assert.equal((await again('/api/auth/me')).body.user.role, 'security');
});

test('availability shows sessions without times and hides ended or full ones', async () => {
  const a = await admin();
  assert.deepEqual((await openSessions(a)).body, { created: 9, skipped: 0 });
  at(IST('2030-01-10', '14:00')); // morning has ended today
  const { days } = (await client()('/api/availability')).body;
  assert.deepEqual(days[0].sessions.map((s) => s.label), ['Afternoon', 'Evening']);
  assert.equal(days[0].sessions[0].start, undefined);
  assert.equal(days.length, 3);
  const sid = days[0].sessions[0].id;
  await a(`/api/admin/sessions/${sid}`, { method: 'PATCH', body: { closed: true } });
  assert.deepEqual((await client()('/api/availability')).body.days[0].sessions.map((s) => s.label), ['Evening']);
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
  await bad({ reference: '' }, /referred you/);
  await bad({ refPhone: '' }, /reference's phone number/);
  await bad({ refDesignation: '' }, /designation/);
  await bad({ purposes: [] }, /purpose/);
  await bad({ purposes: ['other'], description: '' }, /few words/);
  await bad({ peopleCount: 11 }, /between 1 and 10/);
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
  assert.deepEqual([appt.reference, appt.refPhone, appt.refDesignation], ['Swami Ji', '+919988776655', 'Centre coordinator, Bengaluru']);
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

test('hold, approve, reminders, greeting, QR pass at session start, scan once', async () => {
  const a = await admin();
  await openSessions(a);
  const sid = await sessionId('2030-01-11', 'afternoon');
  const v = await visitor();
  const appt = (await v('/api/appointments', { method: 'POST', body: booking(sid, { peopleCount: 2, people: [{ name: 'Meera Rao', phone: '9123456780' }] }) })).body.appointment;

  await a(`/api/admin/appointments/${appt.id}/hold`, { method: 'POST', body: {} });
  assert.equal((await a('/api/admin/appointments?status=hold')).body.appointments.length, 1);
  assert.equal((await a('/api/admin/appointments?status=pending')).body.appointments.length, 0);
  await a(`/api/admin/appointments/${appt.id}/approve`, { method: 'POST', body: { note: 'Please bring an ID card' } });
  await flush();
  const confirm = templateText(messagesTo('+919876543210').at(-1));
  assert.match(confirm, /Appointment confirmed/);
  assert.match(confirm, /QR entry pass will be sent on WhatsApp on Friday, 11 January at 1:00 PM/);
  assert.doesNotMatch(confirm, /\n/);

  const pass = async () => (await v(`/api/me/appointments/${appt.id}/pass`)).body.pass;
  assert.equal((await pass()).state, 'not_yet');
  assert.equal((await pass()).code, undefined);

  const { jobs } = app.locals;
  const runAt = async (date, time) => { at(IST(date, time)); const n = jobs.run(); await flush(); return n; };
  assert.equal(await runAt('2030-01-10', '17:59'), 0);
  assert.equal(await runAt('2030-01-10', '18:00'), 1);      // day before
  assert.match(templateText(messagesTo('+919876543210').at(-1)), /tomorrow/);
  assert.equal(await runAt('2030-01-11', '06:59'), 0);
  assert.equal(await runAt('2030-01-11', '07:00'), 1);      // greeting
  assert.match(templateText(messagesTo('+919876543210').at(-1)), /Today is your visit.*1:00 PM/);
  assert.equal(await runAt('2030-01-11', '12:59'), 0);

  // Security can't let them in before the afternoon opens; an admin can.
  const sRes = await login('9811111111', { signupAs: 'security', name: 'Ramesh Guard' });
  const sid2 = (await a('/api/admin/security')).body.staff[0].id;
  await a(`/api/admin/security/${sid2}/approve`, { method: 'POST' });
  const code = db.prepare('SELECT checkin_code FROM appointments WHERE id = ?').get(appt.id).checkin_code;
  const early = (await sRes('/api/staff/scan', { method: 'POST', body: { code } })).body;
  assert.deepEqual([early.result, early.canAdmit, early.adminOverride], ['early', false, undefined]);
  assert.match(early.message, /Afternoon passes open at 1:00 PM/);
  assert.equal((await sRes('/api/staff/admit', { method: 'POST', body: { code } })).status, 409);

  assert.equal(await runAt('2030-01-11', '13:00'), 1);      // the pass
  const passMsg = sent.filter((s) => s.body?.template?.name === 'entry_pass').at(-1).body;
  assert.equal(passMsg.to, '919876543210');
  assert.equal(passMsg.template.components[0].parameters[0].image.id, 'media-1');
  assert.match(templateText(sent.at(-1)), /valid only today and can be scanned only once/);
  assert.equal(await runAt('2030-01-11', '13:01'), 0);

  const ready = await pass();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.code, code);
  assert.match(ready.svg, /^<svg/);

  const scan = (await sRes('/api/staff/scan', { method: 'POST', body: { code } })).body;
  assert.deepEqual([scan.result, scan.canAdmit, scan.appointment.name, scan.appointment.peopleCount], ['ok', true, 'Asha Rao', 2]);
  assert.equal(scan.appointment.people[0].name, 'Meera Rao');
  assert.ok(scan.appointment.photo);
  assert.equal((await sRes(scan.appointment.photo)).status, 200);
  assert.equal((await sRes('/api/staff/admit', { method: 'POST', body: { code } })).status, 200);

  const again = (await sRes('/api/staff/scan', { method: 'POST', body: { code } })).body;
  assert.deepEqual([again.result, again.canAdmit, again.appointment.checkedInBy], ['used', false, 'Ramesh Guard']);
  assert.match(again.message, /Already checked in/);
  assert.equal((await sRes('/api/staff/admit', { method: 'POST', body: { code } })).status, 409);
  assert.equal((await pass()).state, 'checked_in');
  assert.equal((await sRes('/api/staff/recent')).body.people, 2);

  // The next day the pass is no longer valid.
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

test('approving on the day skips the reminders and sends the pass right away', async () => {
  const a = await admin();
  await openSessions(a);
  const sid = await sessionId('2030-01-10', 'morning'); // it is 09:00, morning is open
  const v = await visitor();
  const appt = (await v('/api/appointments', { method: 'POST', body: booking(sid) })).body.appointment;
  await a(`/api/admin/appointments/${appt.id}/approve`, { method: 'POST', body: {} });
  assert.equal(app.locals.jobs.run(), 1);
  await flush();
  const titles = sent.filter((s) => s.body?.to === '919876543210' && s.body.template.name !== 'login_code').map((s) => s.body.template.components.at(-1).parameters[0].text);
  assert.deepEqual(titles, ['Request received 🙏', 'Appointment confirmed ✅', 'Your entry pass 🎟️']);
});

test('dashboard, date list with search, and who checked people in', async () => {
  const a = await admin();
  await openSessions(a);
  const morning = await sessionId('2030-01-10', 'morning');
  const evening = await sessionId('2030-01-10', 'evening');
  const v1 = await visitor('9800000001', 'Asha Rao');
  const v2 = await visitor('9800000002', 'Ravi Kumar');
  const a1 = (await v1('/api/appointments', { method: 'POST', body: booking(morning, { peopleCount: 3, people: [{ name: 'A', phone: '9700000001' }, { name: 'B', phone: '9700000002' }] }) })).body.appointment;
  const a2 = (await v2('/api/appointments', { method: 'POST', body: booking(evening, { refDesignation: 'Teacher, Mysuru' }) })).body.appointment;
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
  assert.deepEqual(d.sessions.map((x) => [x.label, x.people, x.checkedInPeople]), [['Morning', 3, 3], ['Afternoon', 0, 0], ['Evening', 1, 0]]);
  assert.equal(d.recent[0].checkedInBy, 'Ramesh Guard');
  assert.equal(d.days.find((x) => x.date === '2030-01-10').checkedIn, 3);

  const list = (await a('/api/admin/appointments?date=2030-01-10')).body;
  assert.deepEqual([list.stats.approved, list.stats.checkedIn, list.stats.remaining, list.stats.remainingPeople], [2, 1, 1, 1]);
  assert.equal((await a('/api/admin/appointments?date=2030-01-10&checked=out')).body.appointments[0].name, 'Ravi Kumar');
  assert.equal((await a('/api/admin/appointments?date=2030-01-10&q=98000 00002')).body.appointments[0].name, 'Ravi Kumar');
  assert.equal((await a('/api/admin/appointments?date=2030-01-10&q=bengaluru')).body.appointments.length, 1);
  assert.equal((await a('/api/admin/appointments?date=2030-01-10&q=swami')).body.appointments.length, 2);
});

test('admins can message everyone visiting on a day', async () => {
  const a = await admin();
  await openSessions(a);
  const sid = await sessionId('2030-01-11', 'morning');
  for (const [p, n] of [['9800000001', 'Asha'], ['9800000002', 'Ravi']]) {
    const v = await visitor(p, n);
    const appt = (await v('/api/appointments', { method: 'POST', body: booking(sid) })).body.appointment;
    await a(`/api/admin/appointments/${appt.id}/approve`, { method: 'POST', body: {} });
  }
  const res = await a('/api/admin/broadcast', { method: 'POST', body: { date: '2030-01-11', message: 'Venue changed to Hall B.' } });
  assert.equal(res.body.recipients, 2);
  await flush();
  const broadcasts = sent.filter((s) => s.body?.template && templateText(s).includes('Hall B'));
  assert.equal(broadcasts.length, 2);
  assert.equal((await a('/api/admin/broadcasts?date=2030-01-11')).body.broadcasts[0].recipients, 2);
  assert.equal((await a('/api/admin/broadcast', { method: 'POST', body: { date: '2030-01-20', message: 'x' } })).status, 400);
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

test('admins are added by phone number and can be removed', async () => {
  const a = await admin();
  const added = await a('/api/admin/admins', { method: 'POST', body: { phone: '9000000002', name: 'Second Admin' } });
  assert.equal(added.body.admin.role, 'admin');
  const second = await login('9000000002');
  assert.equal((await second('/api/auth/me')).body.user.role, 'admin');
  assert.equal((await a(`/api/admin/admins/${added.body.admin.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await second('/api/admin/dashboard')).status, 401);
  const me = (await a('/api/auth/me')).body.user;
  assert.equal((await a(`/api/admin/admins/${me.id}`, { method: 'DELETE' })).status, 400);
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
  const res = await a('/api/admin/express', { method: 'POST', body: { name: 'Gopal Rao', phone: '9845011111', peopleCount: 3, photo } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const appt = res.body.appointment;
  assert.deepEqual([appt.status, appt.express, appt.peopleCount, appt.period, appt.createdBy, appt.passSent], ['approved', true, 3, 'morning', 'Seva Admin', true]);
  assert.ok(appt.photo);
  await flush();
  const pass = sent.filter((x) => x.body?.template?.name === 'entry_pass').at(-1).body;
  assert.equal(pass.to, '919845011111');
  assert.match(templateText(sent.at(-1)), /express pass for today/);

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
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 4);
  assert.ok(fs.existsSync(file));
});
