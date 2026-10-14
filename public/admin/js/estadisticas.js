'use strict';
init(async () => {
  const main = $('#main');
  const from = el('input', { type: 'date' }); const to = el('input', { type: 'date' });
  const group = el('select', {}, el('option', { value: 'dia', text: 'Por día' }), el('option', { value: 'semana', text: 'Por semana' }), el('option', { value: 'mes', text: 'Por mes' }));
  const out = el('div');
  put(main, el('h1', { text: 'Estadísticas' }),
    el('div', { class: 'panel' }, el('div', { class: 'row' }, el('div', {}, el('label', { text: 'Desde' }), from), el('div', {}, el('label', { text: 'Hasta' }), to),
      el('div', {}, el('label', { text: 'Agrupar' }), group), el('button', { class: 'shrink primary', type: 'button', text: 'Ver', onclick: () => guard(load) })),
      el('p', { class: 'muted', text: 'Escaneo = alguien abrió el QR. Clic = eligió un enlace en una página propia. No se guardan IP ni datos del teléfono.' })),
    out);

  const bars = (rows, key, label) => {
    const max = Math.max(1, ...rows.map((r) => r[key]));
    return el('table', {}, el('tbody', {}, rows.map((r) => {
      const bar = el('div', { class: 'bar' }); bar.style.width = `${(r[key] / max) * 100}%`;
      return el('tr', {}, el('td', { text: label(r) }), el('td', { class: 'num', text: r[key] }), el('td', { class: 'num', text: r.clics }), el('td', {}, bar));
    })));
  };
  async function load() {
    const p = new URLSearchParams({ group: group.value });
    if (from.value) p.set('from', from.value); if (to.value) p.set('to', to.value);
    const s = await api('GET', `/api/stats?${p}`);
    from.value = s.from; to.value = s.to;
    const head = () => el('thead', {}, el('tr', {}, ['', 'Escaneos', 'Clics', ''].map((h) => el('th', { text: h }))));
    fill(out, 
      el('div', { class: 'cards' },
        el('div', { class: 'card' }, el('div', { class: 'n', text: s.totals.escaneo }), el('div', { class: 'l', text: 'Escaneos en el período' })),
        el('div', { class: 'card' }, el('div', { class: 'n', text: s.totals.clic }), el('div', { class: 'l', text: 'Clics en el período' })),
        el('div', { class: 'card' }, el('div', { class: 'n', text: s.all_time_scans }), el('div', { class: 'l', text: 'Escaneos históricos' })),
        el('div', { class: 'card' }, el('div', { class: 'n', text: 'No medible' }), el('div', { class: 'l', text: 'Reseñas publicadas' }))),
      el('div', { class: 'msg warn', text: s.reviews_note }),
      el('div', { class: 'panel' }, el('h2', { text: 'Por período' }), s.series.length ? el('table', {}, head(), bars(s.series, 'escaneos', (r) => r.period).firstChild) : el('p', { class: 'muted', text: 'Sin escaneos en el período.' })),
      el('div', { class: 'grid cols-2' },
        el('div', { class: 'panel' }, el('h2', { text: 'Por unidad' }), s.byUnit.length ? el('table', {}, head(), bars(s.byUnit, 'escaneos', (r) => `${r.display_number}${r.business_name ? ` · ${r.business_name}` : ''}`).firstChild) : el('p', { class: 'muted', text: 'Sin datos.' })),
        el('div', { class: 'panel' }, el('h2', { text: 'Por negocio' }), s.byBusiness.length ? el('table', {}, head(), bars(s.byBusiness, 'escaneos', (r) => r.business_name).firstChild) : el('p', { class: 'muted', text: 'Sin datos.' }))));
  }
  await load();
});
