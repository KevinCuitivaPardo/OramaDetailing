import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backupTo } from '../db/connection.js';

/**
 * Respaldo diario de la base de datos con VACUUM INTO (copia consistente en caliente, sin detener el servicio).
 * Los archivos conservan los datos personales CIFRADOS: sin DATA_ENCRYPTION_KEY no se pueden leer, así que la clave
 * se guarda aparte. Se conservan BACKUP_KEEP_DAYS días; copia además los archivos FUERA del servidor (ver docs/OPERACION.md).
 */
export function createBackupService({ db, env, log, clock = Date.now }) {
  const dir = resolve(env.BACKUP_DIR);

  function run() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date(clock()).toISOString().replace(/[:.]/g, '-');
    const file = backupTo(db, join(dir, `orama-${stamp}.db`));

    // Verificación: la copia debe abrirse y pasar la revisión de integridad
    const check = db.prepare('PRAGMA integrity_check').all();
    const healthy = check.length === 1 && check[0].integrity_check === 'ok';
    if (!healthy) log.error('respaldo.integridad_fallida', { detalle: check.slice(0, 3) });

    // Retención: se borran los respaldos más viejos que BACKUP_KEEP_DAYS
    const limit = clock() - env.BACKUP_KEEP_DAYS * 86400e3;
    let removed = 0;
    for (const f of readdirSync(dir)) {
      if (!/^(orama|pre-migracion)-.*\.db$/.test(f)) continue;
      const p = join(dir, f);
      if (statSync(p).mtimeMs < limit) { unlinkSync(p); removed++; }
    }
    log.info('respaldo.creado', { archivo: file, integridad: healthy ? 'ok' : 'FALLÓ', borradosAntiguos: removed });
    return { archivo: file, integridad: healthy, borradosAntiguos: removed };
  }

  return { run };
}
