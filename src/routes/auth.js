import express from 'express';
import { issueOtp, checkOtp, publicUser, startSession, endSession, requireUser } from '../auth.js';
import { HttpError, text, phone as parsePhone, rateLimiter } from '../http.js';
import { checkPassword, findReference, referenceAdminIds } from '../references.js';

export function authRoutes({ db, whatsapp, notifier, config, photos }) {
  const router = express.Router();
  const perPhone = rateLimiter({ max: 5, windowMs: 60 * 60_000, message: 'Too many codes requested for this number. Please try again in an hour.' });
  const perIp = rateLimiter({ max: 30, windowMs: 60 * 60_000 });
  // Each code is a paid WhatsApp message: cap per number per day and overall.
  const perPhoneDay = rateLimiter({ max: 10, windowMs: 24 * 60 * 60_000, message: 'Too many codes requested for this number today. Please try again tomorrow.' });
  const overall = rateLimiter({ max: 600, windowMs: 60 * 60_000, message: 'Too many people are logging in right now. Please try again in a few minutes.' });
  const verifyLimit = rateLimiter({ max: 20, windowMs: 15 * 60_000 });
  const findByPhone = db.prepare('SELECT * FROM users WHERE phone = ?');

  // Step 1: send a 6-digit code to the WhatsApp number.
  router.post('/otp/request', (req, res) => {
    const phone = parsePhone(req.body?.phone, config.defaultCountryCode);
    perIp(req.ip);
    perPhone(phone);
    perPhoneDay(phone);
    overall('all');
    const user = findByPhone.get(phone);
    if (user?.role === 'admin') throw new HttpError(400, 'This is an admin number. Please log in on the admin page with your password.');
    const code = issueOtp(db, phone);
    whatsapp.sendOtp(phone, code);
    res.json({
      phone,
      isNew: !user,
      // Only for trying the app locally without WhatsApp set up.
      ...(config.showOtpForTesting && !whatsapp.configured ? { testCode: code } : {}),
    });
  });

  // Step 2: check the code. New numbers get an account here; `signupAs`
  // decides whether it's a visitor or a security staff account.
  router.post('/otp/verify', (req, res) => {
    const phone = parsePhone(req.body?.phone, config.defaultCountryCode);
    verifyLimit(`${req.ip}|${phone}`);
    checkOtp(db, phone, req.body?.code);
    let user = findByPhone.get(phone);
    if (user?.role === 'admin') throw new HttpError(400, 'This is an admin number. Please log in on the admin page with your password.');
    if (!user) {
      const security = req.body?.signupAs === 'security';
      user = db.prepare('INSERT INTO users (phone, role, status) VALUES (?, ?, ?) RETURNING *')
        .get(phone, security ? 'security' : 'visitor', security ? 'pending' : 'active');
      if (security) notifier.emitToStaff('security');
    }
    startSession(db, res, user, config);
    res.json({ user: publicUser(user) });
  });

  // Admins log in with their number and the admin password. Only wrong
  // tries count towards the limits.
  const wrongPerIp = rateLimiter({ max: 20, windowMs: 15 * 60_000 });
  const wrongPerPhone = rateLimiter({ max: 8, windowMs: 15 * 60_000, message: 'Too many wrong tries for this number. Please wait 15 minutes.' });
  const wrongPerPhoneDay = rateLimiter({ max: 30, windowMs: 24 * 60 * 60_000, message: 'Too many wrong tries for this number today. Please try again tomorrow.' });
  const attempts = rateLimiter({ max: 300, windowMs: 60_000, message: 'The server is busy. Please try again in a minute.' });
  router.post('/password', async (req, res) => {
    const phone = parsePhone(req.body?.phone, config.defaultCountryCode);
    attempts('all');
    wrongPerIp.check(req.ip);
    wrongPerPhone.check(phone);
    wrongPerPhoneDay.check(phone);
    const user = findByPhone.get(phone);
    const ok = await checkPassword(req.body?.password, config.adminPasswordHash);
    if (!ok || user?.role !== 'admin' || user.status !== 'active') {
      wrongPerIp(req.ip);
      wrongPerPhone(phone);
      wrongPerPhoneDay(phone);
      throw new HttpError(400, 'Wrong number or password.');
    }
    startSession(db, res, user, config);
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    endSession(db, req, res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => res.json({ user: publicUser(req.user) }));

  router.patch('/me', requireUser, (req, res) => {
    const name = text(req.body?.name, 'your full name', 80);
    if (name.length < 2) throw new HttpError(400, 'Please enter your full name');
    let user = db.prepare('UPDATE users SET name = ? WHERE id = ? RETURNING *').get(name, req.user.id);
    // Security staff choose the reference who will approve them (only while waiting).
    if (user.role === 'security' && user.status === 'pending' && req.body?.referenceId !== undefined) {
      const ref = findReference(config.references, req.body.referenceId);
      if (!ref) throw new HttpError(400, 'Please choose your reference from the list');
      const changed = user.reference_id !== ref.id;
      user = db.prepare('UPDATE users SET reference_id = ? WHERE id = ? RETURNING *').get(ref.id, user.id);
      if (changed && user.photo) {
        for (const id of referenceAdminIds(db, config.references, ref.id, config.defaultCountryCode)) {
          notifier.pushOnly(id, 'Security request 🛡️', `${user.name} wants scanner access`, '/admin.html#/security');
        }
      }
    }
    if (user.role === 'security') notifier.emitToStaff('security');
    res.json({ user: publicUser(user) });
  });

  // The browser sends a small JPEG it has already cropped to the face.
  // Uploads are limited, and a replaced photo is deleted unless a booking
  // still shows it, so the disk can't be filled.
  const photoLimit = rateLimiter({ max: 15, windowMs: 60 * 60_000, message: 'Too many photos. Please try again later.' });
  const photoInUse = db.prepare('SELECT 1 FROM appointments WHERE photo = ? LIMIT 1');
  router.post('/me/photo', requireUser, (req, _res, next) => { photoLimit(req.user.id); next(); },
    express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '450kb' }), (req, res) => {
    const name = photos.save(req.body);
    const old = req.user.photo;
    const user = db.prepare('UPDATE users SET photo = ? WHERE id = ? RETURNING *').get(name, req.user.id);
    if (old && old !== name && !photoInUse.get(old)) photos.remove(old);
    if (user.role === 'security') notifier.emitToStaff('security');
    // A new security sign-up is complete once the photo is in: alert their reference.
    if (user.role === 'security' && user.status === 'pending' && user.reference_id && !old) {
      for (const id of referenceAdminIds(db, config.references, user.reference_id, config.defaultCountryCode)) {
        notifier.pushOnly(id, 'Security request 🛡️', `${user.name ?? 'Someone'} wants scanner access`, '/admin.html#/security');
      }
    }
    res.json({ user: publicUser(user) });
  });

  return router;
}

// Photos are only shown to their owner and to staff.
export function photoRoutes({ db, photos }) {
  const router = express.Router();
  const ownsPhoto = db.prepare(`
    SELECT 1 FROM users WHERE id = ? AND photo = ?
    UNION SELECT 1 FROM appointments WHERE user_id = ? AND photo = ?
  `);
  router.get('/:name', (req, res) => {
    const u = req.user;
    if (!u) throw new HttpError(401, 'Please log in to continue');
    const staff = u.role === 'admin' || (u.role === 'security' && u.status === 'active');
    if (!staff && !ownsPhoto.get(u.id, req.params.name, u.id, req.params.name)) throw new HttpError(404, 'Not found');
    const data = photos.read(req.params.name);
    if (!data) throw new HttpError(404, 'Not found');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' }).send(data);
  });
  return router;
}
