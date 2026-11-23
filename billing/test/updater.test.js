'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Runs the updater against two throwaway Git repos: "origin" gets a new commit, the "install" fast-forwards.
test('updater fetches, fast-forwards and asks for a restart; refuses when files were edited', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-upd-'));
  const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
  const origin = path.join(dir, 'origin');
  fs.mkdirSync(path.join(origin, 'billing', 'lib'), { recursive: true });
  sh(origin, 'init', '-q', '-b', 'main');
  sh(origin, 'config', 'user.email', 't@example.com'); sh(origin, 'config', 'user.name', 't');
  fs.copyFileSync(path.join(__dirname, '..', 'lib', 'updater.js'), path.join(origin, 'billing', 'lib', 'updater.js'));
  fs.writeFileSync(path.join(origin, 'billing', 'a.txt'), '1');
  sh(origin, 'add', '-A'); sh(origin, 'commit', '-qm', 'one');
  const install = path.join(dir, 'install');
  sh(dir, 'clone', '-q', origin, install);
  fs.writeFileSync(path.join(origin, 'billing', 'a.txt'), '2');
  sh(origin, 'commit', '-qam', 'two');

  const { createUpdater } = require(path.join(install, 'billing', 'lib', 'updater.js'));
  let exited = null;
  const u = createUpdater({ getEnabled: () => true, exit: (c) => { exited = c; }, supervised: true });
  const s = await u.check();
  assert.equal(s.last_error, null);
  assert.match(s.last_result, /^Updated to /);
  assert.equal(fs.readFileSync(path.join(install, 'billing', 'a.txt'), 'utf8'), '2');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(exited, 75, 'asks start.js to restart');

  // A hand-edited file blocks the next update instead of being overwritten.
  fs.writeFileSync(path.join(origin, 'billing', 'a.txt'), '3');
  sh(origin, 'commit', '-qam', 'three');
  fs.writeFileSync(path.join(install, 'billing', 'a.txt'), 'edited by hand');
  const u2 = createUpdater({ getEnabled: () => true, exit: () => {}, supervised: true });
  const s2 = await u2.check();
  assert.match(s2.last_error, /changed by hand/);
  assert.equal(fs.readFileSync(path.join(install, 'billing', 'a.txt'), 'utf8'), 'edited by hand');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the app reports a version for the browser to watch', async () => {
  const { createApp } = require('../server');
  const { open } = require('../lib/db');
  const { localAdapter } = require('../lib/sheets');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-ver-'));
  const app = createApp({ db: open(path.join(d, 'b.db')), sheets: localAdapter(path.join(d, 's.json')) });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const v = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/version`)).json();
  assert.match(v.version, /^[0-9a-f]{12}$/);
  srv.close(); fs.rmSync(d, { recursive: true, force: true });
});
