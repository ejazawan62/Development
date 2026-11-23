'use strict';
/* Billing Control web UI. Vanilla JS; every value is inserted as text (never as HTML). */

const $app = document.getElementById('app');
let ME = null;

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else if (k === 'width') el.style.width = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && ME && path !== '/api/login') { ME = null; render(); throw new Error('Signed out'); }
  if (!res.ok) { const e = new Error(data.error || `Error ${res.status}`); e.data = data; throw e; }
  return data;
}
const TYPE = { demo: 'Demo creation', claim: 'Claim creation', submission: 'Claim submission' };
const OUTCOME_LABEL = { demo_done: 'Demo Done', already_added: 'Already demo added', not_eligible: 'Not eligible on DOS', claim_created: 'Claim Created', submitted: 'Submitted', held: 'Held' };
const STANDARD_NOTES = {
  demo: ['Not eligible on DOS — ', 'Member ID not found in ', 'Gender taken from ', 'New MBI from Medicare lookup', 'Medicaid ID from ', 'Medicare Advantage —  is primary', 'Held — insurance not in payer list', 'Portal login failed — waiting for user'],
  claim: ['Held — provider is , not the assigned provider', 'Held — facility address mismatch', 'Held — NDC missing', "Held — CPT/units don't match sheet", 'Held — demo not found', 'Held — not eligible on DOS'],
};
function errorBox(e) {
  const lines = [e.message];
  if (e.data && e.data.problems) lines.push(...e.data.problems.map((p) => `• ${p}`));
  return h('div', { class: 'error', role: 'alert' }, lines.join('\n'));
}
function pill(text, kind) { return h('span', { class: `pill ${kind || ''}` }, text); }
function outcomePill(rec) {
  if (!rec) return h('span', { class: 'muted' }, '—');
  return pill(OUTCOME_LABEL[rec.outcome] || rec.outcome, rec.outcome === 'held' || rec.outcome === 'not_eligible' ? 'warn' : 'blue');
}
function copyBtn(text) {
  return h('button', { type: 'button', class: 'small', 'aria-label': `Copy ${text}`, onclick: (ev) => {
    navigator.clipboard.writeText(text).then(() => { ev.target.textContent = 'Copied'; setTimeout(() => { ev.target.textContent = 'Copy'; }, 1200); });
  } }, 'Copy');
}
function progressBar(t) {
  const total = t.rows_total || 0;
  const held = (t.outcomes.held || 0) + (t.outcomes.not_eligible || 0);
  const done = t.worked - held;
  const bar = h('div', { class: 'bar' }, h('span', { class: 'a', width: total ? `${(done / total) * 100}%` : '0' }), h('span', { class: 'b', width: total ? `${(held / total) * 100}%` : '0' }));
  const parts = Object.entries(t.outcomes).map(([k, n]) => `${n} ${OUTCOME_LABEL[k] || k}`);
  return h('div', {}, bar, h('div', { class: 'muted' }, `${parts.join(' · ') || 'Not started'}${total ? ` · ${total - t.worked} left` : ''}`));
}

// ---------- layout ----------
function shell(active, ...content) {
  const link = (href, text, key) => h('a', { href, class: active === key ? 'on' : '' }, text);
  const nav = [link('#/', 'Tasks', 'tasks'), link('#/payers', 'Payer lists', 'payers')];
  if (ME.role === 'admin') nav.push(link('#/admin', 'Settings', 'admin'));
  const page = h('div', {},
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, 'Billing Control'),
      h('nav', { 'aria-label': 'Main' }, nav),
      h('div', { class: 'who' }, `${ME.name} · ${ME.role}`, h('button', { type: 'button', class: 'small', onclick: async () => { await api('POST', '/api/logout'); ME = null; render(); } }, 'Sign out'))),
    ME.sheets_mode === 'local' ? h('div', { class: 'banner-demo' }, 'Test mode: using local test sheets with fake data. ', ME.role === 'admin' ? h('a', { href: '#/admin' }, 'Connect Google Sheets') : 'An admin can connect Google Sheets', ' before real work.') : null,
    h('main', {}, content));
  $app.replaceChildren(page);
}

// ---------- views ----------
function viewLogin(err) {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const msg = h('div');
  const form = h('form', { class: 'card login', onsubmit: async (ev) => {
    ev.preventDefault();
    try { await api('POST', '/api/login', { email: email.value, password: pass.value }); ME = await api('GET', '/api/me'); render(); } catch (e) { msg.replaceChildren(errorBox(e)); }
  } }, h('h1', {}, 'Billing Control'), h('label', {}, 'Email', email), h('label', {}, 'Password', pass), msg, h('button', { class: 'primary', type: 'submit' }, 'Sign in'));
  if (err) msg.append(errorBox(err));
  $app.replaceChildren(h('main', {}, form));
}

