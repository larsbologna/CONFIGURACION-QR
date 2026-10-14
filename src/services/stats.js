'use strict';
const { nowIso } = require('../db');
const { bad, isoDate } = require('../util');

/** Registra un escaneo o clic. Sin IP ni datos del dispositivo. */
function recordScan(db, unit, kind, target = null) {
  const ts = nowIso();
  db.prepare('INSERT INTO scans(unit_id, business_id, kind, target, unit_status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(unit.id, unit.business_id ?? null, kind, target, unit.status, ts);
  if (kind === 'escaneo') db.prepare('UPDATE units SET scan_count = scan_count + 1, last_scan_at = ? WHERE id = ?').run(ts, unit.id);
}

function stats(db, { from, to, group = 'dia' } = {}) {
  const f = isoDate(from, { field: 'desde' }) || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const t = isoDate(to, { field: 'hasta' }) || new Date().toISOString().slice(0, 10);
  if (f > t) throw bad('El período es inválido');
  const fmt = { dia: '%Y-%m-%d', semana: '%Y-W%W', mes: '%Y-%m' }[group];
  if (!fmt) throw bad('Agrupación inválida');
  const range = [`${f}T00:00:00.000Z`, `${t}T23:59:59.999Z`];
  const totals = { escaneo: 0, clic: 0 };
  for (const r of db.prepare('SELECT kind, COUNT(*) AS n FROM scans WHERE created_at BETWEEN ? AND ? GROUP BY kind').all(...range)) totals[r.kind] = r.n;
  const allTime = db.prepare("SELECT COUNT(*) AS n FROM scans WHERE kind = 'escaneo'").get().n;
  const series = db.prepare(`SELECT strftime('${fmt}', created_at) AS period,
      SUM(kind = 'escaneo') AS escaneos, SUM(kind = 'clic') AS clics
    FROM scans WHERE created_at BETWEEN ? AND ? GROUP BY period ORDER BY period`).all(...range);
  const byUnit = db.prepare(`SELECT u.id, u.display_number, bz.name AS business_name,
      SUM(s.kind = 'escaneo') AS escaneos, SUM(s.kind = 'clic') AS clics
    FROM scans s JOIN units u ON u.id = s.unit_id LEFT JOIN businesses bz ON bz.id = u.business_id
    WHERE s.created_at BETWEEN ? AND ? GROUP BY u.id ORDER BY escaneos DESC LIMIT 50`).all(...range);
  const byBusiness = db.prepare(`SELECT bz.id, IFNULL(bz.name, '(sin negocio)') AS business_name,
      SUM(s.kind = 'escaneo') AS escaneos, SUM(s.kind = 'clic') AS clics
    FROM scans s LEFT JOIN businesses bz ON bz.id = s.business_id
    WHERE s.created_at BETWEEN ? AND ? GROUP BY s.business_id ORDER BY escaneos DESC LIMIT 50`).all(...range);
  return {
    from: f, to: t, group, totals, all_time_scans: allTime, series, byUnit, byBusiness,
    reviews_note: 'Las reseñas publicadas no se pueden medir desde el QR: Google no informa qué escaneo terminó en una reseña. Para verificarlas, consultá el perfil de Google Business del negocio.',
  };
}

module.exports = { recordScan, stats };
