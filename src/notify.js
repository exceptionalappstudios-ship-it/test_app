import webpush from 'web-push';
import { getSetting, setSetting } from './db.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fans a notification out to every channel: the in-app feed, live (SSE)
// connections, Web Push, email and WhatsApp. Also carries the admin event
// stream that keeps the live dashboard current.
export function createNotifier(db, { vapidSubject, channels, appUrl }) {
  let publicKey = getSetting(db, 'vapid_public');
  let privateKey = getSetting(db, 'vapid_private');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    setSetting(db, 'vapid_public', publicKey);
    setSetting(db, 'vapid_private', privateKey);
  }
  webpush.setVapidDetails(vapidSubject, publicKey, privateKey);

  const userStreams = new Map(); // userId -> Set<res>
  const adminStreams = new Set();
  const pending = new Set(); // in-flight deliveries, so tests can await them

  function track(promise) {
    const p = promise.catch((err) => console.warn('Delivery failed:', err.message)).finally(() => pending.delete(p));
    pending.add(p);
  }

  function addUserStream(userId, res) {
    if (!userStreams.has(userId)) userStreams.set(userId, new Set());
    userStreams.get(userId).add(res);
    return () => {
      const set = userStreams.get(userId);
      set?.delete(res);
      if (set?.size === 0) userStreams.delete(userId);
    };
  }

  function addAdminStream(res) {
    adminStreams.add(res);
    return () => adminStreams.delete(res);
  }

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function emitToUser(userId, event, data) {
    for (const res of userStreams.get(userId) ?? []) send(res, event, data);
  }

  // Tells open admin screens that something changed (booking, approval,
  // check-in, message) so dashboards and lists refresh immediately.
  function emitToAdmins(kind, data = {}) {
    for (const res of adminStreams) send(res, 'changed', { kind, ...data });
  }

  async function sendPush(userId, payload) {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload)
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        }
      }
    }));
  }

  function emailHtml(title, body, link) {
    return `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px;color:#2b2118">
      <h2 style="color:#c2620f;margin:0 0 12px">${escapeHtml(title)}</h2>
      <p style="white-space:pre-wrap;line-height:1.5">${escapeHtml(body)}</p>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#d9731a;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600">Open the app</a></p>
    </div>`;
  }

  // Creates an in-app notification for a user and delivers it on every channel.
  // `path` is where the app should open when the notification is tapped.
  function notify(userId, appointmentId, title, body, { path = '#/appointments', email = true, whatsapp = true } = {}) {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO notifications (user_id, appointment_id, title, body) VALUES (?, ?, ?, ?)'
    ).run(userId, appointmentId, title, body);
    const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(lastInsertRowid);
    emitToUser(userId, 'notification', notification);

    const url = `/${path}`;
    const link = `${appUrl}${url}`;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    track(sendPush(userId, { title, body, url }));
    if (email) track(channels.sendEmail(user.email, title, `${body}\n\n${link}`, emailHtml(title, body, link)));
    if (whatsapp) track(channels.sendWhatsApp(user.phone, title, body));
    return notification;
  }

  return {
    notify, emitToUser, emitToAdmins, addUserStream, addAdminStream, publicKey,
    sendEmail: (...args) => track(channels.sendEmail(...args)),
    settle: () => Promise.all([...pending]),
  };
}
