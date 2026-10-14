/* Utilidades compartidas del panel. Sin dependencias externas. */
'use strict';

const App = { session: null };

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
/** replaceChildren/append que aplanan arrays y omiten null/false. */
const kids = (c) => c.flat(Infinity).filter((x) => x != null && x !== false);
const fill = (target, ...c) => target.replaceChildren(...kids(c));
const put = (target, ...c) => target.append(...kids(c));
const $ = (sel, root = document) => root.querySelector(sel);
const qs = (name) => new URLSearchParams(location.search).get(name);

async function api(method, url, body, { raw = false, form = false } = {}) {
  const headers = {};
  if (App.session && method !== 'GET') headers['x-csrf-token'] = App.session.csrf;
  let payload;
  if (form) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  if (res.status === 401) { location.href = '/login'; throw new Error('Sesión vencida'); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Error ${res.status}`);
  }
  if (raw) return res;
  return res.json();
}

function toast(text, kind = 'ok', ms = 4500) {
  const box = $('#toast') || document.body.appendChild(el('div', { id: 'toast' }));
  const m = el('div', { class: `msg ${kind}`, text });
  box.append(m);
  setTimeout(() => m.remove(), ms);
}

/** Ejecuta una acción asíncrona mostrando los errores. */
async function guard(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, 'error', 8000); return undefined; } finally { if (btn) btn.disabled = false; }
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtDay = (d) => (d ? d.split('-').reverse().join('/') : '—');
const badge = (status) => el('span', { class: `badge ${status}`, text: App.session?.statuses[status] || status });

function openDialog(title, body) {
  const d = el('dialog', {},
    el('div', { class: 'dlg-head' }, el('strong', { text: title }), el('button', { class: 'small', type: 'button', onclick: () => d.close(), text: 'Cerrar' })),
    el('div', { class: 'dlg-body' }, body));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

const NAV = [
  ['/admin/', 'Panel'], ['/admin/lote.html', 'Generar lote de QR'], ['/admin/lotes.html', 'Lotes e impresión'],
  ['/admin/disenos.html', 'Diseños'], ['/admin/negocios.html', 'Negocios'], ['/admin/estadisticas.html', 'Estadísticas'],
  ['/admin/auditoria.html', 'Registro y copias'],
];

async function init(pageFn) {
  App.session = await api('GET', '/api/session');
  const here = location.pathname.replace(/index\.html$/, '');
  const top = $('#top');
  top.append(
    el('div', { class: 'brand', text: 'Plásticos QR' }),
    el('nav', {}, NAV.map(([href, text]) => el('a', { href, text, class: here === href ? 'on' : null }))),
    el('div', { class: 'user' }, el('span', { text: App.session.admin.username }),
      el('button', { class: 'small', type: 'button', text: 'Salir', onclick: async () => { await api('POST', '/api/logout', {}); location.href = '/login'; } })),
  );
  if (!App.session.public_base_url_is_production) {
    $('main').prepend(el('div', { class: 'msg warn' },
      `Modo prueba: los QR se generan con el dominio ${App.session.public_base_url}, que no es un dominio público HTTPS. `,
      'Configurá PUBLIC_BASE_URL en el archivo .env antes de generar lotes para imprimir.'));
  }
  try { await pageFn(); } catch (e) { toast(e.message, 'error', 10000); }
}

// ---------- Editor de destino (reutilizado en panel, unidad y negocio) ----------
function destinationEditor(unit) {
  const types = App.session.destination_types;
  const cfg = (() => { try { return JSON.parse(unit.destination_config || 'null'); } catch { return null; } })();
  const type = el('select', {}, el('option', { value: 'ninguno', text: 'Sin destino' }),
    Object.entries(types).map(([k, v]) => el('option', { value: k, text: v, selected: unit.destination_type === k })));
  const url = el('input', { placeholder: 'https://…', value: unit.destination_type && unit.destination_type !== 'pagina' && unit.destination_type !== 'google_resena' ? unit.destination_url : '' });
  const placeId = el('input', { placeholder: 'ChIJ…', value: cfg?.place_id || '' });
  const title = el('input', { value: cfg?.title || '', placeholder: 'Nombre del comercio' });
  const message = el('textarea', { placeholder: 'Ej.: Tu opinión sincera nos ayuda a mejorar.' }, cfg?.message || '');
  const links = el('textarea', { placeholder: 'Un enlace por línea:  Texto | https://…' },
    (cfg?.links || []).map((l) => `${l.text} | ${l.url}`).join('\n'));
  const fUrl = el('div', {}, el('label', { text: 'Dirección (https)' }), url);
  const fPlace = el('div', {}, el('label', { text: 'Place ID de Google (lleva directo a "Escribir reseña")' }), placeId,
    el('div', { class: 'muted', text: 'Se obtiene en developers.google.com/maps/documentation/places/web-service/place-id' }));
  const fPage = el('div', {}, el('label', { text: 'Título' }), title, el('label', { text: 'Mensaje (neutral, sin filtrar opiniones)' }), message,
    el('label', { text: 'Enlaces' }), links);
  const note = el('input', { placeholder: 'Motivo del cambio (opcional)' });
  const out = el('div');
  const sync = () => {
    fUrl.classList.toggle('hidden', !['url', 'menu', 'google_maps'].includes(type.value));
    fPlace.classList.toggle('hidden', type.value !== 'google_resena');
    fPage.classList.toggle('hidden', type.value !== 'pagina');
  };
  type.addEventListener('change', sync); sync();
  const value = () => {
    const t = type.value;
    if (t === 'pagina') {
      return {
        type: t, page: {
          title: title.value, message: message.value,
          links: links.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
            const i = l.lastIndexOf('|');
            return i < 0 ? { text: l, url: '' } : { text: l.slice(0, i).trim(), url: l.slice(i + 1).trim() };
          }),
        },
      };
    }
    if (t === 'google_resena') return { type: t, place_id: placeId.value };
    return { type: t, url: url.value };
  };
  const test = el('button', { type: 'button', text: 'Probar destino', onclick: (e) => guard(async () => {
    fill(out, el('div', { class: 'muted', text: 'Probando…' }));
    const r = await api('POST', '/api/destinations/test', { destination: value() });
    fill(out, el('div', { class: `msg ${r.ok ? 'ok' : 'error'}` }, r.message, r.url ? el('div', {}, el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', text: 'Abrir en otra pestaña' })) : null));
  }, e.target) });
  const root = el('div', {}, el('label', { text: 'Tipo de destino' }), type, fUrl, fPlace, fPage,
    el('label', { text: 'Nota' }), note, el('div', { class: 'actions' }, test), out);
  return { root, value, note: () => note.value };
}

/** Diálogo de acciones rápidas sobre una unidad. */
async function unitActions(unitId, onDone) {
  const u = await api('GET', `/api/units/${unitId}`);
  const de = destinationEditor(u);
  const status = el('select', {}, Object.entries(App.session.statuses).map(([k, v]) => el('option', { value: k, text: v, selected: u.status === k })));
  const body = el('div', {},
    el('div', { class: 'row' },
      el('div', {}, el('div', { class: 'muted', text: 'Unidad' }), el('div', { class: 'big-number', text: u.display_number })),
      el('div', {}, el('div', { class: 'muted', text: 'URL permanente (codificada en el QR)' }), el('div', { class: 'mono', text: u.qr_url }))),
    el('p', {}, 'Estado: ', badge(u.status), '  ·  Negocio: ', u.business_name || '—', '  ·  Lote: ', u.batch_code),
    el('fieldset', {}, el('legend', { text: 'Destino actual' }), el('div', { class: 'mono', text: u.destination_label }), de.root,
      el('div', { class: 'actions' }, el('button', { class: 'primary', type: 'button', text: 'Guardar destino', onclick: (e) => guard(async () => {
        await api('POST', `/api/units/${u.id}/destination`, { destination: de.value(), note: de.note() });
        toast('Destino actualizado. El QR impreso no cambia.'); d.close(); onDone && onDone();
      }, e.target) }))),
    el('fieldset', {}, el('legend', { text: 'Estado' }),
      u.status === 'baja' ? el('div', { class: 'muted', text: 'Dada de baja: estado final.' }) : el('div', { class: 'row' }, status,
        el('button', { class: 'shrink', type: 'button', text: 'Cambiar estado', onclick: (e) => guard(async () => {
          if (status.value === 'baja' && !confirm('Dar de baja es definitivo y el número no se reutiliza. ¿Continuar?')) return;
          await api('POST', `/api/units/${u.id}/status`, { status: status.value });
          toast('Estado actualizado'); d.close(); onDone && onDone();
        }, e.target) }))),
    el('div', { class: 'actions' }, el('a', { class: 'btn', href: `/admin/unidad.html?id=${u.id}`, text: 'Ver ficha completa e historial' })));
  const d = openDialog(`Unidad ${u.display_number}`, body);
}

function unitsTable(rows, { onChange, showBusiness = true } = {}) {
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ['Número', 'Estado', showBusiness ? 'Negocio' : null, 'Destino', 'Lote', 'Diseño', 'Escaneos', ''].filter((x) => x !== null).map((h) => el('th', { text: h })))),
    el('tbody', {}, rows.map((u) => el('tr', {},
      el('td', {}, el('a', { href: `/admin/unidad.html?id=${u.id}` }, el('strong', { text: u.display_number }))),
      el('td', {}, badge(u.status)),
      showBusiness ? el('td', {}, u.business_id ? el('a', { href: `/admin/negocio.html?id=${u.business_id}`, text: u.business_name }) : '—') : null,
      el('td', { class: 'mono', text: u.destination_label }),
      el('td', { text: u.batch_code }),
      el('td', { text: `${u.design_name} v${u.design_version}` }),
      el('td', { class: 'num', text: u.scan_count }),
      el('td', {}, el('button', { class: 'small', type: 'button', text: 'Acciones', onclick: () => guard(() => unitActions(u.id, onChange)) })))))));
}

function historyTable(rows, { showUnit = false } = {}) {
  const labels = { creada: 'Creada', estado: 'Estado', destino: 'Destino', asignada: 'Asignada', desasignada: 'Desasignada', entrega: 'Entrega', reemplazada_por: 'Reemplazada por', reemplaza_a: 'Reemplaza a', reemplazo_de: 'Reemplazo de' };
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, [showUnit ? 'Unidad' : null, 'Fecha', 'Acción', 'Antes', 'Después', 'Nota', 'Administrador'].filter(Boolean).map((h) => el('th', { text: h })))),
    el('tbody', {}, rows.map((h) => el('tr', {},
      showUnit ? el('td', {}, el('strong', { text: h.display_number })) : null,
      el('td', { text: fmtDate(h.created_at) }), el('td', { text: labels[h.action] || h.action }),
      el('td', { class: 'mono', text: h.old_value ?? '' }), el('td', { class: 'mono', text: h.new_value ?? '' }),
      el('td', { text: h.note ?? '' }), el('td', { text: h.username || '—' }))))));
}
