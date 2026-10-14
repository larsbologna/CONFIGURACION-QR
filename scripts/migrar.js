'use strict';
const { loadConfig } = require('../src/config');
const { openDb, migrate } = require('../src/db');
const { createBackup } = require('../src/services/backup');

const config = loadConfig();
const db = openDb(config.dbFile);
const applied = migrate(db, { backupFn: (r) => console.log(`Copia previa: ${createBackup(db, config, r).path}`) });
console.log(applied.length ? `Migraciones aplicadas: ${applied.join(', ')}` : 'La base ya estaba actualizada.');
db.close();
