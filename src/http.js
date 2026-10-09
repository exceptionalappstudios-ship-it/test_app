// Small helpers shared by the route modules.
export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function text(value, field, max, { required = true } = {}) {
  const v = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!v && required) throw new HttpError(400, `Please enter ${field}`);
  if (v.length > max) throw new HttpError(400, `${field[0].toUpperCase() + field.slice(1)} must be at most ${max} characters`);
  return v;
}

// Mobile numbers are exactly 10 digits. They are stored with the country
// code (+91XXXXXXXXXX) so they work for WhatsApp; a number that already
// carries that code (as stored) is accepted too.
export function normalizePhone(value, countryCode = '91') {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !/^\+?[\d\s()-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+${countryCode}${digits}`;
  if (raw.startsWith('+') && digits.length === countryCode.length + 10 && digits.startsWith(countryCode)) return `+${digits}`;
  return null;
}

export function phone(value, countryCode, field = 'a valid WhatsApp number') {
  const p = normalizePhone(value, countryCode);
  if (!p) throw new HttpError(400, `Please enter ${field} (10 digits)`);
  return p;
}

// Fixed-window limiter for OTP endpoints.
export function rateLimiter({ max, windowMs, message = 'Too many attempts. Please wait a few minutes and try again.' }) {
  const hits = new Map();
  const limiter = (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 50000) for (const [k, e] of hits) if (e.reset < now) hits.delete(k);
      return;
    }
    if (++entry.count > max) throw new HttpError(429, message);
  };
  // Throws if `key` is already over the limit, without counting this try.
  limiter.check = (key) => {
    const entry = hits.get(key);
    if (entry && entry.reset >= Date.now() && entry.count >= max) throw new HttpError(429, message);
  };
  return limiter;
}
