'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { startApp, Client, createAdmin, uploadFixtureDesign, createBatch, tmpDir } = require('./helpers');
const { decodeQr } = require('../src/services/designs');
const render = require('../src/services/render');

const MM = 72 / 25.4;
const hasPdftoppm = (() => { try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

async function setup(t, qty = 10, extra = {}) {
  const ctx = await startApp();
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  await c.login();
  const up = await uploadFixtureDesign(c);
  const b = await createBatch(c, up.version.id, qty, extra);
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const units = ctx.db.prepare('SELECT * FROM units WHERE batch_id = ? ORDER BY serial').all(b.body.id);
  return { ctx, c, version: up.version, upload: up, batch: b.body, units };
}

test('sustitución del QR original y legibilidad del nuevo', async (t) => {
  const { c, version, upload } = await setup(t, 1);
  assert.equal(upload.detection.found, true, 'el QR del diseño de prueba se detecta');
  assert.equal(upload.detection.content, 'https://qr-viejo.example/fijo');
  const v = await c.req('POST', `/api/design-versions/${version.id}/verify`, {});
  assert.equal(v.status, 200);
  const errors = v.body.checks.filter((x) => x.level === 'error');
  assert.deepEqual(errors, [], JSON.stringify(v.body.checks));
  assert.ok(v.body.checks.some((x) => /QR original detectado queda completamente cubierto/.test(x.msg)));
  assert.ok(v.body.checks.some((x) => /no queda ningún QR antiguo legible/.test(x.msg)));
});

test('verificación detecta un parche que no tapa el QR original', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  await c.login();
  const { version } = await uploadFixtureDesign(c);
  const bad = JSON.parse(JSON.stringify(version.config));
  bad.qr = { ...bad.qr, x_mm: 5, y_mm: 5, size_mm: 30 };
  bad.cover.enabled = false;
  const put = await c.req('PUT', `/api/design-versions/${version.id}/config`, { config: bad });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const v = await c.req('POST', `/api/design-versions/${version.id}/verify`, {});
  assert.equal(v.body.ok, false);
  assert.ok(v.body.checks.some((x) => x.level === 'error' && /NO queda completamente cubierto|sigue/.test(x.msg)), JSON.stringify(v.body.checks));
});

test('cada QR corresponde exactamente a su número y registro (PNG, PDF, SVG)', async (t) => {
  const { c, units } = await setup(t, 10);
  const seen = new Set();
  for (const u of units) {
    const png = await c.req('GET', `/api/units/${u.id}/export.png`, undefined, { raw: true });
    assert.equal(png.status, 200);
    const buf = Buffer.from(await png.arrayBuffer());
    const meta = await sharp(buf).metadata();
    assert.equal(meta.width, 1280); assert.equal(meta.height, 1920, 'PNG con la resolución del diseño original, sin deformar');
    const dec = await decodeQr(buf);
    assert.ok(dec, `QR legible en ${u.display_number}`);
    assert.equal(dec.text, u.qr_url, `QR de ${u.display_number} apunta a su propia URL`);
    assert.ok(!seen.has(dec.text)); seen.add(dec.text);

    const pdf = await c.req('GET', `/api/units/${u.id}/export.pdf`, undefined, { raw: true });
    const doc = await PDFDocument.load(Buffer.from(await pdf.arrayBuffer()));
    const { width, height } = doc.getPage(0).getSize();
    assert.ok(Math.abs(width / MM - 100) < 0.01 && Math.abs(height / MM - 150) < 0.01, `PDF 100×150 mm (${width / MM}×${height / MM})`);

    const svg = await c.req('GET', `/api/units/${u.id}/export.svg`);
    assert.match(svg.body, /width="100mm" height="150mm"/);
    assert.match(svg.body, new RegExp(`<title>Unidad ${u.display_number}</title>`));
  }
  assert.equal(seen.size, 10);
});

test('el número dentro del plástico se dibuja en la zona configurada', async (t) => {
  const { ctx, units, version } = await setup(t, 1);
  const v = { ...version };
  const u = units[0];
  const withNum = await render.unitPng(ctx.config.uploadsDir, v, u, { numberInDesign: true });
  const without = await render.unitPng(ctx.config.uploadsDir, v, u, { numberInDesign: false });
  const n = v.config.number;
  const k = v.image_width_px / v.width_mm;
  const box = { left: Math.round(n.x_mm * k), top: Math.round(n.y_mm * k), width: Math.round(n.w_mm * k), height: Math.round(n.h_mm * k) };
  const dark = async (b) => { const crop = await sharp(b).extract(box).png().toBuffer(); return (await sharp(crop).stats()).channels[0].min; };
  assert.ok(await dark(withNum) < 120, 'hay texto oscuro en el área del número');
  assert.ok(await dark(without) > 200, 'sin la opción, el área queda como en el diseño');
});

test('plancha: tamaño real, orden correlativo y número debajo que coincide con el QR', async (t) => {
  const { c, batch, units } = await setup(t, 7);
  const q = `batch_id=${batch.id}&paper=A3&orientation=vertical&margin_mm=8&gap_x_mm=6&gap_y_mm=6`;
  const layout = await c.req('GET', `/api/export/sheet-layout?${q}`);
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  assert.equal(layout.body.capacity, 4);
  assert.equal(layout.body.pages, 2);
  assert.deepEqual(layout.body.numbers, units.map((u) => u.display_number));
  for (const cell of layout.body.cells) {
    assert.ok(cell.x >= 8 && cell.x + 100 <= 297 - 8 + 1e-6, 'no se recorta en X');
    assert.ok(cell.y >= 8 && cell.y + 150 + 8 <= 420 - 8 + 1e-6, 'no se recorta en Y');
  }
  const res = await c.req('GET', `/api/export/sheet.pdf?${q}`, undefined, { raw: true });
  assert.equal(res.status, 200);
  const pdfBuf = Buffer.from(await res.arrayBuffer());
  const doc = await PDFDocument.load(pdfBuf);
  assert.equal(doc.getPageCount(), 2);
  const { width, height } = doc.getPage(0).getSize();
  assert.ok(Math.abs(width / MM - 297) < 0.01 && Math.abs(height / MM - 420) < 0.01, 'A3 vertical');

  // Demasiadas por hoja: error explícito, nunca se reduce el diseño
  const tooMany = await c.req('GET', `/api/export/sheet-layout?${q}&per_sheet=10`);
  assert.ok(tooMany.body.errors.some((e) => /como máximo 4/.test(e)));
  const a4v = await c.req('GET', `/api/export/sheet-layout?batch_id=${batch.id}&paper=A4&orientation=vertical&margin_mm=10`);
  assert.equal(a4v.body.capacity, 1, 'A4 vertical: entra 1 diseño a tamaño real');
  const tooSmall = await c.req('GET', `/api/export/sheet.pdf?batch_id=${batch.id}&paper=A4&orientation=horizontal&margin_mm=40`);
  assert.equal(tooSmall.status, 400, 'si no entra a tamaño real, avisa en lugar de escalar');
  assert.match(tooSmall.body.error, /No se reduce el diseño/);

  if (!hasPdftoppm) { t.diagnostic('pdftoppm no disponible: se omite la lectura del QR en la plancha rasterizada'); return; }
  // Rasteriza y lee el QR de cada celda: debe ser la unidad cuyo número figura en esa posición.
  const dir = tmpDir('plancha-');
  fs.writeFileSync(path.join(dir, 'p.pdf'), pdfBuf);
  execFileSync('pdftoppm', ['-r', '150', '-png', path.join(dir, 'p.pdf'), path.join(dir, 'pag')]);
  const pxmm = 150 / 25.4;
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  let idx = 0;
  for (const p of pages) {
    const img = fs.readFileSync(path.join(dir, p));
    for (const cell of layout.body.cells) {
      if (idx >= units.length) break;
      const crop = await sharp(img).extract({ left: Math.round(cell.x * pxmm), top: Math.round(cell.y * pxmm), width: Math.round(100 * pxmm), height: Math.round(150 * pxmm) }).png().toBuffer();
      const dec = await decodeQr(crop);
      assert.ok(dec, `QR legible en la celda ${idx + 1}`);
      assert.equal(dec.text, units[idx].qr_url, `celda ${idx + 1}: el QR es el de la unidad ${units[idx].display_number}, que es el número impreso debajo`);
      idx++;
    }
  }
  assert.equal(idx, units.length);
});

test('exportación ZIP y CSV', async (t) => {
  const { c, batch, units } = await setup(t, 3);
  const zip = await c.req('GET', `/api/export/batch.zip?batch_id=${batch.id}&svg=1&paper=A3&orientation=vertical`, undefined, { raw: true });
  assert.equal(zip.status, 200);
  const buf = Buffer.from(await zip.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const names = buf.toString('latin1');
  for (const u of units) {
    for (const ext of ['png', 'pdf', 'svg']) assert.ok(names.includes(`${ext}/${u.display_number}_${batch.code}.${ext}`), `${u.display_number}.${ext} en el ZIP`);
  }
  assert.ok(names.includes(`plancha_${batch.code}.pdf`));
  assert.ok(names.includes(`${batch.code}.csv`));

  const csv = await c.req('GET', `/api/export/units.csv?batch_id=${batch.id}`);
  assert.equal(csv.status, 200);
  const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'numero;serial;url_permanente;lote;diseno;version_diseno;estado;negocio;destino;fecha_generacion;fecha_entrega;reemplaza_a;escaneos');
  assert.equal(lines.length, 4);
  units.forEach((u, i) => {
    const cols = lines[i + 1].split(';');
    assert.equal(cols[0], u.display_number); assert.equal(cols[2], u.qr_url); assert.equal(cols[3], batch.code); assert.equal(cols[6], 'Generado');
  });
});

test('número que no entra en el plástico: se avisa y queda solo en la plancha', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  await c.login();
  const { version } = await uploadFixtureDesign(c);
  const cfg = JSON.parse(JSON.stringify(version.config));
  cfg.number.enabled = false;
  await c.req('PUT', `/api/design-versions/${version.id}/config`, { config: cfg });
  const pre = await c.req('POST', '/api/batches/preview', { design_version_id: version.id, quantity: 5, placement: 'plastico' });
  assert.equal(pre.body.number_fits, false);
  assert.ok(pre.body.warnings.some((w) => /NO tendrá el número visible/.test(w)));
  const b = await createBatch(c, version.id, 5, { placement: 'plastico' });
  assert.equal(b.body.number_in_design, 0);
  assert.equal(b.body.number_on_sheet, 1);
  assert.ok(b.body.warnings.some((w) => /NO tendrá el número visible/.test(w)));
});

test('rechaza imágenes con proporción distinta (no deforma)', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());
  createAdmin(ctx.db);
  const c = new Client(ctx.base);
  await c.login();
  const png = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#fff' } }).png().toBuffer();
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'cuadrado.png');
  fd.append('name', 'Cuadrado');
  const r = await c.req('POST', '/api/designs', fd, { form: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /proporción/);
});
