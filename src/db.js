'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function nowIso() {
  return new Date().toISOString();
}

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA synchronous = NORMAL');
  db._txDepth = 0;
  return db;
}

/**
 * Ejecuta fn dentro de una transacción BEGIN IMMEDIATE (toma el lock de
 * escritura al empezar, así dos procesos no pueden leer el mismo contador).
 * fn debe ser síncrona: no puede haber await dentro de una transacción.
 */
function tx(db, fn) {
  if (db._txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  db._txDepth++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('tx(): la función no puede ser asíncrona');
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ya revertida */ }
    throw err;
  } finally {
    db._txDepth--;
  }
}

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

function appliedMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  return new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
}

/**
 * Aplica migraciones pendientes, cada una en su transacción.
 * Si la base ya tenía datos, antes se hace una copia de seguridad.
 */
function migrate(db, { backupFn } = {}) {
  const applied = appliedMigrations(db);
  const pending = listMigrations().filter((f) => !applied.has(f));
  if (pending.length === 0) return [];
  if (applied.size > 0 && backupFn) backupFn('antes-de-migrar');
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    tx(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)').run(file, nowIso());
    });
  }
  return pending;
}

module.exports = { openDb, tx, migrate, nowIso };
