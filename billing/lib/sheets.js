'use strict';
// Google Sheets access. Two adapters with the same interface:
//  - google: Sheets API v4 with a service account (share the sheet with the service account's email)
//  - local:  a JSON file of fake sheets, for development and demos (never real patient data)
const fs = require('node:fs');
const crypto = require('node:crypto');

function colToLetter(idx) {
  let n = idx + 1;
  let out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}
function letterToCol(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function spreadsheetIdFromLink(link) {
  const m = String(link || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(String(link || '').trim()) ? String(link).trim() : null;
}
const quoteTab = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

// ---------- Google adapter ----------
function googleAdapter(serviceAccountFile) {
  const sa = JSON.parse(fs.readFileSync(serviceAccountFile, 'utf8'));
  let token = null;
  let tokenExp = 0;
  const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

  async function accessToken() {
    if (token && Date.now() < tokenExp - 60000) return token;
    const now = Math.floor(Date.now() / 1000);
    const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64u(JSON.stringify({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    }));
    const sig = b64u(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claim}`), sa.private_key));
    const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${sig}` }),
    });
    if (!res.ok) throw new Error(`Google sign-in failed (${res.status}). Check the service account key.`);
    const j = await res.json();
    token = j.access_token;
    tokenExp = Date.now() + j.expires_in * 1000;
    return token;
  }

  async function api(pathAndQuery, init = {}) {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${pathAndQuery}`, {
      ...init,
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) {
      let msg = `Google Sheets error ${res.status}`;
      try { msg += ': ' + (await res.json()).error.message; } catch { /* ignore */ }
      if (res.status === 403) msg += `. Share the sheet with ${sa.client_email} (Editor).`;
      throw Object.assign(new Error(msg), { status: 502 });
    }
    return res.json();
  }

  return {
    mode: 'google',
    serviceAccountEmail: sa.client_email,
    async listTabs(spreadsheetId) {
      const j = await api(`${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`);
      return j.sheets.map((x) => x.properties.title);
    },
    async readRange(spreadsheetId, tab, a1) {
      const range = encodeURIComponent(`${quoteTab(tab)}!${a1}`);
      const j = await api(`${encodeURIComponent(spreadsheetId)}/values/${range}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
      return j.values || [];
    },
    async writeCells(spreadsheetId, tab, cells) {
      await api(`${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: cells.map((c) => ({ range: `${quoteTab(tab)}!${colToLetter(c.col)}${c.row}`, values: [[c.value]] })),
        }),
      });
    },
  };
}

// ---------- Local adapter (fake data only) ----------
function localAdapter(file) {
  const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  const save = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  const getTab = (d, id, tab) => {
    const book = d[id];
    if (!book) throw Object.assign(new Error('Sheet not found in local test sheets'), { status: 404 });
    if (!book.tabs[tab]) throw Object.assign(new Error(`Tab "${tab}" not found`), { status: 404 });
    return book.tabs[tab];
  };
  return {
    mode: 'local',
    async listTabs(id) { const d = load(); if (!d[id]) throw Object.assign(new Error('Sheet not found in local test sheets'), { status: 404 }); return Object.keys(d[id].tabs); },
    async readRange(id, tab, a1) {
      const rows = getTab(load(), id, tab);
      const m = a1.match(/^[A-Z]+(\d+):[A-Z]+(\d+)$/);
      const from = m ? Number(m[1]) : 1;
      const to = m ? Number(m[2]) : rows.length;
      return rows.slice(from - 1, to).map((r) => r.map((v) => (v == null ? '' : String(v))));
    },
    async writeCells(id, tab, cells) {
      const d = load();
      const rows = getTab(d, id, tab);
      for (const c of cells) {
        while (rows.length < c.row) rows.push([]);
        const r = rows[c.row - 1];
        while (r.length <= c.col) r.push('');
        r[c.col] = c.value;
      }
      save(d);
    },
  };
}

function createSheets(env = process.env, dataDir) {
  if (env.GOOGLE_SERVICE_ACCOUNT_FILE) return googleAdapter(env.GOOGLE_SERVICE_ACCOUNT_FILE);
  return localAdapter(env.LOCAL_SHEETS_FILE || `${dataDir}/local-sheets.json`);
}

module.exports = { createSheets, localAdapter, colToLetter, letterToCol, spreadsheetIdFromLink };
