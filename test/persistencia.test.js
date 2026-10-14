'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { tmpDir, Client, uploadFixtureDesign, createBatch } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

async function startServer(env) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${env.PORT}/salud`)).ok) return p; } catch { /* aún no */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill(); throw new Error(`el servidor no arrancó: ${out}`);
}
const stop = (p) => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); });

test('los datos persisten al reiniciar el servidor; backup y migraciones', async () => {
  const dir = tmpDir();
  const env = { PORT: String(await freePort()), HOST: '127.0.0.1', DATA_DIR: dir, BACKUP_DIR: path.join(dir, 'backups'), PUBLIC_BASE_URL: 'https://qr.ejemplo-real.com.ar' };
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/crear-admin.js'], { cwd: ROOT, env: { ...process.env, ...env, ADMIN_USER: 'duenio', ADMIN_PASSWORD: 'una-clave-larga-1' } });

  let srv = await startServer(env);
  const base = `http://127.0.0.1:${env.PORT}`;
  let c = new Client(base);
  await c.login('duenio', 'una-clave-larga-1');
  const { version } = await uploadFixtureDesign(c);
  const b = await createBatch(c, version.id, 5);
  const u = (await c.req('GET', `/api/units?batch_id=${b.body.id}&order=asc`)).body.rows[0];
  await c.req('POST', `/api/units/${u.id}/destination`, { destination: { type: 'url', url: 'https://persistente.com.ar' } });
  await c.req('POST', `/api/units/${u.id}/status`, { status: 'activo' });
  const backup = await c.req('POST', '/api/backups', {});
  assert.equal(backup.status, 201);
  await stop(srv);

  srv = await startServer(env);
  try {
    c = new Client(base);
    await c.login('duenio', 'una-clave-larga-1');
    const again = await c.req('GET', `/api/units/${u.id}`);
    assert.equal(again.body.qr_url, u.qr_url);
    assert.equal(again.body.display_number, '001');
    assert.equal(again.body.destination_url, 'https://persistente.com.ar/');
    assert.equal(again.body.status, 'activo');
    const r = await fetch(`${base}${new URL(u.qr_url).pathname}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'https://persistente.com.ar/');
    const next = await createBatch(c, version.id, 1);
    assert.equal(next.body.first_display, '006', 'la numeración continúa después del reinicio');
    const backups = (await c.req('GET', '/api/backups')).body;
    assert.equal(backups.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'backups', backups[0].name, 'qr.db')));
    assert.ok(fs.readdirSync(path.join(dir, 'backups', backups[0].name, 'uploads')).length >= 1, 'la copia incluye los diseños');
  } finally {
    await stop(srv);
  }
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/migrar.js'], { cwd: ROOT, env: { ...process.env, ...env } }).toString();
  assert.match(out, /ya estaba actualizada/);
});
