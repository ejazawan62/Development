'use strict';
// Starts a Claude Code bot session in a new, visible PowerShell window on the PC running Billing Control.
// Visible on purpose: Claude may ask to approve Chrome on a site, and the bot confirms the Task Setup with
// the person before it touches any record (SOP rule 1).
const { spawn } = require('node:child_process');

const SAFE_NAME = /^[A-Za-z0-9 ]{1,20}$/;

/** PowerShell single-quoted string: only ' needs escaping (as ''). */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Builds the PowerShell command the new window runs. Pure function, so it can be tested.
 * The token is read from the user's saved BILLING_TOKEN (setx) at launch, never passed through the app.
 */
function buildBotCommand({ taskId, botName, billingHome, billingUrl }) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new Error('Bad task id');
  if (!SAFE_NAME.test(botName)) throw new Error('Bad bot name');
  const prompt = `You are ${botName}. Use the data-entry skill and start task ${taskId}.`;
  return [
    `$Host.UI.RawUI.WindowTitle = ${psQuote(`${botName} - Task ${taskId}`)}`,
    `$env:BILLING_HOME = ${psQuote(billingHome)}`,
    `$env:BILLING_URL = ${psQuote(billingUrl)}`,
    `$env:BILLING_BOT = ${psQuote(botName)}`,
    "$env:BILLING_TOKEN = [Environment]::GetEnvironmentVariable('BILLING_TOKEN', 'User')",
    // Billing Control may have been started before Claude Code was installed: reload PATH and add the
    // native installer's folder, so "claude" is found either way.
    "$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $env:USERPROFILE '.local\\bin')",
    `if (-not $env:BILLING_TOKEN) { Write-Host ${psQuote('BILLING_TOKEN is not set on this PC. Create a bot token in Billing Control (Settings), then run:  setx BILLING_TOKEN "<token>"')} -ForegroundColor Yellow; return }`,
    `if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host ${psQuote('Claude Code is not installed. Run this in PowerShell, then click Start bot again:  irm https://claude.ai/install.ps1 | iex')} -ForegroundColor Yellow; return }`,
    `Write-Host ${psQuote(`Starting ${botName} on task ${taskId}. Keep this window open while it works.`)} -ForegroundColor Cyan`,
    `claude --chrome ${psQuote(prompt)}`,
  ].join('; ');
}

/** Real launcher (Windows only). Returns { ok, message }. */
function windowsLauncher({ taskId, botName, billingHome, billingUrl }) {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Start bot opens a window on Windows only. On this computer, start the bot by pasting the message into Claude.' };
  }
  const command = buildBotCommand({ taskId, botName, billingHome, billingUrl });
  // -EncodedCommand (UTF-16LE base64) means no shell ever re-parses quotes or special characters:
  // the command line below contains only letters, digits, spaces, '-', '+', '/', '=' and the quoted title.
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const title = `${botName} - Task ${taskId}`;
  // Windows' "start" always opens a NEW visible console window. (A detached child gets no console at all.)
  // shell: true runs: cmd.exe /d /s /c "start "<title>" powershell.exe ..."
  const line = `start "${title}" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  const child = spawn(line, { cwd: billingHome, shell: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  return { ok: true, message: `${botName} is starting in a new window on this PC.` };
}

module.exports = { buildBotCommand, windowsLauncher, SAFE_NAME };
