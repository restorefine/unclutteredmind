# Uncluttered Mind

Say or type everything in your head. Uncluttered Mind turns it into a calm, planned day with breathers between tasks, shows **one thing at a time**, and nudges you on WhatsApp from your business number. Built for ADHD brains.

**Hosting it?** Open [HANDOVER.html](HANDOVER.html) in a browser (what the app does, how every feature works, and step-by-step hosting), or read the same guide in Markdown in [DEPLOY.md](DEPLOY.md).

## What it does

| Problem | Feature |
|---|---|
| Getting started | **Break it into small steps** (AI). The first step always takes under 2 minutes. "I'm stuck" on the focus card, or text `STUCK`. |
| Time blindness | Focus card with a time bar. WhatsApp heads-up before a task, a nudge at the start, "5 minutes left" on long tasks, and a check-in at the end. |
| Out of sight, out of mind | WhatsApp **tap-to-reply buttons** (Done · +15 min · Tomorrow). A second gentle nudge if you don't reply. |
| Capture friction | Brain dump by voice or typing in the app, or **text / voice-note the business number**. AI understands messy speech; built-in rules work without AI. |
| Overwhelm | **"Too much? Keep my top 3"** (or text `TOO MUCH`) keeps set-time items plus your top 3 and moves the rest to tomorrow, with Undo. |
| Energy swings | Morning **energy check-in** (Low / OK / High). Low keeps the 3 easiest things; High puts the hardest thing first. |
| Routines | **Repeats**: "meds every morning at 8", "bins every Tuesday night", "gym on Mondays and Thursdays at 6". |
| Ideas with no date | **Someday list**: "learn Spanish someday". |
| Shame spirals | "Not today" is always one tap away. Missed tasks get a "Did you finish this?" check. A Sunday recap celebrates what got done, with no streaks to break. |
| Messages at bad times | **Quiet hours** (urgent tasks still come through). |
| Secure, quick sign-in | Username + password, then **Face ID / Touch ID / fingerprint** via passkeys. |

## Run it locally

```bash
cp .env.example .env      # set APP_USERNAME and APP_PASSWORD
npm start                 # http://localhost:3000
npm test                  # 36 automated tests (parser, planner, reminders, full server with mocked WhatsApp + AI)
```

No `npm install` needed: there are zero dependencies. Requires Node 22.13 or newer (it uses Node's built-in SQLite). Data lives in `data/unclutteredmind.db`.

Without a server (opening `public/index.html` from a static host), the app still works in "This device only" mode using browser storage. WhatsApp, voice notes and AI need the server.

## Project layout

```
server.js              HTTP server: API, login, WhatsApp webhook, reminder loop, static files
lib/whatsapp.js        WhatsApp Cloud API: buttons inside the 24h window, templates outside it, voice-note download
lib/ai.js              Optional AI: brain-dump understanding, step breakdown, voice transcription
lib/store.js           SQLite storage (built-in node:sqlite), daily backups, one-time data.json import
lib/webauthn.js        Passkey (Face ID / Touch ID) verification, no dependencies
lib/reminders.js       Pure function deciding which reminders are due (fully unit-tested)
public/shared.js       Parser, planner and all state operations (shared by server and browser)
public/app.js          Browser app
public/app.css         Styles (light + dark)
public/index.html      Page shell
test/                  node:test suites
Dockerfile, docker-compose.yml   Production: app only, behind an existing Caddy/Nginx (port 127.0.0.1:3100)
docker-compose.standalone.yml, Caddyfile   Production on a fresh server: app + its own Caddy (automatic HTTPS)
```

## WhatsApp commands

| Send | What happens |
|---|---|
| any text or voice note | Becomes tasks, e.g. "buy milk, ring the GP at 9 tomorrow" |
| `DONE` / `SNOOZE` / `SKIP` | Acts on the current task (or tap the buttons) |
| `TODAY` | Today's plan |
| `STUCK` | Breaks the current task into tiny steps |
| `TOO MUCH` | Keeps 3 things, moves the rest to tomorrow |
| `LOW` / `OK` / `HIGH` | Tells it your energy today |
| `HELP` | Lists the commands |