async function viewHome() {
  const [tasks, alerts, bot] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/alerts'), api('GET', '/api/bot-status')]);
  const today = Object.fromEntries(bot.today.map((r) => [r.outcome, r.n]));
  const prev = tasks.filter((t) => t.state !== 'setup');
  const typeSel = h('select', { 'aria-label': 'Task type' }, Object.entries(TYPE).map(([k, v]) => h('option', { value: k }, v)));
  const copySel = h('select', { 'aria-label': 'Copy setup from' }, h('option', { value: '' }, 'Start empty'), prev.map((t) => h('option', { value: t.id }, `Copy from #${t.id} · ${t.practice_name} · ${t.provider_name}`)));
  const msg = h('div');
  shell('tasks',
    h('div', { class: 'row' }, h('h1', {}, 'Tasks'), h('span', { class: 'muted' }, 'One practice and one provider per task'),
      h('div', { class: 'row end' }, typeSel, copySel, h('button', { class: 'primary', type: 'button', onclick: async () => {
        try {
          const t = await api('POST', '/api/tasks', copySel.value ? { copy_from: Number(copySel.value) } : { task_type: typeSel.value });
          location.hash = `#/tasks/${t.id}/setup`;
        } catch (e) { msg.replaceChildren(errorBox(e)); }
      } }, '+ New task'))),
    msg,
    h('div', { class: 'grid' },
      h('section', { class: 'card' }, h('div', { class: 'muted' }, 'BOT PC'),
        bot.token ? h('div', {}, h('strong', {}, bot.token.name), ` · last seen ${bot.token.last_used_at} UTC`) : h('div', {}, 'No bot has connected yet'),
        bot.working ? h('div', { class: 'muted' }, `Working task #${bot.working.id} · row ${bot.working.current_row} · since ${bot.working.current_row_started_at} UTC`) : null),
      h('section', { class: `card ${alerts.length ? 'warn' : ''}` }, h('div', { class: 'muted' }, `WAITING ON YOU · ${alerts.length}`),
        alerts.length ? alerts.slice(0, 5).map((a) => h('div', {}, h('a', { href: `#/tasks/${a.task_id}` }, `Task #${a.task_id}`), ` · ${a.kind.replace('_', ' ')}: ${a.message}`)) : h('div', {}, 'Nothing waiting')),
      h('section', { class: 'card' }, h('div', { class: 'muted' }, 'TODAY'),
        h('div', { class: 'row' }, ...['demo_done', 'already_added', 'claim_created', 'submitted', 'held'].filter((k) => today[k]).map((k) => h('div', {}, h('b', {}, today[k]), ` ${OUTCOME_LABEL[k]}`)), Object.keys(today).length ? null : 'No rows recorded yet'))),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['#', 'Task type', 'Practice · Provider', 'Sheet · Tab', 'Progress', 'State'].map((x) => h('th', {}, x)))),
      h('tbody', {}, tasks.length ? tasks.map((t) => h('tr', {},
        h('td', { class: 'mono' }, t.id),
        h('td', {}, h('a', { href: t.state === 'setup' ? `#/tasks/${t.id}/setup` : `#/tasks/${t.id}` }, TYPE[t.task_type])),
        h('td', {}, t.practice_name || '—', h('div', { class: 'muted' }, `${t.provider_name || ''} ${t.provider_npi ? '· NPI ' + t.provider_npi : ''}`)),
        h('td', {}, t.tab_name || '—', h('div', { class: 'muted' }, t.row_from ? `rows ${t.row_from}–${t.row_to}` : '')),
        h('td', {}, progressBar(t)),
        h('td', {}, t.state === 'setup' ? pill(`Setup incomplete${t.problems.length ? ` · ${t.problems.length}` : ''}`, 'warn')
          : t.state === 'closed' ? pill('Closed') : t.bot_paused ? pill('Paused · waiting on you', 'warn') : pill('Ready for bot', 'blue'),
        t.open_alerts ? h('div', { class: 'muted' }, `${t.open_alerts} open alert(s)`) : null))) : h('tr', {}, h('td', { colspan: 6 }, 'No tasks yet.'))))));
}

