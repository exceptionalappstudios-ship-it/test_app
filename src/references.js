import crypto from 'node:crypto';

// The people a visitor can name as their reference. A visitor must also type
// one of that person's phone numbers, which proves they really know them.
// These people are also the app's only admins (they log in with their number
// and the admin password).
export const REFERENCES = [
  { id: 'demo', name: 'Demo', phones: ['1234567890'] },
  { id: 'hari-hara', name: 'Swami Hari Hara Ji', phones: ['8618546110', '9405070710'] },
  { id: 'satish', name: 'Satish Vithalani Ji', phones: ['9820029858'] },
  { id: 'dhruv', name: 'Dhruv Shah Ji', phones: ['9824018990'] },
  { id: 'pankaj', name: 'Pankaj Ji', phones: ['9879570962'] },
  { id: 'jaymin', name: 'Jaymin Ji', phones: ['9825355000'] },
];

// The shared admin password, stored only as a scrypt hash. ADMIN_PASSWORD on
// the host replaces it.
export const ADMIN_PASSWORD_HASH = 'scrypt$Y9sBlK7wUYHPZP1jjjjj9A$bcZJHLaFfNhzQ4TMD9jCtFZnDBSZlsToRImKCW1DJ_c';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 32).toString('base64url')}`;
}

// Runs off the main thread, so password checks can't freeze the server.
const scrypt = (password, salt) => new Promise((resolve, reject) => crypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key))));
export async function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash || typeof password !== 'string' || !password || password.length > 200) return false;
  const given = await scrypt(password, salt);
  const want = Buffer.from(hash, 'base64url');
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// "+919876543210" or "9876543210" -> "9876543210"
const lastTen = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-10);

export const findReference = (references, id) => references.find((r) => r.id === id) ?? null;
export const referenceOfPhone = (references, phone) => references.find((r) => r.phones.includes(lastTen(phone))) ?? null;
export const referenceHasPhone = (ref, phone) => Boolean(ref && String(phone ?? '').replace(/\D/g, '').length >= 10 && ref.phones.includes(lastTen(phone)));
