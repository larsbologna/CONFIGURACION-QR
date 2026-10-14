'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, Client, createAdmin, createBatch, tmpDir } = require('./helpers');
const { makeFixture } = require('./fixtures/make-fixture');
const { unitPage } = require('../src/services/publish');

const BASE = 'https://larsbologna.github.io/CONFIGURACION-QR';

test('páginas estáticas: una por QR, según estado y destino', () => {
  const u = { status: 'activo', destination_type: 'url', destination_url: 'https://ejemplo-real.com.ar/carta?a=1&b=2' };
  const html = unitPage(u);
  assert.match(html, /http-equiv="refresh" content="0;url=https:\/\/ejemplo-real\.com\.ar\/carta\?a=1&amp;b=2"/);
  assert.match(html, /location\.replace\("https:\/\/ejemplo-real\.com\.ar\/carta\?a=1&b=2"\)/);
  assert.match(unitPage({ ...u, status: 'generado' }), /todavía no está activado/);
  assert.match(unitPage({ ...u, status: 'pausado' }), /Temporalmente/);
  assert.match(unitPage({ ...u, status: 'baja' }), /ya no está en uso/);
  assert.doesNotMatch(unitPage({ ...u, status: 'pausado' }), /refresh/);
  const p = unitPage({ status: 'activo', destination_type: 'pagina', destination_config: JSON.stringify({ title: '<script>x</script>', message: '', links: [{ text: 'Menú', url: 'https://m.com.ar' }] }) });
  assert.doesNotMatch(p, /<script>x/);
});

test('modo GitHub Pages: publica docs/, se actualiza con cada cambio y otra PC importa el registro sin repetir números', async (t) => {
  const repo = tmpDir('repo-');
  const docs = path.join(repo, 'docs');
  // La imagen del diseño vive en la carpeta del proyecto (como image_....jpg en el repo real).
  const ctx = await startApp({ PUBLIC_BASE_URL: BASE, STATIC_DIR: docs });
  t.after(() => ctx.close().catch(() => {}));
  ctx.config.root = repo;
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  const s = await c.login();
  assert.equal(s.static_mode, true);

  const png = await makeFixture();
  fs.writeFileSync(path.join(repo, 'diseno.png'), png);
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'diseno.png');
  fd.append('name', 'Reseña Google 10×15'); fd.append('profile', 'resena-google-10x15');
  const up = await c.req('POST', '/api/designs', fd, { form: true });
  const b = await createBatch(c, up.body.version.id, 3);
  assert.equal(b.status, 201);
  const units = ctx.db.prepare('SELECT * FROM units ORDER BY serial').all();
  assert.equal(units[0].qr_url, `${BASE}/q/${units[0].public_id}`);

  await new Promise((r) => setTimeout(r, 50));
  for (const u of units) assert.match(fs.readFileSync(path.join(docs, 'q', `${u.public_id}.html`), 'utf8'), /todavía no está activado/);
  assert.ok(fs.existsSync(path.join(docs, '.nojekyll')));
  const reg = JSON.parse(fs.readFileSync(path.join(docs, 'registro.json'), 'utf8'));
  assert.deepEqual(reg.unidades.map((u) => u.numero), ['001', '002', '003']);
  assert.equal(JSON.stringify(reg).includes('password'), false);

  // Cambiar destino y activar → la página del mismo QR redirige al nuevo destino
  await c.req('POST', `/api/units/${units[0].id}/destination`, { destination: { type: 'url', url: 'https://ejemplo-real.com.ar' } });
  await c.req('POST', `/api/units/${units[0].id}/status`, { status: 'activo' });
  await new Promise((r) => setTimeout(r, 50));
  assert.match(fs.readFileSync(path.join(docs, 'q', `${units[0].public_id}.html`), 'utf8'), /url=https:\/\/ejemplo-real\.com\.ar\//);
  await ctx.close();

  // "Otra PC": base vacía + mismo repo → importa todo y sigue la numeración en 004
  // Con root correcto desde el inicio
  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  const cfg = loadConfig({ PUBLIC_BASE_URL: BASE, STATIC_DIR: docs, DATA_DIR: tmpDir() });
  cfg.root = repo;
  const { app, db, imported } = createApp(cfg);
  t.after(() => db.close());
  assert.equal(imported.units_added, 3);
  assert.equal(imported.batches_added, 1);
  const again = db.prepare('SELECT serial, public_id, qr_url, status, destination_url FROM units ORDER BY serial').all();
  assert.deepEqual(again.map((u) => u.public_id), units.map((u) => u.public_id));
  assert.equal(again[0].status, 'activo');
  assert.equal(again[0].destination_url, 'https://ejemplo-real.com.ar/');
  const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  t.after(() => srv.close());
  createAdmin(db);
  const c2 = new Client(`http://127.0.0.1:${srv.address().port}`);
  await c2.login();
  const v = db.prepare('SELECT id FROM design_versions').get();
  const next = await createBatch(c2, v.id, 1);
  assert.equal(next.body.first_display, '004');
  assert.equal(next.body.code.endsWith('-002'), true);
});