async function viewSetup(id) {
  const t = await api('GET', `/api/tasks/${id}`);
  if (t.state !== 'setup') { location.hash = `#/tasks/${id}`; return; }
  const f = {};
  const input = (name, attrs = {}) => { f[name] = h('input', { value: t[name] == null ? '' : t[name], ...attrs }); return f[name]; };
  const typeRadios = Object.entries(TYPE).map(([k, v]) => h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'tt', value: k, checked: t.task_type === k }), v));
  const facilities = h('div', { class: 'facility' });
  const addFacility = (fa = { name: '', address: '' }) => {
    const n = h('input', { value: fa.name, 'aria-label': 'Facility name', placeholder: 'Facility name' });
    const a = h('input', { value: fa.address, 'aria-label': 'Facility address', placeholder: 'Street, City, ST ZIP' });
    const rm = h('button', { type: 'button', class: 'small', onclick: () => { n.remove(); a.remove(); rm.remove(); } }, 'Remove');
    facilities.append(n, a, rm);
  };
  (t.facilities.length ? t.facilities : [{ name: '', address: '' }]).forEach(addFacility);
  const PORTALS = ['Office Ally', 'Medicare (NGS)', 'UHC', 'ePACES (NY Medicaid)', 'Availity', 'Other payer portal'];
  const portalBoxes = PORTALS.map((p) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', value: p, checked: t.portals.includes(p) }), p));
  const special = h('textarea', { rows: 3 }, t.special_instructions);
  const drug = h('input', { value: t.extra_drug_codes, placeholder: 'e.g. Q0138 A9576' });
  const msg = h('div');
  const checkOut = h('div', { class: 'side' });

  const collect = () => ({
    task_type: (typeRadios.map((l) => l.querySelector('input')).find((i) => i.checked) || {}).value,
    practice_name: f.practice_name.value, oa_account: f.oa_account.value, provider_name: f.provider_name.value,
    provider_npi: f.provider_npi.value, billing_npi: f.billing_npi.value, billing_tax_id: f.billing_tax_id.value,
    facilities: [...facilities.querySelectorAll('input')].reduce((acc, el, i, arr) => { if (i % 2 === 0) acc.push({ name: el.value, address: arr[i + 1].value }); return acc; }, []),
    sheet_link: f.sheet_link.value, tab_name: f.tab_name.value, status_col: f.status_col.value, insurance_col: f.insurance_col.value, notes_col: f.notes_col.value,
    row_from: f.row_from.value, row_to: f.row_to.value, dos_from: f.dos_from.value, dos_to: f.dos_to.value,
    portals: portalBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value),
    special_instructions: special.value, extra_drug_codes: drug.value,
  });
  const save = async () => api('PUT', `/api/tasks/${id}`, collect());

  async function runCheck() {
    msg.replaceChildren();
    try {
      await save();
      const r = await api('POST', `/api/tasks/${id}/check-sheet`);
      showCheck(r);
    } catch (e) { msg.replaceChildren(errorBox(e)); if (e.data && e.data.tabs) showTabs(e.data.tabs); }
  }
  function showTabs(tabs) {
    const sel = h('select', { 'aria-label': 'Pick tab' }, h('option', { value: '' }, 'Pick the tab…'), tabs.map((x) => h('option', { value: x, selected: x === f.tab_name.value }, x)));
    checkOut.replaceChildren(h('section', { class: 'card' }, h('h2', {}, 'Tabs in this sheet'), sel,
      h('button', { type: 'button', onclick: () => { f.tab_name.value = sel.value; runCheck(); } }, 'Use this tab and check headers')));
  }
  function showCheck(r) {
    if (!r.header.length) { showTabs(r.tabs); return; }
    // Keep the form in step with the resolved columns so saving doesn't reset the check.
    for (const c of ['status', 'insurance', 'notes']) if (r.columns[c].idx != null) f[`${c}_col`].value = r.columns[c].letter;
    const colRow = (label, c) => h('tr', {}, h('td', {}, label), h('td', { class: 'mono' }, c.idx != null ? `${c.letter} · ${c.header}` : c.error), h('td', { class: c.idx != null ? 'ok' : 'bad' }, c.idx != null ? '✓' : '✗'));
    const selects = {};
    const fieldRows = t.fields.map((fd) => {
      const sel = h('select', { 'aria-label': fd.label }, h('option', { value: '' }, '—'), r.header.map((col, i) => h('option', { value: i, selected: r.mapping[fd.key] === i }, `${col.letter} · ${col.header}`)));
      selects[fd.key] = sel;
      return h('tr', {}, h('td', {}, fd.label), h('td', {}, sel));
    });
    checkOut.replaceChildren(
      h('section', { class: 'card' }, h('h2', {}, 'Sheet header check'), h('div', { class: 'muted' }, `Row 1 of "${f.tab_name.value}"`),
        h('table', {}, h('tbody', {}, colRow('Status', r.columns.status), colRow('Insurance', r.columns.insurance), colRow('Notes', r.columns.notes)))),
      h('section', { class: 'card' }, h('h2', {}, 'Sheet columns the checks read'),
        r.missing.length ? h('div', { class: 'error' }, `Still needed: ${r.missing.join(', ')}`) : h('div', { class: 'success' }, 'All required fields are matched. Check each one.'),
        h('table', {}, h('tbody', {}, fieldRows)),
        h('button', { type: 'button', onclick: async () => {
          const mapping = {};
          for (const [k, sel] of Object.entries(selects)) if (sel.value !== '') mapping[k] = Number(sel.value);
          try { await api('PUT', `/api/tasks/${id}/mapping`, { mapping }); msg.replaceChildren(h('div', { class: 'success' }, 'Column matches saved.')); await refreshProblems(); } catch (e) { msg.replaceChildren(errorBox(e)); }
        } }, 'Save column matches')),
      confirmCard);
    refreshProblems();
  }
  const problemsList = h('ul');
  const confirmMsg = h('div');
  const confirmBox = h('input', { type: 'checkbox' });
  const confirmBtn = h('button', { type: 'button', class: 'primary', onclick: async () => {
    if (!confirmBox.checked) { confirmMsg.replaceChildren(errorBox(new Error('Tick the confirmation box first.'))); return; }
    try { await save(); await api('POST', `/api/tasks/${id}/confirm`); location.hash = `#/tasks/${id}`; } catch (e) { confirmMsg.replaceChildren(errorBox(e)); refreshProblems(); }
  } }, 'Confirm setup and release to bot');
  const confirmCard = h('section', { class: 'card warn' }, h('h2', {}, 'Before the bot can start'), problemsList,
    h('label', { class: 'inline' }, confirmBox, 'I confirm the practice, provider, sheet, tab and columns are right for this task'), confirmMsg, confirmBtn);
  async function refreshProblems() {
    const cur = await api('GET', `/api/tasks/${id}`);
    problemsList.replaceChildren(...(cur.problems.length ? cur.problems.map((p) => h('li', {}, p)) : [h('li', { class: 'ok' }, 'Everything required is filled in')]));
  }

  shell('tasks',
    h('div', { class: 'row' }, h('h1', {}, `Task #${id} · Task Setup`), h('span', { class: 'muted' }, t.copied_from ? `Copied from task #${t.copied_from}: check every field` : 'Starts empty. Nothing is reused unless you choose it.'),
      h('button', { type: 'button', class: 'end', onclick: async () => { try { await save(); msg.replaceChildren(h('div', { class: 'success' }, 'Saved.')); refreshProblems(); } catch (e) { msg.replaceChildren(errorBox(e)); } } }, 'Save')),
    msg,
    h('div', { class: 'split' },
      h('div', { class: 'main' },
        h('section', { class: 'card' }, h('h2', {}, '1 · Task type'), h('div', { class: 'row' }, typeRadios),
          h('div', { class: 'muted' }, 'Sheet status written: Demo creation → "Demo Done" / "Already demo added" · Claim creation → "Claim Created" · Claim submission → "Submitted" · held rows → "Held" plus the reason in Notes')),
        h('section', { class: 'card' }, h('h2', {}, '2 · Practice and provider'), h('div', { class: 'grid' },
          h('label', {}, 'Practice name', input('practice_name')),
          h('label', {}, 'Office Ally account / practice to use', input('oa_account')),
          h('label', {}, 'Provider name (rendering)', input('provider_name')),
          h('label', {}, 'Provider NPI', input('provider_npi', { class: 'mono', inputmode: 'numeric' })),
          h('label', {}, 'Billing / group NPI (if different)', input('billing_npi', { class: 'mono', inputmode: 'numeric' })),
          h('label', {}, 'Billing Tax ID (if different)', input('billing_tax_id', { class: 'mono' })))),
        h('section', { class: 'card' }, h('h2', {}, '3 · Facilities (Box 32)'),
          h('div', { class: 'muted' }, 'A claim\'s facility must exactly match one of these and the sheet, otherwise it is held. Not needed for demo tasks.'),
          facilities, h('button', { type: 'button', class: 'link', onclick: () => addFacility() }, '+ Add facility')),
        h('section', { class: 'card' }, h('h2', {}, '4 · Google Sheet'),
          h('label', {}, 'Google Sheet link', input('sheet_link', { placeholder: 'https://docs.google.com/spreadsheets/d/…' })),
          ME.service_account ? h('div', { class: 'muted' }, `Share the sheet (Editor) with ${ME.service_account}`) : null,
          ME.sheets_account ? h('div', { class: 'muted' }, `Works with any sheet ${ME.sheets_account} can edit. No sharing needed.`) : null,
          h('div', { class: 'grid' },
            h('label', {}, 'Tab name', input('tab_name')),
            h('label', {}, 'Status column (letter or header)', input('status_col')),
            h('label', {}, 'Insurance column', input('insurance_col')),
            h('label', {}, 'Notes column', input('notes_col'))),
          h('div', { class: 'grid' },
            h('label', {}, 'From row', input('row_from', { inputmode: 'numeric' })),
            h('label', {}, 'To row', input('row_to', { inputmode: 'numeric' })),
            h('label', {}, 'DOS from (optional)', input('dos_from', { placeholder: 'MM/DD/YYYY' })),
            h('label', {}, 'DOS to (optional)', input('dos_to', { placeholder: 'MM/DD/YYYY' }))),
          h('button', { type: 'button', class: 'primary', onclick: runCheck }, 'Check sheet header')),
        h('section', { class: 'card' }, h('h2', {}, '5 · Portals and instructions'), h('div', { class: 'row' }, portalBoxes),
          h('div', { class: 'success' }, 'Logins stay in the bot PC\'s Chrome password manager. Never type a password here; this form has no password field.'),
          h('label', {}, 'Extra drug codes that need an NDC (J-codes and Q51xx are always checked)', drug),
          h('label', {}, 'Special instructions for this task', special))),
      checkOut));
  checkOut.append(confirmCard);
  refreshProblems();
}

