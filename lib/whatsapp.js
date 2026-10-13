'use strict';
/*
 * WhatsApp Cloud API client.
 *
 * Meta's rules this file works around:
 *  - Free-form and button messages only reach the user within 24h of their last message to the business number.
 *  - Outside that window only approved templates are delivered.
 * So: inside the window we send real tap-to-reply buttons; outside it we fall back to templates.
 */

const digits = s => String(s || '').replace(/\D/g, '');
const oneLine = s => String(s).replace(/\s*\n+\s*/g, ' · ').replace(/\t/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1000);
const WINDOW_MS = 23.5 * 3600 * 1000;

function createWhatsApp({ env, getMeta, log }) {
  const base = () => (env('WA_API_BASE') || 'https://graph.facebook.com').replace(/\/$/, '');
  const ver = () => env('WA_API_VERSION') || 'v21.0';
  const configured = () => !!(env('WA_TOKEN') && env('WA_PHONE_NUMBER_ID') && env('WA_TO'));
  const inWindow = () => { const t = getMeta().lastInbound; return !!t && Date.now() - t < WINDOW_MS; };
  const auth = () => ({ Authorization: 'Bearer ' + env('WA_TOKEN') });

  async function post(body) {
    const r = await fetch(`${base()}/${ver()}/${env('WA_PHONE_NUMBER_ID')}/messages`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth()),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = j.error || {};
      const e = new Error(err.message || 'HTTP ' + r.status);
      e.code = err.code; e.status = r.status;
      throw e;
    }
    return j;
  }

  /**
   * Send a message. opts.buttons = up to 3 {id, title}; opts.hint = text added when buttons can't be shown.
   * Never throws: returns {ok, mode, error}.
   */
  async function send(text, opts = {}) {
    if (!configured()) return { ok: false, error: 'WhatsApp is not set up' };
    const to = digits(env('WA_TO'));
    const buttons = (opts.buttons || []).slice(0, 3);
    const isTaskTrio = buttons.length === 3 && /^done:/.test(buttons[0].id);
    const withHint = opts.hint ? text + '\n\n' + opts.hint : text;
    let body, mode;

    if (inWindow() || opts.reply) {
      if (buttons.length) {
        mode = 'buttons';
        body = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
          interactive: { type: 'button', body: { text: String(text).slice(0, 1024) },
            action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) } })) } } };
      } else {
        mode = 'text';
        body = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: String(text).slice(0, 4000), preview_url: false } };
      }
    } else if (isTaskTrio && env('WA_TEMPLATE_BUTTONS_NAME')) {
      mode = 'template-buttons';
      body = { messaging_product: 'whatsapp', to, type: 'template', template: {
        name: env('WA_TEMPLATE_BUTTONS_NAME'), language: { code: env('WA_TEMPLATE_LANG') || 'en_GB' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: oneLine(text) }] }]
          .concat(buttons.map((b, i) => ({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: String(b.id) }] }))) } };
    } else if (env('WA_TEMPLATE_NAME')) {
      mode = 'template';
      body = { messaging_product: 'whatsapp', to, type: 'template', template: {
        name: env('WA_TEMPLATE_NAME'), language: { code: env('WA_TEMPLATE_LANG') || 'en_GB' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: oneLine(withHint) }] }] } };
    } else {
      mode = 'text';
      body = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: String(withHint).slice(0, 4000), preview_url: false } };
    }

    try {
      await post(body);
      log('info', 'whatsapp sent', { mode, kind: opts.kind || 'reply' });
      return { ok: true, mode };
    } catch (e) {
      // Interactive messages can be refused (e.g. older clients); retry once as plain text.
      if (mode === 'buttons') {
        try {
          await post({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: String(withHint).slice(0, 4000) } });
          log('warn', 'whatsapp buttons refused, sent as text', { error: e.message });
          return { ok: true, mode: 'text' };
        } catch (_) { /* fall through */ }
      }
      log('error', 'whatsapp send failed', { mode, error: e.message, code: e.code,
        hint: e.code === 131047 ? 'Outside the 24h window: set WA_TEMPLATE_NAME to an approved template.' : undefined });
      return { ok: false, mode, error: e.message };
    }
  }

  // Voice notes: fetch the media URL, then the bytes (both need the token).
  async function downloadMedia(mediaId, maxBytes = 16 * 1024 * 1024) {
    const r = await fetch(`${base()}/${ver()}/${encodeURIComponent(mediaId)}`, { headers: auth(), signal: AbortSignal.timeout(15000) });
    const meta = await r.json().catch(() => ({}));
    if (!r.ok || !meta.url) throw new Error('Could not look up the voice note (' + r.status + ')');
    if (meta.file_size && meta.file_size > maxBytes) throw new Error('Voice note is too long');
    const f = await fetch(meta.url, { headers: auth(), signal: AbortSignal.timeout(30000) });
    if (!f.ok) throw new Error('Could not download the voice note (' + f.status + ')');
    const buf = Buffer.from(await f.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('Voice note is too long');
    return { buffer: buf, mime: meta.mime_type || f.headers.get('content-type') || 'audio/ogg' };
  }

  return { configured, inWindow, send, downloadMedia, digits };
}

module.exports = { createWhatsApp, digits, oneLine };
