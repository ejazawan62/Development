'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS practices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payers (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  aliases TEXT NOT NULL DEFAULT '[]',
  oa_payer_name TEXT NOT NULL,
  payer_id TEXT NOT NULL,
  plan_type TEXT NOT NULL CHECK (plan_type IN ('medicare','advantage','medicaid','medicaid_mco','commercial','other')),
  portal TEXT NOT NULL DEFAULT '',
  sheet_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  task_type TEXT NOT NULL CHECK (task_type IN ('demo','claim','submission')),
  practice_id INTEGER REFERENCES practices(id),
  practice_name TEXT NOT NULL DEFAULT '',
  provider_name TEXT NOT NULL DEFAULT '',
  provider_npi TEXT NOT NULL DEFAULT '',
  billing_npi TEXT NOT NULL DEFAULT '',
  billing_tax_id TEXT NOT NULL DEFAULT '',
  facilities TEXT NOT NULL DEFAULT '[]',
  oa_account TEXT NOT NULL DEFAULT '',
  sheet_link TEXT NOT NULL DEFAULT '',
  spreadsheet_id TEXT NOT NULL DEFAULT '',
  tab_name TEXT NOT NULL DEFAULT '',
  status_col TEXT NOT NULL DEFAULT '',
  insurance_col TEXT NOT NULL DEFAULT '',
  notes_col TEXT NOT NULL DEFAULT '',
  row_from INTEGER,
  row_to INTEGER,
  dos_from TEXT NOT NULL DEFAULT '',
  dos_to TEXT NOT NULL DEFAULT '',
  portals TEXT NOT NULL DEFAULT '[]',
  special_instructions TEXT NOT NULL DEFAULT '',
  extra_drug_codes TEXT NOT NULL DEFAULT '',
  header TEXT NOT NULL DEFAULT '[]',
  header_checked_at TEXT,
  mapping TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'setup' CHECK (state IN ('setup','confirmed','closed')),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  current_row INTEGER,
  current_row_started_at TEXT,
  bot_paused INTEGER NOT NULL DEFAULT 0,
  bot_last_seen TEXT,
  rows_loaded_at TEXT,
  copied_from INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS task_rows (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  row_no INTEGER NOT NULL,
  cells TEXT NOT NULL,
  PRIMARY KEY (task_id, row_no)
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  row_no INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  status_text TEXT NOT NULL,
  insurance TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  checklist TEXT NOT NULL DEFAULT '[]',
  actor TEXT NOT NULL CHECK (actor IN ('bot','user')),
  user_id INTEGER REFERENCES users(id),
  token_id INTEGER REFERENCES api_tokens(id),
  started_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('repeat_issue','otp','login_failed','question','error')),
  message TEXT NOT NULL,
  issue_key TEXT,
  row_no INTEGER,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolution TEXT,
  resolved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  actor TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS portals (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER REFERENCES practices(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  sender TEXT NOT NULL CHECK (sender IN ('user','bot','system')),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message',
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_task ON records(task_id, row_no);
CREATE INDEX IF NOT EXISTS idx_alerts_task ON alerts(task_id, resolved);
CREATE INDEX IF NOT EXISTS idx_payers_practice ON payers(practice_id);
`;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Columns added after the first release: add them to existing databases.
  const have = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name));
  for (const [col, type] of [['bot_name', 'TEXT'], ['bot_claimed_at', 'TEXT'], ['paused_by', 'TEXT']]) {
    if (!have.has(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`);
  }
  const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!userCols.has('removed_at')) db.exec('ALTER TABLE users ADD COLUMN removed_at TEXT');
  const tokenCols = new Set(db.prepare('PRAGMA table_info(api_tokens)').all().map((c) => c.name));
  if (!tokenCols.has('deleted_at')) db.exec('ALTER TABLE api_tokens ADD COLUMN deleted_at TEXT');
  // Starter portal links (all practices). Admins can change them in Settings.
  if (!db.prepare("SELECT value FROM settings WHERE key = 'portals_seeded'").get()) {
    const add = db.prepare('INSERT INTO portals (practice_id, name, url, sort) VALUES (NULL, ?, ?, ?)');
    [['Office Ally', 'https://www.officeally.com/'], ['NGS Medicare', 'https://www.ngsmedicare.com/'], ['ePACES (NY Medicaid)', 'https://www.emedny.org/epaces/'],
      ['UHC Provider', 'https://www.uhcprovider.com/'], ['Availity', 'https://www.availity.com/']].forEach(([n, u], i) => add.run(n, u, i));
    db.prepare("INSERT INTO settings (key, value) VALUES ('portals_seeded', '1')").run();
  }
  return db;
}

/** Runs fn inside a transaction; rolls back on throw. */
function tx(db, fn) {
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

function readSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function writeSetting(db, key, value) {
  if (value == null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

module.exports = { open, tx, hashPassword, verifyPassword, sha256, readSettings, writeSetting };
