'use strict';
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

init(async () => {
  const main = $('#main');
  const id = qs('id');
  const batches = await api('GET', '/api/batches');
  put(main, el('h1', { text: 'Lotes e impresión' }));

  const list = el('div', { class: 'panel' }, el('h2', { text: 'Lotes generados' }),
    batches.length ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Lote', 'Rango', 'Cantidad', 'Diseño', 'Número', 'Fecha'].map((h) => el('th', { text: h })))),
      el('tbody', {}, batches.map((b) => el('tr', {},
        el('td', {}, el('a', { href: `?id=${b.id}`, text: b.code })), el('td', { text: `${b.first_display}–${b.last_display}` }),
        el('td', { class: 'num', text: b.quantity }), el('td', { text: `${b.design_name} v${b.design_version}` }),
        el('td', { text: [b.number_in_design ? 'en plástico' : null, b.number_on_sheet ? 'en plancha' : null].filter(Boolean).join(' + ') }),
        el('td', { class: 'muted', text: fmtDate(b.created_at) }))))))
      : el('p', { class: 'muted', text: 'No hay lotes todavía.' }));

  // ---------- Exportación (por lote o por lista de números) ----------
  const selector = el('input', { placeholder: 'Números a exportar, ej: 1-10, 15' });
  let selection = id ? { batch_id: id } : null;

  if (id) {
    const b = await api('GET', `/api/batches/${id}`);
    put(main, el('div', { class: 'panel' },
      el('h2', { text: `Lote ${b.code}` }),
      el('div', { class: 'row' },
        el('div', {}, el('div', { class: 'muted', text: 'Rango' }), el('div', { class: 'big-number', text: `${b.first_display} – ${b.last_display}` })),
        el('div', {}, el('div', { class: 'muted', text: 'Cantidad' }), el('div', { class: 'big-number', text: b.quantity })),
        el('div', {}, el('div', { class: 'muted', text: 'Diseño' }), el('div', { text: `${b.design_name} v${b.design_version}` }),
          el('div', { class: 'muted', text: `Dominio: ${b.base_url}` }))),
      b.warnings.map((w) => el('div', { class: 'msg warn', text: w })),
      el('p', {}, el('a', { href: `/admin/?batch=${encodeURIComponent(b.code)}`, text: 'Ver unidades de este lote en el panel' }))));
  } else {
    put(main, el('div', { class: 'panel' }, el('h2', { text: 'Exportar unidades sueltas' }),
      el('div', { class: 'row' }, selector, el('button', { class: 'shrink', type: 'button', text: 'Usar esta selección', onclick: () => { selection = { numbers: selector.value }; refresh(); } })),
      el('p', { class: 'muted', text: 'O elegí un lote de la lista de abajo.' })));
  }

  const papers = Object.keys(App.session.papers);
  const f = {
    paper: el('select', {}, [...papers, 'PERSONALIZADO'].map((p) => el('option', { value: p, text: p === 'PERSONALIZADO' ? 'Personalizado' : `${p} (${App.session.papers[p]?.join(' × ')} mm)` }))),
    orientation: el('select', {}, el('option', { value: 'horizontal', text: 'Horizontal' }), el('option', { value: 'vertical', text: 'Vertical' })),
    width_mm: el('input', { type: 'number', placeholder: 'Ancho mm' }),
    height_mm: el('input', { type: 'number', placeholder: 'Alto mm' }),
    margin_mm: el('input', { type: 'number', value: 8, step: 0.5 }),
    gap_x_mm: el('input', { type: 'number', value: 6, step: 0.5 }),
    gap_y_mm: el('input', { type: 'number', value: 6, step: 0.5 }),
    per_sheet: el('input', { type: 'number', min: 1, placeholder: 'Máximo posible' }),
    label: el('select', {}, el('option', { value: '', text: 'Según el lote' }), el('option', { value: '1', text: 'Sí' }), el('option', { value: '0', text: 'No' })),
    label_pt: el('input', { type: 'number', value: 12 }),
    crop_marks: el('select', {}, el('option', { value: '0', text: 'Sin marcas de corte' }), el('option', { value: '1', text: 'Con marcas de corte' })),
  };
  const custom = el('div', { class: 'row hidden' }, el('div', {}, el('label', { text: 'Ancho hoja (mm)' }), f.width_mm), el('div', {}, el('label', { text: 'Alto hoja (mm)' }), f.height_mm));
  const info = el('div');
  const schematic = el('div');
  const frame = el('div');
  const zipOpts = { png: el('input', { type: 'checkbox', checked: true }), pdf: el('input', { type: 'checkbox', checked: true }), svg: el('input', { type: 'checkbox' }), sheet: el('input', { type: 'checkbox', checked: true }) };

  const localPanel = el('div', { class: 'panel' }, el('h2', { text: 'Mandar al local que fabrica los plásticos' }),
    el('p', {}, 'Un solo ZIP con todo lo que necesita el local: ficha técnica con medidas e instrucciones, un PDF con todos los diseños a tamaño real (100 × 150 mm, una página por plástico), un archivo por plástico (PDF, PNG y SVG) con su número en el nombre y una hoja de control con miniaturas numeradas.'),
    App.session.public_base_url_is_production ? null : el('div', { class: 'msg error', text: 'Modo prueba: el paquete saldrá marcado "PRUEBA – NO FABRICAR" porque los QR no apuntan a un dominio público. Configurá el dominio definitivo antes de generar el lote real.' }),
    el('div', { class: 'actions' }, el('button', { class: 'primary', type: 'button', text: 'Descargar paquete para el local (ZIP)', onclick: () => {
      toast('Preparando el paquete… en lotes grandes puede tardar unos minutos.', 'ok', 8000);
      location.href = `/api/export/local.zip?${new URLSearchParams(selection)}`;
    } })));
  const exportPanel = el('div', { class: 'panel' }, el('h2', { text: 'Plancha de impresión (si imprimís vos)' }),
    el('p', { class: 'muted', text: 'Cada diseño se coloca a tamaño real (nunca se reduce ni amplía). El tamaño de la hoja es independiente del tamaño del plástico.' }),
    el('div', { class: 'row' },
      el('div', {}, el('label', { text: 'Papel' }), f.paper), el('div', {}, el('label', { text: 'Orientación' }), f.orientation),
      el('div', {}, el('label', { text: 'Margen (mm)' }), f.margin_mm), el('div', {}, el('label', { text: 'Separación horizontal (mm)' }), f.gap_x_mm),
      el('div', {}, el('label', { text: 'Separación vertical (mm)' }), f.gap_y_mm)),
    custom,
    el('div', { class: 'row' },
      el('div', {}, el('label', { text: 'Unidades por hoja' }), f.per_sheet), el('div', {}, el('label', { text: 'Número debajo de cada diseño' }), f.label),
      el('div', {}, el('label', { text: 'Tamaño del número (pt)' }), f.label_pt), el('div', {}, el('label', { text: 'Marcas de corte' }), f.crop_marks)),
    info, schematic,
    el('div', { class: 'actions' },
      el('button', { type: 'button', text: 'Vista previa del PDF', onclick: () => showPdf() }),
      el('button', { class: 'primary', type: 'button', text: 'Descargar plancha PDF', onclick: () => go('/api/export/sheet.pdf', { download: 1 }) }),
      el('button', { type: 'button', text: 'Descargar CSV', onclick: () => go('/api/export/units.csv') })),
    el('fieldset', {}, el('legend', { text: 'ZIP con archivos individuales' }),
      el('label', {}, zipOpts.png, ' PNG de cada unidad'), el('label', {}, zipOpts.pdf, ' PDF de cada unidad (100 × 150 mm)'),
      el('label', {}, zipOpts.svg, ' SVG de cada unidad'), el('label', {}, zipOpts.sheet, ' Plancha PDF + CSV'),
      el('div', { class: 'actions' }, el('button', { type: 'button', text: 'Descargar ZIP', onclick: () => {
        toast('Generando ZIP… en lotes grandes puede tardar varios minutos.', 'ok', 8000);
        go('/api/export/batch.zip', Object.fromEntries(Object.entries(zipOpts).map(([k, c]) => [k, c.checked ? 1 : 0])));
      } }))),
    el('div', { class: 'msg warn', text: 'Al imprimir en una impresora común, elegí "Tamaño real" o escala 100 %. Con "Ajustar a la página" el plástico NO medirá 10 × 15 cm. Medí la regla de 50 mm del pie de página para comprobarlo.' }),
    frame);

  put(main, localPanel, exportPanel, list);
  if (!selection) { exportPanel.classList.add('hidden'); localPanel.classList.add('hidden'); }

  function params(extra = {}) {
    const p = new URLSearchParams(selection);
    for (const [k, input] of Object.entries(f)) if (input.value !== '' && (k !== 'width_mm' && k !== 'height_mm' || f.paper.value === 'PERSONALIZADO')) p.set(k, input.value);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }
  function go(url, extra) { location.href = `${url}?${params(extra)}`; }
  function showPdf() {
    fill(frame, el('iframe', { class: 'pdf', src: `/api/export/sheet.pdf?${params()}`, title: 'Vista previa de la plancha' }));
  }

  async function refresh() {
    if (!selection) return;
    exportPanel.classList.remove('hidden'); localPanel.classList.remove('hidden');
    custom.classList.toggle('hidden', f.paper.value !== 'PERSONALIZADO');
    let L;
    try { L = await api('GET', `/api/export/sheet-layout?${params()}`); } catch (e) {
      fill(info, el('div', { class: 'msg error', text: e.message })); fill(schematic); return;
    }
    fill(info, 
      el('p', {}, `Hoja ${L.page_w_mm} × ${L.page_h_mm} mm · entran ${L.capacity} diseños (${L.cols} × ${L.rows}) · se usarán ${L.per_sheet} por hoja · ${L.total_units} unidades en ${L.pages} hoja(s).`),
      L.errors.map((x) => el('div', { class: 'msg error', text: x })), L.warnings.map((x) => el('div', { class: 'msg warn', text: x })));
    const svg = svgEl('svg', { viewBox: `0 0 ${L.page_w_mm} ${L.page_h_mm}`, width: Math.min(520, L.page_w_mm * 1.6), class: 'sheet-preview' });
    svg.append(svgEl('rect', { x: 0, y: 0, width: L.page_w_mm, height: L.page_h_mm, fill: '#fff' }));
    svg.append(svgEl('rect', { x: L.params.margin_mm, y: L.params.margin_mm, width: L.page_w_mm - 2 * L.params.margin_mm, height: L.page_h_mm - 2 * L.params.margin_mm, fill: 'none', stroke: '#c33', 'stroke-dasharray': '2 2', 'stroke-width': 0.4 }));
    L.cells.forEach((c, i) => {
      svg.append(svgEl('rect', { x: c.x, y: c.y, width: L.unit_w_mm, height: L.unit_h_mm, fill: '#dbe7fb', stroke: '#1a5fd0', 'stroke-width': 0.5 }));
      const n = L.numbers[i] || '';
      svg.append(svgEl('text', { x: c.x + L.unit_w_mm / 2, y: c.y + L.unit_h_mm / 2, 'font-size': 10, 'text-anchor': 'middle', fill: '#1a5fd0' }, '10 × 15 cm'));
      if (L.label_h_mm) svg.append(svgEl('text', { x: c.x + L.unit_w_mm / 2, y: c.y + L.unit_h_mm + L.label_h_mm * 0.75, 'font-size': 6, 'text-anchor': 'middle', fill: '#000' }, n));
    });
    fill(schematic, el('div', { class: 'muted', text: 'Esquema a escala de la hoja 1 (línea roja: margen):' }), svg);
  }
  Object.values(f).forEach((x) => x.addEventListener('change', refresh));
  await refresh();
});
