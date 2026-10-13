/*
 * Uncluttered Mind — server. No npm dependencies; Node 22.13+ (built-in SQLite).
 *
 *   - Serves the app from /public
 *   - Stores everything in a SQLite database, DATA_DIR/unclutteredmind.db (daily backups)
 *   - Sends WhatsApp reminders with tap-to-reply buttons (WhatsApp Cloud API)
 *   - Reads WhatsApp replies, button taps and voice notes
 *   - Optional AI: understands messy brain dumps, breaks tasks into steps, transcribes voice
 *
 * See README.md and DEPLOY.md.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ config */
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();
process.env.TZ = process.env.TZ || 'Europe/London';

const P = require('./public/shared.js');
const { createWhatsApp, digits } = require('./lib/whatsapp.js');
const { createAI } = require('./lib/ai.js');
const reminders = require('./lib/reminders.js');
const { openStore } = require('./lib/store.js');
const webauthn = require('./lib/webauthn.js');

const env = k => (process.env[k] || '').trim();
const PORT = Number(env('PORT')) || 3000;
const HOST = env('HOST') || '0.0.0.0';
const DATA_DIR = path.resolve(__dirname, env('DATA_DIR') || 'data');
const DB_FILE = env('DB_FILE') ? path.resolve(__dirname, env('DB_FILE')) : path.join(DATA_DIR, 'unclutteredmind.db');
const BACKUP_DIR = path.join(path.dirname(DB_FILE), 'backups');
const PUBLIC = path.join(__dirname, 'public');
const TRUST_PROXY = env('TRUST_PROXY') === '1' || env('TRUST_PROXY') === 'true';
const IS_TEST = env('NODE_ENV') === 'test';

function log(level, msg, extra) {
  if (IS_TEST && level === 'info' && !env('LOG_IN_TESTS')) return;
  const line = { t: new Date().toISOString(), level, msg };
  if (extra) for (const [k, v] of Object.entries(extra)) if (v !== undefined) line[k] = v;
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

/* ------------------------------------------------------------------ storage */
let store;
try { store = openStore({ file: DB_FILE, legacyJson: path.join(DATA_DIR, 'data.json'), log }); }
catch (e) { log('error', 'could not open the database', { file: DB_FILE, error: e.message }); process.exit(1); }
let db = Object.assign({ version: 3, tasks: [], routines: [], routineLog: {}, energy: {}, settings: {}, meta: {} }, store.load());
P.ops.ensure(db);
db.meta = db.meta || {};
db.meta.seen = Array.isArray(db.meta.seen) ? db.meta.seen : [];
db.passkeys = Array.isArray(db.passkeys) ? db.passkeys : [];
if (!db.meta.userId) db.meta.userId = crypto.randomBytes(16).toString('base64url');
if (!db.meta.secret) db.meta.secret = crypto.randomBytes(32).toString('hex');
db.version = 3;

function save() { store.save(db); }
function backup() {
  const today = P.dateKey(new Date());
  if (db.meta.backupDate === today) return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    store.backupTo(path.join(BACKUP_DIR, 'data-' + today + '.db'));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^data-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 14))) fs.unlinkSync(path.join(BACKUP_DIR, f));
    db.meta.backupDate = today;
    save();
  } catch (e) { log('error', 'backup failed', { error: e.message }); }
}
save();

const wa = createWhatsApp({ env, getMeta: () => db.meta, log });
const ai = createAI({ env, log });

