'use strict';
/**
 * "Paquete para el local": todo lo que hay que mandarle al local que fabrica
 * los plásticos (impresión 3D / UV), sin que el dueño tenga que imprimir nada.
 *  - TODOS_LOS_DISENOS_100x150mm.pdf: un diseño por página, a tamaño real, en orden.
 *  - pdf/, png/, svg/: un archivo por unidad, con el número en el nombre.
 *  - FICHA_PARA_EL_LOCAL.pdf: instrucciones técnicas + hoja de referencia con
 *    miniaturas numeradas para controlar que cada QR lleve su número.
 */
const path = require('node:path');
const PDFDocument = require('pdfkit');
const render = require('./render');

const MM = render.MM_TO_PT;
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

function newDoc(size, title) {
  const doc = new PDFDocument({ size, margin: 0, autoFirstPage: false, info: { Title: title, Creator: 'Sistema de plásticos QR' } });
  doc.registerFont('txt', path.join(FONT_DIR, 'DejaVuSans.ttf'));
  doc.registerFont('bold', path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'));
  return doc;
}

/** Un PDF de N páginas de 100 × 150 mm (una unidad por página, en orden). */
async function allDesignsPdf(uploadsDir, items, title) {
  const v0 = items[0].version;
  const doc = newDoc([v0.width_mm * MM, v0.height_mm * MM], title);
  const done = render.collect(doc);
  const imgs = new Map();
  for (const it of items) {
    if (it.version.width_mm !== v0.width_mm || it.version.height_mm !== v0.height_mm) throw new Error('Unidades con tamaños físicos distintos');
    doc.addPage({ size: [it.version.width_mm * MM, it.version.height_mm * MM], margin: 0 });
    if (!imgs.has(it.version.id)) imgs.set(it.version.id, doc.openImage(render.readDesignImage(uploadsDir, it.version)));
    render.drawUnitPdf(doc, imgs.get(it.version.id), it.version, it.unit, 0, 0, { numberInDesign: it.numberInDesign });
  }
  doc.end();
  return done;
}

/** Ficha técnica en A4 + hojas de referencia con miniaturas numeradas. */
async function fichaPdf(uploadsDir, items, { title, baseUrl, isProduction }) {
  const v = items[0].version;
  const cfg = render.withDefaults(v.config);
  const m = render.qrMatrix(items[0].unit.qr_url, cfg.qr.ecc);
  const moduleMm = cfg.qr.size_mm / (m.size + 2 * cfg.qr.margin_modules);
  const first = items[0].unit.display_number; const last = items[items.length - 1].unit.display_number;
  const inDesign = items.some((i) => i.numberInDesign);
  const doc = newDoc('A4', `Ficha para el local - ${title}`);
  const done = render.collect(doc);
  const W = 595.28;

  doc.addPage({ size: 'A4', margin: 0 });
  let y = 50;
  const line = (text, { font = 'txt', size = 10.5, color = '#222222', gap = 4 } = {}) => {
    doc.font(font).fontSize(size).fillColor(color).text(text, 50, y, { width: W - 100 });
    y = doc.y + gap;
  };
  if (!isProduction) {
    doc.rect(40, 30, W - 80, 46).fill('#FDECEA');
    y = 38;
    line('PRUEBA – NO FABRICAR', { font: 'bold', size: 15, color: '#B42318', gap: 1 });
    line(`Estos QR apuntan a ${baseUrl}, que no es un dominio público. No funcionarían en los plásticos.`, { size: 9, color: '#B42318' });
    y = 92;
  }
  line('Pedido de fabricación de plásticos QR', { font: 'bold', size: 18, gap: 10 });
  line(`Lote: ${title}`, { font: 'bold', size: 12 });
  line(`Cantidad: ${items.length} plásticos — numerados del ${first} al ${last}`, { font: 'bold', size: 12, gap: 12 });

  line('Medidas', { font: 'bold', size: 12.5 });
  line(`• Cada plástico mide ${v.width_mm} mm de ancho × ${v.height_mm} mm de alto (vertical).`);
  line(`• Los PDF están a tamaño real: 1 página = 1 plástico de ${v.width_mm} × ${v.height_mm} mm. No escalar ni "ajustar".`);
  line(`• Resolución de la imagen del diseño: ${Math.round(render.dpiOf(v))} ppp. El QR y el número son vectoriales en los PDF/SVG.`, { gap: 10 });

  line('Muy importante: cada plástico es distinto', { font: 'bold', size: 12.5 });
  line('• Cada plástico tiene un código QR ÚNICO. No usar el mismo QR para varios plásticos.');
  line('• El nombre de cada archivo empieza con su número (ej. "001_..."), que coincide con el QR que contiene.');
  line(inDesign
    ? '• El número también está impreso dentro del diseño, debajo de "Escanea con tu celular". Debe quedar visible.'
    : '• Este lote NO lleva el número dentro del diseño: identificar cada pieza por el nombre del archivo.');
  line('• Fabricar en el orden de los números y entregar cada pieza identificada (bolsa o etiqueta con su número).', { gap: 10 });

  line('Cuidado del código QR', { font: 'bold', size: 12.5 });
  line(`• QR de ${cfg.qr.size_mm.toFixed(1)} × ${cfg.qr.size_mm.toFixed(1)} mm; cada cuadradito (módulo) mide ${moduleMm.toFixed(2)} mm. No debe perder definición.`);
  line('• Mantener QR oscuro sobre fondo claro, con buen contraste. No invertir colores, no deformar, no recortar el margen blanco alrededor.');
  line('• Antes de fabricar todo el lote, probar 1 pieza y escanearla con un celular.', { gap: 10 });

  line('Archivos incluidos', { font: 'bold', size: 12.5 });
  line('• TODOS_LOS_DISENOS_100x150mm.pdf — todos los plásticos, una página cada uno, en orden.');
  line('• carpeta pdf/ — un PDF por plástico (vectorial, tamaño real).');
  line('• carpeta png/ — una imagen por plástico.   • carpeta svg/ — versión vectorial editable.');
  line('• listado.csv — número de cada plástico y su dirección.');
  line('• Las páginas siguientes de esta ficha muestran todas las piezas en miniatura con su número, para controlar.', { gap: 10 });

  // Hojas de referencia: miniaturas (escala 0,4) con el número debajo.
  const s = 0.4; const tw = v.width_mm * s; const th = v.height_mm * s;
  const cols = 4; const gapX = (210 - 20 - cols * tw) / (cols - 1); const rowH = th + 9;
  const rows = Math.floor((297 - 30 - 10) / rowH);
  const perPage = cols * rows;
  const imgs = new Map();
  for (let p = 0; p * perPage < items.length; p++) {
    doc.addPage({ size: 'A4', margin: 0 });
    doc.font('bold').fontSize(11).fillColor('#222222').text(`Referencia de control — ${title} — hoja ${p + 1} (miniaturas, NO es tamaño real)`, 10 * MM, 10 * MM, { lineBreak: false });
    items.slice(p * perPage, (p + 1) * perPage).forEach((it, i) => {
      const x = 10 + (i % cols) * (tw + gapX); const yy = 20 + Math.floor(i / cols) * rowH;
      if (!imgs.has(it.version.id)) imgs.set(it.version.id, doc.openImage(render.readDesignImage(uploadsDir, it.version)));
      render.drawUnitPdf(doc, imgs.get(it.version.id), it.version, it.unit, x, yy, { numberInDesign: it.numberInDesign, scale: s });
      doc.save().lineWidth(0.3).strokeColor('#999999').rect(x * MM, yy * MM, tw * MM, th * MM).stroke().restore();
      const tp = render.textPath(it.unit.display_number, 11, x + tw / 2, yy + th + 4.5);
      doc.save().scale(MM).path(tp.d).fill('#000000').restore();
    });
  }
  doc.end();
  return done;
}

function leeme({ title, count, first, last, isProduction, baseUrl }) {
  return [
    isProduction ? null : `*** PRUEBA – NO FABRICAR: los QR apuntan a ${baseUrl} (no es un dominio público) ***`, isProduction ? null : '',
    `Pedido: ${title}`,
    `Cantidad: ${count} plásticos, numerados del ${first} al ${last}.`,
    '',
    'Abrí primero FICHA_PARA_EL_LOCAL.pdf: tiene las medidas y las instrucciones.',
    'Cada plástico mide 100 x 150 mm (vertical) y tiene un QR distinto.',
    'El número al principio del nombre de cada archivo coincide con el QR que contiene.',
  ].filter((l) => l !== null).join('\r\n');
}

module.exports = { allDesignsPdf, fichaPdf, leeme };
