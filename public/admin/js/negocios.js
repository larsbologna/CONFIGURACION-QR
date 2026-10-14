'use strict';
function businessForm(b = {}) {
  const f = {
    name: el('input', { value: b.name || '', required: true }), category: el('input', { value: b.category || '', placeholder: 'Gastronomía, peluquería…' }),
    phone: el('input', { value: b.phone || '' }), contact: el('input', { value: b.contact || '' }),
    delivery_date: el('input', { type: 'date', value: b.delivery_date || '' }), notes: el('textarea', {}, b.notes || ''),
  };
  const root = el('div', {},
    el('div', { class: 'row' }, el('div', {}, el('label', { text: 'Nombre *' }), f.name), el('div', {}, el('label', { text: 'Rubro' }), f.category)),
    el('div', { class: 'row' }, el('div', {}, el('label', { text: 'Teléfono' }), f.phone), el('div', {}, el('label', { text: 'Contacto' }), f.contact),
      el('div', {}, el('label', { text: 'Fecha de entrega' }), f.delivery_date)),
    el('label', { text: 'Observaciones' }), f.notes);
  return { root, value: () => Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value])) };
}

if (location.pathname.endsWith('negocios.html')) {
  init(async () => {
    const main = $('#main');
    const q = el('input', { placeholder: 'Buscar por nombre, rubro o contacto' });
    const list = el('div');
    const form = businessForm();
    put(main, el('h1', { text: 'Negocios' }),
      el('div', { class: 'grid cols-2' },
        el('div', { class: 'panel' }, el('h2', { text: 'Fichas' }), q, list),
        el('div', { class: 'panel' }, el('h2', { text: 'Nuevo negocio' }), form.root,
          el('div', { class: 'actions' }, el('button', { class: 'primary', type: 'button', text: 'Crear ficha', onclick: (e) => guard(async () => {
            const b = await api('POST', '/api/businesses', form.value()); location.href = `/admin/negocio.html?id=${b.id}`;
          }, e.target) })))));
    async function load() {
      const rows = await api('GET', `/api/businesses?q=${encodeURIComponent(q.value)}`);
      fill(list, rows.length ? el('table', {},
        el('thead', {}, el('tr', {}, ['Negocio', 'Rubro', 'Unidades', 'Escaneos', 'Entrega'].map((h) => el('th', { text: h })))),
        el('tbody', {}, rows.map((b) => el('tr', {},
          el('td', {}, el('a', { href: `/admin/negocio.html?id=${b.id}`, text: b.name }), b.archived ? ' (archivado)' : ''),
          el('td', { text: b.category || '—' }), el('td', { class: 'num', text: b.units_count }), el('td', { class: 'num', text: b.scans_count }),
          el('td', { text: fmtDay(b.delivery_date) })))))
        : el('p', { class: 'muted', text: 'No hay negocios cargados.' }));
    }
    q.addEventListener('input', load);
    await load();
  });
}
