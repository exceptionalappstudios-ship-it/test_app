import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { REFERENCES, ADMIN_PASSWORD_HASH, hashPassword } from './references.js';
import path from 'node:path';

const env = process.env;
const port = Number(env.PORT || 3000);
// On Railway the public address and the attached volume are filled in automatically.
const appUrl = (env.APP_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`)).replace(/\/$/, '');
const dataDir = env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || 'data';
const onRailway = Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);

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
  // Behind a hosting proxy, trust one hop so rate limits see each visitor's own IP.
  references: REFERENCES,
  adminPasswordHash: env.ADMIN_PASSWORD ? hashPassword(env.ADMIN_PASSWORD) : ADMIN_PASSWORD_HASH,
  trustProxy: env.TRUST_PROXY ? (/^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY) : (onRailway ? 1 : 'loopback'),
};
if (config.sessionTimes === undefined) delete config.sessionTimes;

const db = openDatabase(env.DATABASE_FILE || path.join(dataDir, 'appointments.db'));

// The admins are exactly the people on the reference list (src/references.js).
// They log in with their number and the admin password.
const adminPhones = [];
for (const ref of REFERENCES) {
  for (const ten of ref.phones) {
    const phone = `+${config.defaultCountryCode}${ten}`;
    adminPhones.push(phone);
    const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!existing) {
      db.prepare("INSERT INTO users (phone, name, role, status) VALUES (?, ?, 'admin', 'active')").run(phone, ref.name);
    } else if (existing.role !== 'admin' || existing.status !== 'active' || !existing.name) {
      db.prepare("UPDATE users SET role = 'admin', status = 'active', name = COALESCE(name, ?) WHERE id = ?").run(ref.name, existing.id);
    }
  }
}
const removed = db.prepare(`UPDATE users SET role = 'visitor' WHERE role = 'admin' AND phone NOT IN (${adminPhones.map(() => '?').join(',')}) RETURNING id`).all(...adminPhones);
for (const { id } of removed) db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
console.log(`${adminPhones.length} admins ready. They log in at ${appUrl}/admin.html with their number and the admin password.`);
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

if (onRailway && !env.RAILWAY_VOLUME_MOUNT_PATH && !env.DATA_DIR) {
  console.warn('No Railway volume attached: bookings and photos will be lost on every deploy. Add a volume mounted at /data.');
}

app.listen(port, () => {
  console.log(`Meet Gurudev is running at ${appUrl}`);
});
