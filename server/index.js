import { buildApp, buildContainer } from './app.js';
import { loadEnv } from './config/env.js';
import { migrate, openDatabase, syncCatalog } from './db/connection.js';
import { startScheduler } from './jobs/scheduler.js';
import { createLogger } from './utils/logger.js';
import { resolve } from 'node:path';

/** Arranque del servidor: configuración → base de datos → API → tareas programadas → apagado ordenado. */
const env = loadEnv();
const log = createLogger({ level: env.LOG_LEVEL, base: { servicio: 'orama-api' } });

process.on('unhandledRejection', (err) => { log.error('proceso.promesa_rechazada', { error: err }); process.exit(1); });
process.on('uncaughtException', (err) => { log.error('proceso.excepcion', { error: err }); process.exit(1); });

const db = openDatabase(env.DATABASE_PATH);
migrate(db, log, { backupDir: resolve(env.BACKUP_DIR) });
syncCatalog(db);

const container = buildContainer({ env, db, log });
const app = buildApp(container);
const server = app.listen(env.PORT, env.HOST, () => {
  log.info('servidor.iniciado', {
    url: `http://${env.HOST}:${env.PORT}`, entorno: env.NODE_ENV,
    gmail: container.mailer.configured ? container.mailer.mode : 'NO CONFIGURADO (los correos quedan en cola)',
    duenoConfigurado: env.OWNER_EMAIL ? 'si' : 'PENDIENTE',
    admin: env.ADMIN_TOKEN_SECRET ? 'habilitado' : 'deshabilitado',
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

if (env.isProd && env.TRUST_PROXY === 0) {
  log.warn('seguridad.trust_proxy_apagado', { detalle: 'TRUST_PROXY=0: si hay un proxy/hosting delante, todas las visitas parecerán la misma IP y los límites de uso fallarán. Ajusta TRUST_PROXY (1 detrás de un proxy).' });
}

const scheduler = env.JOBS_ENABLED ? startScheduler({ tasks: container.tasks, env, log, outboxRepo: container.outboxRepo }) : null;
if (!scheduler) log.warn('scheduler.deshabilitado', { detalle: 'JOBS_ENABLED=false: no habrá resumen diario, limpieza ni envío de correos automáticos' });

function shutdown(signal) {
  log.info('servidor.apagando', { signal });
  scheduler?.stop();
  container.hub.close(); // cierra los flujos en vivo: si no, el servidor esperaría a que cada navegador se desconecte
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  server.close(async () => {
    await container.processor.idle(); // un correo a mitad de envío termina antes de cerrar
    try { db.close(); } catch { /* ya cerrada */ }
    log.info('servidor.apagado');
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
