import { addDays, zoneNow } from '../utils/time.js';
import { BUSINESS } from '../../shared/catalog.js';

/**
 * Definición de las tareas (sin cron ni temporizadores: eso está en scheduler.js).
 * Así cada tarea se puede ejecutar a mano (`npm run job:summary`) y probar con un reloj falso.
 */

/**
 * ¿Qué día se resume ahora? A las 11:00 p.m. la agenda se cierra y se resume el día siguiente.
 * Si el servidor estuvo apagado y se recupera de madrugada (antes de las 6:00 a.m.), el día a resumir es el actual.
 */
export function summaryTarget(nowMs) {
  const { fecha, minutos } = zoneNow(nowMs);
  if (minutos >= BUSINESS.agendaClosedFromMin) return addDays(fecha, 1);
  // Repaso: hasta el mediodía todavía se recupera un resumen del día en curso que no salió (servidor apagado a las 11 p.m.)
  if (minutos < 720) return fecha;
  return null;
}

export function createTasks({ runner, summary, cleanup, calendar, backup, outboxProcessor, env, log, clock = Date.now }) {
  /** Resumen del dueño con las reservas del día siguiente. `fecha` fuerza una fecha concreta (uso manual). */
  async function dailySummary({ fecha } = {}) {
    const nowMs = clock();
    const target = fecha ?? summaryTarget(nowMs);
    if (!target) return { skipped: true, motivo: 'fuera_de_horario' };

    return runner('resumen_diario', target, async () => {
      // Solo se resume un día laborable según el calendario configurado (días de operación, festivos y excepciones)
      if (!calendar.isOpen(target)) return { omitido: 'dia_no_laborable', fecha: target, motivo: calendar.explain(target) };
      if (!env.OWNER_EMAIL) throw new Error('OWNER_EMAIL no está configurado: no hay a quién enviar el resumen');
      const { total, added } = summary.enqueue(target, new Date(nowMs).toISOString());
      return { fecha: target, reservas: total, encolado: added };
    });
  }

  /**
   * Limpieza semanal automática. La clave de idempotencia es la fecha de corte (un lunes): una sola ejecución por semana,
   * aunque el cron se dispare dos veces, haya dos procesos o el repaso la vuelva a intentar.
   * `origen`: 'cron' (domingo 23:59) o 'repaso' (recuperación si el servidor estuvo apagado a esa hora).
   */
  async function weeklyCleanup({ dryRun = false, origen = 'cron' } = {}) {
    if (dryRun) return { ok: true, simulacion: cleanup.simulate({ actor: 'cli' }) };
    if (!cleanup.enabled()) {
      if (origen === 'cron') cleanup.run({ modo: 'automatica' }); // deja constancia de que se omitió
      return { skipped: true, motivo: 'deshabilitada' };
    }
    const { corte } = cleanup.policy(clock());
    return runner('limpieza_semanal', corte, async () => cleanup.run({ modo: 'automatica' }));
  }

  /** Respaldo diario (una ejecución por día). */
  async function dailyBackup() {
    return runner('respaldo', zoneNow(clock()).fecha, async () => backup.run());
  }

  async function sendEmails() { return outboxProcessor.processBatch(); }

  return { dailySummary, weeklyCleanup, dailyBackup, sendEmails };
}