/* ------------------------------------------------------------------ auth */
// One account, set in .env. Passkeys (Face ID etc.) are added after the first password login.
const USERNAME = env('APP_USERNAME').toLowerCase();
const PW_SALT = crypto.randomBytes(16);
const PW_HASH = env('APP_PASSWORD') ? crypto.scryptSync(env('APP_PASSWORD'), PW_SALT, 32) : null;
const authEnabled = () => !!(USERNAME && PW_HASH);
// Changing the username or password signs every device out.
const ACCOUNT_TAG = crypto.createHash('sha256').update(USERNAME + '\n' + env('APP_PASSWORD')).digest('base64url');
const secret = () => env('SESSION_SECRET') || db.meta.secret;
const sign = v => crypto.createHmac('sha256', secret()).update(v + ':' + ACCOUNT_TAG).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function passwordMatches(username, password) {
  const tryHash = crypto.scryptSync(String(password || ''), PW_SALT, 32); // always run, so timing does not reveal the username
  return safeEq(String(username || '').trim().toLowerCase(), USERNAME) && crypto.timingSafeEqual(tryHash, PW_HASH);
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authed(req) {
  if (!authEnabled()) return true;
  const c = cookies(req).um_session || '';
  const [exp, sig] = c.split('.');
  return !!exp && !!sig && Number(exp) > Date.now() && safeEq(sig, sign(exp));
}
function isHttps(req) {
  return env('COOKIE_SECURE') === '1' || req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}
function sessionCookie(req, clear) {
  const days = 90;
  const exp = String(Date.now() + days * 864e5);
  const base = ['Path=/', 'HttpOnly', 'SameSite=Lax'].concat(isHttps(req) ? ['Secure'] : []);
  return clear ? ['um_session=', 'Max-Age=0'].concat(base).join('; ')
    : ['um_session=' + exp + '.' + sign(exp), 'Max-Age=' + days * 86400].concat(base).join('; ');
}
const clientIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

// Passkeys are tied to the site's address. APP_ORIGIN pins it (recommended in production); otherwise it comes from the request.
function relyingParty(req) {
  let origin = env('APP_ORIGIN').replace(/\/+$/, '');
  if (!origin) {
    const host = (TRUST_PROXY && String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()) || req.headers.host || 'localhost';
    origin = (isHttps(req) ? 'https' : 'http') + '://' + host;
  }
  return { origin, rpId: new URL(origin).hostname };
}
const challenges = new Map(); // challenge -> { kind, expires }
function issueChallenge(kind) {
  const now = Date.now();
  if (challenges.size > 500) for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  if (challenges.size > 500) throw new HttpError(429, 'Too many sign-in attempts. Try again in a minute.');
  const c = webauthn.newChallenge();
  challenges.set(c, { kind, expires: now + 5 * 60 * 1000 });
  return c;
}
// Challenges are single-use: taken out whether the check passes or not.
function takeChallenge(clientDataJSON, kind) {
  let c = '';
  try { c = JSON.parse(Buffer.from(String(clientDataJSON || ''), 'base64url').toString('utf8')).challenge || ''; } catch (_) { /* checked below */ }
  const v = challenges.get(c);
  challenges.delete(c);
  if (!v || v.kind !== kind || v.expires < Date.now()) throw new HttpError(400, 'The sign-in request expired. Try again.');
  return c;
}
function deviceName(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? os + ' · ' + br : os;
}
if (env('NODE_ENV') === 'production' && !authEnabled()) {
  log('error', 'refusing to start: set APP_USERNAME and APP_PASSWORD in .env so the app is not open to everyone');
  process.exit(1);
}
const passkeyList = () => db.passkeys.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsed: k.lastUsed || null }));
const loginFails = new Map();

