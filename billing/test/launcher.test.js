'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBotCommand } = require('../lib/launcher');

test('bot launch command: quotes safely and refuses odd input', () => {
  const cmd = buildBotCommand({ taskId: 4, botName: 'Bot 2', billingHome: "C:\\Billing O'Neil\\billing", billingUrl: 'http://127.0.0.1:3000' });
  assert.match(cmd, /claude --chrome 'You are Bot 2\. Use the data-entry skill and start task 4\.'/);
  assert.match(cmd, /\$env:BILLING_HOME = 'C:\\Billing O''Neil\\billing'/, 'single quotes are doubled for PowerShell');
  assert.match(cmd, /GetEnvironmentVariable\('BILLING_TOKEN', 'User'\)/, 'token comes from the PC, not the app');
  assert.ok(!/bct_/.test(cmd));
  assert.throws(() => buildBotCommand({ taskId: 4, botName: "Bot'; rm", billingHome: 'x', billingUrl: 'y' }));
  assert.throws(() => buildBotCommand({ taskId: '4; calc', botName: 'Bot 1', billingHome: 'x', billingUrl: 'y' }));
});

test('bot launch command reloads PATH so a fresh Claude Code install is found', () => {
  const cmd = buildBotCommand({ taskId: 1, botName: 'Bot 1', billingHome: 'C:\\b', billingUrl: 'http://127.0.0.1:3000' });
  assert.match(cmd, /\$env:Path = \[Environment\]::GetEnvironmentVariable\('Path', 'Machine'\)/);
  assert.match(cmd, /Join-Path \$env:USERPROFILE '\.local\\bin'/);
});
