'use strict';
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { HttpError, bad, int, num, str, oneOf } = require('../util');
const auth = require('../services/auth');
const { audit } = require('../services/audit');
const designs = require('../services/designs');
const numbering = require('../services/numbering');
const units = require('../services/units');
const businesses = require('../services/businesses');
const destinations = require('../services/destinations');
const render = require('../services/render');
const { stats } = require('../services/stats');
const backup = require('../services/backup');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sheetParams(q) {
  const b = (v, def) => (v === undefined || v === '' ? def : ['1', 'true', 'on', 'si'].includes(String(v)));
  return {
    paper: oneOf(q.paper, [...Object.keys(render.PAPERS), 'PERSONALIZADO'], { field: 'papel', def: 'A4' }),
    orientation: oneOf(q.orientation, ['vertical', 'horizontal'], { field: 'orientación', def: 'horizontal' }),
    width_mm: num(q.width_mm, { field: 'ancho de hoja', min: 50, max: 2000 }),
    height_mm: num(q.height_mm, { field: 'alto de hoja', min: 50, max: 3000 }),
    margin_mm: num(q.margin_mm, { field: 'margen', min: 0, max: 100, def: 8 }),
    gap_x_mm: num(q.gap_x_mm, { field: 'separación horizontal', min: 0, max: 100, def: 6 }),
    gap_y_mm: num(q.gap_y_mm, { field: 'separación vertical', min: 0, max: 100, def: 6 }),
    label: b(q.label, true),
    label_height_mm: num(q.label_height_mm, { field: 'alto del número', min: 3, max: 40, def: 8 }),
    label_pt: num(q.label_pt, { field: 'tamaño del número', min: 6, max: 48, def: 12 }),
    per_sheet: int(q.per_sheet, { field: 'unidades por hoja', min: 1, max: 500 }),
    crop_marks: b(q.crop_marks, false),
    crop_len_mm: num(q.crop_len_mm, { field: 'largo marca de corte', min: 1, max: 15, def: 4 }),
    crop_offset_mm: num(q.crop_offset_mm, { field: 'distancia marca de corte', min: 0, max: 10, def: 1.5 }),
    footer: b(q.footer, true),
  };
}

function csvCell(v, sep) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita inyección de fórmulas en Excel
  return /["\n\r]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
}

