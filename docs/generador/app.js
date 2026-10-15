/*
 * Generador de QR con el diseño del plástico (corre en GitHub Pages, sin servidor).
 *  - Lee docs/registro.json (lista de QR, diseños y lotes).
 *  - "Nuevo QR": toma el próximo QR libre (o crea uno nuevo con el número siguiente),
 *    le pone el link y guarda en GitHub: registro + docs/q/<código>.html y .json.
 *  - "Cambiar link" / "Pausar": cambia a dónde lleva el MISMO QR (el plástico no cambia).
 *  - Dibuja el diseño con el QR y el número, y lo descarga en PDF (10 × 15 cm) o PNG.
 * Guardar en GitHub usa una llave (token) que queda solo en el navegador de esta compu.
 * Cada guardado es un commit que solo avanza si nadie más cambió el registro: si dos
 * personas generan a la vez, uno reintenta con los datos nuevos y no se repiten números.
 */
(function () {
  'use strict';

  var API = 'https://api.github.com';
  var BRANCH = 'main';
  var REG_PATH = 'docs/registro.json';
  var ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; // igual que el panel (sin 0/O/1/l/I)
  var TOKEN_KEY = 'generador_qr_token';
  var state = { reg: null, repo: null, token: null, current: null };
  var $ = function (id) { return document.getElementById(id); };

  function storage(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }

  // ---------- Utilidades ----------
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function msg(id, text, kind) {
    var el = $(id);
    el.textContent = text || '';
    el.className = 'msg ' + (kind || 'ok') + (text ? '' : ' hidden');
  }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function randomId() {
    var out = ''; var buf = new Uint8Array(32);
    while (out.length < 12) {
      crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length && out.length < 12; i++) if (buf[i] < 256 - (256 % ALPHABET.length)) out += ALPHABET[buf[i] % ALPHABET.length];
    }
    return out;
  }
  function pad(n, d) { var s = String(n); while (s.length < d) s = '0' + s; return s; }
  function b64(str) {
    var bytes = new TextEncoder().encode(str); var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function repoFromDomain(dominio) {
    var u = new URL(dominio);
    var m = /^([a-z0-9-]+)\.github\.io$/i.exec(u.hostname);
    var name = u.pathname.split('/').filter(Boolean)[0];
    if (!m || !name) throw new Error('El dominio de los QR no es de GitHub Pages: ' + dominio);
    return { owner: m[1], name: name };
  }
  function unitFor(u) { return { status: u.estado, destination_type: u.destino_tipo, destination_url: u.destino_url, destination_config: u.destino_config }; }

  // ---------- GitHub API ----------
  function gh(method, path, body, accept) {
    return fetch(API + path, {
      method: method,
      headers: {
        Authorization: 'Bearer ' + state.token,
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    }).then(function (r) {
      if (r.status === 401) throw new Error('La llave de GitHub no es válida o venció. Tocá "Desconectar esta compu" y conectá una nueva.');
      if (r.status === 403 || r.status === 404) {
        return r.text().then(function (t) {
          var e = new Error('GitHub rechazó la operación. Revisá que la llave tenga acceso al repositorio ' + state.repo.name + ' con permiso "Contents: Read and write". (' + r.status + ')');
          e.status = r.status; e.detail = t; throw e;
        });
      }
      if (!r.ok) {
        return r.text().then(function (t) { var e = new Error('Error de GitHub ' + r.status); e.status = r.status; e.detail = t; throw e; });
      }
      return accept && accept.indexOf('raw') >= 0 ? r.text() : r.json();
    });
  }
  var R = function (p) { return '/repos/' + state.repo.owner + '/' + state.repo.name + p; };

  function readHead() {
    return gh('GET', R('/git/ref/heads/' + BRANCH)).then(function (ref) {
      var sha = ref.object.sha;
      return gh('GET', R('/contents/' + REG_PATH + '?ref=' + sha), null, 'application/vnd.github.raw+json')
        .then(function (text) { return { sha: sha, reg: JSON.parse(text) }; });
    });
  }

  /** Commit atómico de varios archivos. Falla (409/422) si main avanzó mientras tanto. */
  function commitFiles(parentSha, files, message) {
    return gh('GET', R('/git/commits/' + parentSha)).then(function (c) {
      return gh('POST', R('/git/trees'), {
        base_tree: c.tree.sha,
        tree: files.map(function (f) { return { path: f.path, mode: '100644', type: 'blob', content: f.content }; }),
      });
    }).then(function (tree) {
      return gh('POST', R('/git/commits'), { message: message, tree: tree.sha, parents: [parentSha] });
    }).then(function (commit) {
      return gh('PATCH', R('/git/refs/heads/' + BRANCH), { sha: commit.sha, force: false }).then(function () { return commit.sha; });
    });
  }

  /** Lee lo último, aplica el cambio y guarda; si otro guardó antes, reintenta con datos frescos. */
  function transaction(mutate, attempt) {
    attempt = attempt || 1;
    return readHead().then(function (h) {
      var change = mutate(h.reg); // devuelve { unit, message }
      h.reg.revision = (h.reg.revision || 0) + 1;
      h.reg.actualizado = new Date().toISOString();
      var files = [
        { path: REG_PATH, content: JSON.stringify(h.reg, null, 1) + '\n' },
        { path: 'docs/q/' + change.unit.id_publico + '.html', content: PaginaQR.unitPage(unitFor(change.unit)) },
        { path: 'docs/q/' + change.unit.id_publico + '.json', content: PaginaQR.stateJson(unitFor(change.unit)) },
      ];
      return commitFiles(h.sha, files, change.message).then(function () {
        state.reg = h.reg;
        return change.unit;
      });
    }).catch(function (e) {
      if ((e.status === 409 || e.status === 422) && attempt < 4) return transaction(mutate, attempt + 1);
      throw e;
    });
  }

  // ---------- Reglas del registro ----------
  function latestDesign(reg) {
    return reg.disenos.reduce(function (a, d) { return !a || d.id > a.id ? d : a; }, null);
  }
  function nextBatchCode(reg, year) {
    var n = 0;
    reg.lotes.forEach(function (l) { var m = /^LOTE-(\d{4})-(\d+)$/.exec(l.codigo); if (m && +m[1] === year) n = Math.max(n, +m[2]); });
    return 'LOTE-' + year + '-' + pad(n + 1, 3);
  }
  function freeUnit(reg) {
    return reg.unidades.filter(function (u) { return u.estado === 'generado' && !u.destino_url && !u.destino_tipo && !u.etiqueta; })
      .sort(function (a, b) { return a.serial - b.serial; })[0] || null;
  }
  /** Asigna el próximo QR libre o crea uno nuevo (número siguiente, nunca repetido). */
  function assign(reg, url, etiqueta) {
    var u = freeUnit(reg);
    var now = new Date().toISOString();
    if (!u) {
      var d = latestDesign(reg);
      if (!d) throw new Error('No hay ningún diseño cargado en el registro.');
      var serial = reg.unidades.reduce(function (m, x) { return Math.max(m, x.serial); }, 0) + 1;
      var lastLote = reg.lotes.reduce(function (a, l) { return !a || l.id > a.id ? l : a; }, null);
      var digits = lastLote ? lastLote.digitos : 3; var prefix = lastLote ? lastLote.prefijo : '';
      var used = {}; reg.unidades.forEach(function (x) { used[x.id_publico] = true; });
      var pid; do { pid = randomId(); } while (used[pid]);
      var loteId = reg.lotes.reduce(function (m, l) { return Math.max(m, l.id); }, 0) + 1;
      var dominio = reg.dominio || (lastLote && lastLote.dominio);
      reg.lotes.push({
        id: loteId, codigo: nextBatchCode(reg, new Date().getFullYear()), diseno_id: d.id, cantidad: 1, primer_serial: serial,
        ultimo_serial: serial, prefijo: prefix, digitos: digits, ubicacion: 'plastico', numero_en_plancha: 0, numero_en_plastico: 1,
        dominio: dominio, creado: now,
      });
      u = { serial: serial, numero: prefix + pad(serial, digits), id_publico: pid, url: dominio + '/q/' + pid, lote_id: loteId,
        diseno_id: d.id, creado: now, reemplaza_serial: null, estado: 'generado', destino_tipo: null, destino_url: null, destino_config: null, etiqueta: null };
      reg.unidades.push(u);
    }
    u.estado = 'activo'; u.destino_tipo = 'url'; u.destino_url = url; u.destino_config = null; u.etiqueta = etiqueta || null;
    return u;
  }

  // ---------- Dibujo del diseño ----------
  var imgCache = {};
  function loadImage(d) {
    var src = 'disenos/' + d.imagen_sha256 + (d.formato === 'jpeg' ? '.jpg' : '.png');
    if (!imgCache[src]) {
      imgCache[src] = new Promise(function (resolve, reject) {
        var i = new Image(); i.onload = function () { resolve(i); }; i.onerror = function () { reject(new Error('No se pudo cargar la imagen del diseño')); }; i.src = src;
      });
    }
    return imgCache[src];
  }
  var fontReady = null;
  function loadFont() {
    if (!fontReady) {
      var f = new FontFace('NumerosQR', 'url(fuente-numeros.ttf)');
      fontReady = f.load().then(function (ff) { document.fonts.add(ff); return true; });
    }
    return fontReady;
  }
  function qrModules(text, ecc) {
    var q = qrcode(0, ecc || 'M'); q.addData(text); q.make();
    var n = q.getModuleCount();
    return { n: n, dark: function (r, c) { return q.isDark(r, c); } };
  }
  function cfgOf(d) {
    var c = d.config;
    return { qr: c.qr, cover: c.cover || { enabled: false }, number: c.number || { enabled: false } };
  }
  /** Recorre el QR en tramos horizontales oscuros: cb(x, y, w, h) en mm. */
  function qrRuns(m, c, cb) {
    var total = m.n + 2 * (c.margin_modules == null ? 2 : c.margin_modules);
    var mod = c.size_mm / total; var off = (c.margin_modules == null ? 2 : c.margin_modules);
    for (var r = 0; r < m.n; r++) {
      var col = 0;
      while (col < m.n) {
        if (!m.dark(r, col)) { col++; continue; }
        var s = col; while (col < m.n && m.dark(r, col)) col++;
        cb(c.x_mm + (s + off) * mod, c.y_mm + (r + off) * mod, (col - s) * mod, mod);
      }
    }
  }
  var CAP = 0.729; // altura de mayúsculas/dígitos de DejaVu Sans Bold (1493/2048)
  function fitPt(ctx, text, pt, box, pxmm) {
    var maxByH = (box.h_mm * 0.8) / (25.4 / 72 * CAP); pt = Math.min(pt, maxByH);
    ctx.font = 'bold ' + (pt * 25.4 / 72 * pxmm) + 'px NumerosQR';
    var w = ctx.measureText(text).width / pxmm;
    if (w > box.w_mm * 0.95) pt = pt * box.w_mm * 0.95 / w;
    return Math.floor(pt * 10) / 10;
  }
  function draw(u) {
    var d = state.reg.disenos.filter(function (x) { return x.id === u.diseno_id; })[0];
    if (!d) return Promise.reject(new Error('No se encuentra el diseño de este QR.'));
    return Promise.all([loadImage(d), loadFont()]).then(function (res) {
      var img = res[0]; var c = cfgOf(d);
      var cv = $('lienzo'); cv.width = d.ancho_px; cv.height = d.alto_px;
      var ctx = cv.getContext('2d'); var k = d.ancho_px / d.ancho_mm;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      if (c.cover.enabled) { ctx.fillStyle = c.cover.color; ctx.fillRect(c.cover.x_mm * k, c.cover.y_mm * k, c.cover.w_mm * k, c.cover.h_mm * k); }
      ctx.fillStyle = c.qr.light; ctx.fillRect(c.qr.x_mm * k, c.qr.y_mm * k, c.qr.size_mm * k, c.qr.size_mm * k);
      ctx.fillStyle = c.qr.dark;
      qrRuns(qrModules(u.url, c.qr.ecc), c.qr, function (x, y, w, h) {
        // Bordes redondeados a píxel: sin líneas finas entre módulos.
        var x0 = Math.round(x * k); var y0 = Math.round(y * k);
        ctx.fillRect(x0, y0, Math.round((x + w) * k) - x0, Math.round((y + h) * k) - y0);
      });
      var lote = state.reg.lotes.filter(function (l) { return l.id === u.lote_id; })[0];
      if (c.number.enabled && (!lote || lote.numero_en_plastico)) {
        var n = c.number; var text = (n.label || '') + u.numero;
        var pt = fitPt(ctx, text, n.font_pt, n, k);
        var px = pt * 25.4 / 72 * k;
        if (n.background) { ctx.fillStyle = n.background; ctx.fillRect(n.x_mm * k, n.y_mm * k, n.w_mm * k, n.h_mm * k); }
        ctx.font = 'bold ' + px + 'px NumerosQR'; ctx.fillStyle = n.color; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, (n.x_mm + n.w_mm / 2) * k, (n.y_mm + n.h_mm / 2) * k + CAP * px / 2);
      }
      return { d: d, c: c, lote: lote };
    });
  }

  // ---------- Descargas ----------
  function fileBase(u) { return u.numero + '_QR'; }
  function downloadBlob(blob, name) {
    var a = el('a', { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function bajarPng() {
    var u = state.current; $('lienzo').toBlob(function (b) { downloadBlob(b, fileBase(u) + '.png'); }, 'image/png');
  }
  function fetchBase64(url) {
    return fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      var bytes = new Uint8Array(buf); var bin = ''; var CH = 0x8000;
      for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return btoa(bin);
    });
  }
  /** PDF de 100 × 150 mm: imagen original + parche + QR y número vectoriales. */
  function bajarPdf() {
    var u = state.current;
    return draw(u).then(function (info) {
      var d = info.d; var c = info.c;
      var imgUrl = 'disenos/' + d.imagen_sha256 + (d.formato === 'jpeg' ? '.jpg' : '.png');
      return Promise.all([fetchBase64(imgUrl), fetchBase64('fuente-numeros.ttf')]).then(function (r) {
        var doc = new window.jspdf.jsPDF({ unit: 'mm', format: [d.ancho_mm, d.alto_mm], orientation: 'portrait', compress: true });
        doc.setProperties({ title: 'Plástico ' + u.numero, creator: 'Generador de QR' });
        doc.addImage('data:image/' + (d.formato === 'jpeg' ? 'jpeg' : 'png') + ';base64,' + r[0], d.formato === 'jpeg' ? 'JPEG' : 'PNG', 0, 0, d.ancho_mm, d.alto_mm);
        if (c.cover.enabled) { doc.setFillColor(c.cover.color); doc.rect(c.cover.x_mm, c.cover.y_mm, c.cover.w_mm, c.cover.h_mm, 'F'); }
        doc.setFillColor(c.qr.light); doc.rect(c.qr.x_mm, c.qr.y_mm, c.qr.size_mm, c.qr.size_mm, 'F');
        doc.setFillColor(c.qr.dark);
        // Leve solapamiento (0,02 mm) para que no queden rayitas blancas entre módulos al imprimir.
        qrRuns(qrModules(u.url, c.qr.ecc), c.qr, function (x, y, w, h) { doc.rect(x, y, w + 0.02, h + 0.02, 'F'); });
        if (c.number.enabled && (!info.lote || info.lote.numero_en_plastico)) {
          var n = c.number; var text = (n.label || '') + u.numero;
          doc.addFileToVFS('NumerosQR.ttf', r[1]); doc.addFont('NumerosQR.ttf', 'NumerosQR', 'bold'); doc.setFont('NumerosQR', 'bold');
          var ctx = $('lienzo').getContext('2d'); var pt = fitPt(ctx, text, n.font_pt, n, d.ancho_px / d.ancho_mm);
          if (n.background) { doc.setFillColor(n.background); doc.rect(n.x_mm, n.y_mm, n.w_mm, n.h_mm, 'F'); }
          doc.setFontSize(pt); doc.setTextColor(n.color);
          doc.text(text, n.x_mm + n.w_mm / 2, n.y_mm + n.h_mm / 2 + CAP * pt * 25.4 / 72 / 2, { align: 'center', baseline: 'alphabetic' });
        }
        downloadBlob(doc.output('blob'), fileBase(u) + '.pdf');
      });
    });
  }

  // ---------- Pantalla ----------
  function estadoTexto(u) {
    if (u.estado === 'activo' && u.destino_url) return ['Activo', 'activo'];
    if (u.estado === 'pausado') return ['Pausado', 'pausado'];
    if (u.estado === 'baja') return ['Dado de baja', ''];
    return ['Libre (sin link)', ''];
  }
  function renderLista() {
    var rows = state.reg.unidades.slice().sort(function (a, b) { return b.serial - a.serial; });
    $('msg-lista').textContent = rows.length ? rows.length + ' QR en total. Los "Libre" se usan primero al generar.' : 'Todavía no hay QR.';
    var tbody = $('filas'); tbody.textContent = '';
    rows.forEach(function (u) {
      var st = estadoTexto(u); var conectado = Boolean(state.token);
      tbody.appendChild(el('tr', {}, [
        el('td', { class: 'numero', text: u.numero }),
        el('td', { text: u.etiqueta || '—' }),
        el('td', { class: 'link' }, [u.destino_url ? el('a', { href: u.destino_url, target: '_blank', rel: 'noopener noreferrer', text: u.destino_url }) : '—']),
        el('td', {}, [el('span', { class: 'estado ' + st[1], text: st[0] })]),
        el('td', { class: 'acciones' }, [
          el('button', { class: 'chico', text: 'Ver diseño', onclick: function () { verResultado(u, false); } }),
          conectado && u.estado !== 'baja' ? el('button', { class: 'chico', text: 'Cambiar link', onclick: function () { cambiarLink(u); } }) : null,
          conectado && u.estado === 'activo' ? el('button', { class: 'chico', text: 'Pausar', onclick: function (e) { cambiarEstado(u, 'pausado', e.target); } }) : null,
          conectado && u.estado === 'pausado' ? el('button', { class: 'chico', text: 'Reactivar', onclick: function (e) { cambiarEstado(u, 'activo', e.target); } }) : null,
          el('a', { class: 'boton chico', href: u.url, target: '_blank', rel: 'noopener', text: 'Probar' }),
        ]),
      ]));
    });
  }

  function verResultado(u, recienGuardado) {
    state.current = u; show('resultado', true);
    $('res-titulo').textContent = 'QR N° ' + u.numero + (u.etiqueta ? ' — ' + u.etiqueta : '');
    $('res-detalle').textContent = !u.destino_url ? 'Este QR todavía no tiene link.'
      : u.estado === 'pausado' ? 'PAUSADO: al escanearlo muestra "temporalmente no disponible". Link guardado: ' + u.destino_url
        : 'Lleva a: ' + u.destino_url;
    $('probar-qr').href = u.url;
    $('res-publicacion').textContent = '';
    draw(u).then(function () { $('resultado').scrollIntoView({ behavior: 'smooth' }); }).catch(function (e) { $('res-detalle').textContent = e.message; });
    if (recienGuardado) esperarPublicacion(u);
  }

  /** GitHub Pages tarda 1-2 minutos: se consulta la página del QR hasta ver el cambio. */
  function esperarPublicacion(u) {
    var target = $('res-publicacion'); var esperado = PaginaQR.stateJson(unitFor(u)); var t0 = Date.now();
    target.className = 'publicacion msg aviso';
    target.textContent = 'Guardado. GitHub está publicando el cambio (tarda 1 o 2 minutos)…';
    (function poll() {
      if (state.current !== u) return;
      fetch('../q/' + u.id_publico + '.json?v=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; })
        .then(function (html) {
          if (html === esperado) { target.className = 'publicacion msg ok'; target.textContent = '✓ Publicado: el QR lleva a ' + (u.destino_url || 'la página de estado') + '. En celulares que ya lo habían abierto puede tardar hasta 10 minutos en actualizarse.'; return; }
          if (Date.now() - t0 > 6 * 60e3) { target.textContent = 'Guardado en GitHub. La publicación está tardando más de lo normal; probá el QR en unos minutos.'; return; }
          setTimeout(poll, 10000);
        });
    }());
  }

  function cargar() {
    var p = state.token ? readHead().then(function (h) { return h.reg; })
      : fetch('../registro.json?v=' + Date.now(), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('No se pudo leer el registro'); return r.json(); });
    return p.then(function (reg) { state.reg = reg; renderLista(); });
  }

  function generar() {
    var v = PaginaQR.validarUrl($('link').value, state.reg && state.reg.dominio);
    if (!v.ok) { msg('msg-nuevo', v.error, 'error'); return; }
    var etiqueta = $('etiqueta').value.trim().slice(0, 80);
    var btn = $('generar'); btn.disabled = true; msg('msg-nuevo', 'Guardando en GitHub…', 'aviso');
    transaction(function (reg) {
      var u = assign(reg, v.url, etiqueta);
      return { unit: u, message: 'QR ' + u.numero + ' → ' + v.url + (etiqueta ? ' (' + etiqueta + ')' : '') };
    }).then(function (u) {
      msg('msg-nuevo', 'Listo: se asignó el QR N° ' + u.numero + '.', 'ok');
      $('link').value = ''; $('etiqueta').value = '';
      renderLista(); verResultado(u, true);
    }).catch(function (e) { msg('msg-nuevo', e.message, 'error'); })
      .then(function () { btn.disabled = false; });
  }

  function cambiarLink(u) {
    var nuevo = window.prompt('Nuevo link para el QR N° ' + u.numero + ' (el plástico no cambia):', u.destino_url || 'https://');
    if (nuevo == null) return;
    var v = PaginaQR.validarUrl(nuevo, state.reg.dominio);
    if (!v.ok) { window.alert(v.error); return; }
    var etiqueta = window.prompt('Nombre del negocio (opcional):', u.etiqueta || '');
    if (etiqueta == null) return;
    guardarCambio(u.serial, function (x) {
      x.destino_tipo = 'url'; x.destino_url = v.url; x.destino_config = null; x.estado = 'activo'; x.etiqueta = etiqueta.trim().slice(0, 80) || null;
      return 'QR ' + x.numero + ' ahora lleva a ' + v.url;
    });
  }
  function cambiarEstado(u, estado, btn) {
    if (btn) btn.disabled = true;
    guardarCambio(u.serial, function (x) { x.estado = estado; return 'QR ' + x.numero + ': ' + (estado === 'pausado' ? 'pausado' : 'reactivado'); });
  }
  function guardarCambio(serial, fn) {
    msg('msg-nuevo', 'Guardando en GitHub…', 'aviso');
    transaction(function (reg) {
      var x = reg.unidades.filter(function (y) { return y.serial === serial; })[0];
      if (!x) throw new Error('No se encontró el QR.');
      if (x.estado === 'baja') throw new Error('Ese QR está dado de baja.');
      return { unit: x, message: fn(x) };
    }).then(function (u) {
      msg('msg-nuevo', 'Guardado: QR N° ' + u.numero + '.', 'ok');
      renderLista(); verResultado(u, true);
    }).catch(function (e) { msg('msg-nuevo', e.message, 'error'); });
  }

  function conectar() {
    var t = $('token').value.trim();
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(t)) { msg('msg-conectar', 'Eso no parece una llave de GitHub (empieza con github_pat_).', 'error'); return; }
    state.token = t; $('guardar-token').disabled = true; msg('msg-conectar', 'Probando la llave…', 'aviso');
    readHead().then(function (h) {
      storage(function (s) { s.setItem(TOKEN_KEY, t); });
      state.reg = h.reg; $('token').value = '';
      iniciarConectado();
    }).catch(function (e) {
      state.token = null; msg('msg-conectar', e.message, 'error');
    }).then(function () { $('guardar-token').disabled = false; });
  }

  function iniciarConectado() {
    show('conectar', false); show('nuevo', true); show('desconectar', true);
    $('estado-conexion').textContent = 'Conectado a GitHub (' + state.repo.owner + '/' + state.repo.name + ')';
    return cargar();
  }

  function init() {
    $('generar').addEventListener('click', generar);
    $('guardar-token').addEventListener('click', conectar);
    $('bajar-png').addEventListener('click', bajarPng);
    $('bajar-pdf').addEventListener('click', function (e) {
      e.target.disabled = true;
      bajarPdf().catch(function (err) { window.alert(err.message); }).then(function () { e.target.disabled = false; });
    });
    $('desconectar').addEventListener('click', function () {
      storage(function (s) { s.removeItem(TOKEN_KEY); }); location.reload();
    });
    $('link').addEventListener('input', function () {
      var v = PaginaQR.validarUrl($('link').value, null); var a = $('probar-link');
      if (v.ok) a.href = v.url; else a.removeAttribute('href');
    });
    // Primero el registro público (sin llave) para saber el repositorio.
    fetch('../registro.json?v=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (reg) {
      state.reg = reg;
      state.repo = repoFromDomain(reg.dominio || reg.lotes[0].dominio);
      $('nombre-repo').textContent = state.repo.name;
      renderLista();
      state.token = storage(function (s) { return s.getItem(TOKEN_KEY); });
      if (state.token) return iniciarConectado().catch(function (e) { show('conectar', true); msg('msg-conectar', e.message, 'error'); });
      show('conectar', true);
      $('estado-conexion').textContent = 'Sin conectar (solo lectura)';
      return null;
    }).catch(function (e) { $('msg-lista').textContent = 'Error: ' + e.message; });
  }

  // Exportado para pruebas automáticas.
  window.GeneradorQR = { assign: assign, freeUnit: freeUnit, nextBatchCode: nextBatchCode, state: state };
  document.addEventListener('DOMContentLoaded', init);
}());
