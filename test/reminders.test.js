'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/shared.js');
const R = require('../lib/reminders.js');

const at = (h, m) => new Date(2026, 9, 12, h, m); // Monday
const KEY = '2026-10-12';

function stateWith(task) {
  const st = P.ops.ensure({ meta: { digestSent: KEY } });
  P.ops.addItems(st, [Object.assign({ date: KEY }, task)], at(6, 0));
  return st;
}
const kinds = r => r.messages.map(m => m.kind);

test('a 60 minute task gets heads-up, start, nudge, wrap-up and check-in exactly once', () => {
  const st = stateWith({ title: 'Essay', start: 14 * 60, duration: 60 });
  assert.deepEqual(kinds(R.due(st, at(13, 49))), []);
  assert.deepEqual(kinds(R.due(st, at(13, 50))), ['pre']);
  assert.deepEqual(kinds(R.due(st, at(13, 55))), []);
  const start = R.due(st, at(14, 0));
  assert.deepEqual(kinds(start), ['start']);
  assert.equal(start.messages[0].buttons.length, 3);
  assert.match(start.messages[0].buttons[0].id, /^done:/);
  assert.deepEqual(kinds(R.due(st, at(14, 5))), ['nudge']);
  assert.deepEqual(kinds(R.due(st, at(14, 55))), ['wrap']);
  assert.deepEqual(kinds(R.due(st, at(15, 0))), ['end']);
  assert.deepEqual(kinds(R.due(st, at(15, 1))), []);
});

test('no nudge when the person already replied', () => {
  const st = stateWith({ title: 'Call', start: 14 * 60, duration: 30 });
  R.due(st, at(14, 0));
  st.tasks[0].ack = true;
  assert.deepEqual(kinds(R.due(st, at(14, 6))), []);
});

test('first unfinished step appears in the start message', () => {
  const st = stateWith({ title: 'Taxes', start: 14 * 60, duration: 30, steps: ['Find P60', 'Log in'] });
  st.tasks[0].steps[0].done = true;
  const r = R.due(st, at(14, 1));
  assert.match(r.messages.find(m => m.kind === 'start').text, /First step: Log in/);
});

test('after a restart, old reminders are not sent late', () => {
  const st = stateWith({ title: 'Gym', start: 9 * 60, duration: 60 });
  const r = R.due(st, at(12, 0));
  assert.deepEqual(kinds(r), []);
  assert.ok(st.tasks[0].notified.end);
});

test('morning plan once a day, with energy buttons until energy is set', () => {
  const st = P.ops.ensure({ meta: {} });
  const r = R.due(st, at(8, 2));
  assert.deepEqual(kinds(r), ['digest']);
  assert.equal(r.messages[0].buttons.length, 3);
  assert.deepEqual(kinds(R.due(st, at(8, 3))), []);
  const st2 = P.ops.ensure({ meta: {}, energy: { [KEY]: 'ok' } });
  assert.equal(R.due(st2, at(8, 10)).messages[0].buttons, null);
  const st3 = P.ops.ensure({ meta: {} });
  assert.deepEqual(kinds(R.due(st3, at(9, 30))), [], 'missed the hour, skip it');
});

test('Sunday recap', () => {
  const st = P.ops.ensure({ meta: { digestSent: '2026-10-11' } });
  const r = R.due(st, new Date(2026, 9, 11, 19, 5));
  assert.deepEqual(kinds(r), ['recap']);
});

test('quiet hours wrap past midnight', () => {
  const s = P.sanitizeSettings({ quietStart: 22 * 60 + 30, quietEnd: 7 * 60 });
  assert.equal(R.isQuiet(23 * 60, s), true);
  assert.equal(R.isQuiet(6 * 60, s), true);
  assert.equal(R.isQuiet(12 * 60, s), false);
  assert.equal(R.isQuiet(12 * 60, P.sanitizeSettings({ quietStart: 600, quietEnd: 600 })), false);
});

test('settings can switch off the extra nudges', () => {
  const st = stateWith({ title: 'Essay', start: 14 * 60, duration: 60 });
  st.settings = P.sanitizeSettings({ nudgeAgain: 0, wrapUp: 0, lead: 0 });
  const all = [];
  for (let m = 13 * 60 + 40; m <= 15 * 60 + 5; m++) all.push(...kinds(R.due(st, at(Math.floor(m / 60), m % 60))));
  assert.deepEqual(all, ['start', 'end']);
});
