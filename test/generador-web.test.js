'use strict';
/**
 * Prueba de punta a punta del generador web (docs/generador/) en Chromium, con la
 * API de GitHub simulada. Se omite si Playwright no está instalado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { decodeQr } = require('../src/services/designs');
const { tmpDir } = require('./helpers');

function loadPlaywright() {
  for (const p of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try { return require(p); } catch { /* siguiente */ }
  }
  return null;
}
const pw = loadPlaywright();
const hasPdftoppm = (() => { try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const DOCS = path.join(__dirname, '..', 'docs');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.ttf': 'font/ttf' };

/** Repositorio simulado: archivos de docs/ en memoria + API git mínima. */
function mockRepo() {
  const files = new Map();
  for (const rel of ['docs/registro.json', ...fs.readdirSync(path.join(DOCS, 'q')).map((f) => `docs/q/${f}`)]) {
    files.set(rel, fs.readFileSync(path.join(DOCS, '..', rel), 'utf8'));
  }
  // La prueba parte siempre de los 3 QR libres, sin importar el estado real del repositorio.
  const reg0 = JSON.parse(files.get('docs/registro.json'));
  reg0.unidades = reg0.unidades.filter((u) => u.serial <= 3).map((u) => ({ ...u, estado: 'generado', destino_tipo: null, destino_url: null, destino_config: null, etiqueta: null }));
  files.set('docs/registro.json', `${JSON.stringify(reg0, null, 1)}\n`);
  const repo = { files, head: 'c0', commits: new Map([['c0', { tree: 't0', files: new Map(files) }]]), trees: new Map([['t0', new Map(files)]]), n: 0, failNextPatch: 0, patches: 0 };
  repo.handle = (method, url, body) => {
    const u = new URL(url); const p = u.pathname.replace('/repos/larsbologna/CONFIGURACION-QR', '');
    if (method === 'GET' && p === '/git/ref/heads/main') return [200, { object: { sha: repo.head } }];
    if (method === 'GET' && p.startsWith('/contents/')) {
      const f = repo.commits.get(u.searchParams.get('ref')).files.get(decodeURIComponent(p.slice('/contents/'.length)));
      return f == null ? [404, {}] : [200, f, true];
    }
    if (method === 'GET' && p.startsWith('/git/commits/')) return [200, { tree: { sha: repo.commits.get(p.split('/').pop()).tree } }];
    if (method === 'POST' && p === '/git/trees') {
      const t = new Map(repo.trees.get(body.base_tree));
      for (const e of body.tree) t.set(e.path, e.content);
      const sha = `t${++repo.n}`; repo.trees.set(sha, t); return [201, { sha }];
    }
    if (method === 'POST' && p === '/git/commits') {
      const sha = `c${++repo.n}`; repo.commits.set(sha, { tree: body.tree, parent: body.parents[0], files: repo.trees.get(body.tree), message: body.message }); return [201, { sha }];
    }
    if (method === 'PATCH' && p === '/git/refs/heads/main') {
      repo.patches++;
      if (repo.failNextPatch > 0) {
        // Simula que otra persona guardó justo antes: main avanza con un cambio ajeno.
        repo.failNextPatch--;
        const prev = repo.commits.get(repo.head);
        const other = `c${++repo.n}`; const t = new Map(prev.files);
        const reg = JSON.parse(t.get('docs/registro.json')); reg.revision += 1; reg.nota += ' ';
        t.set('docs/registro.json', `${JSON.stringify(reg, null, 1)}\n`);
        repo.commits.set(other, { tree: other, parent: repo.head, files: t }); repo.trees.set(other, t); repo.head = other;
        return [422, { message: 'Update is not a fast forward' }];
      }
      const c = repo.commits.get(body.sha);
      if (c.parent !== repo.head) return [422, { message: 'Update is not a fast forward' }];
      repo.head = body.sha; return [200, {}];
    }
    return [404, { message: `no simulado: ${method} ${p}` }];
  };
  repo.current = () => repo.commits.get(repo.head).files;
  repo.registry = () => JSON.parse(repo.current().get('docs/registro.json'));
  return repo;
}

function staticServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(u.pathname).replace(/^\/CONFIGURACION-QR\//, '');
    const f = path.join(DOCS, rel.endsWith('/') || rel === '' ? `${rel}index.html` : rel);
    if (!f.startsWith(DOCS) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('generador web: asigna QR libres, crea nuevos, cambia links sin cambiar el QR y descarga el diseño', { skip: !pw && 'Playwright no disponible' }, async (t) => {
  const repo = mockRepo();
  const srv = await staticServer();
  t.after(() => srv.close());
  const browser = await pw.chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    if (req.headers().authorization !== 'Bearer github_pat_PRUEBA123') return route.fulfill({ status: 401, body: '{}' });
    const [status, body, raw] = repo.handle(req.method(), req.url(), req.postData() ? JSON.parse(req.postData()) : null);
    return route.fulfill({ status, contentType: raw ? 'text/plain' : 'application/json', body: raw ? body : JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  });
  const base = `http://127.0.0.1:${srv.address().port}/CONFIGURACION-QR/generador/`;
  await page.goto(base);
  await page.waitForSelector('#conectar:not(.hidden)');
  assert.equal(await page.locator('#filas tr').count(), 3, 'muestra los 3 QR existentes');

  // Llave inválida y luego válida
  await page.fill('#token', 'github_pat_MALA');
  await page.click('#guardar-token');
  await page.waitForSelector('#msg-conectar.error');
  await page.fill('#token', 'github_pat_PRUEBA123');
  await page.click('#guardar-token');
  await page.waitForSelector('#nuevo:not(.hidden)');

  // Link inválido
  await page.fill('#link', 'http://inseguro.com');
  await page.click('#generar');
  await page.waitForSelector('#msg-nuevo.error');

  async function generar(link, nombre) {
    await page.fill('#link', link);
    await page.fill('#etiqueta', nombre || '');
    await page.click('#generar');
    await page.waitForFunction(() => /se asignó el QR/.test(document.getElementById('msg-nuevo').textContent) && !document.getElementById('generar').disabled);
    const numero = (await page.textContent('#msg-nuevo')).match(/N° (\S+)\./)[1];
    await page.waitForFunction(() => document.getElementById('lienzo').width > 0);
    return numero;
  }

  const n1 = await generar('https://g.page/r/PRUEBA/review', 'Peluquería Ana');
  assert.equal(n1, '001');
  if (process.env.CAPTURA) await page.screenshot({ path: path.join(process.env.CAPTURA, 'gen-1.png'), fullPage: true });
  let reg = repo.registry();
  const u1 = reg.unidades.find((u) => u.numero === '001');
  assert.equal(u1.estado, 'activo');
  assert.equal(u1.destino_url, 'https://g.page/r/PRUEBA/review');
  assert.equal(u1.etiqueta, 'Peluquería Ana');
  const page1 = repo.current().get(`docs/q/${u1.id_publico}.html`);
  assert.match(page1, /url=https:\/\/g\.page\/r\/PRUEBA\/review/);
  assert.equal(JSON.parse(repo.current().get(`docs/q/${u1.id_publico}.json`)).destino_url, 'https://g.page/r/PRUEBA/review');

  // El diseño dibujado tiene el QR correcto y el número dentro
  const dataUrl = await page.evaluate(() => document.getElementById('lienzo').toDataURL('image/png'));
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  const meta = await sharp(png).metadata();
  assert.deepEqual([meta.width, meta.height], [1280, 1920]);
  assert.equal((await decodeQr(png)).text, u1.url, 'el QR del diseño lleva a la URL permanente de la 001');
  const numBox = await sharp(png).extract({ left: 448, top: 1702, width: 384, height: 90 }).png().toBuffer();
  assert.ok((await sharp(numBox).stats()).channels[0].min < 120, 'el número 001 está dibujado debajo de "Escanea con tu celular"');

  // PDF 100 × 150 mm con el QR legible
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bajar-pdf')]);
  assert.equal(dl.suggestedFilename(), '001_QR.pdf');
  const pdfPath = path.join(tmpDir('gen-'), 'p.pdf');
  await dl.saveAs(pdfPath);
  const pdf = await PDFDocument.load(fs.readFileSync(pdfPath));
  const size = pdf.getPage(0).getSize();
  assert.ok(Math.abs(size.width / (72 / 25.4) - 100) < 0.01 && Math.abs(size.height / (72 / 25.4) - 150) < 0.01, 'PDF de 100 × 150 mm');
  if (hasPdftoppm) {
    execFileSync('pdftoppm', ['-r', '200', '-png', pdfPath, pdfPath.replace('.pdf', '')]);
    const rendered = fs.readFileSync(fs.readdirSync(path.dirname(pdfPath)).filter((f) => f.endsWith('.png')).map((f) => path.join(path.dirname(pdfPath), f))[0]);
    assert.equal((await decodeQr(rendered)).text, u1.url, 'el QR del PDF se lee');
  }

  // Siguientes: usa 002 y 003 libres, después crea 004 (con un choque simultáneo en el medio)
  assert.equal(await generar('https://menu.ejemplo-real.com.ar', 'Bar B'), '002');
  repo.failNextPatch = 1;
  assert.equal(await generar('https://www.instagram.com/negocio.c/', ''), '003');
  assert.equal(await generar('https://maps.app.goo.gl/abcdef', 'Kiosco D'), '004');
  reg = repo.registry();
  assert.deepEqual(reg.unidades.map((u) => u.numero), ['001', '002', '003', '004']);
  const u4 = reg.unidades[3];
  assert.match(u4.id_publico, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{12}$/);
  assert.equal(u4.url, `https://larsbologna.github.io/CONFIGURACION-QR/q/${u4.id_publico}`);
  assert.equal(new Set(reg.unidades.map((u) => u.id_publico)).size, 4, 'sin QR repetidos');
  assert.match(reg.lotes.find((l) => l.id === u4.lote_id).codigo, /^LOTE-\d{4}-002$/);
  assert.ok(repo.current().get(`docs/q/${u4.id_publico}.html`).includes('maps.app.goo.gl/abcdef'));

  // Cambiar el link de la 001: mismo QR, nuevo destino
  const revBefore = reg.revision;
  const respuestas = ['https://www.google.com/maps/place/nuevo', 'Peluquería Ana (nuevo local)'];
  page.on('dialog', (d) => d.accept(respuestas.shift()));
  await page.locator('#filas tr', { hasText: 'Peluquería Ana' }).getByRole('button', { name: 'Cambiar link' }).click();
  await page.waitForFunction(() => /Guardado: QR N° 001/.test(document.getElementById('msg-nuevo').textContent));
  reg = repo.registry();
  const u1b = reg.unidades.find((u) => u.numero === '001');
  assert.equal(u1b.id_publico, u1.id_publico, 'el QR (y el plástico) no cambian');
  assert.equal(u1b.destino_url, 'https://www.google.com/maps/place/nuevo');
  assert.ok(reg.revision > revBefore);
  assert.match(repo.current().get(`docs/q/${u1.id_publico}.html`), /google\.com\/maps\/place\/nuevo/);
  assert.equal(JSON.parse(repo.current().get(`docs/q/${u1.id_publico}.json`)).destino_url, 'https://www.google.com/maps/place/nuevo');

  // Pausar
  await page.locator('#filas tr', { hasText: 'Bar B' }).getByRole('button', { name: 'Pausar' }).click();
  await page.waitForFunction(() => /Guardado: QR N° 002/.test(document.getElementById('msg-nuevo').textContent));
  assert.match(repo.current().get(`docs/q/${repo.registry().unidades[1].id_publico}.html`), /Temporalmente no disponible/);
  assert.equal(JSON.parse(repo.current().get(`docs/q/${repo.registry().unidades[1].id_publico}.json`)).estado, 'pausado');
  assert.deepEqual(errors, []);
  if (process.env.CAPTURA) await page.screenshot({ path: path.join(process.env.CAPTURA, 'gen-2.png'), fullPage: true });

  // El panel (Node) incorpora todo lo hecho desde la web y sigue con el 005
  const docs2 = path.join(tmpDir('docs-'), 'docs');
  for (const [rel, content] of repo.current()) { fs.mkdirSync(path.dirname(path.join(docs2, '..', rel)), { recursive: true }); fs.writeFileSync(path.join(docs2, '..', rel), content); }
  fs.mkdirSync(path.join(docs2, 'generador', 'disenos'), { recursive: true });
  for (const f of fs.readdirSync(path.join(DOCS, 'generador', 'disenos'))) fs.copyFileSync(path.join(DOCS, 'generador', 'disenos', f), path.join(docs2, 'generador', 'disenos', f));
  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  const numbering = require('../src/services/numbering');
  const cfg = loadConfig({ PUBLIC_BASE_URL: 'https://larsbologna.github.io/CONFIGURACION-QR', STATIC_DIR: docs2, DATA_DIR: tmpDir() });
  const { db, imported } = createApp(cfg);
  t.after(() => db.close());
  assert.equal(imported.units_added, 4);
  const rows = db.prepare('SELECT display_number, status, destination_url, label FROM units ORDER BY serial').all();
  assert.deepEqual(rows.map((r) => [r.display_number, r.status]), [['001', 'activo'], ['002', 'pausado'], ['003', 'activo'], ['004', 'activo']]);
  assert.equal(rows[0].label, 'Peluquería Ana (nuevo local)');
  const b = numbering.createBatch(db, cfg, null, { designVersionId: 1, quantity: 1, format: {}, placement: 'plastico', numberFits: true });
  assert.equal(b.first_display, '005');
  assert.match(b.code, /-003$/);
});
