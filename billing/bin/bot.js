#!/usr/bin/env node
'use strict';
// Command-line client the Data Entry Bot uses to talk to Billing Control.
// Needs BILLING_URL (default http://127.0.0.1:3000) and BILLING_TOKEN (from Bot access in the app).

const BASE = (process.env.BILLING_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = process.env.BILLING_TOKEN;
let BOT = process.env.BILLING_BOT || 'Bot 1';

const HELP = `Usage: bot <command> [args]

  available                           Tasks this bot can start now (and why others can't)
  tasks                               List confirmed tasks
  show <task>                         Task Setup summary to confirm with the user
  next <task>                         Start (or resume) the next row: prints its card
  row <task> <row>                    Show a row's card again
  record <task> <row> --outcome <o> [--insurance "<primary>"] [--notes "<note>"] --confirm <k1,k2,...>
                                      Write the outcome to the sheet now
  alert <task> --kind otp|login_failed|question|error --message "<text>" [--row <n>]
  heartbeat <task>                    Tell the app the bot is still working
  report <task>                       End-of-session report
  release <task>                      Give the task back (another bot can take it)

Every command takes --as "<bot name>" (or set BILLING_BOT). Each bot that runs at the same time needs its own
name, e.g. --as "Bot 2". One bot works one task at a time.

Outcomes: demo_done, already_added, not_eligible, held (demo) · claim_created, held (claim) · submitted, held (submission)
Add --json to any command for raw JSON.`;

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'json') opts.json = true;
      else if (k === 'as') { BOT = argv[i + 1]; i++; }
      else { opts[k] = argv[i + 1]; i++; }
    } else pos.push(a);
  }
  return { pos, opts };
}

