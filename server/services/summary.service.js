import { diaNombre, fmtFechaLarga, fmtHora, zoneNow } from '../utils/time.js';

/**
 * Resumen diario para el dueño: las reservas CONFIRMADAS del día siguiente, ordenadas por hora,
 * en texto plano cliente por cliente (formato pedido por el dueño). No omite ningún cliente.
 * La base de datos se consulta CADA VEZ que se arma el texto, y el trabajador de correos lo vuelve a armar justo antes de enviar:
 * una reserva cancelada después de las 11 p. m. o movida de fecha no sale con datos viejos.
 */
export function createSummaryService({ reservas, notifier, fc, log, clock = Date.now }) {
  function build(fecha) {
    const rows = reservas.agendaOf(fecha); // ya viene ordenada por hora de inicio y luego por id
    const now = zoneNow(clock());
    const lines = ['RESERVAS PROGRAMADAS PARA EL DÍA SIGUIENTE', `Fecha: ${fmtFechaLarga(fecha)}`, `Estado al momento de generar: ${now.fecha} ${fmtHora(now.minutos)}`, ''];
    if (!rows.length) {
      lines.push('No hay reservas confirmadas para esta fecha.');
    } else {
      rows.forEach((r, i) => {
        lines.push(
          `CLIENTE ${i + 1}`,
          `Nombre: ${fc.decrypt(r.nombre_enc)}`,
          `Teléfono: ${fc.decrypt(r.telefono_enc)}`,
          `Lugar: ${fc.decrypt(r.lugar_enc)}`,
          `Número de reserva: ${r.codigo}`,
          `Servicio: ${r.servicio_nombre}`,
          `Horario: ${fmtHora(r.inicio_min)} - ${fmtHora(r.fin_min)}`,
          '',
        );
      });
      lines.push(`Total: ${rows.length} ${rows.length === 1 ? 'reserva' : 'reservas'}`);
    }
    return { texto: lines.join('\n').trimEnd() + '\n', total: rows.length, dia: diaNombre(fecha) };
  }

  /** Arma y encola el correo del dueño (idempotente: la misma fecha no se encola dos veces). */
  function enqueue(fecha, ts) {
    const { texto, total } = build(fecha);
    const added = notifier.resumenDueno(fecha, texto, ts);
    log.info('resumen.generado', { fecha, reservas: total, encolado: added });
    return { total, added };
  }

  return { build, enqueue };
}
