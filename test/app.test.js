import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApp, sendDueReminders } from '../src/app.js';

const TZ = 'Asia/Kolkata';
// 2030-01-10 09:00 in Kolkata (UTC+5:30)
let clock;
let server;
let base;
let db;
let app;

beforeEach(async () => {
  clock = new Date('2030-01-10T03:30:00Z');
  db = openDatabase(':memory:');
  app = createApp({ db, timeZone: TZ, adminPassword: 'secret', now: () => clock });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
});

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function adminToken() {
  const { body } = await call('/api/admin/login', { method: 'POST', body: { password: 'secret' } });
  return { Authorization: `Bearer ${body.token}` };
}

async function createSlots(admin, body) {
  return call('/api/admin/slots', { method: 'POST', headers: admin, body });
}

const visitorDetails = {
  name: 'Asha Rao', phone: '+91 98765 43210', email: 'Asha@example.com', purpose: 'Seeking guidance',
};

test('admin login rejects wrong password and protects admin routes', async () => {
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  assert.equal((await call('/api/admin/appointments')).status, 401);
  const admin = await adminToken();
  assert.equal((await call('/api/admin/appointments', { headers: admin })).status, 200);
});

test('bulk slot creation respects weekdays, duration and gap, and skips duplicates', async () => {
  const admin = await adminToken();
  // 2030-01-10 is a Thursday; only Thursdays and Fridays in a 7 day range.
  const res = await createSlots(admin, {
    fromDate: '2030-01-10', toDate: '2030-01-16', startTime: '10:00', endTime: '11:00',
    duration: 15, gap: 5, weekdays: [4, 5],
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { created: 6, skipped: 0 }); // 10:00, 10:20, 10:40 × 2 days
  const again = await createSlots(admin, { fromDate: '2030-01-10', startTime: '10:00', endTime: '11:00', duration: 15, gap: 5 });
  assert.deepEqual(again.body, { created: 0, skipped: 3 });

  const { body } = await call('/api/slots');
  assert.deepEqual(body.slots.map((s) => `${s.date} ${s.start_time}-${s.end_time}`), [
    '2030-01-10 10:00-10:15', '2030-01-10 10:20-10:35', '2030-01-10 10:40-10:55',
    '2030-01-11 10:00-10:15', '2030-01-11 10:20-10:35', '2030-01-11 10:40-10:55',
  ]);
});

test('past slots are not offered or bookable', async () => {
  const admin = await adminToken();
  await createSlots(admin, { fromDate: '2030-01-10', startTime: '08:00', endTime: '10:00', duration: 60 });
  const { body } = await call('/api/slots');
  assert.deepEqual(body.slots.map((s) => s.start_time), []); // 08:00 passed, 09:00 is now
  const past = db.prepare("SELECT id FROM slots WHERE start_time = '08:00'").get();
  const res = await call('/api/appointments', { method: 'POST', body: { ...visitorDetails, slotId: past.id } });
  assert.equal(res.status, 409);
});

test('booking validates the form', async () => {
  const admin = await adminToken();
  await createSlots(admin, { fromDate: '2030-01-11', startTime: '10:00', endTime: '10:15', duration: 15 });
  const slotId = (await call('/api/slots')).body.slots[0].id;
  for (const [field, value, msg] of [
    ['name', '', /Name is required/],
    ['email', 'not-an-email', /valid email/],
    ['phone', 'abc', /valid phone/],
    ['purpose', '   ', /Purpose of meeting is required/],
  ]) {
    const res = await call('/api/appointments', { method: 'POST', body: { ...visitorDetails, [field]: value, slotId } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, msg);
  }
});

test('full flow: request, hold, approve with notifications, reminders', async () => {
  const admin = await adminToken();
  await createSlots(admin, { fromDate: '2030-01-11', startTime: '10:00', endTime: '10:30', duration: 15 });
  const [slot, other] = (await call('/api/slots')).body.slots;

  const booked = await call('/api/appointments', { method: 'POST', body: { ...visitorDetails, slotId: slot.id } });
  assert.equal(booked.status, 201);
  assert.equal(booked.body.appointment.status, 'pending');
  assert.equal(booked.body.appointment.email, 'asha@example.com');
  const visitor = { 'X-Visitor-Token': booked.body.visitorToken };

  // The requested slot is held and no longer offered to others.
  assert.deepEqual((await call('/api/slots')).body.slots.map((s) => s.id), [other.id]);
  const clash = await call('/api/appointments', { method: 'POST', body: { ...visitorDetails, slotId: slot.id } });
  assert.equal(clash.status, 409);

  let me = (await call('/api/me', { headers: visitor })).body;
  assert.equal(me.appointments.length, 1);
  assert.equal(me.notifications[0].title, 'Request received');
  assert.equal(me.unread, 1);

  const pending = (await call('/api/admin/appointments?status=pending', { headers: admin })).body;
  assert.equal(pending.appointments.length, 1);
  assert.equal(pending.counts.pending, 1);

  const id = booked.body.appointment.id;
  const approved = await call(`/api/admin/appointments/${id}/approve`, {
    method: 'POST', headers: admin, body: { note: 'Bring photo ID' },
  });
  assert.equal(approved.body.appointment.status, 'approved');
  assert.equal((await call(`/api/admin/appointments/${id}/approve`, { method: 'POST', headers: admin })).status, 409);

  me = (await call('/api/me', { headers: visitor })).body;
  assert.equal(me.appointments[0].status, 'approved');
  assert.equal(me.notifications[0].title, 'Appointment confirmed 🙏');
  assert.match(me.notifications[0].body, /Friday, 11 January 2030, 10:00–10:15/);
  assert.match(me.notifications[0].body, /Bring photo ID/);
  assert.equal(me.unread, 2);

  await call('/api/me/notifications/read', { method: 'POST', headers: visitor });
  assert.equal((await call('/api/me', { headers: visitor })).body.unread, 0);

  // Reminders: none yet (25h away), 24h reminder at 23h before, 1h reminder at 50 minutes before.
  const { notifier } = app.locals;
  assert.equal(sendDueReminders({ db, notifier, timeZone: TZ, now: clock }), 0);
  assert.equal(sendDueReminders({ db, notifier, timeZone: TZ, now: new Date('2030-01-10T05:30:00Z') }), 1);
  assert.equal(sendDueReminders({ db, notifier, timeZone: TZ, now: new Date('2030-01-10T05:31:00Z') }), 0);
  assert.equal(sendDueReminders({ db, notifier, timeZone: TZ, now: new Date('2030-01-11T03:40:00Z') }), 1);
  assert.equal(sendDueReminders({ db, notifier, timeZone: TZ, now: new Date('2030-01-11T03:45:00Z') }), 0);
  me = (await call('/api/me', { headers: visitor })).body;
  assert.deepEqual(me.notifications.slice(0, 2).map((n) => n.title), ['Your meeting is in 1 hour', 'Upcoming meeting reminder']);
});

test('declining or cancelling frees the slot and notifies the visitor', async () => {
  const admin = await adminToken();
  await createSlots(admin, { fromDate: '2030-01-11', startTime: '10:00', endTime: '10:15', duration: 15 });
  const slotId = (await call('/api/slots')).body.slots[0].id;

  const first = await call('/api/appointments', { method: 'POST', body: { ...visitorDetails, slotId } });
  await call(`/api/admin/appointments/${first.body.appointment.id}/reject`, { method: 'POST', headers: admin, body: {} });
  const me = (await call('/api/me', { headers: { 'X-Visitor-Token': first.body.visitorToken } })).body;
  assert.equal(me.notifications[0].title, 'Appointment request declined');
  assert.equal((await call('/api/slots')).body.slots.length, 1);

  // The same device books again and keeps its visitor identity.
  const visitor = { 'X-Visitor-Token': first.body.visitorToken };
  const second = await call('/api/appointments', { method: 'POST', headers: visitor, body: { ...visitorDetails, slotId } });
  assert.equal(second.body.visitorToken, first.body.visitorToken);
  const cancel = await call(`/api/me/appointments/${second.body.appointment.id}/cancel`, { method: 'POST', headers: visitor });
  assert.equal(cancel.body.appointment.status, 'cancelled');
  assert.equal((await call('/api/slots')).body.slots.length, 1);

  // Other visitors can't see or cancel someone else's appointment.
  const third = await call('/api/appointments', { method: 'POST', body: { ...visitorDetails, slotId } });
  const res = await call(`/api/me/appointments/${third.body.appointment.id}/cancel`, { method: 'POST', headers: visitor });
  assert.equal(res.status, 404);
});

test('slots with history cannot be deleted but can be blocked', async () => {
  const admin = await adminToken();
  await createSlots(admin, { fromDate: '2030-01-11', startTime: '10:00', endTime: '10:30', duration: 15 });
  const [a, b] = (await call('/api/slots')).body.slots;
  await call('/api/appointments', { method: 'POST', body: { ...visitorDetails, slotId: a.id } });
  assert.equal((await call(`/api/admin/slots/${a.id}`, { method: 'DELETE', headers: admin })).status, 409);
  assert.equal((await call(`/api/admin/slots/${b.id}`, { method: 'PATCH', headers: admin, body: { blocked: true } })).status, 200);
  assert.equal((await call('/api/slots')).body.slots.length, 0);
  assert.equal((await call(`/api/admin/slots/${b.id}`, { method: 'DELETE', headers: admin })).status, 200);
});

test('push subscriptions require a visitor and a valid subscription', async () => {
  const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'k', auth: 'a' } };
  assert.equal((await call('/api/me/push-subscriptions', { method: 'POST', body: sub })).status, 401);
  const admin = await adminToken();
  await createSlots(admin, { fromDate: '2030-01-11', startTime: '10:00', endTime: '10:15', duration: 15 });
  const slotId = (await call('/api/slots')).body.slots[0].id;
  const { body } = await call('/api/appointments', { method: 'POST', body: { ...visitorDetails, slotId } });
  const visitor = { 'X-Visitor-Token': body.visitorToken };
  assert.equal((await call('/api/me/push-subscriptions', { method: 'POST', headers: visitor, body: { endpoint: 'http://x' } })).status, 400);
  assert.equal((await call('/api/me/push-subscriptions', { method: 'POST', headers: visitor, body: sub })).status, 201);
});
