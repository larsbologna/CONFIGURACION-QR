'use strict';
const { nowIso } = require('../db');

function audit(db, actor, action, { entityType = null, entityId = null, details = null } = {}) {
  db.prepare(`INSERT INTO audit_log(admin_id, username, action, entity_type, entity_id, details, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    actor?.id ?? null, actor?.username ?? null, action, entityType, entityId,
    details == null ? null : JSON.stringify(details), actor?.ip ?? null, nowIso());
}

function unitHistory(db, actor, unitId, action, oldValue, newValue, note = null) {
  const s = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
  db.prepare(`INSERT INTO unit_history(unit_id, admin_id, action, old_value, new_value, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(unitId, actor?.id ?? null, action, s(oldValue), s(newValue), note, nowIso());
}

module.exports = { audit, unitHistory };
