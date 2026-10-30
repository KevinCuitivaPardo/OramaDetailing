import cron from 'node-cron';
import { BUSINESS } from '../../shared/catalog.js';

/**
 * Programa las tareas en la zona horaria del negocio (BUSINESS.timezone, America/Puerto_Rico):
 *   · Resumen del dueño   → OWNER_SUMMARY_CRON (11:00 p.m.). Además, un "repaso" cada 10 min por si el servidor estuvo apagado a esa hora.
 *   · Limpieza semanal    → CLEANUP_CRON (domingos 3:00 a.m.)
 *   · Envío de correos    → cada OUTBOX_INTERVAL_SECONDS
 * Cada tarea tiene su propio try/catch: una falla nunca tumba el servidor ni a las otras tareas.
 */
export function startScheduler({ tasks, env, log, outboxRepo }) {
  const stops = [];
  const guard = (name, fn) => async () => {
    try { await fn(); } catch (err) { log.error('scheduler.error_inesperado', { tarea: name, error: err }); }
  };
  const opts = (name) => ({ timezone: BUSINESS.timezone, name });

  for (const [name, expr] of [['resumen_diario', env.OWNER_SUMMARY_CRON], ['limpieza_semanal', env.CLEANUP_CRON], ['respaldo', env.BACKUP_CRON]]) {
    if (!cron.validate(expr)) throw new Error(`Expresión cron inválida para ${name}: "${expr}"`);
  }

  const summaryTask = cron.schedule(env.OWNER_SUMMARY_CRON, guard('resumen_diario', () => tasks.dailySummary()), opts('resumen_diario'));
  const cleanupTask = cron.schedule(env.CLEANUP_CRON, guard('limpieza_semanal', () => tasks.weeklyCleanup({ origen: 'cron' })), opts('limpieza_semanal'));
  // Repaso: si pasó de las 23:00 y el resumen de esa noche no corrió (servidor apagado/reiniciado), lo ejecuta. Es idempotente.
  const catchUp = cron.schedule('*/10 * * * *', guard('repaso_resumen', () => tasks.dailySummary()), opts('repaso_resumen'));
  // Repaso: si el domingo 23:59 el servidor estaba apagado, la limpieza de la semana terminada se recupera (misma clave: no se repite)
  const cleanupCatchUp = cron.schedule('5-55/10 * * * *', guard('repaso_limpieza', () => tasks.weeklyCleanup({ origen: 'repaso' })), opts('repaso_limpieza'));
  const backupTask = cron.schedule(env.BACKUP_CRON, guard('respaldo', () => tasks.dailyBackup()), opts('respaldo'));
  stops.push(() => summaryTask.stop(), () => cleanupTask.stop(), () => catchUp.stop(), () => backupTask.stop(), () => cleanupCatchUp.stop());

  const timer = setInterval(guard('correos', () => tasks.sendEmails()), env.OUTBOX_INTERVAL_SECONDS * 1000);
  timer.unref?.();
  stops.push(() => clearInterval(timer));

  // Al arrancar: enviar lo pendiente y repasar el resumen
  setTimeout(guard('arranque', async () => {
    await tasks.sendEmails();
    await tasks.dailySummary();
    await tasks.weeklyCleanup({ origen: 'repaso' });
  }), 2000).unref?.();

  log.info('scheduler.iniciado', { resumen: env.OWNER_SUMMARY_CRON, limpieza: env.CLEANUP_CRON, respaldo: env.BACKUP_CRON, envioCadaSeg: env.OUTBOX_INTERVAL_SECONDS, zona: BUSINESS.timezone, duenoConfigurado: env.OWNER_EMAIL ? 'si' : 'PENDIENTE' });
  return { stop: () => stops.forEach((s) => s()) };
}
