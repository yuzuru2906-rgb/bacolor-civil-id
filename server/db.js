'use strict';
/*
 * Tiny database adapter.
 *   - DATABASE_URL set  -> PostgreSQL (use this on Render + Neon, data survives restarts)
 *   - DATABASE_URL empty -> SQLite file (zero-setup local development; needs Node 22.13+)
 *
 * All SQL in the app is written once with "?" placeholders and plain TEXT / INTEGER columns so
 * the same statements run on both engines.
 */

const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS residents (
     id            TEXT PRIMARY KEY,
     contact_key   TEXT NOT NULL,
     name          TEXT NOT NULL,
     region        TEXT,
     registered_at TEXT NOT NULL,
     verified      INTEGER NOT NULL DEFAULT 0,
     data          TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS residents_contact_key_uq ON residents (contact_key)`,
  // Photos live in their own table so listing residents never drags megabytes of base64 around.
  `CREATE TABLE IF NOT EXISTS resident_photos (
     resident_id TEXT NOT NULL,
     kind        TEXT NOT NULL,
     data        TEXT NOT NULL,
     PRIMARY KEY (resident_id, kind)
   )`,
  `CREATE TABLE IF NOT EXISTS credentials (
     resident_id   TEXT PRIMARY KEY,
     password_hash TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS family_profiles (
     id          TEXT PRIMARY KEY,
     phone_key   TEXT NOT NULL DEFAULT '',
     resident_id TEXT NOT NULL DEFAULT '',
     data        TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS family_profiles_phone_idx ON family_profiles (phone_key)`,
  `CREATE TABLE IF NOT EXISTS admins (
     username      TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     phone         TEXT NOT NULL DEFAULT '',
     password_hash TEXT NOT NULL,
     role          TEXT NOT NULL DEFAULT 'staff',
     created_at    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     kind       TEXT NOT NULL,
     subject    TEXT NOT NULL,
     expires_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_subject_idx ON sessions (kind, subject)`
];

/* A simple FIFO lock. Every write goes through it, so read-modify-write code (family links,
   verification, ID numbers) can never interleave inside this one server process. */
function makeLock() {
  let tail = Promise.resolve();
  return function withLock(fn) {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

/* ---------------- SQLite (local development) ---------------- */
function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const norm = (rows) => rows.map((r) => ({ ...r }));
  const api = {
    kind: 'sqlite',
    async query(sql, params = []) { return norm(raw.prepare(sql).all(...params)); },
    async run(sql, params = []) { const r = raw.prepare(sql).run(...params); return { changes: Number(r.changes) }; },
    async exec(sql) { raw.exec(sql); },
    async close() { raw.close(); }
  };
  const lock = makeLock();
  api.tx = (fn) => lock(async () => {
    raw.exec('BEGIN');
    try { const out = await fn(api); raw.exec('COMMIT'); return out; }
    catch (e) { try { raw.exec('ROLLBACK'); } catch (_) {} throw e; }
  });
  api.isUniqueViolation = (e) => /UNIQUE constraint failed/i.test(String(e && e.message));
  return api;
}

/* ---------------- PostgreSQL (production) ---------------- */
function openPostgres(url) {
  let pg;
  try { pg = require('pg'); } catch (e) { throw new Error('DATABASE_URL is set but the "pg" package is not installed. Run: npm install'); }
  const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 20000 });
  pool.on('error', (e) => console.error('Postgres pool error:', e.message));
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
  const mk = (runner) => ({
    kind: 'postgres',
    async query(sql, params = []) { return (await runner.query(toPg(sql), params)).rows; },
    async run(sql, params = []) { const r = await runner.query(toPg(sql), params); return { changes: r.rowCount }; },
    async exec(sql) { await runner.query(sql); }
  });
  const api = mk(pool);
  const lock = makeLock();
  api.tx = (fn) => lock(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(mk(client));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { client.release(); }
  });
  api.close = () => pool.end();
  api.isUniqueViolation = (e) => !!e && e.code === '23505';
  return api;
}

async function openDatabase(opts = {}) {
  const url = opts.databaseUrl !== undefined ? opts.databaseUrl : process.env.DATABASE_URL;
  const db = url
    ? openPostgres(url)
    : openSqlite(opts.sqliteFile || process.env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'bacolor.sqlite'));
  for (const stmt of SCHEMA) await db.exec(stmt);
  return db;
}

module.exports = { openDatabase };
