import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { phone as parsePhone } from './http.js';
import path from 'node:path';

const env = process.env;
const port = Number(env.PORT || 3000);
const appUrl = (env.APP_URL || `http://localhost:${port}`).replace(/\/$/, '');
const dataDir = env.DATA_DIR || 'data';

const config = {
  timeZone: env.APP_TIMEZONE || 'Asia/Kolkata',
  appUrl,
  secureCookies: appUrl.startsWith('https://'),
  defaultCountryCode: env.DEFAULT_COUNTRY_CODE || '91',
  sessionTimes: env.SESSION_TIMES || undefined,
  reminderTime: env.REMINDER_TIME || '18:00',
  greetingTime: env.GREETING_TIME || '07:00',
  vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  contact: { phone: env.CONTACT_PHONE || null, whatsapp: env.CONTACT_WHATSAPP || null, address: env.CONTACT_ADDRESS || null },
  whatsapp: env.WHATSAPP_TOKEN ? {
    token: env.WHATSAPP_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    otpTemplate: env.WHATSAPP_OTP_TEMPLATE || 'login_code',
    template: env.WHATSAPP_TEMPLATE || 'appointment_update',
    passTemplate: env.WHATSAPP_PASS_TEMPLATE || 'entry_pass',
    language: env.WHATSAPP_TEMPLATE_LANG || 'en',
  } : null,
  photosDir: path.join(dataDir, 'photos'),
  showOtpForTesting: env.SHOW_OTP_ON_SCREEN === '1',
  logOutbound: true,
};
if (config.sessionTimes === undefined) delete config.sessionTimes;

const db = openDatabase(env.DATABASE_FILE || path.join(dataDir, 'appointments.db'));

// The first admin is set by phone number; they log in with a WhatsApp code.
if (env.ADMIN_PHONE) {
  const phone = parsePhone(env.ADMIN_PHONE, config.defaultCountryCode);
  const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!existing) {
    db.prepare("INSERT INTO users (phone, name, role, status) VALUES (?, ?, 'admin', 'active')").run(phone, env.ADMIN_NAME || null);
    console.log(`Admin account ready for ${phone}. Log in with this number at ${appUrl}`);
  } else if (existing.role !== 'admin' || existing.status !== 'active') {
    db.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?").run(existing.id);
    console.log(`Gave admin access to ${phone}`);
  }
}
if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
  console.warn('No admin yet. Set ADMIN_PHONE to your WhatsApp number and restart.');
}
if (!config.whatsapp) {
  console.warn('WhatsApp is not set up yet (WHATSAPP_TOKEN). Messages and login codes will be printed here instead.');
}

const app = createApp({ db, config });
const { jobs, whatsapp } = app.locals;

setInterval(() => {
  try { jobs.run(); } catch (err) { console.error('Scheduled messages failed:', err); }
  whatsapp.kick();
}, 30_000);
jobs.run();
whatsapp.kick();

app.listen(port, () => {
  console.log(`Meet Gurudev is running at ${appUrl}`);
});
