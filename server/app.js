import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminController } from './controllers/admin.controller.js';
import { createHealthController } from './controllers/health.controller.js';
import { createPublicController } from './controllers/public.controller.js';
import { createJobRunner } from './jobs/job-runner.js';
import { createTasks } from './jobs/tasks.js';
import { createMailer } from './integrations/gmail.js';
import { cors, createLimiters, errorHandler, requestContext, security } from './middleware/http.js';
import { createMaintenanceRepo } from './repositories/maintenance.repo.js';
import { createOutboxRepo } from './repositories/outbox.repo.js';
import { createReservasRepo } from './repositories/reservas.repo.js';
import { buildRoutes } from './routes/index.js';
import { createAvailabilityService } from './services/availability.service.js';
import { createCleanupService } from './services/cleanup.service.js';
import { createNotifier } from './services/notifier.js';
import { createOutboxProcessor } from './services/outbox.service.js';
import { createReservationsService } from './services/reservations.service.js';
import { createSummaryService } from './services/summary.service.js';
import { verifyEncryptionKey } from './db/key-check.js';
import { createBackupService } from './services/backup.service.js';
import { createFieldCrypto } from './utils/secure.js';
import { createCalendarService } from './services/calendar.service.js';
import { createConfigRepo } from './repositories/config.repo.js';
import { createJobsController } from './controllers/jobs.controller.js';
import { createMetrics } from './utils/metrics.js';
import { setTxObserver } from './db/connection.js';
import { createAdminAccess } from './services/admin-access.js';
import { createEventHub } from './services/event-hub.js';
import { AppError } from './utils/errors.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Ensambla todas las piezas (repositorios → servicios → controladores) una sola vez.
 * Recibe la base de datos, el reloj y, opcionalmente, un transporte de correo ya armado (pruebas).
 */
export function buildContainer({ env, db, log, clock = Date.now, mailTransport }) {
  const fc = createFieldCrypto(env.DATA_ENCRYPTION_KEY);
  if (fc.usingDevKey) log.warn('seguridad.clave_de_desarrollo', { detalle: 'DATA_ENCRYPTION_KEY no está definida: se usa una clave de desarrollo. NO usar así en producción.' });

  verifyEncryptionKey(db, fc); // si la clave no coincide con la de la base de datos, el arranque se detiene con un mensaje claro

  const access = createAdminAccess({ db, fc, clock });
  const hub = createEventHub({ log, clock });
  const reservas = createReservasRepo(db);
  const outboxRepo = createOutboxRepo(db);
  const maintenance = createMaintenanceRepo(db);
  const config = createConfigRepo(db);
  const metrics = createMetrics();
  setTxObserver(metrics.txObserver);
  const calendar = createCalendarService({ config, audit: () => {} }); // los endpoints del panel registran la auditoría con el id de la solicitud
  calendar.seed(new Date(clock()).toISOString());
  const mailer = createMailer({ env, log, transport: mailTransport });
  const notifier = createNotifier({ outbox: outboxRepo, fc, env, log });
  const summary = createSummaryService({ reservas, notifier, fc, log, clock });
  // El resumen del dueño se reconstruye con el estado actual de la base de datos justo antes de enviarse
  const processor = createOutboxProcessor({ outbox: outboxRepo, mailer, fc, log, env, clock, refresh: { resumen_dueno: (p) => ({ ...p, texto: summary.build(p.fecha).texto }) } });

  // Tras confirmar una reserva se intenta enviar su correo de inmediato (sin hacer esperar a la solicitud)
  const kick = () => {
    hub.publish(); // la agenda cambió: las páginas abiertas se actualizan al momento
    setImmediate(() => processor.processBatch().catch((err) => log.error('correo.error_inesperado', { error: err })));
  };

  const availability = createAvailabilityService({ reservas, calendar, config, clock });
  const reservations = createReservationsService({ db, reservas, availability, calendar, config, notifier, fc, env, log, clock, onCommit: kick });
  const cleanup = createCleanupService({ db, maintenance, config, env, log, clock });
  const runner = createJobRunner({ outbox: outboxRepo, log, clock });
  const backup = createBackupService({ db, env, log, clock });
  const tasks = createTasks({ runner, summary, cleanup, calendar, backup, outboxProcessor: processor, env, log, clock });

  return { env, db, log, clock, fc, access, hub, reservas, outboxRepo, config, calendar, metrics, mailer, notifier, processor, reservations, availability, summary, cleanup, backup, tasks };
}

export function buildApp(c, { rateLimits = true, serveStatic = c.env.isProd } = {}) {
  const { env, log, clock } = c;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('etag', false);

  const limiters = createLimiters({ disabled: !rateLimits || !env.RATE_LIMITS_ENABLED });
  const publicCtl = createPublicController({ env, availability: c.availability, reservations: c.reservations, mailer: c.mailer, calendar: c.calendar, clock });
  const adminCtl = createAdminController({ access: c.access, reservations: c.reservations, outbox: c.outboxRepo, calendar: c.calendar, cleanup: c.cleanup, config: c.config, metrics: c.metrics, tasks: c.tasks, log, clock });
  const jobsCtl = createJobsController({ tasks: c.tasks, log });
  const healthCtl = createHealthController({ db: c.db, outbox: c.outboxRepo, mailer: c.mailer, env, clock });

  app.use(c.metrics.middleware);
  app.use(requestContext(log));
  app.use(security(env));
  app.use(cors(env));
  app.use('/api', limiters.global, express.json({ limit: '10kb', strict: true, type: 'application/json' }));
  app.use('/api', buildRoutes({ publicCtl, adminCtl, healthCtl, jobsCtl, limiters, env, access: c.access, hub: c.hub }));
  app.use('/api', (_req, _res, next) => next(new AppError('NO_ENCONTRADO', 404, 'No encontrado.')));

  // En producción el mismo proceso sirve la página compilada (npm run build)
  // Dirección fácil de recordar para el propietario
  app.get('/propietario', (_req, res) => res.redirect(302, '/admin.html'));
  const dist = resolve(here, '../dist');
  if (serveStatic && existsSync(dist)) {
    app.use(express.static(dist, { index: 'index.html', maxAge: '1h', setHeaders: (res, p) => {
      if (/[\\/]assets[\\/]/.test(p)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else if (/\.html$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); // la página siempre se revalida: un despliegue nuevo llega de inmediato
      if (/[\\/]admin\.html$/.test(p)) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive'); } // el panel no se indexa ni se guarda en cachés
    } }));
  }
  app.use(errorHandler(env));
  return app;
}
