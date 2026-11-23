'use strict';
// Creates FAKE demo data: a local test sheet, a practice with a payer list, and two tasks in setup.
// Never put real patient data in the local test sheets file.
const path = require('node:path');
const fs = require('node:fs');
const { open, hashPassword } = require('./db');

function npiWithCheck(nine) {
  const base = '80840' + nine;
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    let d = Number(base[base.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return nine + ((10 - (sum % 10)) % 10);
}

const NPI_MALIK = npiWithCheck('199999990');
const NPI_GROUP = npiWithCheck('199999991');
const SHEET_ID = 'DEMO-SHEET-0000000000000000000000';

function demoSheets() {
  const demos = [
    ['Last Name', 'First Name', 'DOB', 'Gender', 'Address', 'Phone', 'Insurance', 'Member ID', 'DOS', 'Status', 'Notes'],
    ['Brooks', 'Nadia', '02/09/1951', 'F', '12 Pine Rd, Albany, NY 12203', '518-555-0101', 'Medicare', '1EG4TE5MK73', '11/03/2026', '', ''],
    ['Ortiz', 'daniel', '1947-10-30', '', '45 Elm Street Apt 2, Albany, New York 12208', '518.555.0142', 'Medicare', '123456789A', '11/04/2026', '', ''],
    ['Grant', 'Elena', '4/12/1958', 'Female', '9 Lake Ave, Troy, NY 12180', '(518) 555-0177', 'Humana Gold', 'H12345678', '11/04/2026', '', ''],
    ['Kim', 'Harold', '06/21/1939', 'M', '300 State St, Albany, NY 12207', '5185550190', 'NY Medicaid', '', '11/05/2026', '', ''],
    ['Patel', 'Ruth', '12/01/1962', 'F', '77 River St, Troy, NY 12180', '518-555-0123', 'Fidelis Essential', 'FE998877', '11/07/2026', '', ''],
    ['Nguyen', 'Carla', '08/15/1955', 'F', '5 Hill Ct, Albany, NY 12205', '518-555-0166', 'Aetna', 'W123456789', '', '', ''],
  ];
  const sub = [
    ['Patient', 'DOB', 'DOS', 'Office', 'Facility Address', 'Provider', 'CPT', 'Units', 'Modifiers', 'Charges', 'ICD-10', 'NDC', 'POS', 'Insurance', 'Status', 'Notes'],
    ['Brooks, Nadia', '02/09/1951', '11/03/2026', 'Riverside Clinic', '120 Main St Ste 4, Albany, NY 12207', 'Sana Malik MD', '99213', '1', '25', '145.00', 'E11.9, I10', '', '11', 'Medicare', '', ''],
    ['Grant, Elena', '04/12/1958', '11/04/2026', 'Riverside Clinic', '210 Main St Ste 4, Albany, NY 12207', 'Sana Malik MD', '99213; J1100; J3301', '1; 2; 4', '25; ; ', '145.00; 18.00; 12.00', 'L03.115, E11.9', '00641-0367-21 ML1', '11', 'Humana Gold Plus', '', ''],
    ['Ortiz, Daniel', '10/30/1947', '11/04/2026', 'Riverside Clinic', '120 Main Street, Suite 4, Albany, New York 12207', 'Dr. Sana Malik', '99214\nJ1100', '1\n1', '25\n', '210.00\n9.00', 'M54.50', '00641-0367-21 ML1', '11', 'Humana Gold Plus', '', ''],
    ['Kim, Harold', '06/21/1939', '11/05/2026', 'Riverside Clinic', '120 Main St Ste 4, Albany, NY 12207', 'Dr. Lee', '99213', '1', '', '145.00', 'I10', '', '11', 'NY Medicaid', '', ''],
    ['Patel, Ruth', '12/01/1962', '11/07/2026', 'Riverside Nursing Center', '88 Oak Ave, Troy, NY 12180', 'Sana Malik, MD', '99309', '1', '', '160.00', 'J44.9', '', '31', 'Fidelis Care', '', ''],
  ];
  return { [SHEET_ID]: { title: 'DEMO Riverside Nov (fake data)', tabs: { Demos: demos, 'Only Submission': sub } } };
}

function seed(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const sheetsFile = path.join(dataDir, 'local-sheets.json');
  fs.writeFileSync(sheetsFile, JSON.stringify(demoSheets(), null, 2));
  const db = open(path.join(dataDir, 'billing.db'));
  let admin = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  let createdPassword = null;
  if (!admin) {
    createdPassword = 'demo-admin-pass';
    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)').run('Demo Admin', 'admin@example.com', hashPassword(createdPassword), 'admin');
    admin = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  }
  db.prepare('INSERT OR IGNORE INTO practices (name) VALUES (?)').run('Riverside Family Medicine (DEMO)');
  const practice = db.prepare('SELECT id FROM practices WHERE name = ?').get('Riverside Family Medicine (DEMO)');
  if (!db.prepare('SELECT COUNT(*) AS n FROM payers WHERE practice_id = ?').get(practice.id).n) {
    const add = db.prepare('INSERT INTO payers (practice_id, aliases, oa_payer_name, payer_id, plan_type, portal, sheet_name, updated_by) VALUES (?,?,?,?,?,?,?,?)');
    // Example payer IDs only: confirm every one against your Office Ally payer list.
    add.run(practice.id, JSON.stringify(['MCR', 'Medicare Part B']), 'MEDICARE (EXAMPLE)', 'EX-00001', 'medicare', 'NGS', 'Medicare', admin.id);
    add.run(practice.id, JSON.stringify(['Humana Gold']), 'HUMANA (EXAMPLE)', 'EX-00002', 'advantage', 'Availity', 'Humana Gold Plus', admin.id);
    add.run(practice.id, JSON.stringify(['Medicaid']), 'NY MEDICAID (EXAMPLE)', 'EX-00003', 'medicaid', 'ePACES', 'NY Medicaid', admin.id);
    add.run(practice.id, JSON.stringify(['Fidelis']), 'FIDELIS CARE (EXAMPLE)', 'EX-00004', 'medicaid_mco', 'Fidelis portal', 'Fidelis Care', admin.id);
    add.run(practice.id, JSON.stringify([]), 'AETNA (EXAMPLE)', 'EX-00005', 'commercial', 'Availity', 'Aetna', admin.id);
  }
  const base = {
    practice_id: practice.id, practice_name: 'Riverside Family Medicine (DEMO)', provider_name: 'Sana Malik, MD', provider_npi: NPI_MALIK,
    billing_npi: NPI_GROUP, billing_tax_id: '00-0000000', oa_account: 'Riverside FM DEMO account',
    sheet_link: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, spreadsheet_id: SHEET_ID,
    facilities: JSON.stringify([{ name: 'Riverside Clinic', address: '120 Main St Ste 4, Albany, NY 12207-1104' }, { name: 'Riverside Nursing Center', address: '88 Oak Ave, Troy, NY 12180' }]),
    portals: JSON.stringify(['Office Ally', 'Medicare (NGS)', 'Availity', 'ePACES']),
  };
  const ins = db.prepare(`INSERT INTO tasks (task_type, practice_id, practice_name, provider_name, provider_npi, billing_npi, billing_tax_id, oa_account,
    sheet_link, spreadsheet_id, facilities, portals, tab_name, status_col, insurance_col, notes_col, row_from, row_to, special_instructions, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('demo', base.practice_id, base.practice_name, base.provider_name, base.provider_npi, base.billing_npi, base.billing_tax_id, base.oa_account,
    base.sheet_link, base.spreadsheet_id, base.facilities, base.portals, 'Demos', 'Status', 'Insurance', 'Notes', 2, 7, 'DEMO task with fake patients', admin.id);
  ins.run('submission', base.practice_id, base.practice_name, base.provider_name, base.provider_npi, base.billing_npi, base.billing_tax_id, base.oa_account,
    base.sheet_link, base.spreadsheet_id, base.facilities, base.portals, 'Only Submission', 'Status', 'Insurance', 'Notes', 2, 6, 'J-codes need NDC. Accept assignment = Yes.', admin.id);
  db.close();
  return { sheetsFile, createdPassword };
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    console.error('Refusing to seed demo data while GOOGLE_SERVICE_ACCOUNT_FILE is set (this server uses real sheets).');
    process.exit(1);
  }
  const r = seed(dataDir);
  console.log(`Demo data created (fake patients only). Local test sheet: ${r.sheetsFile}`);
  if (r.createdPassword) console.log(`Sign in as admin@example.com / ${r.createdPassword}`);
  console.log('Open the two DEMO tasks, run the header check and confirm them to try the flow.');
}

module.exports = { seed, demoSheets, SHEET_ID, NPI_MALIK };
