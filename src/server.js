'use strict';
const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const { app, db, appliedMigrations, imported } = createApp(config);
if (appliedMigrations.length) console.log(`Migraciones aplicadas: ${appliedMigrations.join(', ')}`);
if (imported && !imported.error) console.log(`Registro sincronizado (revisión ${imported.revision}): ${imported.units_added} unidades nuevas, ${imported.units_updated} actualizadas.`);
if (config.staticDir) console.log(`Modo GitHub Pages: las páginas de los QR se escriben en ${config.staticDir}. Después de cambios, tocá "Publicar en GitHub".`);

const server = app.listen(config.port, config.host, () => {
  console.log(`Panel: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/admin/`);
  console.log(`Dominio de los QR: ${config.publicBaseUrl}${config.publicBaseUrlIsProduction ? '' : '  (MODO PRUEBA: no es un dominio público HTTPS)'}`);
  const n = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (!n) console.log('No hay administradores. Creá uno con:  npm run crear-admin');
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
