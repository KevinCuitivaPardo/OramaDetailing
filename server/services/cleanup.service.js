import { createHash } from 'node:crypto';
import { BUSINESS } from '../../shared/catalog.js';
import { checkpoint, inTransaction } from '../db/connection.js';
import { E } from '../utils/errors.js';
import { addDays, mondayOf, weekdayOf, zoneNow } from '../utils/time.js';

const DAY_MS = 86400e3;
const BATCH = 500;
const SAMPLE = 25;
const MAX_CLOCK_GAP_DAYS = 14;

/**
 * Limpieza semanal. POLÍTICA DEFINITIVA (semanas de lunes a domingo, hora de BUSINESS.timezone):
 *   · Semanas FUTURAS                      → se conservan.
 *   · La semana ACTUAL                     → se conserva hasta que termine.
 *   · Semanas ANTERIORES ya finalizadas    → se eliminan (realizadas, no se presentó y canceladas por igual).
 *   · Reservas confirmadas de fecha futura → NUNCA se eliminan (la regla está en cada consulta, no solo en el cálculo).
 * El domingo, una vez cerrada la jornada (BUSINESS.closeMin), la semana en curso ya terminó: el corte es el lunes siguiente.
 * Cualquier otro día (ejecución manual, recuperación tras un apagón) el corte es el lunes de esta semana.
 *
 * Seguridad adicional antes de borrar: la ejecución automática se aborta si el reloj parece incorrecto (más de 14 días sin
 * ninguna actividad registrada) o si propone borrar más de CLEANUP_MAX_DELETE reservas; la manual exige el código de
 * confirmación de la simulación (si algo cambió desde entonces, hay que simular de nuevo). Cada ejecución queda en el historial.
 * NO toca: clientes, servicios, precios, configuración, calendario, credenciales ni el historial administrativo.
 */