async function viewWorklist(id, filter = 'all') {
  const [t, rows] = await Promise.all([api('GET', `/api/tasks/${id}`), api('GET', `/api/tasks/${id}/rows`)]);
  if (t.state === 'setup') { location.hash = `#/tasks/${id}/setup`; return; }
  const msg = h('div');
  const openAlerts = t.alerts.filter((a) => !a.resolved);
  const inScope = rows.filter((r) => r.in_scope);
  const count = (fn) => inScope.filter(fn).length;
  const isClaim = t.task_type !== 'demo';
  const shown = rows.filter((r) => filter === 'all' ? true
    : filter === 'failed' ? r.in_scope && r.blockers && r.blockers.length && !r.record
      : filter === 'held' ? r.record && (r.record.outcome === 'held' || r.record.outcome === 'not_eligible')
        : filter === 'todo' ? r.in_scope && !r.record : true);
  const chip = (key, label) => h('button', { type: 'button', class: `chip ${filter === key ? 'on' : ''}`, onclick: () => viewWorklist(id, key) }, label);

  const alertEls = openAlerts.map((a) => {
    const note = h('input', { placeholder: 'What you decided (optional)', 'aria-label': 'Resolution' });
    return h('div', { class: 'alert', role: 'alert' }, h('strong', {}, a.kind === 'repeat_issue' ? 'Bot paused: same issue on several rows' : a.kind === 'otp' ? 'One-time code requested' : a.kind === 'login_failed' ? 'Bot paused: portal login failed' : a.kind === 'error' ? 'Bot paused: error' : 'Question from the bot'),
      h('span', {}, a.message), note,
      h('button', { type: 'button', class: 'danger', onclick: async () => { await api('POST', `/api/alerts/${a.id}/resolve`, { resolution: note.value }); viewWorklist(id, filter); } }, a.kind === 'question' || a.kind === 'otp' ? 'Mark answered' : 'Resolved: let bot continue'));
  });

  shell('tasks',
    h('div', { class: 'row' }, h('h1', {}, `Task #${t.id} · ${TYPE[t.task_type]}`),
      h('span', { class: 'muted' }, `${t.practice_name} · ${t.provider_name} · NPI ${t.provider_npi} · ${t.tab_name} · rows ${t.row_from}–${t.row_to}`),
      h('span', { class: 'muted end' }, t.confirmed_at ? `Confirmed ${t.confirmed_at} UTC` : '')),
    h('nav', { class: 'tabs', 'aria-label': 'Task' }, h('a', { href: `#/tasks/${id}`, class: 'on' }, 'Worklist'), h('a', { href: `#/tasks/${id}/report` }, 'Report')),
    msg, alertEls,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, inScope.length), 'Rows in scope'),
      h('div', { class: 'stat' }, h('b', { class: 'ok' }, count((r) => r.record && !['held', 'not_eligible'].includes(r.record.outcome))), isClaim ? (t.task_type === 'submission' ? 'Submitted' : 'Claim Created') : 'Demo Done / already added'),
      h('div', { class: 'stat' }, h('b', { class: 'bad' }, count((r) => r.record && ['held', 'not_eligible'].includes(r.record.outcome))), 'Held / not eligible'),
      h('div', { class: 'stat' }, h('b', {}, count((r) => r.current)), 'In progress'),
      h('div', { class: 'stat' }, h('b', {}, count((r) => !r.record)), 'Not started')),
    h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Show:'), chip('all', 'All'), chip('failed', 'Pre-check failed'), chip('held', 'Held'), chip('todo', 'Not started'),
      h('div', { class: 'row end' },
        t.state === 'confirmed' ? h('button', { type: 'button', onclick: async () => { try { await api('POST', `/api/tasks/${id}/reload`); viewWorklist(id, filter); } catch (e) { msg.replaceChildren(errorBox(e)); } } }, '↻ Re-read sheet') : null,
        t.state === 'confirmed' ? h('button', { type: 'button', onclick: async () => { if (confirm('Move this task back to setup? The bot will stop.')) { await api('POST', `/api/tasks/${id}/edit-setup`); location.hash = `#/tasks/${id}/setup`; } } }, 'Edit setup') : null)),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Row', 'Patient', 'DOB', 'DOS', ...(isClaim ? ['Provider', 'Facility', 'NDC'] : ['Lookups']), 'Pre-check', 'Outcome', 'Notes'].map((x) => h('th', {}, x)))),
      h('tbody', {}, shown.map((r) => h('tr', { class: r.current ? 'cur' : !r.in_scope ? 'dim' : r.blockers && r.blockers.length && !r.record ? 'hl' : '' },
        h('td', { class: 'mono' }, r.row_no),
        h('td', {}, r.in_scope ? h('a', { href: `#/tasks/${id}/rows/${r.row_no}` }, r.patient || '(no name)') : r.patient || '—'),
        h('td', { class: 'mono' }, r.dob), h('td', { class: 'mono' }, r.dos),
        ...(!r.in_scope ? [h('td', { colspan: isClaim ? 4 : 2, class: 'muted' }, r.reason)]
          : isClaim ? [
            h('td', { class: r.provider_ok ? 'ok' : 'bad' }, r.provider_ok ? '✓' : '✗'),
            h('td', { class: r.facility_ok ? 'ok' : 'bad' }, r.facility_ok ? '✓' : '✗'),
            h('td', { class: r.ndc === 'missing' ? 'bad' : r.ndc === 'ok' ? 'ok' : 'muted' }, r.ndc === 'missing' ? '✗' : r.ndc === 'ok' ? '✓' : 'n/a'),
            h('td', {}, r.blockers.length ? pill(isClaim ? 'Must hold' : 'Blocked', 'warn') : pill('Ready', 'blue'))]
            : [h('td', {}, r.todos ? `${r.todos} to look up` : '—'), h('td', {}, r.blockers.length ? pill('Blocked', 'warn') : pill('Ready', 'blue'))]),
        h('td', {}, r.current ? pill('Bot working…', 'dark') : outcomePill(r.record)),
        h('td', {}, r.record ? r.record.notes : r.sheet_notes)))))));
}