/* ------------------------------------------------------------------ http helpers */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};
function send(res, status, body, headers) {
  const isBuf = Buffer.isBuffer(body), isStr = typeof body === 'string';
  res.writeHead(status, Object.assign({
    'Content-Type': isBuf || isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, SECURITY_HEADERS, headers || {}));
  res.end(isBuf || isStr ? body : JSON.stringify(body));
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'That was too large.')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const b = await readBody(req, 200 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch (_) { throw new HttpError(400, 'The request was not valid JSON.'); }
}

function features() {
  return { ai: ai.enabled(), transcribe: ai.canTranscribe(), whatsapp: wa.configured(), auth: authEnabled(), passkeys: db.passkeys.length };
}
function state() {
  if (P.ops.materialize(db, new Date()).length) save();
  return {
    tasks: db.tasks, routines: db.routines, energy: db.energy, settings: db.settings, features: features(),
    whatsapp: { to: env('WA_TO') ? '•••' + digits(env('WA_TO')).slice(-4) : null, inWindow: wa.inWindow() }
  };
}

/* ------------------------------------------------------------------ brain dump */
async function understand(text, viewDate) {
  const now = new Date();
  if (ai.enabled()) {
    try {
      const items = await ai.parseTasks(text, now, db.settings, viewDate);
      if (items.length) return { items, source: 'ai' };
    } catch (e) { log('warn', 'AI parse failed, using rules', { error: e.message }); }
  }
  let items = P.parse(text, now, db.settings);
  const today = P.dateKey(now);
  if (viewDate && P.isDateKey(viewDate) && viewDate !== today) items = items.map(i => (i.date === today ? Object.assign(i, { date: viewDate }) : i));
  return { items: items.map(i => P.sanitizeItem(i, now, db.settings)).filter(Boolean), source: 'rules' };
}

/* ------------------------------------------------------------------ WhatsApp: replies */
function focusTask(now) {
  const today = P.dateKey(now), m = P.minutesNow(now);
  const list = P.dayList(db.tasks, today);
  const started = list.filter(t => t.start <= m + 5);
  return started[started.length - 1] || list[0] || null;
}
function nextLine(now) {
  const m = P.minutesNow(now);
  const next = P.dayList(db.tasks, P.dateKey(now)).find(t => t.start >= m - 5);
  return next ? 'Next: ' + next.title + ' at ' + P.fmt(next.start) + '.' : 'Nothing else planned today.';
}
const dayName = d => (d ? P.dateKey(new Date()) === d ? '' : new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' : '');

async function doAction(action, id) {
  const now = new Date();
  const t = (id && db.tasks.find(x => x.id === id && !x.done)) || (!id ? focusTask(now) : null);
  if (action === 'energy:low' || action === 'energy:ok' || action === 'energy:high') {
    const r = P.ops.energy(db, P.dateKey(now), action.split(':')[1], now); save();
    return { text: r.message + '\n' + nextLine(now) };
  }
  if (action === 'today' || action === 'help') return handleInbound(action);
  if (action === 'rescue') {
    const r = P.ops.rescue(db, P.dateKey(now), now, { keep: 3 }); save();
    return { text: r.moved.length
      ? 'Breathe. I\'ve kept 3 things and anything with a set time, and moved ' + r.moved.length + ' to tomorrow.\n' + nextLine(now)
      : 'Your day is already light. Just do the next thing.\n' + nextLine(now) };
  }
  if (!t) return { text: id ? 'That one is already done or gone.' : 'Nothing open right now. Text me anything to add it.' };
  if (action === 'done') { P.ops.action(db, t.id, 'done', now); save(); return { text: 'Nice one. "' + t.title + '" is done.\n' + nextLine(now) }; }
  if (action === 'snooze') {
    P.ops.action(db, t.id, 'snooze', now); save();
    const u = db.tasks.find(x => x.id === t.id);
    return { text: u && u.date === P.dateKey(now) ? 'Moved "' + t.title + '" to ' + P.fmt(u.start) + '.' : 'No room left today, so "' + t.title + '" is on tomorrow.' };
  }
  if (action === 'tomorrow') { P.ops.action(db, t.id, 'tomorrow', now); save(); return { text: '"' + t.title + '" moved to tomorrow. That\'s allowed.\n' + nextLine(now) }; }
  if (action === 'stuck') {
    if (!ai.enabled()) return { text: 'Try the smallest possible start: open the thing you need for "' + t.title + '" and do 2 minutes.' };
    try {
      const steps = await ai.breakdown(t);
      const cur = db.tasks.find(x => x.id === t.id);
      if (cur) { P.ops.setSteps(db, cur.id, steps.map(text => ({ text }))); save(); }
      return { text: 'Let\'s make "' + t.title + '" smaller:\n' + steps.map((s, i) => (i + 1) + '. ' + s).join('\n') + '\n\nJust do step 1.' };
    } catch (e) { log('warn', 'breakdown failed', { error: e.message }); return { text: 'Couldn\'t break that down just now. Start with 2 minutes on it.' }; }
  }
  return { text: 'Sorry, I didn\'t get that.' };
}

const COMMANDS = [
  [/^(done|did it|finished|yes|yep|y|complete|completed|ticked)$/, 'done'],
  [/^(snooze|later|not yet|15|\+15|plus 15|15 more)$/, 'snooze'],
  [/^(skip|tomorrow|not today|move it)$/, 'tomorrow'],
  [/^(low|low energy|tired|knackered|exhausted)$/, 'energy:low'],
  [/^(ok energy|normal|medium)$/, 'energy:ok'],
  [/^(high|high energy|buzzing)$/, 'energy:high'],
  [/^(too much|overwhelmed|im overwhelmed|i'm overwhelmed|help me|rescue|panic)$/, 'rescue'],
  [/^(stuck|im stuck|i'm stuck|break it down|steps)$/, 'stuck']
];
// Short acknowledgements must never become tasks. "ok"/"good" answer the energy question if it's still open.
const ACK = /^(ok|okay|k|fine|good|great|thanks|thank you|thx|ty|cheers|ta|nice|cool|lol|haha|sound|sounds good|no worries|np|got it|will do|on it)$/;

async function handleInbound(text) {
  const now = new Date();
  const cmd = text.toLowerCase().replace(/[^a-z0-9'+ ]/g, '').replace(/\s+/g, ' ').trim();
  for (const [re, action] of COMMANDS) if (re.test(cmd)) return doAction(action);
  if (ACK.test(cmd)) {
    if (!db.energy[P.dateKey(now)] && /^(ok|okay|fine)$/.test(cmd)) return doAction('energy:ok');
    if (!db.energy[P.dateKey(now)] && /^(good|great)$/.test(cmd)) return doAction('energy:high');
    return { text: '👍' };
  }
  if (/^(today|list|plan|next|whats next|what's next|whats on|what's on)$/.test(cmd)) {
    const list = P.dayList(db.tasks, P.dateKey(now));
    return { text: list.length ? P.digest(db, P.dateKey(now)).replace(/^Good morning\. /, '') : 'Your day is clear. Text me anything to add it.' };
  }
  if (/^(help|hi|hello|hey|start|commands|menu)$/.test(cmd)) {
    return { text: 'Hi, this is Uncluttered Mind. Text or voice-note me anything, e.g. "call the bank at 2, gym after work, buy milk".\n\n' +
      'DONE · SNOOZE · SKIP — for the current task\nTODAY — see your plan\nSTUCK — break the current task into tiny steps\nTOO MUCH — keep 3 things, move the rest\nLOW / OK / HIGH — your energy today' };
  }
  const { items } = await understand(text);
  if (!items.length) return { text: 'I couldn\'t find a task in that. Try "call mum at 3".' };
  const r = P.ops.addItems(db, items, now); save();
  const lines = r.added.filter(t => !t.routineId).map(t => '• ' + t.title + ' — ' + (t.someday ? 'someday list' : t.start != null ? dayName(t.date) + P.fmt(t.start) : 'no room that day'));
  r.routines.forEach(x => lines.push('• ' + x.title + ' — ' + P.daysLabel(x.days) + (x.start != null ? ' ' + P.fmt(x.start) : '')));
  return { text: 'Added:\n' + lines.join('\n') };
}

async function processMessage(msg) {
  if (db.meta.seen.includes(msg.id)) return;
  db.meta.seen = db.meta.seen.concat(msg.id).slice(-200);
  if (digits(msg.from) !== digits(env('WA_TO'))) { log('warn', 'ignored WhatsApp message from an unknown number'); save(); return; }
  db.meta.lastInbound = Date.now(); save();

  let reply;
  try {
    if (msg.type === 'button' && msg.button) {
      const [action, id] = String(msg.button.payload || msg.button.text || '').split(':');
      reply = await doAction(action === 'energy' ? 'energy:' + id : action.toLowerCase(), action === 'energy' ? null : id || null);
    } else if (msg.type === 'interactive' && msg.interactive && msg.interactive.button_reply) {
      const [action, id] = String(msg.interactive.button_reply.id || '').split(':');
      reply = await doAction(action === 'energy' ? 'energy:' + id : action, action === 'energy' ? null : id || null);
    } else if (msg.type === 'audio' && msg.audio && msg.audio.id) {
      if (!ai.canTranscribe()) reply = { text: 'I can\'t listen to voice notes yet. Type it here, or use the mic in the app.' };
      else {
        const media = await wa.downloadMedia(msg.audio.id);
        const heard = await ai.transcribe(media.buffer, media.mime);
        if (!heard) reply = { text: 'I couldn\'t make out any words in that voice note. Try again?' };
        else { const r = await handleInbound(heard); reply = { text: 'I heard: "' + heard.slice(0, 300) + '"\n\n' + r.text, buttons: r.buttons }; }
      }
    } else if (msg.type === 'text' && msg.text && msg.text.body && msg.text.body.trim()) {
      reply = await handleInbound(msg.text.body.trim().slice(0, 5000));
    } else {
      reply = { text: 'I can read text, voice notes and button taps. Text HELP to see what I can do.' };
    }
  } catch (e) {
    log('error', 'handling WhatsApp message failed', { error: e.message });
    reply = { text: 'Something went wrong on my side. Try again in a minute, or use the app.' };
  }
  if (reply) await wa.send(reply.text, { reply: true, buttons: reply.buttons });
}

/* ------------------------------------------------------------------ reminders loop */
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const made = P.ops.materialize(db, now);
    backup();
    if (!wa.configured()) { if (made.length) save(); return; }
    const { messages, changed } = reminders.due(db, now);
    if (changed || made.length) save();
    const quiet = reminders.isQuiet(P.minutesNow(now), db.settings);
    for (const m of messages) {
      if (quiet && !m.urgent) { log('info', 'skipped message in quiet hours', { kind: m.kind }); continue; }
      await wa.send(m.text, { buttons: m.buttons, hint: m.hint, kind: m.kind });
    }
  } catch (e) { log('error', 'tick failed', { error: e.message }); }
  finally { ticking = false; }
}

/* ------------------------------------------------------------------ routes */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

async function api(req, res, p) {
  const method = req.method;
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating && req.headers['x-um'] !== '1') throw new HttpError(403, 'Missing request header.');

  if (p === '/api/login' && method === 'POST') {
    if (!authEnabled()) return send(res, 200, { ok: true });
    const ip = clientIp(req);
    if (loginFails.size > 1000) for (const [k, v] of loginFails) if (v.until < Date.now()) loginFails.delete(k);
    const f = loginFails.get(ip);
    if (f && f.count >= 5 && f.until > Date.now()) throw new HttpError(429, 'Too many wrong attempts. Try again in 15 minutes.');
    const { username, password } = await readJSON(req);
    if (!passwordMatches(username, password)) {
      const n = f && f.until > Date.now() ? f.count + 1 : 1;
      loginFails.set(ip, { count: n, until: Date.now() + 15 * 60 * 1000 });
      log('warn', 'wrong username or password', { ip });
      throw new HttpError(401, 'That username or password didn\'t match.');
    }
    loginFails.delete(ip);
    log('info', 'signed in with password', { ip });
    return send(res, 200, { ok: true, passkeys: db.passkeys.length }, { 'Set-Cookie': sessionCookie(req) });
  }
  if (p === '/api/logout' && method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, true) });

  if (p === '/api/passkey/login/options' && method === 'POST') {
    if (!authEnabled()) throw new HttpError(400, 'Sign-in is not set up on this server.');
    return send(res, 200, { challenge: issueChallenge('login'), rpId: relyingParty(req).rpId, timeout: 60000, userVerification: 'required' });
  }
  if (p === '/api/passkey/login/verify' && method === 'POST') {
    if (!authEnabled()) throw new HttpError(400, 'Sign-in is not set up on this server.');
    const ip = clientIp(req);
    const f = loginFails.get(ip);
    if (f && f.count >= 5 && f.until > Date.now()) throw new HttpError(429, 'Too many wrong attempts. Try again in 15 minutes.');
    const body = await readJSON(req);
    const challenge = takeChallenge(body.clientDataJSON, 'login');
    const cred = db.passkeys.find(k => k.id === body.id);
    if (!cred) throw new HttpError(401, 'This passkey isn\'t registered here any more. Sign in with your password.');
    if (body.userHandle && body.userHandle !== db.meta.userId) throw new HttpError(401, 'This passkey belongs to a different account.');
    try { cred.signCount = webauthn.verifyAuthentication(body, cred, Object.assign({ challenge }, relyingParty(req))); }
    catch (e) {
      if (!(e instanceof webauthn.WebAuthnError)) throw e;
      log('warn', 'passkey sign-in failed', { ip, error: e.message });
      throw new HttpError(401, e.message);
    }
    cred.lastUsed = Date.now(); save();
    log('info', 'signed in with passkey', { ip, passkey: cred.name });
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req) });
  }

  if (!authed(req)) return send(res, 401, { error: 'Login needed', features: { auth: true } });

  if (p === '/api/passkeys' && method === 'GET') return send(res, 200, { passkeys: passkeyList() });
  if (p === '/api/passkey/register/options' && method === 'POST') {
    if (!authEnabled()) throw new HttpError(400, 'Set APP_USERNAME and APP_PASSWORD on the server first.');
    if (db.passkeys.length >= 20) throw new HttpError(400, 'That\'s a lot of passkeys. Remove one first.');
    return send(res, 200, {
      challenge: issueChallenge('register'),
      rp: { name: 'Uncluttered Mind', id: relyingParty(req).rpId },
      user: { id: db.meta.userId, name: USERNAME, displayName: USERNAME },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: db.passkeys.map(k => ({ type: 'public-key', id: k.id, transports: k.transports || undefined })),
      attestation: 'none', timeout: 60000
    });
  }
  if (p === '/api/passkey/register/verify' && method === 'POST') {
    const body = await readJSON(req);
    const challenge = takeChallenge(body.clientDataJSON, 'register');
    let cred;
    try { cred = webauthn.verifyRegistration(body, Object.assign({ challenge }, relyingParty(req))); }
    catch (e) { if (e instanceof webauthn.WebAuthnError) throw new HttpError(400, e.message); throw e; }
    if (db.passkeys.some(k => k.id === cred.id)) throw new HttpError(400, 'This passkey is already set up.');
    const transports = Array.isArray(body.transports) ? body.transports.filter(t => typeof t === 'string' && t.length < 20).slice(0, 6) : [];
    db.passkeys.push(Object.assign(cred, { name: deviceName(req), transports, createdAt: Date.now(), lastUsed: null }));
    save();
    log('info', 'passkey added', { passkey: deviceName(req) });
    return send(res, 200, { ok: true, passkeys: passkeyList() });
  }
  {
    const pk = p.match(/^\/api\/passkeys\/([A-Za-z0-9_-]{1,1400})$/);
    if (pk && method === 'DELETE') {
      db.passkeys = db.passkeys.filter(k => k.id !== pk[1]); save();
      return send(res, 200, { ok: true, passkeys: passkeyList() });
    }
  }

  const now = new Date();
  if (p === '/api/state' && method === 'GET') return send(res, 200, state());

  if (p === '/api/parse' && method === 'POST') {
    const { text, date } = await readJSON(req);
    if (!text || !String(text).trim()) throw new HttpError(400, 'Say or type something first.');
    return send(res, 200, await understand(String(text).slice(0, 5000), P.isDateKey(date) ? date : null));
  }
  if (p === '/api/items' && method === 'POST') {
    const { items } = await readJSON(req);
    if (!Array.isArray(items)) throw new HttpError(400, 'items must be a list.');
    const r = P.ops.addItems(db, items.slice(0, 50), now); save();
    return send(res, 200, Object.assign(state(), { added: r.added, routinesAdded: r.routines }));
  }
  let m;
  if ((m = p.match(/^\/api\/tasks\/([\w-]{1,64})\/(done|undo|snooze|tomorrow|place|today|startnow|someday|delete)$/)) && method === 'POST') {
    const r = P.ops.action(db, m[1], m[2], now);
    if (!r.ok) throw new HttpError(404, r.error);
    save();
    return send(res, 200, Object.assign(state(), { task: r.task }));
  }
  if ((m = p.match(/^\/api\/tasks\/([\w-]{1,64})\/steps$/)) && method === 'PUT') {
    const { steps } = await readJSON(req);
    const r = P.ops.setSteps(db, m[1], steps);
    if (!r.ok) throw new HttpError(404, r.error);
    save();
    return send(res, 200, Object.assign(state(), { autoDone: r.autoDone }));
  }
  if ((m = p.match(/^\/api\/tasks\/([\w-]{1,64})\/breakdown$/)) && method === 'POST') {
    if (!ai.enabled()) throw new HttpError(501, 'Breaking tasks down needs an AI key on the server.');
    const t = db.tasks.find(x => x.id === m[1]);
    if (!t) throw new HttpError(404, 'That task no longer exists.');
    let steps;
    try { steps = await ai.breakdown(t); }
    catch (e) { log('warn', 'breakdown failed', { error: e.message }); throw new HttpError(502, 'Couldn\'t break that down just now. Try again in a moment.'); }
    const r = P.ops.setSteps(db, m[1], steps.map(text => ({ text })));
    if (!r.ok) throw new HttpError(404, r.error);
    save();
    return send(res, 200, state());
  }
  if (p === '/api/rescue' && method === 'POST') {
    const { date } = await readJSON(req);
    const r = P.ops.rescue(db, P.isDateKey(date) ? date : P.dateKey(now), now, { keep: 3 }); save();
    return send(res, 200, Object.assign(state(), { moved: r.moved }));
  }
  if (p === '/api/rescue/undo' && method === 'POST') {
    const { ids } = await readJSON(req);
    const r = P.ops.unrescue(db, Array.isArray(ids) ? ids.slice(0, 200) : [], now); save();
    return send(res, 200, Object.assign(state(), r));
  }
  if (p === '/api/energy' && method === 'POST') {
    const { date, level } = await readJSON(req);
    const r = P.ops.energy(db, date, level, now);
    if (!r.ok) throw new HttpError(400, r.error);
    save();
    return send(res, 200, Object.assign(state(), { moved: r.moved, message: r.message }));
  }
  if ((m = p.match(/^\/api\/routines\/([\w-]{1,64})$/)) && method === 'DELETE') {
    const r = P.ops.deleteRoutine(db, m[1], now);
    if (!r.ok) throw new HttpError(404, 'That repeat no longer exists.');
    save();
    return send(res, 200, state());
  }
  if (p === '/api/settings' && method === 'PUT') {
    db.settings = P.sanitizeSettings(await readJSON(req), db.settings); save();
    return send(res, 200, state());
  }
  if (p === '/api/whatsapp/test' && method === 'POST') {
    if (!wa.configured()) throw new HttpError(400, 'WhatsApp isn\'t set up on the server yet.');
    const r = await wa.send('Uncluttered Mind is connected. Reminders will come here. Text HELP to see what I can do.',
      { buttons: [{ id: 'today:', title: 'Show my plan' }], kind: 'test' });
    if (!r.ok) throw new HttpError(502, r.error || 'WhatsApp refused the message.');
    return send(res, 200, r);
  }
  if (p === '/api/transcribe' && method === 'POST') {
    if (!ai.canTranscribe()) throw new HttpError(501, 'Voice recording needs an OpenAI key on the server.');
    const buf = await readBody(req, 10 * 1024 * 1024);
    if (buf.length < 500) throw new HttpError(400, 'That recording was empty.');
    try { return send(res, 200, { text: await ai.transcribe(buf, req.headers['content-type']) }); }
    catch (e) { log('warn', 'transcribe failed', { error: e.message }); throw new HttpError(502, 'Couldn\'t turn that into text. Try again or type it.'); }
  }
  throw new HttpError(404, 'Not found.');
}

