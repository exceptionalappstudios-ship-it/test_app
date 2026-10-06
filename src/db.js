import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'visitor' CHECK (role IN ('visitor', 'admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

-- Times are wall-clock times in the configured APP_TIMEZONE.
CREATE TABLE IF NOT EXISTS slots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,              -- YYYY-MM-DD
  start_time TEXT NOT NULL,              -- HH:MM
  end_time   TEXT NOT NULL,              -- HH:MM
  is_blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (date, start_time)
);

CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id       INTEGER NOT NULL REFERENCES slots(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  email         TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  admin_note    TEXT,
  checkin_code  TEXT UNIQUE,             -- secret encoded in the entry QR code
  checked_in_at TEXT,
  checked_in_by INTEGER REFERENCES users(id),
  reminded_24h  INTEGER NOT NULL DEFAULT 0,
  reminded_1h   INTEGER NOT NULL DEFAULT 0,
  reminded_qr   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A slot can only be held by one pending/approved appointment at a time.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_active_slot
  ON appointments (slot_id) WHERE status IN ('pending', 'approved');

CREATE TABLE IF NOT EXISTS notifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  read_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One conversation per visitor with the admin team.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id   INTEGER NOT NULL REFERENCES users(id),
  from_admin  INTEGER NOT NULL DEFAULT 0,
  body        TEXT NOT NULL,
  read_at     TEXT,                      -- read by the other side
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Log of every email / WhatsApp message the app tried to send.
CREATE TABLE IF NOT EXISTS outbound_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL,              -- email | whatsapp
  recipient  TEXT NOT NULL,
  subject    TEXT,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL,              -- sent | failed | logged (channel not configured)
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Databases from the first version (visitor tokens, no accounts) can't be
// migrated meaningfully, so they're set aside rather than mixed in.
function setAsideLegacyDatabase(file) {
  if (file === ':memory:' || !fs.existsSync(file)) return;
  const db = new DatabaseSync(file);
  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'visitors'").get();
  db.close();
  if (!legacy) return;
  const backup = `${file}.v1-backup`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, backup + suffix);
  }
  console.warn(`Moved the old database (from before accounts were added) to ${backup}`);
}

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  setAsideLegacyDatabase(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
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
