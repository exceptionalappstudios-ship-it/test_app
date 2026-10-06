import express from 'express';
import {
  createUser, publicUser, startSession, endSession, verifyPassword, validatePassword,
  hashPassword, hashToken, newToken, requireUser,
} from '../auth.js';
import { HttpError, text, email as parseEmail, phone as parsePhone, rateLimiter } from '../http.js';

export function authRoutes({ db, notifier, config }) {
  const router = express.Router();
  const loginLimit = rateLimiter({ max: 10, windowMs: 15 * 60_000 });
  const resetLimit = rateLimiter({ max: 5, windowMs: 60 * 60_000 });
  const session = (res, user) => startSession(db, res, user, config);

  router.post('/signup', (req, res) => {
    const body = req.body ?? {};
    const user = createUser(db, {
      name: text(body.name, 'Name', 100),
      email: parseEmail(body.email),
      phone: parsePhone(body.phone, config.defaultCountryCode),
      password: validatePassword(body.password),
    });
    session(res, user);
    res.status(201).json({ user: publicUser(user) });
  });

  router.post('/login', (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    loginLimit(`${req.ip}|${email}`);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(String(req.body?.password ?? ''), user.password_hash)) {
      throw new HttpError(401, 'Incorrect email or password');
    }
    session(res, user);
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    endSession(db, req, res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => res.json({ user: publicUser(req.user) }));

  router.patch('/me', requireUser, (req, res) => {
    const name = text(req.body?.name, 'Name', 100);
    const phone = parsePhone(req.body?.phone, config.defaultCountryCode);
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone, req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  router.post('/change-password', requireUser, (req, res) => {
    if (!verifyPassword(String(req.body?.currentPassword ?? ''), req.user.password_hash)) {
      throw new HttpError(400, 'Current password is incorrect');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(validatePassword(req.body?.newPassword)), req.user.id);
    res.json({ ok: true });
  });

  // Always answers the same way so it can't be used to discover accounts.
  router.post('/forgot', (req, res) => {
    resetLimit(req.ip);
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) {
      const token = newToken();
      db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))")
        .run(hashToken(token), user.id);
      const link = `${config.appUrl}/${user.role === 'admin' ? 'admin.html' : ''}#/reset/${token}`;
      notifier.sendEmail(user.email, 'Reset your password',
        `Hello ${user.name},\n\nUse this link within 1 hour to set a new password:\n${link}\n\nIf you didn't ask for this, you can ignore this email.`);
    }
    res.json({ ok: true });
  });

  router.post('/reset', (req, res) => {
    resetLimit(req.ip);
    const password = validatePassword(req.body?.password);
    const reset = db.prepare(`
      SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
    `).get(hashToken(String(req.body?.token ?? '')));
    if (!reset) throw new HttpError(400, 'This reset link is invalid or has expired. Please request a new one.');
    db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE token_hash = ?").run(reset.token_hash);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), reset.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(reset.user_id);
    session(res, user);
    res.json({ user: publicUser(user) });
  });

  return router;
}
