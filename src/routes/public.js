'use strict';
const express = require('express');
const { PUBLIC_ID_RE, escapeHtml } = require('../util');
const { recordScan } = require('../services/stats');

function page(title, body, status = 200) {
  return {
    status,
    html: `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/static/public.css"></head>
<body><main class="card">${body}</main></body></html>`,
  };
}

function send(res, p) {
  res.status(p.status).set('Cache-Control', 'no-store').type('html').send(p.html);
}

function publicRoutes(db) {
  const r = express.Router();
  const find = db.prepare('SELECT * FROM units WHERE public_id = ?');

  r.get('/q/:pid', (req, res) => {
    const { pid } = req.params;
    if (!PUBLIC_ID_RE.test(pid)) return send(res, page('Código no encontrado', '<h1>Código no encontrado</h1><p>Este código QR no existe.</p>', 404));
    const unit = find.get(pid);
    if (!unit) return send(res, page('Código no encontrado', '<h1>Código no encontrado</h1><p>Este código QR no existe.</p>', 404));
    recordScan(db, unit, 'escaneo');

    if (unit.status === 'baja') return send(res, page('Código dado de baja', '<h1>Este código ya no está en uso</h1>', 410));
    if (unit.status === 'pausado') return send(res, page('Temporalmente pausado', '<h1>Temporalmente no disponible</h1><p>Volvé a intentarlo más tarde.</p>'));
    if (unit.status === 'defectuoso') return send(res, page('No disponible', '<h1>Este código no está disponible</h1>'));
    if (unit.status !== 'activo' || !unit.destination_type) {
      return send(res, page('Código no activado', '<h1>Este código todavía no está activado</h1><p>Si sos el comercio, contactá a tu proveedor.</p>'));
    }
    if (unit.destination_type === 'pagina') {
      let cfg;
      try { cfg = JSON.parse(unit.destination_config); } catch { cfg = null; }
      if (!cfg) return send(res, page('No disponible', '<h1>Página no disponible</h1>'));
      const links = cfg.links.map((l, i) => `<a class="btn" href="/q/${pid}/ir/${i}" rel="noopener">${escapeHtml(l.text)}</a>`).join('');
      return send(res, page(cfg.title, `<h1>${escapeHtml(cfg.title)}</h1>${cfg.message ? `<p>${escapeHtml(cfg.message)}</p>` : ''}<nav>${links}</nav>`));
    }
    // 302 (no 301): el navegador no memoriza el destino, así se puede cambiar desde el panel.
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').redirect(302, unit.destination_url);
  });

  r.get('/q/:pid/ir/:n', (req, res) => {
    const { pid } = req.params;
    const n = Number(req.params.n);
    const unit = PUBLIC_ID_RE.test(pid) ? find.get(pid) : null;
    if (!unit || unit.status !== 'activo' || unit.destination_type !== 'pagina' || !Number.isInteger(n)) {
      return send(res, page('No disponible', '<h1>Enlace no disponible</h1>', 404));
    }
    let link;
    try { link = JSON.parse(unit.destination_config).links[n]; } catch { link = null; }
    if (!link) return send(res, page('No disponible', '<h1>Enlace no disponible</h1>', 404));
    recordScan(db, unit, 'clic', link.text);
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').redirect(302, link.url);
  });

  return r;
}

module.exports = { publicRoutes };
