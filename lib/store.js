/*
 * SQLite storage (Node's built-in node:sqlite, so still no npm dependencies).
 *
 * The app works on one in-memory state object; save() writes only the rows that
 * changed, inside a single transaction. Tables:
 *   tasks(id, data)      one row per task, data is the task as JSON
 *   routines(id, data)   one row per repeat
 *   kv(key, value)       routineLog, energy, settings, meta, passkeys, version
 *
 * On first start, an existing data.json is imported and renamed to data.json.imported.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let DatabaseSync;
function loadSqlite() {
  if (DatabaseSync) return DatabaseSync;
  // node:sqlite prints an "experimental" warning on some Node versions; it is stable enough for this use.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w && w.message || w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (e) { throw new Error('This Node version has no built-in SQLite. Use Node 22.13 or newer.'); }
  finally { process.emitWarning = emit; }
  return DatabaseSync;
}

const KV_KEYS = ['version', 'routineLog', 'energy', 'settings', 'meta', 'passkeys'];

function openStore({ file, legacyJson, log }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const Sqlite = loadSqlite();
  const sql = new Sqlite(file);
  sql.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS tasks    (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kv       (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const q = {
    upsert: {
      tasks: sql.prepare('INSERT INTO tasks (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
      routines: sql.prepare('INSERT INTO routines (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
    },
    del: {
      tasks: sql.prepare('DELETE FROM tasks WHERE id = ?'),
      routines: sql.prepare('DELETE FROM routines WHERE id = ?'),
    },
    kvSet: sql.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  // What is on disk, so save() only writes changes.
  const written = { tasks: new Map(), routines: new Map(), kv: new Map() };

  function load() {
    const state = {};
    for (const table of ['tasks', 'routines']) {
      state[table] = sql.prepare(`SELECT id, data FROM ${table} ORDER BY rowid`).all().map(r => {
        written[table].set(r.id, r.data);
        return JSON.parse(r.data);
      });
    }
    for (const r of sql.prepare('SELECT key, value FROM kv').all()) {
      written.kv.set(r.key, r.value);
      state[r.key] = JSON.parse(r.value);
    }
    return state;
  }

  function isEmpty() {
    return !sql.prepare('SELECT 1 FROM kv LIMIT 1').get() && !sql.prepare('SELECT 1 FROM tasks LIMIT 1').get();
  }

  function save(state) {
    sql.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['tasks', 'routines']) {
        const seen = new Set();
        for (const row of state[table] || []) {
          if (!row || !row.id) continue;
          seen.add(row.id);
          const data = JSON.stringify(row);
          if (written[table].get(row.id) !== data) { q.upsert[table].run(row.id, data); written[table].set(row.id, data); }
        }
        for (const id of [...written[table].keys()]) {
          if (!seen.has(id)) { q.del[table].run(id); written[table].delete(id); }
        }
      }
      for (const key of KV_KEYS) {
        if (state[key] === undefined) continue;
        const value = JSON.stringify(state[key]);
        if (written.kv.get(key) !== value) { q.kvSet.run(key, value); written.kv.set(key, value); }
      }
      sql.exec('COMMIT');
    } catch (e) {
      sql.exec('ROLLBACK');
      // Forget the cache so the next save rewrites everything.
      for (const m of Object.values(written)) m.clear();
      throw e;
    }
  }

  // Consistent copy of the live database, safe while the app is running.
  function backupTo(target) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    sql.prepare('VACUUM INTO ?').run(target);
  }

  function close() { try { sql.close(); } catch (_) { /* already closed */ } }

  // One-time import of the old JSON file.
  let imported = null;
  if (legacyJson && fs.existsSync(legacyJson) && isEmpty()) {
    imported = JSON.parse(fs.readFileSync(legacyJson, 'utf8'));
    save(imported);
    fs.renameSync(legacyJson, legacyJson + '.imported');
    log('info', 'imported data.json into the database', { tasks: (imported.tasks || []).length, kept: legacyJson + '.imported' });
  }

  return { load, save, backupTo, close };
}

module.exports = { openStore };
