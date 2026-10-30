// Ayudas de fecha para mostrar en pantalla. La hora "oficial" y todas las reglas las decide el SERVIDOR;
// aquí solo se usa para dar formato y para avisar de antemano que la agenda está cerrada.
import { BUSINESS } from '../../../shared/catalog.js';

const HOUR_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS.timezone, hourCycle: 'h23', hour: '2-digit' });

export const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

/** "2026-10-31" → "Sábado 31 de octubre" */
export const fmtDate = (s) => { const d = parseD(s); return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()].toLowerCase()}`; };

/** La agenda se cierra de 11:00 p.m. a 6:00 a.m. (hora del negocio, BUSINESS.timezone). */
export const isClosed = () => { const h = Number(HOUR_FMT.format(new Date())); return h >= 23 || h < 6; };
