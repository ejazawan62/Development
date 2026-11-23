'use strict';
// Claim scrubber: catches the errors that most often get a professional (837P / CMS-1500) claim
// rejected by a clearinghouse or payer, before it is submitted.

const ICD10 = /^[A-TV-Z][0-9][0-9A-Z](\.?[0-9A-Z]{1,4})?$/;
const PROC = /^(\d{4}[0-9A-Z]|[A-V]\d{4})$/; // CPT (incl. Cat II/III) or HCPCS Level II
const MODIFIER = /^[0-9A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ZIP = /^\d{5}(\d{4})?$/;
const STATE = /^[A-Z]{2}$/;
const POS = /^\d{2}$/;
const TIMELY_FILING_DAYS = 365;

function isDate(s) {
  if (!DATE.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** NPI check digit: Luhn over the "80840" prefix plus the first 9 digits. */
function isValidNpi(npi) {
  if (!/^\d{10}$/.test(npi || '')) return false;
  const base = '80840' + npi.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    let d = Number(base[base.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

function normalizeZip(z) { return String(z || '').replace(/\D/g, ''); }
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

/** Validates patient demographics. Returns { errors, warnings } as arrays of strings. */
function validatePatient(p) {
  const errors = [];
  const warnings = [];
  if (!p.first_name) errors.push('Patient first name is required');
  if (!p.last_name) errors.push('Patient last name is required');
  if (!isDate(p.dob)) errors.push('Patient date of birth is missing or invalid');
  else if (p.dob > new Date().toISOString().slice(0, 10)) errors.push('Patient date of birth is in the future');
  if (!['M', 'F', 'U'].includes(p.sex)) errors.push('Patient sex must be M, F or U');
  if (!p.address1) errors.push('Patient street address is required');
  if (!p.city) errors.push('Patient city is required');
  if (!STATE.test(p.state || '')) errors.push('Patient state must be a 2-letter code');
  if (!ZIP.test(normalizeZip(p.zip))) errors.push('Patient ZIP must be 5 or 9 digits');
  if (!p.primary_payer_id) errors.push('Primary insurance (payer) is required');
  if (!p.member_id) errors.push('Primary insurance member ID is required');
  if (p.subscriber_rel && p.subscriber_rel !== 'self') {
    if (!p.subscriber_first || !p.subscriber_last) errors.push('Subscriber name is required when the patient is not the subscriber');
    if (!isDate(p.subscriber_dob)) errors.push('Subscriber date of birth is required when the patient is not the subscriber');
  }
  if (p.secondary_payer_id && !p.secondary_member_id) warnings.push('Secondary insurance has no member ID');
  if (!p.phone) warnings.push('Patient phone number is missing');
  return { errors, warnings };
}

/**
 * Scrubs a claim. `ctx` = { claim, lines, patient, payer, provider, today? }.
 * Returns { errors, warnings }; a claim with errors cannot be marked ready.
 */
function validateClaim(ctx) {
  const { claim, lines = [], patient, payer, provider } = ctx;
  const today = ctx.today || new Date().toISOString().slice(0, 10);
  const errors = [];
  const warnings = [];

  if (!patient) errors.push('Claim has no patient');
  else {
    const pv = validatePatient(patient);
    errors.push(...pv.errors.map((e) => 'Demographics: ' + e));
    warnings.push(...pv.warnings.map((w) => 'Demographics: ' + w));
    if (claim.payer_rank === 'secondary' && !patient.secondary_member_id) errors.push('Secondary claim but the patient has no secondary member ID');
  }

  if (!payer) errors.push('Payer is required');
  else if (!payer.payer_id) errors.push('Payer has no electronic payer ID');

  if (!provider) errors.push('Billing provider is required');
  else {
    if (!isValidNpi(provider.npi)) errors.push(`Billing provider NPI "${provider.npi || ''}" is invalid`);
    if (!/^\d{9}$/.test(String(provider.tax_id || '').replace(/-/g, ''))) errors.push('Billing provider Tax ID (EIN) must be 9 digits');
    if (!provider.address1 || !provider.city || !STATE.test(provider.state || '') || !ZIP.test(normalizeZip(provider.zip))) {
      errors.push('Billing provider address is incomplete');
    } else if (normalizeZip(provider.zip).length !== 9) {
      warnings.push('Billing provider ZIP should be ZIP+4 (9 digits) for 837P');
    }
  }

  if (!POS.test(claim.pos || '')) errors.push('Place of service must be a 2-digit code');

  const dx = Array.isArray(claim.diagnoses) ? claim.diagnoses : [];
  if (dx.length === 0) errors.push('At least one ICD-10 diagnosis code is required');
  if (dx.length > 12) errors.push('No more than 12 diagnosis codes are allowed');
  const seen = new Set();
  dx.forEach((code, i) => {
    if (!ICD10.test(code)) errors.push(`Diagnosis ${i + 1} "${code}" is not a valid ICD-10-CM code format`);
    if (seen.has(code)) errors.push(`Diagnosis "${code}" is listed more than once`);
    seen.add(code);
  });

  if (lines.length === 0) errors.push('At least one service line is required');
  if (lines.length > 50) errors.push('An 837P claim allows at most 50 service lines');

  lines.forEach((l, i) => {
    const n = `Line ${i + 1}`;
    if (!PROC.test(l.cpt || '')) errors.push(`${n}: "${l.cpt || ''}" is not a valid CPT/HCPCS code`);
    const mods = String(l.modifiers || '').split(/[\s,]+/).filter(Boolean);
    if (mods.length > 4) errors.push(`${n}: at most 4 modifiers`);
    mods.forEach((m) => { if (!MODIFIER.test(m)) errors.push(`${n}: modifier "${m}" must be 2 letters/digits`); });
    if (!(Number(l.units) > 0)) errors.push(`${n}: units must be greater than 0`);
    if (!(Number(l.charge_cents) > 0)) errors.push(`${n}: charge must be greater than 0`);
    if (!isDate(l.dos_from)) errors.push(`${n}: date of service is missing or invalid`);
    else {
      if (l.dos_from > today) errors.push(`${n}: date of service is in the future`);
      if (patient && isDate(patient.dob) && l.dos_from < patient.dob) errors.push(`${n}: date of service is before the patient's birth`);
      if (daysBetween(l.dos_from, today) > TIMELY_FILING_DAYS) warnings.push(`${n}: date of service is over ${TIMELY_FILING_DAYS} days old; check the payer's timely filing limit`);
    }
    if (l.dos_to && !isDate(l.dos_to)) errors.push(`${n}: "to" date is invalid`);
    else if (l.dos_to && l.dos_from && l.dos_to < l.dos_from) errors.push(`${n}: "to" date is before the "from" date`);
    else if (l.dos_to && l.dos_to > today) errors.push(`${n}: "to" date is in the future`);
    const ptrs = String(l.dx_pointers || '').split(/[\s,]+/).filter(Boolean);
    if (ptrs.length === 0) errors.push(`${n}: needs at least one diagnosis pointer`);
    if (ptrs.length > 4) errors.push(`${n}: at most 4 diagnosis pointers`);
    ptrs.forEach((p) => {
      const k = Number(p);
      if (!Number.isInteger(k) || k < 1 || k > dx.length) errors.push(`${n}: diagnosis pointer "${p}" does not match a diagnosis on the claim`);
    });
  });

  const keys = lines.map((l) => `${l.dos_from}|${l.cpt}|${l.modifiers}`);
  if (new Set(keys).size !== keys.length) warnings.push('Two or more lines have the same date, code and modifiers; payers may deny them as duplicates');

  return { errors, warnings };
}

module.exports = { validateClaim, validatePatient, isValidNpi, isDate, ICD10, PROC };
