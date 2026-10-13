'use strict';
/*
 * Optional AI features. Everything here is optional: with no API keys the app uses the
 * built-in rule parser and hides "Break it down"; voice notes need OPENAI_API_KEY.
 *
 *  - Understanding brain dumps:  ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY
 *  - Breaking tasks into steps:  same as above
 *  - Voice note transcription:   OPENAI_API_KEY
 */
const P = require('../public/shared.js');

function extractJSON(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI reply had no JSON');
  return JSON.parse(s.slice(a, b + 1));
}

function createAI({ env, log }) {
  const provider = () => (env('ANTHROPIC_API_KEY') ? 'anthropic' : env('OPENAI_API_KEY') ? 'openai' : null);
  const canTranscribe = () => !!env('OPENAI_API_KEY');

  async function complete(system, user, maxTokens) {
    const p = provider();
    if (!p) throw new Error('AI is not set up');
    const timeout = AbortSignal.timeout(Number(env('AI_TIMEOUT_MS')) || 20000);
    if (p === 'anthropic') {
      const r = await fetch((env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', {
        method: 'POST', signal: timeout,
        headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: env('ANTHROPIC_MODEL') || 'claude-haiku-5-5', max_tokens: maxTokens || 1500, system, messages: [{ role: 'user', content: user }] })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + ((j.error && j.error.message) || 'request failed'));
      return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    }
    const r = await fetch((env('OPENAI_BASE_URL') || 'https://api.openai.com').replace(/\/$/, '') + '/v1/chat/completions', {
      method: 'POST', signal: timeout,
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + env('OPENAI_API_KEY') },
      body: JSON.stringify({ model: env('OPENAI_MODEL') || 'gpt-4o-mini', response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('OpenAI ' + r.status + ': ' + ((j.error && j.error.message) || 'request failed'));
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }

  /** Brain dump -> items in the planner's item shape (then sanitised by the caller). */
  async function parseTasks(text, now, settings, viewDate) {
    const s = P.sanitizeSettings(settings);
    const today = P.dateKey(now);
    const system = [
      'You turn a person\'s spoken or typed brain dump into tasks for a day planner built for people with ADHD.',
      `Today is ${now.toLocaleDateString('en-GB', { weekday: 'long' })} ${today}. The time now is ${P.hhmm(P.minutesNow(now))}. They are in the UK.`,
      `They are planning ${viewDate && viewDate !== today ? 'the day ' + viewDate : 'today'}; tasks with no day mentioned belong to that day.`,
      `Their day runs ${P.hhmm(s.dayStart)}–${P.hhmm(s.dayEnd)}.`,
      'Return ONLY JSON: {"tasks":[...]}. Each task has:',
      ' "title": short and clear, starts with a verb where natural, keeps names and details, never includes the time or day.',
      ' "date": "YYYY-MM-DD" or null (null only when someday is true or repeat is set).',
      ' "time": exact start "HH:MM" (24h) if they gave one, else null.',
      ' "before": "HH:MM" if it must be done by a time, else null. "after": "HH:MM" if not before a time, else null.',
      ' "part": one of "first","morning","lunch","afternoon","evening","night","bed", or null.',
      ' "minutes": duration. Use what they said, otherwise a realistic estimate (calls 15, meds 5, gym 60).',
      ' "urgent": true only if they said urgent/asap/important or it is clearly time-critical.',
      ' "energy": "high" for demanding focus work, "low" for easy quick things, else null.',
      ' "repeat": array of weekday numbers (0=Sunday … 6=Saturday) if it repeats, else null.',
      ' "someday": true if there is no particular day ("one day", "at some point").',
      ' "steps": short steps only if they listed steps themselves, else [].',
      'Split separate tasks. Keep a shopping list as one task. Ignore filler words. Never invent tasks.',
      'UK speech: "at 3" during the day means 15:00, "half 4" means 16:30, "tea time" means about 18:00.'
    ].join('\n');
    const raw = await complete(system, String(text).slice(0, 5000), 2000);
    const j = extractJSON(raw);
    const list = Array.isArray(j.tasks) ? j.tasks : [];
    return list.slice(0, 50).map(t => {
      const item = {
        title: t.title, date: t.date || (t.someday || (Array.isArray(t.repeat) && t.repeat.length) ? null : (viewDate || today)),
        start: P.fromHHMM(t.time), duration: Number(t.minutes) || undefined, urgent: !!t.urgent,
        energy: t.energy, someday: !!t.someday, steps: Array.isArray(t.steps) ? t.steps : [],
        repeat: Array.isArray(t.repeat) && t.repeat.length ? { days: t.repeat } : null, window: null
      };
      const before = P.fromHHMM(t.before), after = P.fromHHMM(t.after);
      if (item.start == null) {
        if (before != null || after != null) item.window = Object.assign({}, after != null ? { from: after } : {}, before != null ? { to: before } : {});
        else if (t.part) item.window = P.partWindow(t.part, s);
      }
      return P.sanitizeItem(item, now, s);
    }).filter(Boolean);
  }

  /** Task -> 3-6 tiny steps, the first one under two minutes. */
  async function breakdown(task) {
    const system = 'You help people with ADHD start tasks they are stuck on. Break the task into 3 to 6 tiny, concrete steps. ' +
      'The first step must take under 2 minutes and be a physical, obvious action (for example "Open the laptop and find the email from Sam"). ' +
      'Each step is an instruction of at most 70 characters. Return ONLY JSON: {"steps":["..."]}.';
    const raw = await complete(system, `Task: "${task.title}" (about ${task.duration} minutes)`, 600);
    const j = extractJSON(raw);
    const steps = (Array.isArray(j.steps) ? j.steps : []).map(x => String(x).replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean).slice(0, 8);
    if (!steps.length) throw new Error('AI returned no steps');
    return steps;
  }

  /** Audio bytes -> text (OpenAI transcription). */
  async function transcribe(buffer, mime) {
    if (!canTranscribe()) throw new Error('Voice transcription is not set up');
    const type = String(mime || 'audio/ogg').split(';')[0].trim();
    const ext = { 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
      'audio/aac': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/amr': 'amr' }[type] || 'ogg';
    const form = new FormData();
    form.append('file', new Blob([buffer], { type }), 'voice.' + ext);
    form.append('model', env('TRANSCRIBE_MODEL') || 'whisper-1');
    const r = await fetch((env('OPENAI_BASE_URL') || 'https://api.openai.com').replace(/\/$/, '') + '/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + env('OPENAI_API_KEY') }, body: form,
      signal: AbortSignal.timeout(60000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Transcription ' + r.status + ': ' + ((j.error && j.error.message) || 'request failed'));
    return String(j.text || '').trim();
  }

  return { provider, enabled: () => !!provider(), canTranscribe, parseTasks, breakdown, transcribe };
}

module.exports = { createAI, extractJSON };