function unitsCsv(rows, sep = ';') {
  const head = ['numero', 'serial', 'url_permanente', 'lote', 'diseno', 'version_diseno', 'estado', 'negocio', 'destino', 'fecha_generacion', 'fecha_entrega', 'reemplaza_a', 'escaneos'];
  const lines = [head.join(sep)];
  for (const u of rows) {
    lines.push([u.display_number, u.serial, u.qr_url, u.batch_code, u.design_name, u.design_version, u.status_label, u.business_name,
      u.destination_label, u.created_at, u.delivered_at, u.replaces_display_number, u.scan_count].map((v) => csvCell(v, sep)).join(sep));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

function apiRoutes(db, config) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 1 } });
  const limiter = new auth.LoginLimiter();
  const versionCache = new Map();
  const version = (id) => {
    if (!versionCache.has(id) || !versionCache.get(id).locked) versionCache.set(id, designs.getVersion(db, id));
    return versionCache.get(id);
  };
  const itemFor = (u) => ({ unit: u, version: version(u.design_version_id), numberInDesign: Boolean(u.number_in_design) });

  // ---------- Sesión ----------
  r.post('/login', express.json({ limit: '10kb' }), wrap(async (req, res) => {
    const { username, password } = req.body || {};
    limiter.check(req.ip, username);
    const s = auth.login(db, config, username, password);
    if (!s) {
      limiter.fail(req.ip, username);
      audit(db, { ip: req.ip, username: String(username || '').slice(0, 40) }, 'login.fallido');
      throw new HttpError(401, 'Usuario o contraseña incorrectos');
    }
    limiter.success(req.ip, username);
    audit(db, { ...s.admin, ip: req.ip }, 'login.ok');
    res.set('Set-Cookie', auth.sessionCookie(config, s.token, s.expires)).json({ ok: true });
  }));

  r.use(auth.requireApiAuth);
  r.use(express.json({ limit: '1mb' }));

  r.post('/logout', (req, res) => {
    auth.logout(db, req.sessionToken);
    audit(db, req.admin, 'logout');
    res.set('Set-Cookie', auth.sessionCookie(config, '', null)).json({ ok: true });
  });

  r.get('/session', (req, res) => {
    res.json({
      admin: { id: req.admin.id, username: req.admin.username },
      csrf: req.session.csrf_token,
      public_base_url: config.publicBaseUrl,
      public_base_url_is_production: config.publicBaseUrlIsProduction,
      max_batch: config.maxBatch,
      statuses: units.STATUSES,
      destination_types: destinations.TYPES,
      papers: render.PAPERS,
    });
  });

  r.get('/dashboard', (req, res) => res.json(units.dashboard(db)));

  // ---------- Diseños ----------
  r.get('/designs', (req, res) => res.json(designs.listDesigns(db)));
  r.get('/profiles', (req, res) => res.json(Object.entries(designs.PROFILES).map(([id, p]) => ({ id, name: p.name }))));

  r.post('/designs', upload.single('file'), wrap(async (req, res) => {
    const b = req.body || {};
    const out = await designs.uploadDesign(db, config, req.admin, {
      name: b.name, description: b.description, buffer: req.file?.buffer, originalName: req.file?.originalname,
      width_mm: b.width_mm, height_mm: b.height_mm, profile: b.profile,
    });
    res.status(201).json(out);
  }));

  r.patch('/designs/:id', wrap(async (req, res) => {
    designs.updateDesign(db, req.admin, int(req.params.id, { field: 'id', min: 1 }), req.body || {});
    res.json({ ok: true });
  }));

  r.post('/designs/:id/versions', upload.single('file'), wrap(async (req, res) => {
    const v = await designs.newVersion(db, config, req.admin, int(req.params.id, { field: 'id', min: 1 }), {
      fromVersionId: int(req.body?.from_version_id, { field: 'versión origen', min: 1, required: true }),
      buffer: req.file?.buffer, originalName: req.file?.originalname,
    });
    res.status(201).json(v);
  }));

  r.get('/design-versions/:id', (req, res) => {
    const v = designs.getVersion(db, int(req.params.id, { field: 'id', min: 1 }));
    res.json({ ...v, number_status: render.numberAreaStatus(v) });
  });

  r.get('/design-versions/:id/image', (req, res) => {
    const v = designs.getVersion(db, int(req.params.id, { field: 'id', min: 1 }));
    res.type(v.image_format === 'jpeg' ? 'jpeg' : 'png').set('Cache-Control', 'private, max-age=3600')
      .send(render.readDesignImage(config.uploadsDir, v));
  });

  r.put('/design-versions/:id/config', (req, res) => {
    const v = designs.updateVersionConfig(db, req.admin, int(req.params.id, { field: 'id', min: 1 }), req.body?.config);
    versionCache.delete(v.id);
    res.json({ ...v, number_status: render.numberAreaStatus(v) });
  });

  r.post('/design-versions/:id/detect', wrap(async (req, res) => {
    const v = designs.getVersion(db, int(req.params.id, { field: 'id', min: 1 }));
    const det = await designs.detectExistingQr(config, v);
    res.json({ ...det, suggested_config: det.found ? designs.validateConfig(designs.configFromDetection(det, v.width_mm, v.height_mm), v) : null });
  }));

  r.post('/design-versions/:id/profile', (req, res) => {
    const v = designs.getVersion(db, int(req.params.id, { field: 'id', min: 1 }));
    const p = designs.PROFILES[req.body?.profile];
    if (!p) throw bad('Perfil inexistente');
    res.json({ config: designs.validateConfig(designs.scaleProfile(p.config, v.width_mm, v.height_mm), v) });
  });

  r.post('/design-versions/:id/cover-color', wrap(async (req, res) => {
    const v = designs.getVersion(db, int(req.params.id, { field: 'id', min: 1 }));
    const cfg = req.body?.config ? designs.validateConfig(req.body.config, v) : v.config;
    res.json(await designs.suggestCoverColor(config, { ...v, config: cfg }));
  }));

  r.post('/design-versions/:id/verify', wrap(async (req, res) => {
    res.json(await designs.verifyVersion(db, config, int(req.params.id, { field: 'id', min: 1 })));
  }));

  // Vista previa con una configuración (guardada o no) y un número provisorio.
  r.post('/design-versions/:id/preview', wrap(async (req, res) => {
    const v = designs.getVersion(db, int(req.params.id, { field: 'id', min: 1 }));
    const cfg = req.body?.config ? designs.validateConfig(req.body.config, v) : v.config;
    const fmt = numbering.normalizeFormat({ prefix: req.body?.prefix, min_digits: req.body?.min_digits ?? 3 });
    const serial = int(req.body?.serial, { field: 'número', min: 1, max: 1e9, def: 1 });
    const png = await render.unitPng(config.uploadsDir, { ...v, config: cfg }, {
      qr_url: `${config.publicBaseUrl}/q/VISTA-PREVIA`, display_number: numbering.formatNumber(serial, fmt),
    }, { numberInDesign: req.body?.number_in_design !== false, preview: true, maxWidth: int(req.body?.max_width, { field: 'ancho', min: 100, max: 3000, def: 700 }) });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  }));

  // ---------- Lotes ----------
  function batchInput(b) {
    const dv = int(b.design_version_id, { field: 'diseño', min: 1, required: true });
    const v = designs.getVersion(db, dv);
    return {
      v,
      designVersionId: dv,
      quantity: int(b.quantity, { field: 'cantidad', min: 1, max: config.maxBatch, required: true }),
      format: numbering.normalizeFormat({ prefix: b.prefix, min_digits: b.min_digits ?? 3 }),
      placement: oneOf(b.placement, numbering.PLACEMENTS, { field: 'ubicación del número', def: 'ambos' }),
      notes: str(b.notes, { field: 'notas', max: 1000 }),
    };
  }

  r.post('/batches/preview', (req, res) => {
    const i = batchInput(req.body || {});
    const first = numbering.peekNextSerial(db);
    const last = first + i.quantity - 1;
    const ns = render.numberAreaStatus(i.v, numbering.formatNumber(last, i.format));
    const warnings = [];
    if ((i.placement === 'plastico' || i.placement === 'ambos') && !ns.fits) {
      warnings.push(`El número no entra dentro del plástico (${ns.reasons.join(' ')}). El producto físico NO tendrá el número visible; se imprimirá debajo de cada diseño en la plancha.`);
    }
    if (!config.publicBaseUrlIsProduction) warnings.push(`El dominio configurado (${config.publicBaseUrl}) no es público HTTPS: estos QR solo sirven para pruebas y quedarán así para siempre.`);
    res.json({
      code: numbering.peekBatchCode(db, new Date().getFullYear()),
      quantity: i.quantity, first_serial: first, last_serial: last,
      first_display: numbering.formatNumber(first, i.format), last_display: numbering.formatNumber(last, i.format),
      number_fits: ns.fits, warnings, public_base_url: config.publicBaseUrl,
      note: 'El rango es provisorio hasta confirmar: si otro lote se genera antes, se usarán los números siguientes.',
    });
  });

  r.post('/batches', (req, res) => {
    const b = req.body || {};
    if (b.confirm !== true) throw bad('Falta la confirmación');
    if (!config.publicBaseUrlIsProduction && b.confirm_test_domain !== true) {
      throw bad(`El dominio ${config.publicBaseUrl} no es público: confirmá que se trata de un lote de prueba.`);
    }
    const i = batchInput(b);
    const ns = render.numberAreaStatus(i.v, '0000000');
    const batch = numbering.createBatch(db, config, req.admin, { ...i, numberFits: ns.fits });
    res.status(201).json(batch);
  });

  r.get('/batches', (req, res) => {
    const rows = db.prepare('SELECT id FROM batches ORDER BY id DESC LIMIT 500').all();
    res.json(rows.map((x) => numbering.getBatch(db, x.id)));
  });

  r.get('/batches/:id', (req, res) => {
    const b = numbering.getBatch(db, int(req.params.id, { field: 'id', min: 1 }));
    if (!b) throw new HttpError(404, 'Lote inexistente');
    const counts = db.prepare('SELECT status, COUNT(*) AS n FROM units WHERE batch_id = ? GROUP BY status').all(b.id);
    res.json({ ...b, status_counts: counts });
  });

  // ---------- Unidades ----------
  r.get('/units', (req, res) => res.json(units.searchUnits(db, req.query)));
  r.get('/units/:id', (req, res) => {
    const id = int(req.params.id, { field: 'id', min: 1 });
    const u = units.getUnit(db, id);
    const replacedBy = db.prepare('SELECT id, display_number FROM units WHERE replaces_unit_id = ?').all(id);
    res.json({ ...u, history: units.unitHistoryList(db, id), replaced_by: replacedBy });
  });
  r.post('/units/:id/status', (req, res) => res.json(units.setStatus(db, req.admin, int(req.params.id, { field: 'id', min: 1 }), req.body?.status, req.body?.note)));
  r.post('/units/:id/destination', (req, res) => res.json(units.setDestination(db, config, req.admin, int(req.params.id, { field: 'id', min: 1 }), req.body?.destination, req.body?.note)));
  r.post('/units/:id/unassign', (req, res) => res.json(units.unassign(db, req.admin, int(req.params.id, { field: 'id', min: 1 }), req.body?.note)));
  r.post('/units/:id/delivered', (req, res) => res.json(units.setDelivered(db, req.admin, int(req.params.id, { field: 'id', min: 1 }), req.body?.date)));
  r.post('/units/:id/replace', (req, res) => {
    const id = int(req.params.id, { field: 'id', min: 1 });
    const u = units.getUnit(db, id);
    const repl = req.body?.replacement_number ? units.parseSerial(req.body.replacement_number) : null;
    if (req.body?.replacement_number && repl == null) throw bad('Número de reemplazo inválido');
    const ns = render.numberAreaStatus(version(u.design_version_id), '0000000');
    res.json(units.replaceDefective(db, config, req.admin, id, { replacementSerial: repl, note: req.body?.note, numberFits: ns.fits }));
  });
  r.post('/destinations/test', wrap(async (req, res) => {
    const d = destinations.buildDestination(req.body?.destination, config);
    if (d.destination_type === 'pagina') {
      const links = JSON.parse(d.destination_config).links;
      const results = [];
      for (const l of links) results.push({ text: l.text, ...(await destinations.testDestination(l.url, config)) });
      return res.json({ ok: results.every((x) => x.ok), url: null, results, message: results.map((x) => `${x.text}: ${x.message}`).join(' · ') });
    }
    res.json({ url: d.destination_url, ...(await destinations.testDestination(d.destination_url, config)) });
  }));

  // ---------- Negocios ----------
  r.get('/businesses', (req, res) => res.json(businesses.listBusinesses(db, req.query)));
  r.post('/businesses', (req, res) => res.status(201).json(businesses.createBusiness(db, req.admin, req.body || {})));
  r.get('/businesses/:id', (req, res) => {
    const id = int(req.params.id, { field: 'id', min: 1 });
    res.json({
      ...businesses.getBusiness(db, id),
      units: units.searchUnits(db, { business_id: id, limit: 1000, order: 'asc' }).rows,
      history: businesses.businessHistory(db, id),
    });
  });
  r.put('/businesses/:id', (req, res) => res.json(businesses.updateBusiness(db, req.admin, int(req.params.id, { field: 'id', min: 1 }), req.body || {})));
  r.post('/businesses/:id/assign', (req, res) => {
    const serials = units.parseSerialList(req.body?.numbers);
    const done = units.assignToBusiness(db, req.admin, {
      serials, businessId: req.params.id, deliveredAt: req.body?.delivered_at || null, setStatusTo: req.body?.status || null,
    });
    res.json({ assigned: done });
  });

  // ---------- Exportaciones ----------
  const unitForExport = (id) => units.getUnit(db, int(id, { field: 'id', min: 1 }));

  r.get('/units/:id/export.:fmt', wrap(async (req, res) => {
    const u = unitForExport(req.params.id);
    const it = itemFor(u);
    const base = `${safeName(u.display_number)}_${safeName(u.batch_code)}`;
    const dl = req.query.download === '1';
    if (req.params.fmt === 'png') {
      const maxWidth = int(req.query.max_width, { field: 'ancho', min: 100, max: 5000 });
      const png = await render.unitPng(config.uploadsDir, it.version, u, { numberInDesign: it.numberInDesign, maxWidth });
      if (dl) res.attachment(`${base}.png`);
      return res.type('png').send(png);
    }
    if (req.params.fmt === 'pdf') {
      const pdf = await render.unitPdf(config.uploadsDir, it.version, u, { numberInDesign: it.numberInDesign });
      if (dl) res.attachment(`${base}.pdf`);
      return res.type('pdf').send(pdf);
    }
    if (req.params.fmt === 'svg') {
      const svg = render.unitSvg(config.uploadsDir, it.version, u, { numberInDesign: it.numberInDesign });
      if (dl) res.attachment(`${base}.svg`);
      return res.type('image/svg+xml').send(svg);
    }
    throw bad('Formato inválido');
  }));

  function selectionUnits(q) {
    if (q.batch_id) {
      const batchId = int(q.batch_id, { field: 'lote', min: 1 });
      const out = [];
      for (let off = 0; ; off += 1000) {
        const page = units.searchUnits(db, { batch_id: batchId, limit: 1000, offset: off, order: 'asc' }).rows;
        out.push(...page);
        if (page.length < 1000) break;
      }
      if (!out.length) throw bad('El lote no existe o no tiene unidades');
      return out;
    }
    if (q.numbers) {
      const serials = units.parseSerialList(q.numbers);
      const rows = serials.map((s) => db.prepare('SELECT id FROM units WHERE serial = ?').get(s)).filter(Boolean).map((x) => units.getUnit(db, x.id));
      if (rows.length !== serials.length) throw bad('Algunos números indicados no existen');
      return rows;
    }
    throw bad('Indicá un lote o una lista de números');
  }

  r.get('/export/sheet-layout', (req, res) => {
    const list = selectionUnits(req.query);
    if (!list.length) throw bad('No hay unidades');
    const v = version(list[0].design_version_id);
    const params = sheetParams(req.query);
    if (req.query.label === undefined) params.label = list.some((u) => u.number_on_sheet);
    const layout = render.sheetLayout(params, v.width_mm, v.height_mm);
    res.json({ ...layout, total_units: list.length, pages: layout.per_sheet ? Math.ceil(list.length / layout.per_sheet) : 0, numbers: list.map((u) => u.display_number) });
  });

  r.get('/export/sheet.pdf', wrap(async (req, res) => {
    const list = selectionUnits(req.query);
    const params = sheetParams(req.query);
    if (req.query.label === undefined) params.label = list.some((u) => u.number_on_sheet);
    const title = req.query.batch_id ? list[0].batch_code : `Unidades ${list[0].display_number}-${list[list.length - 1].display_number}`;
    let out;
    try { out = await render.sheetPdf(config.uploadsDir, list.map(itemFor), params, { title }); } catch (e) { throw bad(e.message); }
    audit(db, req.admin, 'exportar.plancha', { details: { title, units: list.length, params } });
    if (req.query.download === '1') res.attachment(`plancha_${safeName(title)}.pdf`);
    res.type('pdf').send(out.pdf);
  }));

  r.get('/export/units.csv', (req, res) => {
    const list = req.query.batch_id || req.query.numbers ? selectionUnits(req.query)
      : units.searchUnits(db, { ...req.query, limit: 1000, order: 'asc' }).rows;
    const sep = req.query.sep === ',' ? ',' : ';';
    audit(db, req.admin, 'exportar.csv', { details: { units: list.length } });
    res.attachment('unidades.csv').type('text/csv; charset=utf-8').send(unitsCsv(list, sep));
  });

  r.get('/export/batch.zip', wrap(async (req, res) => {
    const list = selectionUnits(req.query);
    const want = { png: req.query.png !== '0', pdf: req.query.pdf !== '0', svg: req.query.svg === '1', sheet: req.query.sheet !== '0' };
    const title = req.query.batch_id ? list[0].batch_code : 'seleccion';
    let sheet = null;
    if (want.sheet) {
      const params = sheetParams(req.query);
      if (req.query.label === undefined) params.label = list.some((u) => u.number_on_sheet);
      try { sheet = await render.sheetPdf(config.uploadsDir, list.map(itemFor), params, { title }); } catch (e) { throw bad(`Plancha: ${e.message}`); }
    }
    audit(db, req.admin, 'exportar.zip', { details: { title, units: list.length, want } });
    res.attachment(`${safeName(title)}.zip`).type('zip');
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', (e) => res.destroy(e));
    zip.pipe(res);
    zip.append(unitsCsv(list), { name: `${safeName(title)}.csv` });
    zip.append([
      `Lote/selección: ${title}`, `Unidades: ${list.length} (${list[0].display_number} a ${list[list.length - 1].display_number})`,
      `Cada diseño mide ${version(list[0].design_version_id).width_mm} × ${version(list[0].design_version_id).height_mm} mm.`,
      'Imprimí los PDF al 100 % (tamaño real). No uses "Ajustar a la página".',
      'Cada archivo lleva en el nombre su número, que coincide con el QR que contiene.',
    ].join('\r\n'), { name: 'LEEME.txt' });
    if (sheet) zip.append(sheet.pdf, { name: `plancha_${safeName(title)}.pdf` });
    for (const u of list) {
      const it = itemFor(u);
      const base = `${safeName(u.display_number)}_${safeName(u.batch_code)}`;
      if (want.png) zip.append(await render.unitPng(config.uploadsDir, it.version, u, { numberInDesign: it.numberInDesign }), { name: `png/${base}.png` });
      if (want.pdf) zip.append(await render.unitPdf(config.uploadsDir, it.version, u, { numberInDesign: it.numberInDesign }), { name: `pdf/${base}.pdf` });
      if (want.svg) zip.append(render.unitSvg(config.uploadsDir, it.version, u, { numberInDesign: it.numberInDesign }), { name: `svg/${base}.svg` });
    }
    await zip.finalize();
  }));

  // ---------- Estadísticas, auditoría, copias ----------
  r.get('/stats', (req, res) => res.json(stats(db, req.query)));
  r.get('/audit', (req, res) => {
    const limit = int(req.query.limit, { field: 'limit', min: 1, max: 1000, def: 200 });
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit));
  });
  r.get('/backups', (req, res) => res.json(backup.listBackups(config)));
  r.post('/backups', (req, res) => {
    const b = backup.createBackup(db, config, 'manual');
    audit(db, req.admin, 'backup.crear', { details: { name: b.name } });
    res.status(201).json({ name: b.name });
  });

  r.use((req, res) => res.status(404).json({ error: 'Ruta inexistente' }));
  return r;
}

module.exports = { apiRoutes, unitsCsv, sheetParams };
