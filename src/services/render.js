'use strict';
/**
 * Renderizado de cada unidad (diseño original + QR nuevo + número) y de las
 * planchas de impresión. Todo se dibuja en milímetros con UNA sola rutina de
 * geometría, que luego se emite como SVG (PNG/SVG) o como vectores PDF. Así el
 * PNG, el SVG y el PDF de una unidad son geométricamente idénticos.
 */
const fs = require('node:fs');
const path = require('node:path');
const fontkit = require('fontkit');
const QRCode = require('qrcode');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');

const MM_TO_PT = 72 / 25.4;
const PT_TO_MM = 25.4 / 72;

// ---------- Tipografía (DejaVu Sans Bold, incluida en assets/fonts) ----------
let FONT = null;
function font() {
  if (!FONT) FONT = fontkit.openSync(path.join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf'));
  return FONT;
}

function round(n) { return Math.round(n * 1000) / 1000; }

/** Texto → trazado SVG (en mm), centrado en cx y verticalmente centrado en cy. */
function textPath(text, sizePt, cx, cy) {
  const f = font();
  const sizeMm = sizePt * PT_TO_MM;
  const scale = sizeMm / f.unitsPerEm;
  const run = f.layout(String(text));
  const width = run.advanceWidth * scale;
  const capH = (f.capHeight || f.unitsPerEm * 0.72) * scale;
  let x = cx - width / 2;
  const baseline = cy + capH / 2;
  const parts = [];
  run.glyphs.forEach((g, i) => {
    const pos = run.positions[i];
    const p = g.path.scale(scale, -scale).translate(x + pos.xOffset * scale, baseline - pos.yOffset * scale);
    parts.push(p.toSVG());
    x += pos.xAdvance * scale;
  });
  return { d: parts.join(''), width, height: capH };
}

function textWidth(text, sizePt) {
  const f = font();
  return f.layout(String(text)).advanceWidth * (sizePt * PT_TO_MM / f.unitsPerEm);
}

// ---------- QR ----------
function qrMatrix(text, ecc = 'M') {
  const qr = QRCode.create(text, { errorCorrectionLevel: ecc });
  const size = qr.modules.size;
  const data = qr.modules.data;
  return { size, version: qr.version, dark: (r, c) => data[r * size + c] === 1 };
}

/** Trazado de los módulos oscuros. El cuadrado (x,y,size) incluye la zona silenciosa. */
function qrPath(matrix, x, y, sizeMm, marginModules) {
  const total = matrix.size + 2 * marginModules;
  const m = sizeMm / total;
  const parts = [];
  for (let r = 0; r < matrix.size; r++) {
    let c = 0;
    while (c < matrix.size) {
      if (!matrix.dark(r, c)) { c++; continue; }
      const start = c;
      while (c < matrix.size && matrix.dark(r, c)) c++;
      const px = x + (start + marginModules) * m;
      const py = y + (r + marginModules) * m;
      parts.push(`M${round(px)} ${round(py)}h${round((c - start) * m)}v${round(m)}h${round(-(c - start) * m)}z`);
    }
  }
  return { d: parts.join(''), moduleMm: m };
}

// ---------- Plantilla ----------
const DEFAULT_CONFIG = {
  qr: { x_mm: 30, y_mm: 70, size_mm: 40, margin_modules: 2, ecc: 'M', dark: '#000000', light: '#FFFFFF' },
  cover: { enabled: true, x_mm: 30, y_mm: 70, w_mm: 40, h_mm: 40, color: '#FFFFFF', radius_mm: 0 },
  number: { enabled: false, x_mm: 30, y_mm: 135, w_mm: 40, h_mm: 8, font_pt: 14, color: '#222222', label: '', background: null },
};

function withDefaults(cfg = {}) {
  return {
    qr: { ...DEFAULT_CONFIG.qr, ...(cfg.qr || {}) },
    cover: { ...DEFAULT_CONFIG.cover, ...(cfg.cover || {}) },
    number: { ...DEFAULT_CONFIG.number, ...(cfg.number || {}) },
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** ¿El número entra dentro del plástico sin tapar el QR? Devuelve motivo si no. */
function numberAreaStatus(version, sampleText = '0000') {
  const cfg = withDefaults(version.config);
  const n = cfg.number;
  const reasons = [];
  if (!n.enabled) return { fits: false, reasons: ['La plantilla no tiene definida un área para el número dentro del plástico.'] };
  const box = { x: n.x_mm, y: n.y_mm, w: n.w_mm, h: n.h_mm };
  if (box.w <= 0 || box.h <= 0) reasons.push('El área del número tiene tamaño cero.');
  if (box.x < 0 || box.y < 0 || box.x + box.w > version.width_mm || box.y + box.h > version.height_mm) {
    reasons.push('El área del número sale de los límites del plástico.');
  }
  const qr = { x: cfg.qr.x_mm, y: cfg.qr.y_mm, w: cfg.qr.size_mm, h: cfg.qr.size_mm };
  if (rectsOverlap(box, qr)) reasons.push('El área del número se superpone con el QR.');
  const text = `${n.label || ''}${sampleText}`;
  const fitted = fitFont(text, n.font_pt, box);
  if (fitted < 5) reasons.push('El área del número es demasiado chica para un texto legible (mínimo 5 pt).');
  return { fits: reasons.length === 0, reasons, font_pt: fitted };
}

function fitFont(text, wantedPt, box) {
  let pt = wantedPt;
  const maxByHeight = (box.h * 0.8) / (PT_TO_MM * 0.73);
  pt = Math.min(pt, maxByHeight);
  const w = textWidth(text, pt);
  if (w > box.w * 0.95) pt = pt * (box.w * 0.95) / w;
  return Math.floor(pt * 10) / 10;
}

/**
 * Geometría de una unidad, en mm, relativa a su esquina superior izquierda.
 * unit = { qr_url, display_number }
 */
function unitElements(version, unit, { numberInDesign, preview = false } = {}) {
  const cfg = withDefaults(version.config);
  const els = [];
  if (cfg.cover.enabled) {
    els.push({ type: 'rect', x: cfg.cover.x_mm, y: cfg.cover.y_mm, w: cfg.cover.w_mm, h: cfg.cover.h_mm, r: cfg.cover.radius_mm || 0, fill: cfg.cover.color });
  }
  const matrix = qrMatrix(unit.qr_url, cfg.qr.ecc);
  els.push({ type: 'rect', x: cfg.qr.x_mm, y: cfg.qr.y_mm, w: cfg.qr.size_mm, h: cfg.qr.size_mm, r: 0, fill: cfg.qr.light });
  const qp = qrPath(matrix, cfg.qr.x_mm, cfg.qr.y_mm, cfg.qr.size_mm, cfg.qr.margin_modules);
  els.push({ type: 'path', d: qp.d, fill: cfg.qr.dark, role: 'qr' });

  let numberInfo = null;
  if (numberInDesign) {
    const st = numberAreaStatus(version, unit.display_number);
    if (st.fits) {
      const n = cfg.number;
      if (n.background) els.push({ type: 'rect', x: n.x_mm, y: n.y_mm, w: n.w_mm, h: n.h_mm, r: Math.min(n.h_mm / 4, 2), fill: n.background });
      const text = `${n.label || ''}${unit.display_number}`;
      const pt = fitFont(text, n.font_pt, { w: n.w_mm, h: n.h_mm });
      const tp = textPath(text, pt, n.x_mm + n.w_mm / 2, n.y_mm + n.h_mm / 2);
      els.push({ type: 'path', d: tp.d, fill: n.color, role: 'number' });
      numberInfo = { text, font_pt: pt };
    }
  }
  if (preview) {
    const tp = textPath('VISTA PREVIA - NO IMPRIMIR', 9, version.width_mm / 2, 4);
    els.push({ type: 'path', d: tp.d, fill: '#D00000', role: 'watermark' });
  }
  return { els, matrix, moduleMm: qp.moduleMm, numberInfo };
}

function elementsToSvg(els) {
  return els.map((e) => {
    if (e.type === 'rect') {
      return `<rect x="${round(e.x)}" y="${round(e.y)}" width="${round(e.w)}" height="${round(e.h)}"${e.r ? ` rx="${round(e.r)}"` : ''} fill="${e.fill}"/>`;
    }
    return `<path d="${e.d}" fill="${e.fill}"${e.role === 'qr' ? ' shape-rendering="crispEdges"' : ''}/>`;
  }).join('');
}

// ---------- Imagen base ----------
const imageCache = new Map();
function readDesignImage(uploadsDir, version) {
  const file = path.join(uploadsDir, path.basename(version.image_file));
  const key = `${file}:${version.image_sha256}`;
  if (!imageCache.has(key)) {
    if (imageCache.size > 8) imageCache.clear();
    imageCache.set(key, fs.readFileSync(file));
  }
  return imageCache.get(key);
}

function dpiOf(version) {
  return version.image_width_px / (version.width_mm / 25.4);
}

// ---------- Exportaciones de una unidad ----------
async function unitPng(uploadsDir, version, unit, opts = {}) {
  const base = readDesignImage(uploadsDir, version);
  const { els } = unitElements(version, unit, opts);
  const W = version.image_width_px; const H = version.image_height_px;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${version.width_mm} ${version.height_mm}">${elementsToSvg(els)}</svg>`;
  let img = sharp(base).resize(W, H, { fit: 'fill' }).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  if (opts.maxWidth && opts.maxWidth < W) {
    img = sharp(await img.png().toBuffer()).resize({ width: opts.maxWidth });
  }
  return img.flatten({ background: '#FFFFFF' }).png({ compressionLevel: 6 }).withMetadata({ density: Math.round(dpiOf(version)) }).toBuffer();
}

function unitSvg(uploadsDir, version, unit, opts = {}) {
  const base = readDesignImage(uploadsDir, version);
  const mime = version.image_format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const { els } = unitElements(version, unit, opts);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${version.width_mm}mm" height="${version.height_mm}mm" viewBox="0 0 ${version.width_mm} ${version.height_mm}">
<title>Unidad ${unit.display_number}</title>
<image x="0" y="0" width="${version.width_mm}" height="${version.height_mm}" preserveAspectRatio="none" xlink:href="data:${mime};base64,${base.toString('base64')}"/>
${elementsToSvg(els)}
</svg>
`;
}

/** Dibuja una unidad en un documento PDFKit con su esquina en (xMm, yMm). */
function drawUnitPdf(doc, imgObj, version, unit, xMm, yMm, opts = {}) {
  const { els } = unitElements(version, unit, opts);
  doc.save();
  doc.translate(xMm * MM_TO_PT, yMm * MM_TO_PT);
  doc.scale(MM_TO_PT);
  doc.image(imgObj, 0, 0, { width: version.width_mm, height: version.height_mm });
  for (const e of els) {
    if (e.type === 'rect') {
      if (e.r) doc.roundedRect(e.x, e.y, e.w, e.h, e.r).fill(e.fill);
      else doc.rect(e.x, e.y, e.w, e.h).fill(e.fill);
    } else {
      doc.path(e.d).fill(e.fill);
    }
  }
  doc.restore();
}

function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function unitPdf(uploadsDir, version, unit, opts = {}) {
  const doc = new PDFDocument({
    size: [version.width_mm * MM_TO_PT, version.height_mm * MM_TO_PT], margin: 0, autoFirstPage: true,
    info: { Title: `Unidad ${unit.display_number}`, Creator: 'Sistema de plásticos QR' },
  });
  const done = collect(doc);
  const img = doc.openImage(readDesignImage(uploadsDir, version));
  drawUnitPdf(doc, img, version, unit, 0, 0, opts);
  doc.end();
  return done;
}

// ---------- Planchas ----------
const PAPERS = {
  A4: [210, 297], A3: [297, 420], SRA3: [320, 450], A2: [420, 594],
  CARTA: [215.9, 279.4], OFICIO: [215.9, 355.6], TABLOIDE: [279.4, 431.8],
};

function sheetLayout(params, unitW, unitH) {
  const p = {
    paper: 'A4', orientation: 'horizontal', margin_mm: 8, gap_x_mm: 6, gap_y_mm: 6,
    label: true, label_height_mm: 8, label_pt: 12, per_sheet: null, crop_marks: false,
    crop_len_mm: 4, crop_offset_mm: 1.5, footer: true, ...params,
  };
  const errors = []; const warnings = [];
  let pw; let ph;
  if (p.paper === 'PERSONALIZADO') { pw = Number(p.width_mm); ph = Number(p.height_mm); }
  else if (PAPERS[p.paper]) [pw, ph] = PAPERS[p.paper];
  else errors.push('Tamaño de papel desconocido');
  if (!(pw > 0 && ph > 0)) errors.push('Medidas de papel inválidas');
  if (p.orientation === 'horizontal' && ph > pw) [pw, ph] = [ph, pw];
  if (p.orientation === 'vertical' && pw > ph) [pw, ph] = [ph, pw];

  const labelH = p.label ? Number(p.label_height_mm) : 0;
  const cellH = unitH + labelH;
  const m = Number(p.margin_mm);
  const availW = pw - 2 * m; const availH = ph - 2 * m;
  const cols = Math.max(0, Math.floor((availW + p.gap_x_mm) / (unitW + p.gap_x_mm)));
  const rows = Math.max(0, Math.floor((availH + p.gap_y_mm) / (cellH + p.gap_y_mm)));
  const capacity = cols * rows;
  if (!errors.length && capacity === 0) {
    errors.push(`El diseño (${unitW} × ${unitH} mm${labelH ? ` + ${labelH} mm de número` : ''}) no entra en una hoja de ${round(pw)} × ${round(ph)} mm con márgenes de ${m} mm. No se reduce el diseño: elegí una hoja más grande o márgenes menores.`);
  }
  let perSheet = p.per_sheet ? Number(p.per_sheet) : capacity;
  if (perSheet > capacity && capacity > 0) {
    errors.push(`En esta hoja entran como máximo ${capacity} diseños a tamaño real (${cols} columnas × ${rows} filas).`);
    perSheet = capacity;
  }
  if (p.label && labelH < (p.label_pt * PT_TO_MM) * 1.2) warnings.push('El alto reservado para el número es menor que el tamaño de letra: puede quedar justo.');
  if (p.crop_marks && m < p.crop_len_mm + p.crop_offset_mm) warnings.push('Las marcas de corte exteriores pueden quedar fuera del margen imprimible.');
  if (m < 5) warnings.push('Muchas impresoras no imprimen a menos de 5 mm del borde: el diseño podría recortarse.');

  const usedW = cols * unitW + Math.max(0, cols - 1) * p.gap_x_mm;
  const usedH = rows * cellH + Math.max(0, rows - 1) * p.gap_y_mm;
  const ox = m + (availW - usedW) / 2; const oy = m + (availH - usedH) / 2;
  const cells = [];
  for (let i = 0; i < perSheet; i++) {
    const c = i % cols; const r = Math.floor(i / cols);
    cells.push({ x: round(ox + c * (unitW + p.gap_x_mm)), y: round(oy + r * (cellH + p.gap_y_mm)) });
  }
  return { params: p, page_w_mm: round(pw), page_h_mm: round(ph), unit_w_mm: unitW, unit_h_mm: unitH, label_h_mm: labelH, cols, rows, capacity, per_sheet: perSheet, cells, errors, warnings };
}

function drawCropMarks(doc, x, y, w, h, len, off) {
  doc.save().lineWidth(0.1).strokeColor('#000000');
  const corners = [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]];
  for (const [cx, cy, sx, sy] of corners) {
    doc.moveTo(cx + sx * off, cy).lineTo(cx + sx * (off + len), cy).stroke();
    doc.moveTo(cx, cy + sy * off).lineTo(cx, cy + sy * (off + len)).stroke();
  }
  doc.restore();
}

/**
 * PDF con varias unidades por hoja, en orden correlativo.
 * items: [{ unit, version, numberInDesign }] ordenados.
 */
async function sheetPdf(uploadsDir, items, params, { title = 'Plancha' } = {}) {
  if (!items.length) throw new Error('No hay unidades para exportar');
  const v0 = items[0].version;
  for (const it of items) {
    if (it.version.width_mm !== v0.width_mm || it.version.height_mm !== v0.height_mm) {
      throw new Error('Las unidades seleccionadas tienen tamaños físicos distintos: exportalas en planchas separadas.');
    }
  }
  const layout = sheetLayout(params, v0.width_mm, v0.height_mm);
  if (layout.errors.length) { const e = new Error(layout.errors.join(' ')); e.layout = layout; throw e; }
  const p = layout.params;
  const doc = new PDFDocument({
    size: [layout.page_w_mm * MM_TO_PT, layout.page_h_mm * MM_TO_PT], margin: 0, autoFirstPage: false,
    info: { Title: title, Creator: 'Sistema de plásticos QR' },
  });
  const done = collect(doc);
  doc.registerFont('txt', path.join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'));
  const imgs = new Map();
  const pages = Math.ceil(items.length / layout.per_sheet);
  for (let pg = 0; pg < pages; pg++) {
    doc.addPage({ size: [layout.page_w_mm * MM_TO_PT, layout.page_h_mm * MM_TO_PT], margin: 0 });
    const slice = items.slice(pg * layout.per_sheet, (pg + 1) * layout.per_sheet);
    slice.forEach((it, i) => {
      const { x, y } = layout.cells[i];
      if (!imgs.has(it.version.id)) imgs.set(it.version.id, doc.openImage(readDesignImage(uploadsDir, it.version)));
      drawUnitPdf(doc, imgs.get(it.version.id), it.version, it.unit, x, y, { numberInDesign: it.numberInDesign });
      if (p.label) {
        const tp = textPath(it.unit.display_number, p.label_pt, x + v0.width_mm / 2, y + v0.height_mm + layout.label_h_mm / 2);
        doc.save().scale(MM_TO_PT).path(tp.d).fill('#000000').restore();
      }
      if (p.crop_marks) {
        doc.save().scale(MM_TO_PT);
        drawCropMarks(doc, x, y, v0.width_mm, v0.height_mm, p.crop_len_mm, p.crop_offset_mm);
        doc.restore();
      }
    });
    if (p.footer && p.margin_mm >= 6) {
      const first = slice[0].unit.display_number; const last = slice[slice.length - 1].unit.display_number;
      const text = `${title} · Hoja ${pg + 1}/${pages} · Unidades ${first}–${last} · Cada diseño: ${v0.width_mm} × ${v0.height_mm} mm · Imprimir al 100 % (tamaño real, sin "ajustar a la página")`;
      const fy = layout.page_h_mm - p.margin_mm / 2;
      doc.font('txt').fontSize(6).fillColor('#444444')
        .text(text, p.margin_mm * MM_TO_PT, (fy - 1) * MM_TO_PT, { lineBreak: false, width: (layout.page_w_mm - 2 * p.margin_mm - 55) * MM_TO_PT });
      // Regla de control: debe medir exactamente 50 mm impresa.
      const rx = layout.page_w_mm - p.margin_mm - 50;
      doc.save().scale(MM_TO_PT).lineWidth(0.2).strokeColor('#000000');
      doc.moveTo(rx, fy).lineTo(rx + 50, fy).stroke();
      for (let t = 0; t <= 50; t += 10) doc.moveTo(rx + t, fy - 1.2).lineTo(rx + t, fy).stroke();
      doc.restore();
      doc.font('txt').fontSize(5).fillColor('#444444').text('50 mm', (rx + 51) * MM_TO_PT, (fy - 1.5) * MM_TO_PT, { lineBreak: false });
    }
  }
  doc.end();
  return { pdf: await done, layout, pages };
}

module.exports = {
  MM_TO_PT, PT_TO_MM, DEFAULT_CONFIG, PAPERS, withDefaults, qrMatrix, qrPath, textPath, textWidth,
  numberAreaStatus, unitElements, unitPng, unitSvg, unitPdf, drawUnitPdf, sheetLayout, sheetPdf, dpiOf, readDesignImage,
};
