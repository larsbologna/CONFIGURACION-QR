'use strict';
const { tx, nowIso } = require('../db');
const { bad, notFound, conflict, str, int, isoDate } = require('../util');
const { audit, unitHistory } = require('./audit');
const { buildDestination, describeDestination } = require('./destinations');
const { createReplacementUnit } = require('./numbering');

const STATUSES = {
  generado: 'Generado', disponible: 'Disponible', reservado: 'Reservado', vendido: 'Vendido', entregado: 'Entregado',
  activo: 'Activo', pausado: 'Pausado', defectuoso: 'Defectuoso', baja: 'Dado de baja',
};

const UNIT_SELECT = `SELECT u.*, b.code AS batch_code, b.number_in_design, b.number_on_sheet, bz.name AS business_name,
  d.name AS design_name, v.version AS design_version, ru.display_number AS replaces_display_number
  FROM units u
  JOIN batches b ON b.id = u.batch_id
  JOIN design_versions v ON v.id = u.design_version_id
  JOIN designs d ON d.id = v.design_id
  LEFT JOIN businesses bz ON bz.id = u.business_id
  LEFT JOIN units ru ON ru.id = u.replaces_unit_id`;

function decorate(u) {
  if (!u) return u;
  u.status_label = STATUSES[u.status];
  u.destination_label = describeDestination(u);
  return u;
}

/** "7", "007", "QR-007" → serial 7 */
function parseSerial(text) {
  const m = String(text || '').trim().match(/^[A-Za-z]{0,6}-?0*(\d{1,9})$/);
  return m ? Number(m[1]) : null;
}

/** "1-10, 15, QR-020" → [1..10, 15, 20] */
function parseSerialList(text, max = 5000) {
  const out = new Set();
  for (const part of String(text || '').split(/[,\s;]+/).filter(Boolean)) {
    const range = part.match(/^([A-Za-z]{0,6}-?\d+)-([A-Za-z]{0,6}-?\d+)$/);
    if (range) {
      const a = parseSerial(range[1]); const b = parseSerial(range[2]);
      if (a == null || b == null || b < a) throw bad(`Rango inválido: ${part}`);
      if (b - a + 1 > max) throw bad(`Rango demasiado grande (máx. ${max})`);
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      const s = parseSerial(part);
      if (s == null) throw bad(`Número inválido: ${part}`);
      out.add(s);
    }
    if (out.size > max) throw bad(`Demasiadas unidades (máx. ${max})`);
  }
  return [...out].sort((x, y) => x - y);
}

