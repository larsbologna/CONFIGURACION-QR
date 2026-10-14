'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const jsQR = require('jsqr');
const { tx, nowIso } = require('../db');
const { bad, notFound, conflict, sha256, str, num, int, oneOf, color } = require('../util');
const { audit } = require('./audit');
const render = require('./render');

const ASPECT_TOLERANCE = 0.01; // 1 %

/**
 * Perfiles de plantilla. Las coordenadas están en mm sobre un plástico de
 * 100 × 150 mm. El perfil "resena-google-10x15" se midió sobre la imagen del
 * diseño enviada por el cliente (vista en la conversación, 2:3): son
 * ESTIMACIONES que se deben confirmar con "Detectar QR" y "Verificar".
 */
const PROFILES = {
  'resena-google-10x15': {
    name: 'Reseña Google 10×15 (QR central en tarjeta blanca, número abajo)',
    config: {
      qr: { x_mm: 28.1, y_mm: 75.7, size_mm: 44, margin_modules: 2, ecc: 'M', dark: '#000000', light: '#FFFFFF' },
      cover: { enabled: true, x_mm: 29.0, y_mm: 76.6, w_mm: 42.1, h_mm: 42.2, color: '#FFFFFF', radius_mm: 0 },
      number: { enabled: true, x_mm: 35, y_mm: 133, w_mm: 30, h_mm: 7, font_pt: 14, color: '#3C4043', label: '', background: null },
    },
  },
};

function versionRow(db, id) {
  const v = db.prepare(`SELECT v.*, d.name AS design_name FROM design_versions v JOIN designs d ON d.id = v.design_id WHERE v.id = ?`).get(id);
  if (!v) return null;
  v.config = JSON.parse(v.config_json);
  delete v.config_json;
  v.dpi = Math.round(render.dpiOf(v));
  v.units_count = db.prepare('SELECT COUNT(*) AS n FROM units WHERE design_version_id = ?').get(id).n;
  return v;
}

function getVersion(db, id) {
  const v = versionRow(db, id);
  if (!v) throw notFound('Versión de diseño inexistente');
  return v;
}

function listDesigns(db) {
  const designs = db.prepare('SELECT * FROM designs ORDER BY archived, id DESC').all();
  const versions = db.prepare(`SELECT v.id, v.design_id, v.version, v.locked, v.created_at, v.width_mm, v.height_mm,
      v.image_width_px, v.image_height_px, v.notes,
      (SELECT COUNT(*) FROM units u WHERE u.design_version_id = v.id) AS units_count
    FROM design_versions v ORDER BY v.design_id, v.version DESC`).all();
  for (const d of designs) d.versions = versions.filter((v) => v.design_id === d.id);
  return designs;
}

