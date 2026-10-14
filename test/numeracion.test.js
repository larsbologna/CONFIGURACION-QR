'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startApp, Client, createAdmin, uploadFixtureDesign, createBatch } = require('./helpers');
const { formatNumber } = require('../src/services/numbering');

test('formato de numeración', () => {
  assert.equal(formatNumber(1), '001');
  assert.equal(formatNumber(10), '010');
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(1000), '1000');
  assert.equal(formatNumber(1001), '1001');
  assert.equal(formatNumber(7, { prefix: 'QR-', min_digits: 4 }), 'QR-0007');
});

test('numeración: 1 unidad, 100 consecutivas, sin duplicados, nunca reutilizada', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  await c.login();
  const { version } = await uploadFixtureDesign(c);

  // 1. Una unidad
  const one = await createBatch(c, version.id, 1);
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.equal(one.body.first_display, '001');
  assert.equal(one.body.last_display, '001');
  assert.match(one.body.code, /^LOTE-\d{4}-001$/);

  // 2. Cien consecutivas
  const hundred = await createBatch(c, version.id, 100);
  assert.equal(hundred.status, 201);
  assert.equal(hundred.body.first_display, '002');
  assert.equal(hundred.body.last_display, '101');
  const rows = ctx.db.prepare('SELECT * FROM units WHERE batch_id = ? ORDER BY serial').all(hundred.body.id);
  assert.equal(rows.length, 100);
  rows.forEach((u, i) => {
    assert.equal(u.serial, 2 + i);
    assert.equal(u.display_number, String(2 + i).padStart(3, '0'));
    assert.equal(u.qr_url, `https://qr.ejemplo-real.com.ar/q/${u.public_id}`);
  });

  // 3. Sin duplicados en toda la base
  const dup = ctx.db.prepare(`SELECT
      (SELECT COUNT(*) - COUNT(DISTINCT serial) FROM units) AS s,
      (SELECT COUNT(*) - COUNT(DISTINCT display_number) FROM units) AS d,
      (SELECT COUNT(*) - COUNT(DISTINCT public_id) FROM units) AS p,
      (SELECT COUNT(*) - COUNT(DISTINCT qr_url) FROM units) AS q`).get();
  assert.deepEqual({ ...dup }, { s: 0, d: 0, p: 0, q: 0 });

  // Baja: el número no se reutiliza y la unidad no se puede borrar ni renumerar
  const last = rows[rows.length - 1];
  const baja = await c.req('POST', `/api/units/${last.id}/status`, { status: 'baja' });
  assert.equal(baja.status, 200);
  const react = await c.req('POST', `/api/units/${last.id}/status`, { status: 'activo' });
  assert.equal(react.status, 409);
  assert.throws(() => ctx.db.prepare('DELETE FROM units WHERE id = ?').run(last.id), /no se pueden eliminar/);
  assert.throws(() => ctx.db.prepare('UPDATE units SET serial = 5000 WHERE id = ?').run(last.id), /inmutables/);
  assert.throws(() => ctx.db.prepare('UPDATE units SET qr_url = ? WHERE id = ?').run('https://otro', last.id), /inmutables/);
  const next = await createBatch(c, version.id, 1);
  assert.equal(next.body.first_display, '102', 'tras dar de baja la 101, la siguiente es 102');

  // La versión usada queda bloqueada
  const edit = await c.req('PUT', `/api/design-versions/${version.id}/config`, { config: version.config });
  assert.equal(edit.status, 409);
});

test('numeración: más de 999 amplía el formato sin duplicar', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  await c.login();
  const { version } = await uploadFixtureDesign(c);
  const r = await createBatch(c, version.id, 1002);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.first_display, '001');
  assert.equal(r.body.last_display, '1002');
  const around = ctx.db.prepare('SELECT display_number FROM units WHERE serial BETWEEN 998 AND 1002 ORDER BY serial').all().map((x) => x.display_number);
  assert.deepEqual(around, ['998', '999', '1000', '1001', '1002']);
});

test('concurrencia: lotes simultáneos (HTTP y varios procesos) no duplican números', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  await c.login();
  const { version } = await uploadFixtureDesign(c);

  // 20 pedidos HTTP simultáneos de 25 unidades
  const results = await Promise.all(Array.from({ length: 20 }, () => createBatch(c, version.id, 25)));
  results.forEach((r) => assert.equal(r.status, 201, JSON.stringify(r.body)));

  // 4 procesos independientes escribiendo en la misma base a la vez
  const worker = path.join(__dirname, 'fixtures', 'concurrent-worker.js');
  const runs = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', worker, ctx.config.dbFile, String(version.id), '10', '15'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  }));
  await Promise.all(runs);

  const total = 20 * 25 + 4 * 10 * 15;
  const stats = ctx.db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT serial) AS d, MIN(serial) AS mn, MAX(serial) AS mx, COUNT(DISTINCT public_id) AS p FROM units').get();
  assert.equal(stats.n, total);
  assert.equal(stats.d, total);
  assert.equal(stats.p, total);
  assert.equal(stats.mn, 1);
  assert.equal(stats.mx, total, 'numeración contigua sin huecos ni saltos');
  // Los rangos de los lotes no se solapan
  const batches = ctx.db.prepare('SELECT first_serial, last_serial FROM batches ORDER BY first_serial').all();
  for (let i = 1; i < batches.length; i++) assert.equal(batches[i].first_serial, batches[i - 1].last_serial + 1);
  const codes = ctx.db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT code) AS d FROM batches').get();
  assert.equal(codes.n, codes.d);
});
