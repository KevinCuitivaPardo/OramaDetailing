// Ejecuta una tarea a mano:  npm run job:summary | job:cleanup | job:outbox | backup | job:requeue
//   node scripts/run-job.mjs summary [AAAA-MM-DD]   → resumen del dueño de esa fecha (por defecto, la que corresponda ahora)
//   node scripts/run-job.mjs cleanup [--dry-run]    → limpieza semanal (con --dry-run solo cuenta, no borra)
//   node scripts/run-job.mjs outbox                 → envía los correos pendientes ahora
import { buildContainer } from '../server/app.js';
import { loadEnv } from '../server/config/env.js';
import { migrate, openDatabase, syncCatalog } from '../server/db/connection.js';
import { createLogger } from '../server/utils/logger.js';
import { resolve } from 'node:path';

const [, , job, arg] = process.argv;
const env = loadEnv();
const log = createLogger({ level: env.LOG_LEVEL, base: { servicio: 'orama-job' } });
const db = openDatabase(env.DATABASE_PATH);
migrate(db, log, { backupDir: resolve(env.BACKUP_DIR) });
syncCatalog(db);
const { tasks, outboxRepo } = buildContainer({ env, db, log });

let result;
switch (job) {
  case 'summary': result = await tasks.dailySummary({ fecha: arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : undefined }); break;
  case 'cleanup': result = await tasks.weeklyCleanup({ dryRun: process.argv.includes('--dry-run') }); break;
  case 'outbox': result = await tasks.sendEmails(); break;
  case 'backup': result = await tasks.dailyBackup(); break;
  // Vuelve a poner en cola los correos fallidos que aún conservan su contenido (después de arreglar Gmail)
  case 'requeue': result = { reencolados: outboxRepo.requeueFailed(new Date().toISOString()) }; break;
  default:
    console.error('Uso: node scripts/run-job.mjs <summary|cleanup|outbox|backup|requeue> [fecha | --dry-run]');
    process.exit(2);
}
console.log(JSON.stringify(result, null, 2));
db.close();
