/*
 * Código compartido entre el panel (Node) y el generador web (navegador).
 * Genera la página estática de cada QR y valida los links de destino.
 * Formato UMD: en Node se usa con require(); en el navegador queda en window.PaginaQR.
 * El panel copia este archivo a docs/generador/ al publicar: no editar la copia.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaginaQR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var CSS = 'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f5f7;color:#1d2330}'
    + '.card{max-width:440px;margin:12vh auto;background:#fff;border-radius:12px;padding:28px 24px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.08)}'
    + 'h1{font-size:21px;margin:0 0 10px}p{color:#5d6676}nav{display:flex;flex-direction:column;gap:10px;margin-top:18px}'
    + '.btn{display:block;padding:13px;border-radius:8px;background:#1a5fd0;color:#fff;text-decoration:none;font-weight:600}';

  function shell(title, body, head) {
    return '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
      + '<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">' + (head || '') + '\n'
      + '<title>' + escapeHtml(title) + '</title><style>' + CSS + '</style></head>\n'
      + '<body><main class="card">' + body + '</main></body></html>\n';
  }

  /**
   * HTML de la página de un QR según su estado y destino.
   * unit = { status, destination_type, destination_url, destination_config }
   */
  function unitPage(unit) {
    if (unit.status === 'baja') return shell('Código dado de baja', '<h1>Este código ya no está en uso</h1>');
    if (unit.status === 'pausado') return shell('Temporalmente pausado', '<h1>Temporalmente no disponible</h1><p>Volvé a intentarlo más tarde.</p>');
    if (unit.status === 'defectuoso') return shell('No disponible', '<h1>Este código no está disponible</h1>');
    if (unit.status !== 'activo' || !unit.destination_type) {
      return shell('Código no activado', '<h1>Este código todavía no está activado</h1><p>Si sos el comercio, contactá a tu proveedor.</p>');
    }
    if (unit.destination_type === 'pagina') {
      var cfg = null;
      try { cfg = JSON.parse(unit.destination_config); } catch (e) { cfg = null; }
      if (!cfg) return shell('No disponible', '<h1>Página no disponible</h1>');
      var links = cfg.links.map(function (l) {
        return '<a class="btn" href="' + escapeHtml(l.url) + '" rel="noopener noreferrer">' + escapeHtml(l.text) + '</a>';
      }).join('');
      return shell(cfg.title, '<h1>' + escapeHtml(cfg.title) + '</h1>' + (cfg.message ? '<p>' + escapeHtml(cfg.message) + '</p>' : '') + '<nav>' + links + '</nav>');
    }
    // El destino se valida al guardarlo (https público). Se escapa igual por seguridad.
    var url = escapeHtml(unit.destination_url);
    return shell('Redirigiendo…',
      '<h1>Abriendo…</h1><p><a class="btn" href="' + url + '" rel="noopener noreferrer">Continuar</a></p>',
      '<meta http-equiv="refresh" content="0;url=' + url + '"><link rel="canonical" href="' + url + '">'
        + '<script>location.replace(' + JSON.stringify(unit.destination_url).replace(/</g, '\\u003c') + ');</script>');
  }

  function isPrivateIpv4(h) {
    var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
    if (!m) return false;
    var a = +m[1]; var b = +m[2];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }

  /** Valida un link de destino. Devuelve { ok, url } o { ok:false, error }. */
  function validarUrl(raw, baseUrl) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, error: 'Pegá un link.' };
    if (s.length > 2000) return { ok: false, error: 'El link es demasiado largo.' };
    if (!/^https:\/\//i.test(s) && /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) s = 'https://' + s;
    var u;
    try { u = new URL(s); } catch (e) { return { ok: false, error: 'No es un link válido. Debe empezar con https://' }; }
    if (u.protocol !== 'https:') return { ok: false, error: 'Solo se aceptan links que empiecen con https://' };
    if (u.username || u.password) return { ok: false, error: 'El link no puede llevar usuario ni contraseña.' };
    var host = u.hostname.toLowerCase();
    if (host.indexOf('.') < 0 || host === 'localhost' || /\.(localhost|local|internal)$/.test(host) || isPrivateIpv4(host) || host.indexOf(':') >= 0 || host.charAt(0) === '[') {
      return { ok: false, error: 'El link no es de una página pública.' };
    }
    if (baseUrl) {
      var own = new URL(baseUrl);
      if (host === own.hostname.toLowerCase() && u.pathname.indexOf(own.pathname.replace(/\/$/, '') + '/q/') === 0) {
        return { ok: false, error: 'El link no puede ser otro QR de este sistema.' };
      }
    }
    return { ok: true, url: u.toString() };
  }

  return { escapeHtml: escapeHtml, unitPage: unitPage, validarUrl: validarUrl };
}));