async function webhook(req, res, url) {
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && env('WA_VERIFY_TOKEN') &&
      url.searchParams.get('hub.verify_token') === env('WA_VERIFY_TOKEN');
    return send(res, ok ? 200 : 403, ok ? url.searchParams.get('hub.challenge') || '' : 'forbidden');
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const raw = await readBody(req, 1024 * 1024);
  if (env('WA_APP_SECRET')) {
    const want = 'sha256=' + crypto.createHmac('sha256', env('WA_APP_SECRET')).update(raw).digest('hex');
    if (!safeEq(String(req.headers['x-hub-signature-256'] || ''), want)) { log('warn', 'webhook signature mismatch'); return send(res, 401, 'bad signature'); }
  }
  send(res, 200, 'ok'); // answer Meta straight away, then work
  let body; try { body = JSON.parse(raw.toString('utf8')); } catch (_) { return; }
  const values = (body.entry || []).flatMap(e => e.changes || []).map(c => c.value || {});
  for (const v of values) {
    for (const st of v.statuses || []) {
      if (st.status === 'failed') log('error', 'WhatsApp could not deliver a message', { errors: JSON.stringify(st.errors || []) });
    }
    for (const msg of v.messages || []) await processMessage(msg);
  }
}

function serveStatic(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  let rel;
  try { rel = decodeURIComponent(p === '/' ? '/index.html' : p); } catch (_) { throw new HttpError(400, 'Bad path.'); }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found.');
  const ext = path.extname(file);
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=300';
  res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache }, SECURITY_HEADERS));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { return send(res, 400, 'Bad request'); }
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true, uptime: Math.round(process.uptime()), features: features() });
    if (p === '/webhook') return await webhook(req, res, url);
    if (p.startsWith('/api/')) return await api(req, res, p);
    return serveStatic(req, res, p);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) log('error', 'request failed', { path: p, error: e.message, stack: IS_TEST ? undefined : e.stack });
    if (!res.headersSent) send(res, status, { error: status >= 500 && !e.status ? 'Something broke on the server. Check the logs.' : e.message });
  }
});
server.requestTimeout = 120000;
server.headersTimeout = 30000;

