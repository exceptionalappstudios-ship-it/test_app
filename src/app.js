import express from 'express';
import { REFERENCES } from './references.js';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWhatsApp } from './whatsapp.js';
import { createNotifier } from './notify.js';
import { createPhotoStore } from './photos.js';
import { createJobs } from './jobs.js';
import { sessionMiddleware } from './auth.js';
import { HttpError } from './http.js';
import { parsePeriodTimes, formatDay, formatVisit } from './time.js';
import QRCode from 'qrcode';
import { renderPassPage } from './passPage.js';
import { passState } from './appointments.js';
import { authRoutes, photoRoutes } from './routes/auth.js';
import { visitorRoutes } from './routes/visitor.js';
import { staffRoutes } from './routes/staff.js';
import { adminRoutes } from './routes/admin.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CONFIG = {
  timeZone: 'Asia/Kolkata',
  appUrl: 'http://localhost:3000',
  secureCookies: false,
  defaultCountryCode: '91',
  sessionTimes: '08:00-13:00,16:00-20:00',
  reminderTime: '18:00',     // day-before reminder
  greetingTime: '07:00',     // greeting on the visit day
  vapidSubject: 'mailto:admin@example.com',
  contact: { phone: null, whatsapp: null, address: null },
  whatsapp: null,
  photosDir: null,           // null keeps photos in memory (tests)
  showOtpForTesting: false,
  logOutbound: false,
  trustProxy: 'loopback',
  references: REFERENCES,
  adminPasswordHash: null,   // null turns off password login (tests set their own)
};

// Rejects state-changing requests coming from other websites.
function sameOriginOnly(req, _res, next) {
  const origin = req.get('origin');
  if (req.method === 'GET' || !origin) return next();
  let host = null;
  try { host = new URL(origin).host; } catch { /* "null" or malformed */ }
  next(host === req.get('host') ? undefined : new HttpError(403, 'Cross-site request blocked'));
}

export function createApp({ db, config: overrides = {}, now = () => new Date() }) {
  const config = { ...DEFAULT_CONFIG, ...overrides, contact: { ...DEFAULT_CONFIG.contact, ...overrides.contact } };
  config.periods = parsePeriodTimes(config.sessionTimes);
  const whatsapp = createWhatsApp(db, config);
  const notifier = createNotifier(db, { vapidSubject: config.vapidSubject, whatsapp });
  const photos = createPhotoStore(config.photosDir);
  const jobs = createJobs({ db, notifier, config, now });
  const ctx = { db, whatsapp, notifier, photos, jobs, config, now };

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.locals = Object.assign(app.locals, ctx);

  // Compress everything except live event streams.
  app.use(compression({ filter: (req, res) => !req.path.endsWith('/stream') && compression.filter(req, res) }));
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0, etag: true }));
  const vendor = (file) => (_req, res) => res.sendFile(path.join(ROOT, 'node_modules', file), { maxAge: '30d' });
  app.get('/vendor/jsQR.js', vendor('jsqr/dist/jsQR.js'));
  app.get('/vendor/face-api.js', vendor('@vladmandic/face-api/dist/face-api.esm.js'));
  app.get('/vendor/face-model/:file', (req, res, next) => {
    if (!/^tiny_face_detector_model(-weights_manifest\.json|\.bin)$/.test(req.params.file)) return next();
    vendor(`@vladmandic/face-api/model/${req.params.file}`)(req, res);
  });

  // Used by the hosting platform to check the app is up.
  const ping = db.prepare('SELECT 1');
  app.get('/healthz', (_req, res) => { ping.get(); res.type('text').send('ok'); });

  // The pass link sent on WhatsApp. Works without logging in; the link's
  // secret part is long and random, and the page is never cached.
  const byToken = db.prepare(`SELECT a.*, u.name AS checked_in_by_name FROM appointments a LEFT JOIN users u ON u.id = a.checked_in_by WHERE a.pass_token = ?`);
  app.get('/p/:token', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:" });
    const a = /^[\w-]{16,40}$/.test(req.params.token) ? byToken.get(req.params.token) : null;
    if (!a) return res.status(404).send(renderPassPage({ state: 'missing' }));
    const pass = passState(a, { timeZone: config.timeZone, now: now() });
    res.send(renderPassPage({
      state: pass.state, name: a.name, visit: formatVisit(a), people: a.people_count, code: a.checkin_code, express: Boolean(a.express),
      qrSvg: pass.state === 'ready' ? await QRCode.toString(a.checkin_code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : '',
      validText: pass.today ? 'Valid today' : `Valid on ${formatDay(a.date)}`,
      checkedInTime: a.checked_in_at ? new Date(a.checked_in_at.replace(' ', 'T') + 'Z').toLocaleTimeString('en-IN', { timeZone: config.timeZone, hour: 'numeric', minute: '2-digit' }) : '',
    }));
  });

  app.use('/api', sameOriginOnly, sessionMiddleware(db));
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/photos', photoRoutes(ctx));
  app.use('/api/staff', staffRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));
  app.use('/api', visitorRoutes(ctx));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use((err, _req, res, _next) => {
    const status = err.status ?? err.statusCode ?? (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    const message = status === 413 ? 'This photo is too large. Please try another one.' : status >= 500 ? 'Something went wrong. Please try again.' : err.message;
    res.status(status).json({ error: message, ...err.extra });
  });

  return app;
}
