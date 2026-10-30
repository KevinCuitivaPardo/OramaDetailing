/**
 * Acceso a datos de reservas. Solo SQL parametrizado (nunca se concatena entrada del usuario).
 * No contiene reglas de negocio: eso vive en /services.
 */
const SELECT = `SELECT r.*, c.nombre_enc, c.telefono_enc, c.telefono_mac FROM reservas r LEFT JOIN clientes c ON c.id = r.cliente_id`;

export function createReservasRepo(db) {
  const q = {
    // Toda lectura une al cliente: los datos de la persona (nombre, teléfono) viven en `clientes`, no en cada reserva
    byCode: db.prepare(`${SELECT} WHERE r.codigo = ?`),
    byIdem: db.prepare(`${SELECT} WHERE r.idem_key = ?`),
    byId: db.prepare(`${SELECT} WHERE r.id = ?`),
    upsertCliente: db.prepare(`
      INSERT INTO clientes (telefono_mac, nombre_enc, telefono_enc, correo_enc, correo_mac, creado_en, actualizado_en)
      VALUES (@telefono_mac, @nombre_enc, @telefono_enc, @correo_enc, @correo_mac, @ts, @ts)
      ON CONFLICT (telefono_mac) DO UPDATE SET nombre_enc = excluded.nombre_enc, correo_enc = excluded.correo_enc,
        correo_mac = excluded.correo_mac, actualizado_en = excluded.actualizado_en
      RETURNING id`),
    countClientes: db.prepare('SELECT COUNT(*) AS n FROM clientes'),
    insert: db.prepare(`
      INSERT INTO reservas (codigo, cliente_id, servicio_id, vehiculo, fecha, inicio_min, fin_min, bloque_fin_min, estado,
        correo_enc, correo_mac, lugar_enc, modelo_enc,
        precio_monto, precio_desde, token_hash, idem_key, idem_hash, creada_en, actualizada_en)
      VALUES (@codigo, @cliente_id, @servicio_id, @vehiculo, @fecha, @inicio_min, @fin_min, @bloque_fin_min, 'confirmada',
        @correo_enc, @correo_mac, @lugar_enc, @modelo_enc,
        @precio_monto, @precio_desde, @token_hash, @idem_key, @idem_hash, @ts, @ts)`),
    insertSlot: db.prepare('INSERT INTO reserva_slots (fecha, slot, reserva_id) VALUES (?, ?, ?)'),
    deleteSlots: db.prepare('DELETE FROM reserva_slots WHERE reserva_id = ?'),
    updateSchedule: db.prepare(`
      UPDATE reservas SET fecha = @fecha, inicio_min = @inicio_min, fin_min = @fin_min, bloque_fin_min = @bloque_fin_min,
        cambios = cambios + 1, actualizada_en = @ts
      WHERE id = @id AND estado = 'confirmada'`),
    cancel: db.prepare(`
      UPDATE reservas SET estado = 'cancelada', cancelada_en = @ts, cancelada_por = @por, actualizada_en = @ts
      WHERE id = @id AND estado = 'confirmada'`),
    addEvent: db.prepare('INSERT INTO reserva_eventos (reserva_id, tipo, actor, detalle, creado_en) VALUES (?, ?, ?, ?, ?)'),
    slotsOfDate: db.prepare('SELECT slot FROM reserva_slots WHERE fecha = ?'),
    slotsOfRange: db.prepare('SELECT fecha, slot FROM reserva_slots WHERE fecha >= ? AND fecha <= ?'),
    slotsOfReservation: db.prepare('SELECT slot FROM reserva_slots WHERE reserva_id = ? AND fecha = ?'),
    activeByEmail: db.prepare("SELECT COUNT(*) AS n FROM reservas WHERE correo_mac = ? AND estado = 'confirmada' AND fecha >= ?"),
    byClient: db.prepare("SELECT r.id, r.codigo, r.fecha, r.estado FROM reservas r JOIN clientes c ON c.id = r.cliente_id WHERE c.telefono_mac = ? ORDER BY r.fecha DESC LIMIT 50"),
    createdSince: db.prepare('SELECT COUNT(*) AS n FROM reservas WHERE creada_en >= ?'),
    // Al cancelar se borran los datos propios de la cita. El registro del cliente (`clientes`) se conserva.
    scrubPersonal: db.prepare("UPDATE reservas SET correo_enc = NULL, correo_mac = NULL, lugar_enc = NULL, modelo_enc = NULL WHERE id = ? AND estado <> 'confirmada'"),
    integrityGaps: db.prepare(`
      SELECT r.codigo FROM reservas r WHERE r.estado = 'confirmada'
        AND (SELECT COUNT(*) FROM reserva_slots s WHERE s.reserva_id = r.id AND s.fecha = r.fecha) <> ((r.bloque_fin_min - r.inicio_min + 29) / 30)`),
    orphanSlots: db.prepare("SELECT COUNT(*) AS n FROM reserva_slots s JOIN reservas r ON r.id = s.reserva_id WHERE r.estado <> 'confirmada'"),
    activeByPhone: db.prepare("SELECT COUNT(*) AS n FROM reservas r JOIN clientes c ON c.id = r.cliente_id WHERE c.telefono_mac = ? AND r.estado = 'confirmada' AND r.fecha >= ?"),
    agenda: db.prepare(`
      SELECT r.*, c.nombre_enc, c.telefono_enc, c.telefono_mac, s.nombre AS servicio_nombre
      FROM reservas r JOIN servicios s ON s.id = r.servicio_id LEFT JOIN clientes c ON c.id = r.cliente_id
      WHERE r.fecha = ? AND r.estado = 'confirmada' ORDER BY r.inicio_min ASC, r.id ASC`),
    pendingOpen: db.prepare("SELECT * FROM acciones_pendientes WHERE reserva_id = ? AND tipo = ? AND usada_en IS NULL AND expira_en > ? ORDER BY id DESC LIMIT 1"),
    pendingInsert: db.prepare('INSERT INTO acciones_pendientes (reserva_id, tipo, fecha_nueva, inicio_nuevo_min, token_hash, creada_en, expira_en) VALUES (@reserva_id, @tipo, @fecha_nueva, @inicio_nuevo_min, @token_hash, @ts, @expira_en)'),
    pendingDeleteOpen: db.prepare('DELETE FROM acciones_pendientes WHERE reserva_id = ? AND tipo = ? AND usada_en IS NULL'),
    pendingDeleteAllOpen: db.prepare('DELETE FROM acciones_pendientes WHERE reserva_id = ? AND usada_en IS NULL'),
    pendingByHash: db.prepare('SELECT * FROM acciones_pendientes WHERE token_hash = ?'),
    pendingMarkUsed: db.prepare('UPDATE acciones_pendientes SET usada_en = ? WHERE id = ? AND usada_en IS NULL'),
    pendingPurge: db.prepare('DELETE FROM acciones_pendientes WHERE expira_en < ?'),
    activeOn: db.prepare("SELECT COUNT(*) AS n FROM reservas WHERE fecha = ? AND estado = 'confirmada'"),
  };

  return {
    findByCode: (codigo) => q.byCode.get(codigo),
    findByIdemKey: (key) => q.byIdem.get(key),
    findById: (id) => q.byId.get(id),
    insert(row) { return Number(q.insert.run(row).lastInsertRowid); },
    /** Registra al cliente (o actualiza sus datos de contacto si ya existía) y devuelve su id. */
    upsertCliente: (row) => q.upsertCliente.get(row).id,
    countClientes: () => q.countClientes.get().n,
    byClient: (telefonoMac) => q.byClient.all(telefonoMac),
    pendingOpen: (reservaId, tipo, nowIso) => q.pendingOpen.get(reservaId, tipo, nowIso),
    pendingInsert: (row) => { q.pendingInsert.run(row); },
    pendingDeleteOpen: (reservaId, tipo) => q.pendingDeleteOpen.run(reservaId, tipo).changes,
    pendingDeleteAllOpen: (reservaId) => q.pendingDeleteAllOpen.run(reservaId).changes,
    pendingByHash: (hash) => q.pendingByHash.get(hash),
    pendingMarkUsed: (id, ts) => q.pendingMarkUsed.run(ts, id).changes,
    pendingPurge: (beforeIso) => q.pendingPurge.run(beforeIso).changes,
    countActiveOn: (fecha) => q.activeOn.get(fecha).n,
    insertSlots(reservaId, fecha, firstSlot, lastSlotExclusive) {
      for (let s = firstSlot; s < lastSlotExclusive; s++) q.insertSlot.run(fecha, s, reservaId); // UNIQUE(fecha, slot) frena duplicados
    },
    deleteSlots: (reservaId) => q.deleteSlots.run(reservaId).changes,
    updateSchedule: (p) => q.updateSchedule.run(p).changes,
    cancel: (p) => q.cancel.run(p).changes,
    addEvent: (reservaId, tipo, actor, detalle, ts) => q.addEvent.run(reservaId, tipo, actor, detalle ?? null, ts),
    occupiedSlots: (fecha) => new Set(q.slotsOfDate.all(fecha).map((r) => r.slot)),
    /** Casilleros ocupados de un rango de fechas, agrupados por día. */
    occupiedSlotsRange(from, to) {
      const out = new Map();
      for (const r of q.slotsOfRange.all(from, to)) {
        if (!out.has(r.fecha)) out.set(r.fecha, new Set());
        out.get(r.fecha).add(r.slot);
      }
      return out;
    },
    agendaOf: (fecha) => q.agenda.all(fecha),
    slotsOfReservation: (id, fecha) => new Set(q.slotsOfReservation.all(id, fecha).map((r) => r.slot)),
    countActiveByEmail: (mac, desdeFecha) => q.activeByEmail.get(mac, desdeFecha).n,
    countCreatedSince: (isoTs) => q.createdSince.get(isoTs).n,
    scrubPersonal: (id) => q.scrubPersonal.run(id).changes,
    /** Reservas confirmadas con un número de casilleros distinto al esperado (debería ser siempre vacío). */
    integrityGaps: () => q.integrityGaps.all().map((r) => r.codigo),
    orphanSlots: () => q.orphanSlots.get().n,
    countActiveByPhone: (mac, desdeFecha) => q.activeByPhone.get(mac, desdeFecha).n,
  };
}
