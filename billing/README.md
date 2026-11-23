# Billing Control + Data Entry Bot

Medical billing data entry for demos (patient demographics), claim creation and claim submission in
Office Ally, following the team SOP in [`bot/data-entry/reference/sop.md`](bot/data-entry/reference/sop.md).

There are two parts:

| Part | What it does |
| --- | --- |
| **Billing Control** (web app, `server.js`) | Task Setup form, sheet header check, worklist, per-row checks, demo entry cards, payer lists, alerts, end-of-session reports. Reads and writes the Google Sheet. |
| **Data Entry Bot** (Claude skill, `bot/data-entry/`) | Claude in the desktop app, driving Chrome on the office PC: Office Ally, Medicare/Medicaid/UHC/Availity portals. Gets each row from Billing Control and records the outcome through it. |

What Billing Control enforces (so neither the bot nor a person can skip it):

- A task can't start until every Task Setup field is filled, NPIs pass the check digit, the sheet's header row
  matches the Status / Insurance / Notes columns, and a person ticks **Confirm**.
- One patient at a time: the bot must finish its current row before it gets the next.
- Claims with a different provider, a facility address that doesn't match, a drug line without an NDC,
  codes/units that don't line up, or a bad DOS/ICD-10 **cannot** be recorded as Claim Created / Submitted.
  Only "Held" with a reason.
- Every outcome needs its checklist (searched first, eligibility on DOS, Box 32 checked, saved in Patient Visits only…).
- Only the primary insurance goes in the Insurance column, using the payer list's name. Notes use the standard wording.
  Anything that looks like a password is refused.
- Before writing a row, the app re-reads it and checks the patient name and DOB, so a re-sorted sheet can't
  get the wrong status. Notes are added after the team's existing notes, never over them.
- The same held reason on 3 rows pauses the bot until a person looks.

## Run it on the office PC / VM

Needs Node.js 22.5 or newer.

```bash
git clone <this repo> && cd <repo>/billing
```

```bash
npm install
```

```bash
npm start
```

The first start creates an admin account and prints its password once. Open http://127.0.0.1:3000,
sign in and change the password (top bar → Change password). Set `ADMIN_EMAIL` /
`ADMIN_PASSWORD` before the first start to choose them yourself.

