'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const bad = (msg, details) => new HttpError(400, msg, details);
const notFound = (msg = 'No encontrado') => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; // sin 0/O/1/l/I
/** Identificador público aleatorio (sin sesgo de módulo). 12 caracteres ≈ 70 bits. */
function randomPublicId(length = 12) {
  let out = '';
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < 256 - (256 % ALPHABET.length)) out += ALPHABET[b % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}
const PUBLIC_ID_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{12}$/;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---- Validación de entradas ----
function str(v, { field, max = 500, required = false, trim = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`Falta el campo "${field}"`);
    return null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`Campo "${field}" inválido`);
  let s = String(v);
  if (trim) s = s.trim();
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (s.length > max) throw bad(`El campo "${field}" supera ${max} caracteres`);
  if (required && !s) throw bad(`Falta el campo "${field}"`);
  return s || null;
}

function int(v, { field, min = -Infinity, max = Infinity, required = false, def } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`Falta el campo "${field}"`);
    return def;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`"${field}" debe ser un entero entre ${min} y ${max}`);
  return n;
}

function num(v, { field, min = -Infinity, max = Infinity, required = false, def } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`Falta el campo "${field}"`);
    return def;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`"${field}" debe ser un número entre ${min} y ${max}`);
  return n;
}

function oneOf(v, list, { field, def } = {}) {
  if (v === undefined || v === null || v === '') return def;
  if (!list.includes(v)) throw bad(`"${field}" debe ser uno de: ${list.join(', ')}`);
  return v;
}

function isoDate(v, { field } = {}) {
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v))) throw bad(`"${field}" debe ser una fecha AAAA-MM-DD`);
  return String(v);
}

function color(v, { field, def } = {}) {
  if (v === undefined || v === null || v === '') return def;
  if (!/^#[0-9a-fA-F]{6}$/.test(String(v))) throw bad(`"${field}" debe ser un color #RRGGBB`);
  return String(v).toUpperCase();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = {
  HttpError, bad, notFound, conflict, randomPublicId, PUBLIC_ID_RE, sha256,
  str, int, num, oneOf, isoDate, color, escapeHtml,
};
