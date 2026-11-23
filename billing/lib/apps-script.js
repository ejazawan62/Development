'use strict';
// The Google Apps Script the user pastes into script.google.com and deploys as a web app.
// It runs under their own Google account, so it can open any sheet they can open.
// Every request must carry the secret; without it the script answers "unauthorized".

function appsScriptSource(secret) {
  return `// Billing Control connector. Paste this whole file into a new project at script.google.com.
// Keep this script private: the secret below works like a password.
const SECRET = '${secret}';

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req || req.secret !== SECRET) return out_({ error: 'unauthorized' });
    if (req.action === 'ping') return out_({ ok: true, account: Session.getEffectiveUser().getEmail() });
    const ss = SpreadsheetApp.openById(req.spreadsheetId);
    if (req.action === 'listTabs') return out_({ tabs: ss.getSheets().map(function (s) { return s.getName(); }) });
    const sh = ss.getSheetByName(req.tab);
    if (!sh) return out_({ error: 'Tab "' + req.tab + '" not found' });
    if (req.action === 'read') {
      const lastRow = sh.getLastRow();
      const lastCol = Math.max(sh.getLastColumn(), 1);
      const first = Number(req.row);
      const count = Math.min(Number(req.numRows), Math.max(lastRow - first + 1, 0));
      if (count <= 0) return out_({ values: [] });
      return out_({ values: sh.getRange(first, 1, count, lastCol).getDisplayValues() });
    }
    if (req.action === 'write') {
      req.cells.forEach(function (c) { sh.getRange(Number(c.row), Number(c.col) + 1).setValue(String(c.value)); });
      SpreadsheetApp.flush();
      return out_({ ok: true });
    }
    return out_({ error: 'unknown action' });
  } catch (err) {
    return out_({ error: String(err && err.message || err) });
  }
}

function doGet() {
  return out_({ ok: true, note: 'Billing Control connector is running.' });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

module.exports = { appsScriptSource };