/** Valida y normaliza una configuración de plantilla contra el tamaño físico. */
function validateConfig(raw, { width_mm, height_mm }) {
  if (!raw || typeof raw !== 'object') throw bad('Configuración inválida');
  const W = width_mm; const H = height_mm;
  const q = raw.qr || {}; const c = raw.cover || {}; const n = raw.number || {};
  const cfg = {
    qr: {
      x_mm: num(q.x_mm, { field: 'qr.x_mm', min: 0, max: W, required: true }),
      y_mm: num(q.y_mm, { field: 'qr.y_mm', min: 0, max: H, required: true }),
      size_mm: num(q.size_mm, { field: 'qr.size_mm', min: 8, max: Math.min(W, H), required: true }),
      margin_modules: int(q.margin_modules, { field: 'qr.margin_modules', min: 0, max: 6, def: 2 }),
      ecc: oneOf(q.ecc, ['L', 'M', 'Q', 'H'], { field: 'qr.ecc', def: 'M' }),
      dark: color(q.dark, { field: 'qr.dark', def: '#000000' }),
      light: color(q.light, { field: 'qr.light', def: '#FFFFFF' }),
    },
    cover: {
      enabled: Boolean(c.enabled),
      x_mm: num(c.x_mm, { field: 'cover.x_mm', min: 0, max: W, def: 0 }),
      y_mm: num(c.y_mm, { field: 'cover.y_mm', min: 0, max: H, def: 0 }),
      w_mm: num(c.w_mm, { field: 'cover.w_mm', min: 0, max: W, def: 0 }),
      h_mm: num(c.h_mm, { field: 'cover.h_mm', min: 0, max: H, def: 0 }),
      color: color(c.color, { field: 'cover.color', def: '#FFFFFF' }),
      radius_mm: num(c.radius_mm, { field: 'cover.radius_mm', min: 0, max: 20, def: 0 }),
    },
    number: {
      enabled: Boolean(n.enabled),
      x_mm: num(n.x_mm, { field: 'number.x_mm', min: 0, max: W, def: 0 }),
      y_mm: num(n.y_mm, { field: 'number.y_mm', min: 0, max: H, def: 0 }),
      w_mm: num(n.w_mm, { field: 'number.w_mm', min: 0, max: W, def: 0 }),
      h_mm: num(n.h_mm, { field: 'number.h_mm', min: 0, max: H, def: 0 }),
      font_pt: num(n.font_pt, { field: 'number.font_pt', min: 5, max: 72, def: 14 }),
      color: color(n.color, { field: 'number.color', def: '#222222' }),
      label: str(n.label, { field: 'number.label', max: 12, trim: false }) || '',
      background: n.background ? color(n.background, { field: 'number.background' }) : null,
    },
  };
  if (cfg.qr.x_mm + cfg.qr.size_mm > W + 1e-6 || cfg.qr.y_mm + cfg.qr.size_mm > H + 1e-6) throw bad('El QR sale de los límites del plástico');
  if (cfg.cover.enabled && (cfg.cover.x_mm + cfg.cover.w_mm > W + 1e-6 || cfg.cover.y_mm + cfg.cover.h_mm > H + 1e-6)) throw bad('El área de cobertura sale de los límites del plástico');
  if (cfg.qr.dark === cfg.qr.light) throw bad('Los colores del QR no tienen contraste');
  return cfg;
}

/** Guarda la imagen (nombre = hash del contenido: nunca se sobrescribe otro archivo). */
async function storeImage(config, buffer) {
  let meta;
  try { meta = await sharp(buffer).metadata(); } catch { throw bad('El archivo no es una imagen válida'); }
  if (!['png', 'jpeg', 'webp', 'tiff'].includes(meta.format)) throw bad('Formato no soportado. Usá PNG o JPG (idealmente a 300 ppp o más).');
  let work = buffer; let format = meta.format; const notes = [];
  if ((meta.orientation && meta.orientation > 1) || format === 'webp' || format === 'tiff') {
    work = await sharp(buffer).rotate().png().toBuffer();
    format = 'png';
    notes.push('La imagen se convirtió a PNG sin pérdida (orientación/formato) sin modificar su contenido.');
  }
  const m2 = await sharp(work).metadata();
  const hash = sha256(work);
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const file = `${hash}.${ext}`;
  const full = path.join(config.uploadsDir, file);
  if (!fs.existsSync(full)) fs.writeFileSync(full, work, { flag: 'wx' });
  return { file, hash, width: m2.width, height: m2.height, format, notes, hasAlpha: Boolean(m2.hasAlpha) };
}

function checkAspect(img, width_mm, height_mm) {
  const ratioImg = img.width / img.height;
  const ratioMm = width_mm / height_mm;
  const diff = Math.abs(ratioImg - ratioMm) / ratioMm;
  if (diff > ASPECT_TOLERANCE) {
    throw bad(`La proporción de la imagen (${img.width}×${img.height} px) no coincide con ${width_mm}×${height_mm} mm (diferencia ${(diff * 100).toFixed(1)} %). No se deforma el diseño: exportalo con proporción 2:3 exacta (por ejemplo 1181×1772 px a 300 ppp).`);
  }
  return diff;
}

