'use strict';
init(async () => {
  const main = $('#main');
  const id = Number(qs('id'));
  const u = await api('GET', `/api/units/${id}`);
  const businesses = await api('GET', '/api/businesses');
  const reload = () => location.reload();

  const de = destinationEditor(u);
  const status = el('select', {}, Object.entries(App.session.statuses).map(([k, v]) => el('option', { value: k, text: v, selected: u.status === k })));
  const statusNote = el('input', { placeholder: 'Nota (opcional)' });
  const biz = el('select', {}, el('option', { value: '', text: 'Elegir negocio…' }), businesses.filter((b) => !b.archived).map((b) => el('option', { value: b.id, text: b.name })));
  const delivered = el('input', { type: 'date', value: u.delivered_at || '' });
  const replNumber = el('input', { placeholder: 'Número de una unidad disponible (vacío = generar una nueva)' });
  const replNote = el('input', { placeholder: 'Motivo del defecto' });

  put(main, 
    el('h1', {}, `Unidad ${u.display_number} `, badge(u.status)),
    el('div', { class: 'grid cols-2' },
      el('div', { class: 'panel' },
        el('img', { src: `/api/units/${id}/export.png?max_width=500`, alt: `Diseño de la unidad ${u.display_number}`, class: 'sheet-preview' }),
        el('div', { class: 'actions' },
          el('a', { class: 'btn', href: `/api/units/${id}/export.png?download=1`, text: 'PNG' }),
          el('a', { class: 'btn', href: `/api/units/${id}/export.pdf?download=1`, text: 'PDF 10×15' }),
          el('a', { class: 'btn', href: `/api/units/${id}/export.svg?download=1`, text: 'SVG' }))),
      el('div', { class: 'panel' },
        el('table', {}, el('tbody', {},
          [['Número visible', el('strong', { text: u.display_number })], ['ID interno', u.id], ['Identificador público', el('span', { class: 'mono', text: u.public_id })],
            ['URL permanente (QR)', el('a', { class: 'mono', href: u.qr_url, target: '_blank', rel: 'noopener', text: u.qr_url })],
            ['Destino actual', el('span', { class: 'mono', text: u.destination_label })],
            ['Lote', el('a', { href: `/admin/lotes.html?id=${u.batch_id}`, text: u.batch_code })], ['Diseño', `${u.design_name} v${u.design_version}`],
            ['Número en el plástico', u.number_in_design ? 'Sí' : 'No (solo en la plancha)'],
            ['Negocio', u.business_id ? el('a', { href: `/admin/negocio.html?id=${u.business_id}`, text: u.business_name }) : '—'],
            ['Entrega', fmtDay(u.delivered_at)], ['Generada', fmtDate(u.created_at)], ['Escaneos', `${u.scan_count} (último: ${fmtDate(u.last_scan_at)})`],
            ['Reemplaza a', u.replaces_unit_id ? el('a', { href: `?id=${u.replaces_unit_id}`, text: u.replaces_display_number }) : '—'],
            ['Reemplazada por', u.replaced_by.length ? u.replaced_by.map((r) => el('a', { href: `?id=${r.id}`, text: `${r.display_number} ` })) : '—'],
          ].map(([k, v]) => el('tr', {}, el('th', { text: k }), el('td', {}, v)))))),
    ),
    el('div', { class: 'grid cols-2' },
      el('div', { class: 'panel' }, el('h2', { text: 'Redirección' }),
        el('p', { class: 'muted', text: 'Cambiar el destino no cambia el QR impreso: la URL permanente sigue siendo la misma. El QR solo redirige cuando la unidad está en estado "Activo".' }),
        de.root,
        el('div', { class: 'actions' }, el('button', { class: 'primary', type: 'button', text: 'Guardar destino', onclick: (e) => guard(async () => {
          await api('POST', `/api/units/${id}/destination`, { destination: de.value(), note: de.note() }); toast('Destino guardado'); reload();
        }, e.target) }))),
      el('div', {},
        el('div', { class: 'panel' }, el('h2', { text: 'Estado' }),
          u.status === 'baja' ? el('p', { class: 'muted', text: 'Unidad dada de baja (estado final). Su número no se reutiliza.' })
            : el('div', {}, el('div', { class: 'row' }, status, statusNote),
              el('div', { class: 'actions' }, el('button', { type: 'button', text: 'Cambiar estado', onclick: (e) => guard(async () => {
                if (status.value === 'baja' && !confirm('Dar de baja es definitivo. ¿Continuar?')) return;
                await api('POST', `/api/units/${id}/status`, { status: status.value, note: statusNote.value }); toast('Estado actualizado'); reload();
              }, e.target) })))),
        el('div', { class: 'panel' }, el('h2', { text: 'Negocio y entrega' }),
          u.business_id
            ? el('div', {}, el('p', {}, 'Asignada a ', el('strong', { text: u.business_name }), '.'),
              el('div', { class: 'row' }, el('div', {}, el('label', { text: 'Fecha de entrega' }), delivered),
                el('button', { class: 'shrink', type: 'button', text: 'Guardar fecha', onclick: (e) => guard(async () => { await api('POST', `/api/units/${id}/delivered`, { date: delivered.value || null }); toast('Fecha guardada'); reload(); }, e.target) }),
                el('button', { class: 'shrink danger', type: 'button', text: 'Quitar del negocio', onclick: (e) => guard(async () => {
                  if (!confirm('¿Quitar la unidad de este negocio?')) return;
                  await api('POST', `/api/units/${id}/unassign`, {}); toast('Unidad desasignada'); reload();
                }, e.target) })))
            : el('div', { class: 'row' }, el('div', {}, el('label', { text: 'Negocio' }), biz), el('div', {}, el('label', { text: 'Fecha de entrega' }), delivered),
              el('button', { class: 'shrink primary', type: 'button', text: 'Asignar', onclick: (e) => guard(async () => {
                if (!biz.value) throw new Error('Elegí un negocio');
                await api('POST', `/api/businesses/${biz.value}/assign`, { numbers: String(u.serial), delivered_at: delivered.value || null }); toast('Unidad asignada'); reload();
              }, e.target) }))),
        u.status !== 'baja' && u.status !== 'defectuoso' ? el('div', { class: 'panel' }, el('h2', { text: 'Reemplazo por defecto' }),
          el('p', { class: 'muted', text: 'Marca esta unidad como defectuosa y transfiere negocio y destino a la unidad de reemplazo, que queda vinculada a esta.' }),
          replNumber, replNote,
          el('div', { class: 'actions' }, el('button', { class: 'danger', type: 'button', text: 'Marcar defectuosa y reemplazar', onclick: (e) => guard(async () => {
            if (!confirm('¿Marcar como defectuosa y reemplazar?')) return;
            const r = await api('POST', `/api/units/${id}/replace`, { replacement_number: replNumber.value.trim() || null, note: replNote.value });
            toast(`Reemplazada por ${r.display_number}`); location.href = `?id=${r.id}`;
          }, e.target) }))) : null)),
    el('div', { class: 'panel' }, el('h2', { text: 'Historial de cambios' }), historyTable(u.history)));
});
