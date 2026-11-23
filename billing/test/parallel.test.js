'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open, hashPassword } = require('../lib/db');
const { localAdapter } = require('../lib/sheets');
const { createApp } = require('../server');
const { seed } = require('../lib/seed-demo');

let server; let base; let cookie; let token; let dir; let db;

async function req(method, p, body, bot) {
  const headers = { 'content-type': 'application/json' };
  if (bot) { headers.authorization = `Bearer ${token}`; headers['x-bot-name'] = bot; } else { headers.cookie = cookie; headers['x-requested-with'] = 'fetch'; }
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-par-'));
  const db0 = open(path.join(dir, 'billing.db'));
  db0.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)').run('T', 'admin@example.com', hashPassword('test-password-123'), 'admin');
  db0.close();
  const { sheetsFile } = seed(dir);
  db = open(path.join(dir, 'billing.db'));
  // Give the two demo tasks different Office Ally accounts so two bots may run side by side.
  db.prepare("UPDATE tasks SET oa_account = 'OA account B' WHERE id = 2").run();
  const app = createApp({ db, sheets: localAdapter(sheetsFile) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
  token = (await req('POST', '/api/tokens', { name: 'OFFICE-PC' })).data.token;
  for (const id of [1, 2]) {
    await req('POST', `/api/tasks/${id}/check-sheet`);
    const c = await req('POST', `/api/tasks/${id}/confirm`);
    assert.equal(c.status, 200, JSON.stringify(c.data));
  }
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('two bots work two tasks at the same time; neither can take the other\'s', async () => {
  const a = await req('POST', '/api/tasks/1/next', null, 'Bot 1');
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const clash = await req('POST', '/api/tasks/1/next', null, 'Bot 2');
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /being worked by Bot 1/);

  const avail = (await req('GET', '/api/bot/available', null, 'Bot 2')).data;
  assert.equal(avail.find((x) => x.id === 1).available, false);
  assert.equal(avail.find((x) => x.id === 2).available, true);

  const b = await req('POST', '/api/tasks/2/next', null, 'Bot 2');
  assert.equal(b.status, 200, JSON.stringify(b.data));

  // Each records only on its own task.
  const wrong = await req('POST', `/api/tasks/2/rows/${b.data.row_no}/record`, { outcome: 'held', notes: 'Held — x' }, 'Bot 1');
  assert.equal(wrong.status, 409);
  const ok = await req('POST', `/api/tasks/2/rows/${b.data.row_no}/record`, { outcome: 'held', notes: 'Held — x' }, 'Bot 2');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  const status = (await req('GET', '/api/bot-status')).data;
  assert.deepEqual(status.bots.map((x) => [x.bot, x.task]).sort(), [['Bot 1', 1], ['Bot 2', 2]]);
});

test('same Office Ally account or overlapping rows can\'t run in parallel', async () => {
  await req('POST', '/api/tasks/2/release', null, 'Bot 2');
  db.prepare("UPDATE tasks SET oa_account = 'Riverside FM DEMO account' WHERE id = 2").run();
  const r = await req('POST', '/api/tasks/2/next', null, 'Bot 2');
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Office Ally account/);

  // Same tab, overlapping rows (task 3 copies task 1 with another OA account).
  db.prepare("UPDATE tasks SET oa_account = 'OA account B' WHERE id = 2").run();
  const t3 = await req('POST', '/api/tasks', { copy_from: 1 });
  await req('PUT', `/api/tasks/${t3.data.id}`, { oa_account: 'OA account C' });
  await req('POST', `/api/tasks/${t3.data.id}/check-sheet`);
  assert.equal((await req('POST', `/api/tasks/${t3.data.id}/confirm`)).status, 200);
  const o = await req('POST', `/api/tasks/${t3.data.id}/next`, null, 'Bot 3');
  assert.equal(o.status, 409);
  assert.match(o.data.error, /same sheet tab/);
});

test('a person can release a task; a silent bot loses it after 20 minutes', async () => {
  assert.equal((await req('POST', '/api/tasks/1/release')).status, 200);
  const take = await req('POST', '/api/tasks/1/next', null, 'Bot 2');
  assert.equal(take.status, 200, JSON.stringify(take.data));
  assert.equal(take.data.resumed, true, 'picks up the row Bot 1 left unfinished');

  db.prepare("UPDATE tasks SET bot_last_seen = datetime('now', '-30 minutes') WHERE id = 1").run();
  const over = await req('POST', '/api/tasks/1/next', null, 'Bot 1');
  assert.equal(over.status, 200, JSON.stringify(over.data));
});

