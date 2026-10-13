'use strict';
/*
 * Works out which WhatsApp messages are due right now.
 * Pure function: give it the state and a time, it returns the messages and marks
 * tasks as notified, so nothing is ever sent twice (even after a restart).
 */
const P = require('../public/shared.js');

const taskButtons = t => [
  { id: 'done:' + t.id, title: 'Done' },
  { id: 'snooze:' + t.id, title: '+15 min' },
  { id: 'tomorrow:' + t.id, title: 'Tomorrow' }
];
const TASK_HINT = 'Reply DONE, SNOOZE or SKIP.';
const ENERGY_BUTTONS = [
  { id: 'energy:low', title: 'Low energy' },
  { id: 'energy:ok', title: 'OK' },
  { id: 'energy:high', title: 'High energy' }
];

function isQuiet(m, s) {
  if (s.quietStart === s.quietEnd) return false;
  return s.quietStart < s.quietEnd ? (m >= s.quietStart && m < s.quietEnd) : (m >= s.quietStart || m < s.quietEnd);
}

function firstStep(t) {
  const step = (t.steps || []).find(x => !x.done);
  return step ? step.text : null;
}

/**
 * @returns {{messages: Array<{kind:string,text:string,buttons?:Array,hint?:string,urgent?:boolean,taskId?:string}>, changed: boolean}}
 */
function due(state, now) {
  P.ops.ensure(state);
  state.meta = state.meta || {};
  const s = state.settings;
  const today = P.dateKey(now), m = P.minutesNow(now);
  const messages = [];
  let changed = false;

  // Morning plan + energy check-in
  if (state.meta.digestSent !== today && m >= s.digestTime && m < s.digestTime + 60) {
    state.meta.digestSent = today; changed = true;
    const ask = s.energyCheck && !state.energy[today];
    messages.push({
      kind: 'digest',
      text: P.digest(state, today) + (ask ? '\n\nHow\'s your energy today?' : '\n\nReply TODAY any time to see this again.'),
      buttons: ask ? ENERGY_BUTTONS : null,
      hint: ask ? 'Reply LOW, OK or HIGH.' : null
    });
  }

  // Sunday evening reset
  if (s.weeklyRecap && now.getDay() === 0 && state.meta.recapSent !== today && m >= 19 * 60 && m < 20 * 60) {
    state.meta.recapSent = today; changed = true;
    messages.push({ kind: 'recap', text: P.weeklyRecap(state, now) });
  }

  const todays = P.dayList(state.tasks, today);
  for (const t of todays) {
    t.notified = t.notified || {};
    const n = t.notified;
    const end = t.start + t.duration;
    const next = todays.find(x => x.start >= end && x.id !== t.id);

    if (!n.pre && s.lead > 0 && m >= t.start - s.lead && m < t.start) {
      n.pre = true; changed = true;
      messages.push({ kind: 'pre', taskId: t.id, urgent: t.urgent,
        text: 'Heads up: ' + t.title + ' in ' + (t.start - m) + ' min (' + P.fmt(t.start) + '). Finish what you\'re doing and grab some water.' });
    }
    if (!n.start && m >= t.start) {
      n.start = n.pre = true; changed = true;
      if (m < t.start + 10) {
        const step = firstStep(t);
        messages.push({ kind: 'start', taskId: t.id, urgent: t.urgent, buttons: taskButtons(t), hint: TASK_HINT,
          text: 'Time for: ' + t.title + '\n' + P.fmtDur(t.duration) + ', until ' + P.fmt(end) + '.\n' +
            (step ? 'First step: ' + step : 'Just do the first 2 minutes.') });
      }
    }
    if (!n.nudge && m >= t.start + 5 && n.start) {
      n.nudge = true; changed = true;
      if (s.nudgeAgain && !t.ack && m < t.start + 20 && t.duration >= 15) {
        messages.push({ kind: 'nudge', taskId: t.id, urgent: t.urgent, buttons: taskButtons(t), hint: TASK_HINT,
          text: 'Still with me? "' + t.title + '" started at ' + P.fmt(t.start) + '. Even 2 minutes counts.' });
      }
    }
    if (!n.wrap && t.duration >= 45 && m >= end - 5 && m < end) {
      n.wrap = true; changed = true;
      if (s.wrapUp) {
        messages.push({ kind: 'wrap', taskId: t.id, urgent: t.urgent,
          text: '5 minutes left on "' + t.title + '". Start wrapping up' + (next ? '. Next: ' + next.title + ' at ' + P.fmt(next.start) + '.' : '.') });
      }
    }
    if (!n.end && m >= end) {
      n.end = n.wrap = n.nudge = n.start = n.pre = true; changed = true;
      if (m < end + 10) {
        messages.push({ kind: 'end', taskId: t.id, urgent: t.urgent, buttons: taskButtons(t), hint: TASK_HINT,
          text: 'Did you finish "' + t.title + '"?' });
      }
    }
  }
  return { messages, changed };
}

module.exports = { due, isQuiet, taskButtons, ENERGY_BUTTONS, TASK_HINT };
