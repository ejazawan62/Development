'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/checks');
const rules = require('../lib/rules');
const { guessMapping, resolveColumn } = require('../lib/mapping');

test('NPI check digit', () => {
  assert.equal(c.isValidNpi('1234567893'), true);
  assert.equal(c.isValidNpi('1234567890'), false);
  assert.equal(c.isValidNpi('12345'), false);
});

test('MBI format', () => {
  assert.equal(c.isMbi('1EG4-TE5-MK73'), true);
  assert.equal(c.isMbi('123-45-6789A'), false);
  assert.equal(c.isMbi('1SG4TE5MK73'), false); // S is never used
});

test('NDC conversion to 11 digits', () => {
  assert.equal(c.normalizeNdc('0641-0367-21').ndc11, '00641036721');
  assert.equal(c.normalizeNdc('00641-367-21').ndc11, '00641036721');
  assert.equal(c.normalizeNdc('00641-0367-1').ndc11, '00641036701');
  assert.equal(c.normalizeNdc('00641036721').ndc11, '00641036721');
  assert.ok(c.normalizeNdc('6410367210').error);
  assert.equal(c.parseNdcEntry('N400641036721 ML1').entry, 'N400641036721 ML1');
  assert.equal(c.parseNdcEntry('0641-0367-21', 'un', '2').entry, 'N400641036721 UN2');
  assert.ok(c.parseNdcEntry('00641-0367-21').error, 'unit and qty are required');
});

test('dates', () => {
  assert.equal(c.parseDate('11/4/2026'), '2026-11-04');
  assert.equal(c.parseDate('2026-11-04'), '2026-11-04');
  assert.equal(c.parseDate('02/30/2026'), null);
  assert.equal(c.parseDate('4/12/58', { past: true }), '1958-04-12');
});

test('facility address match is strict but ignores spelling style', () => {
  const setup = '120 Main St Ste 4, Albany, NY 12207-1104';
  assert.equal(c.addressesMatch('120 Main Street, Suite #4, Albany, New York 12207', setup).match, true);
  assert.equal(c.addressesMatch('210 Main St Ste 4, Albany, NY 12207', setup).match, false);
  assert.equal(c.addressesMatch('120 Main St Ste 5, Albany, NY 12207', setup).match, false);
  assert.equal(c.addressesMatch('120 Main St Ste 4, Albany, NY 12208', setup).match, false);
  const noZip = c.addressesMatch('120 Main St Ste 4, Albany, NY', setup);
  assert.equal(noZip.match, true);
  assert.ok(noZip.warning);
});

test('provider match', () => {
  assert.equal(c.providerMatches('Dr. Sana Malik', 'Sana Malik, MD', '1234567893'), true);
  assert.equal(c.providerMatches('Malik, Sana MD', 'Sana Malik, MD', '1234567893'), true);
  assert.equal(c.providerMatches('Dr. Malik', 'Sana Malik, MD', '1234567893'), false);
  assert.equal(c.providerMatches('1234567893', 'Sana Malik, MD', '1234567893'), true);
  assert.equal(c.providerMatches('1245319599', 'Sana Malik, MD', '1234567893'), false);
});

test('notes wording and repeated-issue key', () => {
  assert.equal(rules.standardizeNote('held - NDC missing'), 'Held — NDC missing');
  assert.equal(rules.issueKey('Held — NDC missing (J3301)'), rules.issueKey('held: NDC missing (J9999)'));
  assert.equal(rules.mergeNotes('Called pt', 'Held — x'), 'Called pt | Held — x');
  assert.equal(rules.mergeNotes('Held — x', 'Held — x'), 'Held — x');
});

test('header mapping and column resolution', () => {
  const header = ['Patient', 'DOB', 'DOS', 'Office', 'Facility Address', 'Provider', 'CPT', 'ICD-10', 'NDC', 'Status', 'Notes', 'Insurance'];
  const m = guessMapping(header, new Set([9, 10, 11]));
  assert.equal(m.patient_name, 0);
  assert.equal(m.facility_address, 4);
  assert.equal(m.icd, 7);
  assert.equal(resolveColumn(header, 'status').idx, 9);
  assert.equal(resolveColumn(header, 'K').idx, 10);
  assert.ok(resolveColumn(header, 'Z').error);
});

test('claim check: units/modifiers line up, J-code needs NDC', () => {
  const task = {
    practice_name: 'P', provider_name: 'Sana Malik, MD', provider_npi: '1234567893',
    facilities: [{ name: 'Clinic', address: '1 A St, Albany, NY 12207' }], extra_drug_codes: '',
    mapping: { patient_name: 0, dob: 1, dos: 2, office_name: 3, facility_address: 4, provider: 5, cpt: 6, units: 7, modifiers: 8, icd: 9, ndc: 10 },
  };
  const row = ['Doe, Jan', '01/01/1950', '11/01/2026', 'Clinic', '1 A Street, Albany, NY 12207', 'Sana Malik', '99213, J1100', '1, 2', '25,', 'I10', ''];
  const r = c.claimCheck(row, task);
  assert.deepEqual(r.lines.map((l) => [l.cpt, l.units, l.modifiers.join(' ')]), [['99213', 1, '25'], ['J1100', 2, '']]);
  assert.ok(r.blockers.includes('Held — NDC missing (J1100)'));
  row[10] = '00641-0367-21 ML 1';
  assert.deepEqual(c.claimCheck(row, task).blockers, []);
  row[7] = '1';
  assert.ok(c.claimCheck(row, task).blockers.includes("Held — CPT/units don't match sheet"));
});
