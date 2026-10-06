import crypto from 'node:crypto';
import { openDatabase } from './db.js';
import { createApp, sendDueReminders } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const timeZone = process.env.APP_TIMEZONE ?? 'Asia/Kolkata';
const db = openDatabase(process.env.DATABASE_FILE ?? 'data/appointments.db');

let adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  adminPassword = crypto.randomBytes(9).toString('base64url');
  console.warn(`ADMIN_PASSWORD is not set. Using a temporary admin password for this run: ${adminPassword}`);
}

const app = createApp({ db, timeZone, adminPassword, vapidSubject: process.env.VAPID_SUBJECT });

setInterval(() => {
  try {
    sendDueReminders({ db, notifier: app.locals.notifier, timeZone });
  } catch (err) {
    console.error('Reminder job failed:', err);
  }
}, 60_000);

app.listen(port, () => {
  console.log(`Appointments app running at http://localhost:${port} (timezone ${timeZone})`);
  console.log(`Admin dashboard: http://localhost:${port}/admin.html`);
});
