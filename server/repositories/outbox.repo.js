/** Cola de correos (outbox) y registro de tareas programadas. SQL parametrizado, sin reglas de negocio. */
export function createOutboxRepo(db) {
  const q = {
    enqueue: db.prepare(`
      INSERT INTO outbox_correos (tipo, dedupe_key, reserva_id, destinatario_enc, destino_mac, payload_enc, proximo_intento, creado_en)
      VALUES (@tipo, @dedupe_key, @reserva_id, @destinatario_enc, @destino_mac, @payload_enc, @ts, @ts)
      ON CONFLICT (dedupe_key) DO NOTHING`),
    // Reclama lote: pendientes vencidos, o "enviando" cuyo candado expiró (el proceso murió a mitad del envío)
    claim: db.prepare(`
      UPDATE outbox_correos SET estado = 'enviando', intentos = intentos + 1, bloqueado_hasta = @lease
      WHERE id IN (
        SELECT id FROM outbox_correos
        WHERE (estado = 'pendiente' AND proximo_intento <= @now) OR (estado = 'enviando' AND bloqueado_hasta <= @now)
        ORDER BY id LIMIT @limit)
      RETURNING *`),
    // Al enviarse, el correo ya no necesita su contenido: se borra (incluye el enlace personal de gestión)
    markSent: db.prepare(`UPDATE outbox_correos SET estado = 'enviado', enviado_en = @ts, bloqueado_hasta = NULL, ultimo_error = NULL, payload_enc = '-', destinatario_enc = '-' WHERE id = @id`),
    failExhausted: db.prepare(`UPDATE outbox_correos SET estado = 'fallido', bloqueado_hasta = NULL, ultimo_error = 'Se agotaron los intentos (el proceso se detuvo durante el envío)' WHERE estado = 'enviando' AND bloqueado_hasta <= @now AND intentos >= @max`),
    countToAddress: db.prepare('SELECT COUNT(*) AS n FROM outbox_correos WHERE destino_mac = ? AND creado_en >= ?'),
    requeueFailed: db.prepare("UPDATE outbox_correos SET estado = 'pendiente', intentos = 0, proximo_intento = @ts, ultimo_error = NULL WHERE estado = 'fallido' AND payload_enc <> '-'"),
    lastOkRun: db.prepare("SELECT MAX(iniciado) AS t FROM job_runs WHERE job = ? AND estado = 'ok'"),
    markRetry: db.prepare(`UPDATE outbox_correos SET estado = 'pendiente', proximo_intento = @next, bloqueado_hasta = NULL, ultimo_error = @error WHERE id = @id`),
    markFailed: db.prepare(`UPDATE outbox_correos SET estado = 'fallido', bloqueado_hasta = NULL, ultimo_error = @error WHERE id = @id`),
    // Devuelve el correo a la cola SIN gastar un intento (p. ej. credenciales de Gmail rechazadas)
    release: db.prepare(`UPDATE outbox_correos SET estado = 'pendiente', intentos = MAX(intentos - 1, 0), proximo_intento = @next, bloqueado_hasta = NULL, ultimo_error = @error WHERE id = @id`),
    failedList: db.prepare("SELECT id, tipo, reserva_id, intentos, ultimo_error, creado_en FROM outbox_correos WHERE estado = 'fallido' ORDER BY id DESC LIMIT 50"),
    recent: db.prepare('SELECT id, tipo, estado, intentos, creado_en, enviado_en, proximo_intento, ultimo_error FROM outbox_correos ORDER BY id DESC LIMIT ?'),
    oldestPending: db.prepare("SELECT MIN(creado_en) AS t FROM outbox_correos WHERE estado IN ('pendiente', 'enviando')"),
    counts: db.prepare('SELECT estado, COUNT(*) AS n FROM outbox_correos GROUP BY estado'),
    byKey: db.prepare('SELECT * FROM outbox_correos WHERE dedupe_key = ?'),
    // trabajos
    jobStart: db.prepare(`
      INSERT INTO job_runs (job, run_key, estado, iniciado) VALUES (@job, @run_key, 'en_curso', @ts)
      ON CONFLICT (job, run_key) DO UPDATE SET estado = 'en_curso', iniciado = @ts, terminado = NULL, detalle = NULL
        WHERE job_runs.estado = 'error' OR (job_runs.estado = 'en_curso' AND job_runs.iniciado < @stale)`),
    jobEnd: db.prepare(`UPDATE job_runs SET estado = @estado, terminado = @ts, detalle = @detalle WHERE job = @job AND run_key = @run_key`),
    jobGet: db.prepare('SELECT * FROM job_runs WHERE job = ? AND run_key = ?'),
  };

  return {
    /** Encola un correo. Devuelve false si ya existía uno con la misma dedupe_key (idempotente). */
    enqueue: (row) => q.enqueue.run(row).changes === 1,
    claim: (now, limit, leaseMs) => q.claim.all({ now, limit, lease: new Date(Date.parse(now) + leaseMs).toISOString() }),
    markSent: (id, ts) => q.markSent.run({ id, ts }),
    markRetry: (id, next, error) => q.markRetry.run({ id, next, error }),
    markFailed: (id, error) => q.markFailed.run({ id, error }),
    release: (id, next, error) => q.release.run({ id, next, error }),
    failExhausted: (now, max) => q.failExhausted.run({ now, max }).changes,
    countToAddress: (mac, sinceIso) => q.countToAddress.get(mac, sinceIso).n,
    requeueFailed: (ts) => q.requeueFailed.run({ ts }).changes,
    lastOkRun: (job) => q.lastOkRun.get(job).t,
    failedList: () => q.failedList.all(),
    recent: (n = 100) => q.recent.all(n),
    oldestPendingAt: () => q.oldestPending.get().t,
    counts: () => Object.fromEntries(q.counts.all().map((r) => [r.estado, r.n])),
    byKey: (k) => q.byKey.get(k),
    /** true si esta ejecución "ganó" el derecho a correr (ya no está hecha ni en curso). */
    jobStart: (job, runKey, ts, staleBefore) => q.jobStart.run({ job, run_key: runKey, ts, stale: staleBefore }).changes === 1,
    jobEnd: (job, runKey, estado, ts, detalle) => q.jobEnd.run({ job, run_key: runKey, estado, ts, detalle: detalle ?? null }),
    jobGet: (job, runKey) => q.jobGet.get(job, runKey),
  };
}