async function uploadDesign(db, config, actor, { name, description, buffer, originalName, width_mm = 100, height_mm = 150, profile }) {
  name = str(name, { field: 'nombre', max: 120, required: true });
  description = str(description, { field: 'descripción', max: 1000 });
  width_mm = num(width_mm, { field: 'ancho_mm', min: 20, max: 1000, def: 100 });
  height_mm = num(height_mm, { field: 'alto_mm', min: 20, max: 1000, def: 150 });
  if (!buffer || !buffer.length) throw bad('Falta el archivo de imagen');
  const img = await storeImage(config, buffer);
  const diff = checkAspect(img, width_mm, height_mm);
  const fakeVersion = { image_file: img.file, image_sha256: img.hash, image_width_px: img.width, image_height_px: img.height, width_mm, height_mm };
  const detection = await detectExistingQr(config, fakeVersion);
  let cfg;
  if (profile && PROFILES[profile]) cfg = scaleProfile(PROFILES[profile].config, width_mm, height_mm);
  else if (detection.found) cfg = configFromDetection(detection, width_mm, height_mm);
  else cfg = render.DEFAULT_CONFIG;
  cfg = validateConfig(cfg, { width_mm, height_mm });
  const notes = [...img.notes];
  notes.push('Imagen aplanada (sin capas): el QR original se tapa con un parche del color de fondo y el QR nuevo se dibuja encima. Confirmá el resultado con "Verificar".');
  if (diff > 0) notes.push(`Diferencia de proporción ${(diff * 100).toFixed(2)} % (dentro de la tolerancia del 1 %).`);
  const id = tx(db, () => {
    const designId = Number(db.prepare('INSERT INTO designs(name, description, created_at) VALUES (?, ?, ?)').run(name, description, nowIso()).lastInsertRowid);
    const vId = Number(db.prepare(`INSERT INTO design_versions(design_id, version, image_file, image_sha256, image_original_name,
      image_width_px, image_height_px, image_format, width_mm, height_mm, config_json, notes, created_at, created_by)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(designId, img.file, img.hash, str(originalName, { field: 'archivo', max: 255 }),
      img.width, img.height, img.format, width_mm, height_mm, JSON.stringify(cfg), notes.join('\n'), nowIso(), actor?.id ?? null).lastInsertRowid);
    audit(db, actor, 'diseno.subir', { entityType: 'design_version', entityId: vId, details: { name, file: img.file, w: img.width, h: img.height } });
    return vId;
  });
  return { version: getVersion(db, id), detection, notes };
}

function scaleProfile(cfg, W, H) {
  const sx = W / 100; const sy = H / 150;
  const out = JSON.parse(JSON.stringify(cfg));
  for (const k of ['qr', 'cover', 'number']) {
    const o = out[k];
    if ('x_mm' in o) o.x_mm *= sx;
    if ('y_mm' in o) o.y_mm *= sy;
    if ('w_mm' in o) o.w_mm *= sx;
    if ('h_mm' in o) o.h_mm *= sy;
    if ('size_mm' in o) o.size_mm *= Math.min(sx, sy);
  }
  return out;
}

/** Nueva versión (copia editable) de un diseño, opcionalmente con otra imagen. */
async function newVersion(db, config, actor, designId, { fromVersionId, buffer, originalName }) {
  const from = getVersion(db, fromVersionId);
  if (from.design_id !== designId) throw bad('La versión no pertenece a ese diseño');
  let img = { file: from.image_file, hash: from.image_sha256, width: from.image_width_px, height: from.image_height_px, format: from.image_format };
  if (buffer) {
    img = await storeImage(config, buffer);
    checkAspect(img, from.width_mm, from.height_mm);
  }
  const id = tx(db, () => {
    const next = db.prepare('SELECT MAX(version) AS m FROM design_versions WHERE design_id = ?').get(designId).m + 1;
    const vId = Number(db.prepare(`INSERT INTO design_versions(design_id, version, image_file, image_sha256, image_original_name,
      image_width_px, image_height_px, image_format, width_mm, height_mm, config_json, notes, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(designId, next, img.file, img.hash, buffer ? originalName : from.image_original_name,
      img.width, img.height, img.format, from.width_mm, from.height_mm, JSON.stringify(from.config), `Copia de la versión ${from.version}`, nowIso(), actor?.id ?? null).lastInsertRowid);
    audit(db, actor, 'diseno.nueva_version', { entityType: 'design_version', entityId: vId, details: { from: from.id } });
    return vId;
  });
  return getVersion(db, id);
}

function updateVersionConfig(db, actor, versionId, rawConfig) {
  const v = getVersion(db, versionId);
  if (v.locked) throw conflict('Esta versión ya se usó en un lote y está bloqueada. Creá una nueva versión para modificarla.');
  const cfg = validateConfig(rawConfig, v);
  db.prepare('UPDATE design_versions SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), versionId);
  audit(db, actor, 'diseno.editar_plantilla', { entityType: 'design_version', entityId: versionId });
  return getVersion(db, versionId);
}

function updateDesign(db, actor, designId, { name, description, archived }) {
  const d = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId);
  if (!d) throw notFound('Diseño inexistente');
  db.prepare('UPDATE designs SET name = ?, description = ?, archived = ? WHERE id = ?').run(
    str(name, { field: 'nombre', max: 120 }) || d.name,
    description === undefined ? d.description : str(description, { field: 'descripción', max: 1000 }),
    archived === undefined ? d.archived : (archived ? 1 : 0), designId);
  audit(db, actor, 'diseno.actualizar', { entityType: 'design', entityId: designId });
}

// ---------- Análisis de imagen ----------
async function rgba(buffer, maxWidth) {
  let s = sharp(buffer);
  const meta = await s.metadata();
  if (maxWidth && meta.width > maxWidth) s = s.resize({ width: maxWidth });
  const { data, info } = await s.flatten({ background: '#FFFFFF' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

async function decodeQr(buffer, maxWidth = 1000) {
  for (const w of [maxWidth, 600, 1600]) {
    const img = await rgba(buffer, w);
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    if (r) return { text: r.data, location: r.location, version: r.version, width: img.width, height: img.height };
  }
  return null;
}

/** Busca un QR legible en la imagen original y devuelve su posición en mm. */
async function detectExistingQr(config, version) {
  const buffer = render.readDesignImage(config.uploadsDir, version);
  const r = await decodeQr(buffer);
  if (!r) {
    return { found: false, message: 'No se encontró un QR legible en el diseño. Puede ser decorativo o estar dañado: ubicá el área manualmente en el editor.' };
  }
  const k = version.width_mm / r.width;
  const pts = ['topLeftCorner', 'topRightCorner', 'bottomLeftCorner', 'bottomRightCorner'].map((p) => r.location[p]);
  const xs = pts.map((p) => p.x * k); const ys = pts.map((p) => p.y * (version.height_mm / r.height));
  const box = { x_mm: Math.min(...xs), y_mm: Math.min(...ys), w_mm: Math.max(...xs) - Math.min(...xs), h_mm: Math.max(...ys) - Math.min(...ys) };
  const modules = 17 + 4 * r.version;
  return { found: true, content: r.text, qr_version: r.version, module_mm: box.w_mm / modules, box, message: 'Se detectó el QR existente en el diseño.' };
}

function configFromDetection(det, W, H) {
  const pad = det.module_mm * 1.5;
  const b = det.box;
  const size = Math.max(b.w_mm, b.h_mm) + 4 * det.module_mm; // incluye 2 módulos de zona silenciosa por lado
  const cx = b.x_mm + b.w_mm / 2; const cy = b.y_mm + b.h_mm / 2;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  return {
    qr: { x_mm: clamp(cx - size / 2, 0, W - size), y_mm: clamp(cy - size / 2, 0, H - size), size_mm: size, margin_modules: 2, ecc: 'M' },
    cover: { enabled: true, x_mm: clamp(b.x_mm - pad, 0, W), y_mm: clamp(b.y_mm - pad, 0, H), w_mm: b.w_mm + 2 * pad, h_mm: b.h_mm + 2 * pad, color: '#FFFFFF' },
    number: { ...render.DEFAULT_CONFIG.number },
  };
}

async function regionStats(buffer, version, box) {
  const kx = version.image_width_px / version.width_mm; const ky = version.image_height_px / version.height_mm;
  const left = Math.max(0, Math.round(box.x * kx)); const top = Math.max(0, Math.round(box.y * ky));
  const width = Math.min(version.image_width_px - left, Math.max(1, Math.round(box.w * kx)));
  const height = Math.min(version.image_height_px - top, Math.max(1, Math.round(box.h * ky)));
  if (width < 1 || height < 1) return null;
  // stats() mide la imagen de ENTRADA: hay que materializar el recorte antes.
  const crop = await sharp(buffer).flatten({ background: '#FFFFFF' }).extract({ left, top, width, height }).png().toBuffer();
  const st = await sharp(crop).stats();
  const ch = st.channels.slice(0, 3);
  return { mean: ch.map((c) => c.mean), stdev: Math.max(...ch.map((c) => c.stdev)) };
}

const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** Color de fondo alrededor del área de cobertura (para el parche). */
async function suggestCoverColor(config, version) {
  const cfg = render.withDefaults(version.config);
  const buffer = render.readDesignImage(config.uploadsDir, version);
  const c = cfg.cover; const t = 1;
  const ring = [
    { x: c.x_mm, y: c.y_mm - t - 0.3, w: c.w_mm, h: t }, { x: c.x_mm, y: c.y_mm + c.h_mm + 0.3, w: c.w_mm, h: t },
    { x: c.x_mm - t - 0.3, y: c.y_mm, w: t, h: c.h_mm }, { x: c.x_mm + c.w_mm + 0.3, y: c.y_mm, w: t, h: c.h_mm },
  ];
  const stats = (await Promise.all(ring.map((b) => regionStats(buffer, version, b)))).filter(Boolean);
  if (!stats.length) return null;
  const mean = [0, 1, 2].map((i) => stats.reduce((a, s) => a + s.mean[i], 0) / stats.length);
  const spread = Math.max(...stats.map((s) => s.stdev), ...[0, 1, 2].map((i) => Math.max(...stats.map((s) => Math.abs(s.mean[i] - mean[i])))));
  return { color: hex(mean), uniformity_stdev: Math.round(spread * 10) / 10 };
}

/**
 * Verificación automática de la plantilla. No afirma que el diseño quedó
 * perfecto: informa lo que pudo comprobar y pide revisión visual.
 */
async function verifyVersion(db, config, versionId) {
  const v = getVersion(db, versionId);
  const cfg = render.withDefaults(v.config);
  const checks = [];
  const add = (level, msg) => checks.push({ level, msg });

  const dpi = render.dpiOf(v);
  if (dpi < 150) add('error', `Resolución muy baja: ${Math.round(dpi)} ppp. Para impresión se recomiendan 300 ppp (${Math.round(v.width_mm / 25.4 * 300)}×${Math.round(v.height_mm / 25.4 * 300)} px).`);
  else if (dpi < 290) add('aviso', `Resolución ${Math.round(dpi)} ppp: aceptable, pero se recomiendan 300 ppp o más.`);
  else add('ok', `Resolución ${Math.round(dpi)} ppp.`);
  add('ok', `Tamaño físico: ${v.width_mm} × ${v.height_mm} mm (la imagen se coloca entera, sin recortes ni deformación).`);

  // 1. El QR nuevo se lee y contiene exactamente la URL esperada.
  const testUrl = `${config.publicBaseUrl}/q/VERIFICACION`;
  const matrix = render.qrMatrix(testUrl, cfg.qr.ecc);
  const moduleMm = cfg.qr.size_mm / (matrix.size + 2 * cfg.qr.margin_modules);
  if (moduleMm < 0.33) add('error', `Módulos del QR de ${moduleMm.toFixed(2)} mm: demasiado chicos para imprimir. Agrandá el QR.`);
  else if (moduleMm < 0.5) add('aviso', `Módulos del QR de ${moduleMm.toFixed(2)} mm: legible, pero conviene un QR más grande.`);
  else add('ok', `Módulos del QR de ${moduleMm.toFixed(2)} mm (QR versión ${matrix.version}, corrección ${cfg.qr.ecc}).`);
  if (cfg.qr.margin_modules < 2) add('aviso', 'Zona silenciosa menor a 2 módulos: algunos lectores pueden fallar.');

  const png = await render.unitPng(config.uploadsDir, v, { qr_url: testUrl, display_number: '000' }, { numberInDesign: cfg.number.enabled });
  const dec = await decodeQr(png);
  if (dec && dec.text === testUrl) add('ok', 'El QR nuevo se decodifica correctamente desde la imagen final.');
  else if (dec) add('error', `Se lee un QR, pero con otro contenido ("${dec.text.slice(0, 80)}"): el QR original sigue visible.`);
  else add('error', 'No se pudo leer el QR nuevo en la imagen final.');

  // 2. El QR original quedó tapado.
  const original = await detectExistingQr(config, v);
  if (original.found) {
    const b = original.box;
    const inside = (r) => b.x_mm >= r.x - 0.2 && b.y_mm >= r.y - 0.2 && b.x_mm + b.w_mm <= r.x + r.w + 0.2 && b.y_mm + b.h_mm <= r.y + r.h + 0.2;
    const qrBox = { x: cfg.qr.x_mm, y: cfg.qr.y_mm, w: cfg.qr.size_mm, h: cfg.qr.size_mm };
    const coverBox = { x: cfg.cover.x_mm, y: cfg.cover.y_mm, w: cfg.cover.w_mm, h: cfg.cover.h_mm };
    if (inside(qrBox) || (cfg.cover.enabled && inside(coverBox))) add('ok', 'El QR original detectado queda completamente cubierto.');
    else add('error', 'El QR original detectado NO queda completamente cubierto por el área de cobertura/QR nuevo.');
  } else {
    add('aviso', 'No se pudo detectar automáticamente el QR original (puede ser decorativo o no legible). Verificá visualmente que el área de cobertura lo tape por completo.');
  }
  // Sin el QR nuevo (solo parche), ¿queda algún QR legible del diseño original?
  const blank = { ...v, config: { ...cfg, qr: { ...cfg.qr, dark: cfg.qr.light } } };
  const blankPng = await render.unitPng(config.uploadsDir, blank, { qr_url: testUrl, display_number: '000' }, { numberInDesign: false });
  const leftover = await decodeQr(blankPng);
  if (leftover) add('error', 'Con el parche aplicado todavía se puede leer el QR original: agrandá el área de cobertura.');
  else add('ok', 'Con el parche aplicado no queda ningún QR antiguo legible.');

  // 3. Parche de cobertura sobre fondo uniforme.
  const buffer = render.readDesignImage(config.uploadsDir, v);
  if (cfg.cover.enabled) {
    const ring = await suggestCoverColor(config, v);
    if (ring) {
      const dist = Math.max(...hexToRgb(cfg.cover.color).map((c, i) => Math.abs(c - hexToRgb(ring.color)[i])));
      if (ring.uniformity_stdev > 18) add('aviso', 'El fondo alrededor del QR no es uniforme: el parche de color podría notarse. Lo ideal es subir el diseño sin el QR original.');
      else if (dist > 14) add('aviso', `El color del parche (${cfg.cover.color}) difiere del fondo circundante (${ring.color}). Usá "Color automático".`);
      else add('ok', `El parche coincide con el fondo circundante (${ring.color}).`);
    }
  }

  // 4. Número dentro del plástico.
  const ns = render.numberAreaStatus(v);
  if (!cfg.number.enabled) add('aviso', 'No hay área para el número dentro del plástico: el número solo irá debajo del diseño en la plancha.');
  else if (!ns.fits) ns.reasons.forEach((r) => add('error', r));
  else {
    const st = await regionStats(buffer, v, { x: cfg.number.x_mm, y: cfg.number.y_mm, w: cfg.number.w_mm, h: cfg.number.h_mm });
    if (st && st.stdev > 12 && !cfg.number.background) add('aviso', 'El área del número contiene elementos del diseño original: el número podría taparlos. Movelo a una zona vacía.');
    else add('ok', `El número entra dentro del plástico (${ns.font_pt} pt) en una zona libre del diseño.`);
  }
  add('aviso', 'Revisá visualmente la vista previa antes de imprimir: la verificación automática no reemplaza una prueba impresa escaneada con un celular.');
  return { ok: !checks.some((c) => c.level === 'error'), checks };
}

module.exports = {
  PROFILES, getVersion, listDesigns, validateConfig, uploadDesign, newVersion, updateVersionConfig, updateDesign,
  detectExistingQr, suggestCoverColor, verifyVersion, decodeQr, scaleProfile, configFromDetection,
};
