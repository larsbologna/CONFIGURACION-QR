'use strict';
init(async () => {
  const main = $('#main');
  const [designs, profiles] = await Promise.all([api('GET', '/api/designs'), api('GET', '/api/profiles')]);
  const file = el('input', { type: 'file', accept: 'image/png,image/jpeg' });
  const name = el('input', { placeholder: 'Ej: Reseña Google 10×15' });
  const desc = el('input', { placeholder: 'Descripción (opcional)' });
  const w = el('input', { type: 'number', value: 100, step: 0.1 });
  const h = el('input', { type: 'number', value: 150, step: 0.1 });
  const profile = el('select', {}, el('option', { value: '', text: 'Detectar el QR automáticamente' }),
    profiles.map((p) => el('option', { value: p.id, text: `Perfil: ${p.name}` })));
  const result = el('div');

  put(main, el('h1', { text: 'Diseños de plástico' }),
    el('div', { class: 'panel' }, el('h2', { text: 'Subir diseño original' }),
      el('p', { class: 'muted', text: 'Subí el archivo final tal como lo imprime el proveedor (PNG o JPG, proporción 2:3, idealmente 1181 × 1772 px o más = 300 ppp). El diseño no se modifica: solo se reemplaza el área del QR y, si lo elegís, se agrega el número.' }),
      el('div', { class: 'row' }, el('div', {}, el('label', { text: 'Archivo' }), file), el('div', {}, el('label', { text: 'Nombre' }), name)),
      el('div', { class: 'row' }, el('div', {}, el('label', { text: 'Ancho físico (mm)' }), w), el('div', {}, el('label', { text: 'Alto físico (mm)' }), h),
        el('div', {}, el('label', { text: 'Ubicación inicial del QR' }), profile)),
      el('label', { text: 'Descripción' }), desc,
      el('div', { class: 'actions' }, el('button', { class: 'primary', type: 'button', text: 'Subir diseño', onclick: (e) => guard(async () => {
        if (!file.files[0]) throw new Error('Elegí un archivo');
        const fd = new FormData();
        fd.append('file', file.files[0]); fd.append('name', name.value || file.files[0].name); fd.append('description', desc.value);
        fd.append('width_mm', w.value); fd.append('height_mm', h.value); if (profile.value) fd.append('profile', profile.value);
        const r = await api('POST', '/api/designs', fd, { form: true });
        fill(result, el('div', { class: `msg ${r.detection.found ? 'ok' : 'warn'}`, text: r.detection.message }),
          r.notes.map((n) => el('div', { class: 'msg warn', text: n })),
          el('a', { class: 'btn primary', href: `/admin/editor.html?version=${r.version.id}`, text: 'Abrir el editor de plantilla y verificar' }));
      }, e.target) })), result),
    el('div', { class: 'panel' }, el('h2', { text: 'Diseños guardados' }),
      designs.length ? designs.map((d) => el('fieldset', {}, el('legend', { text: `${d.name}${d.archived ? ' (archivado)' : ''}` }),
        d.description ? el('p', { class: 'muted', text: d.description }) : null,
        el('table', {}, el('tbody', {}, d.versions.map((v) => el('tr', {},
          el('td', { text: `Versión ${v.version}` }), el('td', { text: `${v.width_mm} × ${v.height_mm} mm · ${v.image_width_px}×${v.image_height_px} px` }),
          el('td', { text: v.locked ? `Bloqueada (usada en ${v.units_count} unidades)` : 'Editable' }),
          el('td', {}, el('a', { class: 'btn small', href: `/admin/editor.html?version=${v.id}`, text: v.locked ? 'Ver' : 'Editar' }), ' ',
            el('button', { class: 'small', type: 'button', text: 'Nueva versión', onclick: (e) => guard(async () => {
              const nv = await api('POST', `/api/designs/${d.id}/versions`, (() => { const fd = new FormData(); fd.append('from_version_id', v.id); return fd; })(), { form: true });
              location.href = `/admin/editor.html?version=${nv.id}`;
            }, e.target) })))))),
        el('div', { class: 'actions' }, el('button', { class: 'small', type: 'button', text: d.archived ? 'Desarchivar' : 'Archivar', onclick: (e) => guard(async () => {
          await api('PATCH', `/api/designs/${d.id}`, { archived: !d.archived }); location.reload();
        }, e.target) }))))
        : el('p', { class: 'muted', text: 'Todavía no hay diseños.' })));
});
