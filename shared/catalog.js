/**
 * Catálogo y reglas de negocio — FUENTE ÚNICA DE VERDAD.
 * Lo importan el servidor (validación y cálculo de disponibilidad) y la página (para mostrar precios),
 * así los dos nunca se desincronizan. Todas las horas son minutos desde medianoche, en la zona horaria BUSINESS.timezone.
 */

export const BUSINESS = Object.freeze({
  timezone: 'America/Puerto_Rico', // ÚNICA zona horaria del sistema (UTC-4 todo el año, sin horario de verano): reglas, plazos, correos y tareas
  openMin: 8 * 60,                 // 8:00 a.m.
  closeMin: 17 * 60,               // 5:00 p.m.: el servicio debe TERMINAR (por duración) antes de esta hora
  slotMin: 30,                     // las citas empiezan cada 30 minutos
  // Valor INICIAL de los días de operación (0 = domingo). La verdad vive en la base de datos (tabla `configuracion`) y el
  // administrador la cambia desde el panel; ni los sábados son siempre laborables ni los domingos siempre festivos.
  defaultOpenDays: Object.freeze([3, 4, 5, 6, 0]),
  bookAheadDays: 60,               // cuántos días hacia adelante se puede reservar
  agendaClosedFromMin: 23 * 60,    // la agenda se cierra de 11:00 p.m. ...
  agendaClosedUntilMin: 6 * 60,    // ... a 6:00 a.m. (no se crean ni cambian citas)
});

export const VEHICLES = Object.freeze({ auto: 'Auto', suv: 'SUV', pickup: 'Pickup' });

/**
 * duracionMin = lo que dura el servicio (la hora de fin que ve el cliente).
 * bloqueMin   = lo que se bloquea en la agenda (duración + margen de traslado y preparación).
 * Para bloquear solo la duración, iguala bloqueMin a duracionMin.
 */
export const SERVICES = Object.freeze({
  1: Object.freeze({ id: 1, codigo: 'exterior', nombre: 'Servicio #1 · Exterior', corto: 'Exterior', duracionMin: 90, bloqueMin: 120, incluye: 'Lavado exterior, brillo de goma, cera líquida, flushing y entre puertas' }),
  2: Object.freeze({ id: 2, codigo: 'completo', nombre: 'Servicio #2 · Completo', corto: 'Completo', duracionMin: 150, bloqueMin: 180, incluye: 'Todo lo del #1 + limpieza interior y cristales por dentro y por fuera' }),
});

/** [monto, esDesde]. Todos los precios son "desde": dependen del tamaño y la condición del vehículo. */
export const PRICES = Object.freeze({
  auto:   Object.freeze({ 1: [25, true], 2: [35, true] }),
  suv:    Object.freeze({ 1: [35, true], 2: [45, true] }),
  pickup: Object.freeze({ 1: [45, true], 2: [50, true] }),
});

export function priceOf(vehicle, service) {
  const [amount, from] = PRICES[vehicle][service];
  return { amount, from, text: (from ? 'desde ' : '') + '$' + amount };
}

/** Última hora de inicio posible (minutos) para un servicio: debe terminar antes del cierre. */
export const lastStartMin = (serviceId, closeMin = BUSINESS.closeMin) => closeMin - SERVICES[serviceId].duracionMin;

/** Horas de inicio válidas (minutos) de un servicio, cada `slotMin`. */
/** `hours` = { openMin, closeMin }: el horario vigente (el propietario lo cambia desde el panel); por defecto, el del catálogo. */
export function startTimes(serviceId, hours = BUSINESS) {
  const out = [];
  for (let m = hours.openMin; m <= lastStartMin(serviceId, hours.closeMin); m += BUSINESS.slotMin) out.push(m);
  return out;
}
