'use strict';
/**
 * Prueba un diseño SIN tocar la base real ni consumir numeración:
 *   npm run prueba-diseno -- "C:\ruta\a\mi-diseno.png"
 *   npm run prueba-diseno -- mi-diseno.png --detectar     (ubica el QR por detección automática en vez del perfil)
 *
 * Crea una base temporal en salida-prueba/, importa la imagen, genera las
 * unidades 001, 002 y 003, exporta PNG/PDF/SVG + plancha y comprueba:
 *  - que los tres QR sean distintos y se lean,
 *  - que cada QR contenga la URL de SU registro,
 *  - que el número de cada archivo/plancha coincida con su QR,
 *  - que cada PDF mida exactamente 100 × 150 mm.
 */
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { loadConfig } = require('../src/config');
const { openDb, migrate } = require('../src/db');
const designs = require('../src/services/designs');
const numbering = require('../src/services/numbering');
const render = require('../src/services/render');

const PT_PER_MM = 72 / 25.4;

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Uso: npm run prueba-diseno -- <ruta-a-la-imagen.png|jpg> [--detectar]');
    process.exit(1);
  }
  const useDetection = process.argv.includes('--detectar');
  const out = path.resolve(__dirname, '..', 'salida-prueba', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(out, { recursive: true });
  const config = loadConfig({ DATA_DIR: path.join(out, 'datos') });
  const db = openDb(config.dbFile);
  migrate(db);
  const actor = { id: null, username: 'prueba-diseno' };
  const results = [];
  const check = (ok, msg) => { results.push({ ok, msg }); console.log(`${ok ? 'OK   ' : 'FALLA'} ${msg}`); };

  const up = await designs.uploadDesign(db, config, actor, {
    name: path.basename(file), buffer: fs.readFileSync(file), originalName: path.basename(file),
    profile: useDetection ? undefined : 'resena-google-10x15',
  });
  const v = up.version;
  console.log(`Imagen: ${v.image_width_px}×${v.image_height_px} px → ${v.width_mm}×${v.height_mm} mm (${v.dpi} ppp)`);
  console.log(`Detección del QR original: ${up.detection.message}${up.detection.found ? ` Contenido actual: ${up.detection.content}` : ''}`);
  console.log(`Ubicación usada: ${useDetection && up.detection.found ? 'detección automática' : 'perfil "resena-google-10x15" (medido sobre la imagen enviada)'}`);

  const ver = await designs.verifyVersion(db, config, v.id);
  console.log('\nVerificación de plantilla:');
  for (const c of ver.checks) console.log(`  [${c.level}] ${c.msg}`);

  const ns = render.numberAreaStatus(v, '003');
  const batch = numbering.createBatch(db, config, actor, {
    designVersionId: v.id, quantity: 3, format: { min_digits: 3 }, placement: 'ambos', numberFits: ns.fits,
  });
  const units = db.prepare('SELECT * FROM units WHERE batch_id = ? ORDER BY serial').all(batch.id);
  console.log(`\nLote de prueba ${batch.code}: ${batch.first_display} a ${batch.last_display}${ns.fits ? '' : ' (número solo en plancha: ' + ns.reasons.join(' ') + ')'}\n`);

  const seen = new Set();
  for (const u of units) {
    const opts = { numberInDesign: Boolean(batch.number_in_design) };
    const png = await render.unitPng(config.uploadsDir, v, u, opts);
    const pdf = await render.unitPdf(config.uploadsDir, v, u, opts);
    fs.writeFileSync(path.join(out, `${u.display_number}.png`), png);
    fs.writeFileSync(path.join(out, `${u.display_number}.pdf`), pdf);
    fs.writeFileSync(path.join(out, `${u.display_number}.svg`), render.unitSvg(config.uploadsDir, v, u, opts));
    const dec = await designs.decodeQr(png);
    check(Boolean(dec), `${u.display_number}: el QR se puede leer`);
    check(dec && dec.text === u.qr_url, `${u.display_number}: el QR contiene la URL de su registro (${u.qr_url})`);
    check(!seen.has(u.qr_url), `${u.display_number}: URL única`);
    seen.add(u.qr_url);
    const doc = await PDFDocument.load(pdf);
    const { width, height } = doc.getPage(0).getSize();
    check(Math.abs(width / PT_PER_MM - v.width_mm) < 0.01 && Math.abs(height / PT_PER_MM - v.height_mm) < 0.01,
      `${u.display_number}: PDF de ${(width / PT_PER_MM).toFixed(2)} × ${(height / PT_PER_MM).toFixed(2)} mm`);
  }
  const items = units.map((u) => ({ unit: u, version: v, numberInDesign: Boolean(batch.number_in_design) }));
  const sheet = await render.sheetPdf(config.uploadsDir, items, { paper: 'A3', orientation: 'vertical', label: true }, { title: batch.code });
  fs.writeFileSync(path.join(out, 'plancha-A3.pdf'), sheet.pdf);
  sheet.layout.cells.slice(0, units.length).forEach((c, i) => {
    const inside = c.x >= 0 && c.y >= 0 && c.x + v.width_mm <= sheet.layout.page_w_mm && c.y + v.height_mm + sheet.layout.label_h_mm <= sheet.layout.page_h_mm;
    check(inside, `Plancha: ${units[i].display_number} entra completo en la hoja, sin escalar (posición ${c.x}, ${c.y} mm)`);
  });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nArchivos en: ${out}`);
  console.log(failed ? `${failed} comprobaciones fallaron.` : 'Todas las comprobaciones automáticas pasaron. Revisá visualmente los PNG y escaneá una impresión de prueba.');
  db.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
