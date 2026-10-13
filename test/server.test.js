'use strict';
/*
 * End-to-end: starts the real server against a fake WhatsApp Graph API and fake AI APIs,
 * then drives it like the browser and like Meta's webhook would.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createAuthenticator } = require('./fake-authenticator.js');

const ROOT = path.join(__dirname, '..');
const WA_TO = '447700900123';
const APP_SECRET = 'test-app-secret';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const todayKey = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const tomorrowKey = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

/* ---------------- fake Meta + Anthropic + OpenAI ---------------- */
const sent = [];
let mockBase;
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v21.0/PHONE123/messages' && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer wa-token') return json(401, { error: { message: 'bad token' } });
      sent.push(JSON.parse(raw.toString()));
      return json(200, { messages: [{ id: 'wamid.' + sent.length }] });
    }
    if (req.url === '/v21.0/MEDIA1' && req.method === 'GET') return json(200, { url: mockBase + '/files/MEDIA1', mime_type: 'audio/ogg; codecs=opus', file_size: 2000 });
    if (req.url === '/files/MEDIA1') { res.writeHead(200, { 'Content-Type': 'audio/ogg' }); return res.end(Buffer.alloc(2000, 1)); }
    if (req.url === '/v1/messages' && req.method === 'POST') {
      const body = JSON.parse(raw.toString());
      const user = body.messages[0].content;
      if (/FAILAI/.test(user)) return json(500, { error: { message: 'boom' } });
      if (/Break the task/.test(body.system)) return json(200, { content: [{ type: 'text', text: '{"steps":["Open the laptop","Find the P60","Fill in box 1"]}' }] });
      const tasks = /every monday/i.test(user)
        ? [{ title: 'Water the plants', time: '09:00', minutes: 10, repeat: [1] }]
        : [{ title: 'AI: ' + user.slice(0, 40), date: null, time: null, minutes: 20, before: '23:59' }];
      return json(200, { content: [{ type: 'text', text: 'Sure! ' + JSON.stringify({ tasks }) }] });
    }
    if (req.url === '/v1/audio/transcriptions' && req.method === 'POST') {
      if (!raw.toString('latin1').includes('whisper-1')) return json(400, { error: { message: 'no model' } });
      return json(200, { text: 'phone the vet' });
    }
    json(404, { error: { message: 'mock: unknown ' + req.method + ' ' + req.url } });
  });
});

/* ---------------- server process ---------------- */
let proc, base, dataDir, cookie = '';
const freePort = () => new Promise(r => { const s = http.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

async function startServer() {
  const port = await freePort();
  base = 'http://127.0.0.1:' + port;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, TZ: 'Europe/London', TICK_MS: '3600000',
      APP_USERNAME: 'Rohit', APP_PASSWORD: 'correct horse battery', WA_TOKEN: 'wa-token', WA_PHONE_NUMBER_ID: 'PHONE123', WA_TO: '+44 7700 900123', WA_VERIFY_TOKEN: 'verify-me',
      WA_APP_SECRET: APP_SECRET, WA_API_BASE: mockBase, WA_TEMPLATE_NAME: 'unclutteredmind_reminder',
      ANTHROPIC_API_KEY: 'a-key', ANTHROPIC_BASE_URL: mockBase, OPENAI_API_KEY: 'o-key', OPENAI_BASE_URL: mockBase,
      // Set (even empty) so a production .env in the project folder can't leak into the tests.
      APP_ORIGIN: '', TRUST_PROXY: '0', COOKIE_SECURE: '0', SESSION_SECRET: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) return; } catch (_) { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
function stopServer() { return new Promise(r => { if (!proc || proc.exitCode !== null) return r(); proc.once('exit', r); proc.kill('SIGTERM'); }); }

async function call(method, p, body, extraHeaders) {
  const headers = Object.assign({ 'x-um': '1' }, cookie ? { Cookie: cookie } : {}, body !== undefined ? { 'Content-Type': 'application/json' } : {}, extraHeaders || {});
  const r = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
}
function webhook(payload, secret) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret || APP_SECRET).update(raw).digest('hex');
  return fetch(base + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
}
let msgN = 0;
const inbound = (message, from) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [Object.assign({ from: from || WA_TO, id: 'wamid.in' + (++msgN), timestamp: '1' }, message)] } }] }] });
async function waitForSent(n, ms) { for (let i = 0; i < (ms || 3000) / 50; i++) { if (sent.length >= n) return; await sleep(50); } throw new Error('expected ' + n + ' WhatsApp messages, got ' + sent.length); }
const lastText = () => { const m = sent[sent.length - 1]; return m.type === 'text' ? m.text.body : m.type === 'interactive' ? m.interactive.body.text : JSON.stringify(m.template); };

