import { BUSINESS, PRICES, SERVICES, VEHICLES, startTimes } from '../../shared/catalog.js';
import { inTransaction, isBusy, isStorageProblem, isUniqueViolation } from '../db/connection.js';
import { E } from '../utils/errors.js';
import { newManageToken, newReservationCode, normalizeCode, maskEmail, maskPhone, safeEqual, sha256 } from '../utils/secure.js';
import { diaNombre, fmtFechaLarga, fmtHHMM, fmtHora, isAgendaClosed, parseHHMM, toEpoch } from '../utils/time.js';
import { bookingWindow, slotRange } from './availability.service.js';
import { zoneNow } from '../utils/time.js';

const PROBLEM_MESSAGES = {
  FECHA_INVALIDA: 'La fecha no es válida.',
  FECHA_PASADA_O_HOY: 'Las citas en línea se agendan desde el día siguiente. Para el mismo día, escríbenos por WhatsApp.',
  FECHA_MUY_LEJANA: `Solo se puede reservar hasta ${BUSINESS.bookAheadDays} días hacia adelante.`,
  DIA_NO_LABORABLE: 'Ese día no hay servicio. Elige otra fecha o escríbenos por WhatsApp.',
};

/**
 * Reglas de negocio de las reservas. Todo lo que cambia datos ocurre dentro de una transacción de escritura
 * (BEGIN IMMEDIATE) y la base de datos tiene la última palabra (UNIQUE de casilleros): aunque dos solicitudes
 * lleguen al mismo milisegundo, solo una puede ocupar el horario.
 */
