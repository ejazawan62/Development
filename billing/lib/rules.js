'use strict';
// The SOP rules enforced on every recorded outcome.

const OUTCOMES = {
  demo_done: { status: 'Demo Done', types: ['demo'], needsInsurance: true },
  already_added: { status: 'Already demo added', types: ['demo'], needsInsurance: true },
  not_eligible: { status: '', types: ['demo'], needsNote: 'Not eligible on DOS' },
  claim_created: { status: 'Claim Created', types: ['claim'], claim: true },
  submitted: { status: 'Submitted', types: ['submission'], claim: true },
  held: { status: 'Held', types: ['demo', 'claim', 'submission'], needsNote: 'Held' },
};

const CHECKLISTS = {
  demo_done: {
    searched_no_duplicate: 'Searched Office Ally Patients by last + first name and DOB: not found',
    eligibility_on_dos: 'Eligibility checked in the right portal with the date set to the DOS: active',
    entered_and_double_checked: 'Name, DOB and member ID double-checked against the portal result',
    appears_in_search: 'Saved, and the patient now appears in the patient search',
  },
  already_added: {
    found_by_name_and_dob: 'Found in Office Ally Patients by last + first name, confirmed by DOB',
  },
  not_eligible: {
    searched_no_duplicate: 'Searched Office Ally Patients first',
    eligibility_on_dos: 'Eligibility checked with the date set to the DOS: not active',
  },
  claim: {
    demo_exists: 'Demo exists in Office Ally (searched by name, confirmed DOB)',
    insurance_active_on_dos: 'Primary insurance from the demo is correct and active on the DOS',
    providers_from_task_setup: 'Rendering and billing provider: the Task Setup provider if one is given, otherwise the Office Ally provider matching the sheet',
    facility_box32_matches: 'Box 32: the Office Ally location whose address exactly matches the sheet (new locations added first)',
    line_review_done: 'Re-read line by line: patient, DOS, codes, units, modifiers, pointers, charges, NDCs',
    saved_in_patient_visits_only: 'Saved in Patient Visits only; not sent from Claims/Billing, not in Claims Awaiting Batch',
  },
};

function checklistFor(outcome) {
  if (OUTCOMES[outcome] && OUTCOMES[outcome].claim) return CHECKLISTS.claim;
  return CHECKLISTS[outcome] || {};
}

const SECRET_PATTERN = /\b(password|passwd|pwd|passcode|pass\s*word)\b/i;

/** Normalises "Held - x" / "held: x" to the standard "Held — x". */
function standardizeNote(note) {
  return String(note || '').trim()
    .replace(/^held\s*[-–—:]\s*/i, 'Held — ')
    .replace(/^not eligible on dos\s*[-–—:]\s*/i, 'Not eligible on DOS — ')
    .replace(/\s*;\s*held\s*[-–—:]\s*/gi, '; Held — ');
}

