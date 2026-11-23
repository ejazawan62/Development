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
  role TEXT NOT NULL CHECK (role IN ('admin','biller')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  payer_id TEXT NOT NULL,
  filing_code TEXT NOT NULL DEFAULT 'CI',
  address1 TEXT, city TEXT, state TEXT, zip TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  npi TEXT NOT NULL,
  tax_id TEXT NOT NULL,
  taxonomy TEXT,
  address1 TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL, zip TEXT NOT NULL,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  account_no TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  middle_initial TEXT,
  dob TEXT NOT NULL,
  sex TEXT NOT NULL CHECK (sex IN ('M','F','U')),
  address1 TEXT, address2 TEXT, city TEXT, state TEXT, zip TEXT,
  phone TEXT, email TEXT,
  primary_payer_id INTEGER REFERENCES payers(id),
  member_id TEXT, group_no TEXT,
  subscriber_rel TEXT NOT NULL DEFAULT 'self' CHECK (subscriber_rel IN ('self','spouse','child','other')),
  subscriber_first TEXT, subscriber_last TEXT, subscriber_dob TEXT, subscriber_sex TEXT,
  secondary_payer_id INTEGER REFERENCES payers(id),
  secondary_member_id TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  batch_no TEXT NOT NULL UNIQUE,
  control_no INTEGER NOT NULL,
  claim_count INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  file_content TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  claim_no TEXT NOT NULL UNIQUE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  payer_id INTEGER REFERENCES payers(id),
  payer_rank TEXT NOT NULL DEFAULT 'primary' CHECK (payer_rank IN ('primary','secondary')),
  provider_id INTEGER REFERENCES providers(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','ready','submitted','accepted','rejected','paid','denied')),
  pos TEXT NOT NULL DEFAULT '11',
  diagnoses TEXT NOT NULL DEFAULT '[]',
  prior_auth TEXT,
  notes TEXT,
  total_cents INTEGER NOT NULL DEFAULT 0,
  batch_id INTEGER REFERENCES batches(id),
  submitted_at TEXT,
  payer_claim_no TEXT,
  paid_cents INTEGER,
  response_note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS claim_lines (
  id INTEGER PRIMARY KEY,
  claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  dos_from TEXT NOT NULL,
  dos_to TEXT NOT NULL,
  cpt TEXT NOT NULL,
  modifiers TEXT NOT NULL DEFAULT '',
  units REAL NOT NULL DEFAULT 1,
  charge_cents INTEGER NOT NULL,
  dx_pointers TEXT NOT NULL DEFAULT '1'
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_patient ON claims(patient_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit(entity, entity_id);
`;

const DEFAULT_SETTINGS = {
  practice_name: 'DPIS Medical Billing',
  submitter_id: 'SUBMITTER01',
  submitter_contact: 'Billing Office',
  submitter_phone: '0000000000',
  receiver_name: 'CLEARINGHOUSE',
  receiver_id: 'RECEIVER01',
  usage_indicator: 'T',
  next_control_no: '1',
  next_claim_seq: '1',
  next_account_seq: '1',
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);
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

function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

/** Atomically reads and increments a numeric counter kept in settings. Call inside tx(). */
function nextSeq(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const n = Number(row ? row.value : 1);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(n + 1));
  return n;
}

module.exports = { open, tx, hashPassword, verifyPassword, getSettings, nextSeq };