export function createReservationsService({ db, reservas, availability, calendar, config, notifier, fc, env, log, clock = Date.now, onCommit = () => {} }) {
  const cutoffMs = env.CHANGE_CUTOFF_MINUTES * 60e3;
  const iso = (ms) => new Date(ms).toISOString();

  /* ───────── validaciones de negocio (las de formato ya las hizo zod en el controlador) ───────── */

  function checkSchedule({ servicioId, fecha, hora }, nowMs) {
    if (!config.isServiceActive(servicioId)) throw E.serviceInactive();
    const problem = availability.dateProblem(fecha, nowMs);
    if (problem) throw E.outOfWindow(PROBLEM_MESSAGES[problem]);
    const inicioMin = parseHHMM(hora);
    if (inicioMin == null || !startTimes(servicioId, calendar.hours()).includes(inicioMin)) {
      throw E.validation('Ese horario no existe para este servicio.', { hora: 'inválida' });
    }
    const svc = SERVICES[servicioId];
    return { inicioMin, finMin: inicioMin + svc.duracionMin, bloqueFinMin: inicioMin + svc.bloqueMin, ...slotRange(inicioMin, svc.bloqueMin) };
  }

  /** El bloque de la cita no puede tocar un bloqueo del propietario (almuerzo, etc.). Se vuelve a comprobar dentro de cada transacción. */
  function assertNotBlocked(fecha, sched) {
    const blocked = calendar.blockedSlots(fecha);
    for (let s = sched.first; s < sched.end; s++) if (blocked.has(s)) throw E.slotTaken();
  }

  /** ¿Puede el cliente cambiar/cancelar ahora? Devuelve null si sí, o el motivo. */
  function manageBlock(row, nowMs) {
    if (row.estado !== 'confirmada') return 'NO_ACTIVA';
    if (isAgendaClosed(nowMs)) return 'AGENDA_CERRADA';
    if (toEpoch(row.fecha, row.inicio_min) - nowMs < cutoffMs) return 'FUERA_DE_PLAZO';
    return null;
  }

  const assertManageable = (row, nowMs) => {
    const block = manageBlock(row, nowMs);
    if (block === 'NO_ACTIVA') throw E.notActive();
    if (block === 'AGENDA_CERRADA') throw E.agendaClosed();
    if (block === 'FUERA_DE_PLAZO') throw E.tooLate();
  };

  /* ───────── presentación: solo lo necesario, con datos de contacto enmascarados ───────── */

  function view(row, nowMs = clock()) {
    const svc = SERVICES[row.servicio_id];
    const block = manageBlock(row, nowMs);
    return {
      codigo: row.codigo, estado: row.estado,
      servicio: { id: svc.id, nombre: svc.nombre, duracionMin: row.fin_min - row.inicio_min },
      vehiculo: row.vehiculo, vehiculoNombre: VEHICLES[row.vehiculo],
      fecha: row.fecha, dia: diaNombre(row.fecha), fechaLarga: fmtFechaLarga(row.fecha),
      inicioMin: row.inicio_min, finMin: row.fin_min, inicio: fmtHora(row.inicio_min), fin: fmtHora(row.fin_min),
      // Solo una cita ACTIVA muestra datos de la persona; las canceladas o cerradas únicamente su estado
      lugar: row.lugar_enc ? fc.decrypt(row.lugar_enc) : null,
      nombre: row.estado === 'confirmada' && row.nombre_enc ? fc.decrypt(row.nombre_enc) : null,
      telefono: row.estado === 'confirmada' && row.telefono_enc ? maskPhone(fc.decrypt(row.telefono_enc)) : null,
      correo: row.correo_enc ? maskEmail(fc.decrypt(row.correo_enc)) : null,
      precio: { monto: row.precio_monto, desde: !!row.precio_desde, texto: `${row.precio_desde ? 'desde ' : ''}$${row.precio_monto}` },
      puedeGestionar: block === null, motivoNoGestion: block,
    };
  }

  /* ───────── crear ───────── */

  function create(input, { idempotencyKey, requestId } = {}) {
    const nowMs = clock(), ts = iso(nowMs);
    if (isAgendaClosed(nowMs)) throw E.agendaClosed();

    const svc = SERVICES[input.servicioId];
    const price = PRICES[input.vehiculo]?.[input.servicioId];
    if (!svc || !price) throw E.validation('Servicio o vehículo inválido.');
    const sched = checkSchedule(input, nowMs);

    const idemHash = idempotencyKey
      ? sha256(JSON.stringify([input.servicioId, input.vehiculo, input.fecha, input.hora, input.nombre, input.telefono, input.correo, input.lugar, input.modelo ?? '']))
      : null;

    let result;
    try {
      result = inTransaction(db, () => {
        // Reintento del mismo envío (doble clic, red caída): devuelve la misma reserva, no crea otra
        if (idempotencyKey) {
          const prev = reservas.findByIdemKey(idempotencyKey);
          if (prev) {
            if (prev.idem_hash !== idemHash) throw E.idemConflict();
            return { row: prev, token: null, replay: true };
          }
        }

        // La agenda pudo cerrarse (23:00) mientras esta solicitud esperaba el candado de la base de datos
        if (isAgendaClosed(clock())) throw E.agendaClosed();
        // Antiacaparamiento: un teléfono o un correo no pueden tener más de N reservas futuras activas, y hay un tope global por hora
        const today = zoneNow(nowMs).fecha;
        if (reservas.countActiveByPhone(fc.phoneMac(input.telefono), today) >= env.MAX_ACTIVE_PER_PHONE
          || reservas.countActiveByEmail(fc.emailMac(input.correo), today) >= env.MAX_ACTIVE_PER_EMAIL) throw E.limit(env.MAX_ACTIVE_PER_PHONE);
        if (reservas.countCreatedSince(new Date(nowMs - 3600e3).toISOString()) >= env.MAX_BOOKINGS_PER_HOUR) {
          log.error('reserva.pico_sospechoso', { reservasUltimaHora: env.MAX_BOOKINGS_PER_HOUR, detalle: 'Se alcanzó el tope global de reservas por hora' });
          throw E.tooMany();
        }

        // Registro del cliente (una fila por teléfono; si ya existía, se actualizan sus datos de contacto)
        const clienteId = reservas.upsertCliente({
          telefono_mac: fc.phoneMac(input.telefono), nombre_enc: fc.encrypt(input.nombre), telefono_enc: fc.encrypt(input.telefono),
          correo_enc: fc.encrypt(input.correo), correo_mac: fc.emailMac(input.correo), ts,
        });

        const token = newManageToken();
        const base = {
          cliente_id: clienteId, servicio_id: svc.id, vehiculo: input.vehiculo, fecha: input.fecha,
          inicio_min: sched.inicioMin, fin_min: sched.finMin, bloque_fin_min: sched.bloqueFinMin,
          correo_enc: fc.encrypt(input.correo), correo_mac: fc.emailMac(input.correo), lugar_enc: fc.encrypt(input.lugar), modelo_enc: input.modelo ? fc.encrypt(input.modelo) : null,
          precio_monto: price[0], precio_desde: price[1] ? 1 : 0, token_hash: sha256(token),
          idem_key: idempotencyKey ?? null, idem_hash: idemHash, ts,
        };

        let id = null;
        for (let attempt = 0; attempt < 5 && id == null; attempt++) {
          try {
            id = reservas.insert({ ...base, codigo: newReservationCode() });
          } catch (err) {
            // Código repetido (muy improbable): se genera otro. Cualquier otro error, hacia arriba.
            if (!(isUniqueViolation(err) && /reservas\.codigo/.test(err.message))) throw err;
          }
        }
        if (id == null) throw new Error('No se pudo generar un número de reserva único');

        assertNotBlocked(input.fecha, sched);
        // El candado: un casillero por cada 30 min del bloque. Si alguno ya está ocupado, la BD rechaza y se revierte todo.
        try {
          reservas.insertSlots(id, input.fecha, sched.first, sched.end);
        } catch (err) {
          if (isUniqueViolation(err)) throw E.slotTaken();
          throw err;
        }

        reservas.addEvent(id, 'creada', 'cliente', `${input.fecha} ${input.hora}`, ts);
        const row = reservas.findById(id);
        notifier.confirmacion(row, token, ts); // se escribe en la cola; el envío real ocurre después de confirmar
        return { row, token, replay: false };
      });
    } catch (err) {
      if (err?.code === 'HORARIO_NO_DISPONIBLE') {
        log.warn('reserva.intento_duplicado', { request: requestId, fecha: input.fecha, hora: input.hora, servicio: input.servicioId });
      } else if (isBusy(err) || isStorageProblem(err)) {
        log.error(isBusy(err) ? 'reserva.bd_ocupada' : 'reserva.bd_sin_espacio', { request: requestId, error: err });
        throw E.unavailable();
      }
      throw err;
    }

    if (!result.replay) {
      log.info('reserva.creada', { request: requestId, codigo: result.row.codigo, fecha: result.row.fecha });
      log.info('reserva.confirmada', { request: requestId, codigo: result.row.codigo });
      onCommit();
    } else {
      log.info('reserva.reintento_idempotente', { request: requestId, codigo: result.row.codigo });
    }
    return { reserva: view(result.row, nowMs), token: result.token, replay: result.replay };
  }

  /* ───────── acceso del cliente: código + (teléfono | token del correo) ───────── */

  // Hash de relleno para que "código inexistente" tarde lo mismo que "código con teléfono incorrecto"
  const DECOY = fc.phoneMac('0000000000');

  function authenticate({ codigo, telefono, token }) {
    const code = normalizeCode(codigo);
    const row = code ? reservas.findByCode(code) : undefined;
    let ok = false;
    if (row && row.telefono_mac) {
      if (token) ok = safeEqual(sha256(token), row.token_hash);
      else if (telefono) ok = safeEqual(fc.phoneMac(telefono), row.telefono_mac);
    } else {
      safeEqual(fc.phoneMac(telefono ?? ''), DECOY);
    }
    if (!ok) {
      log.warn('reserva.acceso_denegado', { codigoConFormatoValido: Boolean(code), existe: undefined });
      throw E.notFound(); // misma respuesta para todo fallo: no se puede averiguar qué reservas existen
    }
    return row;
  }

  const lookup = (creds) => view(authenticate(creds));

  /** Horas libres de un día para cambiar una cita propia (mismo servicio, contando como libre su bloque actual). */
  const ownAvailability = (creds, fecha) => {
    const row = authenticate(creds);
    return { servicioId: row.servicio_id, row };
  };

  /* ───────── cancelar y cambiar: lo que se hace dentro de UNA transacción ───────── */

  /** Cancela dentro de una transacción ya abierta. `actor`: 'cliente' (con plazo) o 'dueno'. */
  function cancelInTx(id, actor, nowMs, ts) {
    const fresh = reservas.findById(id);
    // Repetir una cancelación ya hecha (la respuesta se perdió en la red): éxito sin repetir correos ni cambios
    if (fresh.estado === 'cancelada') return { row: fresh, already: true };
    if (fresh.estado !== 'confirmada') throw E.notActive();
    if (actor === 'cliente') { assertManageable(fresh, nowMs); if (isAgendaClosed(clock())) throw E.agendaClosed(); }
    if (reservas.cancel({ id: fresh.id, por: actor, ts }) !== 1) throw E.notActive();
    reservas.deleteSlots(fresh.id); // el horario queda libre para otros clientes
    reservas.addEvent(fresh.id, 'cancelada', actor, null, ts);
    reservas.pendingDeleteAllOpen(fresh.id); // ningún enlace pendiente sobrevive a la cancelación
    const done = reservas.findById(fresh.id);
    notifier.cancelacion(done, actor, ts); // arma los correos con los datos del cliente...
    reservas.scrubPersonal(fresh.id);      // ...y enseguida se borran de la reserva (ya no hacen falta; se conserva solo la huella para reintentos)
    return { row: reservas.findById(fresh.id), already: false };
  }

  /** Cancelación directa: SOLO para el propietario (ruta de administración). Los clientes pasan por requestCancel + confirmAction. */
  function cancel(creds, { actor = 'dueno', requestId } = {}) {
    if (actor !== 'dueno') throw new Error('Los clientes cancelan con confirmación por correo');
    const nowMs = clock(), ts = iso(nowMs);
    const row0 = reservas.findByCode(normalizeCode(creds.codigo) ?? '');
    if (!row0) throw E.notFound();
    const result = inTransaction(db, () => cancelInTx(row0.id, actor, nowMs, ts));
    if (!result.already) {
      log.info('reserva.cancelada', { request: requestId, codigo: result.row.codigo, actor });
      onCommit();
    }
    return view(result.row, nowMs);
  }

  /** Cambia fecha/hora dentro de una transacción ya abierta (mismo servicio). */
  function rescheduleInTx(id, fecha, hora, nowMs, ts) {
    const fresh = reservas.findById(id);
    assertManageable(fresh, nowMs);
    if (isAgendaClosed(clock())) throw E.agendaClosed();
    const sched = checkSchedule({ servicioId: fresh.servicio_id, fecha, hora }, nowMs);
    // Mismo horario que ya tiene (por ejemplo, un reintento del mismo cambio): no hay nada que hacer, y no es un error
    if (fecha === fresh.fecha && sched.inicioMin === fresh.inicio_min) return { unchanged: true, row: fresh };

    if (fresh.cambios >= env.MAX_CHANGES_PER_BOOKING) throw E.tooManyChanges(env.MAX_CHANGES_PER_BOOKING);
    // Se libera el bloque anterior y se ocupa el nuevo; si el nuevo choca, la transacción se revierte y la reserva original queda intacta
    assertNotBlocked(fecha, sched);
    reservas.deleteSlots(fresh.id);
    try {
      reservas.insertSlots(fresh.id, fecha, sched.first, sched.end);
    } catch (err) {
      if (isUniqueViolation(err)) throw E.slotTaken();
      throw err;
    }
    if (reservas.updateSchedule({ id: fresh.id, fecha, inicio_min: sched.inicioMin, fin_min: sched.finMin, bloque_fin_min: sched.bloqueFinMin, ts }) !== 1) {
      throw new Error('updateSchedule no modificó la reserva'); // revierte todo: nunca quedan casilleros nuevos con la fecha vieja
    }
    reservas.addEvent(fresh.id, 'cambiada', 'cliente', `${fresh.fecha} ${fresh.inicio_min} -> ${fecha} ${sched.inicioMin}`, ts);
    reservas.pendingDeleteAllOpen(fresh.id); // los enlaces pendientes eran para el horario anterior
    const updated = reservas.findById(fresh.id);
    notifier.cambio(updated, fresh, ts);
    return { unchanged: false, row: updated };
  }

  /** Traduce los errores de base de datos comunes a respuestas seguras. */
  function guarded(fn, ctx = {}) {
    try {
      return fn();
    } catch (err) {
      if (err?.code === 'HORARIO_NO_DISPONIBLE') log.warn('reserva.cambio_choque', ctx);
      else if (isBusy(err) || isStorageProblem(err)) throw E.unavailable();
      throw err;
    }
  }

  /* ───────── segunda verificación por correo ───────── */

  const ACTION_TTL_MS = 2 * 3600e3; // el enlace del correo vence en 2 horas
  const COOLDOWN_MS = 60e3;          // no se reenvía otro correo si ya se pidió hace menos de 1 minuto

  const pendingInfo = (row, expiraEn) => ({ estado: 'pendiente_confirmacion', correo: row.correo_enc ? maskEmail(fc.decrypt(row.correo_enc)) : null, expiraEn, venceEnMin: Math.round(ACTION_TTL_MS / 60e3) });

  /** El cliente pide cancelar: se manda un correo a la dirección de la reserva; la cita NO cambia todavía. */
  function requestCancel(creds, { requestId } = {}) {
    const nowMs = clock(), ts = iso(nowMs);
    const row0 = authenticate(creds);
    assertManageable(row0, nowMs);
    const out = guarded(() => inTransaction(db, () => {
      const fresh = reservas.findById(row0.id);
      assertManageable(fresh, nowMs);
      const open = reservas.pendingOpen(fresh.id, 'cancelar', ts);
      if (open && Date.parse(open.creada_en) > nowMs - COOLDOWN_MS) return { row: fresh, expiraEn: open.expira_en, enviado: false };
      reservas.pendingDeleteOpen(fresh.id, 'cancelar');
      const token = newManageToken(), expiraEn = iso(nowMs + ACTION_TTL_MS);
      reservas.pendingInsert({ reserva_id: fresh.id, tipo: 'cancelar', fecha_nueva: null, inicio_nuevo_min: null, token_hash: sha256(token), ts, expira_en: expiraEn });
      notifier.confirmarCancelacion(fresh, token, expiraEn, ts);
      return { row: fresh, expiraEn, enviado: true };
    }), { request: requestId });
    if (out.enviado) { log.info('reserva.cancelacion_solicitada', { request: requestId, codigo: out.row.codigo }); onCommit(); }
    return { ...pendingInfo(out.row, out.expiraEn), accion: 'cancelar', reserva: view(out.row, nowMs) };
  }

  /** El cliente pide cambiar fecha/hora: se valida ahora (para avisarle ya si no hay lugar) y se manda el correo de confirmación. */
  function requestReschedule(creds, { fecha, hora }, { requestId } = {}) {
    const nowMs = clock(), ts = iso(nowMs);
    const row0 = authenticate(creds);
    assertManageable(row0, nowMs);
    const out = guarded(() => inTransaction(db, () => {
      const fresh = reservas.findById(row0.id);
      assertManageable(fresh, nowMs);
      const sched = checkSchedule({ servicioId: fresh.servicio_id, fecha, hora }, nowMs);
      if (fecha === fresh.fecha && sched.inicioMin === fresh.inicio_min) throw E.validation('Ese ya es el horario de tu cita.', { hora: 'igual al actual' });
      if (fresh.cambios >= env.MAX_CHANGES_PER_BOOKING) throw E.tooManyChanges(env.MAX_CHANGES_PER_BOOKING);
      // ¿Sigue libre? (su propio bloque cuenta como libre). Aquí NO se reserva: eso ocurre al confirmar.
      const occupied = reservas.occupiedSlots(fecha);
      for (const s of reservas.slotsOfReservation(fresh.id, fecha)) occupied.delete(s);
      for (let s = sched.first; s < sched.end; s++) if (occupied.has(s)) throw E.slotTaken();
      assertNotBlocked(fecha, sched);

      const open = reservas.pendingOpen(fresh.id, 'cambiar', ts);
      if (open && open.fecha_nueva === fecha && open.inicio_nuevo_min === sched.inicioMin && Date.parse(open.creada_en) > nowMs - COOLDOWN_MS) {
        return { row: fresh, expiraEn: open.expira_en, enviado: false, nueva: { fecha, ...sched } };
      }
      reservas.pendingDeleteOpen(fresh.id, 'cambiar');
      const token = newManageToken(), expiraEn = iso(nowMs + ACTION_TTL_MS);
      reservas.pendingInsert({ reserva_id: fresh.id, tipo: 'cambiar', fecha_nueva: fecha, inicio_nuevo_min: sched.inicioMin, token_hash: sha256(token), ts, expira_en: expiraEn });
      const nueva = { fecha, fechaLarga: fmtFechaLarga(fecha), inicio: fmtHora(sched.inicioMin), fin: fmtHora(sched.finMin) };
      notifier.confirmarCambio(fresh, nueva, token, expiraEn, ts);
      return { row: fresh, expiraEn, enviado: true, nueva: { fecha, ...sched } };
    }), { request: requestId });
    if (out.enviado) { log.info('reserva.cambio_solicitado', { request: requestId, codigo: out.row.codigo }); onCommit(); }
    return { ...pendingInfo(out.row, out.expiraEn), accion: 'cambiar', nueva: { fecha, fechaLarga: fmtFechaLarga(fecha), inicio: fmtHora(out.nueva.inicioMin), fin: fmtHora(out.nueva.finMin) }, reserva: view(out.row, nowMs) };
  }

  /** Busca la acción pendiente del enlace. Cualquier fallo de credenciales responde igual (no se puede probar códigos). */
  function loadPending({ codigo, token }, nowMs) {
    const code = normalizeCode(codigo);
    const row = code ? reservas.findByCode(code) : undefined;
    const p = reservas.pendingByHash(sha256(token));
    if (!row || !p || p.reserva_id !== row.id) { log.warn('reserva.enlace_invalido', { codigoConFormatoValido: Boolean(code) }); throw E.linkInvalid(); }
    if (p.usada_en) throw E.linkUsed();
    if (Date.parse(p.expira_en) <= nowMs) throw E.linkExpired();
    return { row, p };
  }

  /** Muestra qué hará el enlace, SIN ejecutarlo. */
  function previewAction(input) {
    const nowMs = clock();
    const { row, p } = loadPending(input, nowMs);
    if (row.estado !== 'confirmada') throw E.notActive();
    const finMin = p.inicio_nuevo_min == null ? null : p.inicio_nuevo_min + (row.fin_min - row.inicio_min);
    return {
      accion: p.tipo, expiraEn: p.expira_en, reserva: view(row, nowMs),
      nueva: p.tipo === 'cambiar' ? { fecha: p.fecha_nueva, fechaLarga: fmtFechaLarga(p.fecha_nueva), inicio: fmtHora(p.inicio_nuevo_min), fin: fmtHora(finMin) } : null,
    };
  }

  /** El cliente abrió el enlace del correo y pulsó "confirmar": ahora sí se cancela o se cambia (una sola vez, con todas las reglas). */
  function confirmAction(input, { requestId } = {}) {
    const nowMs = clock(), ts = iso(nowMs);
    const result = guarded(() => inTransaction(db, () => {
      const { row, p } = loadPending(input, nowMs); // se vuelve a leer DENTRO de la transacción: dos clics a la vez no la ejecutan dos veces
      if (reservas.pendingMarkUsed(p.id, ts) !== 1) throw E.linkUsed();
      if (p.tipo === 'cancelar') return { accion: 'cancelar', ...cancelInTx(row.id, 'cliente', nowMs, ts) };
      return { accion: 'cambiar', ...rescheduleInTx(row.id, p.fecha_nueva, fmtHHMM(p.inicio_nuevo_min), nowMs, ts) };
    }), { request: requestId });
    if (result.accion === 'cancelar' && !result.already) log.info('reserva.cancelada', { request: requestId, codigo: result.row.codigo, actor: 'cliente', via: 'correo' });
    if (result.accion === 'cambiar' && !result.unchanged) log.info('reserva.cambiada', { request: requestId, codigo: result.row.codigo, via: 'correo' });
    onCommit();
    return { accion: result.accion, reserva: view(result.row, nowMs) };
  }

  /* ───────── panel del dueño ───────── */

  function agenda(fecha) {
    return reservas.agendaOf(fecha).map((r) => ({
      codigo: r.codigo, servicio: r.servicio_nombre, vehiculo: VEHICLES[r.vehiculo], inicio: fmtHora(r.inicio_min), fin: fmtHora(r.fin_min),
      nombre: fc.decrypt(r.nombre_enc), telefono: fc.decrypt(r.telefono_enc), lugar: fc.decrypt(r.lugar_enc),
      precio: `${r.precio_desde ? 'desde ' : ''}$${r.precio_monto}`,
    }));
  }

  return { create, lookup, ownAvailability, cancel, requestCancel, requestReschedule, previewAction, confirmAction, agenda, view, bookingWindow: () => bookingWindow(clock()) };
}