/** The issue a note is about, for spotting the same problem on many rows. */
function issueKey(note) {
  const first = standardizeNote(note).split(';')[0].trim();
  return first.replace(/\s*\(.*?\)\s*$/, '').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Validates an outcome before anything is written. Throws { status, message } on failure.
 * ctx = { task, outcome, insurance, notes, checklist, precheck, payers, actor }
 */
function validateRecord(ctx) {
  const { task, outcome, precheck } = ctx;
  const fail = (message, status = 422) => { throw Object.assign(new Error(message), { status }); };
  const def = OUTCOMES[outcome];
  if (!def) fail(`Unknown outcome "${outcome}". Use one of: ${Object.keys(OUTCOMES).filter((o) => OUTCOMES[o].types.includes(task.task_type)).join(', ')}`);
  if (!def.types.includes(task.task_type)) {
    fail(`"${outcome}" is not allowed in a ${task.task_type} task. Allowed: ${Object.keys(OUTCOMES).filter((o) => OUTCOMES[o].types.includes(task.task_type)).join(', ')}`);
  }

  const notes = standardizeNote(ctx.notes);
  const insurance = String(ctx.insurance || '').trim();
  if (SECRET_PATTERN.test(notes) || SECRET_PATTERN.test(insurance)) fail('Notes look like they contain a password. Never write passwords anywhere.');

  if (def.needsNote) {
    if (!notes) fail(`A note is required for "${outcome}" explaining why (rule 12).`);
    if (!notes.startsWith(def.needsNote)) fail(`The note must start with "${def.needsNote} — " (standard wording).`);
  }

  if (def.claim && precheck && precheck.blockers.length) {
    fail(`Pre-checks failed, so this claim must be held, not created: ${precheck.blockers.join('; ')}`, 409);
  }

  if (insurance) {
    if (/secondary|\s[/&+]\s|\bsec\b/i.test(insurance) || insurance.includes(' / ')) fail('Insurance column takes the primary insurance only (rule 9).');
    const payers = ctx.payers || [];
    if (payers.length && !payers.some((p) => p.active && p.sheet_name.toLowerCase() === insurance.toLowerCase())) {
      fail(`"${insurance}" is not a sheet name in this practice's payer list. Use the payer list's name, or add the payer first.`);
    }
  }
  if (def.needsInsurance && !insurance) fail('Write the primary insurance name for this outcome (Step A2/A6).');

  const required = Object.keys(checklistFor(outcome));
  const given = new Set(ctx.checklist || []);
  const missing = required.filter((k) => !given.has(k));
  if (missing.length) fail(`Confirm these steps first: ${missing.map((k) => `${k} (${checklistFor(outcome)[k]})`).join('; ')}`);

  return { notes, insurance, status: def.status };
}

/** Appends a note to whatever the team already wrote, without repeating it. */
function mergeNotes(existing, note) {
  const e = String(existing || '').trim();
  if (!note) return e;
  if (!e) return note;
  if (e.split(/\s*\|\s*/).includes(note)) return e;
  return `${e} | ${note}`;
}

function buildReport(task, records, alerts, inScopeRows) {
  const latest = new Map();
  for (const r of records) latest.set(r.row_no, r);
  const counts = {};
  for (const o of Object.keys(OUTCOMES)) counts[o] = 0;
  const reasons = new Map();
  for (const r of latest.values()) {
    counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    if (r.outcome === 'held' || r.outcome === 'not_eligible') {
      for (const part of r.notes.split(';').map((x) => x.trim()).filter(Boolean)) {
        if (!reasons.has(part)) reasons.set(part, []);
        reasons.get(part).push(r.row_no);
      }
    }
  }
  const lastRecord = records.length ? records.reduce((a, b) => (b.id > a.id ? b : a)) : null;
  const worked = new Set(latest.keys());
  const remaining = inScopeRows.filter((n) => !worked.has(n));
  return {
    task: {
      id: task.id, type: task.task_type, practice: task.practice_name, provider: task.provider_name, provider_npi: task.provider_npi,
      sheet: task.tab_name, rows: `${task.row_from || 2}–${task.row_to || 'last row'}`,
    },
    demos: { demo_done: counts.demo_done, already_added: counts.already_added, not_eligible: counts.not_eligible },
    claims: { claim_created: counts.claim_created, submitted: counts.submitted },
    held: counts.held,
    reasons: [...reasons.entries()].map(([reason, rows]) => ({ reason, rows })),
    last_row_completed: lastRecord ? lastRecord.row_no : null,
    next_row: remaining.length ? remaining[0] : null,
    not_worked: remaining.length,
    open_questions: alerts.filter((a) => !a.resolved && (a.kind === 'question' || a.kind === 'repeat_issue')).map((a) => a.message),
  };
}

function reportText(r) {
  const lines = [
    `Task #${r.task.id} · ${r.task.type} · ${r.task.practice} · ${r.task.provider ? `${r.task.provider} (NPI ${r.task.provider_npi})` : 'provider from Office Ally'}`,
    `Tab: ${r.task.sheet} · rows ${r.task.rows}`,
  ];
  if (r.task.type === 'demo') lines.push(`Demos: ${r.demos.demo_done} Demo Done · ${r.demos.already_added} Already demo added · ${r.demos.not_eligible} not eligible · ${r.held} held`);
  else lines.push(`Claims: ${r.task.type === 'submission' ? r.claims.submitted + ' Submitted' : r.claims.claim_created + ' Claim Created'} · ${r.held} held`);
  if (r.reasons.length) {
    lines.push('Held / skipped reasons:');
    for (const x of r.reasons) lines.push(`  - ${x.reason} (rows ${x.rows.join(', ')})`);
  }
  lines.push(`Last row completed: ${r.last_row_completed ?? 'none'}${r.next_row ? ` · next session starts at row ${r.next_row}` : ' · all rows worked'}`);
  if (r.open_questions.length) {
    lines.push('Open questions:');
    r.open_questions.forEach((q, i) => lines.push(`  ${i + 1}. ${q}`));
  }
  return lines.join('\n');
}

module.exports = { OUTCOMES, CHECKLISTS, checklistFor, validateRecord, standardizeNote, issueKey, mergeNotes, buildReport, reportText };
