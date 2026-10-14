'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const auth = require('../src/services/auth');
const { makeFixture } = require('./fixtures/make-fixture');

function tmpDir(prefix = 'qr-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Levanta la app en un puerto libre con una base temporal. */
async function startApp(env = {}) {
  const dir = env.DATA_DIR || tmpDir();
  const config = loadConfig({ DATA_DIR: dir, BACKUP_DIR: path.join(dir, 'backups'), PUBLIC_BASE_URL: 'https://qr.ejemplo-real.com.ar', ...env });
  const { app, db } = createApp(config);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    config, db, base, dir,
    async close() { await new Promise((r) => server.close(r)); db.close(); },
  };
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async req(method, url, body, { form = false, raw = false, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    let payload;
    if (form) payload = body;
    else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  async login(username = 'admin', password = 'clave-segura-123') {
    const r = await this.req('POST', '/api/login', { username, password });
    if (r.status !== 200) throw new Error(`login: ${r.status} ${JSON.stringify(r.body)}`);
    const s = await this.req('GET', '/api/session');
    this.csrf = s.body.csrf;
    return s.body;
  }
}

function createAdmin(db, username = 'admin', password = 'clave-segura-123') {
  return auth.createAdmin(db, username, password);
}

/** Sube el diseño sintético de prueba y devuelve la versión. */
async function uploadFixtureDesign(client, { profile = 'resena-google-10x15', width = 1280, height = 1920 } = {}) {
  const png = await makeFixture({ width, height });
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'fixture.png');
  fd.append('name', 'Fixture de prueba');
  if (profile) fd.append('profile', profile);
  const r = await client.req('POST', '/api/designs', fd, { form: true });
  if (r.status !== 201) throw new Error(`upload: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function createBatch(client, versionId, quantity, extra = {}) {
  const r = await client.req('POST', '/api/batches', {
    design_version_id: versionId, quantity, placement: 'ambos', confirm: true, confirm_test_domain: true, ...extra,
  });
  return r;
}

module.exports = { tmpDir, startApp, Client, createAdmin, uploadFixtureDesign, createBatch };
