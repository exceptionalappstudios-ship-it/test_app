import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 4;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Everyone signs in with their WhatsApp number. Security staff start as
-- 'pending' until an admin approves them; admins can revoke them later.
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL UNIQUE,      -- +<country><number>
  name        TEXT,
  photo       TEXT,                      -- file name in the photos folder
  role        TEXT NOT NULL DEFAULT 'visitor' CHECK (role IN ('visitor', 'security', 'admin')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'revoked', 'rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS users_role ON users (role, status);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A bookable part of a day: morning, afternoon or evening.
CREATE TABLE IF NOT EXISTS visit_sessions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT NOT NULL,               -- YYYY-MM-DD in APP_TIMEZONE
  period    TEXT NOT NULL CHECK (period IN ('morning', 'afternoon', 'evening')),
  capacity  INTEGER NOT NULL,            -- people, not bookings
  is_closed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (date, period)
);

CREATE TABLE IF NOT EXISTS appointments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  session_id          INTEGER NOT NULL REFERENCES visit_sessions(id),
  date                TEXT NOT NULL,     -- copied from the session for fast lookups
  period              TEXT NOT NULL,
  name                TEXT NOT NULL,
  phone               TEXT NOT NULL,     -- WhatsApp number the pass is sent to
  photo               TEXT,
  reference           TEXT NOT NULL,     -- who referred them (name)
  ref_phone           TEXT,
  ref_designation     TEXT,
  express             INTEGER NOT NULL DEFAULT 0, -- created by an admin, pass valid all day
  created_by          INTEGER REFERENCES users(id),
  people_count        INTEGER NOT NULL CHECK (people_count BETWEEN 1 AND 10),
  purposes            TEXT NOT NULL,     -- JSON array
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'hold', 'approved', 'rejected', 'cancelled')),
  admin_note          TEXT,
  reviewed_by         INTEGER REFERENCES users(id),
  checkin_code        TEXT UNIQUE,
  checked_in_at       TEXT,
  checked_in_by       INTEGER REFERENCES users(id),
  reminded_day_before INTEGER NOT NULL DEFAULT 0,
  greeted             INTEGER NOT NULL DEFAULT 0,
  pass_sent_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS appointments_date ON appointments (date, status);
CREATE INDEX IF NOT EXISTS appointments_status ON appointments (status, date);
CREATE INDEX IF NOT EXISTS appointments_user ON appointments (user_id);
CREATE INDEX IF NOT EXISTS appointments_session ON appointments (session_id, status);

-- Every phone number on a booking (the booker and each extra person), so
-- "one appointment per person" is a single indexed lookup.
CREATE TABLE IF NOT EXISTS appointment_people (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL,
  is_booker      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS appointment_people_phone ON appointment_people (phone);
CREATE INDEX IF NOT EXISTS appointment_people_appt ON appointment_people (appointment_id);

CREATE TABLE IF NOT EXISTS notifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  read_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- WhatsApp outbox. Doubles as a durable queue: rows are sent in the
-- background, retried on failure, and survive restarts.
CREATE TABLE IF NOT EXISTS outbound_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel         TEXT NOT NULL DEFAULT 'whatsapp',
  kind            TEXT NOT NULL,         -- otp | update | pass | broadcast
  recipient       TEXT NOT NULL,
  payload         TEXT NOT NULL,         -- JSON
  preview         TEXT NOT NULL,         -- human-readable text, for logs
  status          TEXT NOT NULL DEFAULT 'queued', -- queued | sending | sent | failed | logged
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT
);
CREATE INDEX IF NOT EXISTS outbound_queue ON outbound_messages (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS broadcasts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  period     TEXT,                       -- null = whole day
  body       TEXT NOT NULL,
  recipients INTEGER NOT NULL,
  sent_by    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Databases from the first versions (email/password accounts, timed slots)
// don't map onto this model, so they're set aside rather than mixed in.
// Version 3 onwards is upgraded in place (see MIGRATIONS).
function setAsideOldDatabase(file) {
  if (file === ':memory:' || !fs.existsSync(file)) return;
  const db = new DatabaseSync(file);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'appointments'").get();
  db.close();
  if (!hasTables || version >= 3) return;
  const backup = `${file}.before-v${SCHEMA_VERSION}`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, backup + suffix);
  }
  console.warn(`Moved the database from the previous version to ${backup}`);
}

// Columns added after version 3.
const MIGRATIONS = [
  ['ref_phone', 'TEXT'],
  ['ref_designation', 'TEXT'],
  ['express', 'INTEGER NOT NULL DEFAULT 0'],
  ['created_by', 'INTEGER REFERENCES users(id)'],
];

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  setAsideOldDatabase(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const columns = new Set(db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name));
  for (const [name, type] of MIGRATIONS) if (!columns.has(name)) db.exec(`ALTER TABLE appointments ADD COLUMN ${name} ${type}`);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
