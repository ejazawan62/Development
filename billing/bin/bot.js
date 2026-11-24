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
  record <task> <row> --outcome <o> [--insurance "<primary>"] [--notes "<note>"] --confirm <k1,k2,...> [--next]
                                      Write the outcome to the sheet now; with --next also start the next row
  list <task>                         All rows at once (row, patient, DOB, DOS, insurance, member ID, status)
  cards <task>                        Every remaining row's full card at once ("load everything" mode)
  alert <task> --kind otp|login_failed|question|error --message "<text>" [--row <n>]
  heartbeat <task>                    Tell the app the bot is still working
  report <task>                       End-of-session report
  release <task>                      Give the task back (another bot can take it)
  inbox <task>                        New messages from people, and whether the task is paused
  say <task> "<text>"                 Send a message to the people watching this task in Billing Control
  wait <task> [--timeout <seconds>]   While paused: wait until a person writes or resumes (default 300 s)

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
      else if (k === 'next') opts.next = true;
      else if (k === 'as') { BOT = argv[i + 1]; i++; }
      else { opts[k] = argv[i + 1]; i++; }
    } else pos.push(a);
  }
  return { pos, opts };
}

async function call(method, path, body) {
  if (!TOKEN) throw new Error('BILLING_TOKEN is not set. Create a bot token in Billing Control → Bot access.');
  // Billing Control restarts for a few seconds when it installs an update: wait for it instead of failing.
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-bot-name': BOT },
        body: body ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (e) {
      if (attempt >= 30) throw new Error(`Billing Control is not answering at ${BASE}. Is it running?`);
      if (attempt === 0) process.stderr.write('Billing Control is restarting, waiting…\n');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

function inboxText(r) {
  const lines = [];
  for (const m of (r && r.inbox) || []) {
    lines.push(`>>> ${m.kind === 'pause' ? 'PAUSE' : m.kind === 'resume' ? 'RESUMED' : 'MESSAGE'} FROM ${m.author} (${m.created_at} UTC): ${m.body}`);
  }
  if (r && r.paused) lines.push(`>>> TASK IS PAUSED${r.paused_by ? ` by ${r.paused_by}` : ''}. Don't save anything. Follow the messages, reply with "say", then run "wait" until it says RESUMED.`);
  return lines.length ? lines.join('\n') + '\n' : '';
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
    if (c.providers.source === 'office_ally') out.push(`PROVIDER from Office Ally: select "${c.providers.rendering.name}" (rendering; billing as set up in Office Ally). No exact match → hold "Held — provider not in Office Ally"`);
    else out.push(`PROVIDERS (Task Setup, locked) rendering ${c.providers.rendering.name} (${c.providers.rendering.npi}) · billing NPI ${c.providers.billing.npi}${c.providers.billing.tax_id ? ` · Tax ID ${c.providers.billing.tax_id}` : ''}`);
    if (c.facility && c.facility.source === 'new_location') out.push(`BOX 32 FACILITY (new location, add in Office Ally first if not done) ${c.facility.name} · ${c.facility.address}`);
    else if (c.facility) out.push(`BOX 32 FACILITY: the Office Ally location whose address is exactly "${c.facility.address}"${c.facility.name ? ` (sheet office: ${c.facility.name})` : ''}. No exact match → hold "Held — facility address mismatch"`);
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
    case 'cards': {
      data = await call('GET', `/api/tasks/${a}/cards`);
      if (!opts.json) {
        process.stdout.write(inboxText(data));
        if (!data.cards.length) return console.log('No rows left to work in this task.');
        const out = [`[${BOT} · task #${a}] ${data.cards.length} patient(s) to work. Work them top to bottom; after EACH one run "record" (without --next).`];
        for (const c of data.cards) out.push('', '─'.repeat(60), printCard({ ...c, outcomes_allowed: null }));
        out.push('', 'RECORD EACH ONE WITH:', ...data.outcomes_allowed.map((o) => `  --outcome ${o.outcome}${Object.keys(o.checklist).length ? ` --confirm ${Object.keys(o.checklist).join(',')}` : ''}`));
        return console.log(out.join('\n'));
      }
      break;
    }
    case 'list': {
      data = await call('GET', `/api/tasks/${a}/rows`);
      if (!opts.json) {
        const lines = data.map((r) => [r.row_no, r.patient, r.dob, r.dos, r.insurance || '-', r.member_id || '-',
          !r.in_scope ? `skip: ${r.reason}` : r.record ? `done: ${r.record.status_text || r.record.outcome}` : r.blockers && r.blockers.length ? `blocked: ${r.blockers[0]}` : 'to do'].join(' | '));
        return console.log(['row | patient | DOB | DOS | insurance | member ID | state', ...lines].join('\n'));
      }
      break;
    }
    case 'show':
      data = await call('GET', `/api/tasks/${a}`);
      if (!opts.json) {
        return console.log([
          `Task #${data.id} · ${data.task_type}`,
          `Practice:          ${data.practice_name}`,
          ...(data.task_type === 'demo' ? [] : [
            `Provider:          ${data.provider_name ? `${data.provider_name} · NPI ${data.provider_npi} (only this provider)` : 'from Office Ally (match each sheet row)'}`,
            `Billing NPI / TIN: ${data.billing_npi || 'as set up in Office Ally'} / ${data.billing_tax_id || 'as set up in Office Ally'}`,
            `New locations:     ${data.facilities.map((f) => `${f.name} — ${f.address}`).join(' | ') || 'none (use Office Ally locations)'}`]),
          `Office Ally:       ${data.oa_account}`,
          `Sheet / tab:       ${data.sheet_link} › ${data.tab_name}`,
          `Columns:           Status ${data.status_col} · Insurance ${data.insurance_col} · Notes ${data.notes_col}`,
          `Rows:              ${data.row_from || 2}-${data.row_to || 'last row'}${data.rework_done ? ' (including rows that already have a status: redo them)' : ''}${data.dos_from || data.dos_to ? ` · DOS ${data.dos_from || '…'} to ${data.dos_to || '…'}` : ''}`,
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
      if (!opts.json) return console.log(inboxText(data) + (data.done ? `${data.message} (Task released.)` : `[${BOT} · task #${a}]\n${printCard(data)}`));
      break;
    case 'row':
      data = await call('GET', `/api/tasks/${a}/rows/${b}`);
      if (!opts.json) return console.log(printCard({ ...data, row_no: b }));
      break;
    case 'record':
      data = await call('POST', `/api/tasks/${a}/rows/${b}/record`, {
        outcome: opts.outcome, insurance: opts.insurance, notes: opts.notes,
        checklist: String(opts.confirm || '').split(',').map((x) => x.trim()).filter(Boolean),
        then_next: !!opts.next,
      });
      if (!opts.json) {
        process.stdout.write(inboxText(data));
        console.log(`Row ${data.row_no} written: ${data.written.map((w) => `${w.cell}="${w.value}"`).join(', ') || '(nothing to write)'}`);
        if (data.stop_and_ask) { console.log(`\nSTOP AND ASK THE USER: ${data.stop_and_ask}`); process.exitCode = 3; return; }
        if (data.next) {
          if (data.next.error) { console.log(`\nNEXT: ${data.next.error}`); process.stdout.write(inboxText({ inbox: data.next.inbox })); if (data.next.status === 423) process.exitCode = 4; return; }
          console.log('');
          process.stdout.write(inboxText(data.next));
          console.log(data.next.done ? `${data.next.message} (Task released.)` : `[${BOT} · task #${a}]\n${printCard(data.next)}`);
        }
        return;
      }
      break;
    case 'alert':
      data = await call('POST', `/api/tasks/${a}/alerts`, { kind: opts.kind, message: opts.message, row: opts.row });
      if (!opts.json) return console.log(`Alert sent${data.paused ? '; task paused until the user resolves it' : ''}.`);
      break;
    case 'heartbeat':
    case 'inbox':
      data = await call('POST', `/api/tasks/${a}/heartbeat`);
      if (!opts.json) return console.log(inboxText(data) || 'No new messages. Not paused.');
      break;
    case 'say': {
      const text = pos.slice(2).join(' ');
      data = await call('POST', `/api/tasks/${a}/messages`, { body: text });
      if (!opts.json) return console.log('Sent.');
      break;
    }
    case 'wait': {
      const secs = Number(opts.timeout) || 300;
      process.stderr.write(`Waiting up to ${secs} s for a message on task #${a}…\n`);
      data = await call('GET', `/api/tasks/${a}/wait?timeout=${secs}`);
      if (!opts.json) {
        const text = inboxText(data);
        if (!text) return console.log('No new messages yet. Still paused: run "wait" again.');
        if (!data.paused) return console.log(text + 'Not paused any more: continue with "next".');
        return console.log(text);
      }
      break;
    }
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
  if (e.data && e.data.inbox) process.stdout.write(inboxText({ inbox: e.data.inbox }));
  console.error(`ERROR: ${e.message}`);
  if (e.data && e.data.problems) console.error(e.data.problems.map((p) => `  - ${p}`).join('\n'));
  process.exitCode = e.status === 423 ? 4 : 2;
});