test('chat: people message the bot, pause it, and resume it in real time', async () => {
  // Task 1 is held by Bot 1 at this point.
  await req('POST', '/api/tasks/1/messages', { body: 'Skip patients with Fidelis today' });
  let hb = (await req('POST', '/api/tasks/1/heartbeat', null, 'Bot 1')).data;
  assert.equal(hb.inbox.length, 1);
  assert.equal(hb.inbox[0].body, 'Skip patients with Fidelis today');
  hb = (await req('POST', '/api/tasks/1/heartbeat', null, 'Bot 1')).data;
  assert.equal(hb.inbox.length, 0, 'each message is delivered once');

  const bad = await req('POST', '/api/tasks/1/messages', { body: 'password: hunter2' });
  assert.equal(bad.status, 422);

  await req('POST', '/api/tasks/1/pause', { note: 'Wait, check row 3 first' });
  const blocked = await req('POST', '/api/tasks/1/next', null, 'Bot 1');
  assert.equal(blocked.status, 423);
  assert.match(blocked.data.error, /paused by T/);
  assert.match(blocked.data.inbox[0].body, /check row 3 first/);

  assert.equal((await req('POST', '/api/tasks/1/messages', { body: 'Got it, waiting.' }, 'Bot 1')).status, 201);
  assert.equal((await req('POST', '/api/tasks/1/messages', { body: 'not mine' }, 'Bot 9')).status, 409, 'only the bot on the task can post');

  // The bot waits; a person's message wakes it up right away.
  const t0 = Date.now();
  const waiting = req('GET', '/api/tasks/1/wait?timeout=30', null, 'Bot 1');
  setTimeout(() => req('POST', '/api/tasks/1/messages', { body: 'Row 3 is fine, carry on' }), 200);
  const woke = (await waiting).data;
  assert.ok(Date.now() - t0 < 5000, 'returns as soon as the message arrives');
  assert.equal(woke.inbox[0].body, 'Row 3 is fine, carry on');
  assert.equal(woke.paused, true);

  const resumed = (await req('POST', '/api/tasks/1/resume')).data;
  assert.equal(resumed.paused, false);
  assert.equal((await req('POST', '/api/tasks/1/next', null, 'Bot 1')).status, 200);

  const all = (await req('GET', '/api/tasks/1/messages')).data.messages;
  assert.deepEqual(all.map((m) => m.sender), ['user', 'system', 'bot', 'user', 'system']);
});

test('deleting a bot token stops it at once and frees its tasks', async () => {
  const list = (await req('GET', '/api/tokens')).data;
  const tok = list.find((x) => x.name === 'OFFICE-PC');
  const d = await req('DELETE', `/api/tokens/${tok.id}`);
  assert.equal(d.status, 200);
  assert.ok(d.data.released_tasks >= 1);
  assert.ok(!(await req('GET', '/api/tokens')).data.some((x) => x.id === tok.id));
  assert.equal((await req('GET', '/api/tasks', null, 'Bot 1')).status, 401, 'token no longer works');
  assert.ok((await req('GET', '/api/tasks/1')).data.bot === null, 'task released');
});

test('Start bot button picks the next free bot name', async () => {
  // Fresh tasks: the earlier tests deleted the token and freed every task.
  const r = await req('POST', '/api/tasks/2/start-bot');
  // In tests the real launcher runs on Linux, so it reports that it only works on Windows.
  assert.equal(r.status, 501);
  assert.match(r.data.prompt, /^You are Bot \d+\. Use the data-entry skill and start task 2\.$/);
});

test('Resume from chat can also clear a login-failed alert', async () => {
  // Use task 2 with a fresh bot token (the earlier test deleted the first one).
  token = (await req('POST', '/api/tokens', { name: 'OFFICE-PC-2' })).data.token;
  await req('POST', '/api/tasks/2/release');
  assert.equal((await req('POST', '/api/tasks/2/next', null, 'Bot 1')).status, 200);
  await req('POST', '/api/tasks/2/alerts', { kind: 'login_failed', message: 'Office Ally login failed twice' }, 'Bot 1');
  await req('POST', '/api/tasks/2/pause', { note: 'hold on' });
  let r = (await req('POST', '/api/tasks/2/resume', {})).data;
  assert.equal(r.paused, true, 'plain resume leaves the alert pause');
  r = (await req('POST', '/api/tasks/2/resume', { resolve_alerts: true })).data;
  assert.equal(r.paused, false);
  assert.equal((await req('POST', '/api/tasks/2/next', null, 'Bot 1')).status, 200);
});

test('record --next: writes the row and hands back the next one in one step', async () => {
  const first = (await req('POST', '/api/tasks/2/next', null, 'Bot 1')).data;
  const r = await req('POST', `/api/tasks/2/rows/${first.row_no}/record`, { outcome: 'held', notes: 'Held — test', then_next: true }, 'Bot 1');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.next, 'next row included');
  assert.ok(r.data.next.done || r.data.next.row_no > first.row_no);
});

test('"load everything" mode: all cards at once, then record rows one by one without next', async () => {
  await req('POST', '/api/tasks/2/release');
  const all = await req('GET', '/api/tasks/2/cards', null, 'Bot 1');
  assert.equal(all.status, 200, JSON.stringify(all.data));
  const rows = all.data.cards.map((c) => c.row_no);
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    const r = await req('POST', `/api/tasks/2/rows/${row}/record`, { outcome: 'held', notes: `Held — test batch ${row}` }, 'Bot 1');
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const again = await req('GET', '/api/tasks/2/cards', null, 'Bot 1');
  assert.equal(again.data.cards.length, 0);
});
