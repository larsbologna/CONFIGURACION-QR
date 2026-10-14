'use strict';
const crypto = require('node:crypto');
const { nowIso } = require('../db');
const { HttpError } = require('../util');

// scrypt: N=2^15, r=8, p=1 (≈32 MB de memoria por hash).
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 });
  return crypto.timingSafeEqual(expected, actual);
}

function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 10) return 'La contraseña debe tener al menos 10 caracteres';
  if (password.length > 200) return 'La contraseña es demasiado larga';
  return null;
}

function createAdmin(db, username, password) {
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username || '')) throw new Error('Usuario inválido (3-40 caracteres: letras, números, . _ -)');
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(weak);
  const res = db.prepare('INSERT INTO admins(username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), nowIso());
  return Number(res.lastInsertRowid);
}

function setAdminPassword(db, username, password) {
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(weak);
  const res = db.prepare('UPDATE admins SET password_hash = ? WHERE username = ?').run(hashPassword(password), username);
  if (res.changes === 0) throw new Error('No existe ese usuario');
}

const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DUMMY_HASH = hashPassword('contraseña-de-relleno-para-tiempo-constante');

function login(db, config, username, password) {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ? AND active = 1').get(String(username || ''));
  const ok = verifyPassword(String(password || ''), admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !ok) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + config.sessionHours * 3600e3).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  db.prepare('INSERT INTO sessions(token_hash, admin_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(tokenHash(token), admin.id, csrf, nowIso(), expires);
  db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(nowIso(), admin.id);
  return { token, admin: { id: admin.id, username: admin.username }, expires };
}

function sessionFromToken(db, token) {
  if (!token || token.length > 100) return null;
  return db.prepare(`SELECT s.token_hash, s.csrf_token, s.expires_at, a.id AS admin_id, a.username
    FROM sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND a.active = 1`).get(tokenHash(token), nowIso()) || null;
}

function logout(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

// ---- Limitador de intentos de inicio de sesión (memoria) ----
class LoginLimiter {
  constructor({ max = 8, windowMs = 15 * 60e3 } = {}) {
    this.max = max; this.windowMs = windowMs; this.hits = new Map();
  }
  key(ip, user) { return `${ip}|${String(user || '').toLowerCase()}`; }
  check(ip, user) {
    const now = Date.now();
    for (const k of [this.key(ip, user), `${ip}|*`]) {
      const e = this.hits.get(k);
      const limit = k.endsWith('|*') ? this.max * 3 : this.max;
      if (e && now - e.first < this.windowMs && e.count >= limit) {
        throw new HttpError(429, 'Demasiados intentos. Esperá unos minutos.');
      }
    }
  }
  fail(ip, user) {
    const now = Date.now();
    for (const k of [this.key(ip, user), `${ip}|*`]) {
      const e = this.hits.get(k);
      if (!e || now - e.first >= this.windowMs) this.hits.set(k, { first: now, count: 1 });
      else e.count++;
    }
  }
  success(ip, user) { this.hits.delete(this.key(ip, user)); }
}

const COOKIE = 'qr_admin';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(config, token, expires) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (config.cookieSecure) attrs.push('Secure');
  attrs.push(expires ? `Expires=${new Date(expires).toUTCString()}` : 'Max-Age=0');
  return attrs.join('; ');
}

/** Middleware: carga la sesión (si existe) en req.admin. */
function loadSession(db) {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const s = sessionFromToken(db, token);
    req.sessionToken = token;
    req.session = s;
    req.admin = s ? { id: s.admin_id, username: s.username, ip: req.ip } : null;
    next();
  };
}

/** API: exige sesión y token CSRF en métodos que modifican. */
function requireApiAuth(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: 'Sesión requerida' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const sent = req.get('x-csrf-token') || '';
    const a = Buffer.from(sent); const b = Buffer.from(req.session.csrf_token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'Token CSRF inválido. Recargá la página.' });
    }
  }
  next();
}

/** Páginas del panel: sin sesión redirige al login. */
function requirePageAuth(req, res, next) {
  if (!req.admin) return res.redirect(302, '/login');
  next();
}

module.exports = {
  hashPassword, verifyPassword, createAdmin, setAdminPassword, login, logout, sessionFromToken,
  LoginLimiter, parseCookies, sessionCookie, loadSession, requireApiAuth, requirePageAuth, COOKIE,
};
