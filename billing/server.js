'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { open, tx, hashPassword, verifyPassword, sha256 } = require('./lib/db');
const { createSheets, colToLetter, letterToCol, spreadsheetIdFromLink } = require('./lib/sheets');
const { FIELDS, guessMapping, resolveColumn, missingRequired } = require('./lib/mapping');
const checks = require('./lib/checks');
const rules = require('./lib/rules');

const SESSION_HOURS = 10;
const REPEAT_LIMIT = 3;
const SETUP_FIELDS = ['task_type', 'practice_name', 'provider_name', 'provider_npi', 'billing_npi', 'billing_tax_id', 'facilities',
  'oa_account', 'sheet_link', 'tab_name', 'status_col', 'insurance_col', 'notes_col', 'row_from', 'row_to', 'dos_from', 'dos_to',
  'portals', 'special_instructions', 'extra_drug_codes'];
const SHEET_FIELDS = new Set(['sheet_link', 'tab_name', 'status_col', 'insurance_col', 'notes_col', 'task_type']);

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (msg, extra) => new HttpError(422, msg, extra);

function createApp({ db, sheets, log = () => {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
    });
    next();
  });

  const q = {
    get: (sql, ...a) => db.prepare(sql).get(...a),
    all: (sql, ...a) => db.prepare(sql).all(...a),
    run: (sql, ...a) => db.prepare(sql).run(...a),
  };
  const audit = (entity, id, action, detail, actor) => q.run('INSERT INTO audit (entity, entity_id, action, detail, actor) VALUES (?,?,?,?,?)',
    entity, id, action, detail == null ? null : JSON.stringify(detail), actor);
  const actorName = (req) => (req.user ? `user:${req.user.email}` : `bot:${req.token.name}`);

  // ---------- auth ----------
  const loginFailures = new Map();
  function parseCookies(h) {
    const out = {};
    for (const part of String(h || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  app.use((req, res, next) => {
    const auth = req.get('authorization') || '';
    if (auth.startsWith('Bearer ')) {
      const tok = q.get('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked = 0', sha256(auth.slice(7).trim()));
      if (tok) { req.token = tok; q.run("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?", tok.id); }
      return next();
    }
    const sid = parseCookies(req.get('cookie')).sid;
    if (sid) {
      const row = q.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`, sha256(sid), Date.now());
      if (row) req.user = row;
    }
    next();
  });
  // Session-authenticated writes must carry a custom header (blocks cross-site form posts).
  app.use('/api', (req, res, next) => {
    if (req.user && !['GET', 'HEAD'].includes(req.method) && req.get('x-requested-with') !== 'fetch') {
      return res.status(403).json({ error: 'Missing request header' });
    }
    next();
  });
  const requireAny = (req, res, next) => (req.user || req.token ? next() : res.status(401).json({ error: 'Sign in required' }));
  const requireUser = (req, res, next) => (req.user ? next() : res.status(req.token ? 403 : 401).json({ error: req.token ? 'The bot token cannot do this; a person must.' : 'Sign in required' }));
  const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.post('/api/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const key = `${email}|${req.ip}`;
    const f = loginFailures.get(key) || { n: 0, until: 0 };
    if (f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
    const user = q.get('SELECT * FROM users WHERE email = ? AND active = 1', email);
    if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      f.n += 1;
      if (f.n >= 5) { f.until = Date.now() + 15 * 60000; f.n = 0; }
      loginFailures.set(key, f);
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    loginFailures.delete(key);
    const sid = crypto.randomBytes(32).toString('base64url');
    q.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', sha256(sid), user.id, Date.now() + SESSION_HOURS * 3600000);
    q.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.set('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`);
    audit('user', user.id, 'login', null, `user:${user.email}`);
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  });
  app.post('/api/logout', (req, res) => {
    const sid = parseCookies(req.get('cookie')).sid;
    if (sid) q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(sid));
    res.set('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => {
    if (req.user) return res.json({ id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, sheets_mode: sheets.mode, service_account: sheets.serviceAccountEmail || null });
    if (req.token) return res.json({ bot: true, name: req.token.name, sheets_mode: sheets.mode });
    res.status(401).json({ error: 'Sign in required' });
  });

  // ---------- task helpers ----------
  function hydrate(t) {
    if (!t) return null;
    const task = { ...t, facilities: JSON.parse(t.facilities), portals: JSON.parse(t.portals), header: JSON.parse(t.header), mapping: JSON.parse(t.mapping) };
    for (const c of ['status', 'insurance', 'notes']) {
      const v = task[`${c}_col`];
      task[`${c}_idx`] = /^[A-Z]{1,2}$/.test(v) && task.header_checked_at ? letterToCol(v) : null;
    }
    return task;
  }
  function getTask(id) {
    const t = hydrate(q.get('SELECT * FROM tasks WHERE id = ?', Number(id)));
    if (!t) throw new HttpError(404, 'Task not found');
    return t;
  }
  const payersFor = (practiceId) => q.all('SELECT * FROM payers WHERE practice_id = ? ORDER BY sheet_name', practiceId)
    .map((p) => ({ ...p, aliases: JSON.parse(p.aliases), active: !!p.active }));

  function setupProblems(t) {
    const p = [];
    const need = (v, label) => { if (v == null || String(v).trim() === '') p.push(`${label} is blank`); };
    need(t.task_type, 'Task type'); need(t.practice_name, 'Practice name'); need(t.provider_name, 'Provider name');
    need(t.oa_account, 'Office Ally account / practice'); need(t.sheet_link, 'Google Sheet link'); need(t.tab_name, 'Tab name');
    need(t.status_col, 'Status column'); need(t.insurance_col, 'Insurance column'); need(t.notes_col, 'Notes column');
    if (!checks.isValidNpi(t.provider_npi)) p.push('Provider NPI is missing or fails the NPI check digit');
    if (t.billing_npi && !checks.isValidNpi(t.billing_npi)) p.push('Billing/group NPI fails the NPI check digit');
    if (t.billing_tax_id && !/^\d{2}-?\d{7}$/.test(t.billing_tax_id)) p.push('Billing Tax ID must be 9 digits');
    if (t.task_type !== 'demo') {
      if (!t.facilities.length) p.push('Add at least one facility (name and address)');
      t.facilities.forEach((f, i) => { if (!f.name || !f.address) p.push(`Facility ${i + 1} needs both a name and an address`); });
    }
    if (!spreadsheetIdFromLink(t.sheet_link)) p.push('Google Sheet link is not a valid sheet link');
    if (!(t.row_from >= 2) || !(t.row_to >= t.row_from)) p.push('Rows to work: "from" must be 2 or more and "to" not before "from"');
    else if (t.row_to - t.row_from > 2000) p.push('Rows to work: at most 2000 rows per task');
    if (t.dos_from && !checks.parseDate(t.dos_from)) p.push('DOS from is not a valid date');
    if (t.dos_to && !checks.parseDate(t.dos_to)) p.push('DOS to is not a valid date');
    if (!t.portals.length) p.push('Portals needed: tick at least one');
    if (!t.header_checked_at) p.push('Run the sheet header check');
    else {
      const idx = [t.status_idx, t.insurance_idx, t.notes_idx];
      if (idx.some((x) => x == null)) p.push('Status, Insurance and Notes columns must match the header row');
      else if (new Set(idx).size !== 3) p.push('Status, Insurance and Notes must be three different columns');
      for (const m of missingRequired(t.task_type, t.mapping)) p.push(`Match a sheet column for: ${m}`);
    }
    return p;
  }

  function scopeOf(task, cells) {
    const ident = checks.rowIdentity(cells, task.mapping);
    if (!ident.replace(/\|/g, '').trim()) return { in_scope: false, reason: 'Blank row' };
    const dos = checks.parseDate(checks.cell(cells, task.mapping, 'dos'));
    if (dos && !checks.inDosRange(dos, task)) return { in_scope: false, reason: 'DOS outside the task date range' };
    return { in_scope: true };
  }

  function cardFor(task, cells) {
    return task.task_type === 'demo' ? checks.demoCard(cells, task, payersFor(task.practice_id)) : checks.claimCheck(cells, task);
  }

  async function readRows(task, from, to) {
    const rows = await sheets.readRange(task.spreadsheet_id, task.tab_name, `A${from}:ZZ${to}`);
    const out = [];
    for (let n = from; n <= to; n++) out.push({ row_no: n, cells: rows[n - from] || [] });
    return out;
  }
  async function loadRows(task) {
    const rows = await readRows(task, task.row_from, task.row_to);
    tx(db, () => {
      q.run('DELETE FROM task_rows WHERE task_id = ?', task.id);
      for (const r of rows) q.run('INSERT INTO task_rows (task_id, row_no, cells) VALUES (?,?,?)', task.id, r.row_no, JSON.stringify(r.cells));
      q.run("UPDATE tasks SET rows_loaded_at = datetime('now') WHERE id = ?", task.id);
    });
    return rows;
  }
  const cachedRow = (taskId, rowNo) => {
    const r = q.get('SELECT cells FROM task_rows WHERE task_id = ? AND row_no = ?', taskId, rowNo);
    return r ? JSON.parse(r.cells) : null;
  };
  const latestRecords = (taskId) => {
    const map = new Map();
    for (const r of q.all('SELECT * FROM records WHERE task_id = ? ORDER BY id', taskId)) map.set(r.row_no, r);
    return map;
  };
  const allowedOutcomes = (task) => Object.keys(rules.OUTCOMES).filter((o) => rules.OUTCOMES[o].types.includes(task.task_type))
    .map((o) => ({ outcome: o, status: rules.OUTCOMES[o].status, checklist: rules.checklistFor(o) }));

  function publicTask(t) {
    const recs = q.get(`SELECT COUNT(DISTINCT row_no) AS worked FROM records WHERE task_id = ?`, t.id).worked;
    const byOutcome = {};
    for (const r of latestRecords(t.id).values()) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
    const total = q.get('SELECT COUNT(*) AS n FROM task_rows WHERE task_id = ?', t.id).n;
    return { ...t, worked: recs, outcomes: byOutcome, rows_total: total, problems: t.state === 'setup' ? setupProblems(t) : [],
      open_alerts: q.get('SELECT COUNT(*) AS n FROM alerts WHERE task_id = ? AND resolved = 0', t.id).n };
  }

  // ---------- tasks ----------
  app.get('/api/tasks', requireAny, (req, res) => {
    const rows = req.token
      ? q.all("SELECT * FROM tasks WHERE state = 'confirmed' ORDER BY id DESC")
      : q.all('SELECT * FROM tasks ORDER BY id DESC LIMIT 200');
    res.json(rows.map(hydrate).map(publicTask));
  });

  app.post('/api/tasks', requireUser, (req, res) => {
    const b = req.body || {};
    let src = {};
    if (b.copy_from) {
      const from = getTask(b.copy_from);
      for (const f of SETUP_FIELDS) src[f] = from[f];
      src.facilities = JSON.stringify(from.facilities); src.portals = JSON.stringify(from.portals);
    }
    const id = tx(db, () => {
      const r = q.run(`INSERT INTO tasks (task_type, created_by, copied_from) VALUES (?,?,?)`, b.task_type || src.task_type || 'demo', req.user.id, b.copy_from || null);
      const taskId = Number(r.lastInsertRowid);
      if (b.copy_from) applySetup(taskId, src, true);
      return taskId;
    });
    audit('task', id, 'create', b.copy_from ? { copied_from: b.copy_from } : null, actorName(req));
    res.status(201).json(publicTask(getTask(id)));
  });

  function applySetup(id, body, raw) {
    const cur = getTask(id);
    const sets = [];
    const vals = [];
    let sheetChanged = false;
    for (const f of SETUP_FIELDS) {
      if (!(f in body)) continue;
      let v = body[f];
      if (f === 'facilities') {
        v = raw ? v : JSON.stringify((Array.isArray(v) ? v : []).map((x) => ({ name: String(x.name || '').trim(), address: String(x.address || '').trim() })).filter((x) => x.name || x.address));
      } else if (f === 'portals') {
        v = raw ? v : JSON.stringify((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean));
      } else if (f === 'row_from' || f === 'row_to') {
        v = v === '' || v == null ? null : Number(v);
      } else if (f === 'dos_from' || f === 'dos_to') {
        v = v ? (checks.parseDate(v) || String(v)) : '';
      } else if (f === 'task_type') {
        if (!['demo', 'claim', 'submission'].includes(v)) throw bad('Task type must be demo, claim or submission');
      } else v = String(v == null ? '' : v).trim();
      if (SHEET_FIELDS.has(f) && String(cur[f]) !== String(v)) sheetChanged = true;
      sets.push(`${f} = ?`); vals.push(v);
    }
    if ('practice_name' in body) {
      const name = String(body.practice_name || '').trim();
      if (name) {
        q.run('INSERT OR IGNORE INTO practices (name) VALUES (?)', name);
        sets.push('practice_id = ?'); vals.push(q.get('SELECT id FROM practices WHERE name = ?', name).id);
      }
    }
    if ('sheet_link' in body) { sets.push('spreadsheet_id = ?'); vals.push(spreadsheetIdFromLink(body.sheet_link) || ''); }
    if (sheetChanged) sets.push("header = '[]'", 'header_checked_at = NULL', "mapping = '{}'");
    if (sets.length) q.run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...vals, id);
  }

  app.get('/api/tasks/:id', requireAny, (req, res) => {
    const t = getTask(req.params.id);
    if (req.token && t.state !== 'confirmed') throw new HttpError(403, 'This task is not confirmed for the bot yet');
    const alerts = q.all('SELECT * FROM alerts WHERE task_id = ? ORDER BY id DESC LIMIT 50', t.id);
    res.json({ ...publicTask(t), alerts, outcomes_allowed: allowedOutcomes(t), fields: FIELDS.map((f) => ({ key: f.key, label: f.label })) });
  });

  app.put('/api/tasks/:id', requireUser, (req, res) => {
    const t = getTask(req.params.id);
    if (t.state !== 'setup') throw bad('Setup is locked after confirmation. Use "Edit setup" first.');
    applySetup(t.id, req.body || {}, false);
    audit('task', t.id, 'setup_update', Object.keys(req.body || {}), actorName(req));
    res.json(publicTask(getTask(t.id)));
  });

  app.post('/api/tasks/:id/check-sheet', requireUser, wrap(async (req, res) => {
    const t = getTask(req.params.id);
    if (t.state !== 'setup') throw bad('Setup is locked after confirmation.');
    if (!t.spreadsheet_id) throw bad('Enter a valid Google Sheet link first');
    const tabs = await sheets.listTabs(t.spreadsheet_id);
    if (!t.tab_name) return res.json({ tabs, header: [], columns: {}, mapping: {}, missing: [] });
    if (!tabs.includes(t.tab_name)) throw bad(`Tab "${t.tab_name}" is not in this sheet`, { tabs });
    const header = ((await sheets.readRange(t.spreadsheet_id, t.tab_name, 'A1:ZZ1'))[0] || []).map((h) => String(h).trim());
    const columns = {};
    for (const c of ['status', 'insurance', 'notes']) columns[c] = resolveColumn(header, t[`${c}_col`]);
    const exclude = new Set(Object.values(columns).filter((c) => c.idx != null).map((c) => c.idx));
    const mapping = req.body && req.body.mapping ? sanitizeMapping(req.body.mapping, header) : guessMapping(header, exclude);
    for (const c of ['status', 'notes']) if (columns[c].idx != null) for (const k of Object.keys(mapping)) if (mapping[k] === columns[c].idx) delete mapping[k];
    const resolvedCols = {};
    for (const c of ['status', 'insurance', 'notes']) if (columns[c].idx != null) resolvedCols[`${c}_col`] = columns[c].letter;
    q.run(`UPDATE tasks SET header = ?, mapping = ?, header_checked_at = datetime('now')${Object.keys(resolvedCols).map((k) => `, ${k} = ?`).join('')} WHERE id = ?`,
      JSON.stringify(header), JSON.stringify(mapping), ...Object.values(resolvedCols), t.id);
    audit('task', t.id, 'header_check', { columns }, actorName(req));
    res.json({ tabs, header: header.map((h, i) => ({ letter: colToLetter(i), header: h })), columns, mapping, missing: missingRequired(t.task_type, mapping), task: publicTask(getTask(t.id)) });
  }));

  function sanitizeMapping(m, header) {
    const out = {};
    for (const f of FIELDS) {
      const v = m[f.key];
      if (v === '' || v == null) continue;
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0 && n < header.length) out[f.key] = n;
    }
    return out;
  }

  app.put('/api/tasks/:id/mapping', requireUser, (req, res) => {
    const t = getTask(req.params.id);
    if (t.state !== 'setup') throw bad('Setup is locked after confirmation.');
    if (!t.header_checked_at) throw bad('Run the sheet header check first');
    q.run('UPDATE tasks SET mapping = ? WHERE id = ?', JSON.stringify(sanitizeMapping(req.body.mapping || {}, t.header)), t.id);
    res.json(publicTask(getTask(t.id)));
  });

  app.post('/api/tasks/:id/confirm', requireUser, wrap(async (req, res) => {
    const t = getTask(req.params.id);
    if (t.state !== 'setup') throw bad('Task is already confirmed or closed');
    const problems = setupProblems(t);
    if (problems.length) throw bad('Task Setup is not complete', { problems });
    // Re-read the header now: it must still be the one the user looked at.
    const header = ((await sheets.readRange(t.spreadsheet_id, t.tab_name, 'A1:ZZ1'))[0] || []).map((h) => String(h).trim());
    if (JSON.stringify(header) !== JSON.stringify(t.header)) throw bad('The sheet header row changed since the check. Run the header check again.');
    await loadRows(t);
    q.run("UPDATE tasks SET state = 'confirmed', confirmed_by = ?, confirmed_at = datetime('now'), bot_paused = 0 WHERE id = ?", req.user.id, t.id);
    audit('task', t.id, 'confirm', null, actorName(req));
    res.json(publicTask(getTask(t.id)));
  }));

  app.post('/api/tasks/:id/edit-setup', requireUser, (req, res) => {
    const t = getTask(req.params.id);
    if (t.state !== 'confirmed') throw bad('Only a confirmed task can go back to setup');
    q.run("UPDATE tasks SET state = 'setup', current_row = NULL, bot_paused = 1 WHERE id = ?", t.id);
    audit('task', t.id, 'edit_setup', null, actorName(req));
    res.json(publicTask(getTask(t.id)));
  });

  app.post('/api/tasks/:id/close', requireUser, (req, res) => {
    const t = getTask(req.params.id);
    q.run("UPDATE tasks SET state = 'closed', current_row = NULL, closed_at = datetime('now') WHERE id = ?", t.id);
    audit('task', t.id, 'close', null, actorName(req));
    res.json(publicTask(getTask(t.id)));
  });

  app.post('/api/tasks/:id/reload', requireUser, wrap(async (req, res) => {
    const t = getTask(req.params.id);
    if (t.state !== 'confirmed') throw bad('Task is not confirmed');
    await loadRows(t);
    res.json({ ok: true });
  }));

  app.get('/api/tasks/:id/rows', requireAny, (req, res) => {
    const t = getTask(req.params.id);
    const latest = latestRecords(t.id);
    const rows = q.all('SELECT * FROM task_rows WHERE task_id = ? ORDER BY row_no', t.id).map((r) => {
      const cells = JSON.parse(r.cells);
      const scope = scopeOf(t, cells);
      const name = checks.patientName(cells, t.mapping);
      const out = {
        row_no: r.row_no, patient: name.unsplit || [name.last, name.first].filter(Boolean).join(', '),
        dob: checks.cell(cells, t.mapping, 'dob'), dos: checks.cell(cells, t.mapping, 'dos'), ...scope,
        sheet_status: t.status_idx != null ? String(cells[t.status_idx] || '') : '',
        sheet_notes: t.notes_idx != null ? String(cells[t.notes_idx] || '') : '',
        current: t.current_row === r.row_no,
      };
      if (scope.in_scope) {
        const card = cardFor(t, cells);
        out.blockers = card.blockers;
        out.warnings = card.warnings.length;
        if (card.kind === 'claim') {
          const by = (name) => (card.checks.find((c) => c.check === name) || {}).ok;
          out.provider_ok = by('Provider'); out.facility_ok = by('Facility address');
          const drug = card.lines.filter((l) => l.drug);
          out.ndc = drug.length === 0 ? 'n/a' : drug.every((l) => l.ndc) ? 'ok' : 'missing';
        } else out.todos = card.todos.length;
      }
      const rec = latest.get(r.row_no);
      if (rec) out.record = { outcome: rec.outcome, status_text: rec.status_text, notes: rec.notes, actor: rec.actor, at: rec.created_at };
      return out;
    });
    res.json(rows);
  });

  app.get('/api/tasks/:id/rows/:row', requireAny, (req, res) => {
    const t = getTask(req.params.id);
    const rowNo = Number(req.params.row);
    const cells = cachedRow(t.id, rowNo);
    if (!cells) throw new HttpError(404, 'Row is not in this task');
    res.json({
      row_no: rowNo, ...scopeOf(t, cells),
      cells: t.header.map((h, i) => ({ letter: colToLetter(i), header: h, value: String(cells[i] == null ? '' : cells[i]) })),
      card: cardFor(t, cells),
      records: q.all('SELECT id, outcome, status_text, insurance, notes, checklist, actor, created_at FROM records WHERE task_id = ? AND row_no = ? ORDER BY id', t.id, rowNo),
      outcomes_allowed: allowedOutcomes(t),
      current: t.current_row === rowNo,
    });
  });

  function openPausingAlerts(taskId) {
    return q.all("SELECT * FROM alerts WHERE task_id = ? AND resolved = 0 AND kind IN ('repeat_issue','login_failed','error')", taskId);
  }

  app.post('/api/tasks/:id/next', requireAny, wrap(async (req, res) => {
    const t = getTask(req.params.id);
    if (t.state !== 'confirmed') throw new HttpError(409, 'Task is not confirmed. A person must confirm the Task Setup first.');
    if (t.bot_paused) {
      const alerts = openPausingAlerts(t.id);
      throw new HttpError(423, 'Paused: stop and ask the user. ' + alerts.map((a) => a.message).join(' / '), { alerts });
    }
    q.run("UPDATE tasks SET bot_last_seen = datetime('now') WHERE id = ?", t.id);
    const latest = latestRecords(t.id);
    let candidates;
    if (t.current_row && !latest.has(t.current_row)) candidates = [t.current_row];
    else candidates = q.all('SELECT row_no FROM task_rows WHERE task_id = ? ORDER BY row_no', t.id).map((r) => r.row_no).filter((n) => !latest.has(n));
    for (const rowNo of candidates) {
      const [fresh] = await readRows(t, rowNo, rowNo);
      const cached = cachedRow(t.id, rowNo);
      if (cached && checks.rowIdentity(cached, t.mapping) !== checks.rowIdentity(fresh.cells, t.mapping)) {
        throw new HttpError(409, `Row ${rowNo} changed in the sheet (different patient). The sheet may have been re-sorted. Ask the user to reload the task rows.`);
      }
      q.run('UPDATE task_rows SET cells = ? WHERE task_id = ? AND row_no = ?', JSON.stringify(fresh.cells), t.id, rowNo);
      const scope = scopeOf(t, fresh.cells);
      if (!scope.in_scope) continue;
      const resumed = t.current_row === rowNo;
      q.run("UPDATE tasks SET current_row = ?, current_row_started_at = CASE WHEN current_row = ? THEN current_row_started_at ELSE datetime('now') END WHERE id = ?", rowNo, rowNo, t.id);
      return res.json({ done: false, resumed, row_no: rowNo, card: cardFor(t, fresh.cells), outcomes_allowed: allowedOutcomes(t), special_instructions: t.special_instructions });
    }
    q.run('UPDATE tasks SET current_row = NULL WHERE id = ?', t.id);
    res.json({ done: true, message: 'Every in-scope row has an outcome. Give the user the end-of-session report.' });
  }));

  app.post('/api/tasks/:id/rows/:row/record', requireAny, wrap(async (req, res) => {
    const t = getTask(req.params.id);
    const rowNo = Number(req.params.row);
    const b = req.body || {};
    if (t.state !== 'confirmed') throw new HttpError(409, 'Task is not confirmed');
    if (req.token && t.current_row !== rowNo) throw new HttpError(409, t.current_row ? `Finish row ${t.current_row} first (one patient at a time).` : 'Call "next" to start a row before recording it.');
    const latest = latestRecords(t.id).get(rowNo);
    if (latest && !(req.user && b.correction)) throw new HttpError(409, `Row ${rowNo} already has an outcome (${latest.outcome}). A person can record a correction in the app.`);
    const cached = cachedRow(t.id, rowNo);
    if (!cached) throw new HttpError(404, 'Row is not in this task');

    const [fresh] = await readRows(t, rowNo, rowNo);
    if (checks.rowIdentity(cached, t.mapping) !== checks.rowIdentity(fresh.cells, t.mapping)) {
      throw new HttpError(409, `Row ${rowNo} in the sheet now shows a different patient. Nothing was written. Reload the task rows and check the sheet.`);
    }
    const precheck = cardFor(t, fresh.cells);
    const checklist = Array.isArray(b.checklist) ? b.checklist : String(b.checklist || '').split(',').map((x) => x.trim()).filter(Boolean);
    const v = rules.validateRecord({ task: t, outcome: b.outcome, insurance: b.insurance, notes: b.notes, checklist, precheck: t.task_type === 'demo' ? null : precheck, payers: payersFor(t.practice_id) });

    const writes = [];
    if (v.status) writes.push({ row: rowNo, col: t.status_idx, value: v.status });
    if (v.insurance) writes.push({ row: rowNo, col: t.insurance_idx, value: v.insurance });
    const existingNotes = String(fresh.cells[t.notes_idx] || '');
    const mergedNotes = rules.mergeNotes(existingNotes, v.notes);
    if (mergedNotes !== existingNotes) writes.push({ row: rowNo, col: t.notes_idx, value: mergedNotes });
    if (writes.length) await sheets.writeCells(t.spreadsheet_id, t.tab_name, writes);

    const newCells = [...fresh.cells];
    for (const w of writes) { while (newCells.length <= w.col) newCells.push(''); newCells[w.col] = w.value; }
    let stop = null;
    tx(db, () => {
      q.run(`INSERT INTO records (task_id, row_no, outcome, status_text, insurance, notes, checklist, actor, user_id, token_id, started_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, t.id, rowNo, b.outcome, v.status, v.insurance, v.notes, JSON.stringify(checklist),
      req.token ? 'bot' : 'user', req.user ? req.user.id : null, req.token ? req.token.id : null, t.current_row === rowNo ? t.current_row_started_at : null);
      q.run('UPDATE task_rows SET cells = ? WHERE task_id = ? AND row_no = ?', JSON.stringify(newCells), t.id, rowNo);
      if (t.current_row === rowNo) q.run("UPDATE tasks SET current_row = NULL, bot_last_seen = datetime('now') WHERE id = ?", t.id);
      if (b.outcome === 'held' || b.outcome === 'not_eligible') {
        for (const part of v.notes.split(';').map((x) => x.trim()).filter(Boolean)) {
          const key = rules.issueKey(part);
          const rowsWith = [...latestRecords(t.id).values()].filter((r) => r.notes.split(';').some((n) => rules.issueKey(n) === key)).map((r) => r.row_no);
          const seen = q.get('SELECT id FROM alerts WHERE task_id = ? AND kind = ? AND issue_key = ?', t.id, 'repeat_issue', key);
          if (rowsWith.length >= REPEAT_LIMIT && !seen) {
            const msg = `Same issue on ${rowsWith.length} rows (${rowsWith.join(', ')}): "${part.replace(/\s*\(.*?\)\s*$/, '')}". It may be a sheet or Task Setup problem.`;
            q.run('INSERT INTO alerts (task_id, kind, message, issue_key, row_no) VALUES (?,?,?,?,?)', t.id, 'repeat_issue', msg, key, rowNo);
            q.run('UPDATE tasks SET bot_paused = 1 WHERE id = ?', t.id);
            stop = msg;
          }
        }
      }
      audit('row', rowNo, 'record', { task: t.id, outcome: b.outcome, writes: writes.map((w) => colToLetter(w.col)) }, actorName(req));
    });
    res.json({
      ok: true, row_no: rowNo, written: writes.map((w) => ({ cell: `${colToLetter(w.col)}${w.row}`, value: w.value })),
      stop_and_ask: stop,
    });
  }));

  app.post('/api/tasks/:id/alerts', requireAny, (req, res) => {
    const t = getTask(req.params.id);
    const kind = String(req.body.kind || '');
    if (!['otp', 'login_failed', 'question', 'error'].includes(kind)) throw bad('kind must be otp, login_failed, question or error');
    const message = String(req.body.message || '').trim().slice(0, 1000);
    if (!message) throw bad('message is required');
    if (/\b(password|passwd|pwd|passcode)\b\s*[:=]/i.test(message)) throw bad('Never write passwords anywhere.');
    const r = q.run('INSERT INTO alerts (task_id, kind, message, row_no) VALUES (?,?,?,?)', t.id, kind, message, req.body.row ? Number(req.body.row) : null);
    if (kind === 'login_failed' || kind === 'error') q.run('UPDATE tasks SET bot_paused = 1 WHERE id = ?', t.id);
    audit('alert', Number(r.lastInsertRowid), 'create', { task: t.id, kind }, actorName(req));
    res.status(201).json({ id: Number(r.lastInsertRowid), paused: kind === 'login_failed' || kind === 'error' });
  });

  app.get('/api/alerts', requireUser, (req, res) => {
    res.json(q.all(`SELECT a.*, t.practice_name, t.task_type FROM alerts a JOIN tasks t ON t.id = a.task_id
      WHERE a.resolved = 0 ORDER BY a.id DESC LIMIT 100`));
  });
  app.post('/api/alerts/:id/resolve', requireUser, (req, res) => {
    const a = q.get('SELECT * FROM alerts WHERE id = ?', Number(req.params.id));
    if (!a) throw new HttpError(404, 'Alert not found');
    q.run("UPDATE alerts SET resolved = 1, resolution = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?", String(req.body.resolution || '').slice(0, 1000), req.user.id, a.id);
    if (!openPausingAlerts(a.task_id).length) q.run('UPDATE tasks SET bot_paused = 0 WHERE id = ?', a.task_id);
    audit('alert', a.id, 'resolve', null, actorName(req));
    res.json({ ok: true });
  });

  app.post('/api/tasks/:id/heartbeat', requireAny, (req, res) => {
    const t = getTask(req.params.id);
    q.run("UPDATE tasks SET bot_last_seen = datetime('now') WHERE id = ?", t.id);
    res.json({ ok: true, paused: !!t.bot_paused, current_row: t.current_row });
  });

  app.get('/api/tasks/:id/report', requireAny, (req, res) => {
    const t = getTask(req.params.id);
    const records = q.all('SELECT * FROM records WHERE task_id = ? ORDER BY id', t.id);
    const alerts = q.all('SELECT * FROM alerts WHERE task_id = ?', t.id);
    const inScope = q.all('SELECT * FROM task_rows WHERE task_id = ? ORDER BY row_no', t.id)
      .filter((r) => scopeOf(t, JSON.parse(r.cells)).in_scope).map((r) => r.row_no);
    const report = rules.buildReport(t, records, alerts, inScope);
    const timed = q.all(`SELECT (julianday(created_at) - julianday(started_at)) * 86400 AS secs FROM records
      WHERE task_id = ? AND started_at IS NOT NULL AND actor = 'bot'`, t.id).map((r) => r.secs).filter((x) => x > 0);
    report.avg_seconds_per_row = timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
    res.json({ ...report, text: rules.reportText(report) });
  });

  // ---------- practices & payer lists ----------
  app.get('/api/practices', requireUser, (req, res) => res.json(q.all('SELECT * FROM practices ORDER BY name')));
  app.get('/api/practices/:id/payers', requireAny, (req, res) => res.json(payersFor(Number(req.params.id))));

  function payerBody(b) {
    const plan = String(b.plan_type || '');
    if (!['medicare', 'advantage', 'medicaid', 'medicaid_mco', 'commercial', 'other'].includes(plan)) throw bad('Pick a plan type');
    const out = {
      aliases: JSON.stringify(String(Array.isArray(b.aliases) ? b.aliases.join(',') : b.aliases || '').split(',').map((x) => x.trim()).filter(Boolean)),
      oa_payer_name: String(b.oa_payer_name || '').trim(), payer_id: String(b.payer_id || '').trim(), plan_type: plan,
      portal: String(b.portal || '').trim(), sheet_name: String(b.sheet_name || '').trim(),
    };
    if (!out.oa_payer_name || !out.payer_id || !out.sheet_name) throw bad('Office Ally payer, payer ID and sheet insurance name are required');
    return out;
  }
  app.post('/api/practices/:id/payers', requireUser, (req, res) => {
    const p = payerBody(req.body || {});
    const pid = Number(req.params.id);
    if (!q.get('SELECT id FROM practices WHERE id = ?', pid)) throw new HttpError(404, 'Practice not found');
    const r = q.run('INSERT INTO payers (practice_id, aliases, oa_payer_name, payer_id, plan_type, portal, sheet_name, updated_by) VALUES (?,?,?,?,?,?,?,?)',
      pid, p.aliases, p.oa_payer_name, p.payer_id, p.plan_type, p.portal, p.sheet_name, req.user.id);
    audit('payer', Number(r.lastInsertRowid), 'create', p, actorName(req));
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  app.put('/api/payers/:id', requireUser, (req, res) => {
    const cur = q.get('SELECT * FROM payers WHERE id = ?', Number(req.params.id));
    if (!cur) throw new HttpError(404, 'Payer not found');
    const p = payerBody({ ...cur, aliases: JSON.parse(cur.aliases), ...req.body });
    const active = req.body.active == null ? cur.active : (req.body.active ? 1 : 0);
    q.run("UPDATE payers SET aliases=?, oa_payer_name=?, payer_id=?, plan_type=?, portal=?, sheet_name=?, active=?, updated_by=?, updated_at=datetime('now') WHERE id=?",
      p.aliases, p.oa_payer_name, p.payer_id, p.plan_type, p.portal, p.sheet_name, active, req.user.id, cur.id);
    audit('payer', cur.id, 'update', { before: cur, after: { ...p, active } }, actorName(req));
    res.json({ ok: true });
  });
  app.get('/api/practices/:id/unmatched', requireUser, (req, res) => {
    const pid = Number(req.params.id);
    const payers = payersFor(pid);
    const found = new Map();
    for (const t of q.all("SELECT * FROM tasks WHERE practice_id = ? AND state = 'confirmed' AND task_type = 'demo'", pid).map(hydrate)) {
      if (t.insurance_idx == null) continue;
      const done = latestRecords(t.id);
      for (const r of q.all('SELECT * FROM task_rows WHERE task_id = ?', t.id)) {
        if (done.has(r.row_no)) continue;
        const v = String(JSON.parse(r.cells)[t.insurance_idx] || '').trim();
        if (!v || checks.findPayer(payers, v)) continue;
        if (!found.has(v.toLowerCase())) found.set(v.toLowerCase(), { name: v, rows: [] });
        found.get(v.toLowerCase()).rows.push({ task: t.id, row: r.row_no });
      }
    }
    res.json([...found.values()]);
  });

  // ---------- users & bot tokens ----------
  app.get('/api/users', requireAdmin, (req, res) => res.json(q.all('SELECT id, name, email, role, active, created_at FROM users ORDER BY name')));
  app.post('/api/users', requireAdmin, (req, res) => {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || String(password || '').length < 10) throw bad('Name, email and a password of at least 10 characters are required');
    if (!['admin', 'staff'].includes(role)) throw bad('Role must be admin or staff');
    try {
      const r = q.run('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)', String(name).trim(), String(email).trim().toLowerCase(), hashPassword(password), role);
      audit('user', Number(r.lastInsertRowid), 'create', { email, role }, actorName(req));
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw bad('A user with that email already exists');
      throw e;
    }
  });
  app.put('/api/users/:id', requireAdmin, (req, res) => {
    const u = q.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!u) throw new HttpError(404, 'User not found');
    const b = req.body || {};
    if (b.password != null) {
      if (String(b.password).length < 10) throw bad('Password must be at least 10 characters');
      q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(b.password), u.id);
      q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    }
    if (b.active != null) {
      if (u.id === req.user.id && !b.active) throw bad('You cannot deactivate yourself');
      q.run('UPDATE users SET active = ? WHERE id = ?', b.active ? 1 : 0, u.id);
      if (!b.active) q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    }
    if (b.role && ['admin', 'staff'].includes(b.role) && u.id !== req.user.id) q.run('UPDATE users SET role = ? WHERE id = ?', b.role, u.id);
    audit('user', u.id, 'update', { active: b.active, role: b.role, password_changed: b.password != null }, actorName(req));
    res.json({ ok: true });
  });
  app.get('/api/tokens', requireAdmin, (req, res) => res.json(q.all('SELECT id, name, created_at, last_used_at, revoked FROM api_tokens ORDER BY id DESC')));
  app.post('/api/tokens', requireAdmin, (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) throw bad('Give the token a name (for example the bot PC name)');
    const token = 'bct_' + crypto.randomBytes(32).toString('base64url');
    const r = q.run('INSERT INTO api_tokens (name, token_hash, created_by) VALUES (?,?,?)', name, sha256(token), req.user.id);
    audit('token', Number(r.lastInsertRowid), 'create', { name }, actorName(req));
    res.status(201).json({ id: Number(r.lastInsertRowid), name, token });
  });
  app.post('/api/tokens/:id/revoke', requireAdmin, (req, res) => {
    q.run('UPDATE api_tokens SET revoked = 1 WHERE id = ?', Number(req.params.id));
    audit('token', Number(req.params.id), 'revoke', null, actorName(req));
    res.json({ ok: true });
  });
  app.get('/api/bot-status', requireUser, (req, res) => {
    const tok = q.get('SELECT name, last_used_at FROM api_tokens WHERE revoked = 0 AND last_used_at IS NOT NULL ORDER BY last_used_at DESC LIMIT 1');
    const working = q.get("SELECT id, current_row, current_row_started_at, bot_paused FROM tasks WHERE state = 'confirmed' AND current_row IS NOT NULL ORDER BY current_row_started_at DESC LIMIT 1");
    const today = q.all(`SELECT outcome, COUNT(*) AS n FROM records WHERE date(created_at) = date('now') GROUP BY outcome`);
    res.json({ token: tok || null, working: working || null, today });
  });

  // ---------- static UI ----------
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) log(err);
    res.status(status).json({ error: status >= 500 && !err.status ? 'Server error' : err.message, ...(err.extra || {}) });
  });
  return app;
}

function ensureAdmin(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return null;
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)').run('Admin', email, hashPassword(password), 'admin');
  return { email, password, generated: !process.env.ADMIN_PASSWORD };
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const db = open(path.join(dataDir, 'billing.db'));
  const sheets = createSheets(process.env, dataDir);
  const created = ensureAdmin(db);
  if (created) {
    console.log(`Created first admin: ${created.email}${created.generated ? ` / password: ${created.password} (change it after signing in)` : ''}`);
  }
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  createApp({ db, sheets, log: (e) => console.error(e) }).listen(port, host, () => {
    console.log(`Billing Control on http://${host}:${port} · sheets: ${sheets.mode}${sheets.mode === 'local' ? ' (local test sheets, fake data only)' : ` (${sheets.serviceAccountEmail})`}`);
  });
}

module.exports = { createApp, ensureAdmin };
