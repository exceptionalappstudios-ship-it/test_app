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

// Normalises to international format (+<country><number>) so it works for
// WhatsApp. Numbers typed without a country code get the default one.
export function normalizePhone(value, defaultCountryCode) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !/^\+?[\d\s()-]+$/.test(raw)) return null;
  let digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else {
      digits = digits.replace(/^0+/, '');
      if (digits.length <= 10) digits = defaultCountryCode + digits;
    }
  }
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

export function phone(value, defaultCountryCode, field = 'a valid WhatsApp number') {
  const p = normalizePhone(value, defaultCountryCode);
  if (!p) throw new HttpError(400, `Please enter ${field}`);
  return p;
}

// Fixed-window limiter for OTP endpoints.
export function rateLimiter({ max, windowMs, message = 'Too many attempts. Please wait a few minutes and try again.' }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 50000) for (const [k, e] of hits) if (e.reset < now) hits.delete(k);
      return;
    }
    if (++entry.count > max) throw new HttpError(429, message);
  };
}
