import webpush from 'web-push';
import { getSetting, setSetting } from './db.js';

// Creates in-app notifications and fans them out to live (SSE) connections
// and Web Push subscriptions.
export function createNotifier(db, { vapidSubject }) {
  let publicKey = getSetting(db, 'vapid_public');
  let privateKey = getSetting(db, 'vapid_private');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    setSetting(db, 'vapid_public', publicKey);
    setSetting(db, 'vapid_private', privateKey);
  }
  webpush.setVapidDetails(vapidSubject, publicKey, privateKey);

  const streams = new Map(); // visitorId -> Set<res>

  function addStream(visitorId, res) {
    if (!streams.has(visitorId)) streams.set(visitorId, new Set());
    streams.get(visitorId).add(res);
    return () => {
      const set = streams.get(visitorId);
      set?.delete(res);
      if (set?.size === 0) streams.delete(visitorId);
    };
  }

  async function sendPush(visitorId, payload) {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE visitor_id = ?').all(visitorId);
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload)
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        } else {
          console.warn(`Push to subscription ${s.id} failed:`, err.message);
        }
      }
    }));
  }

  function notify(visitorId, appointmentId, title, body) {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO notifications (visitor_id, appointment_id, title, body) VALUES (?, ?, ?, ?)'
    ).run(visitorId, appointmentId, title, body);
    const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(lastInsertRowid);

    for (const res of streams.get(visitorId) ?? []) {
      res.write(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`);
    }
    // Push delivery is best-effort and must never block the request.
    sendPush(visitorId, { title, body, url: '/my.html' }).catch(() => {});
    return notification;
  }

  return { notify, addStream, publicKey };
}
