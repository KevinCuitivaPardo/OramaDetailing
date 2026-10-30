// Define (o cambia) la contraseña del propietario para entrar al panel. Se ejecuta EN EL SERVIDOR, donde está la base de datos:
//   node --env-file=/etc/orama/orama.env scripts/admin-password.mjs --generar     → crea una contraseña aleatoria y la muestra UNA vez
//   ADMIN_NEW_PASSWORD='mi contraseña larga' node --env-file=... scripts/admin-password.mjs
// Después el propietario puede cambiarla desde el propio panel (pestaña "Cuenta"). Cambiarla cierra todas las sesiones abiertas.
import { randomBytes } from 'node:crypto';
import { loadEnv } from '../server/config/env.js';
import { migrate, openDatabase } from '../server/db/connection.js';
import { createAdminAccess } from '../server/services/admin-access.js';
import { createFieldCrypto } from '../server/utils/secure.js';

const env = loadEnv();
const db = openDatabase(env.DATABASE_PATH);
migrate(db, undefined, { backupDir: env.BACKUP_DIR });
const access = createAdminAccess({ db, fc: createFieldCrypto(env.DATA_ENCRYPTION_KEY) });

let password = process.env.ADMIN_NEW_PASSWORD;
const generated = process.argv.includes('--generar');
if (generated) {
  // 4 grupos de letras y números fáciles de leer (sin 0/O/1/l): 20 caracteres con ~100 bits de entropía
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const group = () => Array.from(randomBytes(5), (b) => alphabet[b % alphabet.length]).join('');
  password = [group(), group(), group(), group()].join('-');
}
if (!password) { console.error('Indica --generar o la variable ADMIN_NEW_PASSWORD.'); process.exit(2); }
try { await access.setPassword(password); } catch (e) { console.error(e.message); process.exit(1); }
console.log(generated ? `Contraseña del propietario (guárdala; cámbiala desde el panel):\n${password}` : 'Contraseña actualizada.');
db.close();
