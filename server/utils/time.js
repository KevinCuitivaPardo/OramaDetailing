import { BUSINESS } from '../../shared/catalog.js';

/**
 * Fechas y horas del negocio. La zona horaria sale de UN solo lugar (BUSINESS.timezone en shared/catalog.js: America/Puerto_Rico,
 * UTC-4 todo el año) y los cálculos no dependen de la zona del servidor. Se usa Intl para obtener el desfase, así que
 * cambiar la zona (incluso a una con horario de verano) solo exige editar esa constante.
 * Una "fecha" es 'YYYY-MM-DD' y una "hora" son minutos desde medianoche. El reloj se inyecta (pruebas).
 */
const ZONE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** Hora local (como si fuera UTC) de un instante: sirve para sacar fecha, minutos y desfase. */
function localParts(utcMs) {
  const p = Object.fromEntries(ZONE_FMT.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute };
}
/** Desfase (ms) de la zona respecto a UTC en ese instante: local = utc + desfase. */
function zoneOffsetMs(utcMs) {
  const { y, m, d, h, min } = localParts(utcMs);
  return Date.UTC(y, m - 1, d, h, min) - Math.floor(utcMs / 60e3) * 60e3;
}

export const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const pad = (n) => String(n).padStart(2, '0');
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha y hora actuales del negocio a partir de un instante UTC (ms). */
export function zoneNow(nowMs = Date.now()) {
  const d = new Date(nowMs + zoneOffsetMs(nowMs));
  return { fecha: toDateStr(d), minutos: d.getUTCHours() * 60 + d.getUTCMinutes(), diaSemana: d.getUTCDay() };
}

const toDateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** true si 'YYYY-MM-DD' es una fecha real del calendario (rechaza 2026-02-31). */
export function isValidDate(fecha) {
  if (typeof fecha !== 'string' || !DATE_RE.test(fecha)) return false;
  const [y, m, d] = fecha.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const parse = (fecha) => { const [y, m, d] = fecha.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

export const weekdayOf = (fecha) => parse(fecha).getUTCDay();
export function addDays(fecha, n) { const d = parse(fecha); d.setUTCDate(d.getUTCDate() + n); return toDateStr(d); }
/** Diferencia en días (b - a). */
export const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400e3);

/** Instante UTC (ms) en que empieza `minutos` del día `fecha` en la zona del negocio. */
export function toEpoch(fecha, minutos) {
  const local = parse(fecha).getTime() + minutos * 60e3;
  return local - zoneOffsetMs(local - zoneOffsetMs(local)); // dos pasos: correcto también cerca de un cambio de horario
}

/** Lunes de la semana (lunes a domingo) que contiene `fecha`. */
export function mondayOf(fecha) { const wd = weekdayOf(fecha); return addDays(fecha, -((wd + 6) % 7)); }

/** La agenda está cerrada de 11:00 p.m. a 6:00 a.m. (hora del negocio). */
export function isAgendaClosed(nowMs = Date.now()) {
  const { minutos } = zoneNow(nowMs);
  return minutos >= BUSINESS.agendaClosedFromMin || minutos < BUSINESS.agendaClosedUntilMin;
}

export function fmtHora(min) {
  const h = Math.floor(min / 60);
  return `${((h + 11) % 12) + 1}:${pad(min % 60)} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}
export const fmtHHMM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
export function parseHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function fmtFechaLarga(fecha) {
  const d = parse(fecha);
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}
export const diaNombre = (fecha) => DIAS[weekdayOf(fecha)];
