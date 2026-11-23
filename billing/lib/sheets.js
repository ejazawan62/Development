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
const mergeNote = (existing, note) => {
  const e = String(existing || '').trim();
  if (!note) return e;
  if (!e) return note;
  return e.split(/\s*\|\s*/).includes(note) ? e : `${e} | ${note}`;
};

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
    /** Checks the expected cells, then writes; one step. Returns { cells } or { mismatch: true }. */
    async recordRow(id, tab, { row, expect, writes }) {
      const d = load();
      const rows = getTab(d, id, tab);
      const r = rows[row - 1] || [];
      const val = (c) => (r[c] == null ? '' : String(r[c]));
      if (expect.some((e) => val(e.col) !== e.value)) return { mismatch: true };
      while (rows.length < row) rows.push([]);
      const target = rows[row - 1];
      for (const w of writes) {
        while (target.length <= w.col) target.push('');
        target[w.col] = w.mode === 'append' ? mergeNote(target[w.col], w.value) : w.value;
      }
      save(d);
      return { cells: target.map((v) => (v == null ? '' : String(v))) };
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

// ---------- Apps Script adapter (no Google Cloud console needed) ----------
// The user deploys lib/apps-script.js's script as a web app under their own Google account.
const APPS_SCRIPT_URL = /^https:\/\/script\.google\.com\/(a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

function appsScriptAdapter(url, secret, { allowAnyUrl = false } = {}) {
  if (!allowAnyUrl && !APPS_SCRIPT_URL.test(url)) throw new Error('Not a Google Apps Script web app URL (it should end in /exec)');
  async function call(action, payload) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ secret, action, ...payload }),
        redirect: 'follow',
      });
    } catch (e) {
      throw Object.assign(new Error(`Can't reach the Google script: ${e.message}`), { status: 502 });
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      throw Object.assign(new Error('The Google script did not answer with data. Check it is deployed as a web app with access "Anyone", then redeploy.'), { status: 502 });
    }
    if (data.error) throw Object.assign(new Error(`Google Sheets: ${data.error}`), { status: data.error === 'unauthorized' ? 502 : 422 });
    return data;
  }
  const rangeRows = (a1) => {
    const m = String(a1).match(/^[A-Z]+(\d+):[A-Z]+(\d+)$/);
    if (!m) throw new Error(`Unsupported range ${a1}`);
    return { row: Number(m[1]), numRows: Number(m[2]) - Number(m[1]) + 1 };
  };
  return {
    mode: 'appsscript',
    ping: () => call('ping', {}),
    async listTabs(spreadsheetId) { return (await call('listTabs', { spreadsheetId })).tabs; },
    async readRange(spreadsheetId, tab, a1) {
      const values = (await call('read', { spreadsheetId, tab, ...rangeRows(a1) })).values || [];
      return values.map((r) => {
        const row = r.map((v) => (v == null ? '' : String(v)));
        while (row.length && row[row.length - 1] === '') row.pop();
        return row;
      });
    },
    async writeCells(spreadsheetId, tab, cells) {
      await call('write', { spreadsheetId, tab, cells: cells.map((c) => ({ row: c.row, col: c.col, value: String(c.value) })) });
    },
    /** One round trip (script version 2+). Returns null when the deployed script is older. */
    async recordRow(spreadsheetId, tab, { row, expect, writes }) {
      try {
        const r = await call('record', { spreadsheetId, tab, row, expect, writes: writes.map((w) => ({ ...w, value: String(w.value) })) });
        return r.mismatch ? { mismatch: true } : { cells: (r.cells || []).map((v) => (v == null ? '' : String(v))) };
      } catch (e) {
        if (/unknown action/.test(e.message)) return null;
        throw e;
      }
    },
  };
}

/**
 * Picks the sheets connection on every call, so connecting Google in the app takes effect without a restart.
 * Order: service account (env) → Apps Script (saved in settings) → local test sheets.
 */
function createSheets(env = process.env, dataDir, getSettings = () => ({}), adapterOptions = {}) {
  if (env.GOOGLE_SERVICE_ACCOUNT_FILE) return googleAdapter(env.GOOGLE_SERVICE_ACCOUNT_FILE);
  const local = localAdapter(env.LOCAL_SHEETS_FILE || `${dataDir}/local-sheets.json`);
  let cached = { key: null, adapter: null };
  const current = () => {
    const s = getSettings();
    if (!s.apps_script_url || !s.apps_script_secret) return local;
    const key = `${s.apps_script_url}|${s.apps_script_secret}`;
    if (cached.key !== key) cached = { key, adapter: appsScriptAdapter(s.apps_script_url, s.apps_script_secret, adapterOptions) };
    return cached.adapter;
  };
  return {
    get mode() { return current().mode; },
    get recordRow() { const a = current(); return a.recordRow ? (...x) => a.recordRow(...x) : null; },
    listTabs: (...a) => current().listTabs(...a),
    readRange: (...a) => current().readRange(...a),
    writeCells: (...a) => current().writeCells(...a),
  };
}

module.exports = { createSheets, localAdapter, appsScriptAdapter, APPS_SCRIPT_URL, colToLetter, letterToCol, spreadsheetIdFromLink };