const timer = setInterval(() => { tick(); }, Number(env('TICK_MS')) || 30000);

server.listen(PORT, HOST, () => {
  log('info', 'Uncluttered Mind running', { url: 'http://localhost:' + PORT, timezone: process.env.TZ, database: DB_FILE, features: JSON.stringify(features()) });
  if (!wa.configured()) log('warn', 'WhatsApp not set up yet: fill in WA_TOKEN, WA_PHONE_NUMBER_ID and WA_TO');
  else {
    if (!env('WA_APP_SECRET')) log('warn', 'WA_APP_SECRET is empty: anyone who finds /webhook could fake messages. Set it in production.');
    if (!env('WA_TEMPLATE_NAME')) log('warn', 'WA_TEMPLATE_NAME is empty: reminders will fail when you have not messaged the business number for 24h.');
  }
  if (!authEnabled()) log('warn', 'APP_USERNAME / APP_PASSWORD are empty: anyone with the link can open the planner. Set them before going online.');
  else if (env('APP_PASSWORD').length < 10) log('warn', 'APP_PASSWORD is shorter than 10 characters. Use a longer one.');
  if (env('APP_PIN')) log('warn', 'APP_PIN is no longer used. Sign-in now uses APP_USERNAME and APP_PASSWORD (plus passkeys).');
  tick();
});

function shutdown(sig) {
  log('info', 'shutting down', { signal: sig });
  clearInterval(timer);
  try { save(); } catch (_) { /* best effort */ }
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => log('error', 'unhandled rejection', { error: e && e.message }));
