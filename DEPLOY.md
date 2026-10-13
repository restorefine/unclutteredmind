# Uncluttered Mind: Developer Handover & Hosting Guide

This guide covers everything needed to put Uncluttered Mind online, connect it to the WhatsApp business number, and keep it running.

**Estimated time:** about 1–2 hours, most of it waiting on Meta (business verification and template approval).

---

## 1. What you're deploying

A single Node.js process with **no npm dependencies**:

- serves the web app (`public/`)
- exposes a small JSON API (`/api/*`) protected by a login (username + password, or a passkey: Face ID / Touch ID / fingerprint)
- receives WhatsApp messages on `/webhook` (WhatsApp Cloud API)
- runs a reminder loop every 30 seconds that sends WhatsApp messages
- stores everything in a SQLite database (`DATA_DIR/unclutteredmind.db`, Node's built-in SQLite) with transactional writes and 14 days of daily backups

```
Phone browser ──HTTPS──▶  Caddy / platform proxy  ──▶  node server.js  ──▶  DATA_DIR/unclutteredmind.db
                                                           │   ▲
                         WhatsApp Cloud API  ◀──messages───┘   └──webhook── Meta
                         Anthropic / OpenAI  ◀──optional AI calls
```

**Important constraints**

- **One user per deployment.** One login (plus that person's passkeys), one WhatsApp recipient (`WA_TO`).
- **Run exactly one instance.** Storage is a file and the reminder timer runs in-process. Two replicas would double-send reminders and overwrite each other's data. Don't enable autoscaling.
- **It needs a persistent disk.** Without one, data is wiped on every deploy.
- **It must stay running.** "Sleep when idle" free tiers will miss reminders.
- **HTTPS is required.** The microphone, secure cookies and Meta's webhook all need it.

## 2. Requirements

| Thing | Notes |
|---|---|
| Node 22.13+ **or** Docker | Docker image provided |
| A domain or subdomain | e.g. `app.unclutteredmind.com`, with DNS you control |
| Host with a persistent disk | A small VPS (1 vCPU / 512 MB is plenty), or Render / Railway / Fly.io with a volume |
| Meta Business account + the business phone number | For WhatsApp |
| Optional: Anthropic and/or OpenAI API key | For AI understanding, step breakdown and voice notes |

## 3. Try it locally first (5 minutes)

```bash
unzip unclutteredmind.zip && cd unclutteredmind
npm test                 # should print: pass 36, fail 0
cp .env.example .env     # set APP_USERNAME and APP_PASSWORD
npm start                # open http://localhost:3000
```

Without WhatsApp or AI keys everything else works, and the server logs say what's missing.

## 4. Configuration

All settings are environment variables (or a `.env` file next to `server.js`). `.env.example` has every option with comments.

| Variable | Required | What it does |
|---|---|---|
| `APP_USERNAME` | **Yes** (online) | The one account that can sign in. |
| `APP_PASSWORD` | **Yes** (online) | Its password, 12+ characters. Five wrong tries lock logins for 15 minutes. The app won't start with `NODE_ENV=production` (the Docker default) unless both are set. |
| `APP_ORIGIN` | Recommended | The exact address, e.g. `https://app.yourdomain.com`. Passkeys are tied to it. If empty it's taken from each request. |
| `TZ` | Recommended | Timezone for planning and reminders. Default `Europe/London`. |
| `DATA_DIR` | **Yes** (prod) | Folder on the persistent disk. Docker default `/data`. |
| `TRUST_PROXY` | Yes behind a proxy | Set to `1` behind Caddy/Nginx/Render/Railway so HTTPS cookies and IP rate-limiting work. |
| `PORT` | No | Default `3000`. Platforms usually set this for you. |
| `SESSION_SECRET` | No | Signs login cookies. Auto-generated and stored in the database if empty. Changing `APP_USERNAME` or `APP_PASSWORD` signs everyone out. |
| `WA_TOKEN` | For WhatsApp | Permanent System User access token |
| `WA_PHONE_NUMBER_ID` | For WhatsApp | Phone number ID of the business number (not the phone number itself) |
| `WA_TO` | For WhatsApp | Rohit's personal number in international format, e.g. `447700900123`. Only this number can command the bot. |
| `WA_VERIFY_TOKEN` | For WhatsApp | Random string you make up; must match the webhook settings in Meta |
| `WA_APP_SECRET` | **Yes** (prod) | Meta app secret. Used to verify webhook signatures; without it, forged calls are possible. |
| `WA_TEMPLATE_NAME` | For WhatsApp | Approved plain template (section 6.6) |
| `WA_TEMPLATE_BUTTONS_NAME` | Optional | Approved template with 3 quick-reply buttons (section 6.6) |
| `WA_TEMPLATE_LANG` | No | Default `en_GB`. Must match the template's language. |
| `WA_API_VERSION` | No | Default `v21.0`. Bump if Meta deprecates it. |
| `ANTHROPIC_API_KEY` | Optional | Enables AI brain-dump understanding and "Break it into small steps" |
| `ANTHROPIC_MODEL` | No | Default `claude-haiku-5-5` |
| `OPENAI_API_KEY` | Optional | Enables voice notes (WhatsApp and in-app recording). Also used for AI text if there's no Anthropic key. |
| `OPENAI_MODEL` / `TRANSCRIBE_MODEL` | No | Defaults `gpt-4o-mini` / `whisper-1`. Check these are still current in OpenAI's docs. |

## 5. Hosting

Pick **one** option.

### Option A: VPS with Docker Compose + Caddy (recommended)

Gives automatic HTTPS, a persistent volume, and auto-restart. Works on any Ubuntu/Debian VPS (Hetzner, DigitalOcean, Lightsail…).

1. **Point DNS.** Create an `A` record for your subdomain → the VPS IP. Wait until `ping app.yourdomain.com` resolves to it.
2. **Install Docker** on the VPS:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
3. **Open the firewall** for 80 and 443 (and SSH):
   ```bash
   ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
   ```
4. **Upload the code** (scp the zip, or push to a private Git repo and clone):
   ```bash
   scp unclutteredmind.zip root@VPS_IP:~ && ssh root@VPS_IP
   unzip unclutteredmind.zip && cd unclutteredmind
   ```
5. **Configure:**
   ```bash
   cp .env.example .env && nano .env
   ```
   Set at least `DOMAIN`, `APP_USERNAME`, `APP_PASSWORD`, `APP_ORIGIN` (`https://` + your domain), `TZ`. Add the WhatsApp values once you have them (section 6). Compose already sets `DATA_DIR=/data` and `TRUST_PROXY=1`.
6. **Start:**
   ```bash
   docker compose up -d --build
   docker compose logs -f app      # Ctrl+C to stop following
   ```
7. **Check:** `https://app.yourdomain.com/healthz` returns `{"ok":true,...}` and the site shows the sign-in screen. Sign in with the password; on a phone or Mac it then offers to set up Face ID / Touch ID.

**Update later:** upload the new code, then run `docker compose up -d --build`. Data lives in the `um-data` volume and survives rebuilds.

> **Tested:** the Docker image has been built and run: health check passes, tasks survive a container restart, and the daily backup is written.

### Option B: Render / Railway / Fly.io (no server admin)

The repo has a `Dockerfile`, so any Docker-capable platform works. On whichever you choose:

1. Create a **Web Service from the repo/Dockerfile** (push the folder to a private GitHub repo first).
2. **Add a persistent disk/volume** mounted at **`/data`** (1 GB is plenty).
3. Set **instances = 1**, no autoscaling, and pick a plan that **doesn't sleep**.
4. Set environment variables: `APP_USERNAME`, `APP_PASSWORD`, `APP_ORIGIN`, `TZ=Europe/London`, `DATA_DIR=/data`, `TRUST_PROXY=1`, plus the WhatsApp/AI values.
5. Set the health check path to `/healthz`.
6. Add the custom domain in the platform's dashboard and follow its DNS instructions (HTTPS is automatic).

### Option C: Plain Node on a server you already run

```bash
node server.js     # keep alive with systemd or pm2; put Nginx/Caddy in front for HTTPS; set TRUST_PROXY=1
```

Minimal systemd unit (`/etc/systemd/system/unclutteredmind.service`):

```ini
[Unit]
Description=Uncluttered Mind
After=network.target

[Service]
WorkingDirectory=/opt/unclutteredmind
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data
EnvironmentFile=/opt/unclutteredmind/.env

[Install]
WantedBy=multi-user.target
```

## 6. Connect WhatsApp (WhatsApp Cloud API)

Do this once the site is live on HTTPS, because Meta has to reach the webhook.

### 6.1 Create the Meta app

1. Go to **developers.facebook.com → My Apps → Create app**. Choose type **Business** and link it to RestoRefine's **Meta Business account**.
2. In the app dashboard, **Add product → WhatsApp → Set up**.

### 6.2 Add the business phone number

1. **WhatsApp → API Setup → Add phone number**, then verify it by SMS or voice.
2. ⚠️ **If the number is currently used in the WhatsApp Business app on a phone,** read Meta's onboarding screen carefully. Depending on Meta's current options, the number may be shared with the app ("coexistence") or have to be moved to the API exclusively, in which case it stops working in the phone app. **Confirm with Rohit before migrating.** Using a dedicated number for the bot avoids the issue.
3. Copy the **Phone number ID** (not the number) into `WA_PHONE_NUMBER_ID`.
4. Make sure **business verification** and a **payment method** are set up in Business Settings, or messaging limits will be very low.

### 6.3 Permanent access token

The token on the API Setup page expires after 24 hours, so don't use it in production.

1. **business.facebook.com → Settings → Users → System users → Add** (Admin role).
2. **Assign assets:** the app (full control) and the WhatsApp account (full control).
3. **Generate new token** for the app with the permissions **`whatsapp_business_messaging`** and **`whatsapp_business_management`**, with no expiry.
4. Put it in `WA_TOKEN`.

### 6.4 Webhook (so replies, button taps and voice notes reach the app)

1. **WhatsApp → Configuration → Webhook → Edit**
   - Callback URL: `https://app.yourdomain.com/webhook`
   - Verify token: the same value as `WA_VERIFY_TOKEN`
2. Click **Verify and save**. It only succeeds if the server is running with `WA_VERIFY_TOKEN` set.
3. **Webhook fields → `messages` → Subscribe.**
4. **App settings → Basic → App secret** → put it in `WA_APP_SECRET`, then restart.
5. Set the app to **Live** mode.

### 6.5 Recipient

Put Rohit's personal number in `WA_TO` (digits with country code; spaces and `+` are fine). Messages from any other number are ignored.

### 6.6 Message templates

WhatsApp only delivers free-form and button messages within **24 hours of the user's last message** to the business number. Outside that window it requires pre-approved templates. The app switches between the two automatically.

Create these in **WhatsApp Manager → Message templates → Create template**:

**Template 1 (required): `unclutteredmind_reminder`**
- Category: **Utility**
- Language: **English (UK)**, matching `WA_TEMPLATE_LANG=en_GB`
- Body:
  ```
  Hi, it's Uncluttered Mind. {{1}} Reply here any time.
  ```
- Sample for `{{1}}`: `Time for: Call the bank. 15 min, until 2:15pm.`
- Set `WA_TEMPLATE_NAME=unclutteredmind_reminder`

**Template 2 (optional, recommended): `unclutteredmind_task`**
- Same category, language and body as above.
- **Buttons → Quick reply**, exactly three, **in this order**: `Done`, `+15 min`, `Tomorrow`
- Set `WA_TEMPLATE_BUTTONS_NAME=unclutteredmind_task`

The app fills `{{1}}` with the message text. Templates can't contain line breaks, so the app joins lines with " · ". Template messages are charged by Meta; check Meta's current WhatsApp pricing.

**Tip for Rohit:** sending any message (e.g. `TODAY`) to the business number each morning keeps the 24h window open, so reminders arrive with real tap buttons.

### 6.7 Test it

1. Restart the app. The logs should show `"features":"{\"ai\":…,\"whatsapp\":true,…}"` with no WhatsApp warnings.
2. From Rohit's phone, send **`hi`** to the business number. The help message should come back.
3. In the app: **Settings → Send a test WhatsApp**.
4. Add a task 12 minutes from now and wait: you should get the heads-up, then the start message with buttons.

## 7. AI keys (optional, recommended)

| Feature | Key | Without it |
|---|---|---|
| Understanding messy brain dumps | `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) | Built-in rule parser (still good) |
| "Break it into small steps" / `STUCK` | same | Button hidden; manual steps still work |
| WhatsApp voice notes + in-app recording fallback | `OPENAI_API_KEY` | App asks to type; in-browser speech recognition (Chrome/Edge/Safari) still works |

Set a **monthly spend limit** in each provider's console. Usage for one person is small, but limits stop surprises. If an AI call fails or times out, the app quietly falls back to the rule parser.

## 8. Go-live checklist

- [ ] `https://…/healthz` returns `ok: true`
- [ ] `APP_USERNAME`, `APP_PASSWORD` (12+ characters) and `APP_ORIGIN` set; the sign-in screen appears
- [ ] Face ID / Touch ID set up on the phone after the first login, and signing in with **Passkey** works
- [ ] Persistent disk mounted; `DATA_DIR` points at it; `unclutteredmind.db` appears after the first start
- [ ] Exactly **one** instance running, and it never sleeps
- [ ] `TRUST_PROXY=1` behind a proxy/platform
- [ ] `TZ` correct (check that a task at 3pm shows as 3pm)
- [ ] WhatsApp: token is a **permanent** System User token; webhook verified; `messages` subscribed; `WA_APP_SECRET` set
- [ ] Template `unclutteredmind_reminder` **approved**; optional buttons template approved
- [ ] Test WhatsApp received; replying `DONE` to a reminder works
- [ ] Uptime monitor (e.g. UptimeRobot, free) pinging `/healthz` every 5 minutes
- [ ] Off-server backup scheduled (section 9)
- [ ] On Rohit's phone: open the site → Share → **Add to Home Screen**

## 9. Running it

**Logs:** one JSON line per event (`docker compose logs -f app`). Useful messages: `whatsapp sent`, `whatsapp send failed` (with Meta's error code and a hint), `WhatsApp could not deliver a message`, `AI parse failed, using rules`, `wrong username or password`, `signed in with passkey`, `passkey sign-in failed`.

**Backups:** the app writes `DATA_DIR/backups/data-YYYY-MM-DD.db` daily and keeps 14. Also copy them off the server. For a VPS, run this daily from cron:

```bash
docker compose cp app:/data/backups ./backups-$(date +%F)
```

**Restore:** stop the app, delete `unclutteredmind.db-wal` and `unclutteredmind.db-shm` if present, copy a backup over `DATA_DIR/unclutteredmind.db`, then start it again.

**Moving from the old JSON version:** leave `data.json` in `DATA_DIR`. On first start the app imports it into the database and renames it to `data.json.imported`.

**Database won't open:** the app logs `could not open the database` and exits instead of starting empty. Restore from `backups/` as above.

**Updating:** replace the code, run `npm test`, then redeploy. Data format changes are handled on load.

**Health:** `GET /healthz` returns `{ ok, uptime, features }`. The Docker image has a built-in HEALTHCHECK.

## 10. Security summary

- Username + password login (scrypt-hashed in memory, constant-time compare) → HttpOnly, SameSite=Lax, Secure (on HTTPS) session cookie valid for 90 days, signed with HMAC.
- Passkeys (WebAuthn): Face ID / Touch ID / fingerprint / Windows Hello / security key. The server stores only the public key. Each sign-in checks the site address, a single-use challenge (5 minutes), that the face/finger/PIN check happened (user verification), and the signature. Passkeys can be removed in Settings → Sign-in; the password always still works.
- Login rate limit: 5 wrong attempts per IP → 15-minute lockout.
- The server refuses to start in production without a login configured.
- Every write request requires the `x-um: 1` header (CSRF protection) and a JSON body.
- Strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and `no-referrer`; static file serving is protected against path traversal.
- Webhook calls are verified with `X-Hub-Signature-256` (needs `WA_APP_SECRET`). Only messages from `WA_TO` are acted on; duplicate deliveries are ignored.
- Secrets stay in environment variables only; the browser never sees tokens or keys.
- Task text can include personal details. Keep the server's disk and backups private, and keep `.env` out of Git (it's already in `.gitignore`).

## 11. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Webhook "Verify and save" fails | Server not reachable over HTTPS, or `WA_VERIFY_TOKEN` mismatch. Check `curl "https://…/webhook?hub.mode=subscribe&hub.verify_token=YOURTOKEN&hub.challenge=hi"` returns `hi`. |
| Replies to the bot do nothing | `messages` field not subscribed, app not Live, `WA_TO` doesn't match the sender, or `WA_APP_SECRET` is wrong (logs show `webhook signature mismatch`). |
| `whatsapp send failed` with code **131047** | Outside the 24h window and no approved template. Set `WA_TEMPLATE_NAME` to an approved template. |
| Code **132001** | Template name or language doesn't match what's approved. Check `WA_TEMPLATE_LANG`. |
| Code **190** / "Session has expired" | Temporary token used. Create the permanent System User token (6.3). |
| Code **131030** | `WA_TO` isn't an allowed recipient (test mode) → add it in API Setup, or take the app Live with a verified business. |
| Reminders an hour off | Wrong `TZ`. |
| No reminders at all | WhatsApp not configured (pill in app says "WhatsApp off"), quiet hours, the instance is sleeping, or a "heads-up" setting is Off. |
| Data disappears after deploy | No persistent disk, or `DATA_DIR` isn't on it. |
| Everyone logged out | `APP_USERNAME`, `APP_PASSWORD` or `SESSION_SECRET` changed (expected). |
| Passkey button missing or fails with "different site" | Passkeys need HTTPS (or `localhost`) and only work on the address they were created on. Set `APP_ORIGIN` to the real address; if the domain changed, sign in with the password and add the passkey again. |
| App exits with `refusing to start` | Set `APP_USERNAME` and `APP_PASSWORD` in `.env`. |
| Mic button says it can't listen | Firefox has no speech recognition: add `OPENAI_API_KEY` for the recording fallback. The page must be HTTPS. |

## 12. API reference (for debugging)

All `/api/*` calls need the session cookie (log in first); writes need the `x-um: 1` header.

| Method & path | Body | Purpose |
|---|---|---|
| `POST /api/login` | `{username, password}` | Sets the session cookie; returns `passkeys` (count) |
| `POST /api/passkey/login/options` → `/verify` | WebAuthn assertion | Sign in with a passkey |
| `POST /api/passkey/register/options` → `/verify` | WebAuthn attestation | Add a passkey (signed in) |
| `GET /api/passkeys`, `DELETE /api/passkeys/:id` | – | List / remove passkeys |
| `POST /api/logout` | – | Clears it |
| `GET /api/state` | – | Tasks, repeats, energy, settings, feature flags |
| `POST /api/parse` | `{text, date?}` | Brain dump → preview items (`source: ai|rules`) |
| `POST /api/items` | `{items:[…]}` | Adds tasks/repeats |
| `POST /api/tasks/:id/:action` | – | `done`, `undo`, `snooze`, `tomorrow`, `place`, `today`, `startnow`, `someday`, `delete` |
| `PUT /api/tasks/:id/steps` | `{steps:[{id?,text,done}]}` | Replace steps (finishing all steps completes the task) |
| `POST /api/tasks/:id/breakdown` | – | AI steps |
| `POST /api/rescue` · `/api/rescue/undo` | `{date}` · `{ids}` | Keep top 3 / undo |
| `POST /api/energy` | `{date, level: low|ok|high}` | Energy check-in |
| `DELETE /api/routines/:id` | – | Stop a repeat |
| `PUT /api/settings` | settings object | Values are clamped server-side |
| `POST /api/whatsapp/test` | – | Sends a test message |
| `POST /api/transcribe` | raw audio | In-app recording → text |
| `GET/POST /webhook` | Meta | WhatsApp verification / events |
| `GET /healthz` | – | Health |

## 13. Known limits and sensible next steps

- Single user. Turning it into a product for other people needs accounts, a database (e.g. Postgres), per-user WhatsApp numbers and opt-in consent, billing, and a privacy policy. Treat that as a separate project.
- No phone push notifications outside WhatsApp yet (web push would need a service worker and VAPID keys).
- No Google/Outlook calendar sync yet.
- Times are in one timezone (`TZ`).
