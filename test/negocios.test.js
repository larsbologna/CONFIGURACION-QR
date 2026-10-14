'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, Client, createAdmin, uploadFixtureDesign, createBatch } = require('./helpers');

test('asignación a negocios, exclusividad y reemplazos vinculados', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  await c.login();
  const { version } = await uploadFixtureDesign(c);
  await createBatch(c, version.id, 10);

  const a = (await c.req('POST', '/api/businesses', { name: 'Negocio A', category: 'Gastronomía', phone: '123', contact: 'Ana', delivery_date: '2026-10-20' })).body;
  const b = (await c.req('POST', '/api/businesses', { name: 'Negocio B' })).body;

  const asg = await c.req('POST', `/api/businesses/${a.id}/assign`, { numbers: '001-003, 005', delivered_at: '2026-10-20', status: 'entregado' });
  assert.equal(asg.status, 200, JSON.stringify(asg.body));
  assert.deepEqual(asg.body.assigned, ['001', '002', '003', '005']);

  // La misma unidad no puede ir a otro negocio; la operación se cancela entera
  const clash = await c.req('POST', `/api/businesses/${b.id}/assign`, { numbers: '004-005' });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /005 ya está asignada a "Negocio A"/);
  assert.equal(ctx.db.prepare('SELECT business_id FROM units WHERE serial = 4').get().business_id, null, 'no quedó asignación parcial');

  // Asignaciones simultáneas de la misma unidad a dos negocios: solo una gana
  const race = await Promise.all([
    c.req('POST', `/api/businesses/${a.id}/assign`, { numbers: '008' }),
    c.req('POST', `/api/businesses/${b.id}/assign`, { numbers: '008' }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);

  const detail = await c.req('GET', `/api/businesses/${a.id}`);
  assert.equal(detail.body.units.filter((u) => ['001', '002', '003', '005'].includes(u.display_number)).length, 4);
  assert.ok(detail.body.history.length >= 4);

  // Reemplazo por defecto: hereda negocio y destino, queda vinculado
  const u2 = ctx.db.prepare('SELECT id FROM units WHERE serial = 2').get();
  await c.req('POST', `/api/units/${u2.id}/destination`, { destination: { type: 'url', url: 'https://negocio-a.com.ar' } });
  const rep = await c.req('POST', `/api/units/${u2.id}/replace`, { replacement_number: '009', note: 'Impresión dañada' });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.equal(rep.body.display_number, '009');
  assert.equal(rep.body.business_id, a.id);
  assert.equal(rep.body.destination_url, 'https://negocio-a.com.ar/');
  assert.equal(rep.body.replaces_display_number, '002');
  assert.equal(ctx.db.prepare('SELECT status FROM units WHERE id = ?').get(u2.id).status, 'defectuoso');

  // Reemplazo con una unidad nueva (se numera a continuación, nunca reutiliza)
  const u3 = ctx.db.prepare('SELECT id FROM units WHERE serial = 3').get();
  const rep2 = await c.req('POST', `/api/units/${u3.id}/replace`, { note: 'Rayado' });
  assert.equal(rep2.status, 200);
  assert.equal(rep2.body.display_number, '011');
  assert.equal(rep2.body.replaces_display_number, '003');
  const orig = await c.req('GET', `/api/units/${u3.id}`);
  assert.deepEqual(orig.body.replaced_by.map((x) => x.display_number), ['011']);

  // Búsqueda del panel por negocio, estado, lote y diseño
  assert.ok((await c.req('GET', '/api/units?business=Negocio%20A')).body.total >= 4);
  assert.equal((await c.req('GET', '/api/units?status=defectuoso')).body.total, 2);
  assert.equal((await c.req('GET', '/api/units?number=007')).body.rows[0].display_number, '007');
  assert.equal((await c.req('GET', '/api/units?design=Fixture')).body.total, 11);
  const dash = await c.req('GET', '/api/dashboard');
  assert.equal(dash.body.total, 11);
  assert.equal(dash.body.counts.defectuoso, 2);
});
