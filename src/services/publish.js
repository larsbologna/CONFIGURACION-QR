'use strict';
/**
 * Publicación estática para GitHub Pages.
 *
 * GitHub Pages no ejecuta un servidor: cada QR apunta a
 *   <PUBLIC_BASE_URL>/q/<identificador>
 * y GitHub Pages sirve el archivo docs/q/<identificador>.html, que redirige al
 * destino actual. Cambiar un destino = regenerar ese archivo y subirlo (push);
 * el QR impreso no cambia nunca.
 *
 * docs/registro.json guarda los datos públicos de cada unidad (número, URL,
 * lote, diseño). Con él, el panel de cualquier PC reconstruye la base si está
 * vacía, así la numeración nunca se repite aunque se cambie de computadora.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { tx, nowIso } = require('../db');
const { escapeHtml, PUBLIC_ID_RE } = require('../util');

const REGISTRY_VERSION = 1;

function staticDir(config) {
  return config.staticDir;
}

const CSS = 'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f5f7;color:#1d2330}'
  + '.card{max-width:440px;margin:12vh auto;background:#fff;border-radius:12px;padding:28px 24px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.08)}'
  + 'h1{font-size:21px;margin:0 0 10px}p{color:#5d6676}nav{display:flex;flex-direction:column;gap:10px;margin-top:18px}'
  + '.btn{display:block;padding:13px;border-radius:8px;background:#1a5fd0;color:#fff;text-decoration:none;font-weight:600}';

function shell(title, body, head = '') {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">${head}
<title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body><main class="card">${body}</main></body></html>
`;
}

/** HTML estático de una unidad según su estado y destino (misma lógica que /q/:id del servidor). */
function unitPage(unit) {
  if (unit.status === 'baja') return shell('Código dado de baja', '<h1>Este código ya no está en uso</h1>');
  if (unit.status === 'pausado') return shell('Temporalmente pausado', '<h1>Temporalmente no disponible</h1><p>Volvé a intentarlo más tarde.</p>');
  if (unit.status === 'defectuoso') return shell('No disponible', '<h1>Este código no está disponible</h1>');
  if (unit.status !== 'activo' || !unit.destination_type) {
    return shell('Código no activado', '<h1>Este código todavía no está activado</h1><p>Si sos el comercio, contactá a tu proveedor.</p>');
  }
  if (unit.destination_type === 'pagina') {
    let cfg = null;
    try { cfg = JSON.parse(unit.destination_config); } catch { cfg = null; }
    if (!cfg) return shell('No disponible', '<h1>Página no disponible</h1>');
    const links = cfg.links.map((l) => `<a class="btn" href="${escapeHtml(l.url)}" rel="noopener noreferrer">${escapeHtml(l.text)}</a>`).join('');
    return shell(cfg.title, `<h1>${escapeHtml(cfg.title)}</h1>${cfg.message ? `<p>${escapeHtml(cfg.message)}</p>` : ''}<nav>${links}</nav>`);
  }
  // Destino validado al guardarlo (https público). Se escapa igual por seguridad.
  const url = escapeHtml(unit.destination_url);
  return shell('Redirigiendo…',
    `<h1>Abriendo…</h1><p><a class="btn" href="${url}" rel="noopener noreferrer">Continuar</a></p>`,
    `<meta http-equiv="refresh" content="0;url=${url}"><link rel="canonical" href="${url}">`
      + `<script>location.replace(${JSON.stringify(unit.destination_url).replace(/</g, '\\u003c')});</script>`);
}

