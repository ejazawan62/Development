'use strict';
// Guesses which sheet column holds which field from the header row. The user confirms the result.
const { letterToCol, colToLetter } = require('./sheets');

const FIELDS = [
  { key: 'last_name', label: 'Last name', syn: ['last name', 'last', 'patient last name', 'lname', 'surname', 'pt last name'] },
  { key: 'first_name', label: 'First name', syn: ['first name', 'first', 'patient first name', 'fname', 'pt first name'] },
  { key: 'patient_name', label: 'Patient name (Last, First)', syn: ['patient name', 'patient', 'name', 'pt name', 'patient full name'] },
  { key: 'dob', label: 'DOB', syn: ['dob', 'date of birth', 'birth date', 'birthdate', 'd o b'] },
  { key: 'gender', label: 'Gender', syn: ['gender', 'sex'] },
  { key: 'address', label: 'Patient address', syn: ['address', 'patient address', 'street', 'address 1', 'address1', 'street address'] },
  { key: 'city', label: 'City', syn: ['city'] },
  { key: 'state', label: 'State', syn: ['state', 'st'] },
  { key: 'zip', label: 'ZIP', syn: ['zip', 'zip code', 'zipcode', 'postal code'] },
  { key: 'phone', label: 'Phone', syn: ['phone', 'phone number', 'phone no', 'contact', 'cell', 'mobile', 'telephone'] },
  { key: 'member_id', label: 'Member ID / MBI / Medicaid ID', syn: ['member id', 'member', 'member no', 'policy', 'policy number', 'policy no', 'insurance id', 'subscriber id', 'id', 'mbi', 'medicare id', 'medicare number', 'medicaid id', 'ins id'] },
  { key: 'dos', label: 'Date of service', syn: ['dos', 'date of service', 'service date', 'visit date', 'dos date'] },
  { key: 'practice', label: 'Practice', syn: ['practice', 'practice name', 'group', 'group name'] },
  { key: 'office_name', label: 'Office / facility name', syn: ['office', 'office name', 'facility', 'facility name', 'location', 'location name', 'clinic'] },
  { key: 'facility_address', label: 'Facility address', syn: ['facility address', 'office address', 'location address', 'service address', 'service facility address', 'facility addr'] },
  { key: 'provider', label: 'Provider', syn: ['provider', 'rendering provider', 'provider name', 'doctor', 'physician', 'rendering'] },
  { key: 'referring', label: 'Referring provider', syn: ['referring', 'referring provider', 'referring physician'] },
  { key: 'cpt', label: 'CPT/HCPCS', syn: ['cpt', 'cpt code', 'cpt codes', 'cpts', 'procedure', 'procedure code', 'procedure codes', 'hcpcs', 'codes', 'cpt hcpcs'] },
  { key: 'units', label: 'Units', syn: ['units', 'unit', 'qty', 'quantity'] },
  { key: 'modifiers', label: 'Modifiers', syn: ['modifier', 'modifiers', 'mod', 'mods'] },
  { key: 'charges', label: 'Charges', syn: ['charge', 'charges', 'amount', 'fee', 'fees', 'billed amount'] },
  { key: 'icd', label: 'ICD-10', syn: ['icd', 'icd10', 'icd 10', 'icd codes', 'icd 10 codes', 'dx', 'dx codes', 'diagnosis', 'diagnosis codes', 'diagnoses'] },
  { key: 'dx_pointers', label: 'Diagnosis pointers', syn: ['pointer', 'pointers', 'dx pointer', 'dx pointers', 'diagnosis pointer'] },
  { key: 'ndc', label: 'NDC', syn: ['ndc', 'ndc number', 'ndc code', 'ndc no', 'ndcs'] },
  { key: 'ndc_unit', label: 'NDC unit qualifier', syn: ['ndc unit', 'unit qualifier', 'ndc uom', 'ndc unit of measure'] },
  { key: 'ndc_qty', label: 'NDC quantity', syn: ['ndc qty', 'ndc quantity', 'ndc units', 'drug qty', 'drug quantity'] },
  { key: 'pos', label: 'Place of service', syn: ['pos', 'place of service', 'pos code'] },
  { key: 'prior_auth', label: 'Prior authorization', syn: ['prior auth', 'auth', 'authorization', 'auth no', 'auth number', 'pa', 'pa no', 'prior authorization'] },
];

const REQUIRED = {
  demo: [['last_name', 'patient_name'], ['first_name', 'patient_name'], ['dob']],
  claim: [['last_name', 'patient_name'], ['first_name', 'patient_name'], ['dob'], ['dos'], ['provider'], ['facility_address'], ['cpt'], ['icd']],
};
REQUIRED.submission = REQUIRED.claim;

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Resolves a Task Setup column (letter like "K" or a header name like "Status") to an index. */
function resolveColumn(header, spec) {
  const t = String(spec || '').trim();
  if (!t) return { error: 'blank' };
  const byName = header.findIndex((h) => norm(h) === norm(t));
  if (byName >= 0) return { idx: byName, letter: colToLetter(byName), header: header[byName] };
  if (/^[A-Za-z]{1,2}$/.test(t)) {
    const idx = letterToCol(t);
    if (idx < header.length && String(header[idx] || '').trim()) return { idx, letter: t.toUpperCase(), header: header[idx] };
    return { error: `column ${t.toUpperCase()} has no header` };
  }
  return { error: `no column named "${t}" in the header row` };
}

const SHEET_COLUMNS = {
  status: ['status', 'demo status', 'claim status', 'sheet status', 'work status', 'progress'],
  insurance: ['insurance', 'primary insurance', 'insurance name', 'ins', 'primary ins', 'payer', 'primary payer', 'insurance company', 'carrier'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks', 'remark', 'billing notes'],
};
const LABEL = { status: 'Status', insurance: 'Insurance', notes: 'Notes' };

/** Finds the Status / Insurance / Notes column from the header row. */
function detectColumn(header, kind, taken = new Set()) {
  const headers = header.map(norm);
  const syn = SHEET_COLUMNS[kind];
  let idx = headers.findIndex((h, i) => !taken.has(i) && syn.includes(h));
  if (idx < 0) idx = headers.findIndex((h, i) => !taken.has(i) && h && syn.some((s) => s.length > 3 && h.includes(s)) && !(kind === 'status' && /insur/.test(h)));
  if (idx < 0) return { error: `no ${LABEL[kind]} column found: type its letter or header name` };
  return { idx, letter: colToLetter(idx), header: header[idx], detected: true };
}

function guessMapping(header, exclude = new Set()) {
  const used = new Set(exclude);
  const mapping = {};
  const headers = header.map(norm);
  for (const pass of ['exact', 'contains']) {
    for (const f of FIELDS) {
      if (mapping[f.key] != null) continue;
      const idx = headers.findIndex((h, i) => !used.has(i) && h && (pass === 'exact' ? f.syn.includes(h) : f.syn.some((sy) => sy.length > 3 && h.includes(sy))));
      if (idx >= 0) { mapping[f.key] = idx; used.add(idx); }
    }
  }
  // "Patient name" only if separate first/last weren't found.
  if (mapping.last_name != null && mapping.first_name != null) delete mapping.patient_name;
  return mapping;
}

function missingRequired(taskType, mapping) {
  return (REQUIRED[taskType] || []).filter((alts) => !alts.some((k) => mapping[k] != null && mapping[k] >= 0))
    .map((alts) => alts.map((k) => FIELDS.find((f) => f.key === k).label).join(' or '));
}

module.exports = { FIELDS, guessMapping, resolveColumn, detectColumn, missingRequired };