async function viewRow(id, rowNo) {
  const [t, r] = await Promise.all([api('GET', `/api/tasks/${id}`), api('GET', `/api/tasks/${id}/rows/${rowNo}`)]);
  const c = r.card;
  const msg = h('div');
  const main = [];
  const latest = r.records[r.records.length - 1];
  if (c.blockers.length) main.push(h('section', { class: 'card warn' }, h('h2', {}, c.kind === 'claim' ? 'Pre-checks failed: hold this claim' : 'Blocked: fix before entering'), h('ul', {}, c.blockers.map((b) => h('li', {}, b)))));
  if (c.warnings.length) main.push(h('section', { class: 'card' }, h('h2', {}, 'Warnings'), h('ul', {}, c.warnings.map((w) => h('li', {}, w)))));

  if (c.kind === 'demo') {
    main.push(h('section', { class: 'card' }, h('h2', {}, 'Do these first'), h('ol', { class: 'steps' }, c.steps.map((s) => h('li', {}, s)))));
    main.push(h('section', { class: 'card' }, h('h2', {}, 'Patients → Add New Patient'),
      h('table', {}, h('thead', {}, h('tr', {}, ['Office Ally field', 'Enter', 'From sheet', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, c.fields.map((fd) => h('tr', {}, h('td', {}, fd.field),
          h('td', { class: fd.lookup ? 'bad' : 'typed' }, fd.lookup ? 'Look up in portal' : fd.value || '(blank)'),
          h('td', { class: 'muted' }, fd.source || ''), h('td', {}, fd.value ? copyBtn(fd.value) : null)))))));
    const ins = c.insurance;
    main.push(h('section', { class: 'card' }, h('h2', {}, 'Primary insurance'), h('table', {}, h('tbody', {},
      h('tr', {}, h('td', {}, 'Sheet says'), h('td', {}, ins.sheet_value || '(blank)')),
      h('tr', {}, h('td', {}, 'Office Ally payer'), h('td', {}, ins.oa_payer_name ? h('span', { class: 'typed' }, ins.oa_payer_name) : h('span', { class: 'bad' }, 'Not in payer list'), ins.payer_id ? h('div', { class: 'muted' }, `Payer ID ${ins.payer_id} · ${ins.plan_type} · portal ${ins.portal}`) : null)),
      h('tr', {}, h('td', {}, 'Member ID'), h('td', {}, ins.member_id ? h('span', { class: 'typed' }, ins.member_id) : h('span', { class: 'bad' }, 'Look up'), ins.member_id ? copyBtn(ins.member_id) : null)),
      h('tr', {}, h('td', {}, 'Subscriber / relationship'), h('td', { class: 'typed' }, `${ins.subscriber} / ${ins.relationship}`)),
      h('tr', {}, h('td', {}, 'Eligibility date (DOS)'), h('td', { class: c.dos_mdy ? 'typed' : 'bad' }, c.dos_mdy || 'Missing: ask the user')),
      h('tr', {}, h('td', {}, 'Write to sheet'), h('td', {}, ins.sheet_insurance_name || '—')))),
    h('div', { class: 'muted' }, 'Secondary insurance: add in Office Ally only if eligibility shows one. Never write it to the sheet\'s Insurance column.')));
  } else {
    main.push(h('section', { class: 'card' }, h('h2', {}, 'Sheet vs Task Setup'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Check', 'Sheet', 'Task Setup', 'Result'].map((x) => h('th', {}, x)))),
      h('tbody', {}, c.checks.map((k) => h('tr', { class: k.ok ? '' : 'hl' }, h('td', {}, k.check), h('td', {}, k.sheet), h('td', {}, k.setup), h('td', { class: k.ok ? 'ok' : 'bad' }, k.ok ? '✓ Match' : '✗ Mismatch'))))))));
    main.push(h('section', { class: 'card' }, h('h2', {}, 'CMS-1500 entry'), h('table', {}, h('tbody', {},
      h('tr', {}, h('td', {}, 'Patient'), h('td', { class: 'typed' }, `${c.patient.last}, ${c.patient.first} · DOB ${c.patient.dob_mdy}`)),
      h('tr', {}, h('td', {}, 'DOS (from/to)'), h('td', { class: 'typed' }, c.dos_mdy)),
      h('tr', {}, h('td', {}, 'Rendering / billing'), h('td', {}, `${c.providers.rendering.name} · ${c.providers.rendering.npi} / NPI ${c.providers.billing.npi}${c.providers.billing.tax_id ? ` · Tax ID ${c.providers.billing.tax_id}` : ''}`)),
      h('tr', {}, h('td', {}, 'Box 32 facility'), h('td', {}, c.facility ? `${c.facility.name} · ${c.facility.address}` : h('span', { class: 'bad' }, 'No matching facility'))),
      c.pos ? h('tr', {}, h('td', {}, 'Place of service'), h('td', { class: 'typed' }, c.pos)) : null,
      c.prior_auth ? h('tr', {}, h('td', {}, 'Prior auth (Box 23)'), h('td', { class: 'typed' }, c.prior_auth)) : null,
      c.referring ? h('tr', {}, h('td', {}, 'Referring'), h('td', {}, c.referring)) : null,
      h('tr', {}, h('td', {}, 'Box 21 ICD-10'), h('td', { class: 'typed' }, c.diagnoses.map((d, i) => `${String.fromCharCode(65 + i)}. ${d}`).join('   '))))),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['#', 'CPT/HCPCS', 'Mod', 'Units', 'Charge', 'Dx ptr', 'NDC (shaded line)'].map((x) => h('th', {}, x)))),
      h('tbody', {}, c.lines.map((l) => h('tr', { class: l.drug && !l.ndc ? 'hl' : '' },
        h('td', {}, l.line), h('td', { class: 'typed' }, l.cpt), h('td', { class: 'typed' }, l.modifiers.join(' ')), h('td', { class: 'typed' }, l.units),
        h('td', { class: 'typed' }, l.charge_cents == null ? '—' : `$${(l.charge_cents / 100).toFixed(2)}`), h('td', { class: 'typed' }, l.dx_pointer || '?'),
        h('td', {}, !l.drug ? h('span', { class: 'muted' }, 'Not a drug line') : l.ndc ? [h('span', { class: 'typed' }, l.ndc.entry), ' ', copyBtn(l.ndc.entry), l.ndc.converted ? h('div', { class: 'muted' }, `Sheet had ${l.ndc.source}; converted to 11 digits`) : null] : h('span', { class: 'bad' }, l.ndc_error || 'NDC missing')))))))));
  }
  main.push(h('details', { class: 'card' }, h('summary', {}, 'Raw sheet row'), h('table', {}, h('tbody', {}, r.cells.map((x) => h('tr', {}, h('td', { class: 'mono' }, x.letter), h('td', {}, x.header), h('td', {}, x.value)))))));

  // Record form
  const outcomeRadios = r.outcomes_allowed.map((o) => {
    const blocked = (rulesClaim(o.outcome) && c.blockers.length > 0);
    return h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'oc', value: o.outcome, disabled: blocked, onchange: () => drawChecklist(o) }), OUTCOME_LABEL[o.outcome], blocked ? h('span', { class: 'muted' }, '(blocked by pre-checks)') : null);
  });
  const checklist = h('ul', { class: 'plain' });
  function drawChecklist(o) {
    checklist.replaceChildren(...Object.entries(o.checklist).map(([k, label]) => h('li', {}, h('label', { class: 'inline' }, h('input', { type: 'checkbox', value: k }), label))));
    if (c.kind === 'demo' && (o.outcome === 'demo_done' || o.outcome === 'already_added') && !insurance.value && c.insurance.sheet_insurance_name) insurance.value = c.insurance.sheet_insurance_name;
  }
  const insurance = h('input', { placeholder: 'Primary insurance only' });
  const notes = h('textarea', { rows: 3 });
  const chips = (c.kind === 'demo' ? STANDARD_NOTES.demo : STANDARD_NOTES.claim).map((n) => h('button', { type: 'button', class: 'chip', onclick: () => { notes.value = notes.value ? `${notes.value}; ${n}` : n; notes.focus(); } }, n.trim()));
  const recordCard = h('section', { class: 'card focus' }, h('h2', {}, latest ? 'Record a correction' : 'Record outcome'),
    latest ? h('div', { class: 'muted' }, `Current outcome: ${OUTCOME_LABEL[latest.outcome]} by ${latest.actor} at ${latest.created_at} UTC`) : null,
    h('div', { class: 'plain' }, outcomeRadios), checklist,
    c.kind === 'demo' ? h('label', {}, 'Insurance column', insurance) : null,
    h('label', {}, 'Notes (standard wording)', notes), h('div', { class: 'chips' }, chips),
    h('button', { type: 'button', class: 'primary', disabled: t.state !== 'confirmed', onclick: async () => {
      const oc = outcomeRadios.map((l) => l.querySelector('input')).find((i) => i.checked);
      if (!oc) { msg.replaceChildren(errorBox(new Error('Pick an outcome'))); return; }
      try {
        const res = await api('POST', `/api/tasks/${id}/rows/${rowNo}/record`, {
          outcome: oc.value, insurance: insurance.value, notes: notes.value, correction: !!latest,
          checklist: [...checklist.querySelectorAll('input:checked')].map((i) => i.value),
        });
        msg.replaceChildren(h('div', { class: 'success' }, `Written to sheet: ${res.written.map((w) => `${w.cell} = "${w.value}"`).join(', ') || 'nothing to change'}${res.stop_and_ask ? `\nStop and ask: ${res.stop_and_ask}` : ''}`));
        setTimeout(() => viewRow(id, rowNo), 1500);
      } catch (e) { msg.replaceChildren(errorBox(e)); }
    } }, 'Write to sheet now'));

  shell('tasks',
    h('div', { class: 'row' }, h('a', { href: `#/tasks/${id}` }, `← Task #${id}`)),
    h('div', { class: 'row' }, h('h1', {}, `Row ${rowNo}${c.kind === 'claim' ? ` · ${c.patient.last}, ${c.patient.first}` : ` · ${c.fields[0].value}, ${c.fields[1].value}`}`),
      h('span', { class: 'muted' }, `DOS ${c.dos_mdy || '—'}`), r.current ? pill('Bot working on this row', 'dark') : null,
      c.blockers.length ? h('span', { class: 'end' }, pill(`${c.blockers.length} problem(s)`, 'warn')) : h('span', { class: 'end' }, pill('Pre-checks pass', 'blue'))),
    msg,
    h('div', { class: 'split' }, h('div', { class: 'main' }, main),
      h('div', { class: 'side' }, t.state === 'confirmed' ? recordCard : h('div', { class: 'card' }, 'Task is not open for recording.'),
        h('section', { class: 'card' }, h('h2', {}, 'History'), r.records.length ? h('ul', { class: 'plain' }, r.records.map((x) => h('li', {}, outcomePill(x), ` ${x.actor} · ${x.created_at} UTC`, x.notes ? h('div', { class: 'muted' }, x.notes) : null))) : h('div', { class: 'muted' }, 'No outcome yet')))));
}
const rulesClaim = (o) => o === 'claim_created' || o === 'submitted';

