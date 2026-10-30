import { BUSINESS, SERVICES, startTimes } from '../../shared/catalog.js';
import { addDays, diffDays, fmtHHMM, fmtHora, isValidDate, zoneNow } from '../utils/time.js';

const SLOT = BUSINESS.slotMin;

/** Casilleros de 30 min que ocupa un bloque [inicio, inicio + bloque): p. ej. 8:00 + 3 h → [16, 22). */
export const slotRange = (inicioMin, bloqueMin) => ({ first: inicioMin / SLOT, end: Math.ceil((inicioMin + bloqueMin) / SLOT) });

/** Rango de fechas reservables en línea: desde mañana hasta `bookAheadDays` días. El mismo día se atiende por WhatsApp. */
export function bookingWindow(nowMs) {
  const hoy = zoneNow(nowMs).fecha;
  return { desde: addDays(hoy, 1), hasta: addDays(hoy, BUSINESS.bookAheadDays), hoy };
}

/** Motivo por el que una fecha no se puede reservar en línea (o null si sí). */
export function dateProblem(fecha, nowMs, isOpen) {
  if (!isValidDate(fecha)) return 'FECHA_INVALIDA';
  const { desde, hasta } = bookingWindow(nowMs);
  if (diffDays(desde, fecha) < 0) return 'FECHA_PASADA_O_HOY';
  if (diffDays(hasta, fecha) > 0) return 'FECHA_MUY_LEJANA';
  if (!isOpen(fecha)) return 'DIA_NO_LABORABLE';
  return null;
}

/**
 * Horas de inicio libres para un servicio, dado el conjunto de casilleros ocupados.
 * No basta con "ocultar el horario elegido": una hora es libre solo si TODOS los casilleros de su bloque están libres,
 * así una reserva de 8:00 (bloque de 3 h) deja sin disponibilidad también 8:30, 9:00 … y 7:30 si el nuevo bloque la pisaría.
 */
export function freeStarts(occupied, serviceId, hours) {
  const svc = SERVICES[serviceId];
  const out = [];
  for (const inicio of startTimes(serviceId, hours)) {
    const { first, end } = slotRange(inicio, svc.bloqueMin);
    let free = true;
    for (let s = first; s < end; s++) if (occupied.has(s)) { free = false; break; }
    if (free) out.push(inicio);
  }
  return out;
}

export const hourView = (inicioMin, serviceId) => ({
  inicioMin, valor: fmtHHMM(inicioMin), finMin: inicioMin + SERVICES[serviceId].duracionMin,
  inicio: fmtHora(inicioMin), fin: fmtHora(inicioMin + SERVICES[serviceId].duracionMin),
});

export function createAvailabilityService({ reservas, calendar, config, clock = Date.now }) {
  const problemOf = (fecha, nowMs) => dateProblem(fecha, nowMs, calendar.isOpen);
  return {
    /** Motivo por el que una fecha no se puede reservar en línea (null si sí). Usa el calendario configurado. */
    dateProblem: problemOf,
    /** Disponibilidad real de un día para un servicio. */
    day({ fecha, servicioId, excludeReservaId = null }) {
      const nowMs = clock();
      if (!config.isServiceActive(servicioId)) return { fecha, reservable: false, motivo: 'SERVICIO_INACTIVO', agotado: false, horas: [] };
      const problem = problemOf(fecha, nowMs);
      if (problem) return { fecha, reservable: false, motivo: problem, agotado: false, horas: [] };
      const occupied = reservas.occupiedSlots(fecha);
      // Al cambiar una cita, su propio bloque cuenta como libre (así puede moverse 30 min sin chocar consigo misma)
      if (excludeReservaId) for (const s of reservas.slotsOfReservation(excludeReservaId, fecha)) occupied.delete(s);
      for (const s of calendar.blockedSlots(fecha)) occupied.add(s); // almuerzo y bloqueos del propietario
      const horas = freeStarts(occupied, servicioId, calendar.hours()).map((m) => hourView(m, servicioId));
      return { fecha, reservable: true, motivo: null, agotado: horas.length === 0, horas };
    },

    /** Estado de cada día de un mes (para pintar el calendario con una sola consulta). */
    month({ mes, servicioId }) {
      const nowMs = clock();
      const [y, m] = mes.split('-').map(Number);
      const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const first = `${mes}-01`, last = `${mes}-${String(days).padStart(2, '0')}`;
      const occupied = reservas.occupiedSlotsRange(first, last);
      const dias = {};
      const serviceOn = config.isServiceActive(servicioId);
      const hrs = calendar.hours();
      for (let d = 1; d <= days; d++) {
        const fecha = `${mes}-${String(d).padStart(2, '0')}`;
        if (!serviceOn) { dias[fecha] = { estado: 'cerrado' }; continue; }
        const problem = problemOf(fecha, nowMs);
        if (problem) { dias[fecha] = { estado: problem === 'DIA_NO_LABORABLE' ? 'cerrado' : 'fuera_de_rango' }; continue; }
        const taken = new Set(occupied.get(fecha) ?? []);
        for (const s of calendar.blockedSlots(fecha)) taken.add(s);
        const libres = freeStarts(taken, servicioId, hrs).length;
        dias[fecha] = libres ? { estado: 'disponible', libres } : { estado: 'agotado', libres: 0 };
      }
      return { mes, dias };
    },
  };
}
