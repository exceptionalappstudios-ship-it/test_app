import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { sendDueReminders } from './jobs.js';
import { createUser } from './auth.js';

const env = process.env;
const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));
const port = num(env.PORT, 3000);
const appUrl = (env.APP_URL ?? `http://localhost:${port}`).replace(/\/$/, '');

const config = {
  timeZone: env.APP_TIMEZONE ?? 'Asia/Kolkata',
  appUrl,
  secureCookies: appUrl.startsWith('https://'),
  defaultCountryCode: env.DEFAULT_COUNTRY_CODE ?? '91',
  qrLeadMinutes: num(env.QR_LEAD_MINUTES, 10),
  maxActivePerUser: num(env.MAX_ACTIVE_APPOINTMENTS, 3),
  vapidSubject: env.VAPID_SUBJECT ?? (env.SMTP_FROM_EMAIL ? `mailto:${env.SMTP_FROM_EMAIL}` : 'mailto:admin@example.com'),
  adminNotifyEmail: env.ADMIN_NOTIFY_EMAIL || null,
  contact: {
    phone: env.CONTACT_PHONE || null,
    whatsapp: env.CONTACT_WHATSAPP || null,
    email: env.CONTACT_EMAIL || null,
    address: env.CONTACT_ADDRESS || null,
  },
  smtp: env.SMTP_HOST ? {
    host: env.SMTP_HOST,
    port: num(env.SMTP_PORT, 587),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM ?? env.SMTP_USER,
  } : null,
  whatsapp: env.WHATSAPP_TOKEN ? {
    token: env.WHATSAPP_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    template: env.WHATSAPP_TEMPLATE ?? 'appointment_update',
    language: env.WHATSAPP_TEMPLATE_LANG ?? 'en',
  } : null,
  logOutbound: true,
};

const db = openDatabase(env.DATABASE_FILE ?? 'data/appointments.db');

// First admin account comes from the environment; more can be added in the app.
if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
  const email = env.ADMIN_EMAIL.trim().toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!existing) {
    createUser(db, { name: env.ADMIN_NAME ?? 'Admin', email, phone: env.ADMIN_PHONE ?? '', password: env.ADMIN_PASSWORD, role: 'admin' });
    console.log(`Created admin account ${email}`);
  } else if (existing.role !== 'admin') {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
    console.log(`Gave admin access to ${email}`);
  }
}
if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
  console.warn('No admin account yet. Start with ADMIN_EMAIL and ADMIN_PASSWORD set to create one.');
}
if (!config.smtp) console.warn('Email is not configured (SMTP_HOST); emails will be printed here instead.');
if (!config.whatsapp) console.warn('WhatsApp is not configured (WHATSAPP_TOKEN); messages will be printed here instead.');

const app = createApp({ db, config });

setInterval(() => {
  try {
    sendDueReminders({ db, notifier: app.locals.notifier, config: app.locals.config });
  } catch (err) {
    console.error('Reminder job failed:', err);
  }
}, 60_000);

app.listen(port, () => {
  console.log(`Appointments app running at ${appUrl} (timezone ${config.timeZone})`);
  console.log(`Admin app: ${appUrl}/admin.html`);
});
