/*
 * Código compartido entre el panel (Node) y el generador web (navegador).
 * Genera la página estática de cada QR y valida los links de destino.
 * Formato UMD: en Node se usa con require(); en el navegador queda en window.PaginaQR.
 * El panel copia este archivo a docs/generador/ al publicar: no editar la copia.
 *
 * Cada QR tiene dos archivos en docs/q/:
 *   <id>.json  → estado y destino actuales (lo único que cambia al editar un link)
 *   <id>.html  → página que abre el QR. Al abrirse pide <id>.json con un parámetro
 *                único (?t=...), así nunca usa una copia vieja guardada en caché por el
 *                navegador o por GitHub (que guarda las páginas ~10 minutos). Si no puede
 *                leerlo, usa el estado incluido en la propia página.
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

  // Script que corre al abrir el QR: lee el estado actual y redirige o muestra el mensaje.
  // Se escribe como texto (no como función) para que sea idéntico en Node y en el navegador.
  var LOADER = [
    '(function(){',
    'var fb=JSON.parse(document.getElementById("estado").textContent);',
    'var id=location.pathname.split("/").pop().replace(/\\.html$/,"");',
    'function vista(s){',
    ' if(s.estado==="baja")return{t:"Código dado de baja",h:"Este código ya no está en uso"};',
    ' if(s.estado==="pausado")return{t:"Temporalmente pausado",h:"Temporalmente no disponible",p:"Volvé a intentarlo más tarde."};',
    ' if(s.estado==="defectuoso")return{t:"No disponible",h:"Este código no está disponible"};',
    ' if(s.estado!=="activo"||!s.destino_tipo)return{t:"Código no activado",h:"Este código todavía no está activado",p:"Si sos el comercio, contactá a tu proveedor."};',
    ' if(s.destino_tipo==="pagina"){var c=null;try{c=JSON.parse(s.destino_config)}catch(e){}',
    '  if(!c||!c.links)return{t:"No disponible",h:"Página no disponible"};return{t:c.title,h:c.title,p:c.message||"",l:c.links};}',
    ' if(/^https:\\/\\//i.test(s.destino_url||""))return{r:s.destino_url};',
    ' return{t:"No disponible",h:"Este código no está disponible"};}',
    'function mostrar(s){var v=vista(s);if(v.r){location.replace(v.r);return;}',
    ' document.title=v.t;var m=document.getElementById("c");m.textContent="";',
    ' var h=document.createElement("h1");h.textContent=v.h;m.appendChild(h);',
    ' if(v.p){var p=document.createElement("p");p.textContent=v.p;m.appendChild(p);}',
    ' if(v.l){var n=document.createElement("nav");v.l.forEach(function(x){if(!/^https:\\/\\//i.test(x.url))return;',
    '  var a=document.createElement("a");a.className="btn";a.href=x.url;a.rel="noopener noreferrer";a.textContent=x.text;n.appendChild(a);});m.appendChild(n);}}',
    'var listo=false;function fin(s){if(listo)return;listo=true;mostrar(s);}',
    'setTimeout(function(){fin(fb);},4000);',
    'fetch(id+".json?t="+Date.now(),{cache:"no-store"}).then(function(r){if(!r.ok)throw 0;return r.json();})',
    ' .then(function(s){fin(s);},function(){fin(fb);});',
    '})();',
  ].join('\n');

  /**
   * HTML de la página de un QR. unit = { public_id, status, destination_type, destination_url, destination_config }
   * Incluye el estado actual como respaldo; al abrirse consulta <id>.json para usar siempre el último.
   */
  function unitPage(unit) {
    var s = unitState(unit); var v = view(s);
    var noscript = v.redirect ? '<noscript><meta http-equiv="refresh" content="0;url=' + escapeHtml(v.redirect) + '"></noscript>' : '';
    var embedded = JSON.stringify(s).replace(/</g, '\\u003c');
    return '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
      + '<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">' + noscript + '\n'
      + '<title>' + escapeHtml(v.redirect ? 'Abriendo…' : v.title) + '</title><style>' + CSS + '</style></head>\n'
      + '<body><main class="card" id="c">' + (v.redirect ? '<h1>Abriendo…</h1>' : bodyHtml(v)) + '</main>\n'
      + '<script type="application/json" id="estado">' + embedded + '</script>\n'
      + '<script>\n' + LOADER + '\n</script>\n'
      + '</body></html>\n';
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
