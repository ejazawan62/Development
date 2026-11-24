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
const MODELS = new Set(['', 'sonnet', 'opus', 'haiku']);

// Tools a background bot may use without asking: its own CLI, Claude in Chrome, and reading files.
const BACKGROUND_TOOLS = ['Bash(node *bot.js*)', 'PowerShell(node *bot.js*)', 'mcp__claude-in-chrome__*', 'Read'];

function buildBotCommand({ taskId, botName, billingHome, billingUrl, model = '', headless = false, confirmedBy = '' }) {
  if (!MODELS.has(model)) throw new Error('Bad model');
  if (!Number.isInteger(taskId) || taskId < 1) throw new Error('Bad task id');
  if (!SAFE_NAME.test(botName)) throw new Error('Bad bot name');
  const who = /^[A-Za-z][A-Za-z .'-]{0,59}$/.test(confirmedBy) ? confirmedBy : 'a person';
  const prompt = headless
    ? `You are ${botName}. Use the data-entry skill and work task ${taskId}. You are running in the background with no terminal: `
      + `the Task Setup was already confirmed in Billing Control by ${who}, so do not ask for a yes. Talk to people only through `
      + 'the bot say command, and wait for their answers (including one-time codes) with the bot wait command.'
    : `You are ${botName}. Use the data-entry skill and start task ${taskId}.`;
  const fail = (text) => (headless ? `Write-Output ${psQuote(text)}; exit 2` : `Write-Host ${psQuote(text)} -ForegroundColor Yellow; return`);
  return [
    headless ? '$env:BILLING_HEADLESS = \'1\'' : `$Host.UI.RawUI.WindowTitle = ${psQuote(`${botName} - Task ${taskId}`)}`,
    `$env:BILLING_HOME = ${psQuote(billingHome)}`,
    `$env:BILLING_URL = ${psQuote(billingUrl)}`,
    `$env:BILLING_BOT = ${psQuote(botName)}`,
    "$env:BILLING_TOKEN = [Environment]::GetEnvironmentVariable('BILLING_TOKEN', 'User')",
    // Billing Control may have been started before Claude Code was installed: reload PATH and add the
    // native installer's folder, so "claude" is found either way.
    "$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $env:USERPROFILE '.local\\bin')",
    `if (-not $env:BILLING_TOKEN) { ${fail('BILLING_TOKEN is not set on this PC. Create a bot token in Billing Control (Settings), then run:  setx BILLING_TOKEN "<token>"')} }`,
    `if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { ${fail('Claude Code is not installed. Run this in PowerShell, then click Start bot again:  irm https://claude.ai/install.ps1 | iex')} }`,
    // Keep the bot's instructions (the data-entry skill) in step with this Billing Control version.
    "$skills = Join-Path $env:USERPROFILE '.claude\\skills'; New-Item -ItemType Directory -Force $skills | Out-Null; Copy-Item -Recurse -Force (Join-Path $env:BILLING_HOME 'bot\\data-entry') $skills",
    ...(headless
      ? [`claude -p ${psQuote(prompt)} --chrome --output-format stream-json --verbose --permission-mode dontAsk --allowedTools ${BACKGROUND_TOOLS.map(psQuote).join(' ')}${model ? ` --model ${model}` : ''}`]
      : [`Write-Host ${psQuote(`Starting ${botName} on task ${taskId}. Keep this window open while it works.`)} -ForegroundColor Cyan`,
        `claude --chrome${model ? ` --model ${model}` : ''} ${psQuote(prompt)}`]),
  ].join('; ');
}

/** Real launcher (Windows only). Returns { ok, message, child? }. */
function windowsLauncher({ taskId, botName, billingHome, billingUrl, model, headless = false, confirmedBy = '' }) {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Start bot works on Windows only. On this computer, start the bot by pasting the message into Claude.' };
  }
  const command = buildBotCommand({ taskId, botName, billingHome, billingUrl, model, headless, confirmedBy });
  if (headless) {
    // Hidden: no window, no taskbar entry. Billing Control reads its progress from stdout.
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      cwd: billingHome, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, child, message: `${botName} is working in the background. Follow it in the chat panel.` };
  }
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

/** Stops a background bot and everything it started (Claude, its shells). */
function stopProcessTree(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  else child.kill('SIGTERM');
}

module.exports = { buildBotCommand, windowsLauncher, stopProcessTree, SAFE_NAME, BACKGROUND_TOOLS };
