'use strict';
const { tx, nowIso } = require('../db');
const { notFound, str, isoDate } = require('../util');
const { audit } = require('./audit');

function clean(input) {
  return {
    name: str(input.name, { field: 'nombre', max: 150, required: true }),
    category: str(input.category, { field: 'rubro', max: 100 }),
    phone: str(input.phone, { field: 'teléfono', max: 40 }),
    contact: str(input.contact, { field: 'contacto', max: 150 }),
    notes: str(input.notes, { field: 'observaciones', max: 2000 }),
    delivery_date: isoDate(input.delivery_date, { field: 'fecha de entrega' }),
  };
}

function listBusinesses(db, { q } = {}) {
  const like = `%${q || ''}%`;
  return db.prepare(`SELECT bz.*, (SELECT COUNT(*) FROM units u WHERE u.business_id = bz.id) AS units_count,
      (SELECT COUNT(*) FROM scans s WHERE s.business_id = bz.id AND s.kind = 'escaneo') AS scans_count
    FROM businesses bz WHERE bz.name LIKE ? OR IFNULL(bz.category, '') LIKE ? OR IFNULL(bz.contact, '') LIKE ?
    ORDER BY bz.archived, bz.name COLLATE NOCASE`).all(like, like, like);
}

function getBusiness(db, id) {
  const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
  if (!b) throw notFound('Negocio inexistente');
  return b;
}

function createBusiness(db, actor, input) {
  const c = clean(input); const ts = nowIso();
  return tx(db, () => {
    const id = Number(db.prepare(`INSERT INTO businesses(name, category, phone, contact, notes, delivery_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(c.name, c.category, c.phone, c.contact, c.notes, c.delivery_date, ts, ts).lastInsertRowid);
    audit(db, actor, 'negocio.crear', { entityType: 'business', entityId: id, details: c });
    return getBusiness(db, id);
  });
}

function updateBusiness(db, actor, id, input) {
  const c = clean(input);
  return tx(db, () => {
    const before = getBusiness(db, id);
    db.prepare(`UPDATE businesses SET name = ?, category = ?, phone = ?, contact = ?, notes = ?, delivery_date = ?, archived = ?, updated_at = ?
      WHERE id = ?`).run(c.name, c.category, c.phone, c.contact, c.notes, c.delivery_date, input.archived ? 1 : 0, nowIso(), id);
    audit(db, actor, 'negocio.editar', { entityType: 'business', entityId: id, details: { before, after: c } });
    return getBusiness(db, id);
  });
}

function businessHistory(db, id) {
  return db.prepare(`SELECT h.*, a.username, u.display_number FROM unit_history h
    JOIN units u ON u.id = h.unit_id LEFT JOIN admins a ON a.id = h.admin_id
    WHERE u.business_id = ? OR (h.action IN ('asignada', 'desasignada') AND (h.new_value = (SELECT name FROM businesses WHERE id = ?) OR h.old_value = (SELECT name FROM businesses WHERE id = ?)))
    ORDER BY h.id DESC LIMIT 300`).all(id, id, id);
}

module.exports = { listBusinesses, getBusiness, createBusiness, updateBusiness, businessHistory };