async function viewReport(id) {
  const [t, r] = await Promise.all([api('GET', `/api/tasks/${id}`), api('GET', `/api/tasks/${id}/report`)]);
  shell('tasks',
    h('div', { class: 'row' }, h('h1', {}, `End-of-session report · Task #${id}`),
      h('div', { class: 'row end' }, h('button', { type: 'button', onclick: () => navigator.clipboard.writeText(r.text) }, 'Copy as text'),
        t.state !== 'closed' ? h('button', { type: 'button', class: 'primary', onclick: async () => { if (confirm('Close this task? The bot will no longer work it.')) { await api('POST', `/api/tasks/${id}/close`); viewReport(id); } } }, 'Close task') : pill('Closed'))),
    h('nav', { class: 'tabs', 'aria-label': 'Task' }, h('a', { href: `#/tasks/${id}` }, 'Worklist'), h('a', { href: `#/tasks/${id}/report`, class: 'on' }, 'Report')),
    h('section', { class: 'card' }, h('div', { class: 'grid' },
      h('div', {}, h('div', { class: 'muted' }, 'Practice'), h('strong', {}, r.task.practice)),
      h('div', {}, h('div', { class: 'muted' }, 'Provider'), h('strong', {}, `${r.task.provider} · ${r.task.provider_npi}`)),
      h('div', {}, h('div', { class: 'muted' }, 'Last row completed'), h('strong', {}, r.last_row_completed ?? 'none'), r.next_row ? h('div', { class: 'muted' }, `Next session starts at row ${r.next_row}`) : h('div', { class: 'muted' }, 'All rows worked')),
      h('div', {}, h('div', { class: 'muted' }, 'Average bot time per row'), h('strong', {}, r.avg_seconds_per_row ? `${Math.floor(r.avg_seconds_per_row / 60)}m ${r.avg_seconds_per_row % 60}s` : '—')))),
    h('div', { class: 'stats' },
      ...(r.task.type === 'demo'
        ? [['Demo Done', r.demos.demo_done], ['Already demo added', r.demos.already_added], ['Not eligible', r.demos.not_eligible]]
        : [[r.task.type === 'submission' ? 'Submitted' : 'Claim Created', r.task.type === 'submission' ? r.claims.submitted : r.claims.claim_created]])
        .concat([['Held', r.held], ['Not worked', r.not_worked]]).map(([l, n]) => h('div', { class: 'stat' }, h('b', {}, n), l))),
    r.reasons.length ? h('section', { class: 'card' }, h('h2', {}, 'Held / skipped reasons'), h('table', {}, h('tbody', {}, r.reasons.map((x) => h('tr', {}, h('td', {}, x.reason), h('td', { class: 'mono' }, `rows ${x.rows.join(', ')}`)))))) : null,
    r.open_questions.length ? h('section', { class: 'card warn' }, h('h2', {}, 'Open questions'), h('ol', {}, r.open_questions.map((q) => h('li', {}, q)))) : null,
    h('section', { class: 'card' }, h('h2', {}, 'As text'), h('pre', { class: 'report' }, r.text)));
}

