// Small helpers shared by the route modules.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function text(value, field, max) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function email(value) {
  const v = text(value, 'Email', 200).toLowerCase();
  if (!EMAIL_RE.test(v)) throw new HttpError(400, 'Please enter a valid email address');
  return v;
}

// Normalises to international format (+<country><number>) so the number
// works for WhatsApp. Local numbers get the default country code.
export function phone(value, defaultCountryCode) {
  const raw = text(value, 'Phone number', 25);
  if (!/^\+?[\d\s()-]+$/.test(raw)) throw new HttpError(400, 'Please enter a valid phone number');
  let digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) {
    digits = digits.replace(/^0+/, '');
    if (digits.length <= 10) digits = defaultCountryCode + digits;
  }
  if (digits.length < 8 || digits.length > 15) throw new HttpError(400, 'Please enter a valid phone number');
  return `+${digits}`;
}

// Fixed-window limiter for login / reset endpoints.
export function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10000) for (const [k, e] of hits) if (e.reset < now) hits.delete(k);
      return;
    }
    if (++entry.count > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
  };
}
