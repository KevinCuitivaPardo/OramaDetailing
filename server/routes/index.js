import { Router } from 'express';
import { E } from '../utils/errors.js';
import { adminAuth, jobsAuth, sendError, validate } from '../middleware/http.js';
import {
  adminCalendarQuery, adminCleanupRunBody, adminServiceBody, adminServiceParam, adminCleanupToggleBody, adminDateParam, adminExceptionBody, adminTaskParam, adminWeekdaysBody, taskParam,
  blockBody, blockIdParam, hoursBody, loginBody, passwordBody, fieldErrors, actionBody, accessBody, adminAgendaQuery, adminCancelBody, availabilityQuery, createReservationBody, idempotencyKey, monthQuery, ownAvailabilityBody, rescheduleBody,
} from '../validation/schemas.js';

const sendBusy = (res, req) => sendError(res, E.tooMany(), req);

/** Exige la cabecera Idempotency-Key (un UUID por intento de envío): hace seguros los reintentos y los dobles clics. */
const requireIdempotencyKey = (req, _res, next) => {
  const parsed = idempotencyKey.safeParse(req.get('idempotency-key'));
  if (!parsed.success) return next(E.validation('Falta la cabecera Idempotency-Key (16–64 caracteres).'));
  req.idemKey = parsed.data;
  next();
};

/**
 * Mapa de rutas. Los controladores no se instancian aquí: llegan ya armados.
 * Regla: ninguna ruta lleva datos sensibles en la URL (código y teléfono viajan en el cuerpo, que no se registra).
 */
export function buildRoutes({ publicCtl, adminCtl, healthCtl, jobsCtl, limiters, env, access, hub }) {
  const r = Router();

  r.get('/salud', healthCtl.salud);
  r.get('/listo', healthCtl.listo);
  r.get('/config', publicCtl.config);
  // Cambios en tiempo real (SSE): solo avisa "la disponibilidad cambió"; no lleva datos de nadie
  r.get('/eventos', limiters.events, (req, res) => { if (!hub.add(req, res)) sendBusy(res, req); });

  r.get('/disponibilidad', limiters.availability, validate(availabilityQuery, 'query'), publicCtl.availabilityDay);
  r.get('/disponibilidad/mes', limiters.availability, validate(monthQuery, 'query'), publicCtl.availabilityMonth);

  r.post('/reservas', limiters.create, requireIdempotencyKey, validate(createReservationBody), publicCtl.create);
  r.post('/reservas/consultar', limiters.accessIp, limiters.accessCode, validate(accessBody), publicCtl.lookup);
  r.post('/reservas/disponibilidad', limiters.accessIp, limiters.accessCode, validate(ownAvailabilityBody), publicCtl.ownAvailability);
  r.post('/reservas/cambiar', limiters.accessIp, limiters.accessCode, limiters.manage, validate(rescheduleBody), publicCtl.reschedule);
  r.post('/reservas/accion', limiters.accessIp, validate(actionBody), publicCtl.actionPreview);
  r.post('/reservas/confirmar', limiters.accessIp, limiters.manage, validate(actionBody), publicCtl.actionConfirm);
  r.post('/reservas/cancelar', limiters.accessIp, limiters.accessCode, limiters.manage, validate(accessBody), publicCtl.cancel);

  // Panel del dueño: sin ADMIN_TOKEN estas rutas responden 404 como si no existieran
  const admin = Router();
  // Inicio de sesión del propietario (público, pero con límite de intentos por IP y global)
  admin.post('/login', limiters.adminFail, limiters.adminLogin, validate(loginBody), adminCtl.login);
  admin.use(limiters.adminFail, limiters.admin, adminAuth(env, access));
  // Cualquier cambio exitoso del propietario avisa a las páginas abiertas (clientes y panel)
  admin.use((req, res, next) => { if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) hub.publish(); }); next(); });
  admin.post('/password', validate(passwordBody), adminCtl.changePassword);
  admin.get('/horario', adminCtl.hours);
  admin.put('/horario', validate(hoursBody), adminCtl.setHours);
  admin.post('/bloqueos', validate(blockBody), adminCtl.addBlock);
  admin.delete('/bloqueos/:id', validate(blockIdParam, 'params'), adminCtl.removeBlock);
  admin.get('/agenda', validate(adminAgendaQuery, 'query'), adminCtl.agenda);
  admin.post('/reservas/cancelar', validate(adminCancelBody), adminCtl.cancel);
  admin.get('/correos', adminCtl.emails);
  admin.get('/estado', healthCtl.estado);
  admin.get('/servicios', adminCtl.services);
  admin.put('/servicios/:id/activo', (req, _res, next) => {
    const p = adminServiceParam.safeParse(req.params), b = adminServiceBody.safeParse(req.body);
    if (!p.success || !b.success) return next(E.validation('Revisa los datos marcados.', fieldErrors((p.error ?? b.error))));
    req.valid = { ...p.data, ...b.data };
    next();
  }, adminCtl.setServiceActive);
  admin.get('/calendario', validate(adminCalendarQuery, 'query'), adminCtl.calendar);
  admin.put('/calendario/dias-operacion', validate(adminWeekdaysBody), adminCtl.setWeekdays);
  admin.put('/calendario/excepciones', validate(adminExceptionBody), adminCtl.setException);
  admin.delete('/calendario/excepciones/:fecha', validate(adminDateParam, 'params'), adminCtl.deleteException);
  admin.get('/limpieza', adminCtl.cleanupStatus);
  admin.put('/limpieza/habilitada', validate(adminCleanupToggleBody), adminCtl.cleanupToggle);
  admin.post('/limpieza/simulacion', adminCtl.cleanupSimulate);
  admin.post('/limpieza/ejecutar', validate(adminCleanupRunBody), adminCtl.cleanupRun);
  admin.post('/tareas/:tarea', validate(adminTaskParam, 'params'), adminCtl.runTask);
  admin.get('/auditoria', adminCtl.audit);
  admin.get('/metricas', adminCtl.metrics);
  r.use('/admin', admin);

  // Disparador externo de tareas programadas (red de seguridad del cron interno). 404 si JOBS_TRIGGER_SECRET no existe.
  r.post('/internal/tareas/:tarea', limiters.internal, jobsAuth(env), validate(taskParam, 'params'), jobsCtl.run);

  return r;
}
