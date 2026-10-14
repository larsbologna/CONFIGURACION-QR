'use strict';
init(async () => {
  const main = $('#main');
  const cards = el('div', { class: 'cards' });
  const recent = el('div', { class: 'grid cols-2' });
  const filters = {
    number: el('input', { placeholder: 'Número (ej. 007)' }),
    business: el('input', { placeholder: 'Negocio' }),
    batch: el('input', { placeholder: 'Lote', value: qs('batch') || '' }),
    status: el('select', {}, el('option', { value: '', text: 'Todos los estados' }),
      Object.entries(App.session.statuses).map(([k, v]) => el('option', { value: k, text: v }))),
    design: el('input', { placeholder: 'Diseño' }),
  };
  const results = el('div');
  let offset = 0; const limit = 50;

  put(main, 
    el('h1', { text: 'Panel principal' }), cards, recent,
    el('div', { class: 'panel' }, el('h2', { text: 'Unidades' }),
      el('div', { class: 'row' }, Object.values(filters), el('button', { class: 'shrink primary', type: 'button', text: 'Buscar', onclick: () => { offset = 0; search(); } })),
      el('div', { class: 'actions' },
        el('a', { class: 'btn', href: '/admin/lote.html', text: '+ Generar lote' }),
        el('a', { class: 'btn', href: '/admin/negocios.html', text: 'Asignar a un negocio' }),
        el('button', { type: 'button', text: 'Descargar CSV de la búsqueda', onclick: () => { location.href = `/api/export/units.csv?${params()}`; } })),
      results));

  for (const f of Object.values(filters)) f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { offset = 0; search(); } });
  filters.status.addEventListener('change', () => { offset = 0; search(); });

  function params() {
    const p = new URLSearchParams();
    for (const [k, f] of Object.entries(filters)) if (f.value.trim()) p.set(k, f.value.trim());
    return p;
  }

  async function search() {
    const p = params(); p.set('limit', limit); p.set('offset', offset);
    const r = await api('GET', `/api/units?${p}`);
    fill(results, 
      r.rows.length ? unitsTable(r.rows, { onChange: load }) : el('p', { class: 'muted', text: 'No hay unidades que coincidan. Generá un lote para empezar.' }),
      el('div', { class: 'pager' },
        el('button', { class: 'small', type: 'button', text: '← Anteriores', disabled: offset === 0, onclick: () => { offset -= limit; search(); } }),
        el('span', { class: 'muted', text: r.total ? `${offset + 1}–${Math.min(offset + limit, r.total)} de ${r.total}` : '' }),
        el('button', { class: 'small', type: 'button', text: 'Siguientes →', disabled: offset + limit >= r.total, onclick: () => { offset += limit; search(); } })));
  }

  async function load() {
    const d = await api('GET', '/api/dashboard');
    const c = d.counts;
    const items = [['Total generados', d.total], ['Disponibles', c.generado + c.disponible], ['Reservados', c.reservado],
      ['Vendidos', c.vendido], ['Entregados', c.entregado], ['Activos', c.activo], ['Pausados', c.pausado],
      ['Defectuosos', c.defectuoso], ['Dados de baja', c.baja], ['Escaneos totales', d.scans]];
    fill(cards, ...items.map(([l, n]) => el('div', { class: 'card' }, el('div', { class: 'n', text: n }), el('div', { class: 'l', text: l }))));
    fill(recent, 
      el('div', { class: 'panel' }, el('h2', { text: 'Últimos lotes' }),
        d.batches.length ? el('table', {}, el('tbody', {}, d.batches.map((b) => el('tr', {},
          el('td', {}, el('a', { href: `/admin/lotes.html?id=${b.id}`, text: b.code })),
          el('td', { text: `${String(b.first_serial).padStart(b.number_min_digits, '0')}–${String(b.last_serial).padStart(b.number_min_digits, '0')}` }),
          el('td', { class: 'num', text: `${b.quantity} u.` }), el('td', { class: 'muted', text: fmtDate(b.created_at) })))))
          : el('p', { class: 'muted', text: 'Todavía no se generó ningún lote.' })),
      el('div', { class: 'panel' }, el('h2', { text: 'Últimos cambios de destino' }),
        d.changes.length ? el('table', {}, el('tbody', {}, d.changes.map((h) => el('tr', {},
          el('td', {}, el('a', { href: `/admin/unidad.html?id=${h.unit_id}`, text: h.display_number })),
          el('td', { class: 'mono', text: h.new_value || '—' }), el('td', { class: 'muted', text: `${h.username || '—'} · ${fmtDate(h.created_at)}` })))))
          : el('p', { class: 'muted', text: 'Sin cambios todavía.' })));
    await search();
  }
  await load();
});