test.before(async () => {
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  mockBase = 'http://127.0.0.1:' + mock.address().port;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-test-'));
  await startServer();
});
test.after(async () => { await stopServer(); mock.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

/* ---------------- tests ---------------- */
test('health check and static app with security headers', async () => {
  const h = await call('GET', '/healthz');
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.features, { ai: true, transcribe: true, whatsapp: true, auth: true, passkeys: 0 });
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(await page.text(), /<title>Uncluttered Mind<\/title>/);
  for (const f of ['/app.js', '/app.css', '/shared.js', '/manifest.webmanifest', '/icon.svg']) assert.equal((await fetch(base + f)).status, 200, f);
  assert.equal((await fetch(base + '/..%2fserver.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404);
  assert.equal((await fetch(base + '/nope.js')).status, 404);
});

test('login protects the API', async () => {
  assert.equal((await call('GET', '/api/state')).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'rohit', password: 'correct horse battery' }, { 'x-um': '' })).status, 403, 'missing CSRF header');
  assert.equal((await call('POST', '/api/login', { username: 'rohit', password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'someone', password: 'correct horse battery' })).status, 401);
  const ok = await call('POST', '/api/login', { username: ' Rohit ', password: 'correct horse battery' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.passkeys, 0, 'tells the app to offer Face ID setup');
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const st = await call('GET', '/api/state');
  assert.equal(st.status, 200);
  assert.ok(Array.isArray(st.body.tasks));
  assert.equal(st.body.whatsapp.to, '•••0123');
});

test('outside the 24h window, WhatsApp falls back to the approved template', async () => {
  const n = sent.length;
  const r = await call('POST', '/api/whatsapp/test', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'template');
  await waitForSent(n + 1);
  const m = sent[sent.length - 1];
  assert.equal(m.type, 'template');
  assert.equal(m.template.name, 'unclutteredmind_reminder');
  assert.doesNotMatch(m.template.components[0].parameters[0].text, /\n/, 'template text must be one line');
});

test('brain dump: AI understanding, with rules as the fallback', async () => {
  const ai = await call('POST', '/api/parse', { text: 'ring the dentist', date: todayKey() });
  assert.equal(ai.status, 200);
  assert.equal(ai.body.source, 'ai');
  assert.equal(ai.body.items[0].title, 'AI: ring the dentist');
  const rules = await call('POST', '/api/parse', { text: 'FAILAI call mum at 3' });
  assert.equal(rules.body.source, 'rules');
  assert.equal(rules.body.items[0].start, 15 * 60);
  const rep = await call('POST', '/api/parse', { text: 'water plants every monday at 9' });
  assert.deepEqual(rep.body.items[0].repeat, { days: [1] });
  assert.equal((await call('POST', '/api/parse', { text: '   ' })).status, 400);
});

let taskId;
test('adding tasks, repeats and acting on them', async () => {
  const add = await call('POST', '/api/items', { items: [
    { title: 'Write essay', date: tomorrowKey(), start: 600, duration: 60 },
    { title: 'Water the plants', start: 540, duration: 10, repeat: { days: [0, 1, 2, 3, 4, 5, 6] } },
    { title: 'x' }, { nonsense: true }
  ] });
  assert.equal(add.status, 200);
  assert.equal(add.body.routinesAdded.length, 1);
  assert.equal(add.body.routines.length, 1);
  const essay = add.body.tasks.find(t => t.title === 'Write essay');
  taskId = essay.id;
  assert.equal(essay.start, 600);
  const snoozed = await call('POST', '/api/tasks/' + taskId + '/snooze', {});
  assert.equal(snoozed.body.tasks.find(t => t.id === taskId).start, 615);
  assert.equal((await call('POST', '/api/tasks/nope/done', {})).status, 404);
  assert.equal((await call('POST', '/api/tasks/' + taskId + '/explode', {})).status, 404);
  assert.equal((await call('POST', '/api/items', { items: 'nope' })).status, 400);
  const bad = await fetch(base + '/api/items', { method: 'POST', headers: { 'x-um': '1', Cookie: cookie, 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
});

test('steps: AI breakdown, manual edit, auto-complete', async () => {
  const b = await call('POST', '/api/tasks/' + taskId + '/breakdown', {});
  assert.equal(b.status, 200);
  const t = b.body.tasks.find(x => x.id === taskId);
  assert.deepEqual(t.steps.map(s => s.text), ['Open the laptop', 'Find the P60', 'Fill in box 1']);
  const all = await call('PUT', '/api/tasks/' + taskId + '/steps', { steps: t.steps.map(s => Object.assign({}, s, { done: true })) });
  assert.equal(all.body.autoDone, true);
  assert.equal(all.body.tasks.find(x => x.id === taskId).done, true);
  await call('POST', '/api/tasks/' + taskId + '/undo', {});
});

test('too much: rescue and undo', async () => {
  const d = tomorrowKey();
  await call('POST', '/api/items', { items: ['One', 'Two', 'Three', 'Four', 'Five'].map(n => ({ title: 'Job ' + n, date: d })) });
  const r = await call('POST', '/api/rescue', { date: d });
  assert.equal(r.status, 200);
  assert.ok(r.body.moved.length >= 2);
  const u = await call('POST', '/api/rescue/undo', { ids: r.body.moved });
  assert.equal(u.body.restored, r.body.moved.length);
});

test('energy, settings and repeats management', async () => {
  assert.equal((await call('POST', '/api/energy', { date: todayKey(), level: 'wild' })).status, 400);
  const e = await call('POST', '/api/energy', { date: todayKey(), level: 'ok' });
  assert.equal(e.body.energy[todayKey()], 'ok');
  const s = await call('PUT', '/api/settings', { buffer: 15, dayStart: 900, dayEnd: 600, lead: 'abc' });
  assert.equal(s.body.settings.buffer, 15);
  assert.equal(s.body.settings.dayStart, 480);
  const st = await call('GET', '/api/state');
  const rid = st.body.routines[0].id;
  const del = await call('DELETE', '/api/routines/' + rid, {});
  assert.equal(del.body.routines.length, 0);
  assert.equal((await call('DELETE', '/api/routines/' + rid, {})).status, 404);
});

test('WhatsApp webhook: verification and signatures', async () => {
  const ok = await fetch(base + '/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123');
  assert.equal(await ok.text(), 'abc123');
  assert.equal((await fetch(base + '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x')).status, 403);
  const before = sent.length;
  assert.equal((await webhook(inbound({ type: 'text', text: { body: 'hello' } }), 'wrong-secret')).status, 401);
  assert.equal((await webhook(inbound({ type: 'text', text: { body: 'hello' } }, '447000000000'))).status, 200);
  await sleep(300);
  assert.equal(sent.length, before, 'strangers and forged calls get no reply');
});

test('WhatsApp: text adds tasks, buttons act, voice notes are transcribed, duplicates ignored', async () => {
  let n = sent.length;
  await webhook(inbound({ type: 'text', text: { body: 'help' } }));
  await waitForSent(++n);
  assert.match(lastText(), /DONE · SNOOZE · SKIP/);
  assert.equal(sent[sent.length - 1].to, WA_TO);

  const msg = inbound({ type: 'text', text: { body: 'buy dog food' } });
  await webhook(msg);
  await waitForSent(++n);
  assert.match(lastText(), /Added:\n• AI: buy dog food/);
  await webhook(msg); // Meta retries happen; must not double-add
  await sleep(300);
  assert.equal(sent.length, n);
  let st = await call('GET', '/api/state');
  const food = st.body.tasks.filter(t => t.title === 'AI: buy dog food');
  assert.equal(food.length, 1);

  await webhook(inbound({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'done:' + food[0].id, title: 'Done' } } }));
  await waitForSent(++n);
  assert.match(lastText(), /is done/);
  st = await call('GET', '/api/state');
  assert.equal(st.body.tasks.find(t => t.id === food[0].id).done, true);

  await webhook(inbound({ type: 'button', button: { payload: 'done:' + food[0].id, text: 'Done' } }));
  await waitForSent(++n);
  assert.match(lastText(), /already done or gone/);

  await webhook(inbound({ type: 'audio', audio: { id: 'MEDIA1', mime_type: 'audio/ogg' } }));
  await waitForSent(++n);
  assert.match(lastText(), /I heard: "phone the vet"/);

  await webhook(inbound({ type: 'text', text: { body: 'LOW' } }));
  await waitForSent(++n);
  assert.match(lastText(), /Low energy day/);

  await webhook(inbound({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'energy:high', title: 'High energy' } } }));
  await waitForSent(++n);
  assert.match(lastText(), /Good energy/);

  const before = (await call('GET', '/api/state')).body.tasks.length;
  await webhook(inbound({ type: 'text', text: { body: 'Thanks!' } }));
  await waitForSent(++n);
  assert.equal(lastText(), '👍');
  assert.equal((await call('GET', '/api/state')).body.tasks.length, before, 'thanks is not a task');

  await webhook(inbound({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'today:', title: 'Show my plan' } } }));
  await waitForSent(++n);
  assert.doesNotMatch(lastText(), /Sorry/);

  await webhook(inbound({ type: 'sticker', sticker: { id: 'S1' } }));
  await waitForSent(++n);
  assert.match(lastText(), /text, voice notes and button taps/);
});

