'use strict';
const fs = require('node:fs');
const path = require('node:path');

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Copia consistente de la base (VACUUM INTO) + diseños subidos. */
function createBackup(db, config, reason = 'manual') {
  const safeReason = String(reason).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'manual';
  let dir = path.join(config.backupDir, `${stamp()}-${safeReason}`);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(config.backupDir, `${stamp()}-${safeReason}-${i}`);
  fs.mkdirSync(dir, { recursive: true });
  db.prepare('VACUUM INTO ?').run(path.join(dir, 'qr.db'));
  if (fs.existsSync(config.uploadsDir)) {
    fs.cpSync(config.uploadsDir, path.join(dir, 'uploads'), { recursive: true });
  }
  return { name: path.basename(dir), path: dir };
}

function listBackups(config) {
  if (!fs.existsSync(config.backupDir)) return [];
  return fs.readdirSync(config.backupDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(config.backupDir, d.name, 'qr.db')))
    .map((d) => {
      const st = fs.statSync(path.join(config.backupDir, d.name, 'qr.db'));
      return { name: d.name, size_bytes: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

module.exports = { createBackup, listBackups };
