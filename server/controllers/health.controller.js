/** Chequeos de salud. `salud` = el proceso responde. `listo` = además la base de datos y la configuración sirven. */
export function createHealthController({ db, outbox, mailer, env, clock }) {
  function snapshot() {
    const oldest = outbox.oldestPendingAt();
    const ageMin = oldest ? Math.round((clock() - Date.parse(oldest)) / 60e3) : 0;
    const counts = outbox.counts();
    const degradado = !mailer.configured || !env.OWNER_EMAIL || ageMin > 15 || (counts.fallido ?? 0) > 0;
    return { ageMin, counts, degradado };
  }

  return {
    salud: (_req, res) => res.json({ ok: true }),

    listo: (_req, res) => {
      let dbOk = false;
      try { dbOk = db.prepare('SELECT 1 AS ok').get().ok === 1; } catch { /* se reporta abajo */ }
      if (!dbOk) return res.status(503).json({ estado: 'caido', baseDeDatos: false });

      // Público: solo el estado general. El detalle (configuración, colas) está en /api/admin/estado.
      res.json({ estado: snapshot().degradado ? 'degradado' : 'ok' });
    },

    estado: (_req, res) => {
      const s = snapshot();
      res.json({
        estado: s.degradado ? 'degradado' : 'ok',
        correo: mailer.configured ? 'configurado' : 'no_configurado',
        correoDueno: env.OWNER_EMAIL ? 'configurado' : 'pendiente',
        correosPendientes: s.counts.pendiente ?? 0,
        correosFallidos: s.counts.fallido ?? 0,
        pendienteMasAntiguoMin: s.ageMin,
        ultimoResumen: outbox.lastOkRun('resumen_diario'),
        ultimaLimpieza: outbox.lastOkRun('limpieza_semanal'),
        ultimoRespaldo: outbox.lastOkRun('respaldo'),
      });
    },
  };
}
