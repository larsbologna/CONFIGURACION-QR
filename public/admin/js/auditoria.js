'use strict';
init(async () => {
  const main = $('#main');
  const [log, backups] = await Promise.all([api('GET', '/api/audit?limit=300'), api('GET', '/api/backups')]);
  put(main, el('h1', { text: 'Registro de acciones y copias de seguridad' }),
    el('div', { class: 'panel' }, el('h2', { text: 'Copias de seguridad' }),
      el('p', { class: 'muted', text: 'Cada copia guarda la base de datos completa y los diseños subidos en la carpeta "backups". Antes de cada migración se hace una copia automática. Guardá copias también fuera de esta PC.' }),
      el('div', { class: 'actions' }, el('button', { class: 'primary', type: 'button', text: 'Crear copia ahora', onclick: (e) => guard(async () => {
        const r = await api('POST', '/api/backups', {}); toast(`Copia creada: ${r.name}`); location.reload();
      }, e.target) })),
      backups.length ? el('table', {}, el('tbody', {}, backups.map((b) => el('tr', {}, el('td', { class: 'mono', text: b.name }),
        el('td', { class: 'num', text: `${(b.size_bytes / 1024).toFixed(0)} KB` }), el('td', { text: fmtDate(b.created_at) })))))
        : el('p', { class: 'muted', text: 'Todavía no hay copias.' })),
    el('div', { class: 'panel' }, el('h2', { text: 'Últimas acciones' }), el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Fecha', 'Administrador', 'Acción', 'Entidad', 'Detalle', 'IP'].map((h) => el('th', { text: h })))),
      el('tbody', {}, log.map((a) => el('tr', {}, el('td', { text: fmtDate(a.created_at) }), el('td', { text: a.username || '—' }),
        el('td', { text: a.action }), el('td', { text: a.entity_type ? `${a.entity_type} #${a.entity_id}` : '' }),
        el('td', { class: 'mono', text: (a.details || '').slice(0, 160) }), el('td', { class: 'mono', text: a.ip || '' }))))))));
});
