'use strict';
// The Google Apps Script the user pastes into script.google.com and deploys as a web app.
// It runs under their own Google account, so it can open any sheet they can open.
// Every request must carry the secret; without it the script answers "unauthorized".

const SCRIPT_VERSION = 2;

function appsScriptSource(secret) {
  return `// Billing Control connector v${SCRIPT_VERSION}. Paste this whole file into a new project at script.google.com.
// Keep this script private: the secret below works like a password.
const SECRET = '${secret}';

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req || req.secret !== SECRET) return out_({ error: 'unauthorized' });
    if (req.action === 'ping') return out_({ ok: true, version: ${SCRIPT_VERSION}, account: Session.getEffectiveUser().getEmail() });
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
    if (req.action === 'record') {
      // Check the row still holds what Billing Control read, then write: one round trip, under a lock.
      const lock = LockService.getDocumentLock() || LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        const width = Math.max(sh.getLastColumn(), 1, ...req.writes.map(function (w) { return Number(w.col) + 1; }));
        const range = sh.getRange(Number(req.row), 1, 1, width);
        const cells = range.getDisplayValues()[0];
        for (const e of req.expect) { if (String(cells[e.col] == null ? '' : cells[e.col]) !== e.value) return out_({ mismatch: true }); }
        req.writes.forEach(function (w) {
          let v = String(w.value);
          if (w.mode === 'append') {
            const cur = String(cells[w.col] || '').trim();
            v = !cur ? v : (cur.split(/\\s*\\|\\s*/).indexOf(v) >= 0 ? cur : cur + ' | ' + v);
          }
          sh.getRange(Number(req.row), Number(w.col) + 1).setValue(v);
          cells[w.col] = v;
        });
        SpreadsheetApp.flush();
        return out_({ ok: true, cells: cells });
      } finally { lock.releaseLock(); }
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

module.exports = { appsScriptSource, SCRIPT_VERSION };
