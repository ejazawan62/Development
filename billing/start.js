'use strict';
// Runs Billing Control and restarts it after it installs an update (exit code 75).
// "npm start" runs this file; the server itself is server.js.
const { spawn } = require('node:child_process');
const path = require('node:path');

const RESTART_CODE = 75;

function run() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'server.js')], {
    cwd: __dirname, stdio: 'inherit', env: { ...process.env, BILLING_SUPERVISED: '1' },
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.on('exit', (code, signal) => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (code === RESTART_CODE) {
      console.log('Update installed. Restarting Billing Control…');
      setTimeout(run, 500);
    } else {
      process.exit(code == null ? (signal ? 1 : 0) : code);
    }
  });
}

run();
