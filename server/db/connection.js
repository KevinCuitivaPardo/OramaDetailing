import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUSINESS, PRICES, SERVICES } from '../../shared/catalog.js';
import { zoneNow } from '../utils/time.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Abre la base de datos con las opciones de seguridad e integridad activadas. */
export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path === ':memory:' ? path : resolve(path));
  db.exec(`
    PRAGMA busy_timeout = 5000;      -- si otro proceso escribe, espera hasta 5 s en vez de fallar (va primero: protege a los demás PRAGMA)
    PRAGMA journal_mode = WAL;       -- lecturas no bloquean escrituras
    PRAGMA synchronous = FULL;       -- una reserva confirmada sobrevive a un corte de luz (el volumen es bajo: el costo es insignificante)
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;       -- al borrar, SQLite sobrescribe el contenido (no quedan datos personales en páginas libres)
  `);
  return db;
}

const dbFile = (db) => db.prepare('PRAGMA database_list').get()?.file || null;

/** Copia consistente de la base de datos en caliente (VACUUM INTO). El archivo destino no debe existir. */
export function backupTo(db, destination) {
  mkdirSync(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
  db.prepare('VACUUM INTO ?').run(resolve(destination));
  return resolve(destination);
}

/**
 * Aplica las migraciones pendientes en orden, cada una en su propia transacción.
 *  - Antes de tocar una base de datos EXISTENTE se guarda una copia (`pre-migracion-…db`).
 *  - La lista de aplicadas se vuelve a leer DENTRO de la transacción: dos procesos que arrancan a la vez no la ejecutan dos veces.
 *  - Cada migración guarda su checksum: si alguien edita una migración ya aplicada, el arranque se detiene.
 *  - Una migración que reconstruye tablas lleva la marca `-- no-fk` en su primera línea: se ejecuta con las llaves foráneas
 *    apagadas (dentro de una transacción no se pueden apagar) y se verifica con `PRAGMA foreign_key_check` antes de confirmar.
 */
export function migrate(db, log, { backupDir } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, aplicada_en TEXT NOT NULL, checksum TEXT) STRICT');
  const dir = join(here, 'migrations');
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const versions = files.map((f) => Number.parseInt(f, 10));
  if (new Set(versions).size !== versions.length) throw new Error('Hay dos migraciones con el mismo número de versión');

  const sums = new Map(files.map((f) => [Number.parseInt(f, 10), createHash('sha256').update(readFileSync(join(dir, f), 'utf8')).digest('hex')]));
  const applied = new Map(db.prepare('SELECT version, checksum FROM schema_migrations').all().map((r) => [r.version, r.checksum]));
  for (const [v, sum] of applied) {
    if (sum && sums.has(v) && sums.get(v) !== sum) throw new Error(`La migración ${v} se modificó después de aplicarse. Crea una migración nueva en lugar de editarla.`);
  }

  const pending = files.filter((f) => !applied.has(Number.parseInt(f, 10)));
  const file = dbFile(db);
  if (pending.length && applied.size && file) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const copy = backupTo(db, join(backupDir ?? join(dirname(file), 'backups'), `pre-migracion-${stamp}.db`));
    log?.info('db.respaldo_previo_a_migrar', { archivo: copy });
  }

  for (const name of pending) {
    const version = Number.parseInt(name, 10);
    const sql = readFileSync(join(dir, name), 'utf8');
    const rebuild = /^--\s*no-fk\b/m.test(sql.split('\n')[0] ?? '');
    if (rebuild) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version)) { db.exec('ROLLBACK'); continue; } // otro proceso ya la aplicó
      db.exec(sql);
      if (rebuild && db.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`La migración ${version} dejó filas con llaves foráneas inválidas`);
      db.prepare('INSERT INTO schema_migrations (version, aplicada_en, checksum) VALUES (?, ?, ?)').run(version, new Date().toISOString(), sums.get(version));
      db.exec('COMMIT');
      log?.info('db.migracion_aplicada', { version, archivo: name });
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ya revertida */ }
      throw err;
    } finally {
      if (rebuild) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

/**
 * Sincroniza el catálogo (servicios y precios) con /shared/catalog.js.
 * Cambiar la duración o el bloque de un servicio que ya tiene reservas futuras se rechaza: las citas ya hechas
 * conservan su horario y los casilleros que ocupan, y el catálogo nuevo las dejaría incoherentes. Si hace falta,
 * primero se atienden o se mueven esas reservas.
 */
export function syncCatalog(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const hoy = zoneNow().fecha;
    const current = new Map(db.prepare('SELECT id, duracion_min, bloque_min FROM servicios').all().map((r) => [r.id, r]));
    for (const s of Object.values(SERVICES)) {
      const prev = current.get(s.id);
      if (prev && (prev.duracion_min !== s.duracionMin || prev.bloque_min !== s.bloqueMin)) {
        const n = db.prepare("SELECT COUNT(*) AS n FROM reservas WHERE servicio_id = ? AND estado = 'confirmada' AND fecha >= ?").get(s.id, hoy).n;
        if (n > 0) throw new Error(`No se puede cambiar la duración del servicio "${s.nombre}": hay ${n} reserva(s) futuras con la duración anterior. Atiéndelas o cancélalas primero.`);
      }
    }
    const upService = db.prepare(`
      INSERT INTO servicios (id, codigo, nombre, duracion_min, bloque_min, activo) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT (id) DO UPDATE SET codigo = excluded.codigo, nombre = excluded.nombre,
        duracion_min = excluded.duracion_min, bloque_min = excluded.bloque_min`); // `activo` NO se toca: lo decide el administrador
    const upPrice = db.prepare(`
      INSERT INTO precios (servicio_id, vehiculo, monto, es_desde) VALUES (?, ?, ?, ?)
      ON CONFLICT (servicio_id, vehiculo) DO UPDATE SET monto = excluded.monto, es_desde = excluded.es_desde`);
    for (const s of Object.values(SERVICES)) upService.run(s.id, s.codigo, s.nombre, s.duracionMin, s.bloqueMin);
    for (const [vehiculo, byService] of Object.entries(PRICES)) {
      for (const [sid, [monto, desde]] of Object.entries(byService)) upPrice.run(Number(sid), vehiculo, monto, desde ? 1 : 0);
    }
    // Servicios que ya no están en el catálogo se desactivan (nunca se borran: las reservas viejas los referencian)
    const ids = Object.values(SERVICES).map((s) => s.id);
    db.prepare(`UPDATE servicios SET activo = 0 WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ya revertida */ }
    throw err;
  }
}

/**
 * Ejecuta `fn` dentro de una transacción de escritura. BEGIN IMMEDIATE toma el candado de escritura
 * desde el principio, así dos reservas simultáneas se ejecutan una detrás de la otra (también entre procesos).
 */
let txObserver = null;
/** Medición opcional de las transacciones (duración y espera del candado). La usa el módulo de métricas. */
export const setTxObserver = (fn) => { txObserver = fn; };

export function inTransaction(db, fn) {
  const t0 = txObserver ? performance.now() : 0;
  db.exec('BEGIN IMMEDIATE');
  const waited = txObserver ? performance.now() - t0 : 0; // tiempo esperando el candado de escritura
  try {
    const out = fn();
    db.exec('COMMIT');
    txObserver?.({ ok: true, ms: performance.now() - t0, waitedMs: waited });
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ya revertida */ }
    txObserver?.({ ok: false, ms: performance.now() - t0, waitedMs: waited });
    throw err;
  }
}

/** Checkpoint del WAL con verificación: devuelve si pudo truncarlo (si hay lectores activos, `busy` = true). */
export function checkpoint(db) {
  const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  return { busy: Boolean(r?.busy) };
}

/** ¿El error es una violación de UNIQUE/PRIMARY KEY? (SQLite: errcode 1555 = PK, 2067 = UNIQUE) */
export const isUniqueViolation = (err) => err?.errcode === 1555 || err?.errcode === 2067 || /UNIQUE constraint failed/.test(err?.message ?? '');
export const isBusy = (err) => err?.errcode === 5 || err?.errcode === 6 || /database is locked/.test(err?.message ?? '');
/** Disco lleno o base de datos de solo lectura: no es culpa del cliente, se responde 503. */
export const isStorageProblem = (err) => [8, 13].includes(err?.errcode) || /database or disk is full|readonly database/i.test(err?.message ?? '');

export { BUSINESS };