async function call(method, path, body) {
  if (!TOKEN) throw new Error('BILLING_TOKEN is not set. Create a bot token in Billing Control → Bot access.');
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-bot-name': BOT },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

function printCard(r) {
  const c = r.card;
  const out = [`ROW ${r.row_no}${r.resumed ? ' (resumed: finish this row first)' : ''}`];
  if (c.blockers.length) out.push('BLOCKERS (do not create; hold or ask):', ...c.blockers.map((b) => `  ✗ ${b}`));
  if (c.warnings.length) out.push('WARNINGS:', ...c.warnings.map((w) => `  ! ${w}`));
  if (c.kind === 'demo') {
    out.push('STEPS:', ...c.steps.map((s, i) => `  ${i + 1}. ${s}`));
    out.push('ADD NEW PATIENT (Office Ally field → value):');
    for (const f of c.fields) out.push(`  ${f.field.padEnd(11)} ${f.lookup ? '[LOOK UP IN PORTAL]' : f.value || '(blank in sheet)'}`);
    const ins = c.insurance;
    out.push('PRIMARY INSURANCE:',
      `  Sheet says      ${ins.sheet_value || '(blank)'}`,
      `  OA payer        ${ins.oa_payer_name || '(not in payer list)'}${ins.payer_id ? `  · payer ID ${ins.payer_id}` : ''}`,
      `  Plan type       ${ins.plan_type || '?'}  · portal ${ins.portal || '?'}`,
      `  Member ID       ${ins.member_id || '[LOOK UP]'}`,
      `  Subscriber      ${ins.subscriber} · relationship ${ins.relationship}`,
      `  Write to sheet  ${ins.sheet_insurance_name || '(payer list name)'}`,
      `  Eligibility date (DOS): ${c.dos_mdy || 'MISSING: ask the user'}`);
  } else {
    out.push(`PATIENT ${c.patient.last}, ${c.patient.first} · DOB ${c.patient.dob_mdy} · DOS ${c.dos_mdy}${c.pos ? ` · POS ${c.pos}` : ''}`);
    out.push(`PROVIDERS rendering ${c.providers.rendering.name} (${c.providers.rendering.npi}) · billing NPI ${c.providers.billing.npi}${c.providers.billing.tax_id ? ` · Tax ID ${c.providers.billing.tax_id}` : ''}`);
    if (c.facility) out.push(`BOX 32 FACILITY ${c.facility.name} · ${c.facility.address}`);
    if (c.referring) out.push(`REFERRING ${c.referring}`);
    if (c.prior_auth) out.push(`PRIOR AUTH (Box 23) ${c.prior_auth}`);
    out.push(`BOX 21 ICD-10 ${c.diagnoses.map((d, i) => `${String.fromCharCode(65 + i)}. ${d}`).join('  ')}`);
    out.push('BOX 24 LINES:');
    for (const l of c.lines) {
      out.push(`  ${l.line}. ${l.cpt} mods:${l.modifiers.join(' ') || '-'} units:${l.units} charge:${l.charge_cents == null ? '?' : (l.charge_cents / 100).toFixed(2)} ptr:${l.dx_pointer || '?'}${l.drug ? `  NDC: ${l.ndc ? l.ndc.entry : 'MISSING'}` : ''}`);
    }
    out.push('CHECKS:', ...c.checks.map((k) => `  ${k.ok ? '✓' : '✗'} ${k.check}: sheet "${k.sheet}" vs ${k.setup}`));
  }
  if (r.outcomes_allowed) {
    out.push('WHEN DONE, RECORD ONE OF:');
    for (const o of r.outcomes_allowed) out.push(`  --outcome ${o.outcome}${Object.keys(o.checklist).length ? ` --confirm ${Object.keys(o.checklist).join(',')}` : ''}`);
  }
  return out.join('\n');
}

async function main() {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  const [cmd, a, b] = pos;
  let data;
  switch (cmd) {
    case 'tasks':
      data = await call('GET', '/api/tasks');
      if (!opts.json) {
        if (!data.length) return console.log('No confirmed tasks. Ask the user to confirm a Task Setup in Billing Control.');
        return console.log(data.map((t) => `#${t.id} ${t.task_type} · ${t.practice_name} · ${t.provider_name} · ${t.tab_name} rows ${t.row_from || 2}-${t.row_to || 'end'} · worked ${t.worked}/${t.rows_total}${t.bot_paused ? ' · PAUSED' : ''}`).join('\n'));
      }
      break;
    case 'available':
      data = await call('GET', '/api/bot/available');
      if (!opts.json) {
        if (!data.length) return console.log('No confirmed tasks. Ask the user to confirm a Task Setup in Billing Control.');
        return console.log(data.map((t) => `${t.available ? 'READY  ' : 'BLOCKED'} #${t.id} ${t.task_type} · ${t.practice_name} · ${t.provider_name} · ${t.tab_name}${t.bot ? ` · worked by ${t.bot}` : ''}${t.reason ? `\n         ${t.reason}` : ''}`).join('\n'));
      }
      break;
    case 'release':
      data = await call('POST', `/api/tasks/${a}/release`);
      if (!opts.json) return console.log(`Task #${a} released by ${BOT}.`);
      break;
    case 'show':
      data = await call('GET', `/api/tasks/${a}`);
      if (!opts.json) {
        return console.log([
          `Task #${data.id} · ${data.task_type}`,
          `Practice:          ${data.practice_name}`,
          `Provider:          ${data.provider_name} · NPI ${data.provider_npi}`,
          `Billing NPI / TIN: ${data.billing_npi || '(same as provider)'} / ${data.billing_tax_id || '-'}`,
          `Facilities:        ${data.facilities.map((f) => `${f.name} — ${f.address}`).join(' | ') || '-'}`,
          `Office Ally:       ${data.oa_account}`,
          `Sheet / tab:       ${data.sheet_link} › ${data.tab_name}`,
          `Columns:           Status ${data.status_col} · Insurance ${data.insurance_col} · Notes ${data.notes_col}`,
          `Rows:              ${data.row_from || 2}-${data.row_to || 'last row'}${data.dos_from || data.dos_to ? ` · DOS ${data.dos_from || '…'} to ${data.dos_to || '…'}` : ''}`,
          `Portals:           ${data.portals.join(', ')}`,
          `Portal links:      ${(data.portal_links || []).map((p) => `${p.name} ${p.url}`).join(' | ') || '-'}`,
          `Special:           ${data.special_instructions || '-'}`,
          `State:             ${data.state}${data.bot_paused ? ' · PAUSED (stop and ask the user)' : ''}`,
          '', 'Confirm this setup with the user before touching any record.',
        ].join('\n'));
      }
      break;
    case 'next':
      data = await call('POST', `/api/tasks/${a}/next`);
      if (!opts.json) return console.log(data.done ? `${data.message} (Task released.)` : `[${BOT} · task #${a}]\n${printCard(data)}`);
      break;
    case 'row':
      data = await call('GET', `/api/tasks/${a}/rows/${b}`);
      if (!opts.json) return console.log(printCard({ ...data, row_no: b }));
      break;
    case 'record':
      data = await call('POST', `/api/tasks/${a}/rows/${b}/record`, {
        outcome: opts.outcome, insurance: opts.insurance, notes: opts.notes,
        checklist: String(opts.confirm || '').split(',').map((x) => x.trim()).filter(Boolean),
      });
      if (!opts.json) {
        console.log(`Row ${data.row_no} written: ${data.written.map((w) => `${w.cell}="${w.value}"`).join(', ') || '(nothing to write)'}`);
        if (data.stop_and_ask) { console.log(`\nSTOP AND ASK THE USER: ${data.stop_and_ask}`); process.exitCode = 3; }
        return;
      }
      break;
    case 'alert':
      data = await call('POST', `/api/tasks/${a}/alerts`, { kind: opts.kind, message: opts.message, row: opts.row });
      if (!opts.json) return console.log(`Alert sent${data.paused ? '; task paused until the user resolves it' : ''}.`);
      break;
    case 'heartbeat':
      data = await call('POST', `/api/tasks/${a}/heartbeat`);
      if (!opts.json) return console.log(data.paused ? 'PAUSED: stop and ask the user.' : 'ok');
      break;
    case 'report':
      data = await call('GET', `/api/tasks/${a}/report`);
      if (!opts.json) return console.log(data.text);
      break;
    default:
      console.log(HELP);
      process.exitCode = cmd ? 1 : 0;
      return;
  }
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  if (e.data && e.data.problems) console.error(e.data.problems.map((p) => `  - ${p}`).join('\n'));
  process.exitCode = e.status === 423 ? 4 : 2;
});
