'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/shared.js');

const MON_9 = new Date(2026, 9, 12, 9, 0);   // Monday 12 Oct 2026, 09:00
const MON_KEY = '2026-10-12';
const titles = items => items.map(i => i.title);

test('parser: messy brain dump becomes separate tasks', () => {
  const items = P.parse('um so I need to call the bank at 2, gym after work, buy milk, eggs and bread, and finish the report by 5pm urgent', MON_9);
  assert.deepEqual(titles(items), ['Call the bank', 'Gym', 'Buy milk, eggs and bread', 'Finish the report']);
  assert.equal(items[0].start, 14 * 60);
  assert.equal(items[0].duration, 15);
  assert.deepEqual(items[1].window, { from: 17 * 60 + 30, to: 21 * 60 + 30 });
  assert.deepEqual(items[3].window, { to: 17 * 60 });
  assert.equal(items[3].urgent, true);
});

test('parser: UK times', () => {
  const t = s => P.parse(s, MON_9)[0];
  assert.equal(t('call mum at half 3').start, 15 * 60 + 30);
  assert.equal(t('call mum at quarter to 4').start, 15 * 60 + 45);
  assert.equal(t('meeting at 14:30').start, 14 * 60 + 30);
  assert.equal(t('meeting at 9am').start, 9 * 60);
  assert.equal(t('lunch with Sam at noon').start, 12 * 60);
  const range = t('meeting with Sam from 2 to 3:30pm');
  assert.equal(range.start, 14 * 60); assert.equal(range.duration, 90);
  assert.equal(t('pay 20 pounds to Sam at 4').title, 'Pay 20 pounds to Sam');
});

test('parser: days, lengths, someday, repeats', () => {
  const t = s => P.parse(s, MON_9)[0];
  assert.equal(t('dentist at 9:15 on friday').date, '2026-10-16');
  assert.equal(t('dentist tomorrow at 10').date, '2026-10-13');
  assert.equal(t('revise for 2 hours').duration, 120);
  assert.equal(t('hoover for 20 minutes').duration, 20);
  assert.equal(t('read for half an hour').duration, 30);
  const sd = t('learn spanish someday');
  assert.equal(sd.someday, true); assert.equal(sd.date, null);
  const meds = t('take my meds every morning at 8');
  assert.deepEqual(meds.repeat.days, [0, 1, 2, 3, 4, 5, 6]); assert.equal(meds.start, 8 * 60); assert.equal(meds.duration, 5);
  assert.deepEqual(t('gym on mondays and thursdays at 6pm').repeat.days, [1, 4]);
  assert.deepEqual(t('check emails every weekday at 9').repeat.days, [1, 2, 3, 4, 5]);
  const bins = t('bins out every tuesday night');
  assert.deepEqual(bins.repeat.days, [2]); assert.ok(bins.window && bins.window.from >= 19 * 60);
});

test('parser: ignores empty and junk input', () => {
  assert.deepEqual(P.parse('', MON_9), []);
  assert.deepEqual(P.parse('um. so. and', MON_9), []);
  assert.ok(P.parse('x'.repeat(10000), MON_9).length <= 50);
});

test('sanitizeSettings clamps values and rejects a backwards day', () => {
  const s = P.sanitizeSettings({ buffer: 999, lead: -5, dayStart: 600, dayEnd: 500, energyCheck: 7, digestTime: 'abc' });
  assert.equal(s.buffer, 60); assert.equal(s.lead, 0); assert.equal(s.energyCheck, 1);
  assert.equal(s.dayStart, P.DEFAULTS.dayStart); assert.equal(s.dayEnd, P.DEFAULTS.dayEnd);
  assert.equal(s.digestTime, P.DEFAULTS.digestTime);
});

