import { BUSINESS } from '../../shared/catalog.js';
import { addDays, diffDays, isValidDate, weekdayOf } from '../utils/time.js';

/**
 * Calendario de operación CENTRALIZADO. Un día es laborable así:
 *   1) si tiene una excepción en `calendario_dias`: 'abierto' → sí; 'festivo' o 'cerrado' → no;
 *   2) si no, según los días de la semana configurados (`configuracion.dias_operacion`, editable desde el panel).
 * No se asume nada: ni que los sábados abran ni que los domingos sean festivos. Se lee de la base de datos en cada
 * consulta (lecturas por clave primaria), así un cambio del administrador se aplica al instante, incluso entre procesos.
 */
const KEY = 'dias_operacion';
export const EXCEPTION_TYPES = ['festivo', 'cerrado', 'abierto'];

export function createCalendarService({ config, audit = () => {} }) {
  const parseDays = (s) => (s ? s.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : []);

  const weekdays = () => {
    const raw = config.get(KEY);
    return (raw == null ? [...BUSINESS.defaultOpenDays] : parseDays(raw)).sort((a, b) => a - b);
  };

  /** Por qué un día está abierto o cerrado (para mostrar al administrador). */
  function explain(fecha) {
    const ex = config.day(fecha);
    if (ex) return { abierto: ex.tipo === 'abierto', origen: 'excepcion', tipo: ex.tipo, motivo: ex.motivo };
    return { abierto: weekdays().includes(weekdayOf(fecha)), origen: 'semana', tipo: null, motivo: '' };
  }
  const isOpen = (fecha) => explain(fecha).abierto;

  function setWeekdays(days, ts) {
    const clean = [...new Set(days)].sort((a, b) => a - b);
    if (!clean.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) throw new Error('Días inválidos');
    config.set(KEY, clean.join(','), ts);
    audit('calendario.dias_operacion', clean.join(','));
    return clean;
  }

  function setException({ fecha, tipo, motivo = '' }, ts) {
    if (!isValidDate(fecha)) throw new Error('Fecha inválida');
    if (!EXCEPTION_TYPES.includes(tipo)) throw new Error('Tipo inválido');
    config.setDay({ fecha, tipo, motivo: String(motivo).slice(0, 120), ts });
    // Cerrar un día que ya tiene citas no las cancela (el dueño decide qué hacer con ellas): solo se avisa
    const afectadas = tipo === 'abierto' ? 0 : config.activeReservationsOn(fecha);
    audit('calendario.excepcion', `${fecha} ${tipo}`);
    return { fecha, tipo, motivo, reservasConfirmadas: afectadas };
  }

  function removeException(fecha) {
    const n = config.deleteDay(fecha);
    if (n) audit('calendario.excepcion_eliminada', fecha);
    return n > 0;
  }

  /** Vista para el panel: días de la semana, excepciones de un rango y estado de cada fecha. */
  function overview({ desde, hasta }) {
    const dias = [];
    for (let f = desde; diffDays(f, hasta) >= 0 && dias.length < 400; f = addDays(f, 1)) {
      const e = explain(f);
      dias.push({ fecha: f, abierto: e.abierto, origen: e.origen, tipo: e.tipo, motivo: e.motivo, reservas: config.activeReservationsOn(f) });
    }
    return { diasOperacion: weekdays(), excepciones: config.days(desde, hasta), dias };
  }

  /* ───────── horario de atención y bloqueos ───────── */
  const SLOT = BUSINESS.slotMin;
  const hours = () => ({ openMin: Number(config.get('hora_apertura_min') ?? BUSINESS.openMin), closeMin: Number(config.get('hora_cierre_min') ?? BUSINESS.closeMin) });

  function setHours({ aperturaMin, cierreMin }, ts) {
    const okStep = (m) => Number.isInteger(m) && m % SLOT === 0;
    // La agenda online se cierra de 11 p. m. a 6 a. m.: el horario de atención debe caber dentro de ese rango
    if (!okStep(aperturaMin) || !okStep(cierreMin) || aperturaMin < BUSINESS.agendaClosedUntilMin || cierreMin > BUSINESS.agendaClosedFromMin || aperturaMin >= cierreMin) {
      throw new Error('Horario inválido: la apertura debe ser antes del cierre, entre las 6:00 a. m. y las 11:00 p. m., en múltiplos de 30 minutos.');
    }
    config.set('hora_apertura_min', aperturaMin, ts); config.set('hora_cierre_min', cierreMin, ts);
    audit('horario.atencion', `${aperturaMin}-${cierreMin}`);
    return hours();
  }

  /** Casilleros de 30 min bloqueados en una fecha (almuerzo, bloqueos de ese día o de ese día de la semana). */
  function blockedSlots(fecha) {
    const out = new Set();
    for (const b of config.blocksFor(fecha, weekdayOf(fecha))) for (let s = b.desde_min / SLOT; s < b.hasta_min / SLOT; s++) out.add(s);
    return out;
  }

  const blockView = (b) => ({ id: b.id, alcance: b.fecha ? 'dia' : b.dia_semana != null ? 'semana' : 'diario', fecha: b.fecha, diaSemana: b.dia_semana, desdeMin: b.desde_min, hastaMin: b.hasta_min, motivo: b.motivo });
  const listBlocks = (desdeFecha) => config.blocksList(desdeFecha).map(blockView);

  /** `alcance`: 'dia' (fecha), 'semana' (diaSemana) o 'diario'. No cancela citas: devuelve cuántas quedan dentro del bloqueo. */
  function addBlock({ alcance, fecha, diaSemana, desdeMin, hastaMin, motivo = '' }, ts) {
    if (!(Number.isInteger(desdeMin) && Number.isInteger(hastaMin) && desdeMin % SLOT === 0 && hastaMin % SLOT === 0 && desdeMin >= 0 && hastaMin <= 1440 && desdeMin < hastaMin)) throw new Error('Horas inválidas');
    if (alcance === 'dia' && !isValidDate(fecha)) throw new Error('Fecha inválida');
    if (alcance === 'semana' && !(Number.isInteger(diaSemana) && diaSemana >= 0 && diaSemana <= 6)) throw new Error('Día de la semana inválido');
    const row = { fecha: alcance === 'dia' ? fecha : null, dia_semana: alcance === 'semana' ? diaSemana : null, desde_min: desdeMin, hasta_min: hastaMin, motivo: String(motivo).slice(0, 120), ts };
    // El mismo bloqueo dos veces no se duplica
    const id = config.blockFind(row) ?? config.blockInsert(row);
    const afectadas = config.blockAffected({ desdeFecha: ts.slice(0, 10), fecha: row.fecha, dow: row.dia_semana, desde: desdeMin, hasta: hastaMin });
    audit('horario.bloqueo', `${alcance} ${fecha ?? diaSemana ?? ''} ${desdeMin}-${hastaMin}`);
    return { id, reservasConfirmadas: afectadas };
  }

  function removeBlock(id) {
    const n = config.blockDelete(id);
    if (n) audit('horario.bloqueo_eliminado', String(id));
    return n > 0;
  }

  /** Siembra los valores por defecto la primera vez (nunca pisa lo que el administrador ya configuró). */
  function seed(ts) { config.seed(KEY, BUSINESS.defaultOpenDays.join(','), ts); config.seed('limpieza_habilitada', 'true', ts); }

  return { hours, setHours, blockedSlots, listBlocks, addBlock, removeBlock, isOpen, explain, weekdays, setWeekdays, setException, removeException, overview, seed };
}
