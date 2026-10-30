/**
 * "Canario" de la clave de cifrado. La primera vez se guarda en la base de datos una palabra cifrada; en cada arranque se
 * descifra. Si DATA_ENCRYPTION_KEY cambió o se perdió, el servidor se detiene con un mensaje claro en vez de arrancar y
 * fallar en cada consulta (o, peor, empezar a cifrar datos nuevos con otra clave).
 */
const CANARY = 'orama-canario-v1';

export function verifyEncryptionKey(db, fc) {
  const row = db.prepare("SELECT valor FROM meta WHERE clave = 'canario'").get();
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO meta (clave, valor) VALUES ('canario', ?)").run(fc.encrypt(CANARY));
    return { creado: true };
  }
  let ok = false;
  try { ok = fc.decrypt(row.valor) === CANARY; } catch { ok = false; }
  if (!ok) {
    throw new Error('DATA_ENCRYPTION_KEY no coincide con la clave con la que se cifró esta base de datos. Restaura la clave original (gestor de secretos); sin ella no se pueden leer los datos personales.');
  }
  return { creado: false };
}
