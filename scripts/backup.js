'use strict';
const { loadConfig } = require('../src/config');
const { openDb, migrate } = require('../src/db');
const { createBackup } = require('../src/services/backup');

const config = loadConfig();
const db = openDb(config.dbFile);
migrate(db);
const b = createBackup(db, config, process.argv[2] || 'manual');
console.log(`Copia de seguridad creada en: ${b.path}`);
db.close();
