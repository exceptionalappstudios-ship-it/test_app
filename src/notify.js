import webpush from 'web-push';
import { getSetting, setSetting } from './db.js';

// Delivers updates to people: the in-app feed, live connections (SSE), Web
// Push and WhatsApp. Also carries the staff event stream that keeps admin
// dashboards and the security screen current.
export function createNotifier(db, { vapidSubject, whatsapp }) {
  let publicKey = getSetting(db, 'vapid_public');
  let privateKey = getSetting(db, 'vapid_private');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    setSetting(db, 'vapid_public', publicKey);
    setSetting(db, 'vapid_private', privateKey);
  }
  webpush.setVapidDetails(vapidSubject, publicKey, privateKey);

  const userStreams = new Map(); // userId -> Set<res>
  const staffStreams = new Set();
  const insertNotification = db.prepare(
    'INSERT INTO notifications (user_id, appointment_id, title, body) VALUES (?, ?, ?, ?) RETURNING *'
  );
  const userPhone = db.prepare('SELECT phone FROM users WHERE id = ?');
  const subscriptions = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Live connections are capped (each holds a socket open): 5 per person, and
  // a total well above 1,000 visitors plus staff.
  const MAX_STREAMS = 10000;
  const MAX_PER_PERSON = 5;
  let streamCount = 0;
  function openStream(req, res, set, key) {
    if (streamCount >= MAX_STREAMS) return res.status(503).json({ error: 'Busy, please retry' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    let streams = set;
    if (key !== undefined) {
      if (!userStreams.has(key)) userStreams.set(key, new Set());
      streams = userStreams.get(key);
    }
    // The oldest connection of this person is closed to make room.
    if (key !== undefined && streams.size >= MAX_PER_PERSON) {
      const oldest = streams.values().next().value;
      streams.delete(oldest);
      oldest.destroy();
    }
    streams.add(res);
    streamCount++;
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    let closed = false;
    res.on('close', () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      streamCount--;
      streams.delete(res);
      if (key !== undefined && streams.size === 0 && userStreams.get(key) === streams) userStreams.delete(key);
    });
  }

  const emitToUser = (userId, event, data = {}) => { for (const res of userStreams.get(userId) ?? []) send(res, event, data); };

  // Tells open admin and security screens that something changed. Clients
  // refresh at most every couple of seconds, so a rush of check-ins is cheap.
  const emitToStaff = (kind, data = {}) => { for (const res of staffStreams) send(res, 'changed', { kind, ...data }); };

  async function sendPush(userId, payload) {
    await Promise.all(subscriptions.all(userId).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { timeout: 5000, TTL: 86400 });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      }
    }));
  }

  // In-app notification + live update + push, and WhatsApp to `phone`
  // (the user's own number unless given; false to skip WhatsApp).
  function notify(userId, appointmentId, title, body, { phone, kind = 'update', path = '#/visit' } = {}) {
    const notification = insertNotification.get(userId, appointmentId, title, body);
    emitToUser(userId, 'notification', notification);
    sendPush(userId, { title, body, url: `/${path}` }).catch(() => {});
    if (phone !== false) whatsapp.sendUpdate(phone ?? userPhone.get(userId).phone, title, body, kind);
    return notification;
  }

  // The entry pass: in-app notification plus a WhatsApp message with the
  // entry code and a link to the pass page (not the QR image itself).
  // `appBody` is a shorter text for the app, where the pass is one tap away.
  function sendPass(appt, title, body, appBody = body) {
    const notification = insertNotification.get(appt.user_id, appt.id, title, appBody);
    emitToUser(appt.user_id, 'notification', notification);
    sendPush(appt.user_id, { title, body: appBody, url: '/#/visit' }).catch(() => {});
    whatsapp.sendPass(appt.phone, appt.pass_token, title, body);
  }

  // A phone alert only (no in-app message), e.g. telling an admin about a new request.
  const pushOnly = (userId, title, body, url) => sendPush(userId, { title, body, url }).catch(() => {});

  return {
    notify, sendPass, pushOnly, emitToUser, emitToStaff, publicKey,
    openUserStream: (req, res, userId) => openStream(req, res, null, userId),
    openStaffStream: (req, res) => openStream(req, res, staffStreams),
  };
}
