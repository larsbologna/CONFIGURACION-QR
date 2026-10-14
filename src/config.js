'use strict';
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'si', 'sí', 'yes'].includes(String(v).toLowerCase());
}

function normalizeBaseUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('PUBLIC_BASE_URL debe ser http(s)');
  if (u.search || u.hash) throw new Error('PUBLIC_BASE_URL no debe tener parámetros');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** ¿El dominio sirve para imprimir QR reales? (https y no local) */
function isProductionBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname;
    if (h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':')) return false;
    if (/(^|\.)(example\.(com|org|net)|mi-dominio\.com|local|test|invalid)$/.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const dataDir = path.resolve(ROOT, env.DATA_DIR || './data');
  const publicBaseUrl = normalizeBaseUrl(env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`);
  const cookieSecure = env.COOKIE_SECURE && env.COOKIE_SECURE !== 'auto'
    ? bool(env.COOKIE_SECURE, false)
    : publicBaseUrl.startsWith('https://');
  return {
    root: ROOT,
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    publicBaseUrl,
    publicBaseUrlIsProduction: isProductionBaseUrl(publicBaseUrl),
    dataDir,
    dbFile: path.join(dataDir, 'qr.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
    backupDir: path.resolve(ROOT, env.BACKUP_DIR || './backups'),
    sessionHours: Number(env.SESSION_HOURS || 12),
    trustProxy: bool(env.TRUST_PROXY, false),
    cookieSecure,
    allowHttpDestinations: bool(env.ALLOW_HTTP_DESTINATIONS, false),
    maxBatch: Number(env.MAX_BATCH || 5000),
    fontFile: path.join(ROOT, 'assets', 'fonts', 'DejaVuSans-Bold.ttf'),
  };
}

module.exports = { loadConfig, isProductionBaseUrl, normalizeBaseUrl };
