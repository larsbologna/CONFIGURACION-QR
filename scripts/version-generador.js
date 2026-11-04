'use strict';
/**
 * Pone una marca de versión (?v=<hash del contenido>) a los archivos que carga
 * docs/generador/index.html. Así, cuando un archivo cambia, los celulares y
 * navegadores bajan la versión nueva en lugar de usar la copia guardada.
 *   node scripts/version-generador.js          → actualiza index.html
 *   node scripts/version-generador.js --check  → solo verifica (sale con error si falta actualizar)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = path.join(__dirname, '..', 'docs', 'generador');
const INDEX = path.join(DIR, 'index.html');

function stamp(html, dir = DIR) {
  return html.replace(/(src|href)="((?!https?:|\/\/|#)[^"?]+\.(?:js|css))(?:\?v=[0-9a-f]+)?"/g, (m, attr, file) => {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) return m;
    const v = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 10);
    return `${attr}="${file}?v=${v}"`;
  });
}

if (require.main === module) {
  const html = fs.readFileSync(INDEX, 'utf8');
  const next = stamp(html);
  if (process.argv.includes('--check')) {
    if (next !== html) { console.error('docs/generador/index.html tiene marcas de versión viejas: correr node scripts/version-generador.js'); process.exit(1); }
    console.log('Marcas de versión al día.');
  } else {
    fs.writeFileSync(INDEX, next);
    console.log(next === html ? 'Sin cambios.' : 'index.html actualizado.');
  }
}

module.exports = { stamp, INDEX };
