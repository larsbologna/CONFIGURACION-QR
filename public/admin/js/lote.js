'use strict';
init(async () => {
  const main = $('#main');
  const designs = await api('GET', '/api/designs');
  const versions = designs.filter((d) => !d.archived).flatMap((d) => d.versions.map((v) => ({ ...v, design_name: d.name })));
  if (!versions.length) {
    put(main, el('h1', { text: 'Generar lote de QR' }), el('div', { class: 'panel' },
      el('p', { text: 'Primero subí un diseño de plástico.' }), el('a', { class: 'btn primary', href: '/admin/disenos.html', text: 'Ir a Diseños' })));
    return;
  }
  const version = el('select', {}, versions.map((v) => el('option', { value: v.id, text: `${v.design_name} — versión ${v.version}${v.locked ? ' (usada)' : ''}` })));
  const preset = el('div', { class: 'row' }, [1, 10, 50, 100, 500, 1000].map((n) => el('button', { type: 'button', class: 'shrink', text: n, onclick: () => { qty.value = n; refresh(); } })));
  const qty = el('input', { type: 'number', min: 1, max: App.session.max_batch, value: 10 });
  const prefix = el('input', { placeholder: 'Sin prefijo (ej. QR-)', maxlength: 7 });
  const digits = el('select', {}, [3, 4, 5, 6].map((n) => el('option', { value: n, text: `${n} dígitos (${'0'.repeat(n - 1)}1)`, selected: n === 3 })));
  const placement = el('select', {},
    el('option', { value: 'ambos', text: 'En ambos lugares (plástico y plancha)' }),
    el('option', { value: 'plancha', text: 'Solo debajo de cada diseño en la plancha' }),
    el('option', { value: 'plastico', text: 'Solo dentro del plástico' }));
  const notes = el('input', { placeholder: 'Notas del lote (opcional)' });
  const summary = el('div');
  const thumbs = el('div', { class: 'thumbs' });
  const testDomain = el('input', { type: 'checkbox', id: 'td' });
  const confirmBtn = el('button', { class: 'primary', type: 'button', text: 'Confirmar y generar', disabled: true });

  put(main, el('h1', { text: 'Generar lote de QR' }),
    el('div', { class: 'grid cols-2' },
      el('div', { class: 'panel' },
        el('label', { text: 'Diseño' }), version,
        el('label', { text: 'Cantidad' }), preset, qty,
        el('div', { class: 'row' }, el('div', {}, el('label', { text: 'Prefijo' }), prefix), el('div', {}, el('label', { text: 'Formato de número' }), digits)),
        el('div', { class: 'muted', text: 'A partir de 1000 el número se amplía solo (1000, 1001…). Nunca se repite ni se reutiliza.' }),
        el('label', { text: 'Dónde imprimir el número' }), placement,
        el('label', { text: 'Notas' }), notes),
      el('div', { class: 'panel' }, el('h2', { text: 'Resumen antes de confirmar' }), summary,
        App.session.public_base_url_is_production ? null : el('label', {}, testDomain, ' Entiendo que este lote es de PRUEBA (dominio no público).'),
        el('div', { class: 'actions' }, confirmBtn))),
    el('div', { class: 'panel' }, el('h2', { text: 'Vista previa (primeras unidades, números provisorios)' }),
      el('p', { class: 'muted', text: 'La vista previa lleva la marca "VISTA PREVIA" y un QR de ejemplo. Los QR definitivos se crean al confirmar.' }), thumbs));

  let last = null; let timer = null;
  const body = () => ({
    design_version_id: Number(version.value), quantity: Number(qty.value), prefix: prefix.value.trim(),
    min_digits: Number(digits.value), placement: placement.value, notes: notes.value,
  });

  async function refresh() {
    confirmBtn.disabled = true;
    try {
      last = await api('POST', '/api/batches/preview', body());
    } catch (e) {
      fill(summary, el('div', { class: 'msg error', text: e.message })); fill(thumbs); return;
    }
    fill(summary, 
      el('table', {}, el('tbody', {},
        el('tr', {}, el('th', { text: 'Lote' }), el('td', { text: last.code })),
        el('tr', {}, el('th', { text: 'Cantidad' }), el('td', { text: last.quantity })),
        el('tr', {}, el('th', { text: 'Primer número' }), el('td', {}, el('strong', { text: last.first_display }))),
        el('tr', {}, el('th', { text: 'Último número' }), el('td', {}, el('strong', { text: last.last_display }))),
        el('tr', {}, el('th', { text: 'URL de cada QR' }), el('td', { class: 'mono', text: `${last.public_base_url}/q/<identificador único>` })))),
      last.warnings.map((w) => el('div', { class: 'msg warn', text: w })),
      el('div', { class: 'muted', text: last.note }));
    confirmBtn.disabled = false;
    const n = Math.min(4, last.quantity);
    const imgs = [];
    for (let i = 0; i < n; i++) {
      const serial = last.first_serial + i;
      const res = await api('POST', `/api/design-versions/${version.value}/preview`, {
        serial, prefix: prefix.value.trim(), min_digits: Number(digits.value), number_in_design: placement.value !== 'plancha' && last.number_fits, max_width: 360,
      }, { raw: true });
      const url = URL.createObjectURL(await res.blob());
      imgs.push(el('figure', {}, el('img', { src: url, alt: `Vista previa ${i + 1}` }),
        placement.value !== 'plastico' || !last.number_fits ? el('figcaption', { text: `${prefix.value.trim().toUpperCase()}${String(serial).padStart(Number(digits.value), '0')}` }) : null));
    }
    fill(thumbs, ...imgs);
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 350); };
  [version, qty, prefix, digits, placement].forEach((x) => { x.addEventListener('input', later); x.addEventListener('change', later); });

  confirmBtn.addEventListener('click', () => guard(async () => {
    if (!App.session.public_base_url_is_production && !testDomain.checked) throw new Error('Marcá la casilla de lote de prueba o configurá el dominio público.');
    if (!confirm(`Se reservarán definitivamente ${last.quantity} números (desde ${last.first_display}). ¿Confirmar?`)) return;
    const b = await api('POST', '/api/batches', { ...body(), confirm: true, confirm_test_domain: testDomain.checked });
    toast(`Lote ${b.code} generado: ${b.first_display} a ${b.last_display}`);
    location.href = `/admin/lotes.html?id=${b.id}`;
  }, confirmBtn));
  await refresh();
});