async function viewPayers(practiceId) {
  const practices = await api('GET', '/api/practices');
  if (!practices.length) { shell('payers', h('h1', {}, 'Payer lists'), h('div', { class: 'card' }, 'A practice appears here once a task uses it.')); return; }
  const pid = Number(practiceId) || practices[0].id;
  const [payers, unmatched] = await Promise.all([api('GET', `/api/practices/${pid}/payers`), api('GET', `/api/practices/${pid}/unmatched`)]);
  const msg = h('div');
  const PLAN = { medicare: 'Medicare', advantage: 'Medicare Advantage', medicaid: 'Medicaid', medicaid_mco: 'Medicaid MCO', commercial: 'Commercial', other: 'Other' };
  const form = (p = {}) => {
    const fl = {
      sheet_name: h('input', { value: p.sheet_name || '', placeholder: 'e.g. Humana Gold Plus' }),
      aliases: h('input', { value: (p.aliases || []).join(', '), placeholder: 'Other names sheets use, comma separated' }),
      oa_payer_name: h('input', { value: p.oa_payer_name || '' }),
      payer_id: h('input', { value: p.payer_id || '', class: 'mono' }),
      plan_type: h('select', {}, h('option', { value: '' }, 'Pick…'), Object.entries(PLAN).map(([k, v]) => h('option', { value: k, selected: p.plan_type === k }, v))),
      portal: h('input', { value: p.portal || '', placeholder: 'e.g. NGS, UHC portal, ePACES, Availity' }),
    };
    return h('section', { class: 'card focus' }, h('h2', {}, p.id ? `Edit "${p.sheet_name}"` : 'Add payer mapping'),
      h('div', { class: 'grid' },
        h('label', {}, 'Name written to the sheet\'s Insurance column', fl.sheet_name), h('label', {}, 'Other names in sheets', fl.aliases),
        h('label', {}, 'Office Ally payer (as listed in OA)', fl.oa_payer_name), h('label', {}, 'Payer ID', fl.payer_id),
        h('label', {}, 'Plan type', fl.plan_type), h('label', {}, 'Eligibility portal', fl.portal)),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: async () => {
          const body = Object.fromEntries(Object.entries(fl).map(([k, el]) => [k, el.value]));
          try { if (p.id) await api('PUT', `/api/payers/${p.id}`, body); else await api('POST', `/api/practices/${pid}/payers`, body); viewPayers(pid); } catch (e) { msg.replaceChildren(errorBox(e)); }
        } }, 'Save'),
        p.id ? h('button', { type: 'button', onclick: async () => { await api('PUT', `/api/payers/${p.id}`, { active: !p.active }); viewPayers(pid); } }, p.active ? 'Deactivate' : 'Reactivate') : null,
        h('button', { type: 'button', class: 'link', onclick: () => editSlot.replaceChildren() }, 'Cancel')));
  };
  const editSlot = h('div');
  const sel = h('select', { 'aria-label': 'Practice', onchange: () => { location.hash = `#/payers/${sel.value}`; } }, practices.map((p) => h('option', { value: p.id, selected: p.id === pid }, p.name)));
  shell('payers',
    h('div', { class: 'row' }, h('h1', {}, 'Payer list'), h('label', { class: 'inline' }, 'Practice', sel),
      h('button', { type: 'button', class: 'primary end', onclick: () => editSlot.replaceChildren(form()) }, '+ Add mapping')),
    h('div', { class: 'muted' }, 'Matches the insurance names your sheets use to the exact Office Ally payer. Confirm every payer ID against Office Ally\'s payer list.'),
    msg, editSlot,
    unmatched.length ? h('section', { class: 'card warn' }, h('h2', {}, `Needs a match · ${unmatched.length}`), h('div', { class: 'muted' }, 'Names found in open demo tasks. Those rows are blocked until mapped.'),
      h('ul', { class: 'plain' }, unmatched.map((u) => h('li', { class: 'row' }, h('strong', {}, `"${u.name}"`), h('span', { class: 'muted' }, u.rows.map((x) => `task #${x.task} row ${x.row}`).join(', ')),
        h('button', { type: 'button', class: 'small', onclick: () => editSlot.replaceChildren(form({ aliases: [u.name] })) }, 'Map it'))))) : null,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Sheet writes', 'Also matches', 'Office Ally payer', 'Payer ID', 'Plan type', 'Eligibility portal', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, payers.length ? payers.map((p) => h('tr', { class: p.active ? '' : 'dim' },
        h('td', {}, h('strong', {}, p.sheet_name)), h('td', {}, p.aliases.join(', ')), h('td', {}, p.oa_payer_name), h('td', { class: 'mono' }, p.payer_id),
        h('td', {}, PLAN[p.plan_type]), h('td', {}, p.portal), h('td', {}, h('button', { type: 'button', class: 'small', onclick: () => editSlot.replaceChildren(form(p)) }, 'Edit')))) : h('tr', {}, h('td', { colspan: 7 }, 'No payers yet'))))));
}

