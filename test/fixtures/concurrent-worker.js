'use strict';
// Proceso independiente que crea lotes contra la misma base (prueba de concurrencia).
const { loadConfig } = require('../../src/config');
const { openDb } = require('../../src/db');
const { createBatch } = require('../../src/services/numbering');

const [dbFile, versionId, batches, qty] = process.argv.slice(2);
const config = loadConfig({ PUBLIC_BASE_URL: 'https://qr.ejemplo-real.com.ar' });
const db = openDb(dbFile);
for (let i = 0; i < Number(batches); i++) {
  createBatch(db, config, null, { designVersionId: Number(versionId), quantity: Number(qty), format: {}, placement: 'plancha', numberFits: true });
}
db.close();