function registry(db) {
  const versions = db.prepare(`SELECT v.*, d.name AS design_name, d.description AS design_description FROM design_versions v
    JOIN designs d ON d.id = v.design_id WHERE v.id IN (SELECT DISTINCT design_version_id FROM batches) ORDER BY v.id`).all();
  const batches = db.prepare('SELECT * FROM batches ORDER BY id').all();
  const units = db.prepare(`SELECT u.serial, u.display_number, u.public_id, u.qr_url, u.batch_id, u.design_version_id, u.created_at,
      u.replaces_unit_id, ru.serial AS replaces_serial, u.status, u.destination_type, u.destination_url, u.destination_config
    FROM units u LEFT JOIN units ru ON ru.id = u.replaces_unit_id ORDER BY u.serial`).all();
  return {
    formato: 'registro-plasticos-qr', version: REGISTRY_VERSION, actualizado: nowIso(),
    nota: 'Registro público de unidades generadas. No contiene datos de clientes ni contraseñas. No editar a mano.',
    disenos: versions.map((v) => ({
      id: v.id, nombre: v.design_name, descripcion: v.design_description, version: v.version, imagen: v.image_original_name,
      imagen_sha256: v.image_sha256, ancho_px: v.image_width_px, alto_px: v.image_height_px, formato: v.image_format,
      ancho_mm: v.width_mm, alto_mm: v.height_mm, config: JSON.parse(v.config_json), creado: v.created_at,
    })),
    lotes: batches.map((b) => ({
      id: b.id, codigo: b.code, diseno_id: b.design_version_id, cantidad: b.quantity, primer_serial: b.first_serial,
      ultimo_serial: b.last_serial, prefijo: b.number_prefix, digitos: b.number_min_digits, ubicacion: b.placement_requested,
      numero_en_plancha: b.number_on_sheet, numero_en_plastico: b.number_in_design, dominio: b.base_url, creado: b.created_at,
    })),
    unidades: units.map((u) => ({
      serial: u.serial, numero: u.display_number, id_publico: u.public_id, url: u.qr_url, lote_id: u.batch_id,
      diseno_id: u.design_version_id, creado: u.created_at, reemplaza_serial: u.replaces_serial ?? null,
      // Estado y destino ya son públicos (las páginas redirigen ahí); no hay datos de clientes.
      estado: u.status, destino_tipo: u.destination_type, destino_url: u.destination_url, destino_config: u.destination_config,
    })),
  };
}

