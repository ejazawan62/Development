'use strict';
// Keeps Billing Control up to date from its Git branch: fetch, fast-forward only, install dependencies when the
// lock file changed, then ask start.js to restart (exit 75). It never overwrites local changes.
const { execFile } = require('node:child_process');
const path = require('node:path');

const RESTART_CODE = 75;
const repoRoot = path.join(__dirname, '..');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: repoRoot, timeout: 5 * 60000, windowsHide: true, shell: process.platform === 'win32' && cmd === 'npm', ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error((stderr || err.message).toString().trim().split('\n').slice(-3).join(' ')), { cause: err }));
      else resolve(stdout.toString().trim());
    });
  });
}
const git = (...a) => run('git', a);

function createUpdater({ getEnabled, isBusy = () => false, log = () => {}, exit = (c) => process.exit(c), supervised = process.env.BILLING_SUPERVISED === '1' }) {
  const state = { current: null, branch: null, behind: 0, last_check: null, last_result: null, last_error: null, supervised, updating: false };

  async function describe() {
    try {
      state.current = await git('rev-parse', '--short', 'HEAD');
      state.branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    } catch (e) { state.last_error = `Not a Git checkout: ${e.message}`; }
    return state;
  }

  /** Checks GitHub; installs and restarts when an update is there. */
  async function check({ install = true } = {}) {
    if (state.updating) return state;
    state.last_check = new Date().toISOString();
    state.last_error = null;
    try {
      await describe();
      if (!state.branch || state.branch === 'HEAD') throw new Error('Not on a branch, so there is nothing to update from');
      await git('fetch', '--quiet', 'origin', state.branch);
      state.behind = Number(await git('rev-list', '--count', `HEAD..origin/${state.branch}`)) || 0;
      if (!state.behind) { state.last_result = 'Up to date'; return state; }
      if (!install) { state.last_result = `${state.behind} update(s) available`; return state; }
      const dirty = (await git('status', '--porcelain', '--untracked-files=no')).trim();
      if (dirty) throw new Error('Files in this folder were changed by hand, so the update was not installed. Ask for help to clean them up.');
      state.updating = true;
      const lockBefore = await git('rev-parse', 'HEAD:billing/package-lock.json').catch(() => '');
      await git('merge', '--ff-only', `origin/${state.branch}`);
      const lockAfter = await git('rev-parse', 'HEAD:billing/package-lock.json').catch(() => '');
      if (lockBefore !== lockAfter) await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: path.join(repoRoot, 'billing') });
      await describe();
      state.behind = 0;
      state.last_result = `Updated to ${state.current}`;
      log(`Update installed (${state.current}).`);
      if (supervised) {
        // Give running requests (for example a bot writing a row) a moment to finish, then restart.
        const started = Date.now();
        const wait = () => (isBusy() && Date.now() - started < 30000 ? setTimeout(wait, 500) : exit(RESTART_CODE));
        setTimeout(wait, 300);
      } else {
        state.last_result += '. Restart Billing Control (npm.cmd start) to use it.';
      }
    } catch (e) {
      state.last_error = e.message;
      state.updating = false;
    }
    return state;
  }

  function start(intervalMinutes = 5) {
    describe();
    const tick = () => { if (getEnabled()) check().catch(() => {}); };
    setTimeout(tick, 60000);
    return setInterval(tick, intervalMinutes * 60000);
  }

  return { state, check, describe, start };
}

module.exports = { createUpdater, RESTART_CODE };
