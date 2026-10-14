'use strict';
init(async () => {
  const main = $('#main');
  const id = Number(qs('id'));
  const b = await api('GET', `/api/businesses/${id}`);
  const form = (() => {
    const f = {
      name: el('input', { value: b.name }), category: el('input', { value: b.category || '' }), phone: el('input', { value: b.phone || '' }),
      contact: el('input', { value: b.contact || '' }), delivery_date: el('input', { type: 'date', value: b.delivery_date || '' }),
      notes: el('textarea', {}, b.notes || ''), archived: el('input', { type: 'checkbox', checked: Boolean(b.archived) }),
    };
    return {
      root: el('div', {},
        el('div', { class: 'row' }, el('div', {}, el('label', { text: 'Nombre' }), f.name), el('div', {}, el('label', { text: 'Rubro' }), f.category)),
        el('div', { class: 'row' }, el('div', {}, el('label', { text: 'Teléfono' }), f.phone), el('div', {}, el('label', { text: 'Contacto' }), f.contact),
          el('div', {}, el('label', { text: 'Fecha de entrega' }), f.delivery_date)),
        el('label', { text: 'Observaciones' }), f.notes, el('label', {}, f.archived, ' Archivado')),
      value: () => ({ ...Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'archived').map(([k, x]) => [k, x.value])), archived: f.archived.checked }),
    };
  })();
  const numbers = el('input', { placeholder: 'Ej: 001-010, 015' });
  const delivered = el('input', { type: 'date' });
  const setStatus = el('select', {}, el('option', { value: '', text: 'No cambiar el estado' }),
    ['reservado', 'vendido', 'entregado', 'activo'].map((s) => el('option', { value: s, text: App.session.statuses[s] })));

  put(main, el('h1', { text: b.name }),
    el('div', { class: 'grid cols-2' },
      el('div', { class: 'panel' }, el('h2', { text: 'Ficha' }), form.root,
        el('div', { class: 'actions' }, el('button', { class: 'primary', type: 'button', text: 'Guardar', onclick: (e) => guard(async () => {
          await api('PUT', `/api/businesses/${id}`, form.value()); toast('Ficha guardada'); location.reload();
        }, e.target) }))),
      el('div', { class: 'panel' }, el('h2', { text: 'Asignar plásticos' }),
        el('p', { class: 'muted', text: 'Una unidad solo puede pertenecer a un negocio. Si alguna ya está asignada a otro, no se asigna ninguna.' }),
        el('label', { text: 'Números' }), numbers,
        el('div', { class: 'row' }, el('div', {}, el('label', { text: 'Fecha de entrega' }), delivered), el('div', {}, el('label', { text: 'Estado' }), setStatus)),
        el('div', { class: 'actions' }, el('button', { class: 'primary', type: 'button', text: 'Asignar', onclick: (e) => guard(async () => {
          const r = await api('POST', `/api/businesses/${id}/assign`, { numbers: numbers.value, delivered_at: delivered.value || null, status: setStatus.value || null });
          toast(`Asignadas: ${r.assigned.join(', ')}`); location.reload();
        }, e.target) })))),
    el('div', { class: 'panel' }, el('h2', { text: `Plásticos asignados (${b.units.length})` }),
      b.units.length ? unitsTable(b.units, { showBusiness: false, onChange: () => location.reload() }) : el('p', { class: 'muted', text: 'Sin plásticos asignados.' }),
      b.units.length ? el('div', { class: 'actions' },
        el('a', { class: 'btn', href: `/admin/lotes.html`, text: 'Imprimir estos números (desde Lotes e impresión)' })) : null),
    el('div', { class: 'panel' }, el('h2', { text: 'Historial' }), historyTable(b.history, { showUnit: true })));
});
