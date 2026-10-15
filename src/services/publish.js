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
 * docs/registro.json es la fuente común entre el panel (Node) y el generador web
 * (docs/generador/). Lleva un número de "revision" que sube con cada cambio: el
 * panel incorpora (sincroniza) las revisiones nuevas antes de publicar, así ningún
 * número de QR se repite y no se pierden cambios hechos desde la web.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { tx, nowIso } = require('../db');
const { PUBLIC_ID_RE } = require('../util');
const { unitPage: sharedUnitPage } = require('../shared/pagina-qr');

const REGISTRY_FORMAT = 'registro-plasticos-qr';
const SHARED_FILE = path.join(__dirname, '..', 'shared', 'pagina-qr.js');
const FONT_FILE = path.join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

const unitPage = (u) => sharedUnitPage(u);

function knownRevision(db) {
  const r = db.prepare("SELECT value FROM counters WHERE name = 'registry_revision'").get();
  return r ? r.value : 0;
}
function setKnownRevision(db, rev) {
  db.prepare("INSERT OR IGNORE INTO counters(name, value) VALUES ('registry_revision', 0)").run();
  db.prepare("UPDATE counters SET value = ? WHERE name = 'registry_revision'").run(rev);
}

function readDiskRegistry(config) {
  if (!config.staticDir) return null;
  const file = path.join(config.staticDir, 'registro.json');
  if (!fs.existsSync(file)) return null;
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (reg.formato !== REGISTRY_FORMAT || !Array.isArray(reg.unidades)) throw new Error('docs/registro.json no tiene el formato esperado');
  return reg;
}

function registry(db, config) {
  const versions = db.prepare(`SELECT v.*, d.name AS design_name, d.description AS design_description FROM design_versions v
    JOIN designs d ON d.id = v.design_id WHERE v.id IN (SELECT DISTINCT design_version_id FROM batches) ORDER BY v.id`).all();
  const batches = db.prepare('SELECT * FROM batches ORDER BY id').all();
  const units = db.prepare(`SELECT u.*, ru.serial AS replaces_serial
    FROM units u LEFT JOIN units ru ON ru.id = u.replaces_unit_id ORDER BY u.serial`).all();
  return {
    formato: REGISTRY_FORMAT, version: 1, revision: knownRevision(db), actualizado: nowIso(),
    dominio: config.publicBaseUrl,
    nota: 'Registro público de los QR. Lo leen y escriben el panel y el generador web. No editar a mano.',
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
      // Estado, destino y etiqueta ya son visibles públicamente (las páginas redirigen ahí).
      estado: u.status, destino_tipo: u.destination_type, destino_url: u.destination_url, destino_config: u.destination_config,
      etiqueta: u.label ?? null,
    })),
  };
}

const comparable = (reg) => JSON.stringify({ ...reg, actualizado: null, revision: null });