test('sanitizeItem rejects junk and trims', () => {
  assert.equal(P.sanitizeItem(null, MON_9), null);
  assert.equal(P.sanitizeItem({ title: ' ' }, MON_9), null);
  const i = P.sanitizeItem({ title: 'A'.repeat(500), start: 99999, duration: -3, window: { from: 900, to: 800 }, repeat: { days: [9, 'x', 2, 2] }, steps: ['one', '', { text: 'two' }] }, MON_9);
  assert.equal(i.title.length, 140); assert.equal(i.start, 1435); assert.equal(i.duration, 5);
  assert.equal(i.window, null); assert.deepEqual(i.repeat.days, [2]); assert.deepEqual(i.steps, ['one', 'two']);
});

test('addItems never double-books and leaves breathers', () => {
  const st = P.ops.ensure({});
  P.ops.addItems(st, P.parse('call bank at 10, email accountant, write report, buy milk, tidy desk', MON_9), MON_9);
  const day = P.dayList(st.tasks, MON_KEY);
  assert.equal(day.length, 5);
  for (let i = 1; i < day.length; i++) assert.ok(day[i].start >= day[i - 1].start + day[i - 1].duration + st.settings.buffer, 'overlap at ' + day[i].title);
  for (const t of day) assert.ok(t.start >= P.minutesNow(MON_9), 'scheduled in the past: ' + t.title);
});

test('actions: snooze, tomorrow, someday, today, startnow, done/undo, delete', () => {
  const st = P.ops.ensure({});
  const { added } = P.ops.addItems(st, [{ title: 'Write essay', date: MON_KEY, start: 600, duration: 60 }], MON_9);
  const id = added[0].id;
  P.ops.action(st, id, 'snooze', MON_9); assert.equal(st.tasks[0].start, 615);
  P.ops.action(st, id, 'tomorrow', MON_9); assert.equal(st.tasks[0].date, '2026-10-13');
  P.ops.action(st, id, 'someday', MON_9); assert.equal(st.tasks[0].someday, true); assert.equal(st.tasks[0].date, null);
  P.ops.action(st, id, 'today', MON_9); assert.equal(st.tasks[0].date, MON_KEY); assert.ok(st.tasks[0].start >= 545);
  P.ops.action(st, id, 'startnow', MON_9); assert.equal(st.tasks[0].start, 540);
  P.ops.action(st, id, 'done', MON_9); assert.equal(st.tasks[0].done, true);
  P.ops.action(st, id, 'undo', MON_9); assert.equal(st.tasks[0].done, false);
  assert.equal(P.ops.action(st, 'nope', 'done', MON_9).ok, false);
  assert.equal(P.ops.action(st, id, 'explode', MON_9).ok, false);
  P.ops.action(st, id, 'delete', MON_9); assert.equal(st.tasks.length, 0);
});

test('snooze late at night rolls to tomorrow', () => {
  const late = new Date(2026, 9, 12, 23, 50);
  const st = P.ops.ensure({});
  const { added } = P.ops.addItems(st, [{ title: 'Read', date: MON_KEY, start: 23 * 60 + 40, duration: 30 }], late);
  P.ops.action(st, added[0].id, 'snooze', late);
  assert.equal(st.tasks[0].date, '2026-10-13');
});

test('steps: ticking the last step finishes the task', () => {
  const st = P.ops.ensure({});
  const { added } = P.ops.addItems(st, [{ title: 'Do taxes', date: MON_KEY, steps: ['Find P60', 'Open HMRC site'] }], MON_9);
  const t = st.tasks[0];
  assert.equal(t.steps.length, 2);
  let r = P.ops.setSteps(st, added[0].id, [{ id: t.steps[0].id, text: t.steps[0].text, done: true }, t.steps[1]]);
  assert.equal(r.autoDone, false);
  r = P.ops.setSteps(st, added[0].id, t.steps.map(s => Object.assign({}, s, { done: true })));
  assert.equal(r.autoDone, true); assert.equal(st.tasks[0].done, true);
});

