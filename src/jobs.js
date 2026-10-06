import { nowInTimezone, minutesUntil, addDays, formatSlot } from './time.js';

// Sends "tomorrow", "in one hour" and "your entry pass is ready" notifications
// for approved appointments. Runs every minute.
export function sendDueReminders({ db, notifier, config, now = new Date() }) {
  const { timeZone, qrLeadMinutes } = config;
  const today = nowInTimezone(timeZone, now).date;
  const upcoming = db.prepare(`
    SELECT a.*, s.date, s.start_time, s.end_time FROM appointments a JOIN slots s ON s.id = a.slot_id
    WHERE a.status = 'approved' AND a.checked_in_at IS NULL
      AND (a.reminded_24h = 0 OR a.reminded_1h = 0 OR a.reminded_qr = 0)
      AND s.date BETWEEN ? AND ?
  `).all(addDays(today, -1), addDays(today, 2));

  const mark = db.prepare('UPDATE appointments SET reminded_24h = ?, reminded_1h = ?, reminded_qr = ? WHERE id = ?');
  let sent = 0;
  for (const a of upcoming) {
    const mins = minutesUntil(a.date, a.start_time, timeZone, now);
    if (mins <= -15) continue;
    if (mins <= qrLeadMinutes && !a.reminded_qr) {
      mark.run(1, 1, 1, a.id);
      notifier.notify(a.user_id, a.id, 'Your entry pass is ready 🎟️',
        `Your meeting with Gurudev starts at ${a.start_time}. Open the app and show your QR code at the entrance.`,
        { path: `#/pass/${a.id}` });
      sent++;
    } else if (mins > qrLeadMinutes && mins <= 60 && !a.reminded_1h) {
      mark.run(1, 1, 0, a.id);
      notifier.notify(a.user_id, a.id, 'Your meeting is in 1 hour',
        `Reminder: your meeting with Gurudev starts at ${a.start_time} today. Your entry QR code will appear in the app ${qrLeadMinutes} minutes before.`);
      sent++;
    } else if (mins > 60 && mins <= 24 * 60 && !a.reminded_24h) {
      mark.run(1, 0, 0, a.id);
      notifier.notify(a.user_id, a.id, 'Upcoming meeting reminder', `Reminder: your meeting with Gurudev is on ${formatSlot(a)}.`);
      sent++;
    }
  }
  return sent;
}