function searchUnits(db, f = {}) {
  const where = []; const params = [];
  if (f.number) {
    const s = parseSerial(f.number);
    if (s != null) { where.push('u.serial = ?'); params.push(s); } else { where.push('u.display_number LIKE ?'); params.push(`%${f.number}%`); }
  }
  if (f.business) { where.push('bz.name LIKE ?'); params.push(`%${f.business}%`); }
  if (f.business_id) { where.push('u.business_id = ?'); params.push(Number(f.business_id)); }
  if (f.batch) { where.push('b.code LIKE ?'); params.push(`%${f.batch}%`); }
  if (f.batch_id) { where.push('u.batch_id = ?'); params.push(Number(f.batch_id)); }
  if (f.status) { if (!STATUSES[f.status]) throw bad('Estado inválido'); where.push('u.status = ?'); params.push(f.status); }
  if (f.design) { where.push('d.name LIKE ?'); params.push(`%${f.design}%`); }
  if (f.q) {
    where.push('(u.display_number LIKE ? OR bz.name LIKE ? OR b.code LIKE ? OR d.name LIKE ? OR u.public_id = ?)');
    params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`, f.q);
  }
  const limit = int(f.limit, { field: 'limit', min: 1, max: 1000, def: 50 });
  const offset = int(f.offset, { field: 'offset', min: 0, max: 1e9, def: 0 });
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = UNIT_SELECT.slice(UNIT_SELECT.indexOf('FROM'));
  const total = db.prepare(`SELECT COUNT(*) AS n ${from} ${w}`).get(...params).n;
  const rows = db.prepare(`${UNIT_SELECT} ${w} ORDER BY u.serial ${f.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, rows: rows.map(decorate) };
}

function getUnit(db, id) {
  const u = decorate(db.prepare(`${UNIT_SELECT} WHERE u.id = ?`).get(id));
  if (!u) throw notFound('Unidad inexistente');
  return u;
}

function unitHistoryList(db, id) {
  return db.prepare(`SELECT h.*, a.username FROM unit_history h LEFT JOIN admins a ON a.id = h.admin_id
    WHERE h.unit_id = ? ORDER BY h.id DESC`).all(id);
}

function setStatus(db, actor, id, status, note) {
  if (!STATUSES[status]) throw bad('Estado inválido');
  note = str(note, { field: 'nota', max: 500 });
  return tx(db, () => {
    const u = getUnit(db, id);
    if (u.status === status) return u;
    if (u.status === 'baja') throw conflict('La unidad está dada de baja y no puede cambiar de estado');
    db.prepare('UPDATE units SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
    unitHistory(db, actor, id, 'estado', u.status, status, note);
    audit(db, actor, 'unidad.estado', { entityType: 'unit', entityId: id, details: { from: u.status, to: status } });
    return getUnit(db, id);
  });
}

function setDestination(db, config, actor, id, input, note) {
  const dest = buildDestination(input, config);
  note = str(note, { field: 'nota', max: 500 });
  return tx(db, () => {
    const u = getUnit(db, id);
    if (u.status === 'baja') throw conflict('La unidad está dada de baja');
    const old = { type: u.destination_type, url: u.destination_url, config: u.destination_config };
    db.prepare('UPDATE units SET destination_type = ?, destination_url = ?, destination_config = ?, updated_at = ? WHERE id = ?')
      .run(dest.destination_type, dest.destination_url, dest.destination_config, nowIso(), id);
    unitHistory(db, actor, id, 'destino', describeDestination(u), describeDestination(dest), note);
    audit(db, actor, 'unidad.destino', { entityType: 'unit', entityId: id, details: { old, new: dest } });
    return getUnit(db, id);
  });
}

/** Asigna unidades a un negocio. Falla completa si alguna ya pertenece a otro. */
function assignToBusiness(db, actor, { serials, businessId, deliveredAt, setStatusTo }) {
  const bizId = int(businessId, { field: 'negocio', min: 1, required: true });
  const delivered = isoDate(deliveredAt, { field: 'fecha de entrega' });
  if (setStatusTo && !STATUSES[setStatusTo]) throw bad('Estado inválido');
  if (!serials.length) throw bad('No se indicaron unidades');
  return tx(db, () => {
    const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(bizId);
    if (!biz) throw notFound('Negocio inexistente');
    const ts = nowIso();
    const done = [];
    for (const serial of serials) {
      const u = db.prepare('SELECT * FROM units WHERE serial = ?').get(serial);
      if (!u) throw bad(`No existe la unidad número ${serial}`);
      if (u.status === 'baja' || u.status === 'defectuoso') throw conflict(`La unidad ${u.display_number} está ${STATUSES[u.status].toLowerCase()} y no se puede asignar`);
      // UPDATE condicional: imposible asignar una unidad a dos negocios a la vez.
      const r = db.prepare(`UPDATE units SET business_id = ?, assigned_at = COALESCE(CASE WHEN business_id = ? THEN assigned_at END, ?),
          delivered_at = COALESCE(?, delivered_at), updated_at = ?
        WHERE id = ? AND (business_id IS NULL OR business_id = ?)`).run(bizId, bizId, ts, delivered, ts, u.id, bizId);
      if (r.changes !== 1) {
        const other = db.prepare('SELECT name FROM businesses WHERE id = ?').get(u.business_id);
        throw conflict(`La unidad ${u.display_number} ya está asignada a "${other?.name}". Quitala de ese negocio primero.`);
      }
      if (u.business_id !== bizId) unitHistory(db, actor, u.id, 'asignada', null, biz.name);
      if (delivered && delivered !== u.delivered_at) unitHistory(db, actor, u.id, 'entrega', u.delivered_at, delivered);
      if (setStatusTo && setStatusTo !== u.status) {
        db.prepare('UPDATE units SET status = ? WHERE id = ?').run(setStatusTo, u.id);
        unitHistory(db, actor, u.id, 'estado', u.status, setStatusTo);
      }
      done.push(u.display_number);
    }
    audit(db, actor, 'negocio.asignar', { entityType: 'business', entityId: bizId, details: { units: done } });
    return done;
  });
}

function unassign(db, actor, id, note) {
  return tx(db, () => {
    const u = getUnit(db, id);
    if (!u.business_id) return u;
    db.prepare('UPDATE units SET business_id = NULL, assigned_at = NULL, delivered_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
    unitHistory(db, actor, id, 'desasignada', u.business_name, null, str(note, { field: 'nota', max: 500 }));
    audit(db, actor, 'unidad.desasignar', { entityType: 'unit', entityId: id, details: { business: u.business_name } });
    return getUnit(db, id);
  });
}

function setDelivered(db, actor, id, date) {
  const d = isoDate(date, { field: 'fecha de entrega' });
  return tx(db, () => {
    const u = getUnit(db, id);
    db.prepare('UPDATE units SET delivered_at = ?, updated_at = ? WHERE id = ?').run(d, nowIso(), id);
    unitHistory(db, actor, id, 'entrega', u.delivered_at, d);
    return getUnit(db, id);
  });
}

/**
 * Marca una unidad como defectuosa y la reemplaza por otra (existente en stock
 * o nueva). El reemplazo queda vinculado a la original y hereda negocio y destino.
 */
function replaceDefective(db, config, actor, id, { replacementSerial, note, numberFits }) {
  note = str(note, { field: 'nota', max: 500 });
  return tx(db, () => {
    const orig = getUnit(db, id);
    if (orig.status === 'baja') throw conflict('La unidad está dada de baja');
    let rep;
    if (replacementSerial != null) {
      rep = db.prepare('SELECT * FROM units WHERE serial = ?').get(replacementSerial);
      if (!rep) throw bad('La unidad de reemplazo no existe');
      if (rep.id === orig.id) throw bad('Una unidad no puede reemplazarse a sí misma');
      if (rep.business_id) throw conflict(`La unidad ${rep.display_number} ya está asignada a un negocio`);
      if (!['generado', 'disponible'].includes(rep.status)) throw conflict(`La unidad ${rep.display_number} no está disponible`);
      if (rep.replaces_unit_id) throw conflict(`La unidad ${rep.display_number} ya es reemplazo de otra`);
    } else {
      rep = createReplacementUnit(db, config, actor, orig, { numberFits });
    }
    const ts = nowIso();
    const newStatus = ['generado', 'disponible', 'defectuoso'].includes(orig.status) ? 'disponible' : orig.status;
    db.prepare(`UPDATE units SET replaces_unit_id = ?, business_id = ?, assigned_at = ?, destination_type = ?, destination_url = ?,
        destination_config = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(orig.id, orig.business_id, orig.business_id ? ts : null, orig.destination_type, orig.destination_url,
        orig.destination_config, newStatus, ts, rep.id);
    db.prepare("UPDATE units SET status = 'defectuoso', updated_at = ? WHERE id = ?").run(ts, orig.id);
    unitHistory(db, actor, orig.id, 'estado', orig.status, 'defectuoso', note);
    unitHistory(db, actor, orig.id, 'reemplazada_por', null, rep.display_number, note);
    unitHistory(db, actor, rep.id, 'reemplaza_a', null, orig.display_number, note);
    audit(db, actor, 'unidad.reemplazo', { entityType: 'unit', entityId: orig.id, details: { replacement: rep.display_number } });
    return getUnit(db, rep.id);
  });
}

function dashboard(db) {
  const counts = Object.fromEntries(Object.keys(STATUSES).map((s) => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM units GROUP BY status').all()) counts[r.status] = r.n;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const batches = db.prepare(`SELECT b.id, b.code, b.quantity, b.first_serial, b.last_serial, b.number_prefix, b.number_min_digits,
      b.created_at, d.name AS design_name, v.version AS design_version
    FROM batches b JOIN design_versions v ON v.id = b.design_version_id JOIN designs d ON d.id = v.design_id
    ORDER BY b.id DESC LIMIT 8`).all();
  const changes = db.prepare(`SELECT h.*, a.username, u.display_number FROM unit_history h
    JOIN units u ON u.id = h.unit_id LEFT JOIN admins a ON a.id = h.admin_id
    WHERE h.action = 'destino' ORDER BY h.id DESC LIMIT 10`).all();
  const scans = db.prepare("SELECT COUNT(*) AS n FROM scans WHERE kind = 'escaneo'").get().n;
  return { total, counts, batches, changes, scans };
}

module.exports = {
  STATUSES, parseSerial, parseSerialList, searchUnits, getUnit, unitHistoryList, setStatus, setDestination,
  assignToBusiness, unassign, setDelivered, replaceDefective, dashboard,
};
