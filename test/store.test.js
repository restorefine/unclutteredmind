'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../lib/store.js');

const log = () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'um-store-'));

test('saves, updates and deletes rows, and reloads them', () => {
  const dir = tmp(), file = path.join(dir, 'x.db');
  let s = openStore({ file, log });
  const state = { version: 3, tasks: [{ id: 'a', title: 'one' }, { id: 'b', title: 'two' }], routines: [{ id: 'r', title: 'meds' }], settings: { quiet: true }, meta: {} };
  s.save(state);
  state.tasks[0].title = 'one!';
  state.tasks.splice(1, 1);
  state.routines = [];
  s.save(state);
  s.close();
  s = openStore({ file, log });
  const back = s.load();
  assert.deepStrictEqual(back.tasks, [{ id: 'a', title: 'one!' }]);
  assert.deepStrictEqual(back.routines, []);
  assert.deepStrictEqual(back.settings, { quiet: true });
  s.close();
});

test('imports an old data.json once and keeps it as .imported', () => {
  const dir = tmp(), json = path.join(dir, 'data.json'), file = path.join(dir, 'x.db');
  fs.writeFileSync(json, JSON.stringify({ version: 2, tasks: [{ id: 't1', title: 'buy milk' }], routines: [], energy: { '2026-10-11': 'low' }, settings: {}, meta: { secret: 'abc' } }));
  const s = openStore({ file, legacyJson: json, log });
  const back = s.load();
  assert.equal(back.tasks[0].title, 'buy milk');
  assert.equal(back.meta.secret, 'abc');
  assert.ok(!fs.existsSync(json) && fs.existsSync(json + '.imported'));
  s.close();
});

test('backupTo writes a readable copy', () => {
  const dir = tmp(), file = path.join(dir, 'x.db'), copy = path.join(dir, 'copy.db');
  const s = openStore({ file, log });
  s.save({ tasks: [{ id: 'a', title: 'one' }], routines: [], meta: {} });
  s.backupTo(copy);
  s.close();
  const c = openStore({ file: copy, log });
  assert.equal(c.load().tasks[0].title, 'one');
  c.close();
});
