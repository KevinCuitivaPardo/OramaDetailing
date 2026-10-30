/**
 * Ejecuta una tarea programada de forma idempotente y observable.
 *  - `job_runs` tiene UNIQUE(job, run_key): si el cron se dispara dos veces, o hay dos procesos, solo una ejecución corre.
 *  - Una ejecución 'error' puede reintentarse; una 'en_curso' abandonada (el proceso murió) se retoma pasados 30 min.
 *  - Nunca lanza: los errores se registran y quedan en `job_runs` para diagnosticar.
 */
const STALE_MS = 30 * 60e3;

export function createJobRunner({ outbox, log, clock = Date.now }) {
  return async function runJob(job, runKey, fn) {
    const nowMs = clock();
    const started = outbox.jobStart(job, runKey, new Date(nowMs).toISOString(), new Date(nowMs - STALE_MS).toISOString());
    if (!started) {
      const prev = outbox.jobGet(job, runKey);
      log.info('tarea.omitida', { job, runKey, estado: prev?.estado });
      return { skipped: true, estado: prev?.estado };
    }
    log.info('tarea.iniciada', { job, runKey });
    const t0 = Date.now();
    try {
      const result = (await fn()) ?? {};
      const detalle = JSON.stringify(result).slice(0, 500);
      outbox.jobEnd(job, runKey, 'ok', new Date(clock()).toISOString(), detalle);
      log.info('tarea.terminada', { job, runKey, ms: Date.now() - t0, result });
      return { skipped: false, ok: true, result };
    } catch (err) {
      outbox.jobEnd(job, runKey, 'error', new Date(clock()).toISOString(), String(err?.message ?? err).slice(0, 300));
      log.error('tarea.fallida', { job, runKey, ms: Date.now() - t0, error: err });
      return { skipped: false, ok: false, error: err?.message };
    }
  };
}
