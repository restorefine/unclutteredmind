/* Uncluttered Mind — browser app. Talks to the server when there is one; otherwise works on this device only. */
(function () {
  'use strict';
  const P = window.Planner;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toMin = v => P.fromHHMM(v) == null ? 0 : P.fromHHMM(v);
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const today = () => P.dateKey(new Date());

  const S = {
    mode: 'starting', tasks: [], routines: [], energy: {}, settings: P.sanitizeSettings({}),
    features: { ai: false, transcribe: false, whatsapp: false, auth: false }, wa: {},
    view: today(), preview: [], previewSource: '', open: null, busy: false
  };

  /* ================================================================ backends */

  class AuthError extends Error {}
  class OfflineError extends Error {}

  const remote = {
    async call(method, url, body, opts) {
      opts = opts || {};
      let r;
      try {
        r = await fetch(url, {
          method, credentials: 'same-origin',
          headers: Object.assign({ 'x-um': '1' }, opts.raw ? { 'Content-Type': opts.type || 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          body: opts.raw ? body : body !== undefined ? JSON.stringify(body) : undefined
        });
      } catch (_) { throw new OfflineError('Can\'t reach the server. Check your connection.'); }
      const isJson = (r.headers.get('content-type') || '').includes('application/json');
      const j = isJson ? await r.json().catch(() => ({})) : null;
      if (r.status === 401 && j && j.error === 'Login needed') throw new AuthError('Login needed');
      if (!isJson) throw new OfflineError('No server here.');
      if (!r.ok) throw new Error(j.error || 'The server said no (' + r.status + ').');
      return j;
    },
    state() { return this.call('GET', 'api/state'); },
    login(username, password) { return this.call('POST', 'api/login', { username, password }); },
    passkeys() { return this.call('GET', 'api/passkeys'); },
    delPasskey(id) { return this.call('DELETE', 'api/passkeys/' + encodeURIComponent(id), {}); },
    logout() { return this.call('POST', 'api/logout', {}); },
    parse(text, date) { return this.call('POST', 'api/parse', { text, date }); },
    add(items) { return this.call('POST', 'api/items', { items }); },
    act(id, a) { return this.call('POST', 'api/tasks/' + encodeURIComponent(id) + '/' + a, {}); },
    steps(id, steps) { return this.call('PUT', 'api/tasks/' + encodeURIComponent(id) + '/steps', { steps }); },
    breakdown(id) { return this.call('POST', 'api/tasks/' + encodeURIComponent(id) + '/breakdown', {}); },
    rescue(date) { return this.call('POST', 'api/rescue', { date }); },
    unrescue(ids) { return this.call('POST', 'api/rescue/undo', { ids }); },
    energy(date, level) { return this.call('POST', 'api/energy', { date, level }); },
    delRoutine(id) { return this.call('DELETE', 'api/routines/' + encodeURIComponent(id), {}); },
    settings(s) { return this.call('PUT', 'api/settings', s); },
    testWa() { return this.call('POST', 'api/whatsapp/test', {}); },
    transcribe(blob) { return this.call('POST', 'api/transcribe', blob, { raw: true, type: blob.type || 'audio/webm' }); }
  };

  const KEY = 'unclutteredmind.v2';
  const OLD_KEYS = ['unclutteredmind.v1', 'dayline.v1'];
  const local = {
    st: null,
    load() {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(KEY) || 'null');
        for (const k of OLD_KEYS) if (!saved) saved = JSON.parse(localStorage.getItem(k) || 'null');
      } catch (_) { saved = null; }
      if (saved && Array.isArray(saved.tasks)) { this.st = P.ops.ensure(saved); return; }
      // First open with no server: show a sample day so the screen makes sense.
      this.st = P.ops.ensure({});
      const now = new Date();
      const items = P.parse('email the accountant, gym after work for an hour, buy milk and eggs, finish the report by 5 urgent, call mum at half 7', now, this.st.settings);
      P.ops.addItems(this.st, items.map(i => Object.assign(i, { example: true })), now);
    },
    save() { try { localStorage.setItem(KEY, JSON.stringify(this.st)); } catch (_) { /* private mode: keep in memory */ } },
    out(extra) {
      return Object.assign({ tasks: this.st.tasks, routines: this.st.routines, energy: this.st.energy, settings: this.st.settings,
        features: { ai: false, transcribe: false, whatsapp: false, auth: false }, whatsapp: {} }, extra || {});
    },
    done(extra) { this.save(); return this.out(extra); },
    async state() { if (!this.st) this.load(); P.ops.materialize(this.st, new Date()); return this.done(); },
    async parse(text, date) {
      const now = new Date();
      let items = P.parse(text, now, this.st.settings);
      if (date && date !== P.dateKey(now)) items = items.map(i => (i.date === P.dateKey(now) ? Object.assign(i, { date }) : i));
      return { items: items.map(i => P.sanitizeItem(i, now, this.st.settings)).filter(Boolean), source: 'rules' };
    },
    async add(items) { const r = P.ops.addItems(this.st, items, new Date()); return this.done({ added: r.added, routinesAdded: r.routines }); },
    async act(id, a) { const r = P.ops.action(this.st, id, a, new Date()); if (!r.ok) throw new Error(r.error); return this.done({ task: r.task }); },
    async steps(id, steps) { const r = P.ops.setSteps(this.st, id, steps); if (!r.ok) throw new Error(r.error); return this.done({ autoDone: r.autoDone }); },
    async breakdown() { throw new Error('Breaking tasks down needs the server with an AI key.'); },
    async rescue(date) { const r = P.ops.rescue(this.st, date, new Date(), { keep: 3 }); return this.done({ moved: r.moved }); },
    async unrescue(ids) { const r = P.ops.unrescue(this.st, ids, new Date()); return this.done(r); },
    async energy(date, level) { const r = P.ops.energy(this.st, date, level, new Date()); if (!r.ok) throw new Error(r.error); return this.done({ moved: r.moved, message: r.message }); },
    async delRoutine(id) { P.ops.deleteRoutine(this.st, id, new Date()); return this.done(); },
    async settings(s) { this.st.settings = P.sanitizeSettings(s, this.st.settings); return this.done(); },
    async testWa() { throw new Error('WhatsApp needs the server running.'); },
    async transcribe() { throw new Error('Recording needs the server with an OpenAI key.'); },
    async login() { return { ok: true }; },
    async logout() { return { ok: true }; }
  };

  let B = remote;

  function take(j) {
    if (!j) return;
    S.tasks = Array.isArray(j.tasks) ? j.tasks : [];
    S.routines = Array.isArray(j.routines) ? j.routines : [];
    S.energy = j.energy || {};
    S.settings = P.sanitizeSettings(j.settings || {});
    S.features = Object.assign({ ai: false, transcribe: false, whatsapp: false, auth: false }, j.features || {});
    S.wa = j.whatsapp || {};
  }

  // Run a backend call, update state, re-render, report errors kindly.
  async function run(fn, opts) {
    opts = opts || {};
    if (S.busy && !opts.allowConcurrent) return null;
    S.busy = true;
    try {
      const j = await fn();
      if (j && j.tasks) take(j);
      render();
      return j || {};
    } catch (e) {
      if (e instanceof AuthError) { showLogin(); return null; }
      toast(e.message || 'Something went wrong.');
      return null;
    } finally { S.busy = false; }
  }

  async function boot() {
    try {
      take(await remote.state());
      S.mode = 'api'; B = remote;
      $('loginGate').hidden = true; $('passkeySetup').hidden = true; $('main').hidden = false;
      document.body.classList.remove('gated');
    } catch (e) {
      if (e instanceof AuthError) { S.mode = 'api'; B = remote; showLogin(); return; }
      S.mode = 'local'; B = local;
      take(await local.state());
    }
    render();
  }

  /* ================================================================ sign-in + passkeys */

  // WebAuthn sends binary; the server speaks base64url.
  const toB64u = buf => btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const passkeysWork = () => !!(window.PublicKeyCredential && window.isSecureContext && navigator.credentials);
  const ASK_KEY = 'unclutteredmind.passkeyAsked';
  const passkeyError = e => (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) ? null
    : e && e.name === 'InvalidStateError' ? 'This device already has a passkey here.'
    : (e && e.message) || 'Passkey didn\'t work. Use your password instead.';

  async function canUsePlatformPasskey() {
    if (!passkeysWork()) return false;
    try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (_) { return false; }
  }

  function showLogin() {
    $('loginGate').hidden = false; $('passkeySetup').hidden = true; $('main').hidden = true;
    document.body.classList.add('gated');
    const pk = passkeysWork();
    $('passkeyLogin').hidden = !pk; $('passkeyHint').hidden = !pk;
    setTimeout(() => $('loginUser').focus(), 50);
  }
  function loginError(msg) { $('loginError').textContent = msg; $('loginError').hidden = !msg; }

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    loginError('');
    try {
      const r = await remote.login($('loginUser').value.trim(), $('loginPass').value);
      $('loginPass').value = '';
      let asked = false;
      try { asked = localStorage.getItem(ASK_KEY) === '1'; } catch (_) { /* storage blocked */ }
      if (!r.passkeys && !asked && await canUsePlatformPasskey()) return showPasskeySetup();
      await boot();
    } catch (err) { loginError(err.message); }
  });

  $('passkeyLogin').addEventListener('click', async () => {
    loginError('');
    try {
      const o = await remote.call('POST', 'api/passkey/login/options', {});
      const cred = await navigator.credentials.get({ publicKey: {
        challenge: fromB64u(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification, allowCredentials: []
      } });
      const a = cred.response;
      await remote.call('POST', 'api/passkey/login/verify', {
        id: cred.id, clientDataJSON: toB64u(a.clientDataJSON), authenticatorData: toB64u(a.authenticatorData),
        signature: toB64u(a.signature), userHandle: a.userHandle ? toB64u(a.userHandle) : null
      });
      await boot();
    } catch (err) { const m = passkeyError(err); if (m) loginError(m); }
  });

  async function registerPasskey() {
    const o = await remote.call('POST', 'api/passkey/register/options', {});
    const cred = await navigator.credentials.create({ publicKey: Object.assign({}, o, {
      challenge: fromB64u(o.challenge),
      user: Object.assign({}, o.user, { id: fromB64u(o.user.id) }),
      excludeCredentials: (o.excludeCredentials || []).map(c => Object.assign({}, c, { id: fromB64u(c.id) }))
    }) });
    const a = cred.response;
    return remote.call('POST', 'api/passkey/register/verify', {
      id: cred.id, clientDataJSON: toB64u(a.clientDataJSON), attestationObject: toB64u(a.attestationObject),
      transports: typeof a.getTransports === 'function' ? a.getTransports() : []
    });
  }

  function showPasskeySetup() {
    $('loginGate').hidden = true; $('main').hidden = true; $('passkeySetup').hidden = false;
    document.body.classList.add('gated');
    $('setupError').hidden = true;
    setTimeout(() => $('setupYes').focus(), 50);
  }
  $('setupYes').addEventListener('click', async () => {
    $('setupError').hidden = true;
    try {
      await registerPasskey();
      try { localStorage.setItem(ASK_KEY, '1'); } catch (_) { /* fine */ }
      await boot();
      toast('Passkey set up. Next time, just tap Passkey.');
    } catch (err) {
      const m = passkeyError(err);
      if (m) { $('setupError').textContent = m; $('setupError').hidden = false; }
    }
  });
  $('setupNo').addEventListener('click', async () => {
    try { localStorage.setItem(ASK_KEY, '1'); } catch (_) { /* fine */ }
    await boot();
  });

  function renderPasskeys(list) {
    const when = t => t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'never';
    $('passkeyList').innerHTML = list.length
      ? list.map(k => '<li><span>' + esc(k.name) + ' <span class="tag">Added ' + esc(when(k.createdAt)) + ' · last used ' + esc(when(k.lastUsed)) + '</span></span>' +
          '<button class="btn small ghost del" type="button" data-passkey="' + esc(k.id) + '">Remove</button></li>').join('')
      : '<li class="empty">No passkeys yet. You sign in with your password.</li>';
  }
  async function loadPasskeys() {
    try { renderPasskeys((await remote.passkeys()).passkeys || []); } catch (_) { /* shown next time */ }
  }
  $('passkeyList').addEventListener('click', async e => {
    const b = e.target.closest('[data-passkey]');
    if (!b) return;
    if (!confirm('Remove this passkey? You can still sign in with your password.')) return;
    try { renderPasskeys((await remote.delPasskey(b.dataset.passkey)).passkeys || []); toast('Passkey removed'); }
    catch (err) { toast(err.message); }
  });
  $('addPasskey').addEventListener('click', async () => {
    try { const r = await registerPasskey(); renderPasskeys(r.passkeys || []); toast('Passkey added'); }
    catch (err) { const m = passkeyError(err); if (m) toast(m); }
  });
  $('settingsBox').addEventListener('toggle', () => { if ($('settingsBox').open && !$('accountBox').hidden) loadPasskeys(); });

  $('logoutBtn').addEventListener('click', async () => { try { await B.logout(); } catch (_) {} showLogin(); });

  /* ================================================================ actions */

  const CHEERS = ['Nice. One down.', 'Done. That counts.', 'Ticked off. Good work.', 'Sorted.', 'That\'s off your mind now.'];
  const cheer = () => CHEERS[Math.floor(Math.random() * CHEERS.length)];

  async function act(id, action) {
    const before = S.tasks.find(t => t.id === id);
    const j = await run(() => B.act(id, action));
    if (!j) return;
    S.open = action === 'delete' ? null : S.open;
    const after = S.tasks.find(t => t.id === id);
    if (action === 'done') toast(cheer(), { label: 'Undo', fn: () => act(id, 'undo') });
    else if (action === 'snooze' && after) toast(after.date === today() ? 'Moved to ' + P.fmt(after.start) : 'No room left today, so it\'s on tomorrow');
    else if (action === 'tomorrow') toast('Moved to tomorrow. That\'s allowed.');
    else if ((action === 'place' || action === 'today') && after) toast(after.start != null ? 'Fitted in at ' + P.fmt(after.start) : 'No gap left today. Try tomorrow.');
    else if (action === 'startnow') toast('Go. Just the first 2 minutes.');
    else if (action === 'someday') toast('Moved to your someday list.');
    else if (action === 'delete' && before) toast('Removed "' + before.title + '"');
  }

  async function saveSteps(task, steps) {
    const j = await run(() => B.steps(task.id, steps));
    if (j && j.autoDone) toast('All steps done, so the task is ticked off. ' + cheer());
  }
  async function toggleStep(taskId, stepId) {
    const t = S.tasks.find(x => x.id === taskId); if (!t) return;
    const steps = (t.steps || []).map(s => (s.id === stepId ? Object.assign({}, s, { done: !s.done }) : s));
    await saveSteps(t, steps);
  }
  async function breakdown(taskId) {
    const t = S.tasks.find(x => x.id === taskId); if (!t) return;
    toast('Breaking it down…');
    S.open = taskId;
    const j = await run(() => B.breakdown(taskId));
    if (j) toast('Here are some small steps. Just do the first one.');
  }
  async function rescue() {
    const j = await run(() => B.rescue(S.view));
    if (!j) return;
    const moved = j.moved || [];
    if (!moved.length) toast('Your day is already light. Just do the next thing.');
    else toast('Kept 3 things. Moved ' + moved.length + ' to tomorrow. Breathe.', { label: 'Undo', fn: () => run(() => B.unrescue(moved)) });
  }
  async function setEnergy(level) {
    const j = await run(() => B.energy(today(), level));
    if (j && j.message) {
      const moved = j.moved || [];
      toast(j.message, moved.length ? { label: 'Undo', fn: () => run(() => B.unrescue(moved)) } : null);
    }
  }

  /* ================================================================ rendering */

  function render() {
    if (S.mode === 'starting') return;
    const now = new Date(), td = today(), nowMin = P.minutesNow(now);
    const isToday = S.view === td;
    const vd = new Date(S.view + 'T12:00:00');
    $('dayName').textContent = isToday ? 'Today' : S.view === P.addDays(td, 1) ? 'Tomorrow' : vd.toLocaleDateString('en-GB', { weekday: 'long' });
    $('dateLine').textContent = vd.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    $('prevDay').disabled = S.view <= td;

    const pill = $('modePill');
    pill.className = 'pill' + (S.mode === 'api' && S.features.whatsapp ? ' on' : S.mode === 'api' ? ' warn' : '');
    pill.lastElementChild.textContent = S.mode === 'api' ? (S.features.whatsapp ? 'WhatsApp on' : 'WhatsApp off') : 'This device only';

    const day = S.tasks.filter(t => t.date === S.view && !t.someday);
    const planned = day.filter(t => !t.done && t.start != null).sort((a, b) => a.start - b.start);
    const unplaced = S.tasks.filter(t => !t.done && !t.someday && t.start == null && t.date && (t.date === S.view || (isToday && t.date < td)));
    const overdue = isToday ? S.tasks.filter(t => !t.done && !t.someday && t.start != null && t.date && t.date < td) : [];
    const done = day.filter(t => t.done);
    const someday = S.tasks.filter(t => t.someday && !t.done);

    $('energyCard').hidden = !(isToday && S.settings.energyCheck && !S.energy[td] && planned.length > 0);
    $('exampleBanner').hidden = !S.tasks.some(t => t.example);
    renderFocus(planned, isToday, nowMin);
    renderLoad(planned, isToday, nowMin);
    renderTimeline(planned, isToday, nowMin);

    $('noRoom').hidden = !(unplaced.length || overdue.length);
    $('noRoomList').innerHTML = overdue.concat(unplaced).map(t =>
      '<li><span>' + esc(t.title) + ' <span class="tag">' + (t.start != null ? 'from an earlier day' : P.fmtDur(t.duration)) + '</span></span>' +
      '<span class="btnrow"><button class="btn small" data-act="place" data-id="' + esc(t.id) + '">Fit in today</button>' +
      '<button class="btn small ghost" data-act="tomorrow" data-id="' + esc(t.id) + '">Tomorrow</button>' +
      '<button class="btn small ghost" data-act="someday" data-id="' + esc(t.id) + '">Someday</button></span></li>').join('');

    $('somedayBox').hidden = !someday.length;
    $('somedaySummary').textContent = 'Someday (' + someday.length + ')';
    $('somedayList').innerHTML = someday.map(t =>
      '<li><span>' + esc(t.title) + '</span><span class="btnrow"><button class="btn small" data-act="today" data-id="' + esc(t.id) + '">Do today</button>' +
      '<button class="btn small ghost del" data-act="delete" data-id="' + esc(t.id) + '">Delete</button></span></li>').join('');

    $('doneBox').hidden = !done.length;
    $('doneSummary').textContent = done.length + ' done ' + (isToday ? 'today' : 'this day');
    $('doneList').innerHTML = done.map(t => '<li><span>' + esc(t.title) + '</span><button class="btn small ghost" data-act="undo" data-id="' + esc(t.id) + '">Undo</button></li>').join('');

    renderSettings();
  }

  function stepInfo(t) {
    const steps = t.steps || [];
    const next = steps.find(s => !s.done);
    return { steps, next, doneCount: steps.filter(s => s.done).length, index: next ? steps.indexOf(next) + 1 : 0 };
  }

  function renderFocus(planned, isToday, nowMin) {
    const box = $('focus');
    if (!isToday) {
      const first = planned[0];
      box.innerHTML = '<div class="eyebrow">Planning ahead</div>' +
        (first ? '<h2>First up: <mark>' + esc(first.title) + '</mark></h2><p class="meta">at ' + P.fmt(first.start) + ' · ' + planned.length + ' thing' + (planned.length === 1 ? '' : 's') + ' planned</p>'
               : '<p class="allclear">Nothing planned yet. Talk or type below to fill this day.</p>');
      return;
    }
    const current = planned.find(t => t.start <= nowMin && nowMin < t.start + t.duration);
    const missed = planned.filter(t => t.start + t.duration <= nowMin && t.start + t.duration > nowMin - 180).pop();
    const next = planned.find(t => t.start > nowMin);
    const stepBlock = (t, si) => si.next
      ? '<div class="stepline"><span class="eyebrow">Step ' + si.index + ' of ' + si.steps.length + '</span><strong>' + esc(si.next.text) + '</strong></div>' : '';
    const stuckBtn = t => (S.features.ai && !(t.steps || []).length ? '<button class="btn ghost" data-breakdown="' + esc(t.id) + '">I\'m stuck</button>' : '');
    let html = '';
    if (current) {
      const si = stepInfo(current);
      const left = current.start + current.duration - nowMin;
      const pct = Math.min(100, ((nowMin - current.start) / current.duration) * 100);
      html = '<div class="eyebrow">Right now</div><h2><mark>' + esc(current.title) + '</mark></h2>' + stepBlock(current, si) +
        '<p class="meta"><span class="mono">' + left + ' min</span> left · until ' + P.fmt(current.start + current.duration) + '</p>' +
        '<div class="clock" role="progressbar" aria-label="Time used" aria-valuenow="' + Math.round(pct) + '" aria-valuemin="0" aria-valuemax="100"><span style="width:' + pct.toFixed(1) + '%"></span></div>' +
        '<div class="btnrow">' +
          (si.next ? '<button class="btn primary" data-step="' + esc(current.id) + ':' + esc(si.next.id) + '">Step done</button>' : '<button class="btn primary" data-act="done" data-id="' + esc(current.id) + '">Done</button>') +
          '<button class="btn" data-act="snooze" data-id="' + esc(current.id) + '">+15 min</button>' +
          '<button class="btn ghost" data-act="tomorrow" data-id="' + esc(current.id) + '">Not today</button>' + stuckBtn(current) +
        '</div>';
    } else if (missed) {
      html = '<div class="eyebrow">Quick check</div><h2>Did you finish <mark>' + esc(missed.title) + '</mark>?</h2>' +
        '<p class="meta">It was planned for ' + P.fmt(missed.start) + '. No guilt either way.</p>' +
        '<div class="btnrow"><button class="btn primary" data-act="done" data-id="' + esc(missed.id) + '">Yes, done</button>' +
        '<button class="btn" data-act="place" data-id="' + esc(missed.id) + '">Do it next</button>' +
        '<button class="btn ghost" data-act="tomorrow" data-id="' + esc(missed.id) + '">Tomorrow</button></div>';
    } else if (next) {
      const si = stepInfo(next);
      const wait = next.start - nowMin;
      const pct = Math.max(0, 100 - (wait / 120) * 100);
      html = '<div class="eyebrow">Up next</div><h2><mark>' + esc(next.title) + '</mark></h2>' + stepBlock(next, si) +
        '<p class="meta">in <span class="mono">' + (wait >= 60 ? P.fmtDur(wait) : wait + ' min') + '</span> at ' + P.fmt(next.start) + ' · ' + P.fmtDur(next.duration) + '</p>' +
        '<div class="clock"><span style="width:' + pct.toFixed(1) + '%"></span></div>' +
        '<div class="btnrow"><button class="btn primary" data-act="startnow" data-id="' + esc(next.id) + '">Start it now</button>' +
        '<button class="btn ghost" data-act="tomorrow" data-id="' + esc(next.id) + '">Not today</button>' + stuckBtn(next) + '</div>';
    } else {
      html = '<div class="eyebrow">Right now</div><p class="allclear">Nothing on. Rest counts too.</p>' +
        '<p class="meta">Got something buzzing in your head? Tap the mic and say it.</p>';
    }
    box.innerHTML = html;
  }

  function renderLoad(planned, isToday, nowMin) {
    const s = S.settings;
    const from = isToday ? Math.max(nowMin, s.dayStart) : s.dayStart;
    const avail = Math.max(0, s.dayEnd - from);
    const used = planned.reduce((a, t) => a + Math.max(0, Math.min(t.start + t.duration, s.dayEnd) - Math.max(t.start, from)), 0);
    const pct = avail ? Math.min(100, (used / avail) * 100) : 100;
    const full = pct >= 80;
    const flexibleLeft = planned.filter(t => !t.fixed && (!isToday || t.start > nowMin)).length;
    const el = $('load');
    el.className = 'load' + (full ? ' full' : '');
    el.innerHTML = '<div class="bar"><span style="width:' + pct.toFixed(1) + '%"></span></div>' +
      '<p>' + (full ? '<strong>That\'s a lot for one day.</strong> ' : '') + '<span class="mono">' + P.fmtDur(used) + '</span> planned out of <span class="mono">' + P.fmtDur(avail) + '</span> ' + (isToday ? 'left today' : 'in the day') + '.</p>' +
      (flexibleLeft > 3 ? '<div><button class="btn small" data-rescue="1">Too much? Keep my top 3</button></div>' : '');
  }

  function renderTimeline(planned, isToday, nowMin) {
    const tl = $('timeline');
    $('planTitle').textContent = isToday ? 'The rest of today' : 'The plan';
    if (S.open && !planned.some(t => t.id === S.open)) S.open = null; // finished/moved tasks don't stay "open"
    if (!planned.length) {
      tl.innerHTML = '<li class="empty">Empty so far. Say everything that\'s in your head and it gets laid out here, with breathers in between.</li>';
      return;
    }
    let html = '', prevEnd = null;
    for (const t of planned) {
      const end = t.start + t.duration;
      if (prevEnd != null && t.start - prevEnd >= 45) html += '<li class="gap">' + P.fmtDur(t.start - prevEnd) + ' free</li>';
      prevEnd = Math.max(prevEnd || 0, end);
      const isNow = isToday && t.start <= nowMin && nowMin < end;
      const isPast = isToday && end <= nowMin;
      const open = S.open === t.id;
      const si = stepInfo(t);
      html += '<li class="row' + (isNow ? ' now' : '') + (isPast ? ' past' : '') + '">' +
        '<button class="check" data-act="done" data-id="' + esc(t.id) + '" aria-label="Mark ' + esc(t.title) + ' done">' + CHECK + '</button>' +
        '<div class="when2"><span class="t mono">' + P.fmt(t.start) + '</span><span class="d">' + P.fmtDur(t.duration) + '</span></div>' +
        '<div class="what">' + esc(t.title) + '<div class="tags">' +
          (isNow ? '<span class="tag now">now</span>' : '') +
          (t.urgent ? '<span class="tag urgent">urgent</span>' : '') +
          (si.steps.length ? '<span class="tag">' + si.doneCount + '/' + si.steps.length + ' steps</span>' : '') +
          (t.routineId ? '<span class="tag">repeats</span>' : '') +
          (t.fixed ? '<span class="tag">set time</span>' : '') +
          (t.energy === 'high' ? '<span class="tag">big one</span>' : '') +
          (t.example ? '<span class="tag">example</span>' : '') +
        '</div></div>' +
        '<button class="more" data-toggle="' + esc(t.id) + '" aria-expanded="' + open + '" aria-label="More for ' + esc(t.title) + '">⋯</button>' +
        (open ? renderActs(t, si) : '') +
        '</li>';
    }
    tl.innerHTML = html;
  }

  function renderActs(t, si) {
    const steps = si.steps.map(s =>
      '<li class="' + (s.done ? 'done' : '') + '"><button class="stepbox" data-step="' + esc(t.id) + ':' + esc(s.id) + '" aria-label="' + (s.done ? 'Untick' : 'Tick') + ' step: ' + esc(s.text) + '">' + CHECK + '</button>' +
      '<span>' + esc(s.text) + '</span><button class="x" data-steprm="' + esc(t.id) + ':' + esc(s.id) + '" aria-label="Remove step">×</button></li>').join('');
    return '<div class="acts">' +
      '<div class="btnrow"><button class="btn small" data-act="snooze" data-id="' + esc(t.id) + '">+15 min</button>' +
      '<button class="btn small" data-act="tomorrow" data-id="' + esc(t.id) + '">Tomorrow</button>' +
      '<button class="btn small" data-act="someday" data-id="' + esc(t.id) + '">Someday</button>' +
      '<button class="btn small ghost del" data-act="delete" data-id="' + esc(t.id) + '">Delete</button></div>' +
      (steps ? '<ul class="steps">' + steps + '</ul>' : '') +
      '<form class="stepadd" data-stepadd="' + esc(t.id) + '"><input id="stepInput-' + esc(t.id) + '" maxlength="120" placeholder="Add a small step" aria-label="Add a step to ' + esc(t.title) + '">' +
      '<button class="btn small" type="submit">Add</button></form>' +
      (S.features.ai ? '<div><button class="btn small ghost" data-breakdown="' + esc(t.id) + '">' + (si.steps.length ? 'Break it down again' : 'Break it into small steps') + '</button></div>' : '') +
      '</div>';
  }

  function renderSettings() {
    const s = S.settings;
    $('sStart').value = P.hhmm(s.dayStart); $('sEnd').value = P.hhmm(Math.min(s.dayEnd, 1439));
    $('sBuffer').value = String(s.buffer); $('sDur').value = String(s.defaultDuration);
    $('sLead').value = String(s.lead); $('sDigest').value = P.hhmm(s.digestTime);
    $('sEnergy').value = String(s.energyCheck); $('sNudge').value = String(s.nudgeAgain);
    $('sWrap').value = String(s.wrapUp); $('sRecap').value = String(s.weeklyRecap);
    $('sQuietStart').value = P.hhmm(s.quietStart); $('sQuietEnd').value = P.hhmm(s.quietEnd);
    for (const sel of ['sBuffer', 'sDur', 'sLead']) if ($(sel).selectedIndex < 0) $(sel).selectedIndex = 0;

    const note = $('waNote');
    if (S.mode !== 'api') {
      note.textContent = 'Right now your tasks are saved in this browser only. WhatsApp reminders, voice notes and AI need the Uncluttered Mind server.';
      $('testWa').hidden = true;
    } else if (!S.features.whatsapp) {
      note.textContent = 'The server is running but WhatsApp isn\'t set up yet.';
      $('testWa').hidden = true;
    } else {
      note.textContent = 'Reminders go to the number ending ' + (S.wa.to || '').replace(/•/g, '') + '. Tap the buttons on WhatsApp, or reply DONE, SNOOZE, SKIP, TODAY, STUCK or TOO MUCH. You can also text or voice-note tasks.';
      $('testWa').hidden = false;
    }
    $('accountBox').hidden = !(S.mode === 'api' && S.features.auth);
    $('addPasskey').hidden = !passkeysWork();
    $('routineList').innerHTML = S.routines.length
      ? S.routines.map(r => '<li><span>' + esc(r.title) + ' <span class="tag">' + esc(P.daysLabel(r.days) + (r.start != null ? ' · ' + P.fmt(r.start) : '')) + '</span></span>' +
          '<button class="btn small ghost del" data-routine="' + esc(r.id) + '">Stop repeating</button></li>').join('')
      : '<li class="empty">Nothing repeats yet. Say "take meds every morning at 8" or "bins every Tuesday night".</li>';
  }

  const SETTING_FIELDS = { sStart: 'dayStart', sEnd: 'dayEnd', sBuffer: 'buffer', sDur: 'defaultDuration', sLead: 'lead', sDigest: 'digestTime',
    sEnergy: 'energyCheck', sNudge: 'nudgeAgain', sWrap: 'wrapUp', sRecap: 'weeklyRecap', sQuietStart: 'quietStart', sQuietEnd: 'quietEnd' };
  const TIME_FIELDS = ['sStart', 'sEnd', 'sDigest', 'sQuietStart', 'sQuietEnd'];
  Object.keys(SETTING_FIELDS).forEach(id => $(id).addEventListener('change', async () => {
    const next = {};
    for (const [fid, key] of Object.entries(SETTING_FIELDS)) next[key] = TIME_FIELDS.includes(fid) ? toMin($(fid).value) : Number($(fid).value);
    if (next.dayEnd === 1439) next.dayEnd = 1440;
    if (next.dayEnd - next.dayStart < 60) { toast('Your day needs to be at least an hour long.'); return renderSettings(); }
    const j = await run(() => B.settings(next), { allowConcurrent: true });
    if (j) toast('Saved');
  }));
  $('testWa').addEventListener('click', async () => {
    const j = await run(() => B.testWa());
    if (j) toast(j.mode === 'template' || j.mode === 'template-buttons' ? 'Sent using your template. Check WhatsApp.' : 'Sent. Check WhatsApp.');
  });

  /* ================================================================ events */

  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const d = b.dataset;
    if (d.toggle) { S.open = S.open === d.toggle ? null : d.toggle; render(); return; }
    if (d.act) { act(d.id, d.act); return; }
    if (d.step) { const [tid, sid] = d.step.split(':'); toggleStep(tid, sid); return; }
    if (d.steprm) {
      const [tid, sid] = d.steprm.split(':');
      const t = S.tasks.find(x => x.id === tid);
      if (t) saveSteps(t, (t.steps || []).filter(s => s.id !== sid));
      return;
    }
    if (d.breakdown) { breakdown(d.breakdown); return; }
    if (d.rescue) { rescue(); return; }
    if (d.energy) { setEnergy(d.energy); return; }
    if (d.routine) {
      const r = S.routines.find(x => x.id === d.routine);
      run(() => B.delRoutine(d.routine)).then(j => { if (j && r) toast('"' + r.title + '" won\'t repeat any more.'); });
    }
  });
  document.addEventListener('submit', e => {
    const f = e.target.closest('form[data-stepadd]');
    if (!f) return;
    e.preventDefault();
    const tid = f.dataset.stepadd;
    const input = f.querySelector('input');
    const text = input.value.trim();
    const t = S.tasks.find(x => x.id === tid);
    if (!text || !t) return;
    saveSteps(t, (t.steps || []).concat({ text, done: false })).then(() => { const el = $('stepInput-' + tid); if (el) el.focus(); });
  });
  $('prevDay').addEventListener('click', () => { S.view = P.addDays(S.view, -1); S.open = null; render(); });
  $('nextDay').addEventListener('click', () => { S.view = P.addDays(S.view, 1); S.open = null; render(); });
  $('clearExamples').addEventListener('click', async () => {
    const ids = S.tasks.filter(t => t.example).map(t => t.id);
    for (const id of ids) { try { await B.act(id, 'delete'); } catch (_) { /* already gone */ } }
    take(await B.state().catch(() => null));
    render(); toast('Cleared. Your turn.');
  });

  /* ================================================================ brain dump → preview → add */

  async function sortIt() {
    const text = $('dumpInput').value.trim();
    if (!text) { toast('Say or type something first'); $('dumpInput').focus(); return; }
    $('sortBtn').disabled = true; $('sortBtn').textContent = 'Sorting…';
    try {
      const j = await B.parse(text, S.view);
      if (!j.items || !j.items.length) { toast('I couldn\'t find a task in that. Try "call mum at 3".'); return; }
      S.preview = j.items; S.previewSource = j.source; renderPreview();
    } catch (e) {
      if (e instanceof AuthError) return showLogin();
      const j = await local.parse(text, S.view).catch(() => null); // server hiccup: parse here instead
      if (j && j.items.length) { S.preview = j.items; S.previewSource = 'rules'; renderPreview(); }
      else toast(e.message);
    } finally { $('sortBtn').disabled = false; $('sortBtn').textContent = 'Sort it'; }
  }
  function renderPreview() {
    const box = $('preview');
    box.hidden = !S.preview.length;
    const td = today();
    $('previewTitle').textContent = S.previewSource === 'ai' ? 'Here\'s what I understood' : 'Here\'s what I heard';
    $('previewList').innerHTML = S.preview.map((it, i) => {
      const dayTag = it.date && it.date !== S.view ? (it.date === P.addDays(td, 1) ? 'Tomorrow ' : new Date(it.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' }) + ' ') : '';
      return '<li class="prow"><span class="when mono">' + esc(dayTag + P.whenLabel(it)) + (it.urgent ? ' · urgent' : '') + '</span>' +
        '<input id="pv' + i + '" data-i="' + i + '" value="' + esc(it.title) + '" maxlength="140" aria-label="Task ' + (i + 1) + '">' +
        '<button class="x" type="button" data-rm="' + i + '" aria-label="Remove ' + esc(it.title) + '">×</button></li>';
    }).join('');
    $('addBtn').textContent = 'Add ' + S.preview.length + ' to my day';
  }
  $('previewList').addEventListener('input', e => { const i = e.target.dataset.i; if (i != null && S.preview[+i]) S.preview[+i].title = e.target.value; });
  $('previewList').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (!b) return; e.stopPropagation(); S.preview.splice(+b.dataset.rm, 1); renderPreview(); });
  $('sortBtn').addEventListener('click', () => { stopListening(); sortIt(); });
  $('dumpInput').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sortIt(); } });
  $('cancelBtn').addEventListener('click', () => { S.preview = []; renderPreview(); $('dumpInput').focus(); });
  $('addBtn').addEventListener('click', async () => {
    const items = S.preview.filter(i => i.title && i.title.trim().length > 1);
    if (!items.length) return;
    const j = await run(() => B.add(items));
    if (!j) return;
    S.preview = []; $('dumpInput').value = ''; renderPreview();
    const added = (j.added || []).filter(t => !t.routineId);
    const reps = j.routinesAdded || [];
    const first = added.filter(t => t.start != null && t.date === S.view).sort((a, b) => a.start - b.start)[0];
    const parts = [];
    if (added.length) parts.push('Added ' + added.length + (first ? ', first at ' + P.fmt(first.start) : ''));
    if (reps.length) parts.push(reps.length + ' repeating');
    toast(parts.join(' · ') || 'Added');
  });

  /* ================================================================ voice */

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, recorder = null, chunks = [], listening = false, baseText = '';
  function setListening(on, label) {
    listening = on;
    $('inputbox').classList.toggle('listening', on);
    $('micBtn').setAttribute('aria-pressed', String(on));
    $('micBtn').setAttribute('aria-label', on ? 'Stop talking' : 'Start talking');
    $('micHint').textContent = label || (on ? 'Listening… say it all, then tap again' : 'Tap to talk');
  }
  function stopListening() {
    if (rec && listening) { try { rec.stop(); } catch (_) {} }
    if (recorder && recorder.state === 'recording') { try { recorder.stop(); } catch (_) {} }
  }
  function micProblem(msg) { setListening(false, msg); toast(msg); }

  async function startRecording() {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (_) { return micProblem('Microphone is blocked. Allow it in your browser, or use the mic on your keyboard.'); }
    chunks = [];
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    try { recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined); }
    catch (_) { stream.getTracks().forEach(t => t.stop()); return micProblem('Recording isn\'t supported here. Use the mic on your keyboard.'); }
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      setListening(false, 'Turning that into text…');
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
        const j = await B.transcribe(blob);
        if (j.text) { $('dumpInput').value = ($('dumpInput').value.trim() ? $('dumpInput').value.trim() + '\n' : '') + j.text; setListening(false); sortIt(); }
        else micProblem('I didn\'t catch any words. Try again?');
      } catch (e) { micProblem(e.message); }
    };
    recorder.start();
    setListening(true, 'Recording… tap again when you\'re done');
  }

  $('micBtn').addEventListener('click', () => {
    if (listening) return stopListening();
    if (SR) {
      rec = new SR();
      rec.lang = 'en-GB'; rec.continuous = true; rec.interimResults = true;
      baseText = $('dumpInput').value.trim();
      rec.onresult = e => {
        let finalText = '', interim = '';
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript.trim() + '. ';
          else interim += r[0].transcript;
        }
        $('dumpInput').value = (baseText ? baseText + '\n' : '') + finalText.trim();
        $('interim').textContent = interim;
      };
      rec.onerror = e => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          listening = false;
          if (S.features.transcribe && window.MediaRecorder) return startRecording();
          micProblem('Microphone is blocked here. Allow it in your browser, or use the mic on your keyboard.');
        } else if (e.error === 'no-speech') toast('Didn\'t catch anything. Try again?');
        else if (e.error !== 'aborted') micProblem('Voice stopped (' + e.error + '). You can keep typing.');
      };
      rec.onend = () => {
        const was = listening;
        setListening(false); $('interim').textContent = '';
        if (was && $('dumpInput').value.trim() && $('dumpInput').value.trim() !== baseText) sortIt();
      };
      try { rec.start(); setListening(true); } catch (_) { micProblem('Voice couldn\'t start. Use the mic on your keyboard.'); }
      return;
    }
    if (S.features.transcribe && window.MediaRecorder && navigator.mediaDevices) return startRecording();
    micProblem('This browser can\'t listen. Use Chrome, Edge or Safari, or the mic on your keyboard.');
  });

  /* ================================================================ toast + clock */

  let tt, toastFn = null;
  function toast(msg, action) {
    const el = $('toast');
    $('toastText').textContent = msg;
    toastFn = action ? action.fn : null;
    $('toastBtn').hidden = !action;
    if (action) $('toastBtn').textContent = action.label;
    el.classList.add('show');
    clearTimeout(tt);
    tt = setTimeout(() => { el.classList.remove('show'); toastFn = null; }, action ? 6000 : 2800);
  }
  $('toastBtn').addEventListener('click', () => {
    const fn = toastFn; toastFn = null;
    $('toast').classList.remove('show');
    if (fn) fn();
  });

  // Keep "now" accurate and pick up WhatsApp changes, without fighting the person mid-edit.
  setInterval(async () => {
    const editing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (S.preview.length || editing || S.busy) return;
    if (S.mode === 'api') { try { take(await remote.state()); } catch (e) { if (e instanceof AuthError) return showLogin(); } }
    else if (S.mode === 'local') take(await local.state());
    if (S.view < today()) S.view = today();
    render();
  }, 30000);

  boot();
})();