test('rescue keeps set-time tasks and the top 3, undo puts them back', () => {
  const st = P.ops.ensure({});
  P.ops.addItems(st, [
    { title: 'Dentist', date: MON_KEY, start: 15 * 60, duration: 60 },
    { title: 'Task A', date: MON_KEY }, { title: 'Task B', date: MON_KEY, urgent: true }, { title: 'Task C', date: MON_KEY },
    { title: 'Task D', date: MON_KEY }, { title: 'Task E', date: MON_KEY }, { title: 'Task F', date: MON_KEY }
  ], MON_9);
  const r = P.ops.rescue(st, MON_KEY, MON_9);
  assert.equal(r.moved.length, 3);
  const left = st.tasks.filter(t => t.date === MON_KEY).map(t => t.title).sort();
  assert.deepEqual(left, ['Dentist', 'Task A', 'Task B', 'Task C']);
  assert.ok(st.tasks.filter(t => t.date === '2026-10-13').every(t => t.start != null));
  P.ops.unrescue(st, r.moved, MON_9);
  assert.equal(st.tasks.filter(t => t.date === MON_KEY).length, 7);
});

test('energy: low keeps the easiest 3, high puts the big task first', () => {
  const st = P.ops.ensure({});
  P.ops.addItems(st, [
    { title: 'Email', date: MON_KEY, energy: 'low' }, { title: 'Essay', date: MON_KEY, energy: 'high' },
    { title: 'Text Sam', date: MON_KEY, energy: 'low' }, { title: 'Report', date: MON_KEY, energy: 'high' }, { title: 'Bins', date: MON_KEY, energy: 'low' }
  ], MON_9);
  const st2 = JSON.parse(JSON.stringify(st));
  const low = P.ops.energy(st, MON_KEY, 'low', MON_9);
  assert.equal(low.moved.length, 2);
  assert.deepEqual(st.tasks.filter(t => t.date === MON_KEY).map(t => t.title).sort(), ['Bins', 'Email', 'Text Sam']);
  P.ops.energy(st2, MON_KEY, 'high', MON_9);
  assert.equal(P.dayList(st2.tasks, MON_KEY)[0].energy, 'high');
  assert.equal(P.ops.energy(st, MON_KEY, 'wild', MON_9).ok, false);
});

test('repeats: created once per day, past times skipped, stop removes future copies', () => {
  const st = P.ops.ensure({});
  const r = P.ops.addItems(st, P.parse('take meds every day at 8, water plants every monday and thursday', MON_9), MON_9);
  assert.equal(r.routines.length, 2);
  const meds = st.routines.find(x => x.title === 'Take meds');
  const medsCopies = st.tasks.filter(t => t.routineId === meds.id);
  assert.equal(medsCopies.length, 7, '8am today has passed, so 7 of the next 8 days');
  assert.ok(!medsCopies.some(t => t.date === MON_KEY));
  assert.equal(P.ops.materialize(st, MON_9).length, 0, 'second run adds nothing');
  const plants = st.routines.find(x => x.title === 'Water plants');
  assert.deepEqual(st.tasks.filter(t => t.routineId === plants.id).map(t => P.weekdayOf(t.date)).sort(), [1, 1, 4]);
  // deleting one copy does not bring it back
  const one = medsCopies[0];
  P.ops.action(st, one.id, 'delete', MON_9);
  assert.equal(P.ops.materialize(st, MON_9).length, 0);
  P.ops.deleteRoutine(st, meds.id, MON_9);
  assert.equal(st.tasks.filter(t => t.routineId === meds.id).length, 0);
  assert.equal(st.routines.length, 1);
});

test('digest and weekly recap read well', () => {
  const st = P.ops.ensure({});
  assert.match(P.digest(st, MON_KEY), /Nothing planned yet/);
  P.ops.addItems(st, [{ title: 'Call bank', date: MON_KEY, start: 600, duration: 15, urgent: true }], MON_9);
  assert.match(P.digest(st, MON_KEY), /10am — Call bank \(urgent\)/);
  assert.match(P.weeklyRecap(st, MON_9), /quiet week/);
  P.ops.action(st, st.tasks[0].id, 'done', MON_9);
  st.tasks[0].doneAt = MON_9.getTime();
  assert.match(P.weeklyRecap(st, MON_9), /finished 1 thing/);
});