function writeIfChanged(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

/** Escribe docs/q/<id>.html de todas las unidades + registro. Devuelve cuántos archivos cambiaron. */
function publishStatic(db, config) {
  const dir = staticDir(config);
  if (!dir) return null;
  let changed = 0;
  changed += writeIfChanged(path.join(dir, '.nojekyll'), '') ? 1 : 0;
  changed += writeIfChanged(path.join(dir, 'index.html'), shell('Códigos QR', '<h1>Códigos QR</h1><p>Escaneá el código de tu plástico.</p>')) ? 1 : 0;
  const units = db.prepare('SELECT * FROM units ORDER BY serial').all();
  for (const u of units) {
    if (!PUBLIC_ID_RE.test(u.public_id)) continue;
    changed += writeIfChanged(path.join(dir, 'q', `${u.public_id}.html`), unitPage(u)) ? 1 : 0;
  }
  const reg = registry(db);
  const file = path.join(dir, 'registro.json');
  // Solo reescribir si cambió algo más que la fecha.
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { prev = null; }
  if (!prev || JSON.stringify({ ...prev, actualizado: null }) !== JSON.stringify({ ...reg, actualizado: null })) {
    fs.writeFileSync(file, `${JSON.stringify(reg, null, 1)}\n`);
    changed++;
  }
  return { changed, units: units.length, dir };
}

/**
 * Si la base no tiene unidades y existe docs/registro.json, reconstruye diseños,
 * lotes y unidades con los MISMOS números e identificadores. Así nunca se
 * reutiliza un número ya fabricado.
 */
function importRegistry(db, config, { storeImageSync }) {
  const dir = staticDir(config);
  if (!dir) return null;
  const file = path.join(dir, 'registro.json');
  if (!fs.existsSync(file)) return null;
  if (db.prepare('SELECT COUNT(*) AS n FROM units').get().n > 0) return null;
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (reg.formato !== 'registro-plasticos-qr' || !Array.isArray(reg.unidades) || !reg.unidades.length) return null;
  return tx(db, () => {
    const vmap = new Map(); const bmap = new Map(); const umap = new Map();
    for (const d of reg.disenos) {
      const img = storeImageSync(d);
      const designId = Number(db.prepare('INSERT INTO designs(name, description, created_at) VALUES (?, ?, ?)').run(d.nombre, d.descripcion ?? null, d.creado).lastInsertRowid);
      vmap.set(d.id, Number(db.prepare(`INSERT INTO design_versions(design_id, version, image_file, image_sha256, image_original_name,
        image_width_px, image_height_px, image_format, width_mm, height_mm, config_json, notes, locked, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(designId, d.version, img, d.imagen_sha256, d.imagen, d.ancho_px, d.alto_px,
        d.formato, d.ancho_mm, d.alto_mm, JSON.stringify(d.config), 'Importado de docs/registro.json', d.creado).lastInsertRowid));
    }
    let maxSerial = 0; const years = new Map();
    for (const b of reg.lotes) {
      bmap.set(b.id, Number(db.prepare(`INSERT INTO batches(code, design_version_id, quantity, first_serial, last_serial, number_prefix,
        number_min_digits, placement_requested, number_on_sheet, number_in_design, base_url, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(b.codigo, vmap.get(b.diseno_id), b.cantidad, b.primer_serial, b.ultimo_serial,
        b.prefijo, b.digitos, b.ubicacion, b.numero_en_plancha, b.numero_en_plastico, b.dominio, 'Importado de docs/registro.json', b.creado).lastInsertRowid));
      const m = String(b.codigo).match(/^LOTE-(\d{4})-(\d+)$/);
      if (m) years.set(m[1], Math.max(years.get(m[1]) || 0, Number(m[2])));
    }
    const ins = db.prepare(`INSERT INTO units(serial, display_number, public_id, qr_url, batch_id, design_version_id, status,
        destination_type, destination_url, destination_config, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const u of reg.unidades) {
      umap.set(u.serial, Number(ins.run(u.serial, u.numero, u.id_publico, u.url, bmap.get(u.lote_id), vmap.get(u.diseno_id),
        u.estado || 'generado', u.destino_tipo ?? null, u.destino_url ?? null, u.destino_config ?? null, u.creado, nowIso()).lastInsertRowid));
      maxSerial = Math.max(maxSerial, u.serial);
    }
    for (const u of reg.unidades) {
      if (u.reemplaza_serial) db.prepare('UPDATE units SET replaces_unit_id = ? WHERE serial = ?').run(umap.get(u.reemplaza_serial), u.serial);
    }
    db.prepare("UPDATE counters SET value = MAX(value, ?) WHERE name = 'unit_serial'").run(maxSerial);
    for (const [y, n] of years) {
      db.prepare('INSERT OR IGNORE INTO counters(name, value) VALUES (?, 0)').run(`batch_${y}`);
      db.prepare('UPDATE counters SET value = MAX(value, ?) WHERE name = ?').run(n, `batch_${y}`);
    }
    return { units: reg.unidades.length, batches: reg.lotes.length };
  });
}

/** git add + commit + push de la carpeta publicada. */
function gitPublish(config, message) {
  const run = (args) => new Promise((resolve) => {
    execFile('git', args, { cwd: config.root, timeout: 60000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }));
  });
  return (async () => {
    const rel = path.relative(config.root, staticDir(config)) || '.';
    const steps = [];
    const add = await run(['add', '--', rel]); steps.push(add);
    if (!add.ok) return { ok: false, steps };
    const diff = await run(['diff', '--cached', '--quiet', '--', rel]);
    if (diff.ok) return { ok: true, nothing: true, steps };
    const commit = await run(['commit', '-m', message, '--', rel]); steps.push(commit);
    if (!commit.ok) return { ok: false, steps };
    const push = await run(['push']); steps.push(push);
    return { ok: push.ok, steps };
  })();
}

module.exports = { unitPage, registry, publishStatic, importRegistry, gitPublish };
