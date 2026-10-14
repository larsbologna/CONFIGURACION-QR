'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, Client, createAdmin, uploadFixtureDesign, createBatch } = require('./helpers');
const { hashPassword, verifyPassword } = require('../src/services/auth');

test('contraseñas con hash scrypt y sal', () => {
  const h1 = hashPassword('clave-segura-123');
  const h2 = hashPassword('clave-segura-123');
  assert.match(h1, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(h1, h2);
  assert.ok(!h1.includes('clave-segura-123'));
  assert.equal(verifyPassword('clave-segura-123', h1), true);
  assert.equal(verifyPassword('otra', h1), false);
});

test('panel administrativo protegido', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  const anon = new Client(ctx.base);

  // Sin administradores: no hay forma de crear uno desde la web
  const setup = await anon.req('GET', '/login');
  assert.match(setup.body, /npm run crear-admin/);
  createAdmin(ctx.db);

  for (const url of ['/api/units', '/api/dashboard', '/api/designs', '/api/businesses', '/api/export/units.csv', '/api/audit', '/api/backups', '/api/session']) {
    const r = await anon.req('GET', url);
    assert.equal(r.status, 401, `${url} sin sesión`);
  }
  for (const url of ['/admin/', '/admin/index.html', '/admin/lote.html', '/admin/js/common.js']) {
    const r = await anon.req('GET', url);
    assert.equal(r.status, 302, `${url} sin sesión`);
    assert.equal(r.headers.get('location'), '/login');
  }
  const post = await anon.req('POST', '/api/batches', { quantity: 1 });
  assert.equal(post.status, 401);

  // Credenciales incorrectas
  const wrong = await anon.req('POST', '/api/login', { username: 'admin', password: 'incorrecta-123' });
  assert.equal(wrong.status, 401);

  const c = new Client(ctx.base);
  await c.login();
  const cookie = c.cookie;
  const login = await new Client(ctx.base).req('POST', '/api/login', { username: 'admin', password: 'clave-segura-123' });
  const sc = login.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Secure/, 'Secure con dominio https');

  // Con sesión funciona; sin token CSRF, no
  assert.equal((await c.req('GET', '/api/dashboard')).status, 200);
  const noCsrf = await fetch(`${ctx.base}/api/businesses`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X' }) });
  assert.equal(noCsrf.status, 403);
  const foreign = await c.req('POST', '/api/businesses', { name: 'X' }, { headers: { origin: 'https://atacante.com' } });
  assert.equal(foreign.status, 403);

  // Encabezados de seguridad
  const page = await c.req('GET', '/admin/', undefined, { raw: true });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');

  // Cierre de sesión invalida la cookie
  await c.req('POST', '/api/logout', {});
  const after = await fetch(`${ctx.base}/api/dashboard`, { headers: { cookie } });
  assert.equal(after.status, 401);

  // Registro de acciones
  const acts = ctx.db.prepare('SELECT action FROM audit_log').all().map((a) => a.action);
  assert.ok(acts.includes('login.fallido') && acts.includes('login.ok') && acts.includes('logout'));
});

test('límite de intentos de inicio de sesión', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const anon = new Client(ctx.base);
  let last;
  for (let i = 0; i < 10; i++) last = await anon.req('POST', '/api/login', { username: 'admin', password: `mal-${i}-xxxxxx` });
  assert.equal(last.status, 429);
});

test('entradas maliciosas: validación y consultas parametrizadas', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  await c.login();
  const { version } = await uploadFixtureDesign(c);
  await createBatch(c, version.id, 2);
  const inj = await c.req('GET', `/api/units?q=${encodeURIComponent("' OR 1=1; DROP TABLE units; --")}`);
  assert.equal(inj.status, 200);
  assert.equal(inj.body.total, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM units').get().n, 2);
  assert.equal((await c.req('POST', '/api/batches', { design_version_id: version.id, quantity: -5, confirm: true, confirm_test_domain: true })).status, 400);
  assert.equal((await c.req('POST', '/api/batches', { design_version_id: version.id, quantity: 999999, confirm: true })).status, 400);
  assert.equal((await c.req('POST', '/api/batches', { design_version_id: version.id, quantity: 1, prefix: '1A', confirm: true })).status, 400);
  assert.equal((await c.req('POST', '/api/batches', { design_version_id: version.id, quantity: 1 })).status, 400, 'requiere confirmación');
  assert.equal((await c.req('POST', '/api/businesses', { name: 'x'.repeat(500) })).status, 400);
  assert.equal((await c.req('GET', '/api/units/abc')).status, 400);
  const badJson = await fetch(`${ctx.base}/api/businesses`, { method: 'POST', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/json' }, body: '{malo' });
  assert.equal(badJson.status, 400);
});

test('dominio de prueba: exige confirmación explícita', async (t) => {
  const ctx = await startApp({ PUBLIC_BASE_URL: 'http://localhost:3000' });
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  await c.login();
  const { version } = await uploadFixtureDesign(c);
  const r = await c.req('POST', '/api/batches', { design_version_id: version.id, quantity: 1, confirm: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no es público/);
});
