/*
 * Código compartido entre el panel (Node) y el generador web (navegador).
 * Genera la página estática de cada QR y valida los links de destino.
 * Formato UMD: en Node se usa con require(); en el navegador queda en window.PaginaQR.
 * El panel copia este archivo a docs/generador/ al publicar: no editar la copia.
 *
 * Cada QR tiene dos archivos en docs/q/:
 *   <id>.html  → página que abre el QR. Si el QR está activo, redirige apenas empieza a
 *                cargar (script en el <head>, sin mostrar contenido intermedio).
 *   <id>.json  → estado y destino actuales; lo usa el generador para saber cuándo GitHub
 *                ya publicó un cambio.
 * GitHub Pages guarda las páginas en caché ~10 minutos: un cambio de link puede tardar
 * ese tiempo en llegar a todos los celulares.
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

  /** Estado público de un QR (lo que se guarda en docs/q/<id>.json). */
  function unitState(unit) {
    return {
      estado: unit.status || 'generado',
      destino_tipo: unit.destination_type || null,
      destino_url: unit.destination_url || null,
      destino_config: unit.destination_config || null,
    };
  }
  function stateJson(unit) { return JSON.stringify(unitState(unit), null, 1) + '\n'; }

  /** Qué mostrar para un estado: { redirect } o { title, body: [{tag, text, href}] } */
  function view(s) {
    if (s.estado === 'baja') return { title: 'Código dado de baja', h1: 'Este código ya no está en uso' };
    if (s.estado === 'pausado') return { title: 'Temporalmente pausado', h1: 'Temporalmente no disponible', p: 'Volvé a intentarlo más tarde.' };
    if (s.estado === 'defectuoso') return { title: 'No disponible', h1: 'Este código no está disponible' };
    if (s.estado !== 'activo' || !s.destino_tipo) return { title: 'Código no activado', h1: 'Este código todavía no está activado', p: 'Si sos el comercio, contactá a tu proveedor.' };
    if (s.destino_tipo === 'pagina') {
      var cfg = null;
      try { cfg = JSON.parse(s.destino_config); } catch (e) { cfg = null; }
      if (!cfg || !cfg.links) return { title: 'No disponible', h1: 'Página no disponible' };
      return { title: cfg.title, h1: cfg.title, p: cfg.message || '', links: cfg.links };
    }
    if (/^https:\/\//i.test(s.destino_url || '')) return { redirect: s.destino_url };
    return { title: 'No disponible', h1: 'Este código no está disponible' };
  }

  function bodyHtml(v) {
    if (v.redirect) return '<h1>Abriendo…</h1><p><a class="btn" href="' + escapeHtml(v.redirect) + '" rel="noopener noreferrer">Continuar</a></p>';
    return '<h1>' + escapeHtml(v.h1) + '</h1>' + (v.p ? '<p>' + escapeHtml(v.p) + '</p>' : '')
      + (v.links ? '<nav>' + v.links.map(function (l) {
        return '<a class="btn" href="' + escapeHtml(l.url) + '" rel="noopener noreferrer">' + escapeHtml(l.text) + '</a>';
      }).join('') + '</nav>' : '');
  }

  /**
   * HTML de la página de un QR. unit = { status, destination_type, destination_url, destination_config }
   * Activo con link: redirección inmediata desde el <head> (location.replace + meta refresh de respaldo),
   * con la página en blanco para que no se vea nada intermedio.
   */
  function unitPage(unit) {
    var s = unitState(unit); var v = view(s);
    var head = '<!doctype html>\n<html lang="es"><head><meta charset="utf-8">';
    if (v.redirect) {
      var js = JSON.stringify(v.redirect).replace(/</g, '\\u003c');
      return head + '<script>location.replace(' + js + ');</script>'
        + '<meta http-equiv="refresh" content="0;url=' + escapeHtml(v.redirect) + '">'
        + '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1"><title></title>'
        + '<style>html,body{background:#fff;margin:0}</style></head><body></body></html>\n';
    }
    return head + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
      + '<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">\n'
      + '<title>' + escapeHtml(v.title) + '</title><style>' + CSS + '</style></head>\n'
      + '<body><main class="card">' + bodyHtml(v) + '</main></body></html>\n';
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

  return { escapeHtml: escapeHtml, unitPage: unitPage, unitState: unitState, stateJson: stateJson, validarUrl: validarUrl };
}));
