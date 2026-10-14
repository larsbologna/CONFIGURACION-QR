'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { openDb, migrate } = require('./db');
const { HttpError } = require('./util');
const auth = require('./services/auth');
const backup = require('./services/backup');
const publish = require('./services/publish');
const { sha256 } = require('./util');
const fs = require('node:fs');
const { apiRoutes } = require('./routes/api');
const { publicRoutes } = require('./routes/public');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Busca la imagen de un diseño del registro (raíz del repo o disenos/) y la copia a uploads. */
function restoreDesignImage(config, d) {
  const ext = d.formato === 'jpeg' ? 'jpg' : 'png';
  const target = path.join(config.uploadsDir, `${d.imagen_sha256}.${ext}`);
  if (fs.existsSync(target)) return path.basename(target);
  const name = path.basename(String(d.imagen || ''));
  for (const dir of [config.root, path.join(config.root, 'disenos')]) {
    const f = path.join(dir, name);
    if (name && fs.existsSync(f)) {
      const buf = fs.readFileSync(f);
      if (sha256(buf) !== d.imagen_sha256) throw new Error(`La imagen ${name} no coincide con la registrada (fue modificada)`);
      fs.mkdirSync(config.uploadsDir, { recursive: true });
      fs.writeFileSync(target, buf);
      return path.basename(target);
    }
  }
  throw new Error(`No se encuentra la imagen del diseño "${d.nombre}" (${name}). Copiala a la carpeta del proyecto.`);
}

function createApp(config) {
  const db = openDb(config.dbFile);
  const applied = migrate(db, { backupFn: (reason) => backup.createBackup(db, config, reason) });
  let imported = null;
  try {
    imported = publish.importRegistry(db, config, { storeImageSync: (d) => restoreDesignImage(config, d) });
  } catch (e) {
    imported = { error: e.message };
    console.error(`No se pudo importar docs/registro.json: ${e.message}`);
  }
  // No regenerar si la importación falló: se sobrescribiría el registro publicado con uno vacío.
  if (config.staticDir && !imported?.error) publish.publishStatic(db, config);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'], frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'self'", 'blob:'], styleSrc: ["'self'"], scriptSrc: ["'self'"], formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.cookieSecure,
  }));

  app.get('/salud', (req, res) => res.json({ ok: true }));
  app.use(publicRoutes(db));
  app.use('/static', express.static(path.join(PUBLIC_DIR, 'static'), { maxAge: '1h' }));

  app.use(auth.loadSession(db));

  // Defensa adicional CSRF: los pedidos que modifican deben venir del mismo origen.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      const host = req.get('x-forwarded-host') && config.trustProxy ? req.get('x-forwarded-host') : req.get('host');
      let ok = false;
      try { ok = new URL(origin).host === host; } catch { ok = false; }
      if (!ok) return res.status(403).json({ error: 'Origen no permitido' });
    }
    next();
  });
  app.use('/api', apiRoutes(db, config));

  app.get('/', (req, res) => res.redirect(302, req.admin ? '/admin/' : '/login'));
  app.get('/login', (req, res) => {
    if (req.admin) return res.redirect(302, '/admin/');
    const n = db.prepare('SELECT COUNT(*) AS n FROM admins WHERE active = 1').get().n;
    res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLIC_DIR, n ? 'login.html' : 'sin-admin.html'));
  });
  app.use('/admin', auth.requirePageAuth, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); },
    express.static(path.join(PUBLIC_DIR, 'admin'), { index: 'index.html', extensions: ['html'] }));

  app.use((req, res) => res.status(404).type('text').send('No encontrado'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message || 'Error interno';
    if (err instanceof HttpError) { /* mensaje propio */ } else if (err.code === 'LIMIT_FILE_SIZE') {
      status = 413; message = 'El archivo supera el tamaño máximo (40 MB)';
    } else if (err.type === 'entity.parse.failed') {
      status = 400; message = 'JSON inválido';
    } else if (err.code === 'ERR_SQLITE_ERROR') {
      status = 409;
      message = /UNIQUE/.test(message) ? 'Registro duplicado: la operación se canceló sin cambios' : message;
    } else if (status >= 500) {
      console.error(err);
      message = 'Error interno del servidor';
    }
    if (res.headersSent) return res.destroy();
    res.status(status).json({ error: message, details: err.details });
  });

  return { app, db, appliedMigrations: applied, imported };
}

module.exports = { createApp };
