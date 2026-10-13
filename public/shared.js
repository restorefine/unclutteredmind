/*
 * Uncluttered Mind — shared brain-dump parser, day planner and state operations.
 *
 * Runs unchanged in the browser (window.Planner) and in Node (require('./public/shared.js')),
 * so the server and the browser-only fallback mode behave identically.
 *
 * Conventions
 *   - Times are minutes since midnight (0–1439), dates are 'YYYY-MM-DD' in the server's local timezone.
 *   - "state" is { tasks, routines, routineLog, energy, settings }.
 *   - ops.* functions mutate the state object they are given and return a small result.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================ settings */

  const DEFAULTS = {
    dayStart: 8 * 60,        // planning window start
    dayEnd: 22 * 60,         // planning window end
    buffer: 10,              // breather between tasks (min)
    defaultDuration: 30,     // when nothing is said
    lead: 10,                // WhatsApp heads-up before a task (min, 0 = off)
    digestTime: 8 * 60,      // morning plan message
    quietStart: 22 * 60 + 30,// no WhatsApp from…
    quietEnd: 7 * 60,        // …until (urgent tasks still come through)
    nudgeAgain: 1,           // second nudge 5 min after start if no reply
    wrapUp: 1,               // "5 minutes left" on tasks of 45 min or longer
    energyCheck: 1,          // ask about energy in the morning
    weeklyRecap: 1           // Sunday evening recap
  };
  const LIMITS = {
    dayStart: [0, 1439], dayEnd: [1, 1440], buffer: [0, 60], defaultDuration: [5, 240], lead: [0, 120],
    digestTime: [0, 1439], quietStart: [0, 1439], quietEnd: [0, 1439],
    nudgeAgain: [0, 1], wrapUp: [0, 1], energyCheck: [0, 1], weeklyRecap: [0, 1]
  };
  function sanitizeSettings(input, base) {
    const prev = Object.assign({}, DEFAULTS, base || {});
    const out = Object.assign({}, prev);
    input = input || {};
    for (const k of Object.keys(LIMITS)) {
      if (input[k] === undefined || input[k] === null || input[k] === '') continue;
      const n = Math.round(Number(input[k]));
      if (!Number.isFinite(n)) continue;
      out[k] = Math.max(LIMITS[k][0], Math.min(LIMITS[k][1], n));
    }
    if (out.dayEnd - out.dayStart < 60) { out.dayStart = prev.dayStart; out.dayEnd = prev.dayEnd; }
    return out;
  }
  const cfg = s => sanitizeSettings(s || {});

  /* ================================================================ helpers */

  const pad = n => String(n).padStart(2, '0');
  const dateKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const minutesNow = d => d.getHours() * 60 + d.getMinutes();
  const isDateKey = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  function parseKey(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); }
  const addDays = (key, n) => { const d = parseKey(key); d.setDate(d.getDate() + n); return dateKey(d); };
  const weekdayOf = key => parseKey(key).getDay();
  function fmt(min) {
    min = ((Math.round(min) % 1440) + 1440) % 1440;
    let h = Math.floor(min / 60); const m = min % 60;
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + (m ? ':' + pad(m) : '') + ap;
  }
  function fmtDur(min) {
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60), m = min % 60;
    return h + ' hr' + (m ? ' ' + m + ' min' : '');
  }
  const hhmm = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  function fromHHMM(v) {
    const m = String(v == null ? '' : v).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const n = +m[1] * 60 + +m[2];
    return n >= 0 && n < 1440 ? n : null;
  }
  let uidCounter = 0;
  const uid = () => Date.now().toString(36) + (uidCounter++).toString(36) + Math.random().toString(36).slice(2, 7);
  const clampInt = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null; };
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function daysLabel(days) {
    const d = (days || []).slice().sort();
    if (d.length === 7) return 'Every day';
    if (d.join() === '1,2,3,4,5') return 'Weekdays';
    if (d.join() === '0,6') return 'Weekends';
    return 'Every ' + d.map(x => DAY_SHORT[x]).join(', ');
  }
  function partWindow(name, s) {
    s = cfg(s);
    switch (String(name || '').toLowerCase()) {
      case 'first': return { from: s.dayStart, to: s.dayStart + 90 };
      case 'morning': return { from: 9 * 60, to: 12 * 60 };
      case 'lunch': return { from: 12 * 60, to: 14 * 60 };
      case 'afternoon': return { from: 12 * 60, to: 17 * 60 };
      case 'evening': return { from: 17 * 60 + 30, to: 21 * 60 + 30 };
      case 'night': return { from: 19 * 60, to: Math.max(s.dayEnd, 20 * 60) };
      case 'before bed': case 'bed': return { from: 20 * 60, to: Math.max(s.dayEnd, 21 * 60) };
      default: return null;
    }
  }

  /* ================================================================ parsing */

  const SMALL = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const MINWORDS = { five: 5, ten: 10, fifteen: 15, twenty: 20, 'twenty five': 25, thirty: 30, forty: 40, 'forty five': 45, ninety: 90 };
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const WD = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
  const PREP = '(at|by|before|after|from|around|about|@)';
  const TASK_VERBS = 'call|ring|phone|text|email|e-mail|message|reply|buy|get|grab|pick|collect|go|book|send|pay|make|cook|clean|tidy|wash|do|finish|start|write|read|study|revise|check|meet|walk|take|order|submit|fix|prep|prepare|post|drop|return|visit|feed|hoover|iron|shower|sort|plan|review|update|watch|learn|practise|practice|apply|hit|bin|put|renew|cancel|chase|ask|tell|remind|file|print|sign|charge|water|empty|change|move|clear|organise|organize|research|draft';
  const SHOP_LEAD = /^(?:buy|get|grab|pick\s+up|order|collect)\b/i;
  const FILLER = /^(?:(?:so|ok|okay|right|um+|uh+|erm+|like|also|and|then|plus|oh|yeah|well|first|firstly|next|lastly|finally|basically|anyway)\b[\s,]*)+/i;
  const LEAD = /^(?:i\s+(?:really\s+)?(?:need|have|want|got|gotta|must|should|ought)(?:\s+to)?|i've\s+got(?:\s+to)?|i'?m\s+going\s+to|i'?m|i\s+will|i'll|need\s+to|have\s+to|got\s+to|gotta|must|remember\s+to|don'?t\s+forget\s+to|remind\s+me\s+to|please|let'?s|going\s+to|gonna|try\s+to|to)\b\s*/i;
  const HIGH_ENERGY = /\b(essay|assignment|report|tax(es)?|tax return|deep clean|revis(e|ion)|study|presentation|proposal|accounts|budget|dissertation|exam|interview|deep work|write up|spring clean|declutter)\b/i;
  const LOW_ENERGY = /\b(quick|easy|small|simple|text|reply|bins?|water the plants|feed)\b/i;

  function stripLead(s) {
    let t = String(s).replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 4; i++) t = t.replace(FILLER, '').replace(LEAD, '').trim();
    return t;
  }

  function resolveHour(h, ap, ctx) {
    if (ap) {
      const a = ap[0].toLowerCase();
      if (a === 'p' && h < 12) h += 12;
      if (a === 'a' && h === 12) h = 0;
      return h;
    }
    if (h >= 12) return h;
    if (h <= 6) return h + 12;                                             // "at 3" means 3pm
    if (ctx.isToday && h * 60 < ctx.nowMin && h + 12 <= 23) return h + 12; // "at 7" said in the afternoon means 7pm
    return h;
  }

  function applyTime(res, prep, minutes) {
    const p = (prep || '').toLowerCase();
    if (p === 'by' || p === 'before') res.window = { to: minutes };
    else if (p === 'after') res.window = { from: minutes };
    else res.start = minutes;
  }

  function daysFromNames(text) {
    const out = [];
    const re = new RegExp(WD, 'gi');
    let m;
    while ((m = re.exec(text))) out.push(WEEKDAYS.indexOf(m[0].toLowerCase()));
    return out;
  }

  function parseOne(raw, ctx, s) {
    let w = ' ' + raw + ' ';
    const res = { start: null, window: null, duration: null, date: ctx.today, urgent: false, energy: null, repeat: null, someday: false };
    let mm;
    const cut = m => { w = w.replace(m, ' '); };

    // number words -> digits where they are clearly times or lengths
    w = w.replace(/\b(at|half(?:\s+past)?|quarter\s+(?:past|to)|around|about|by|before|after|from|until|till)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi,
      (_, a, b) => a + ' ' + SMALL[b.toLowerCase()]);
    w = w.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(o'?clock|am|pm)\b/gi,
      (_, a, b) => SMALL[a.toLowerCase()] + ' ' + b);
    w = w.replace(/\bfor\s+(?:an?|one)\s+hour\b/gi, 'for 60 min')
      .replace(/\b(?:for\s+)?an\s+hour\s+and\s+a\s+half\b/gi, 'for 90 min')
      .replace(/\b(?:for\s+)?half\s+an\s+hour\b/gi, 'for 30 min')
      .replace(/\bfor\s+(two|three|four)\s+hours?\b/gi, (_, n) => 'for ' + SMALL[n.toLowerCase()] * 60 + ' min')
      .replace(/\b(five|ten|fifteen|twenty[- ]five|twenty|thirty|forty[- ]five|forty|ninety)\s+(min|mins|minutes)\b/gi,
        (_, n) => MINWORDS[n.toLowerCase().replace('-', ' ')] + ' min');

    // repeats: "every tuesday and friday", "every morning", "daily", "on mondays"
    if ((mm = w.match(new RegExp('\\b(?:every|each)\\s+((?:' + WD + 's?(?:\\s*(?:,|and|&)\\s*)?)+)', 'i')))) {
      res.repeat = { days: daysFromNames(mm[1]) }; cut(mm[0]);
    } else if ((mm = w.match(/\b(?:every|each)\s+(?:single\s+)?(day|morning|afternoon|evening|night|weekday|week\s*day|weekend|week)s?\b|\bdaily\b/i))) {
      const unit = (mm[1] || 'day').toLowerCase().replace(/\s+/g, '');
      const days = unit === 'weekday' ? [1, 2, 3, 4, 5] : unit === 'weekend' ? [0, 6] : unit === 'week' ? [ctx.now.getDay()] : [0, 1, 2, 3, 4, 5, 6];
      res.repeat = { days };
      const keep = { morning: ' morning ', afternoon: ' afternoon ', evening: ' evening ', night: ' night ' }[unit] || ' ';
      w = w.replace(mm[0], keep);
    } else if ((mm = w.match(new RegExp('\\bon\\s+(' + WD + 's(?:\\s*(?:,|and|&)\\s*' + WD + 's)*)\\b', 'i')))) {
      res.repeat = { days: daysFromNames(mm[1]) }; cut(mm[0]);
    }
    if (res.repeat) res.repeat.days = Array.from(new Set(res.repeat.days)).filter(d => d >= 0).sort();

    // someday
    if (!res.repeat && (mm = w.match(/\b(?:some\s?day|one\s+day|at\s+some\s+point|eventually|some\s?time(?:\s+soon)?|whenever\s+i\s+(?:can|get\s+(?:a\s+)?(?:chance|time))|when\s+i\s+get\s+(?:a\s+)?(?:chance|time)|no\s+rush)\b/i))) {
      res.someday = true; cut(mm[0]);
    }

    // day
    if (!res.repeat && (mm = w.match(/\b(?:on\s+|this\s+|next\s+)?(today|tomorrow|tmrw|tomorow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i))) {
      const d = mm[1].toLowerCase();
      if (d === 'today') res.date = ctx.today;
      else if (d.startsWith('tom') || d === 'tmrw') res.date = addDays(ctx.today, 1);
      else {
        let diff = (WEEKDAYS.indexOf(d) - ctx.now.getDay() + 7) % 7;
        if (diff === 0) diff = 7;
        res.date = addDays(ctx.today, diff);
      }
      res.someday = false;
      cut(mm[0]);
    }
    const tctx = { isToday: !res.repeat && res.date === ctx.today, nowMin: ctx.nowMin };

    // ranges: "2-4pm", "from 2 to 3:30"
    if ((mm = w.match(/\b(?:from\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|to|till|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i)) ||
        (mm = w.match(/\bfrom\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|to|till|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?(?!\s*(?:min|hour|hr))\b/i))) {
      const end = resolveHour(+mm[4], mm[6], tctx) * 60 + (+mm[5] || 0);
      const sh = +mm[1];
      let start = resolveHour(sh, mm[3] || (mm[6] && sh <= +mm[4] ? mm[6] : null), tctx) * 60 + (+mm[2] || 0);
      if (start >= end) start -= 12 * 60;
      if (start >= 0 && end > start && end <= 1440) { res.start = start; res.duration = end - start; cut(mm[0]); }
    }

    if (res.start == null) {
      if ((mm = w.match(new RegExp('(?:\\b' + PREP + '\\s+)?half\\s+(?:past\\s+)?(\\d{1,2})\\b', 'i')))) {
        applyTime(res, mm[1], resolveHour(+mm[2], null, tctx) * 60 + 30); cut(mm[0]);
      } else if ((mm = w.match(new RegExp('(?:\\b' + PREP + '\\s+)?quarter\\s+(past|to)\\s+(\\d{1,2})\\b', 'i')))) {
        const h = resolveHour(+mm[3], null, tctx);
        applyTime(res, mm[1], mm[2].toLowerCase() === 'past' ? h * 60 + 15 : h * 60 - 15); cut(mm[0]);
      } else if ((mm = w.match(new RegExp('(?:\\b' + PREP + '\\s*)?\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)', 'i'))) && +mm[2] <= 12) {
        applyTime(res, mm[1], resolveHour(+mm[2], mm[4], tctx) * 60 + (+mm[3] || 0)); cut(mm[0]);
      } else if ((mm = w.match(new RegExp('(?:\\b' + PREP + '\\s*)?\\b([01]?\\d|2[0-3])[:.]([0-5]\\d)\\b', 'i')))) {
        applyTime(res, mm[1], resolveHour(+mm[2], null, tctx) * 60 + (+mm[3])); cut(mm[0]);
      } else if ((mm = w.match(new RegExp('\\b' + PREP + '\\s+(\\d{1,2})(?:\\s*o\'?clock)?\\b(?!\\s*(?:min|mins|minute|minutes|hour|hours|hr|hrs|h\\b|%|st|nd|rd|th|people|times|things|items|days|weeks|pounds|quid))', 'i'))) && +mm[2] <= 23) {
        applyTime(res, mm[1], resolveHour(+mm[2], null, tctx) * 60); cut(mm[0]);
      } else if ((mm = w.match(/\b(?:at\s+)?(noon|midday|12\s*noon)\b/i))) {
        res.start = 12 * 60; cut(mm[0]);
      }
    }

    // parts of the day (only when no exact time)
    const PARTS = [
      [/\bfirst\s+thing(?:\s+in\s+the\s+morning)?\b/i, 'first'],
      [/\b(?:this\s+|in\s+the\s+)?morning\b/i, 'morning'],
      [/\b(?:at\s+|over\s+|on\s+my\s+)?lunch(?:time|\s+break)?\b/i, 'lunch'],
      [/\b(?:this\s+|in\s+the\s+)?afternoon\b/i, 'afternoon'],
      [/\b(?:after\s+work|tonight|(?:this\s+|in\s+the\s+)?evening)\b/i, 'evening'],
      [/\bbefore\s+bed\b/i, 'bed'],
      [/\b(?:at\s+)?night\b/i, 'night']
    ];
    if (res.start == null && !res.window) {
      for (const [re, name] of PARTS) {
        if ((mm = w.match(re))) { res.window = partWindow(name, s); cut(mm[0]); break; }
      }
    } else {
      w = w.replace(/\b(?:this\s+|in\s+the\s+)?(?:morning|afternoon|evening)\b|\btonight\b|\b(?:at\s+)?night\b/i, ' ');
    }

    // duration
    if (res.duration == null && (mm = w.match(/\b(?:for\s+)?(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h)\b(?:\s+long)?/i))) {
      const n = parseFloat(mm[1]);
      res.duration = Math.round(/^h/i.test(mm[2]) ? n * 60 : n);
      cut(mm[0]);
    }

    // urgency + explicit energy
    if (/\b(urgent(?:ly)?|asap|a\.s\.a\.p|important|priority|critical)\b|!+/i.test(w)) {
      res.urgent = true;
      w = w.replace(/\b(urgent(?:ly)?|asap|a\.s\.a\.p|important|priority|critical)\b|!+/gi, ' ');
    }
    if ((mm = w.match(/\b(low|high)[- ]energy\b/i))) { res.energy = mm[1].toLowerCase(); cut(mm[0]); }

    // title
    let t = stripLead(w).replace(/^(?:a|an)\s+/i, '');
    for (let i = 0; i < 3; i++) t = t.replace(/[\s,\-–:]*\b(?:at|on|by|for|in|from|the|and|to|around|about|o'?clock|it's|its|is|every|each)\s*$/i, '').trim();
    t = t.replace(/^[\s,.\-–:]+|[\s,.\-–:]+$/g, '').replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ');
    if (t.length < 2) return null;
    res.title = (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 140);

    if (!res.energy) res.energy = HIGH_ENERGY.test(t) ? 'high' : LOW_ENERGY.test(t) ? 'low' : null;
    if (res.duration == null) {
      if (/\b(meds|medication|pills|tablets|vitamins)\b/i.test(t)) res.duration = 5;
      else if (/\b(quick|call|ring|phone|text|email|e-mail|reply|message|pay|book|order|post|bins?|renew|cancel)\b/i.test(t)) res.duration = 15;
      else if (/\b(gym|workout|run|clean|study|revise|revision|meeting|appointment|dentist|doctor|gp|shop|shopping|cook|essay|assignment|lecture|class|report)\b/i.test(t)) res.duration = 60;
      else res.duration = s.defaultDuration;
    }
    res.duration = Math.max(5, Math.min(res.duration, 8 * 60));
    if (res.start != null) res.start = Math.max(0, Math.min(res.start, 24 * 60 - 5));
    if (res.someday) { res.date = null; res.start = null; res.window = null; }
    if (res.repeat) res.date = null;
    return res;
  }

  function parse(text, now, settings) {
    now = now || new Date();
    const s = cfg(settings);
    const ctx = { now, today: dateKey(now), nowMin: minutesNow(now) };
    let src = ' ' + String(text || '').slice(0, 5000).replace(/[‘’]/g, "'") + ' ';
    // "gym at 6 and buy milk" -> two tasks; "milk and eggs" stays one
    src = src.replace(new RegExp('\\s+and\\s+(?=(?:also\\s+)?(?:i\\s+(?:need|have|want)\\s+to\\s+)?(?:' + TASK_VERBS + ')\\b)', 'gi'), ' ; ');
    const chunks = src.split(/\n+|;|\.(?=\s|$)|!(?=\s|$)|\?(?=\s|$)|,\s*(?:and\s+)?then\b|\s(?:and\s+)?then\s|\safter\s+that\s|\sand\s+also\s|,(?!\d)/i)
      .map(c => (c || '').trim()).filter(Boolean);
    // "buy milk, eggs and bread" -> keep the shopping list together
    const merged = [];
    for (const c of chunks) {
      const core = stripLead(c);
      const prev = merged[merged.length - 1];
      const words = core.split(/\s+/).filter(Boolean);
      const looksLikeListItem = words.length && words.length <= 3 && !/\d/.test(core) &&
        !new RegExp('^(?:' + TASK_VERBS + ')\\b', 'i').test(core) &&
        !/\b(today|tomorrow|tonight|morning|afternoon|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|every|urgent|asap)\b/i.test(core);
      if (prev && looksLikeListItem && SHOP_LEAD.test(stripLead(prev))) merged[merged.length - 1] = prev + ', ' + core;
      else merged.push(c);
    }
    const out = [];
    for (const c of merged) {
      const item = parseOne(c, ctx, s);
      if (item) out.push(item);
    }
    return out.slice(0, 50);
  }

  /* ========================================================== item checking */

  // Cleans an item from any source (the browser, the AI, WhatsApp) before it touches state.
  function sanitizeItem(i, now, settings) {
    if (!i || typeof i !== 'object') return null;
    const s = cfg(settings);
    const title = String(i.title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (title.length < 2) return null;
    const out = {
      title,
      date: isDateKey(i.date) ? i.date : (i.someday || i.repeat ? null : dateKey(now || new Date())),
      start: i.start == null || i.start === '' ? null : clampInt(i.start, 0, 1435),
      duration: clampInt(i.duration, 5, 480) || s.defaultDuration,
      window: null,
      urgent: !!i.urgent,
      energy: i.energy === 'low' || i.energy === 'high' ? i.energy : null,
      someday: !!i.someday,
      repeat: null,
      steps: Array.isArray(i.steps) ? i.steps.map(x => String(typeof x === 'object' && x ? x.text : x).trim().slice(0, 120)).filter(Boolean).slice(0, 12) : []
    };
    if (i.window && typeof i.window === 'object') {
      const from = i.window.from == null ? null : clampInt(i.window.from, 0, 1440);
      const to = i.window.to == null ? null : clampInt(i.window.to, 0, 1440);
      if (from != null || to != null) {
        out.window = {};
        if (from != null) out.window.from = from;
        if (to != null) out.window.to = to;
        if (from != null && to != null && to <= from) out.window = null;
      }
    }
    if (i.repeat && Array.isArray(i.repeat.days)) {
      const days = Array.from(new Set(i.repeat.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))).sort();
      if (days.length) { out.repeat = { days }; out.date = null; out.someday = false; }
    }
    if (out.someday) { out.date = null; out.start = null; out.window = null; }
    return out;
  }

  /* ================================================================ planning */

  function findSlot(tasks, t, settings, now, notBefore) {
    const s = cfg(settings);
    const today = dateKey(now), nowMin = minutesNow(now);
    if (!t.date || t.date < today) return null;
    const busy = tasks
      .filter(x => x.id !== t.id && x.date === t.date && x.start != null && !x.done)
      .map(x => [x.start - s.buffer, x.start + x.duration + s.buffer]);
    const free = c => busy.every(b => !(c < b[1] && c + t.duration > b[0]));
    const tryRange = (from, to) => {
      if (t.date === today) from = Math.max(from, Math.ceil((nowMin + 5) / 5) * 5);
      if (notBefore != null) from = Math.max(from, notBefore);
      from = Math.ceil(from / 5) * 5;
      for (let c = from; c + t.duration <= to; c += 5) if (free(c)) return c;
      return null;
    };
    const win = t.window || {};
    const first = tryRange(Math.max(s.dayStart, win.from != null ? win.from : 0), Math.min(s.dayEnd, win.to != null ? win.to : 1440));
    if (first != null) return first;
    if (t.window) return tryRange(s.dayStart, s.dayEnd); // window gone? fit it anywhere that day
    return null;
  }

  function makeTask(it, now, settings, order) {
    const s = cfg(settings);
    return {
      id: uid(),
      title: String(it.title || '').slice(0, 140),
      date: it.someday ? null : (it.date || dateKey(now)),
      start: it.start != null ? it.start : null,
      duration: it.duration || s.defaultDuration,
      fixed: it.start != null,
      window: it.window || null,
      urgent: !!it.urgent,
      energy: it.energy || null,
      someday: !!it.someday,
      steps: (it.steps || []).map(x => ({ id: uid(), text: String(x).slice(0, 120), done: false })),
      routineId: it.routineId || null,
      done: false,
      ack: false,
      notified: {},
      unplaced: false,
      example: !!it.example,
      createdAt: Date.now(),
      _order: order || 0
    };
  }

  function addItems(tasks, items, settings, now) {
    now = now || new Date();
    const out = tasks.slice();
    const made = items.map((it, i) => makeTask(it, now, settings, i)).filter(t => t.title);
    const queue = made.slice().sort((a, b) => (b.fixed - a.fixed) || (b.urgent - a.urgent) || (a._order - b._order));
    for (const t of queue) {
      if (!t.fixed && !t.someday) {
        t.start = findSlot(out, t, settings, now);
        t.unplaced = t.start == null;
      }
      out.push(t);
    }
    made.forEach(t => delete t._order);
    return { tasks: out, added: made };
  }

  function dayList(tasks, date) {
    return tasks.filter(t => t.date === date && !t.done && t.start != null).sort((a, b) => a.start - b.start);
  }

  function whenLabel(it) {
    if (it.someday) return 'Someday';
    if (it.repeat && it.repeat.days) return daysLabel(it.repeat.days) + (it.start != null ? ' ' + fmt(it.start) : '');
    if (it.start != null) return fmt(it.start);
    if (it.window && it.window.to != null && it.window.from == null) return 'by ' + fmt(it.window.to);
    if (it.window && it.window.from != null && it.window.to == null) return 'after ' + fmt(it.window.from);
    if (it.window) return fmt(it.window.from) + '–' + fmt(it.window.to);
    return 'fit it in';
  }

  /* ========================================================= state ops */

  function ensure(state) {
    state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
    state.routines = Array.isArray(state.routines) ? state.routines : [];
    state.routineLog = state.routineLog && typeof state.routineLog === 'object' ? state.routineLog : {};
    state.energy = state.energy && typeof state.energy === 'object' ? state.energy : {};
    state.settings = sanitizeSettings(state.settings || {});
    return state;
  }
  const find = (state, id) => state.tasks.find(t => t.id === id);
  function replace(state, t, now) {
    t.start = null;
    t.start = findSlot(state.tasks, t, state.settings, now);
    t.unplaced = t.start == null;
  }

  // Create today's (and the next week's) copies of repeating tasks.
  function materialize(state, now, days) {
    ensure(state);
    now = now || new Date();
    days = days || 8;
    const today = dateKey(now), nowMin = minutesNow(now);
    const created = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(today, i), wd = weekdayOf(date);
      for (const r of state.routines) {
        if (!Array.isArray(r.days) || !r.days.includes(wd)) continue;
        const key = r.id + ':' + date;
        if (state.routineLog[key]) continue;
        state.routineLog[key] = 1;
        if (date === today && r.start != null && r.start < nowMin) continue; // already passed today
        const t = makeTask({ title: r.title, date, start: r.start, duration: r.duration, window: r.window, urgent: r.urgent, energy: r.energy, steps: r.steps, routineId: r.id }, now, state.settings);
        delete t._order;
        if (!t.fixed) {
          t.start = findSlot(state.tasks, t, state.settings, now);
          if (t.start == null) { if (date === today) continue; t.unplaced = true; }
        }
        state.tasks.push(t);
        created.push(t);
      }
    }
    const cutoff = addDays(today, -30);
    for (const k of Object.keys(state.routineLog)) if (k.slice(-10) < cutoff) delete state.routineLog[k];
    for (const k of Object.keys(state.energy)) if (k < addDays(today, -14)) delete state.energy[k];
    return created;
  }

  const ops = {
    ensure,
    materialize,

    addItems(state, items, now) {
      ensure(state);
      now = now || new Date();
      const plain = [], routines = [];
      for (const raw of items || []) {
        const it = sanitizeItem(raw, now, state.settings);
        if (!it) continue;
        if (it.repeat) {
          const r = { id: uid(), title: it.title, days: it.repeat.days, start: it.start, window: it.window, duration: it.duration, urgent: it.urgent, energy: it.energy, steps: it.steps, createdAt: Date.now() };
          state.routines.push(r);
          routines.push(r);
        } else {
          plain.push(Object.assign(it, { example: !!(raw && raw.example) }));
        }
      }
      const res = addItems(state.tasks, plain, state.settings, now);
      state.tasks = res.tasks;
      const fromRoutines = routines.length ? materialize(state, now) : [];
      return { added: res.added.concat(fromRoutines.filter(t => routines.some(r => r.id === t.routineId))), routines };
    },

    action(state, id, action, now) {
      ensure(state);
      now = now || new Date();
      const today = dateKey(now), nowMin = minutesNow(now);
      const t = find(state, id);
      if (!t) return { ok: false, error: 'That task no longer exists.' };
      switch (action) {
        case 'delete':
          state.tasks = state.tasks.filter(x => x.id !== id);
          return { ok: true, task: t };
        case 'done':
          t.done = true; t.doneAt = Date.now(); t.ack = true; break;
        case 'undo':
          t.done = false; delete t.doneAt; break;
        case 'snooze': {
          if (t.someday || !t.date) return ops.action(state, id, 'today', now);
          const base = t.date === today ? Math.max(t.start != null ? t.start : nowMin, nowMin) : (t.start != null ? t.start : state.settings.dayStart);
          const next = Math.ceil((base + 15) / 5) * 5;
          if (next + t.duration > 24 * 60) return ops.action(state, id, 'tomorrow', now);
          if (t.date < today) t.date = today;
          t.start = next; t.notified = {}; t.unplaced = false; t.window = null; t.ack = true;
          break;
        }
        case 'tomorrow':
          t.date = addDays(!t.date || t.date < today ? today : t.date, 1);
          t.someday = false; t.notified = {}; t.done = false; t.ack = true; t.window = null;
          if (!t.fixed) replace(state, t, now);
          break;
        case 'place':
        case 'today':
          if (!t.date || t.date < today || action === 'today') t.date = today;
          t.someday = false; t.window = null; t.fixed = false; t.notified = {}; t.ack = true;
          replace(state, t, now);
          break;
        case 'startnow':
          if (!t.date || t.date !== today) t.date = today;
          t.someday = false; t.window = null; t.fixed = true; t.notified = { pre: true, start: true }; t.ack = true;
          t.start = Math.floor(nowMin / 5) * 5; t.unplaced = false;
          break;
        case 'someday':
          t.date = null; t.start = null; t.window = null; t.fixed = false; t.someday = true; t.unplaced = false; t.notified = {};
          break;
        default:
          return { ok: false, error: 'Unknown action.' };
      }
      return { ok: true, task: t };
    },

    setSteps(state, id, steps) {
      ensure(state);
      const t = find(state, id);
      if (!t) return { ok: false, error: 'That task no longer exists.' };
      const clean = (Array.isArray(steps) ? steps : []).slice(0, 12).map(x => ({
        id: x && typeof x.id === 'string' && x.id.length < 40 ? x.id : uid(),
        text: String(x && x.text != null ? x.text : x || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        done: !!(x && x.done)
      })).filter(x => x.text);
      t.steps = clean;
      let autoDone = false;
      if (clean.length && clean.every(x => x.done) && !t.done) { t.done = true; t.doneAt = Date.now(); t.ack = true; autoDone = true; }
      return { ok: true, task: t, autoDone };
    },

    // "I'm overwhelmed": keep set-time items and the top `keep` flexible ones, move the rest to tomorrow.
    rescue(state, date, now, opts) {
      ensure(state);
      now = now || new Date();
      opts = opts || {};
      const keep = opts.keep == null ? 3 : opts.keep;
      const today = dateKey(now), nowMin = minutesNow(now);
      if (!date || date < today) date = today;
      const inProgress = t => date === today && t.start != null && t.start <= nowMin && nowMin < t.start + t.duration;
      const flexible = state.tasks.filter(t => t.date === date && !t.done && !t.someday && !t.fixed && !inProgress(t));
      const rank = t => (t.energy === 'low' ? 0 : t.energy === 'high' ? 2 : 1);
      flexible.sort((a, b) => (b.urgent - a.urgent) || (opts.preferLow ? rank(a) - rank(b) : 0) ||
        ((a.start == null ? 9999 : a.start) - (b.start == null ? 9999 : b.start)));
      const kept = flexible.slice(0, keep), moved = flexible.slice(keep);
      const tomorrow = addDays(date, 1);
      for (const t of moved) {
        t.rescuedFrom = date; t.date = tomorrow; t.notified = {}; t.window = null;
        replace(state, t, now);
      }
      for (const t of kept) {
        if (t.start == null || (date === today && t.start + t.duration <= nowMin)) { t.window = null; replace(state, t, now); }
      }
      return { moved: moved.map(t => t.id), kept: kept.map(t => t.id) };
    },

    unrescue(state, ids, now) {
      ensure(state);
      now = now || new Date();
      const today = dateKey(now);
      let n = 0;
      for (const id of ids || []) {
        const t = find(state, id);
        if (!t || !t.rescuedFrom) continue;
        t.date = t.rescuedFrom < today ? today : t.rescuedFrom;
        delete t.rescuedFrom;
        t.notified = {};
        replace(state, t, now);
        n++;
      }
      return { restored: n };
    },

    energy(state, date, level, now) {
      ensure(state);
      now = now || new Date();
      const today = dateKey(now), nowMin = minutesNow(now);
      if (!isDateKey(date)) date = today;
      if (!['low', 'ok', 'high'].includes(level)) return { ok: false, error: 'Pick low, ok or high.' };
      state.energy[date] = level;
      if (level === 'low') {
        const r = ops.rescue(state, date, now, { keep: 3, preferLow: true });
        return { ok: true, moved: r.moved, message: r.moved.length
          ? 'Low energy day. Kept the 3 easiest things and moved ' + r.moved.length + ' to tomorrow.'
          : 'Low energy day. Your plan is already light, so just do the next thing.' };
      }
      if (level === 'high') {
        const notStarted = t => date !== today || t.start == null || t.start > nowMin;
        const flex = state.tasks.filter(t => t.date === date && !t.done && !t.someday && !t.fixed && notStarted(t));
        flex.sort((a, b) => (b.urgent - a.urgent) || ((b.energy === 'high') - (a.energy === 'high')) || ((a.start || 0) - (b.start || 0)));
        flex.forEach(t => { t.start = null; });
        flex.forEach(t => { t.notified = {}; replace(state, t, now); });
        return { ok: true, moved: [], message: flex.some(t => t.energy === 'high') ? 'Good energy. The hardest thing is now first.' : 'Good energy. Make the most of it.' };
      }
      return { ok: true, moved: [], message: 'Got it. Plan stays as it is.' };
    },

    deleteRoutine(state, id, now) {
      ensure(state);
      now = now || new Date();
      const today = dateKey(now);
      const before = state.routines.length;
      state.routines = state.routines.filter(r => r.id !== id);
      state.tasks = state.tasks.filter(t => !(t.routineId === id && !t.done && t.date && t.date > today));
      return { ok: state.routines.length < before };
    }
  };

  /* ================================================================ messages */

  function digest(state, date) {
    const list = dayList(state.tasks, date);
    if (!list.length) return 'Good morning. Nothing planned yet. Text me what\'s on your mind and I\'ll lay out your day.';
    const lines = list.slice(0, 12).map(t => '• ' + fmt(t.start) + ' — ' + t.title + (t.urgent ? ' (urgent)' : ''));
    if (list.length > 12) lines.push('…and ' + (list.length - 12) + ' more');
    return 'Good morning. Here\'s today, one thing at a time:\n' + lines.join('\n');
  }

  function weeklyRecap(state, now) {
    const since = now.getTime() - 7 * 24 * 3600 * 1000;
    const done = state.tasks.filter(t => t.done && t.doneAt && t.doneAt >= since);
    const today = dateKey(now);
    const missed = state.tasks.filter(t => !t.done && t.date && t.date < today && t.date >= addDays(today, -7)).length;
    if (!done.length) return 'Weekly reset: a quiet week, and that\'s okay. Tomorrow is a fresh page. Text me what\'s on your mind for Monday.';
    const top = done.slice(-3).map(t => t.title).join(', ');
    return 'Weekly reset: you finished ' + done.length + ' thing' + (done.length === 1 ? '' : 's') + ' this week, including ' + top + '.' +
      (missed ? ' ' + missed + ' slipped. Reply TODAY to see what\'s next, or just leave them.' : ' Nothing slipped. Nice work.');
  }

  return {
    DEFAULTS, sanitizeSettings, sanitizeItem, parse, addItems, findSlot, dayList, digest, weeklyRecap, whenLabel,
    partWindow, daysLabel, fmt, fmtDur, hhmm, fromHHMM, dateKey, addDays, weekdayOf, minutesNow, isDateKey, uid, ops
  };
});
