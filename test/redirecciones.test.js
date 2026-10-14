'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, Client, createAdmin, uploadFixtureDesign, createBatch } = require('./helpers');
const { decodeQr } = require('../src/services/designs');

async function setup(t) {
  const ctx = await startApp();
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  await c.login();
  const { version } = await uploadFixtureDesign(c);
  const b = await createBatch(c, version.id, 3);
  const units = ctx.db.prepare('SELECT * FROM units WHERE batch_id = ? ORDER BY serial').all(b.body.id);
  return { ctx, c, units };
}
const path = (u) => new URL(u.qr_url).pathname;

test('cambiar la redirección no cambia el QR', async (t) => {
  const { ctx, c, units } = await setup(t);
  const u = units[0];
  const before = Buffer.from(await (await c.req('GET', `/api/units/${u.id}/export.png`, undefined, { raw: true })).arrayBuffer());

  // Sin destino ni activación: no redirige
  let r = await fetch(ctx.base + path(u), { redirect: 'manual' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /todavía no está activado/);

  await c.req('POST', `/api/units/${u.id}/destination`, { destination: { type: 'menu', url: 'https://menu.ejemplo-real.com.ar/carta' } });
  await c.req('POST', `/api/units/${u.id}/status`, { status: 'activo' });
  r = await fetch(ctx.base + path(u), { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://menu.ejemplo-real.com.ar/carta');
  assert.match(r.headers.get('cache-control'), /no-store/);

  const ch = await c.req('POST', `/api/units/${u.id}/destination`, { destination: { type: 'google_resena', place_id: 'ChIJN1t_tDeuEmsRUsoyG83frY4' }, note: 'pidió reseñas' });
  assert.equal(ch.status, 200);
  r = await fetch(ctx.base + path(u), { redirect: 'manual' });
  assert.equal(r.headers.get('location'), 'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4');

  const after = Buffer.from(await (await c.req('GET', `/api/units/${u.id}/export.png`, undefined, { raw: true })).arrayBuffer());
  assert.equal((await decodeQr(before)).text, (await decodeQr(after)).text, 'el contenido del QR es idéntico');
  assert.equal(ctx.db.prepare('SELECT qr_url FROM units WHERE id = ?').get(u.id).qr_url, u.qr_url);

  // Historial con administrador
  const d = await c.req('GET', `/api/units/${u.id}`);
  const dest = d.body.history.filter((h) => h.action === 'destino');
  assert.equal(dest.length, 2);
  assert.equal(dest[0].username, 'admin');
  assert.equal(dest[0].note, 'pidió reseñas');

  // Pausar y dar de baja
  await c.req('POST', `/api/units/${u.id}/status`, { status: 'pausado' });
  r = await fetch(ctx.base + path(u), { redirect: 'manual' });
  assert.equal(r.status, 200); assert.match(await r.text(), /Temporalmente/);
  await c.req('POST', `/api/units/${u.id}/status`, { status: 'baja' });
  r = await fetch(ctx.base + path(u), { redirect: 'manual' });
  assert.equal(r.status, 410);

  // Escaneos registrados sin datos personales
  const scans = ctx.db.prepare('SELECT * FROM scans WHERE unit_id = ?').all(u.id);
  assert.equal(scans.length, 5);
  assert.deepEqual(Object.keys(scans[0]).sort(), ['business_id', 'created_at', 'id', 'kind', 'target', 'unit_id', 'unit_status']);
});

test('validación de destinos: sin redirecciones abiertas ni inseguras', async (t) => {
  const { c, units } = await setup(t);
  const id = units[1].id;
  const bad = [
    'javascript:alert(1)', 'http://sitio.com', 'https://localhost/x', 'https://127.0.0.1/', 'https://192.168.0.10/',
    'https://usuario:clave@sitio.com/', 'ftp://sitio.com', 'https://intranet/', 'https://qr.ejemplo-real.com.ar/q/abc',
    'data:text/html,hola', 'no es url',
  ];
  for (const url of bad) {
    const r = await c.req('POST', `/api/units/${id}/destination`, { destination: { type: 'url', url } });
    assert.equal(r.status, 400, `debe rechazar ${url}`);
  }
  const pid = await c.req('POST', `/api/units/${id}/destination`, { destination: { type: 'google_resena', place_id: 'abc"><script>' } });
  assert.equal(pid.status, 400);
  // El parámetro de la URL pública no permite elegir destino
  const r = await fetch(`${new URL(units[1].qr_url).pathname}?next=https://malicioso.com`.replace(/^/, c.base), { redirect: 'manual' });
  assert.notEqual(r.headers.get('location'), 'https://malicioso.com');
  const nf = await fetch(`${c.base}/q/../../etc/passwd`, { redirect: 'manual' });
  assert.equal(nf.status, 404);
});

test('página propia neutral con clics registrados', async (t) => {
  const { ctx, c, units } = await setup(t);
  const u = units[2];
  const set = await c.req('POST', `/api/units/${u.id}/destination`, { destination: { type: 'pagina', page: {
    title: 'Café <b>Centro</b>', message: 'Tu opinión sincera nos ayuda.',
    links: [{ text: 'Ver menú', url: 'https://menu.ejemplo-real.com.ar' }, { text: 'Opinar en Google', url: 'https://g.page/r/abc/review' }],
  } } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  await c.req('POST', `/api/units/${u.id}/status`, { status: 'activo' });
  const page = await fetch(ctx.base + path(u));
  const html = await page.text();
  assert.match(html, /Café &lt;b&gt;Centro&lt;\/b&gt;/, 'el contenido se escapa (sin XSS)');
  assert.doesNotMatch(html, /estrella|puntuaci|rating/i, 'no hay filtrado por puntuación');
  const click = await fetch(`${ctx.base}${path(u)}/ir/1`, { redirect: 'manual' });
  assert.equal(click.status, 302);
  assert.equal(click.headers.get('location'), 'https://g.page/r/abc/review');
  const bad = await fetch(`${ctx.base}${path(u)}/ir/7`, { redirect: 'manual' });
  assert.equal(bad.status, 404);
  const st = await c.req('GET', '/api/stats');
  assert.equal(st.body.totals.escaneo, 1);
  assert.equal(st.body.totals.clic, 1);
  assert.match(st.body.reviews_note, /no se pueden medir/);
});