function sheetsCard(gs, msg) {
  const card = h('section', { class: `card ${gs.mode === 'local' ? 'focus' : ''}`, id: 'sheets' }, h('h2', {}, 'Google Sheets connection'));
  if (gs.mode === 'google') { card.append(h('div', { class: 'success' }, 'Connected with a Google service account (set on the server).')); return card; }
  if (gs.mode === 'appsscript') {
    card.append(h('div', { class: 'success' }, `Connected as ${gs.account || 'your Google account'} since ${gs.connected_at.slice(0, 16).replace('T', ' ')} UTC. Paste any sheet link this account can edit into a Task Setup.`),
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: async () => {
        if (!confirm('Disconnect Google Sheets? The app goes back to test mode until you connect again.')) return;
        await api('DELETE', '/api/settings/sheets'); ME = await api('GET', '/api/me'); viewAdmin();
      } }, 'Disconnect')));
    return card;
  }
  const url = h('input', { placeholder: 'https://script.google.com/macros/s/…/exec', value: gs.url });
  const scriptBox = gs.script ? h('textarea', { rows: 8, readonly: true, class: 'mono', 'aria-label': 'Script' }, gs.script) : null;
  card.append(
    h('div', { class: 'muted' }, 'One-time setup, about 5 minutes, in your normal Google account. No Google Cloud console.'),
    h('ol', { class: 'steps' },
      h('li', {}, h('strong', {}, 'Get the script: '), gs.script ? 'done. ' : '',
        h('button', { type: 'button', class: gs.script ? 'small' : 'primary', onclick: async () => {
          if (gs.script && !confirm('Make a new script? You will need to paste and deploy it again.')) return;
          await api('POST', '/api/settings/sheets/new-script'); viewAdmin();
        } }, gs.script ? 'Make a new one' : 'Get script'),
        scriptBox ? h('div', {}, scriptBox, h('div', { class: 'row' }, copyBtn(gs.script), h('span', { class: 'muted' }, 'The script contains a secret key. Don\'t share it.'))) : null),
      h('li', {}, 'Open ', h('a', { href: 'https://script.google.com/home/projects/create', target: '_blank', rel: 'noopener noreferrer' }, 'script.google.com (new project)'),
        ', delete the sample code, paste the script, and click the Save icon.'),
      h('li', {}, 'Click ', h('strong', {}, 'Deploy → New deployment'), '. Click the gear next to "Select type" → ', h('strong', {}, 'Web app'),
        '. Set "Execute as" = ', h('strong', {}, 'Me'), ' and "Who has access" = ', h('strong', {}, 'Anyone'), '. Click ', h('strong', {}, 'Deploy'), '.'),
      h('li', {}, 'Click ', h('strong', {}, 'Authorize access'), ', pick your account. On "Google hasn\'t verified this app" click ', h('strong', {}, 'Advanced → Go to … (unsafe)'),
        ' → ', h('strong', {}, 'Allow'), '. (It is your own script, so this warning is expected.)'),
      h('li', {}, 'Copy the ', h('strong', {}, 'Web app URL'), ' and paste it here:', h('div', { class: 'row' }, url,
        h('button', { type: 'button', class: 'primary', disabled: !gs.script, onclick: async (ev) => {
          ev.target.disabled = true; ev.target.textContent = 'Testing…';
          try { await api('PUT', '/api/settings/sheets', { url: url.value }); ME = await api('GET', '/api/me'); viewAdmin(); }
          catch (e) { msg.replaceChildren(errorBox(e)); ev.target.disabled = false; ev.target.textContent = 'Connect'; msg.scrollIntoView(); }
        } }, 'Connect')))));
  return card;
}

async function viewAdmin() {
  const [users, tokens, gs] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/tokens'), api('GET', '/api/settings/sheets')]);
  const msg = h('div');
  const nu = { name: h('input'), email: h('input', { type: 'email' }), password: h('input', { type: 'password', autocomplete: 'new-password' }), role: h('select', {}, h('option', { value: 'staff' }, 'staff'), h('option', { value: 'admin' }, 'admin')) };
  const tokName = h('input', { placeholder: 'e.g. OFFICE-VM-01' });
  shell('admin', h('h1', {}, 'Settings, users & bot access'), msg, sheetsCard(gs, msg),
    h('section', { class: 'card' }, h('h2', {}, 'Bot tokens'),
      h('div', { class: 'muted' }, 'The bot PC uses a token instead of a password. It can only work confirmed tasks: it cannot change Task Setups, payer lists or users.'),
      h('div', { class: 'row' }, tokName, h('button', { type: 'button', class: 'primary', onclick: async () => {
        try {
          const t = await api('POST', '/api/tokens', { name: tokName.value });
          msg.replaceChildren(h('div', { class: 'success' }, `Token for ${t.name} (shown once, store it on the bot PC as BILLING_TOKEN): `, h('span', { class: 'typed' }, t.token), ' ', copyBtn(t.token)));
        } catch (e) { msg.replaceChildren(errorBox(e)); }
      } }, 'Create token')),
      h('table', {}, h('tbody', {}, tokens.map((t) => h('tr', { class: t.revoked ? 'dim' : '' }, h('td', {}, t.name), h('td', { class: 'muted' }, `created ${t.created_at} · last used ${t.last_used_at || 'never'}`),
        h('td', {}, t.revoked ? 'revoked' : h('button', { type: 'button', class: 'small', onclick: async () => { if (confirm(`Revoke ${t.name}?`)) { await api('POST', `/api/tokens/${t.id}/revoke`); viewAdmin(); } } }, 'Revoke'))))))),
    h('section', { class: 'card' }, h('h2', {}, 'Users'),
      h('table', {}, h('tbody', {}, users.map((u) => h('tr', { class: u.active ? '' : 'dim' }, h('td', {}, u.name), h('td', {}, u.email), h('td', {}, u.role),
        h('td', {}, u.id === ME.id ? '(you)' : h('button', { type: 'button', class: 'small', onclick: async () => { await api('PUT', `/api/users/${u.id}`, { active: !u.active }); viewAdmin(); } }, u.active ? 'Deactivate' : 'Reactivate'),
          ' ', h('button', { type: 'button', class: 'small', onclick: async () => { const p = prompt(`New password for ${u.email} (10+ characters)`); if (p) { try { await api('PUT', `/api/users/${u.id}`, { password: p }); msg.replaceChildren(h('div', { class: 'success' }, 'Password changed.')); } catch (e) { msg.replaceChildren(errorBox(e)); } } } }, 'Set password')))))),
      h('div', { class: 'grid' }, h('label', {}, 'Name', nu.name), h('label', {}, 'Email', nu.email), h('label', {}, 'Password (10+)', nu.password), h('label', {}, 'Role', nu.role)),
      h('button', { type: 'button', onclick: async () => {
        try { await api('POST', '/api/users', Object.fromEntries(Object.entries(nu).map(([k, el]) => [k, el.value]))); viewAdmin(); } catch (e) { msg.replaceChildren(errorBox(e)); }
      } }, 'Add user')));
}

// ---------- router ----------
async function render() {
  try {
    if (!ME) {
      try { ME = await api('GET', '/api/me'); } catch { ME = null; }
      if (!ME || ME.bot) { ME = null; viewLogin(); return; }
    }
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'tasks' && parts[1]) {
      if (parts[2] === 'setup') return await viewSetup(parts[1]);
      if (parts[2] === 'report') return await viewReport(parts[1]);
      if (parts[2] === 'rows' && parts[3]) return await viewRow(parts[1], parts[3]);
      return await viewWorklist(parts[1]);
    }
    if (parts[0] === 'payers') return await viewPayers(parts[1]);
    if (parts[0] === 'admin' && ME.role === 'admin') return await viewAdmin();
    return await viewHome();
  } catch (e) {
    if (e.message === 'Signed out') return;
    if (ME) shell('', errorBox(e)); else viewLogin(e);
  }
}
window.addEventListener('hashchange', render);
render();