Settings (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Where the app listens. Keep `127.0.0.1` unless other office PCs need it (then put it behind HTTPS) |
| `DATA_DIR` | `billing/data` | Database (`billing.db`). Back this folder up |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | not set | Optional: Google service account key. Without it, connect Google in Settings; until then the app runs in test mode with local fake sheets |

### Connect Google Sheets

The easy way (no Google Cloud console): sign in to Billing Control as admin, open **Settings → Google Sheets
connection** and follow the 5 steps on screen. You paste a small script into **script.google.com** under your
own Google account and deploy it as a web app. After that, any sheet that account can edit works by pasting
its link into a Task Setup. The script contains a secret key: don't share it. **Make a new one** replaces the key.

Alternative for IT-managed setups: a Google Cloud service account. Start the app with
`GOOGLE_SERVICE_ACCOUNT_FILE=/path/to/key.json` and share each sheet with the service account's email as Editor.

### Try it with fake data first

```bash
npm run seed:demo
```

```bash
npm start
```

Sign in with username `admin@example.com` and password `demo-admin-pass`. Two DEMO tasks are ready: open each, click
**Check sheet header**, tick the confirmation and confirm. The fake sheet is `data/local-sheets.json`.

## Set up the bot PC

On the PC or VM the bot uses (it can be the same machine):

1. Install the Claude desktop app and Claude in Chrome. Save the Office Ally and portal logins in Chrome's
   password manager, so nobody has to type passwords into the chat.
2. In Billing Control → **Users & bot access**, create a bot token (shown once).
3. Set these environment variables for the user the bot runs as:
   - `BILLING_HOME`: the full path of this `billing` folder
   - `BILLING_URL`: for example `http://127.0.0.1:3000`
   - `BILLING_TOKEN`: the token from step 2
4. Copy the skill folder `bot/data-entry` to `~/.claude/skills/data-entry` (Windows:
   `%USERPROFILE%\.claude\skills\data-entry`).
5. Check the connection:

   ```bash
   node "$BILLING_HOME/bin/bot.js" tasks
   ```

Then, in Claude: **"Start task 12"**. The bot shows the Task Setup, waits for your yes, and works row by row.
It asks you in chat for one-time codes, and stops when a login fails twice or the app pauses the task.

The bot token can only work confirmed tasks. It cannot edit Task Setups, payer lists or users.

## Updates

`npm start` runs `start.js`, which runs the server and restarts it after an update. Every 5 minutes Billing Control
checks its Git branch; if there is a new version it fast-forwards (never overwriting local edits), runs
`npm install` when dependencies changed, and restarts within seconds. Open pages notice the new version and reload
themselves (after saving what is being typed). Turn this off, or check now, in **Settings → Updates**.

## Start bot button

On a confirmed task's worklist, **Start bot** opens a PowerShell window on the PC running Billing Control and
starts Claude Code there (`claude --chrome "You are Bot N. Use the data-entry skill and start task X."`), with the next
free bot name. It needs, on that PC:

- Claude Code (command-line):

  ```bash
  irm https://claude.ai/install.ps1 | iex
  ```

- Claude in Chrome, signed in to the same Claude account, and Chrome signed in to Office Ally and the portals;
- `BILLING_TOKEN` saved with `setx` (the window reads it from the PC; the app never stores the token).

The window stays visible on purpose: Claude may ask to approve Chrome on a site, and the bot confirms the Task
Setup with you before it starts. Keep the window open while the bot works. On a Mac or Linux PC the button shows
the message to paste into Claude instead.

## Running several bots at once

Each bot is a separate Claude conversation driving **its own Chrome profile** (its own Office Ally and portal
logins), on the same PC or on different PCs/VMs.

1. In Chrome, create one profile per bot (profile icon → **Add**), for example "Bot 1", "Bot 2". In each profile,
   install Claude in Chrome and sign in to Office Ally and the portals, and save the passwords.
2. Start each bot with its name: *"You are Bot 2. Start task 14."* The bot adds `--as "Bot 2"` to every command.
3. Billing Control keeps them apart:
   - a task belongs to one bot at a time, and one bot works one task at a time;
   - two bots can't use the **same Office Ally account** at the same time (one login in two places can log the other
     out or switch its practice). Use separate Office Ally logins per bot, or give parallel tasks different accounts;
   - two bots can't work **overlapping rows of the same sheet tab**;
   - a bot that is silent for 20 minutes loses its claim, and a person can **Release** a task from the worklist.

Some payer portals also allow only one session per user, so give each bot its own portal users where you can.
Test with two bots on fake data first: whether Claude in Chrome can drive two Chrome profiles at the same time on one
PC depends on your Claude app version. If it can't, run each bot on its own PC/VM or Windows user account.

## Talking to a bot while it works

Every task page has a **Chat with bot** button (bottom right). Messages reach the bot working that task within
seconds of its next check, and its replies, questions and alerts show up in the same chat. **Pause bot** stops it
at its next check (it checks before every Office Ally save and between patients): it leaves the screen unsaved,
says where it stopped, and waits for your instruction until you click **Resume**. Anyone signed in to Billing
Control can use the chat, from any office.

## Sheet layout

The header check matches columns by name (you can change any match before confirming). For claims, one row is one
claim; several codes in one cell are split on new lines, `;`, `|` or `,`, and units / modifiers / charges / pointers
in their own columns must use the same separator so they line up (`99213; J1100` with units `1; 2`). NDCs can be
`00641-0367-21 ML1`, or have their unit and quantity in separate columns. 10-digit NDCs are converted to 11 digits
only when written with dashes; otherwise the row is held.

## Patient data (HIPAA)

- Keep Billing Control on the office PC/VM or your own server. It stores sheet rows for open tasks in `data/`.
  Protect and back up that folder like any other patient data.
- Google Sheets with patient data should be in a Google Workspace account covered by Google's BAA.
- Before the bot handles real patients, check that your Claude plan is covered by a BAA with Anthropic.
- Test only with fake data (`npm run seed:demo`). The seed refuses to run when Google Sheets is connected.

## Development

```bash
npm test
```

Code map: `lib/checks.js` (claim and demo checks: NPI, MBI, NDC, addresses, providers), `lib/rules.js`
(outcomes, checklists, notes, report), `lib/mapping.js` (header matching), `lib/sheets.js` (Google Sheets and
local test sheets), `server.js` (API), `public/` (web app), `bin/bot.js` (bot CLI).