test('test message uses buttons inside the 24h window', async () => {
  const n = sent.length;
  const r = await call('POST', '/api/whatsapp/test', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'buttons');
  await waitForSent(n + 1);
  assert.equal(sent[sent.length - 1].type, 'interactive');
});

test('in-app recording is transcribed', async () => {
  const tiny = await fetch(base + '/api/transcribe', { method: 'POST', headers: { 'x-um': '1', Cookie: cookie, 'Content-Type': 'audio/webm' }, body: Buffer.alloc(10) });
  assert.equal(tiny.status, 400);
  const ok = await fetch(base + '/api/transcribe', { method: 'POST', headers: { 'x-um': '1', Cookie: cookie, 'Content-Type': 'audio/webm' }, body: Buffer.alloc(4000, 2) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).text, 'phone the vet');
});

test('passkeys: set up after login, then sign in with Face ID alone', async () => {
  const site = { origin: base, rpId: '127.0.0.1' };
  const fake = createAuthenticator('ec');
  assert.equal((await call('POST', '/api/passkey/register/verify', {})).status, 400, 'no challenge, no passkey');

  const opts = (await call('POST', '/api/passkey/register/options', {})).body;
  assert.equal(opts.rp.id, '127.0.0.1');
  assert.equal(opts.authenticatorSelection.userVerification, 'required');
  const reg = fake.register(Object.assign({ challenge: opts.challenge, userId: opts.user.id }, site));
  const added = await call('POST', '/api/passkey/register/verify', reg);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.passkeys.length, 1);
  assert.equal((await call('POST', '/api/passkey/register/verify', reg)).status, 400, 'challenge is single-use');

  await call('POST', '/api/logout', {});
  cookie = '';
  assert.equal((await call('GET', '/api/state')).status, 401);
  assert.equal((await call('POST', '/api/passkey/register/options', {})).status, 401, 'adding a passkey needs a login');

  const signIn = async extra => {
    const o = (await call('POST', '/api/passkey/login/options', {})).body;
    return call('POST', '/api/passkey/login/verify', fake.sign(Object.assign({ challenge: o.challenge }, site, extra)));
  };
  assert.equal((await signIn({ origin: 'https://evil.example' })).status, 401);
  assert.equal((await signIn({ tamper: true })).status, 401);
  assert.equal((await signIn({ flags: 0x01 })).status, 401, 'Face ID / fingerprint must have been checked');
  assert.equal(cookie, '', 'no session from failed attempts');
  const good = await signIn({});
  assert.equal(good.status, 200);
  assert.match(good.headers.get('set-cookie'), /um_session=/);
  assert.equal((await call('GET', '/api/state')).status, 200);

  const list = (await call('GET', '/api/passkeys')).body.passkeys;
  assert.equal(list.length, 1);
  assert.ok(list[0].lastUsed);
  assert.ok(!('jwk' in list[0]), 'public key material is not sent to the browser');
});

test('data survives a restart, and so does the login', async () => {
  const before = (await call('GET', '/api/state')).body.tasks.length;
  assert.ok(fs.existsSync(path.join(dataDir, 'unclutteredmind.db')));
  assert.ok(fs.existsSync(path.join(dataDir, 'backups')));
  await stopServer();
  await startServer();
  const after = await call('GET', '/api/state');
  assert.equal(after.status, 200, 'session cookie still valid');
  assert.equal(after.body.tasks.length, before);
  const keys = (await call('GET', '/api/passkeys')).body.passkeys;
  assert.equal(keys.length, 1, 'passkeys are saved in the database');
  assert.equal((await call('DELETE', '/api/passkeys/' + keys[0].id, {})).body.passkeys.length, 0);
  const out = await call('POST', '/api/logout', {});
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('five wrong passwords lock logins for a while', async () => {
  cookie = '';
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/login', { username: 'rohit', password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'rohit', password: 'correct horse battery' })).status, 429);
});
