import crypto from 'node:crypto';
import { HttpError } from './http.js';

// Everyone stays logged in for 30 days.
const SESSION_DAYS = { admin: 30, security: 30, visitor: 30 };
const OTP_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
export const SESSION_COOKIE = 'sid';

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const hashCode = (phone, code) => crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');

// Creates a fresh 6-digit code for a phone number, replacing any earlier one.
export function issueOtp(db, phone) {
  const recent = db.prepare("SELECT 1 FROM otp_codes WHERE phone = ? AND sent_at > datetime('now', '-30 seconds')").get(phone);
  if (recent) throw new HttpError(429, 'A code was just sent. Please wait 30 seconds before asking for another.');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare(`
    INSERT INTO otp_codes (phone, code_hash, expires_at, attempts, sent_at)
    VALUES (?, ?, datetime('now', '+${OTP_MINUTES} minutes'), 0, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at
  `).run(phone, hashCode(phone, code));
  return code;
}

export function checkOtp(db, phone, code) {
  const row = db.prepare("SELECT * FROM otp_codes WHERE phone = ? AND expires_at > datetime('now')").get(phone);
  if (!row) throw new HttpError(400, 'This code has expired. Please ask for a new one.');
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong codes. Please ask for a new one.');
  const given = hashCode(phone, String(code ?? '').replace(/\D/g, ''));
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(row.code_hash))) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?').run(phone);
    throw new HttpError(400, 'That code is not right. Please check the WhatsApp message and try again.');
  }
  db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone);
}

// Visitors and security need a face photo; admins only a name. Security staff
// waiting for approval also need to have chosen their reference.
export const isProfileComplete = (u) => Boolean(u?.name && (u.photo || u.role === 'admin')
  && (u.role !== 'security' || u.status !== 'pending' || u.reference_id));

export const publicUser = (u) => u && {
  id: u.id, name: u.name, phone: u.phone, role: u.role, status: u.status,
  photo: u.photo ? `/api/photos/${u.photo}` : null, profileComplete: isProfileComplete(u),
  ...(u.role === 'security' ? { referenceId: u.reference_id ?? null } : {}),
};

function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionMiddleware(db) {
  const find = db.prepare(`
    SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
  `);
  return (req, _res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    req.user = token ? find.get(hashToken(token)) ?? null : null;
    req.sessionToken = req.user ? token : null;
    next();
  };
}

export function startSession(db, res, user, { secureCookies }) {
  const token = newToken();
  const days = SESSION_DAYS[user.role] ?? 30;
  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= datetime('now')").run();
  db.prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${Number(days)} days'))`)
    .run(hashToken(token), user.id);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: days * 86400_000, path: '/',
  });
}

export function endSession(db, req, res) {
  if (req.sessionToken) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(req.sessionToken));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function requireUser(req, _res, next) {
  next(req.user ? undefined : new HttpError(401, 'Please log in to continue'));
}

// Logged in with name and photo filled in.
export function requireProfile(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in to continue'));
  next(isProfileComplete(req.user) ? undefined : new HttpError(403, 'Please add your name and photo first'));
}

export function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in to continue'));
  next(req.user.role === 'admin' ? undefined : new HttpError(403, 'Admins only'));
}

// Admins, and security staff an admin has approved.
export function requireStaff(req, _res, next) {
  const u = req.user;
  if (!u) return next(new HttpError(401, 'Please log in to continue'));
  if (u.role === 'admin' || (u.role === 'security' && u.status === 'active')) return next();
  if (u.role === 'security' && u.status === 'pending') return next(new HttpError(403, 'Your security account is waiting for admin approval'));
  next(new HttpError(403, 'You do not have scanner access'));
}
