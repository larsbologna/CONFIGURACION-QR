'use strict';
const { tx, nowIso } = require('../db');
const { bad, randomPublicId } = require('../util');
const { audit, unitHistory } = require('./audit');

const PLACEMENTS = ['plancha', 'plastico', 'ambos'];

function normalizeFormat({ prefix = '', min_digits = 3 } = {}) {
  const p = String(prefix ?? '').trim().toUpperCase();
  // Solo letras (+ guion final opcional): así dos prefijos distintos nunca
  // pueden producir el mismo texto visible (ej. "A1"+"011" vs "A"+"1011").
  if (!/^[A-Z]{0,6}-?$/.test(p) || p === '-') throw bad('El prefijo solo admite hasta 6 letras y un guion final opcional (ej: "QR-")');
  const d = Number(min_digits);
  if (!Number.isInteger(d) || d < 1 || d > 8) throw bad('La cantidad mínima de dígitos debe estar entre 1 y 8');
  return { prefix: p, min_digits: d };
}

/** 1 → "001"; 1000 → "1000" (el formato se amplía solo, nunca se trunca). */
function formatNumber(serial, fmt = {}) {
  const { prefix = '', min_digits = 3 } = fmt;
  return `${prefix}${String(serial).padStart(min_digits, '0')}`;
}

function peekNextSerial(db) {
  const c = db.prepare("SELECT value FROM counters WHERE name = 'unit_serial'").get().value;
  const m = db.prepare('SELECT COALESCE(MAX(serial), 0) AS m FROM units').get().m;
  return Math.max(c, m) + 1;
}

function nextBatchCode(db, year) {
  const name = `batch_${year}`;
  db.prepare('INSERT OR IGNORE INTO counters(name, value) VALUES (?, 0)').run(name);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
  const n = db.prepare('SELECT value FROM counters WHERE name = ?').get(name).value;
  return `LOTE-${year}-${String(n).padStart(3, '0')}`;
}

function peekBatchCode(db, year) {
  const r = db.prepare('SELECT value FROM counters WHERE name = ?').get(`batch_${year}`);
  return `LOTE-${year}-${String((r ? r.value : 0) + 1).padStart(3, '0')}`;
}

/**
 * Reserva la numeración y crea todas las unidades del lote en UNA transacción
 * BEGIN IMMEDIATE. Si algo falla no queda nada a medias.
 *
 * placement: 'plancha' | 'plastico' | 'ambos'
 * numberFits: si la plantilla tiene un área válida para el número dentro del plástico.
 */
function createBatch(db, config, actor, {
  designVersionId, quantity, format, placement, notes = null, numberFits, now = new Date(),
}) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > config.maxBatch) {
    throw bad(`La cantidad debe ser un entero entre 1 y ${config.maxBatch}`);
  }
  if (!PLACEMENTS.includes(placement)) throw bad('Ubicación del número inválida');
  const fmt = normalizeFormat(format);
  const warnings = [];
  let numberInDesign = placement === 'plastico' || placement === 'ambos';
  let numberOnSheet = placement === 'plancha' || placement === 'ambos';
  if (numberInDesign && !numberFits) {
    numberInDesign = false;
    numberOnSheet = true;
    warnings.push('La plantilla no tiene un área válida para el número dentro del plástico: el producto físico NO tendrá el número visible. Se mantiene la numeración debajo de cada diseño en la plancha.');
  }
  if (!config.publicBaseUrlIsProduction) {
    warnings.push(`Los QR de este lote apuntan a ${config.publicBaseUrl}, que no es un dominio público HTTPS. Sirven solo para pruebas.`);
  }

  return tx(db, () => {
    const version = db.prepare('SELECT * FROM design_versions WHERE id = ?').get(designVersionId);
    if (!version) throw bad('La versión de diseño no existe');

    const first = peekNextSerial(db);
    const last = first + quantity - 1;
    db.prepare("UPDATE counters SET value = ? WHERE name = 'unit_serial'").run(last);
    const code = nextBatchCode(db, now.getFullYear());
    const ts = nowIso();

    const batchId = Number(db.prepare(`INSERT INTO batches(code, design_version_id, quantity, first_serial, last_serial,
        number_prefix, number_min_digits, placement_requested, number_on_sheet, number_in_design, warnings, base_url,
        notes, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      code, version.id, quantity, first, last, fmt.prefix, fmt.min_digits, placement,
      numberOnSheet ? 1 : 0, numberInDesign ? 1 : 0, warnings.length ? JSON.stringify(warnings) : null,
      config.publicBaseUrl, notes, ts, actor?.id ?? null).lastInsertRowid);

    db.prepare('UPDATE design_versions SET locked = 1 WHERE id = ?').run(version.id);

    const insert = db.prepare(`INSERT INTO units(serial, display_number, public_id, qr_url, batch_id, design_version_id,
        status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'generado', ?, ?)`);
    const exists = db.prepare('SELECT 1 FROM units WHERE public_id = ?');
    const hist = db.prepare(`INSERT INTO unit_history(unit_id, admin_id, action, old_value, new_value, note, created_at)
      VALUES (?, ?, 'creada', NULL, ?, ?, ?)`);
    const seen = new Set();
    for (let serial = first; serial <= last; serial++) {
      let pid;
      do { pid = randomPublicId(); } while (seen.has(pid) || exists.get(pid));
      seen.add(pid);
      const url = `${config.publicBaseUrl}/q/${pid}`;
      const unitId = insert.run(serial, formatNumber(serial, fmt), pid, url, batchId, version.id, ts, ts).lastInsertRowid;
      hist.run(unitId, actor?.id ?? null, 'generado', `Lote ${code}`, ts);
    }
    audit(db, actor, 'lote.crear', { entityType: 'batch', entityId: batchId, details: { code, quantity, first, last } });
    return getBatch(db, batchId);
  });
}

function getBatch(db, id) {
  const b = db.prepare(`SELECT b.*, d.name AS design_name, v.version AS design_version, v.design_id
    FROM batches b JOIN design_versions v ON v.id = b.design_version_id JOIN designs d ON d.id = v.design_id
    WHERE b.id = ?`).get(id);
  if (!b) return null;
  b.warnings = b.warnings ? JSON.parse(b.warnings) : [];
  b.first_display = formatNumber(b.first_serial, { prefix: b.number_prefix, min_digits: b.number_min_digits });
  b.last_display = formatNumber(b.last_serial, { prefix: b.number_prefix, min_digits: b.number_min_digits });
  return b;
}

/** Unidad de reemplazo: lote de 1 vinculado a la unidad original. */
function createReplacementUnit(db, config, actor, original, { numberFits }) {
  return tx(db, () => {
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(original.batch_id);
    const b = createBatch(db, config, actor, {
      designVersionId: original.design_version_id,
      quantity: 1,
      format: { prefix: batch.number_prefix, min_digits: batch.number_min_digits },
      placement: batch.placement_requested,
      notes: `Reemplazo de la unidad ${original.display_number}`,
      numberFits,
    });
    const unit = db.prepare('SELECT * FROM units WHERE batch_id = ?').get(b.id);
    unitHistory(db, actor, unit.id, 'reemplazo_de', null, original.display_number);
    return unit;
  });
}

module.exports = { formatNumber, normalizeFormat, peekNextSerial, peekBatchCode, createBatch, getBatch, createReplacementUnit, PLACEMENTS };
