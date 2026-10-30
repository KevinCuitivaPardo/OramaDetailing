/**
 * Disparador externo de tareas programadas. Un servicio de cron (GitHub Actions, cron-job.org, el programador del hosting)
 * llama aquí con `Authorization: Bearer JOBS_TRIGGER_SECRET`. Es una red de seguridad: las tareas son IDEMPOTENTES
 * (la misma ejecución no se repite), así que dispararlas de más no hace daño, y si el proceso estaba dormido o reiniciándose,
 * la primera llamada lo pone al día. Solo devuelve conteos, nunca datos de clientes.
 */
export function createJobsController({ tasks, log }) {
  const runners = {
    resumen: () => tasks.dailySummary(),
    limpieza: () => tasks.weeklyCleanup({ origen: 'repaso' }),
    correos: () => tasks.sendEmails(),
    respaldo: () => tasks.dailyBackup(),
  };
  return {
    run: async (req, res) => {
      const { tarea } = req.valid;
      const result = await runners[tarea]();
      log.info('tareas.disparo_externo', { request: req.id, tarea, omitida: Boolean(result?.skipped) });
      res.json({ tarea, ok: result?.ok !== false, omitida: Boolean(result?.skipped), resultado: result?.result ?? result });
    },
  };
}
