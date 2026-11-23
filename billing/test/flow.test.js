'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open, hashPassword } = require('../lib/db');
const { localAdapter } = require('../lib/sheets');
const { createApp } = require('../server');
const { seed, SHEET_ID } = require('../lib/seed-demo');

let server; let base; let cookie; let token; let dir; let sheetsFile;

async function req(method, p, body, { bot = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (bot) headers.authorization = `Bearer ${token}`;
  else { headers.cookie = cookie || ''; headers['x-requested-with'] = 'fetch'; }
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, res };
}
const sheet = () => JSON.parse(fs.readFileSync(sheetsFile, 'utf8'))[SHEET_ID].tabs;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-test-'));
  const db0 = open(path.join(dir, 'billing.db'));
  db0.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)').run('T', 'admin@example.com', hashPassword('test-password-123'), 'admin');
  db0.close();
  ({ sheetsFile } = seed(dir));
  const db = open(path.join(dir, 'billing.db'));
  const app = createApp({ db, sheets: localAdapter(sheetsFile), log: (e) => console.error(e) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await req('POST', '/api/login', { username: 'admin@example.com', password: 'test-password-123' });
  assert.equal(login.status, 200);
  cookie = login.res.headers.get('set-cookie').split(';')[0];
  const t = await req('POST', '/api/tokens', { name: 'TEST-PC' });
  token = t.data.token;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('rejects writes without the custom header (CSRF guard)', async () => {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('bot cannot see or confirm unconfirmed tasks', async () => {
  const list = await req('GET', '/api/tasks', null, { bot: true });
  assert.equal(list.data.length, 0);
  const c = await req('POST', '/api/tasks/1/confirm', null, { bot: true });
  assert.equal(c.status, 403);
  const n = await req('POST', '/api/tasks/1/next', null, { bot: true });
  assert.equal(n.status, 409);
});

test('confirm refuses until the header check has run', async () => {
  const c = await req('POST', '/api/tasks/1/confirm');
  assert.equal(c.status, 422);
  assert.ok(c.data.problems.some((p) => /header check/.test(p)));
});

test('demo task: header check, confirm, entry cards, record', async () => {
  const chk = await req('POST', '/api/tasks/1/check-sheet');
  assert.equal(chk.status, 200, JSON.stringify(chk.data));
  assert.equal(chk.data.columns.status.letter, 'J');
  assert.equal(chk.data.columns.notes.letter, 'K');
  assert.equal(chk.data.columns.insurance.letter, 'G');
  assert.deepEqual(chk.data.missing, []);
  const conf = await req('POST', '/api/tasks/1/confirm');
  assert.equal(conf.status, 200, JSON.stringify(conf.data));

  // Row 2: Brooks, all good.
  let n = await req('POST', '/api/tasks/1/next', null, { bot: true });
  assert.equal(n.data.row_no, 2);
  assert.equal(n.data.card.blockers.length, 0);
  assert.equal(n.data.card.fields.find((f) => f.field === 'DOB').value, '02/09/1951');
  assert.equal(n.data.card.fields.find((f) => f.field === 'City').value, 'ALBANY');
  assert.equal(n.data.card.insurance.oa_payer_name, 'MEDICARE (EXAMPLE)');

  // Calling next again resumes the same row (one patient at a time).
  const again = await req('POST', '/api/tasks/1/next', null, { bot: true });
  assert.equal(again.data.row_no, 2);
  assert.equal(again.data.resumed, true);

  // Recording another row is refused.
  const wrongRow = await req('POST', '/api/tasks/1/rows/3/record', { outcome: 'held', notes: 'Held — test' }, { bot: true });
  assert.equal(wrongRow.status, 409);

  // Missing checklist is refused.
  const noCheck = await req('POST', '/api/tasks/1/rows/2/record', { outcome: 'demo_done', insurance: 'Medicare' }, { bot: true });
  assert.equal(noCheck.status, 422);
  assert.match(noCheck.data.error, /searched_no_duplicate/);

  // Secondary insurance in the insurance column is refused.
  const sec = await req('POST', '/api/tasks/1/rows/2/record', { outcome: 'demo_done', insurance: 'Medicare / NY Medicaid', checklist: ['searched_no_duplicate', 'eligibility_on_dos', 'entered_and_double_checked', 'appears_in_search'] }, { bot: true });
  assert.equal(sec.status, 422);

  // Password-looking notes are refused.
  const pw = await req('POST', '/api/tasks/1/rows/2/record', { outcome: 'demo_done', insurance: 'Medicare', notes: 'password is x', checklist: ['searched_no_duplicate', 'eligibility_on_dos', 'entered_and_double_checked', 'appears_in_search'] }, { bot: true });
  assert.equal(pw.status, 422);

  const ok = await req('POST', '/api/tasks/1/rows/2/record', { outcome: 'demo_done', insurance: 'Medicare', notes: '', checklist: ['searched_no_duplicate', 'eligibility_on_dos', 'entered_and_double_checked', 'appears_in_search'] }, { bot: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(sheet().Demos[1][9], 'Demo Done');
  assert.equal(sheet().Demos[1][6], 'Medicare');

  // Row 3: Ortiz: old Medicare number and missing gender become todos.
  n = await req('POST', '/api/tasks/1/next', null, { bot: true });
  assert.equal(n.data.row_no, 3);
  assert.ok(n.data.card.todos.some((t) => /not an MBI/.test(t)));
  assert.ok(n.data.card.todos.some((t) => /Gender missing/.test(t)));
  assert.equal(n.data.card.fields.find((f) => f.field === 'Address').value, '45 ELM ST APT 2');
  assert.equal(n.data.card.fields.find((f) => f.field === 'State').value, 'NY');

  // If the sheet is re-sorted, nothing is written.
  const tabs = JSON.parse(fs.readFileSync(sheetsFile, 'utf8'));
  const saved = tabs[SHEET_ID].tabs.Demos[2];
  tabs[SHEET_ID].tabs.Demos[2] = tabs[SHEET_ID].tabs.Demos[3];
  fs.writeFileSync(sheetsFile, JSON.stringify(tabs));
  const moved = await req('POST', '/api/tasks/1/rows/3/record', { outcome: 'already_added', insurance: 'Medicare', checklist: ['found_by_name_and_dob'] }, { bot: true });
  assert.equal(moved.status, 409);
  tabs[SHEET_ID].tabs.Demos[2] = saved;
  fs.writeFileSync(sheetsFile, JSON.stringify(tabs));

  const done = await req('POST', '/api/tasks/1/rows/3/record', { outcome: 'demo_done', insurance: 'Medicare', notes: 'New MBI from Medicare lookup; Gender taken from NGS', checklist: ['searched_no_duplicate', 'eligibility_on_dos', 'entered_and_double_checked', 'appears_in_search'] }, { bot: true });
  assert.equal(done.status, 200, JSON.stringify(done.data));

  // Row 6: insurance name not in payer list blocks the card.
  await req('POST', '/api/tasks/1/next', null, { bot: true });
  await req('POST', '/api/tasks/1/rows/4/record', { outcome: 'already_added', insurance: 'Humana Gold Plus', checklist: ['found_by_name_and_dob'] }, { bot: true });
  await req('POST', '/api/tasks/1/next', null, { bot: true });
  await req('POST', '/api/tasks/1/rows/5/record', { outcome: 'not_eligible', notes: 'Not eligible on DOS - ePACES shows no coverage', checklist: ['searched_no_duplicate', 'eligibility_on_dos'] }, { bot: true });
  assert.equal(sheet().Demos[4][10], 'Not eligible on DOS — ePACES shows no coverage');
  assert.equal(sheet().Demos[4][9], '');
  n = await req('POST', '/api/tasks/1/next', null, { bot: true });
  assert.equal(n.data.row_no, 6);
  assert.ok(n.data.card.blockers.some((b) => /Fidelis Essential/.test(b)));
  const um = await req('GET', '/api/practices/1/unmatched');
  assert.equal(um.data[0].name, 'Fidelis Essential');
  await req('POST', '/api/tasks/1/rows/6/record', { outcome: 'held', notes: 'Held — insurance not in payer list' }, { bot: true });

  // Row 7: no DOS.
  n = await req('POST', '/api/tasks/1/next', null, { bot: true });
  assert.ok(n.data.card.blockers.some((b) => /No DOS/.test(b)));

  const rep = await req('GET', '/api/tasks/1/report', null, { bot: true });
  assert.equal(rep.data.demos.demo_done, 2);
  assert.equal(rep.data.demos.already_added, 1);
  assert.equal(rep.data.held, 1);
  assert.equal(rep.data.last_row_completed, 6);
  assert.equal(rep.data.next_row, 7);
});

test('submission task: holds, NDC, provider, repeated-issue pause', async () => {
  const chk = await req('POST', '/api/tasks/2/check-sheet');
  assert.equal(chk.status, 200, JSON.stringify(chk.data));
  assert.deepEqual(chk.data.missing, []);
  const conf = await req('POST', '/api/tasks/2/confirm');
  assert.equal(conf.status, 200, JSON.stringify(conf.data));
  // The bot still holds task 1 (row 7 unfinished); it must release it before taking another task.
  const busy = await req('POST', '/api/tasks/2/next', null, { bot: true });
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, /already working task #1/);
  assert.equal((await req('POST', '/api/tasks/1/release', null, { bot: true })).status, 200);
  const claimChecks = ['demo_exists', 'insurance_active_on_dos', 'providers_from_task_setup', 'facility_box32_matches', 'line_review_done', 'saved_in_patient_visits_only'];

  // Row 2 passes.
  let n = await req('POST', '/api/tasks/2/next', null, { bot: true });
  assert.equal(n.data.row_no, 2);
  assert.deepEqual(n.data.card.blockers, []);
  assert.equal(n.data.card.facility.name, 'Riverside Clinic');
  const wrongOutcome = await req('POST', '/api/tasks/2/rows/2/record', { outcome: 'claim_created', checklist: claimChecks }, { bot: true });
  assert.equal(wrongOutcome.status, 422);
  let r = await req('POST', '/api/tasks/2/rows/2/record', { outcome: 'submitted', checklist: claimChecks }, { bot: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(sheet()['Only Submission'][1][14], 'Submitted');

  // Row 3: facility mismatch and a J-code without NDC: cannot be submitted.
  n = await req('POST', '/api/tasks/2/next', null, { bot: true });
  assert.equal(n.data.row_no, 3);
  // Not a listed new location: the bot must find the Office Ally location with exactly this address.
  assert.equal(n.data.card.facility.source, 'office_ally');
  assert.equal(n.data.card.facility.address, '210 Main St Ste 4, Albany, NY 12207');
  assert.ok(n.data.card.blockers.some((b) => /NDC/.test(b)), JSON.stringify(n.data.card.blockers));
  r = await req('POST', '/api/tasks/2/rows/3/record', { outcome: 'submitted', checklist: claimChecks }, { bot: true });
  assert.equal(r.status, 409);
  r = await req('POST', '/api/tasks/2/rows/3/record', { outcome: 'held', notes: 'Held - facility address mismatch' }, { bot: true });
  assert.equal(r.status, 200);
  assert.equal(sheet()['Only Submission'][2][15], 'Held — facility address mismatch');

  // Row 4: NDC per line, long-form address still matches.
  n = await req('POST', '/api/tasks/2/next', null, { bot: true });
  assert.equal(n.data.row_no, 4);
  assert.deepEqual(n.data.card.blockers, []);
  assert.equal(n.data.card.lines[1].ndc.entry, 'N400641036721 ML1');
  await req('POST', '/api/tasks/2/rows/4/record', { outcome: 'held', notes: 'Held — facility address mismatch (test)' }, { bot: true });

  // Row 5: other provider.
  n = await req('POST', '/api/tasks/2/next', null, { bot: true });
  assert.ok(n.data.card.blockers.some((b) => /provider is Dr. Lee/.test(b)));
  r = await req('POST', '/api/tasks/2/rows/5/record', { outcome: 'held', notes: 'Held — facility address mismatch' }, { bot: true });
  assert.ok(r.data.stop_and_ask, 'third identical issue pauses the bot');

  const paused = await req('POST', '/api/tasks/2/next', null, { bot: true });
  assert.equal(paused.status, 423);
  const alerts = await req('GET', '/api/alerts');
  const a = alerts.data.find((x) => x.kind === 'repeat_issue');
  await req('POST', `/api/alerts/${a.id}/resolve`, { resolution: 'Sheet typo, fixed' });
  n = await req('POST', '/api/tasks/2/next', null, { bot: true });
  assert.equal(n.data.row_no, 6);
  assert.equal(n.data.card.facility.name, 'Riverside Nursing Center');
});
