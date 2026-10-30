/**
 * Errores de dominio: tienen un código estable (para el frontend y las pruebas), un estado HTTP
 * y un mensaje en español SEGURO para mostrar al cliente (nunca detalles internos).
 */
export class AppError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const E = {
  validation: (message = 'Revisa los datos e inténtalo de nuevo.', fields) => new AppError('DATOS_INVALIDOS', 400, message, { fields }),
  // No distingue "código inexistente" de "teléfono incorrecto": evita enumerar reservas ajenas
  notFound: () => new AppError('RESERVA_NO_ENCONTRADA', 404, 'No encontramos una reserva con esos datos. Revisa el número y tu celular.'),
  slotTaken: () => new AppError('HORARIO_NO_DISPONIBLE', 409, 'Ese horario ya no está disponible. Escoge otro, por favor.'),
  agendaClosed: () => new AppError('AGENDA_CERRADA', 423, 'La agenda está cerrada de 11:00 p.m. a 6:00 a.m. Inténtalo después de las 6:00 a.m. o escríbenos por WhatsApp.'),
  outOfWindow: (message) => new AppError('FECHA_NO_PERMITIDA', 422, message),
  tooLate: () => new AppError('FUERA_DE_PLAZO', 403, 'Ya no es posible cambiar o cancelar por aquí. Escríbenos por WhatsApp y lo resolvemos.'),
  notActive: () => new AppError('RESERVA_NO_ACTIVA', 409, 'Esta reserva ya no está activa.'),
  idemConflict: () => new AppError('IDEMPOTENCY_KEY_REUTILIZADA', 409, 'Esa solicitud ya se usó con datos distintos.'),
  unauthorized: () => new AppError('NO_AUTORIZADO', 401, 'No autorizado.'),
  tooMany: () => new AppError('DEMASIADAS_SOLICITUDES', 429, 'Demasiadas solicitudes. Espera unos minutos e inténtalo de nuevo.'),
  limit: (n) => new AppError('LIMITE_DE_RESERVAS', 409, `Ya tienes ${n} reservas activas. Para agendar otra, cancela una o escríbenos por WhatsApp.`),
  tooManyChanges: (n) => new AppError('LIMITE_DE_CAMBIOS', 403, `Esta cita ya se cambió ${n} veces por internet. Para otro cambio, escríbenos por WhatsApp.`),
  serviceInactive: () => new AppError('SERVICIO_INACTIVO', 422, 'Este servicio no está disponible para reservar por ahora. Escríbenos por WhatsApp.'),
  linkInvalid: () => new AppError('ENLACE_INVALIDO', 404, 'Este enlace no es válido. Revisa que lo hayas copiado completo o vuelve a pedir la confirmación desde “Mi reserva”.'),
  linkExpired: () => new AppError('ENLACE_VENCIDO', 410, 'Este enlace venció. Vuelve a pedir la cancelación o el cambio desde “Mi reserva”.'),
  linkUsed: () => new AppError('ENLACE_USADO', 409, 'Este enlace ya se usó. Si necesitas algo más, entra a “Mi reserva”.'),
  mailUnavailable: () => new AppError('CORREO_NO_DISPONIBLE', 503, 'Ahora no podemos enviarte el correo de confirmación. Escríbenos por WhatsApp y lo resolvemos.'),
  conflict: (message) => new AppError('CONFLICTO', 409, message),
  forbidden: (message) => new AppError('PROHIBIDO', 403, message),
  unavailable: () => new AppError('SERVICIO_NO_DISPONIBLE', 503, 'Este servicio no está disponible por ahora.'),
};
