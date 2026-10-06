import crypto from 'node:crypto';
import { HttpError } from './http.js';

const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'sid';

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
  if (password.length > 200) throw new HttpError(400, 'Password is too long');
  return password;
}

export function createUser(db, { name, email, phone, password, role = 'visitor' }) {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with this email already exists. Please log in instead.');
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(name, email, phone, hashPassword(password), role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
}

export const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });

function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionMiddleware(db) {
  return (req, _res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    req.user = token ? db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `).get(hashToken(token)) : null;
    req.sessionToken = req.user ? token : null;
    next();
  };
}

export function startSession(db, res, user, { secureCookies }) {
  const token = newToken();
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .run(hashToken(token), user.id);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: SESSION_DAYS * 86400_000, path: '/',
  });
}

export function endSession(db, req, res) {
  if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(req.sessionToken));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function requireUser(req, _res, next) {
  next(req.user ? undefined : new HttpError(401, 'Please log in to continue'));
}

export function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in to continue'));
  next(req.user.role === 'admin' ? undefined : new HttpError(403, 'Admins only'));
}
