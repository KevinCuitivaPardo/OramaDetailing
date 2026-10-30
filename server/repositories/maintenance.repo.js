/**
 * Consultas de mantenimiento (limpieza semanal). Todas con SQL parametrizado.
 * Cada borrado repite sus guardas en el WHERE: NUNCA toca reservas confirmadas vigentes ni de fechas desde el corte en adelante,
 * y nunca toca `clientes`, `configuracion`, `calendario_dias`, `servicios`, `precios` ni el historial administrativo.
 */
const ELIGIBLE = `fecha < @corte AND fecha <= @hoy AND (estado IN ('completada', 'no_llego', 'cancelada') OR estado = 'confirmada')`;

export function createMaintenanceRepo(db) {
  const q = {
    // Candidatas: semanas ya finalizadas. Las 'confirmada' vencidas se marcarían como realizadas y se borran con las demás.
    candidates: db.prepare(`SELECT id, codigo, fecha, estado FROM reservas WHERE ${ELIGIBLE} ORDER BY fecha, id LIMIT @limit`),
    countCandidates: db.prepare(`SELECT estado, COUNT(*) AS n, MIN(fecha) AS desde, MAX(fecha) AS hasta FROM reservas WHERE ${ELIGIBLE} GROUP BY estado`),
    kept: db.prepare(`SELECT COUNT(*) AS n FROM reservas WHERE NOT (${ELIGIBLE})`),
    keptActiveFuture: db.prepare("SELECT COUNT(*) AS n FROM reservas WHERE estado = 'confirmada' AND fecha >= @corte"),
    total: db.prepare('SELECT COUNT(*) AS n FROM reservas'),
    markDone: db.prepare("UPDATE reservas SET estado = 'completada', actualizada_en = @ts WHERE estado = 'confirmada' AND fecha < @corte AND fecha <= @hoy"),
    scrub: (n) => db.prepare(`
      UPDATE reservas SET correo_enc = NULL, correo_mac = NULL, lugar_enc = NULL, modelo_enc = NULL, idem_key = NULL, idem_hash = NULL, token_hash = 'borrado'
      WHERE id IN (${Array(n).fill('?').join(',')}) AND estado <> 'confirmada' AND fecha < ? AND fecha <= ?`),
    // Solo se borran los correos YA resueltos; uno pendiente nunca se pierde (su reserva_id pasa a NULL al borrar la reserva)
    delOutboxOf: (n) => db.prepare(`DELETE FROM outbox_correos WHERE estado IN ('enviado', 'fallido') AND reserva_id IN (${Array(n).fill('?').join(',')})`),
    delReservas: (n) => db.prepare(`
      DELETE FROM reservas WHERE id IN (${Array(n).fill('?').join(',')})
        AND estado IN ('completada', 'no_llego', 'cancelada') AND fecha < ? AND fecha <= ?`),

    pastSlots: db.prepare('DELETE FROM reserva_slots WHERE fecha < ?'),
    countPastSlots: db.prepare('SELECT COUNT(*) AS n FROM reserva_slots WHERE fecha < ?'),
    oldIdem: db.prepare('UPDATE reservas SET idem_key = NULL, idem_hash = NULL WHERE idem_key IS NOT NULL AND creada_en < ?'),
    oldSent: db.prepare("DELETE FROM outbox_correos WHERE estado = 'enviado' AND enviado_en < ?"),
    oldFailed: db.prepare("DELETE FROM outbox_correos WHERE estado = 'fallido' AND creado_en < ?"),
    oldJobs: db.prepare('DELETE FROM job_runs WHERE iniciado < ?'),
    oldActions: db.prepare('DELETE FROM acciones_pendientes WHERE expira_en < ?'),
    lastJob: db.prepare('SELECT MAX(iniciado) AS t FROM job_runs'),
    lastCreated: db.prepare('SELECT MAX(creada_en) AS t FROM reservas'),
  };

  return {
    candidates: (p) => q.candidates.all({ ...p, limit: p.limit ?? 100000 }),
    countByState: (p) => q.countCandidates.all(p),
    countKept: (p) => q.kept.get(p).n,
    countActiveFuture: (corte) => q.keptActiveFuture.get({ corte }).n,
    countTotal: () => q.total.get().n,
    markPastAsDone: (p) => q.markDone.run(p).changes,
    /** Sobrescribe lo propio de cada cita y luego la borra (y, por cascada, sus casilleros e historial). Devuelve cuántas borró. */
    purgeReservations(ids, { corte, hoy }) {
      if (!ids.length) return 0;
      q.scrub(ids.length).run(...ids, corte, hoy);
      q.delOutboxOf(ids.length).run(...ids);
      return q.delReservas(ids.length).run(...ids, corte, hoy).changes;
    },
    deletePastSlots: (hoy) => q.pastSlots.run(hoy).changes,
    countPastSlots: (hoy) => q.countPastSlots.get(hoy).n,
    clearOldIdempotency: (before) => q.oldIdem.run(before).changes,
    deleteOldSentEmails: (before) => q.oldSent.run(before).changes,
    deleteOldFailedEmails: (before) => q.oldFailed.run(before).changes,
    deleteExpiredActions: (before) => q.oldActions.run(before).changes,
    deleteOldJobRuns: (before) => q.oldJobs.run(before).changes,
    /** Última evidencia de que el reloj del servidor era correcto: tareas ejecutadas o reservas creadas. */
    lastClockEvidence: () => [q.lastJob.get().t, q.lastCreated.get().t].filter(Boolean).sort().at(-1) ?? null,
  };
}
