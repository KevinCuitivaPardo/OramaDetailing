import { SERVICES, PRICES, VEHICLES, BUSINESS } from '../../shared/catalog.js';
import { AppError, E } from '../utils/errors.js';
import { addDays, fmtHHMM, parseHHMM, zoneNow } from '../utils/time.js';

/**
 * API de administración opcional (sin interfaz web). Todas las rutas pasan antes por `adminAuth` (Bearer ADMIN_TOKEN_SECRET).
 * Cada operación que cambia algo deja una línea en `auditoria_admin` (sin datos personales).
 */
export function createAdminController({ access, reservations, outbox, calendar, cleanup, config, metrics, tasks, log, clock }) {
  const nowIso = () => new Date(clock()).toISOString();
  const audit = (req, accion, detalle) => config.audit({ ts: nowIso(), accion, detalle, request_id: req.id });

  const blockOut = (b) => ({ ...b, desde: fmtHHMM(b.desdeMin), hasta: fmtHHMM(b.hastaMin) });

  return {
    /** Inicio de sesión del propietario: contraseña → sesión de 8 horas. */
    login: async (req, res) => {
      if (!access.hasPassword()) throw new AppError('NO_ENCONTRADO', 404, 'No encontrado.');
      if (!(await access.verifyPassword(req.valid.password))) {
        log.warn('admin.login_fallido', { request: req.id });
        config.audit({ ts: nowIso(), accion: 'admin.login_fallido', request_id: req.id }); // el propietario ve los intentos en Cuenta (limitados por IP, no se acumulan sin tope)
        throw E.unauthorized();
      }
      log.info('admin.login', { request: req.id });
      config.audit({ ts: nowIso(), accion: 'admin.login', request_id: req.id });
      res.json(access.issue());
    },

    /** Cambia la contraseña (pide la actual). Cierra las demás sesiones y deja abierta esta con una nueva. */
    changePassword: async (req, res) => {
      if (!(await access.verifyPassword(req.valid.actual))) throw E.unauthorized();
      const problem = access.passwordProblem(req.valid.nueva);
      if (problem) throw E.validation(problem, { nueva: problem });
      await access.setPassword(req.valid.nueva);
      audit(req, 'admin.password_cambiada');
      res.json(access.issue());
    },

    /** Horario de atención y bloqueos (almuerzo, salir temprano…). */
    hours: (_req, res) => {
      const h = calendar.hours();
      res.json({ aperturaMin: h.openMin, cierreMin: h.closeMin, apertura: fmtHHMM(h.openMin), cierre: fmtHHMM(h.closeMin), zona: BUSINESS.timezone, bloqueos: calendar.listBlocks(zoneNow(clock()).fecha).map(blockOut) });
    },
    setHours: (req, res) => {
      let h;
      try { h = calendar.setHours({ aperturaMin: parseHHMM(req.valid.apertura), cierreMin: parseHHMM(req.valid.cierre) }, nowIso()); } catch (e) { throw E.validation(e.message); }
      audit(req, 'horario.atencion', `${req.valid.apertura}-${req.valid.cierre}`);
      res.json({ aperturaMin: h.openMin, cierreMin: h.closeMin, apertura: fmtHHMM(h.openMin), cierre: fmtHHMM(h.closeMin) });
    },
    addBlock: (req, res) => {
      const v = req.valid;
      let out;
      try { out = calendar.addBlock({ alcance: v.alcance, fecha: v.fecha, diaSemana: v.diaSemana, desdeMin: parseHHMM(v.desde), hastaMin: parseHHMM(v.hasta), motivo: v.motivo ?? '' }, nowIso()); } catch (e) { throw E.validation(e.message); }
      audit(req, 'horario.bloqueo', `${v.alcance} ${v.fecha ?? v.diaSemana ?? ''} ${v.desde}-${v.hasta}`);
      res.status(201).json(out);
    },
    removeBlock: (req, res) => {
      if (!calendar.removeBlock(req.valid.id)) throw E.validation('Ese bloqueo no existe.');
      audit(req, 'horario.bloqueo_eliminado', String(req.valid.id));
      res.json({ eliminado: req.valid.id });
    },

    agenda: (req, res) => {
      const agenda = reservations.agenda(req.valid.fecha);
      res.json({ fecha: req.valid.fecha, abierto: calendar.explain(req.valid.fecha), total: agenda.length, reservas: agenda });
    },

    /** Cancelar una cita acordada por WhatsApp: libera el horario y avisa al cliente. */
    cancel: (req, res) => {
      const r = reservations.cancel({ codigo: req.valid.codigo }, { actor: 'dueno', requestId: req.id });
      audit(req, 'reserva.cancelada_por_admin', r.codigo);
      log.info('admin.reserva_cancelada', { request: req.id, codigo: r.codigo });
      res.json({ reserva: { codigo: r.codigo, estado: r.estado } });
    },

    /** Historial de notificaciones (sin contenido ni destinatarios) y estado de la cola. */
    emails: (_req, res) => res.json({ conteo: outbox.counts(), masAntiguoPendiente: outbox.oldestPendingAt(), fallidos: outbox.failedList(), recientes: outbox.recent(100) }),

    /**
     * Servicios y precios. Los precios y duraciones son reglas de negocio versionadas en shared/catalog.js (la página y el servidor
     * leen el mismo archivo); el administrador decide cuáles servicios se pueden reservar ahora (activar/desactivar).
     */
    services: (_req, res) => res.json({
      servicios: Object.values(SERVICES).map((s) => ({
        id: s.id, nombre: s.nombre, activo: config.isServiceActive(s.id), duracionMin: s.duracionMin, bloqueMin: s.bloqueMin,
        precios: Object.fromEntries(Object.keys(VEHICLES).map((v) => [v, `${PRICES[v][s.id][1] ? 'desde ' : ''}$${PRICES[v][s.id][0]}`])),
      })),
      horario: { abre: calendar.hours().openMin, cierra: calendar.hours().closeMin, zona: BUSINESS.timezone },
    }),

    setServiceActive: (req, res) => {
      config.setServiceActive(req.valid.id, req.valid.activo);
      audit(req, 'servicio.activo', `${req.valid.id}=${req.valid.activo}`);
      res.json({ id: req.valid.id, activo: config.isServiceActive(req.valid.id) });
    },

    /* ───────── calendario ───────── */
    calendar: (req, res) => {
      const hoy = zoneNow(clock()).fecha;
      const desde = req.valid.desde ?? hoy, hasta = req.valid.hasta ?? addDays(desde, 90);
      res.json({ zona: BUSINESS.timezone, ...calendar.overview({ desde, hasta }) });
    },
    setWeekdays: (req, res) => {
      const dias = calendar.setWeekdays(req.valid.dias, nowIso());
      audit(req, 'calendario.dias_operacion', dias.join(','));
      res.json({ diasOperacion: dias });
    },
    setException: (req, res) => {
      const out = calendar.setException(req.valid, nowIso());
      audit(req, 'calendario.excepcion', `${out.fecha} ${out.tipo}`);
      res.json(out);
    },
    deleteException: (req, res) => {
      const removed = calendar.removeException(req.valid.fecha);
      if (!removed) throw E.validation('Ese día no tiene excepción.');
      audit(req, 'calendario.excepcion_eliminada', req.valid.fecha);
      res.json({ eliminado: req.valid.fecha });
    },

    /* ───────── limpieza semanal ───────── */
    cleanupStatus: (_req, res) => res.json(cleanup.status()),
    cleanupToggle: (req, res) => {
      cleanup.setEnabled(req.valid.habilitada, 'admin');
      audit(req, 'limpieza.habilitada', String(req.valid.habilitada));
      res.json({ habilitada: cleanup.enabled() });
    },
    cleanupSimulate: (req, res) => {
      const plan = cleanup.simulate({ actor: 'admin' });
      audit(req, 'limpieza.simulacion', `corte ${plan.corte}: ${plan.total}`);
      res.json(plan);
    },
    cleanupRun: (req, res) => {
      audit(req, 'limpieza.manual', req.valid.confirmToken);
      const out = cleanup.run({ modo: 'manual', actor: 'admin', confirmToken: req.valid.confirmToken });
      res.json(out);
    },

    /** Dispara una tarea ahora (idempotente), por si el programador externo falló. */
    runTask: async (req, res) => {
      const r = await ({ resumen: () => tasks.dailySummary(), correos: () => tasks.sendEmails(), respaldo: () => tasks.dailyBackup() }[req.valid.tarea])();
      audit(req, 'tarea.manual', req.valid.tarea);
      res.json({ tarea: req.valid.tarea, resultado: r });
    },

    audit: (_req, res) => res.json({ registros: config.auditRecent(100) }),
    metrics: (_req, res) => res.json(metrics.snapshot()),
  };
}
