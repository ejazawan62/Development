'use strict';
// Builds an ASC X12 005010X222A1 (837 Professional) interchange from a set of claims.
// One ISA/GS/ST envelope per batch; one billing-provider HL per provider; one subscriber
// HL (plus a patient HL when the patient is not the subscriber) per claim.

const REL_CODE = { spouse: '01', child: '19', other: 'G8' };

/** Strips X12 delimiters and non-printables, uppercases. */
function clean(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[*~:^\r\n]/g, ' ').replace(/[^\x20-\x7E]/g, '').trim();
}
function pad(v, len) { return clean(v).slice(0, len).padEnd(len, ' '); }
function d8(iso) { return String(iso).replace(/-/g, ''); }
function money(cents) { return (cents / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'); }
function digits(v) { return String(v || '').replace(/\D/g, ''); }

function segment(...elements) {
  // Trailing empty elements must be dropped in X12.
  const els = elements.map((e) => (e == null ? '' : String(e)));
  while (els.length > 1 && els[els.length - 1] === '') els.pop();
  return els.join('*') + '~';
}

/**
 * @param {object} p
 * @param {object} p.settings practice/submitter settings
 * @param {number} p.controlNo interchange control number
 * @param {string} p.batchNo
 * @param {Date}   p.now
 * @param {Array}  p.claims each { claim, lines, patient, payer, provider }
 */
function build837P({ settings, controlNo, batchNo, now = new Date(), claims }) {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hm = now.toISOString().slice(11, 16).replace(':', '');
  const ctrl = String(controlNo).padStart(9, '0');
  const out = [];
  const body = [];
  const s = (...e) => body.push(segment(...e));

  out.push(segment('ISA', '00', pad('', 10), '00', pad('', 10), 'ZZ', pad(settings.submitter_id, 15),
    'ZZ', pad(settings.receiver_id, 15), ymd.slice(2), hm, '^', '00501', ctrl, '0',
    settings.usage_indicator === 'P' ? 'P' : 'T', ':'));
  out.push(segment('GS', 'HC', clean(settings.submitter_id), clean(settings.receiver_id), ymd, hm, String(controlNo), 'X', '005010X222A1'));

  s('ST', '837', '0001', '005010X222A1');
  s('BHT', '0019', '00', clean(batchNo), ymd, hm, 'CH');
  s('NM1', '41', '2', clean(settings.practice_name), '', '', '', '', '46', clean(settings.submitter_id));
  s('PER', 'IC', clean(settings.submitter_contact), 'TE', digits(settings.submitter_phone));
  s('NM1', '40', '2', clean(settings.receiver_name), '', '', '', '', '46', clean(settings.receiver_id));

  // Group claims by billing provider.
  const byProvider = new Map();
  for (const c of claims) {
    if (!byProvider.has(c.provider.id)) byProvider.set(c.provider.id, []);
    byProvider.get(c.provider.id).push(c);
  }

  let hl = 0;
  for (const group of byProvider.values()) {
    const prov = group[0].provider;
    const provHl = ++hl;
    s('HL', provHl, '', '20', '1');
    if (prov.taxonomy) s('PRV', 'BI', 'PXC', clean(prov.taxonomy));
    s('NM1', '85', '2', clean(prov.name), '', '', '', '', 'XX', digits(prov.npi));
    s('N3', clean(prov.address1));
    s('N4', clean(prov.city), clean(prov.state), digits(prov.zip));
    s('REF', 'EI', digits(prov.tax_id));

    for (const { claim, lines, patient, payer } of group) {
      const secondary = claim.payer_rank === 'secondary';
      const memberId = secondary ? patient.secondary_member_id : patient.member_id;
      const isSelf = secondary || patient.subscriber_rel === 'self';
      const subHl = ++hl;
      s('HL', subHl, provHl, '22', isSelf ? '0' : '1');
      s('SBR', secondary ? 'S' : 'P', isSelf ? '18' : '', secondary ? '' : clean(patient.group_no), '', '', '', '', '', clean(payer.filing_code || 'CI'));
      if (isSelf) {
        s('NM1', 'IL', '1', clean(patient.last_name), clean(patient.first_name), clean(patient.middle_initial), '', '', 'MI', clean(memberId));
        s('N3', clean(patient.address1), clean(patient.address2));
        s('N4', clean(patient.city), clean(patient.state), digits(patient.zip));
        s('DMG', 'D8', d8(patient.dob), clean(patient.sex));
      } else {
        s('NM1', 'IL', '1', clean(patient.subscriber_last), clean(patient.subscriber_first), '', '', '', 'MI', clean(memberId));
        s('N3', clean(patient.address1), clean(patient.address2));
        s('N4', clean(patient.city), clean(patient.state), digits(patient.zip));
        s('DMG', 'D8', d8(patient.subscriber_dob), clean(patient.subscriber_sex || 'U'));
      }
      s('NM1', 'PR', '2', clean(payer.name), '', '', '', '', 'PI', clean(payer.payer_id));

      if (!isSelf) {
        s('HL', ++hl, subHl, '23', '0');
        s('PAT', REL_CODE[patient.subscriber_rel] || 'G8');
        s('NM1', 'QC', '1', clean(patient.last_name), clean(patient.first_name), clean(patient.middle_initial));
        s('N3', clean(patient.address1), clean(patient.address2));
        s('N4', clean(patient.city), clean(patient.state), digits(patient.zip));
        s('DMG', 'D8', d8(patient.dob), clean(patient.sex));
      }

      s('CLM', clean(claim.claim_no), money(claim.total_cents), '', '', `${clean(claim.pos)}:B:1`, 'Y', 'A', 'Y', 'Y');
      if (claim.prior_auth) s('REF', 'G1', clean(claim.prior_auth));
      s('HI', ...claim.diagnoses.map((code, i) => `${i === 0 ? 'ABK' : 'ABF'}:${clean(code).replace('.', '')}`));

      lines.forEach((l, i) => {
        const mods = String(l.modifiers || '').split(/[\s,]+/).filter(Boolean).map(clean);
        const ptrs = String(l.dx_pointers || '').split(/[\s,]+/).filter(Boolean).join(':');
        s('LX', i + 1);
        s('SV1', ['HC', clean(l.cpt), ...mods].join(':'), money(l.charge_cents), 'UN', String(Number(l.units)), '', '', ptrs);
        if (l.dos_to && l.dos_to !== l.dos_from) s('DTP', '472', 'RD8', `${d8(l.dos_from)}-${d8(l.dos_to)}`);
        else s('DTP', '472', 'D8', d8(l.dos_from));
      });
    }
  }

  body.push(segment('SE', body.length + 1, '0001'));
  out.push(...body);
  out.push(segment('GE', '1', String(controlNo)));
  out.push(segment('IEA', '1', ctrl));
  return out.join('\n') + '\n';
}

module.exports = { build837P, clean };
