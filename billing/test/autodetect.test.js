'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open, hashPassword } = require('../lib/db');
const { localAdapter } = require('../lib/sheets');
const { detectColumn } = require('../lib/mapping');
const { createApp } = require('../server');

const ID = 'AUTO-SHEET-000000000000000000000';
let server; let base; let cookie; let dir; let file;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-auto-'));
  file = path.join(dir, 'sheets.json');
  fs.writeFileSync(file, JSON.stringify({ [ID]: { tabs: { Sheet1: [
    ['Last Name', 'First Name', 'DOB', 'Primary Insurance', 'Member ID', 'DOS', 'Status', 'Comments'],
    ['Done', 'Already', '01/01/1950', 'Aetna', 'W1', '11/01/2026', 'Demo Done', ''],
    ['New', 'Patient', '02/02/1960', 'Aetna', 'W2', '11/01/2026', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['Later', 'Row', '03/03/1970', 'Aetna', 'W3', '11/02/2026', '', ''],
    ['', '', '', '', '', '', '', ''],
  ] } } }));
  const db = open(path.join(dir, 'b.db'));
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)').run('A', 'a@example.com', hashPassword('test-password-123'), 'admin');
  const app = createApp({ db, sheets: localAdapter(file) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'test-password-123' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};

test('detectColumn finds common header names', () => {
  const header = ['Patient', 'Insurance Status', 'Primary Ins', 'Claim Status', 'Remarks'];
  assert.equal(detectColumn(header, 'status').letter, 'D');
  assert.equal(detectColumn(header, 'insurance').letter, 'C');
  assert.equal(detectColumn(header, 'notes').letter, 'E');
  assert.ok(detectColumn(['A', 'B'], 'notes').error);
});

test('blank tab, columns and rows are filled in from the sheet', async () => {
  const t = await call('POST', '/api/tasks', { task_type: 'demo' });
  await call('PUT', `/api/tasks/${t.data.id}`, {
    practice_name: 'P', provider_name: 'Dr A', provider_npi: '1234567893', oa_account: 'OA',
    sheet_link: `https://docs.google.com/spreadsheets/d/${ID}/edit`, tab_name: 'sheet 1', portals: ['Office Ally'],
  });
  const chk = await call('POST', `/api/tasks/${t.data.id}/check-sheet`);
  assert.equal(chk.status, 200, JSON.stringify(chk.data));
  assert.equal(chk.data.task.tab_name, 'Sheet1');
  assert.equal(chk.data.columns.status.letter, 'G');
  assert.equal(chk.data.columns.insurance.letter, 'D');
  assert.equal(chk.data.columns.notes.letter, 'H');
  assert.deepEqual(chk.data.task.problems, []);
  const conf = await call('POST', `/api/tasks/${t.data.id}/confirm`);
  assert.equal(conf.status, 200, JSON.stringify(conf.data));

  const rows = (await call('GET', `/api/tasks/${t.data.id}/rows`)).data;
  assert.deepEqual(rows.map((r) => r.row_no), [2, 3, 4, 5], 'reads to the last row with data');
  assert.equal(rows[0].in_scope, false, 'row with a status is skipped');
  assert.match(rows[0].reason, /Already has status "Demo Done"/);
  assert.equal(rows[1].in_scope, true);
  assert.equal(rows[2].reason, 'Blank row');

  // Once this task records a row, it stays in scope even though it now has a status.
  await call('POST', `/api/tasks/${t.data.id}/rows/3/record`, { outcome: 'held', notes: 'Held — test' });
  const after = (await call('GET', `/api/tasks/${t.data.id}/rows`)).data;
  assert.equal(after.find((r) => r.row_no === 3).in_scope, true);
  const rep = (await call('GET', `/api/tasks/${t.data.id}/report`)).data;
  assert.equal(rep.next_row, 5);
  assert.match(rep.text, /rows 2–last row/);
});

test('portal links: starter list, practice-specific links, https only', async () => {
  let all = (await call('GET', '/api/portals')).data;
  assert.ok(all.some((p) => p.name === 'Office Ally'));
  const bad = await call('POST', '/api/portals', { name: 'X', url: 'http://insecure.example.com' });
  assert.equal(bad.status, 422);
  const pr = (await call('GET', '/api/practices')).data[0];
  const add = await call('POST', '/api/portals', { name: 'Fidelis', url: 'https://provider.example.com/login', practice_id: pr.id });
  assert.equal(add.status, 201);
  const t = (await call('GET', '/api/tasks/1')).data;
  assert.ok(t.portal_links.some((p) => p.name === 'Fidelis'));
  assert.ok(t.portal_links.some((p) => p.name === 'Office Ally'));
  all = (await call('GET', '/api/portals?practice_id=999')).data;
  assert.ok(!all.some((p) => p.name === 'Fidelis'), 'other practices do not see it');
});

test('delete a task: removes it and its records, sheet untouched', async () => {
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = await call('POST', '/api/tasks', { task_type: 'claim' });
  const d = await call('DELETE', `/api/tasks/${t.data.id}`);
  assert.equal(d.status, 200);
  assert.equal((await call('GET', `/api/tasks/${t.data.id}`)).status, 404);
  // Task 1 has a recorded row; admin can still delete it.
  const d1 = await call('DELETE', '/api/tasks/1');
  assert.equal(d1.status, 200, JSON.stringify(d1.data));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before);
});

test('a user can change their own password', async () => {
  const wrong = await call('PUT', '/api/me/password', { current: 'nope', password: 'new-password-456' });
  assert.equal(wrong.status, 422);
  const ok = await call('PUT', '/api/me/password', { current: 'test-password-123', password: 'new-password-456' });
  assert.equal(ok.status, 200);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'new-password-456' }) });
  assert.equal(login.status, 200);
});

test('remove a user: access ends, name stays, email can be reused', async () => {
  const add = await call('POST', '/api/users', { name: 'Temp Staff', email: 'temp@example.com', password: 'temp-password-1', role: 'staff' });
  assert.equal(add.status, 201);
  const me = (await call('GET', '/api/me')).data;
  assert.equal((await call('DELETE', `/api/users/${me.id}`)).status, 422, 'cannot remove yourself');
  assert.equal((await call('DELETE', `/api/users/${add.data.id}`)).status, 200);
  assert.ok(!(await call('GET', '/api/users')).data.some((u) => u.email === 'temp@example.com'));
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'temp@example.com', password: 'temp-password-1' }) });
  assert.equal(login.status, 401);
  assert.equal((await call('POST', '/api/users', { name: 'Temp Again', email: 'temp@example.com', password: 'temp-password-2', role: 'staff' })).status, 201);
});

test('usernames and admin password reset', async () => {
  const add = await call('POST', '/api/users', { name: 'Nabeel', username: 'Nabeel', password: '', role: 'staff' });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  assert.equal(add.data.username, 'nabeel');
  assert.match(add.data.password, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
  let login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'NABEEL', password: add.data.password }) });
  assert.equal(login.status, 200);
  assert.equal((await call('POST', '/api/users', { name: 'X', username: 'has space', role: 'staff' })).status, 422);
  const reset = await call('POST', `/api/users/${add.data.id}/reset-password`);
  assert.equal(reset.status, 200);
  login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nabeel', password: add.data.password }) });
  assert.equal(login.status, 401, 'old password stops working');
  login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nabeel', password: reset.data.password }) });
  assert.equal(login.status, 200);
  const list = (await call('GET', '/api/users')).data;
  assert.ok(list.every((u) => !('password' in u) && !('password_hash' in u)), 'passwords are never listed');
});
