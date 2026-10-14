'use strict';
/**
 * Genera una imagen SINTÉTICA de prueba (no es el diseño del cliente) con la
 * misma geometría general que el plástico real: 2:3, tarjeta blanca con un QR
 * "viejo" en el centro y un texto debajo. Sirve para probar el reemplazo del QR
 * de forma automática sin depender del archivo original.
 */
const sharp = require('sharp');
const QRCode = require('qrcode');

async function makeFixture({ width = 1280, height = 1920, oldUrl = 'https://qr-viejo.example/fijo' } = {}) {
  const s = width / 1280;
  const qrPng = await QRCode.toBuffer(oldUrl, { margin: 0, width: Math.round(530 * s), errorCorrectionLevel: 'M', color: { dark: '#222222', light: '#FFFFFF' } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1280 1920">
    <rect width="1280" height="1920" fill="#FDFDFD"/>
    <circle cx="640" cy="450" r="130" fill="none" stroke="#4285F4" stroke-width="60"/>
    <rect x="390" y="630" width="500" height="80" fill="#F5BC1C"/>
    <rect x="110" y="760" width="1060" height="70" fill="#222222"/>
    <rect x="200" y="860" width="880" height="55" fill="#333333"/>
    <rect x="342" y="952" width="600" height="603" rx="24" fill="#FFFFFF" stroke="#EEEEEE" stroke-width="3"/>
    <rect x="455" y="1612" width="370" height="36" fill="#444444"/>
    <text x="640" y="1880" font-size="30" text-anchor="middle" fill="#C00">FIXTURE DE PRUEBA</text>
  </svg>`;
  return sharp(Buffer.from(svg))
    .composite([{ input: qrPng, left: Math.round(376 * s), top: Math.round(985 * s) }])
    .png().toBuffer();
}

module.exports = { makeFixture };
