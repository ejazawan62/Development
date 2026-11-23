'use strict';
// Pre-checks that run on a sheet row before the bot (or a person) touches Office Ally.
// "blockers" mean the row must be held (claims) or cannot be worked yet (demos);
// "warnings" are shown but do not block; "todos" tell the bot which lookup to do first.

const STATES = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT',
  DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL',
  INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT',
  NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA',
  'PUERTO RICO': 'PR', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN',
  TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI', WYOMING: 'WY',
};
const STATE_CODES = new Set(Object.values(STATES));

const ADDRESS_WORDS = {
  STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', ROAD: 'RD', BOULEVARD: 'BLVD', DRIVE: 'DR', LANE: 'LN', COURT: 'CT',
  PLACE: 'PL', SUITE: 'STE', APARTMENT: 'APT', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', FLOOR: 'FL',
  BUILDING: 'BLDG', HIGHWAY: 'HWY', PARKWAY: 'PKWY', CIRCLE: 'CIR', TERRACE: 'TER', ROOM: 'RM', SQUARE: 'SQ',
  EXPRESSWAY: 'EXPY', TURNPIKE: 'TPKE', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  MOUNT: 'MT', FORT: 'FT', SAINT: 'ST',
};

const PROVIDER_TITLES = new Set(['DR', 'MD', 'DO', 'NP', 'PA', 'PAC', 'FNP', 'FNPC', 'FNPBC', 'DPM', 'RN', 'APRN', 'PHD', 'DNP', 'ANP', 'AGNP', 'DMD', 'DDS', 'OD', 'LCSW', 'PT', 'DPT', 'OT', 'MBBS']);

const ICD10 = /^[A-TV-Z][0-9][0-9A-Z](\.?[0-9A-Z]{1,4})?$/;
const PROC = /^(\d{4}[0-9A-Z]|[A-V]\d{4})$/;
const MODIFIER = /^[0-9A-Z]{2}$/;
const NDC_UNITS = new Set(['UN', 'ML', 'GR', 'F2', 'ME']);
const MBI_LETTER = 'AC-HJKMNP-RT-Y';
const MBI = new RegExp(`^[1-9][${MBI_LETTER}][${MBI_LETTER}0-9][0-9][${MBI_LETTER}][${MBI_LETTER}0-9][0-9][${MBI_LETTER}]{2}[0-9]{2}$`);

const s = (v) => (v == null ? '' : String(v)).trim();
const upper = (v) => s(v).toUpperCase();

function isIsoDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Parses the date formats people type into sheets. Returns ISO YYYY-MM-DD or null. */
function parseDate(v, { past = false } = {}) {
  const t = s(v);
  if (!t) return null;
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  let y; let mo; let d;
  if (m) { [, y, mo, d] = m; } else {
    m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
    if (!m) return null;
    [, mo, d, y] = m;
    if (y.length === 2) {
      // Two-digit years: for birth dates pick the most recent past century.
      const yy = Number(y);
      const nowYY = new Date().getUTCFullYear() % 100;
      y = String(past ? (yy > nowYY ? 1900 + yy : 2000 + yy) : 2000 + yy);
    }
  }
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

const toMDY = (iso) => (iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : '');
const today = () => new Date().toISOString().slice(0, 10);

/** NPI check digit: Luhn over "80840" + the first 9 digits. */
function isValidNpi(npi) {
  const n = s(npi);
  if (!/^\d{10}$/.test(n)) return false;
  const base = '80840' + n.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    let d = Number(base[base.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(n[9]);
}

function isMbi(v) { return MBI.test(upper(v).replace(/[\s-]/g, '')); }

function normalizeText(v) { return upper(v).replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' '); }

/** Canonical form of an address for comparison: abbreviations, state codes, ZIP5. */
function normalizeAddress(v) {
  let t = upper(v).replace(/#/g, ' STE ').replace(/(\d{5})-?\d{4}\b/g, '$1');
  for (const [name, code] of Object.entries(STATES)) {
    if (name.includes(' ')) t = t.replace(new RegExp(`\\b${name}\\b`, 'g'), code);
  }
  return t.replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/)
    .map((w) => ADDRESS_WORDS[w] || STATES[w] || w)
    .filter((w, i, arr) => !(w === 'STE' && arr[i - 1] === 'STE') && !(w === 'STE' && ['APT', 'UNIT', 'RM', 'FL', 'BLDG'].includes(arr[i - 1])))
    .join(' ');
}

const stripZip = (norm) => norm.replace(/\s\d{5}$/, '');

/** Strict address match. Returns { match, warning }. */
function addressesMatch(sheetAddr, setupAddr) {
  const a = normalizeAddress(sheetAddr);
  const b = normalizeAddress(setupAddr);
  if (!a || !b) return { match: false };
  if (a === b) return { match: true };
  const aHasZip = /\s\d{5}$/.test(a);
  const bHasZip = /\s\d{5}$/.test(b);
  if (!aHasZip && bHasZip && a === stripZip(b)) return { match: true, warning: 'Sheet facility address has no ZIP; street, city and state match' };
  return { match: false };
}

function providerTokens(v) {
  return normalizeText(v).split(' ').filter((t) => t && !PROVIDER_TITLES.has(t)).sort();
}

/** The sheet's provider must be the Task Setup provider (same name tokens, or the same NPI). */
function providerMatches(sheetValue, setupName, setupNpi) {
  const raw = s(sheetValue);
  if (!raw) return false;
  const npis = raw.match(/\b\d{10}\b/g) || [];
  if (npis.length) return npis.every((n) => n === s(setupNpi));
  const a = providerTokens(raw);
  const b = providerTokens(setupName);
  return a.length > 0 && a.length === b.length && a.every((t, i) => t === b[i]);
}

function parseMoneyCents(v) {
  const t = s(v).replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** Converts an NDC to the 11-digit 5-4-2 form. Returns { ndc11 } or { error }. */
function normalizeNdc(v) {
  const t = upper(v).replace(/^N4/, '').trim();
  const dashed = t.match(/^(\d{4,5})-(\d{3,4})-(\d{1,2})$/);
  if (dashed) {
    const [, a, b, c] = dashed;
    const shape = `${a.length}-${b.length}-${c.length}`;
    if (shape === '5-4-2') return { ndc11: a + b + c };
    if (shape === '4-4-2') return { ndc11: '0' + a + b + c, converted: true };
    if (shape === '5-3-2') return { ndc11: a + '0' + b + c, converted: true };
    if (shape === '5-4-1') return { ndc11: a + b + '0' + c, converted: true };
    return { error: `NDC "${s(v)}" has an unknown segment layout` };
  }
  const digits = t.replace(/\s/g, '');
  if (/^\d{11}$/.test(digits)) return { ndc11: digits };
  if (/^\d{10}$/.test(digits)) return { error: `NDC "${s(v)}" is 10 digits without dashes, so it can't be converted to 11 digits safely` };
  return { error: `NDC "${s(v)}" is not a valid NDC` };
}

/** Parses one NDC entry, which may carry its unit and quantity inline ("00641-0367-21 ML 2"). */
function parseNdcEntry(entry, unitCell, qtyCell) {
  const t = upper(entry).replace(/^N4\s*/, '');
  const m = t.match(/^([\d-]+)\s*(?:(UN|ML|GR|F2|ME)\s*([\d.]+))?$/);
  if (!m) return { error: `NDC "${s(entry)}" is not in a recognised format` };
  const n = normalizeNdc(m[1]);
  if (n.error) return n;
  const unit = m[2] || upper(unitCell);
  const qty = m[3] || s(qtyCell);
  if (!unit || !qty) return { error: `NDC ${m[1]} has no unit qualifier/quantity`, ndc11: n.ndc11 };
  if (!NDC_UNITS.has(unit)) return { error: `NDC unit "${unit}" must be one of UN, ML, GR, F2, ME`, ndc11: n.ndc11 };
  if (!(Number(qty) > 0)) return { error: `NDC quantity "${qty}" must be greater than 0`, ndc11: n.ndc11 };
  return { ndc11: n.ndc11, unit, qty: String(Number(qty)), converted: n.converted, source: s(entry), entry: `N4${n.ndc11} ${unit}${Number(qty)}` };
}

function isDrugCode(code, extra) {
  return /^J\d{4}$/.test(code) || /^Q51\d{2}$/.test(code) || extra.has(code);
}

function lineSeparator(cell) {
  const t = s(cell);
  if (t.includes('\n')) return /\n/;
  if (t.includes(';')) return /;/;
  if (t.includes('|')) return /\|/;
  return /,/;
}
const splitBy = (cell, sep) => s(cell).split(sep).map((x) => x.trim()).filter(Boolean);
// Parallel lists keep empty entries so "25; ;" still lines up with three CPT codes.
const splitKeep = (raw, sep) => { const t = raw == null ? '' : String(raw); return t.trim() ? t.replace(/[\s;|,]+$/, (m) => (sep.test(m) ? m : '')).split(sep).map((x) => x.trim()) : []; };
const rawCell = (row, mapping, key) => { const idx = mapping[key]; return idx == null || idx < 0 ? '' : String(row[idx] == null ? '' : row[idx]); };

/** Reads a cell value by mapping key from a row (array of cells). */
function cell(row, mapping, key) {
  const idx = mapping[key];
  return idx == null || idx < 0 ? '' : s(row[idx]);
}

/** Patient name from separate columns, or "Last, First" in one column. */
function patientName(row, mapping) {
  const last = cell(row, mapping, 'last_name');
  const first = cell(row, mapping, 'first_name');
  if (last || first) return { last: upper(last), first: upper(first) };
  const full = cell(row, mapping, 'patient_name');
  const m = full.match(/^([^,]+),\s*(.+)$/);
  if (m) return { last: upper(m[1]), first: upper(m[2]) };
  return { last: '', first: '', unsplit: full };
}

function splitAddress(row, mapping) {
  const street = cell(row, mapping, 'address');
  const city = cell(row, mapping, 'city');
  const state = cell(row, mapping, 'state');
  const zip = cell(row, mapping, 'zip');
  const fix = (st) => STATES[upper(st)] || upper(st);
  if (city || state || zip) {
    return { address1: normalizeAddressLine(street), city: upper(city), state: fix(state), zip: zip.replace(/[^\d]/g, '').replace(/^(\d{5})(\d{4})$/, '$1-$2') };
  }
  const m = street.match(/^(.+?),\s*([^,]+?),\s*([A-Za-z .]+?),?\s+(\d{5}(?:-?\d{4})?)$/);
  if (!m) return street ? { unsplit: street } : {};
  return { address1: normalizeAddressLine(m[1]), city: upper(m[2]), state: fix(m[3].trim()), zip: m[4].replace(/^(\d{5})-?(\d{4})$/, '$1-$2') };
}

function normalizeAddressLine(v) {
  return upper(v).replace(/[.,]/g, '').split(/\s+/).filter(Boolean).map((w) => ADDRESS_WORDS[w] || w).join(' ');
}

function formatPhone(v) {
  const d = s(v).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
}

function normalizeGender(v) {
  const t = upper(v);
  if (['M', 'MALE'].includes(t)) return 'M';
  if (['F', 'FEMALE'].includes(t)) return 'F';
  return null;
}

/** Finds the payer-list entry for an insurance name written in the sheet. */
function findPayer(payers, insuranceName) {
  const key = normalizeText(insuranceName);
  if (!key) return null;
  for (const p of payers) {
    if (!p.active) continue;
    const names = [p.sheet_name, p.oa_payer_name, ...(p.aliases || [])].map(normalizeText);
    if (names.includes(key)) return p;
  }
  return null;
}

function inDosRange(dos, task) {
  if (!dos) return true;
  if (task.dos_from && dos < task.dos_from) return false;
  if (task.dos_to && dos > task.dos_to) return false;
  return true;
}

/** Row identity used to detect a re-sorted sheet before writing. */
function rowIdentity(row, mapping) {
  const n = patientName(row, mapping);
  return [n.last || '', n.first || '', normalizeText(n.unsplit || ''), parseDate(cell(row, mapping, 'dob'), { past: true }) || cell(row, mapping, 'dob')].join('|');
}

/** Demo entry card: everything the bot needs to type into Patients → Add New Patient. */
function demoCard(row, task, payers) {
  const m = task.mapping;
  const blockers = [];
  const warnings = [];
  const todos = [];
  const name = patientName(row, m);
  if (name.unsplit) blockers.push(`Patient name "${name.unsplit}" is not in "Last, First" form; can't split it safely`);
  else if (!name.last || !name.first) blockers.push('Patient first or last name is missing');

  const dobRaw = cell(row, m, 'dob');
  const dob = parseDate(dobRaw, { past: true });
  if (!dob) blockers.push(dobRaw ? `DOB "${dobRaw}" is not a valid date` : 'DOB is missing');
  else if (dob > today()) blockers.push('DOB is in the future');

  const dosRaw = cell(row, m, 'dos');
  const dos = parseDate(dosRaw);
  if (!dos) blockers.push(dosRaw ? `DOS "${dosRaw}" is not a valid date` : 'No DOS on this row: eligibility must use the DOS, never today. Ask the user which date to use');

  const gender = normalizeGender(cell(row, m, 'gender'));
  if (!gender) todos.push('Gender missing: take it from the insurance portal eligibility result');

  const addr = splitAddress(row, m);
  if (addr.unsplit) warnings.push(`Address "${addr.unsplit}" could not be split into street/city/state/ZIP automatically; split it by reading it exactly, don't guess missing parts`);
  else if (!addr.address1 || !addr.city || !addr.state || !addr.zip) warnings.push('Address is incomplete in the sheet');
  else {
    if (!STATE_CODES.has(addr.state)) warnings.push(`State "${addr.state}" is not a US state code`);
    if (!/^\d{5}(-\d{4})?$/.test(addr.zip)) warnings.push(`ZIP "${addr.zip}" is not 5 or 9 digits`);
  }

  const phoneRaw = cell(row, m, 'phone');
  const phone = formatPhone(phoneRaw);
  if (phoneRaw && !phone) warnings.push(`Phone "${phoneRaw}" is not a 10-digit number`);

  const insuranceRaw = task.insurance_idx != null ? s(row[task.insurance_idx]) : '';
  const payer = findPayer(payers, insuranceRaw);
  if (!insuranceRaw) todos.push('Insurance name missing: find the active plan on the DOS in the portals before adding');
  else if (!payer) blockers.push(`Insurance "${insuranceRaw}" is not in this practice's payer list: add a mapping first`);

  const memberId = upper(cell(row, m, 'member_id')).replace(/\s+/g, '');
  const portal = payer ? payer.portal : '';
  if (!memberId) todos.push(`Member ID missing: search ${portal || 'the insurance portal'} by last name, first name and DOB`);
  if (payer && payer.plan_type === 'medicare' && memberId && !isMbi(memberId)) todos.push(`"${memberId}" is not an MBI: use the Medicare MBI lookup (e.g. NGS) for the new MBI`);
  if (payer && (payer.plan_type === 'medicaid' || payer.plan_type === 'medicaid_mco') && !memberId) todos.push('Medicaid ID missing: look it up in the state Medicaid portal (e.g. ePACES) by name, DOB and gender');
  if (payer && payer.plan_type === 'medicare') todos.push('If eligibility shows a Medicare Advantage plan, that plan is primary, not Original Medicare');

  const steps = [
    `Confirm Office Ally is on: ${task.oa_account}`,
    `Search Patients for ${name.last || '?'}, ${name.first || '?'} and confirm DOB ${toMDY(dob) || '?'}. If found, record "already_added"`,
    ...todos,
    `Check eligibility in ${portal || 'the right portal'} with the date set to the DOS ${toMDY(dos) || '(missing)'}`,
  ];

  return {
    kind: 'demo',
    blockers, warnings, todos, steps,
    fields: [
      { field: 'Last Name', value: name.last, source: name.unsplit || cell(row, m, 'last_name') },
      { field: 'First Name', value: name.first, source: name.unsplit || cell(row, m, 'first_name') },
      { field: 'DOB', value: toMDY(dob), source: dobRaw },
      { field: 'Gender', value: gender || '', lookup: !gender, source: cell(row, m, 'gender') },
      { field: 'Address', value: addr.address1 || '', source: cell(row, m, 'address') },
      { field: 'City', value: addr.city || '', source: cell(row, m, 'city') || '(split)' },
      { field: 'State', value: addr.state || '', source: cell(row, m, 'state') || '(split)' },
      { field: 'ZIP', value: addr.zip || '', source: cell(row, m, 'zip') || '(split)' },
      { field: 'Phone', value: phone || '', source: phoneRaw },
    ],
    insurance: {
      sheet_value: insuranceRaw,
      oa_payer_name: payer ? payer.oa_payer_name : null,
      payer_id: payer ? payer.payer_id : null,
      plan_type: payer ? payer.plan_type : null,
      portal: portal || null,
      sheet_insurance_name: payer ? payer.sheet_name : null,
      member_id: memberId,
      subscriber: 'SELF',
      relationship: 'SELF',
    },
    dos, dos_mdy: toMDY(dos),
  };
}

/** Claim check for claim creation / submission rows. */
function claimCheck(row, task) {
  const m = task.mapping;
  const blockers = [];
  const warnings = [];
  const checks = [];
  const add = (check, ok, sheetVal, setupVal, failNote) => {
    checks.push({ check, ok, sheet: sheetVal, setup: setupVal });
    if (!ok && failNote) blockers.push(failNote);
  };

  const name = patientName(row, m);
  if (name.unsplit) blockers.push(`Held — patient name "${name.unsplit}" not in "Last, First" form`);
  const dobRaw = cell(row, m, 'dob');
  const dob = parseDate(dobRaw, { past: true });
  if (!dob) blockers.push('Held — patient DOB missing or invalid');

  if (m.practice != null && m.practice >= 0) {
    const pv = cell(row, m, 'practice');
    add('Practice', normalizeText(pv) === normalizeText(task.practice_name), pv, task.practice_name, `Held — practice is "${pv}", not ${task.practice_name}`);
  }

  const provRaw = cell(row, m, 'provider');
  add('Provider', providerMatches(provRaw, task.provider_name, task.provider_npi), provRaw, `${task.provider_name} · ${task.provider_npi}`,
    `Held — provider is ${provRaw || '(blank)'}, not the assigned provider`);

  // Facility: office name picks the setup facility; its address must match the sheet exactly.
  const office = cell(row, m, 'office_name');
  const facAddr = cell(row, m, 'facility_address');
  let facility = null;
  if (office) {
    facility = task.facilities.find((f) => normalizeText(f.name) === normalizeText(office)) || null;
    add('Office name', !!facility, office, task.facilities.map((f) => f.name).join(' / '), `Held — office "${office}" is not a Task Setup facility`);
  }
  if (!facAddr) add('Facility address', false, '', facility ? facility.address : '', 'Held — facility address missing in sheet');
  else {
    const candidates = facility ? [facility] : task.facilities;
    let hit = null;
    for (const f of candidates) {
      const r = addressesMatch(facAddr, f.address);
      if (r.match) { hit = f; if (r.warning) warnings.push(r.warning); break; }
    }
    add('Facility address', !!hit, facAddr, candidates.map((f) => f.address).join(' / '), 'Held — facility address mismatch');
    if (hit) facility = hit;
  }

  const dosRaw = cell(row, m, 'dos');
  const dos = parseDate(dosRaw);
  const dosOk = !!dos && dos <= today();
  add('Date of service', dosOk, dosRaw, task.dos_from || task.dos_to ? `${task.dos_from || '…'} to ${task.dos_to || '…'}` : 'valid, not future',
    dos ? 'Held — DOS is in the future' : 'Held — DOS missing or invalid');

  const dxRaw = cell(row, m, 'icd');
  const dx = splitBy(dxRaw, /[\n,;|\s]+/).map(upper);
  const badDx = dx.filter((c) => !ICD10.test(c));
  const dxOk = dx.length > 0 && dx.length <= 12 && badDx.length === 0;
  add('ICD-10', dxOk, dxRaw, 'valid ICD-10, 1–12 codes',
    dx.length === 0 ? 'Held — no ICD-10 codes on sheet' : badDx.length ? `Held — ICD-10 code ${badDx.join(', ')} is not valid` : 'Held — more than 12 ICD-10 codes');

  // Service lines.
  const cptCell = cell(row, m, 'cpt');
  const sep = lineSeparator(cptCell);
  const extra = new Set(splitBy(task.extra_drug_codes, /[\s,;]+/).map(upper));
  const cptEntries = splitBy(cptCell, sep);
  const list = (key) => (m[key] != null && m[key] >= 0 ? splitKeep(rawCell(row, m, key), sep) : null);
  const unitsList = list('units');
  const modsList = list('modifiers');
  const chargesList = list('charges');
  const ptrList = list('dx_pointers');

  const lineErrors = [];
  const lines = cptEntries.map((entry, i) => {
    // Accept "99213-25", "99213 25 59", "J1100 x2".
    const t = upper(entry).replace(/\s*[xX×]\s*(\d+(\.\d+)?)\s*$/, ' X$1');
    const parts = t.split(/[\s-]+/).filter(Boolean);
    const code = parts.shift() || '';
    let units = null;
    const inlineMods = [];
    for (const p of parts) {
      if (/^X\d+(\.\d+)?$/.test(p)) units = Number(p.slice(1));
      else inlineMods.push(p);
    }
    if (unitsList) units = unitsList.length === cptEntries.length ? Number(unitsList[i]) : NaN;
    if (units == null) units = 1;
    let mods = inlineMods;
    if (modsList && modsList.length) {
      if (modsList.length === cptEntries.length) mods = splitBy(modsList[i], /[\s,/-]+/).filter((x) => x !== '-');
      else if (cptEntries.length === 1) mods = splitBy(modsList.join(' '), /[\s,/-]+/);
      else lineErrors.push('Held — modifiers don\'t line up with CPT codes on sheet');
    }
    mods = mods.map(upper);
    let charge = null;
    if (chargesList) charge = chargesList.length === cptEntries.length ? parseMoneyCents(chargesList[i]) : undefined;
    let ptr = '';
    if (ptrList && ptrList.length === cptEntries.length) ptr = upper(ptrList[i]).replace(/[\s,]+/g, '');
    else if (dx.length === 1) ptr = 'A';
    return { line: i + 1, cpt: code, modifiers: mods, units, charge_cents: charge, dx_pointer: ptr, drug: isDrugCode(code, extra) };
  });

  if (!cptEntries.length) lineErrors.push('Held — no CPT/HCPCS codes on sheet');
  for (const l of lines) {
    if (!PROC.test(l.cpt)) lineErrors.push(`Held — "${l.cpt}" is not a valid CPT/HCPCS code`);
    if (!(l.units > 0)) lineErrors.push('Held — CPT/units don\'t match sheet');
    if (l.modifiers.length > 4 || l.modifiers.some((x) => !MODIFIER.test(x))) lineErrors.push(`Held — modifier on ${l.cpt} is not valid`);
    if (l.charge_cents === undefined) lineErrors.push('Held — charges don\'t line up with CPT codes on sheet');
    else if (chargesList && !(l.charge_cents > 0)) lineErrors.push(`Held — charge on ${l.cpt} is missing or invalid`);
  }
  if (ptrList && ptrList.length !== cptEntries.length) lineErrors.push('Held — diagnosis pointers don\'t line up with CPT codes on sheet');
  if (!ptrList && dx.length > 1) warnings.push('Sheet has no diagnosis pointer column and several ICD-10 codes: point each line exactly as the sheet/superbill shows; if it is not shown, hold the claim');
  if (!chargesList) warnings.push('No charges column mapped: enter charges from the superbill/fee schedule');

  // NDCs: either one per line or one per drug line, in order.
  const ndcRaw = rawCell(row, m, 'ndc');
  const ndcSep = lineSeparator(ndcRaw);
  let ndcList = splitKeep(ndcRaw, ndcSep);
  let unitCells = splitKeep(rawCell(row, m, 'ndc_unit'), ndcSep);
  let qtyCells = splitKeep(rawCell(row, m, 'ndc_qty'), ndcSep);
  const drugLines = lines.filter((l) => l.drug);
  let ndcFor = new Map();
  const parallel = ndcList.length > 1 && ndcList.length === lines.length && ndcList.some((x) => !x || x === '-');
  if (!parallel) {
    const keep = ndcList.map((x, i) => (x && x !== '-' ? i : -1)).filter((i) => i >= 0);
    ndcList = keep.map((i) => ndcList[i]);
    if (unitCells.length > 1) unitCells = keep.map((i) => unitCells[i]);
    if (qtyCells.length > 1) qtyCells = keep.map((i) => qtyCells[i]);
  }
  if (parallel) {
    lines.forEach((l, i) => { if (ndcList[i] && ndcList[i] !== '-') { l.drug = true; ndcFor.set(l, i); } });
  } else if (ndcList.length === drugLines.length) {
    drugLines.forEach((l, i) => ndcFor.set(l, i));
  } else if (ndcList.length === lines.length) {
    lines.forEach((l, i) => { l.drug = true; ndcFor.set(l, i); });
  } else if (ndcList.length) {
    lineErrors.push('Held — NDC count doesn\'t match drug lines');
    ndcFor = new Map();
  }
  for (const l of lines.filter((x) => x.drug)) {
    if (!ndcFor.has(l)) { if (ndcList.length === 0 || ndcList.length === drugLines.length) lineErrors.push(`Held — NDC missing (${l.cpt})`); continue; }
    const i = ndcFor.get(l);
    const parsed = parseNdcEntry(ndcList[i], unitCells[i] || unitCells[0], qtyCells[i] || qtyCells[0]);
    if (parsed.error) { l.ndc_error = parsed.error; lineErrors.push(`Held — NDC problem on ${l.cpt}: ${parsed.error}`); } else l.ndc = parsed;
  }
  const uniqueLineErrors = [...new Set(lineErrors)];
  blockers.push(...uniqueLineErrors);
  checks.push({ check: 'Service lines', ok: uniqueLineErrors.length === 0, sheet: cptCell, setup: 'codes, units, modifiers, charges, NDC' });

  const pos = cell(row, m, 'pos');
  if (pos && !/^\d{2}$/.test(pos)) blockers.push(`Held — place of service "${pos}" is not a 2-digit code`);

  return {
    kind: 'claim',
    blockers: [...new Set(blockers)],
    warnings,
    checks,
    patient: { last: name.last, first: name.first, dob, dob_mdy: toMDY(dob) },
    dos, dos_mdy: toMDY(dos),
    facility,
    pos: pos || null,
    prior_auth: cell(row, m, 'prior_auth') || null,
    referring: cell(row, m, 'referring') || null,
    diagnoses: dx,
    lines,
    providers: {
      rendering: { name: task.provider_name, npi: task.provider_npi },
      billing: { npi: task.billing_npi || task.provider_npi, tax_id: task.billing_tax_id || null },
    },
  };
}

module.exports = {
  parseDate, toMDY, isValidNpi, isMbi, normalizeAddress, addressesMatch, providerMatches, normalizeNdc,
  parseNdcEntry, demoCard, claimCheck, findPayer, rowIdentity, patientName, inDosRange, normalizeText, cell,
};