export function createCleanupService({ db, maintenance, config, env, log, clock = Date.now }) {
  const isoAgo = (nowMs, days) => new Date(nowMs - days * DAY_MS).toISOString();

  /** Fecha de corte (exclusiva): se borra lo anterior a ella. Siempre es un lunes y nunca pasa de mañana. */
  function policy(nowMs) {
    const { fecha: hoy, minutos, diaSemana } = zoneNow(nowMs);
    const semanaInicio = mondayOf(hoy);
    const jornadaCerrada = diaSemana === 0 && minutos >= BUSINESS.closeMin;
    const corte = jornadaCerrada ? addDays(semanaInicio, 7) : semanaInicio;
    return { hoy, semanaInicio, jornadaCerrada, corte };
  }

  const tokenOf = (corte, ids) => createHash('sha256').update(`${corte}|${ids.join(',')}`).digest('hex').slice(0, 24);

  /** Qué se eliminaría ahora mismo. No modifica nada. */
  function plan(nowMs = clock()) {
    const pol = policy(nowMs);
    const p = { corte: pol.corte, hoy: pol.hoy };
    const rows = maintenance.candidates(p);
    const porEstado = { completada: 0, no_llego: 0, cancelada: 0, confirmada_vencida: 0 };
    for (const r of rows) porEstado[r.estado === 'confirmada' ? 'confirmada_vencida' : r.estado]++;
    // Autocomprobación: ninguna candidata puede ser de una semana no finalizada. Si esto fallara, no se borra nada.
    const bad = rows.find((r) => !(r.fecha < pol.corte && r.fecha <= pol.hoy));
    if (bad || weekdayOf(pol.corte) !== 1 || pol.corte > addDays(pol.hoy, 1)) throw new Error('Plan de limpieza inconsistente: no se eliminará nada');
    return {
      ...pol,
      total: rows.length, porEstado,
      rango: rows.length ? { desde: rows[0].fecha, hasta: rows.at(-1).fecha } : null,
      muestra: rows.slice(0, SAMPLE).map((r) => ({ codigo: r.codigo, fecha: r.fecha, estado: r.estado })),
      conservadas: { reservas: maintenance.countTotal() - rows.length, confirmadasDesdeElCorte: maintenance.countActiveFuture(pol.corte) },
      casillerosPasados: maintenance.countPastSlots(pol.hoy),
      ids: rows.map((r) => r.id),
      token: tokenOf(pol.corte, rows.map((r) => r.id)),
    };
  }

  const publicPlan = ({ ids, ...rest }) => rest;

  /** Simulación: muestra lo que se eliminaría y deja constancia en el historial. No borra nada. */
  function simulate({ actor = 'admin' } = {}) {
    const ts = new Date(clock()).toISOString();
    const p = plan();
    const id = config.cleanupStart({ ts, modo: 'simulacion', corte: p.corte, actor });
    config.cleanupEnd({ id, ts, estado: 'ok', resumen: { total: p.total, porEstado: p.porEstado } });
    log.info('limpieza.simulacion', { corte: p.corte, candidatas: p.total, porEstado: p.porEstado });
    return publicPlan(p);
  }

  const enabled = () => config.get('limpieza_habilitada') !== 'false';
  function setEnabled(value, actor = 'admin') {
    const ts = new Date(clock()).toISOString();
    config.set('limpieza_habilitada', value ? 'true' : 'false', ts);
    config.audit({ ts, accion: 'limpieza.habilitada', detalle: `${value} (${actor})` });
  }

  /**
   * Ejecuta la limpieza. `modo`: 'automatica' (cron) o 'manual' (administrador, con `confirmToken`).
   * Los errores y abortos quedan en el historial.
   */
  function run({ modo = 'automatica', actor = 'sistema', confirmToken } = {}) {
    const nowMs = clock(), ts = new Date(nowMs).toISOString();
    if (modo === 'manual' && !confirmToken) throw E.validation('Falta el código de confirmación de la simulación.');
    const p0 = policy(nowMs);
    const histId = config.cleanupStart({ ts, modo, corte: p0.corte, actor });
    const finish = (estado, resumen, error) => config.cleanupEnd({ id: histId, ts: new Date(clock()).toISOString(), estado, resumen, error });

    try {
      if (modo === 'automatica' && !enabled()) {
        finish('omitida', { motivo: 'limpieza automática deshabilitada' });
        log.info('limpieza.omitida', { motivo: 'deshabilitada' });
        return { estado: 'omitida', motivo: 'deshabilitada' };
      }

      // Guarda 1 (solo automática): un reloj muy adelantado haría ver como "pasado" lo que aún es futuro
      if (modo === 'automatica') {
        const evidence = maintenance.lastClockEvidence();
        if (evidence && nowMs - Date.parse(evidence) > MAX_CLOCK_GAP_DAYS * DAY_MS) {
          const msg = `Sin actividad registrada desde ${evidence}: el reloj del servidor podría ser incorrecto. Revisa y ejecuta la limpieza manual.`;
          finish('abortada', { motivo: 'reloj_sospechoso', ultimaActividad: evidence }, msg);
          log.error('limpieza.abortada', { motivo: 'reloj_sospechoso' });
          return { estado: 'abortada', motivo: 'reloj_sospechoso' };
        }
      }

      const out = inTransaction(db, () => {
        const p = plan(nowMs); // se recalcula DENTRO de la transacción: lo que se borra es lo que hay en este instante
        if (modo === 'manual' && p.token !== confirmToken) throw E.conflict('Los datos cambiaron desde la simulación. Simula de nuevo antes de ejecutar.');
        // Guarda 2 (solo automática): tope de borrado
        if (modo === 'automatica' && p.total > env.CLEANUP_MAX_DELETE) return { abortada: true, total: p.total };

        const finalizadas = maintenance.markPastAsDone({ corte: p.corte, hoy: p.hoy, ts });
        let borradas = 0;
        for (let i = 0; i < p.ids.length; i += BATCH) borradas += maintenance.purgeReservations(p.ids.slice(i, i + BATCH), { corte: p.corte, hoy: p.hoy });
        if (borradas !== p.total) throw new Error(`Se esperaba borrar ${p.total} y se borraron ${borradas}: se revierte todo`);
        return {
          corte: p.corte, candidatas: p.total, porEstado: p.porEstado, finalizadas, borradas,
          casillerosPasados: maintenance.deletePastSlots(p.hoy),
          idempotencia: maintenance.clearOldIdempotency(isoAgo(nowMs, 7)),
          colaEnviados: maintenance.deleteOldSentEmails(isoAgo(nowMs, 30)),
          colaFallidos: maintenance.deleteOldFailedEmails(isoAgo(nowMs, 30)),
          tareas: maintenance.deleteOldJobRuns(isoAgo(nowMs, 180)),
          auditoria: config.auditTrim(isoAgo(nowMs, 365)),
          accionesVencidas: maintenance.deleteExpiredActions(isoAgo(nowMs, 1)),
        };
      });

      if (out.abortada) {
        const msg = `La limpieza automática propuso borrar ${out.total} reservas (máximo ${env.CLEANUP_MAX_DELETE}). No se borró nada; revisa y ejecuta la manual.`;
        finish('abortada', { motivo: 'tope_de_borrado', propuestas: out.total }, msg);
        log.error('limpieza.abortada', { motivo: 'tope_de_borrado', propuestas: out.total });
        return { estado: 'abortada', motivo: 'tope_de_borrado', propuestas: out.total };
      }

      // Mantenimiento del archivo (fuera de la transacción)
      try {
        if (checkpoint(db).busy) log.warn('limpieza.checkpoint_incompleto', { detalle: 'Había lectores activos: el archivo WAL no se pudo truncar esta vez' });
        db.exec('PRAGMA optimize;');
      } catch (err) { log.warn('limpieza.mantenimiento_omitido', { error: err.message }); }

      out.integridad = integrityReport();
      if (!out.integridad.ok) log.error('limpieza.integridad_fallida', out.integridad);
      finish('ok', out);
      log.info('limpieza.completada', out);
      return { estado: 'ok', ...out };
    } catch (err) {
      finish('error', null, String(err?.message ?? err).slice(0, 300));
      log.error('limpieza.error', { error: err });
      throw err;
    }
  }

  /** Revisa que los casilleros coincidan con las reservas confirmadas y que el archivo no esté dañado. */
  function integrityReport() {
    const orphanSlots = db.prepare(`SELECT COUNT(*) AS n FROM reserva_slots s LEFT JOIN reservas r ON r.id = s.reserva_id WHERE r.id IS NULL OR r.estado <> 'confirmada'`).get().n;
    const badBlocks = db.prepare(`SELECT COUNT(*) AS n FROM reservas r WHERE r.estado = 'confirmada'
      AND (SELECT COUNT(*) FROM reserva_slots WHERE reserva_id = r.id) <> (r.bloque_fin_min - r.inicio_min) / 30`).get().n;
    const quick = db.prepare('PRAGMA quick_check').all();
    const fileOk = quick.length === 1 && quick[0].quick_check === 'ok';
    return { ok: orphanSlots === 0 && badBlocks === 0 && fileOk, casillerosHuerfanos: orphanSlots, reservasConBloqueIncoherente: badBlocks, archivo: fileOk ? 'ok' : 'DAÑADO' };
  }

  /** Estado para el panel: habilitada, última ejecución, historial y la fecha de corte que aplicaría hoy. */
  function status() {
    return { habilitada: enabled(), ultima: config.cleanupLast(), historial: config.cleanupRecent(20), politica: policy(clock()) };
  }

  return { policy, plan, simulate, run, enabled, setEnabled, status, integrityReport };
}