function writeIfChanged(file, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (fs.existsSync(file) && fs.readFileSync(file).equals(buf)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return true;
}

/**
 * Escribe docs/q/<id>.html de todas las unidades, el registro y los archivos que
 * necesita el generador web. Antes incorpora cambios más nuevos del registro.
 */
function publishStatic(db, config, { storeImageSync } = {}) {
  const dir = config.staticDir;
  if (!dir) return null;
  const disk = readDiskRegistry(config);
  if (disk && (disk.revision || 0) > knownRevision(db)) {
    syncRegistry(db, config, { storeImageSync: storeImageSync || defaultImageRestorer(config), reg: disk });
  }
  let changed = 0;
  const w = (rel, content) => { changed += writeIfChanged(path.join(dir, rel), content) ? 1 : 0; };
  w('.nojekyll', '');
  w('index.html', sharedUnitPage({ status: 'generado' }).replace('Este código todavía no está activado', 'Códigos QR')
    .replace('<p>Si sos el comercio, contactá a tu proveedor.</p>', '<p>Escaneá el código de tu plástico.</p>'));
  const units = db.prepare('SELECT * FROM units ORDER BY serial').all();
  for (const u of units) {
    if (PUBLIC_ID_RE.test(u.public_id)) w(path.join('q', `${u.public_id}.html`), unitPage(u));
  }
  // Archivos de apoyo del generador web (copias: el original está en src/ y assets/).
  w(path.join('generador', 'pagina-qr.js'), fs.readFileSync(SHARED_FILE));
  w(path.join('generador', 'fuente-numeros.ttf'), fs.readFileSync(FONT_FILE));
  const reg = registry(db, config);
  for (const d of reg.disenos) {
    const v = db.prepare('SELECT image_file FROM design_versions WHERE id = ?').get(d.id);
    const src = path.join(config.uploadsDir, path.basename(v.image_file));
    if (fs.existsSync(src)) w(path.join('generador', 'disenos', `${d.imagen_sha256}.${d.formato === 'jpeg' ? 'jpg' : 'png'}`), fs.readFileSync(src));
  }
  if (!disk || comparable(disk) !== comparable(reg)) {
    const rev = Math.max(knownRevision(db), disk ? disk.revision || 0 : 0) + (disk ? 1 : 0);
    setKnownRevision(db, rev);
    reg.revision = rev;
    fs.writeFileSync(path.join(dir, 'registro.json'), `${JSON.stringify(reg, null, 1)}\n`);
    changed++;
  }
  return { changed, units: units.length, dir, revision: knownRevision(db) };
}

function defaultImageRestorer(config) {
  return (d) => {
    const ext = d.formato === 'jpeg' ? 'jpg' : 'png';
    const target = path.join(config.uploadsDir, `${d.imagen_sha256}.${ext}`);
    if (fs.existsSync(target)) return path.basename(target);
    const candidates = [
      path.join(config.staticDir || '', 'generador', 'disenos', `${d.imagen_sha256}.${ext}`),
      path.join(config.root, path.basename(String(d.imagen || ''))),
      path.join(config.root, 'disenos', path.basename(String(d.imagen || ''))),
    ];
    for (const f of candidates) {
      if (f && fs.existsSync(f) && fs.statSync(f).isFile()) {
        const buf = fs.readFileSync(f);
        if (require('node:crypto').createHash('sha256').update(buf).digest('hex') !== d.imagen_sha256) continue;
        fs.mkdirSync(config.uploadsDir, { recursive: true });
        fs.writeFileSync(target, buf);
        return path.basename(target);
      }
    }
    throw new Error(`No se encuentra la imagen del diseño "${d.nombre}" (${d.imagen}).`);
  };
}

/**
 * Incorpora docs/registro.json a la base:
 *  - base vacía: importa todo (mismos números, identificadores y lotes);
 *  - base con datos y revisión más nueva: agrega lo que falte y actualiza estado,
 *    destino y etiqueta de cada unidad (cambios hechos desde el generador web).
 * Si el registro contradice la base (mismo número con otro QR) se detiene sin cambiar nada.
 */
function syncRegistry(db, config, { storeImageSync, reg } = {}) {
  reg = reg || readDiskRegistry(config);
  if (!reg) return null;
  const restore = storeImageSync || defaultImageRestorer(config);
  const empty = db.prepare('SELECT COUNT(*) AS n FROM units').get().n === 0;
  const rev = reg.revision || 0;
  if (!empty && rev <= knownRevision(db)) return null;
  if (empty && !reg.unidades.length) return null;
  return tx(db, () => {
    const out = { units_added: 0, units_updated: 0, batches_added: 0, designs_added: 0 };
    for (const d of reg.disenos) {
      if (db.prepare('SELECT 1 FROM design_versions WHERE id = ?').get(d.id)) continue;
      const img = restore(d);
      const designId = Number(db.prepare('INSERT INTO designs(name, description, created_at) VALUES (?, ?, ?)').run(d.nombre, d.descripcion ?? null, d.creado).lastInsertRowid);
      db.prepare(`INSERT INTO design_versions(id, design_id, version, image_file, image_sha256, image_original_name,
        image_width_px, image_height_px, image_format, width_mm, height_mm, config_json, notes, locked, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(d.id, designId, d.version, img, d.imagen_sha256, d.imagen, d.ancho_px, d.alto_px,
        d.formato, d.ancho_mm, d.alto_mm, JSON.stringify(d.config), 'Importado de docs/registro.json', d.creado);
      out.designs_added++;
    }
    const years = new Map();
    for (const b of reg.lotes) {
      const m = String(b.codigo).match(/^LOTE-(\d{4})-(\d+)$/);
      if (m) years.set(m[1], Math.max(years.get(m[1]) || 0, Number(m[2])));
      const cur = db.prepare('SELECT code FROM batches WHERE id = ?').get(b.id);
      if (cur) {
        if (cur.code !== b.codigo) throw new Error(`El registro no coincide con la base: el lote #${b.id} es ${cur.code} acá y ${b.codigo} en GitHub.`);
        continue;
      }
      db.prepare(`INSERT INTO batches(id, code, design_version_id, quantity, first_serial, last_serial, number_prefix,
        number_min_digits, placement_requested, number_on_sheet, number_in_design, base_url, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(b.id, b.codigo, b.diseno_id, b.cantidad, b.primer_serial, b.ultimo_serial,
        b.prefijo, b.digitos, b.ubicacion, b.numero_en_plancha, b.numero_en_plastico, b.dominio, 'Importado de docs/registro.json', b.creado);
      out.batches_added++;
    }
    let maxSerial = 0;
    for (const u of reg.unidades) {
      maxSerial = Math.max(maxSerial, u.serial);
      const cur = db.prepare('SELECT * FROM units WHERE serial = ?').get(u.serial);
      if (!cur) {
        db.prepare(`INSERT INTO units(serial, display_number, public_id, qr_url, batch_id, design_version_id, status,
            destination_type, destination_url, destination_config, label, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(u.serial, u.numero, u.id_publico, u.url, u.lote_id, u.diseno_id,
          u.estado || 'generado', u.destino_tipo ?? null, u.destino_url ?? null, u.destino_config ?? null, u.etiqueta ?? null, u.creado, nowIso());
        out.units_added++;
        continue;
      }
      if (cur.public_id !== u.id_publico) throw new Error(`El registro no coincide con la base: el número ${u.numero} tiene otro QR en GitHub.`);
      const next = { status: u.estado || cur.status, destination_type: u.destino_tipo ?? null, destination_url: u.destino_url ?? null, destination_config: u.destino_config ?? null, label: u.etiqueta ?? null };
      if (next.status === cur.status && next.destination_type === cur.destination_type && next.destination_url === cur.destination_url
        && next.destination_config === cur.destination_config && next.label === cur.label) continue;
      if (cur.status === 'baja' && next.status !== 'baja') throw new Error(`La unidad ${cur.display_number} está dada de baja en la base y activa en GitHub.`);
      db.prepare('UPDATE units SET status = ?, destination_type = ?, destination_url = ?, destination_config = ?, label = ?, updated_at = ? WHERE id = ?')
        .run(next.status, next.destination_type, next.destination_url, next.destination_config, next.label, nowIso(), cur.id);
      db.prepare(`INSERT INTO unit_history(unit_id, admin_id, action, old_value, new_value, note, created_at)
        VALUES (?, NULL, 'sincronizado', ?, ?, 'Cambio hecho desde el generador web', ?)`)
        .run(cur.id, `${cur.status} · ${cur.destination_url || 'sin destino'}`, `${next.status} · ${next.destination_url || 'sin destino'}`, nowIso());
      out.units_updated++;
    }
    for (const u of reg.unidades) {
      if (u.reemplaza_serial) {
        const r = db.prepare('SELECT id FROM units WHERE serial = ?').get(u.reemplaza_serial);
        if (r) db.prepare('UPDATE units SET replaces_unit_id = ? WHERE serial = ? AND replaces_unit_id IS NULL').run(r.id, u.serial);
      }
    }
    db.prepare("UPDATE counters SET value = MAX(value, ?) WHERE name = 'unit_serial'").run(maxSerial);
    for (const [y, n] of years) {
      db.prepare('INSERT OR IGNORE INTO counters(name, value) VALUES (?, 0)').run(`batch_${y}`);
      db.prepare('UPDATE counters SET value = MAX(value, ?) WHERE name = ?').run(n, `batch_${y}`);
    }
    setKnownRevision(db, Math.max(rev, knownRevision(db)));
    return { ...out, revision: rev, imported_all: empty };
  });
}

/** Compatibilidad: importación inicial (base vacía). */
function importRegistry(db, config, opts = {}) {
  if (db.prepare('SELECT COUNT(*) AS n FROM units').get().n > 0) return null;
  const r = syncRegistry(db, config, opts);
  return r ? { units: r.units_added, batches: r.batches_added } : null;
}

/** Trae lo último de GitHub, incorpora cambios web, regenera y sube la carpeta publicada. */
function gitPublish(db, config, message) {
  const run = (args) => new Promise((resolve) => {
    execFile('git', args, { cwd: config.root, timeout: 60000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }));
  });
  return (async () => {
    const rel = path.relative(config.root, config.staticDir) || '.';
    const steps = [];
    // Los archivos de docs/ se regeneran desde la base: se descartan las copias locales antes de traer lo nuevo.
    steps.push(await run(['checkout', '--', rel]));
    steps.push(await run(['clean', '-fdq', '--', path.join(rel, 'q')]));
    const pull = await run(['pull', '--ff-only']); steps.push(pull);
    if (!pull.ok) return { ok: false, steps };
    publishStatic(db, config);
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

module.exports = { unitPage, registry, publishStatic, syncRegistry, importRegistry, gitPublish, readDiskRegistry, knownRevision };
