import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChannels } from './channels.js';
import { createNotifier } from './notify.js';
import { sessionMiddleware } from './auth.js';
import { HttpError } from './http.js';
import { authRoutes } from './routes/auth.js';
import { visitorRoutes } from './routes/visitor.js';
import { adminRoutes } from './routes/admin.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CONFIG = {
  timeZone: 'Asia/Kolkata',
  appUrl: 'http://localhost:3000',
  secureCookies: false,
  defaultCountryCode: '91',
  qrLeadMinutes: 10,         // QR entry pass appears this long before the meeting
  checkinEarlyMinutes: 30,   // admitting earlier than this needs an override
  checkinGraceMinutes: 60,   // pass stays valid this long after the slot ends
  maxActivePerUser: 3,
  vapidSubject: 'mailto:admin@example.com',
  adminNotifyEmail: null,
  contact: { phone: null, whatsapp: null, email: null, address: null },
  smtp: null,
  whatsapp: null,
  logOutbound: false,
};

// Rejects state-changing requests coming from other websites.
function sameOriginOnly(req, _res, next) {
  const origin = req.get('origin');
  if (req.method === 'GET' || !origin) return next();
  let host = null;
  try { host = new URL(origin).host; } catch { /* "null" or malformed */ }
  if (host !== req.get('host')) {
    return next(new HttpError(403, 'Cross-site request blocked'));
  }
  next();
}

export function createApp({ db, config: overrides = {}, now = () => new Date() }) {
  const config = { ...DEFAULT_CONFIG, ...overrides, contact: { ...DEFAULT_CONFIG.contact, ...overrides.contact } };
  const channels = createChannels(db, config);
  const notifier = createNotifier(db, { vapidSubject: config.vapidSubject, channels, appUrl: config.appUrl });
  const ctx = { db, notifier, config, now };

  const app = express();
  app.set('trust proxy', 'loopback');
  app.locals.notifier = notifier;
  app.locals.config = config;

  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(ROOT, 'public')));
  app.get('/vendor/jsQR.js', (_req, res) => res.sendFile(path.join(ROOT, 'node_modules/jsqr/dist/jsQR.js')));

  app.use('/api', sameOriginOnly, sessionMiddleware(db));
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));
  app.use('/api', visitorRoutes(ctx));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use((err, _req, res, _next) => {
    const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  return app;
}
