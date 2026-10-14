'use strict';
/**
 * Crea un administrador o cambia su contraseña.
 *   npm run crear-admin               (pregunta usuario y contraseña)
 *   npm run crear-admin -- usuario    (pregunta solo la contraseña)
 * También acepta ADMIN_USER y ADMIN_PASSWORD como variables de entorno.
 */
const readline = require('node:readline');
const { loadConfig } = require('../src/config');
const { openDb, migrate } = require('../src/db');
const auth = require('../src/services/auth');

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); else process.stdout.write('*'); };
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const config = loadConfig();
  const db = openDb(config.dbFile);
  migrate(db);
  const username = process.env.ADMIN_USER || process.argv[2] || (await ask('Usuario administrador: ')).trim();
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await ask('Contraseña (mínimo 10 caracteres): ', true);
    const again = await ask('Repetir contraseña: ', true);
    if (password !== again) { console.error('Las contraseñas no coinciden.'); process.exit(1); }
  }
  const exists = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
  try {
    if (exists) { auth.setAdminPassword(db, username, password); console.log(`Contraseña actualizada para "${username}".`); }
    else { auth.createAdmin(db, username, password); console.log(`Administrador "${username}" creado.`); }
  } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
  db.close();
})();
