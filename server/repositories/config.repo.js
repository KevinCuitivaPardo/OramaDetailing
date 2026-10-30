/** Configuración editable por el administrador, calendario, historial de limpieza y auditoría. SQL parametrizado. */
export function createConfigRepo(db) {
  const q = {
    get: db.prepare('SELECT valor FROM configuracion WHERE clave = ?'),
    set: db.prepare(`INSERT INTO configuracion (clave, valor, actualizado_en) VALUES (@clave, @valor, @ts)
      ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`),
    seed: db.prepare('INSERT OR IGNORE INTO configuracion (clave, valor, actualizado_en) VALUES (@clave, @valor, @ts)'),
    day: db.prepare('SELECT fecha, tipo, motivo FROM calendario_dias WHERE fecha = ?'),
    days: db.prepare('SELECT fecha, tipo, motivo FROM calendario_dias WHERE fecha >= ? AND fecha <= ? ORDER BY fecha'),
    setDay: db.prepare(`INSERT INTO calendario_dias (fecha, tipo, motivo, creado_en) VALUES (@fecha, @tipo, @motivo, @ts)
      ON CONFLICT (fecha) DO UPDATE SET tipo = excluded.tipo, motivo = excluded.motivo`),
    delDay: db.prepare('DELETE FROM calendario_dias WHERE fecha = ?'),
    cleanStart: db.prepare("INSERT INTO limpieza_ejecuciones (inicio, modo, estado, corte_fecha, actor) VALUES (@ts, @modo, 'en_curso', @corte, @actor)"),
    cleanEnd: db.prepare('UPDATE limpieza_ejecuciones SET fin = @ts, estado = @estado, resumen = @resumen, error = @error WHERE id = @id'),
    cleanRecent: db.prepare('SELECT id, inicio, fin, modo, estado, corte_fecha, resumen, error, actor FROM limpieza_ejecuciones ORDER BY id DESC LIMIT ?'),
    cleanLast: db.prepare("SELECT id, inicio, fin, modo, estado, corte_fecha, resumen, error, actor FROM limpieza_ejecuciones WHERE modo <> 'simulacion' AND estado <> 'en_curso' ORDER BY id DESC LIMIT 1"),
    cleanTrim: db.prepare('DELETE FROM limpieza_ejecuciones WHERE id NOT IN (SELECT id FROM limpieza_ejecuciones ORDER BY id DESC LIMIT 200)'),
    audit: db.prepare('INSERT INTO auditoria_admin (ts, accion, detalle, request_id) VALUES (@ts, @accion, @detalle, @request_id)'),
    auditRecent: db.prepare('SELECT ts, accion, detalle FROM auditoria_admin ORDER BY id DESC LIMIT ?'),
    auditTrim: db.prepare('DELETE FROM auditoria_admin WHERE ts < ?'),
    services: db.prepare('SELECT id, codigo, nombre, duracion_min, bloque_min, activo FROM servicios ORDER BY id'),
    serviceActive: db.prepare('SELECT activo FROM servicios WHERE id = ?'),
    setServiceActive: db.prepare('UPDATE servicios SET activo = ? WHERE id = ?'),
    blocksFor: db.prepare('SELECT desde_min, hasta_min FROM bloqueos_horario WHERE fecha = @fecha OR dia_semana = @dow OR (fecha IS NULL AND dia_semana IS NULL)'),
    blocksList: db.prepare('SELECT id, fecha, dia_semana, desde_min, hasta_min, motivo FROM bloqueos_horario WHERE fecha IS NULL OR fecha >= ? ORDER BY fecha IS NOT NULL, fecha, dia_semana, desde_min'),
    blockInsert: db.prepare('INSERT INTO bloqueos_horario (fecha, dia_semana, desde_min, hasta_min, motivo, creado_en) VALUES (@fecha, @dia_semana, @desde_min, @hasta_min, @motivo, @ts)'),
    blockFind: db.prepare('SELECT id FROM bloqueos_horario WHERE fecha IS @fecha AND dia_semana IS @dia_semana AND desde_min = @desde_min AND hasta_min = @hasta_min'),
    blockDelete: db.prepare('DELETE FROM bloqueos_horario WHERE id = ?'),
    blockAffected: db.prepare(`SELECT COUNT(*) AS n FROM reservas WHERE estado = 'confirmada' AND fecha >= @desdeFecha
      AND (@fecha IS NULL OR fecha = @fecha) AND (@dow IS NULL OR CAST(strftime('%w', fecha) AS INTEGER) = @dow)
      AND inicio_min < @hasta AND bloque_fin_min > @desde`),
    activeOn: db.prepare("SELECT COUNT(*) AS n FROM reservas WHERE fecha = ? AND estado = 'confirmada'"),
  };
  const parse = (r) => (r ? { ...r, resumen: r.resumen ? JSON.parse(r.resumen) : null } : null);
  return {
    get: (clave) => q.get.get(clave)?.valor ?? null,
    set: (clave, valor, ts) => { q.set.run({ clave, valor: String(valor), ts }); },
    seed: (clave, valor, ts) => { q.seed.run({ clave, valor: String(valor), ts }); },
    day: (fecha) => q.day.get(fecha) ?? null,
    days: (from, to) => q.days.all(from, to),
    setDay: (row) => { q.setDay.run(row); },
    deleteDay: (fecha) => q.delDay.run(fecha).changes,
    services: () => q.services.all(),
    isServiceActive: (id) => q.serviceActive.get(id)?.activo === 1,
    setServiceActive: (id, on) => q.setServiceActive.run(on ? 1 : 0, id).changes,
    blocksFor: (fecha, dow) => q.blocksFor.all({ fecha, dow }),
    blocksList: (desdeFecha) => q.blocksList.all(desdeFecha),
    blockInsert: (row) => Number(q.blockInsert.run(row).lastInsertRowid),
    blockFind: (r) => q.blockFind.get({ fecha: r.fecha, dia_semana: r.dia_semana, desde_min: r.desde_min, hasta_min: r.hasta_min })?.id ?? null,
    blockDelete: (id) => q.blockDelete.run(id).changes,
    blockAffected: (p) => q.blockAffected.get(p).n,
    activeReservationsOn: (fecha) => q.activeOn.get(fecha).n,
    cleanupStart: (p) => Number(q.cleanStart.run(p).lastInsertRowid),
    cleanupEnd: (p) => { q.cleanEnd.run({ id: p.id, ts: p.ts, estado: p.estado, resumen: p.resumen ? JSON.stringify(p.resumen) : null, error: p.error ?? null }); q.cleanTrim.run(); },
    cleanupRecent: (n = 20) => q.cleanRecent.all(n).map(parse),
    cleanupLast: () => parse(q.cleanLast.get()),
    audit: (p) => { q.audit.run({ ts: p.ts, accion: p.accion, detalle: p.detalle ?? null, request_id: p.request_id ?? null }); },
    auditRecent: (n = 50) => q.auditRecent.all(n),
    auditTrim: (before) => q.auditTrim.run(before).changes,
  };
}
