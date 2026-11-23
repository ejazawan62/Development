'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open, hashPassword, readSettings } = require('../lib/db');
const { createSheets, appsScriptAdapter } = require('../lib/sheets');
const { appsScriptSource } = require('../lib/apps-script');
const { createApp } = require('../server');

// A stand-in for the deployed Apps Script: same request/response shape.
const SHEET = { Tab1: [['Last Name', 'First Name', 'DOB', 'Insurance', 'Status', 'Notes'], ['Doe', 'Jan', '01/01/1950', 'Aetna', '', '']] };
let fake; let fakeUrl; let secretSeen = null; let app; let base; let cookie; let dir;

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r = JSON.parse(body);
      const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (r.secret !== secretSeen) return send({ error: 'unauthorized' });
      if (r.action === 'ping') return send({ ok: true, account: 'billing@example.com' });
      if (r.spreadsheetId !== 'SHEET-ID-12345678901234567890') return send({ error: 'Requested entity was not found.' });
      if (r.action === 'listTabs') return send({ tabs: Object.keys(SHEET) });
      const sh = SHEET[r.tab];
      if (!sh) return send({ error: `Tab "${r.tab}" not found` });
      if (r.action === 'read') return send({ values: sh.slice(r.row - 1, r.row - 1 + r.numRows) });
      if (r.action === 'write') { for (const c of r.cells) sh[c.row - 1][c.col] = c.value; return send({ ok: true }); }
      return send({ error: 'unknown action' });
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}/exec`;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-as-'));
  const db = open(path.join(dir, 'billing.db'));
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)').run('A', 'a@example.com', hashPassword('test-password-123'), 'admin');
  // Allow the local fake URL for the test only.
  const sheets = createSheets({}, dir, () => readSettings(db), { allowAnyUrl: true });
  const server = createApp({ db, sheets, appsScriptOptions: { allowAnyUrl: true } });
  await new Promise((r) => { app = server.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${app.address().port}`;
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'test-password-123' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(() => { app.close(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};

test('only real Apps Script URLs are accepted by default', () => {
  assert.throws(() => appsScriptAdapter('http://127.0.0.1/exec', 's'));
  assert.throws(() => appsScriptAdapter('https://evil.example.com/macros/s/AKfycbx1234567890123456789/exec', 's'));
  assert.ok(appsScriptAdapter('https://script.google.com/macros/s/AKfycbx1234567890123456789/exec', 's'));
  assert.ok(appsScriptAdapter('https://script.google.com/a/macros/clinic.com/s/AKfycbx1234567890123456789/exec', 's'));
});

test('script template carries the secret', () => {
  assert.match(appsScriptSource('abc123'), /const SECRET = 'abc123';/);
});

test('connect, then read and write a sheet through the script', async () => {
  let s = await call('GET', '/api/settings/sheets');
  assert.equal(s.data.mode, 'local');
  s = await call('POST', '/api/settings/sheets/new-script');
  secretSeen = s.data.script.match(/const SECRET = '([^']+)'/)[1];

  // Wrong secret on the script side → clear message, nothing saved.
  const realSecret = secretSeen;
  secretSeen = 'other';
  let c = await call('PUT', '/api/settings/sheets', { url: fakeUrl });
  assert.equal(c.status, 422);
  assert.match(c.data.error, /secret does not match/);
  secretSeen = realSecret;

  c = await call('PUT', '/api/settings/sheets', { url: fakeUrl });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.mode, 'appsscript');
  assert.equal(c.data.account, 'billing@example.com');

  const t = await call('POST', '/api/tasks', { task_type: 'demo' });
  await call('PUT', `/api/tasks/${t.data.id}`, {
    practice_name: 'P', provider_name: 'Dr A', provider_npi: '1234567893', oa_account: 'OA',
    sheet_link: 'https://docs.google.com/spreadsheets/d/SHEET-ID-12345678901234567890/edit', tab_name: 'Tab1',
    status_col: 'Status', insurance_col: 'Insurance', notes_col: 'Notes', row_from: 2, row_to: 2, portals: ['Office Ally'],
  });
  const chk = await call('POST', `/api/tasks/${t.data.id}/check-sheet`);
  assert.equal(chk.status, 200, JSON.stringify(chk.data));
  assert.equal(chk.data.columns.status.letter, 'E');
  const conf = await call('POST', `/api/tasks/${t.data.id}/confirm`);
  assert.equal(conf.status, 200, JSON.stringify(conf.data));
  const rec = await call('POST', `/api/tasks/${t.data.id}/rows/2/record`, { outcome: 'held', notes: 'Held — test' });
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  assert.equal(SHEET.Tab1[1][4], 'Held');
  assert.equal(SHEET.Tab1[1][5], 'Held — test');

  const d = await call('DELETE', '/api/settings/sheets');
  assert.equal(d.data.mode, 'local');
});
