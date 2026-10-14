'use strict';
/* Editor de plantilla: ubica el QR nuevo, el parche que tapa el QR original y el número. */
init(async () => {
  const main = $('#main');
  const vid = Number(qs('version'));
  let v = await api('GET', `/api/design-versions/${vid}`);
  const profiles = await api('GET', '/api/profiles');
  let cfg = JSON.parse(JSON.stringify(v.config));
  const W = v.width_mm; const H = v.height_mm;
  const locked = Boolean(v.locked);

  const img = el('img', { src: `/api/design-versions/${vid}/image`, alt: 'Diseño original' });
  const stage = el('div', { class: 'stage' }, img);
  const boxes = {
    qr: el('div', { class: 'box qr' }, el('span', { class: 'tag', text: 'QR nuevo' }), el('span', { class: 'handle' })),
    cover: el('div', { class: 'box cover' }, el('span', { class: 'tag', text: 'Parche (tapa QR original)' }), el('span', { class: 'handle' })),
    number: el('div', { class: 'box number' }, el('span', { class: 'tag', text: 'Número' }), el('span', { class: 'handle' })),
  };
  stage.append(boxes.cover, boxes.qr, boxes.number);

  // Campos numéricos (mm)
  const n = (val, step = 0.1) => el('input', { type: 'number', step, value: val, disabled: locked });
  const F = {
    qr: { x_mm: n(cfg.qr.x_mm), y_mm: n(cfg.qr.y_mm), size_mm: n(cfg.qr.size_mm), margin_modules: n(cfg.qr.margin_modules, 1),
      ecc: el('select', { disabled: locked }, ['L', 'M', 'Q', 'H'].map((x) => el('option', { value: x, text: x, selected: cfg.qr.ecc === x }))),
      dark: el('input', { type: 'color', value: cfg.qr.dark, disabled: locked }), light: el('input', { type: 'color', value: cfg.qr.light, disabled: locked }) },
    cover: { enabled: el('input', { type: 'checkbox', checked: cfg.cover.enabled, disabled: locked }), x_mm: n(cfg.cover.x_mm), y_mm: n(cfg.cover.y_mm),
      w_mm: n(cfg.cover.w_mm), h_mm: n(cfg.cover.h_mm), radius_mm: n(cfg.cover.radius_mm), color: el('input', { type: 'color', value: cfg.cover.color, disabled: locked }) },
    number: { enabled: el('input', { type: 'checkbox', checked: cfg.number.enabled, disabled: locked }), x_mm: n(cfg.number.x_mm), y_mm: n(cfg.number.y_mm),
      w_mm: n(cfg.number.w_mm), h_mm: n(cfg.number.h_mm), font_pt: n(cfg.number.font_pt, 0.5), color: el('input', { type: 'color', value: cfg.number.color, disabled: locked }),
      label: el('input', { value: cfg.number.label || '', maxlength: 12, placeholder: 'Texto antes del número (ej. N° )', disabled: locked }),
      bg_on: el('input', { type: 'checkbox', checked: Boolean(cfg.number.background), disabled: locked }),
      background: el('input', { type: 'color', value: cfg.number.background || '#FFFFFF', disabled: locked }) },
  };
  const field = (label, input) => el('div', {}, el('label', { text: label }), input);
  const preview = el('div');
  const report = el('div');
  const detectMsg = el('div');

  function readForm() {
    const num = (x) => Number(x.value);
    cfg = {
      qr: { x_mm: num(F.qr.x_mm), y_mm: num(F.qr.y_mm), size_mm: num(F.qr.size_mm), margin_modules: num(F.qr.margin_modules), ecc: F.qr.ecc.value, dark: F.qr.dark.value.toUpperCase(), light: F.qr.light.value.toUpperCase() },
      cover: { enabled: F.cover.enabled.checked, x_mm: num(F.cover.x_mm), y_mm: num(F.cover.y_mm), w_mm: num(F.cover.w_mm), h_mm: num(F.cover.h_mm), radius_mm: num(F.cover.radius_mm), color: F.cover.color.value.toUpperCase() },
      number: { enabled: F.number.enabled.checked, x_mm: num(F.number.x_mm), y_mm: num(F.number.y_mm), w_mm: num(F.number.w_mm), h_mm: num(F.number.h_mm), font_pt: num(F.number.font_pt), color: F.number.color.value.toUpperCase(), label: F.number.label.value, background: F.number.bg_on.checked ? F.number.background.value.toUpperCase() : null },
    };
    draw();
  }
  function writeForm() {
    const r = (x) => Math.round(x * 100) / 100;
    for (const k of ['x_mm', 'y_mm', 'size_mm', 'margin_modules']) F.qr[k].value = r(cfg.qr[k]);
    F.qr.ecc.value = cfg.qr.ecc; F.qr.dark.value = cfg.qr.dark; F.qr.light.value = cfg.qr.light;
    for (const k of ['x_mm', 'y_mm', 'w_mm', 'h_mm', 'radius_mm']) F.cover[k].value = r(cfg.cover[k]);
    F.cover.enabled.checked = cfg.cover.enabled; F.cover.color.value = cfg.cover.color;
    for (const k of ['x_mm', 'y_mm', 'w_mm', 'h_mm', 'font_pt']) F.number[k].value = r(cfg.number[k]);
    F.number.enabled.checked = cfg.number.enabled; F.number.color.value = cfg.number.color; F.number.label.value = cfg.number.label || '';
    F.number.bg_on.checked = Boolean(cfg.number.background); if (cfg.number.background) F.number.background.value = cfg.number.background;
    draw();
  }
  for (const group of Object.values(F)) for (const input of Object.values(group)) { input.addEventListener('input', readForm); input.addEventListener('change', readForm); }

  function draw() {
    const k = stage.clientWidth / W; // px por mm
    const place = (b, x, y, w, h, show = true) => {
      b.classList.toggle('hidden', !show);
      b.style.left = `${x * k}px`; b.style.top = `${y * k}px`; b.style.width = `${w * k}px`; b.style.height = `${h * k}px`;
    };
    place(boxes.qr, cfg.qr.x_mm, cfg.qr.y_mm, cfg.qr.size_mm, cfg.qr.size_mm);
    place(boxes.cover, cfg.cover.x_mm, cfg.cover.y_mm, cfg.cover.w_mm, cfg.cover.h_mm, cfg.cover.enabled);
    place(boxes.number, cfg.number.x_mm, cfg.number.y_mm, cfg.number.w_mm, cfg.number.h_mm, cfg.number.enabled);
  }

  // Arrastrar y redimensionar
  if (!locked) {
    for (const [key, box] of Object.entries(boxes)) {
      box.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        const resize = ev.target.classList.contains('handle');
        const k = stage.clientWidth / W;
        const c = cfg[key];
        const start = { px: ev.clientX, py: ev.clientY, x: c.x_mm, y: c.y_mm, w: key === 'qr' ? c.size_mm : c.w_mm, h: key === 'qr' ? c.size_mm : c.h_mm };
        box.setPointerCapture(ev.pointerId);
        const move = (e) => {
          const dx = (e.clientX - start.px) / k; const dy = (e.clientY - start.py) / k;
          if (resize) {
            if (key === 'qr') c.size_mm = Math.max(8, Math.min(start.w + Math.max(dx, dy), W - c.x_mm, H - c.y_mm));
            else { c.w_mm = Math.max(1, Math.min(start.w + dx, W - c.x_mm)); c.h_mm = Math.max(1, Math.min(start.h + dy, H - c.y_mm)); }
          } else {
            c.x_mm = Math.max(0, Math.min(start.x + dx, W - start.w));
            c.y_mm = Math.max(0, Math.min(start.y + dy, H - start.h));
          }
          writeForm();
        };
        const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); };
        box.addEventListener('pointermove', move); box.addEventListener('pointerup', up);
      });
    }
  }
  window.addEventListener('resize', draw);
  img.addEventListener('load', draw);

  async function showPreview() {
    const res = await api('POST', `/api/design-versions/${vid}/preview`, { config: cfg, serial: 1, max_width: 700 }, { raw: true });
    fill(preview, el('img', { src: URL.createObjectURL(await res.blob()), alt: 'Vista previa', class: 'sheet-preview' }));
  }
  async function save() {
    v = await api('PUT', `/api/design-versions/${vid}/config`, { config: cfg });
    toast('Plantilla guardada');
  }
  const profileSel = el('select', { disabled: locked }, profiles.map((p) => el('option', { value: p.id, text: p.name })));

  put(main, 
    el('h1', { text: `Plantilla: ${v.design_name} — versión ${v.version}` }),
    locked ? el('div', { class: 'msg warn' }, 'Esta versión ya se usó en un lote y está bloqueada (así las unidades se re-exportan siempre iguales). ',
      el('button', { class: 'small', type: 'button', text: 'Crear una versión editable', onclick: (e) => guard(async () => {
        const fd = new FormData(); fd.append('from_version_id', vid);
        const nv = await api('POST', `/api/designs/${v.design_id}/versions`, fd, { form: true });
        location.href = `/admin/editor.html?version=${nv.id}`;
      }, e.target) })) : null,
    el('p', { class: 'muted' }, `Plástico ${W} × ${H} mm · imagen ${v.image_width_px} × ${v.image_height_px} px (${v.dpi} ppp). `,
      'Arrastrá los recuadros o escribí las medidas en mm. El parche tapa el QR original (imagen aplanada); el QR nuevo se dibuja encima.'),
    v.notes ? el('div', { class: 'msg warn', text: v.notes }) : null,
    el('div', { class: 'editor' },
      el('div', {}, stage, el('div', { class: 'muted', text: 'Azul: QR nuevo (incluye zona silenciosa) · Naranja: parche · Verde: número' })),
      el('div', {},
        el('div', { class: 'panel' },
          el('div', { class: 'actions' },
            el('button', { type: 'button', text: 'Detectar QR existente', disabled: locked, onclick: (e) => guard(async () => {
              const r = await api('POST', `/api/design-versions/${vid}/detect`, {});
              fill(detectMsg, el('div', { class: `msg ${r.found ? 'ok' : 'warn'}`, text: r.found ? `${r.message} Contenido: ${r.content}` : r.message }));
              if (r.suggested_config) { cfg = { ...r.suggested_config, number: cfg.number }; writeForm(); }
            }, e.target) }),
            profileSel,
            el('button', { type: 'button', text: 'Aplicar perfil', disabled: locked, onclick: (e) => guard(async () => {
              const r = await api('POST', `/api/design-versions/${vid}/profile`, { profile: profileSel.value });
              cfg = r.config; writeForm(); toast('Perfil aplicado (coordenadas estimadas: verificá).', 'warn');
            }, e.target) }),
            el('button', { type: 'button', text: 'Color automático del parche', disabled: locked, onclick: (e) => guard(async () => {
              const r = await api('POST', `/api/design-versions/${vid}/cover-color`, { config: cfg });
              if (r) { cfg.cover.color = r.color; writeForm(); toast(`Color del fondo: ${r.color}`); }
            }, e.target) })),
          detectMsg),
        el('fieldset', {}, el('legend', { text: 'QR nuevo' }),
          el('div', { class: 'row' }, field('X (mm)', F.qr.x_mm), field('Y (mm)', F.qr.y_mm), field('Lado (mm)', F.qr.size_mm)),
          el('div', { class: 'row' }, field('Zona silenciosa (módulos)', F.qr.margin_modules), field('Corrección de errores', F.qr.ecc), field('Color módulos', F.qr.dark), field('Color fondo', F.qr.light))),
        el('fieldset', {}, el('legend', {}, F.cover.enabled, ' Parche sobre el QR original'),
          el('div', { class: 'row' }, field('X', F.cover.x_mm), field('Y', F.cover.y_mm), field('Ancho', F.cover.w_mm), field('Alto', F.cover.h_mm)),
          el('div', { class: 'row' }, field('Radio esquinas', F.cover.radius_mm), field('Color', F.cover.color))),
        el('fieldset', {}, el('legend', {}, F.number.enabled, ' Número dentro del plástico'),
          el('div', { class: 'row' }, field('X', F.number.x_mm), field('Y', F.number.y_mm), field('Ancho', F.number.w_mm), field('Alto', F.number.h_mm)),
          el('div', { class: 'row' }, field('Tamaño (pt)', F.number.font_pt), field('Color', F.number.color), field('Texto previo', F.number.label)),
          el('div', { class: 'row' }, el('label', {}, F.number.bg_on, ' Fondo detrás del número'), F.number.background)),
        el('div', { class: 'actions' },
          el('button', { type: 'button', text: 'Vista previa', onclick: (e) => guard(showPreview, e.target) }),
          locked ? null : el('button', { class: 'primary', type: 'button', text: 'Guardar', onclick: (e) => guard(save, e.target) }),
          el('button', { type: 'button', text: locked ? 'Verificar' : 'Guardar y verificar', onclick: (e) => guard(async () => {
            if (!locked) await save();
            fill(report, el('div', { class: 'muted', text: 'Verificando (genera el diseño y lee el QR)…' }));
            const r = await api('POST', `/api/design-versions/${vid}/verify`, {});
            fill(report, el('div', { class: `msg ${r.ok ? 'ok' : 'error'}`, text: r.ok ? 'Sin errores en la verificación automática.' : 'La verificación encontró errores.' }),
              r.checks.map((c) => el('div', { class: `msg ${c.level}`, text: c.msg })));
            await showPreview();
          }, e.target) })),
        report)),
    el('div', { class: 'panel' }, el('h2', { text: 'Vista previa (con QR de ejemplo y número 001)' }), preview));
  draw();
  await showPreview();
});
