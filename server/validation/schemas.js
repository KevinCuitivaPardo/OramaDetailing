import { z } from 'zod';
import { VEHICLES } from '../../shared/catalog.js';
import { isValidDate } from '../utils/time.js';
import { isValidPhone, normalizeCode } from '../utils/secure.js';

/**
 * Validación de TODA entrada externa con listas blancas. Los objetos son `.strict()`:
 * un campo que no esté aquí (p. ej. "estado" o "codigo" al crear) se rechaza, así no hay asignación masiva.
 */
const noControl = (s) => !/[\u0000-\u001f\u007f]/.test(s); // sin saltos de línea ni caracteres de control
// Los textos libres se muestran en correos que salen con la marca del negocio: no se aceptan enlaces ni direcciones web
const noLinks = (s) => !/(https?:|ftp:|www\.|@|\b[a-z0-9-]+\.(com|net|org|co|io|me|ly|tk|ru|xyz|info|biz|app|link|click|top)\b)/i.test(s);
const text = (min, max, label) =>
  z.string({ error: `${label} es obligatorio` }).trim().min(min, `${label} es obligatorio`).max(max, `${label} es demasiado largo`).refine(noControl, `${label} contiene caracteres no permitidos`);

const servicioId = z.coerce.number().int().refine((n) => n === 1 || n === 2, 'Servicio inválido');
const fecha = z.string().refine(isValidDate, 'Fecha inválida (usa AAAA-MM-DD)');
const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora inválida (usa HH:MM)');
const telefono = z.string({ error: 'El teléfono es obligatorio' }).refine(isValidPhone, 'Escribe un celular de 10 dígitos');
const codigo = z.string().max(20).refine((c) => normalizeCode(c) !== null, 'Número de reserva inválido');
const token = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/, 'Enlace inválido');

/** Credenciales de acceso a una reserva: código + (teléfono | token del correo). */
const creds = {
  codigo,
  telefono: telefono.optional(),
  token: token.optional(),
};
const needsProof = (o) => Boolean(o.telefono) !== Boolean(o.token); // exactamente uno de los dos

export const createReservationBody = z.strictObject({
  servicioId,
  vehiculo: z.enum(Object.keys(VEHICLES), { error: 'Tipo de vehículo inválido' }),
  fecha,
  hora,
  nombre: text(3, 80, 'El nombre completo')
    .refine((n) => n.split(/\s+/).length >= 2, 'Escribe nombre y apellido')
    .refine((n) => /^[\p{L}\p{M}\p{N}\s'.,-]+$/u.test(n), 'El nombre solo puede llevar letras, números, espacios y . , \' -'),
  telefono,
  correo: z.string({ error: 'El correo es obligatorio' }).trim().toLowerCase().max(254, 'Correo demasiado largo').email('Escribe un correo válido').refine(noControl, 'Correo inválido'),
  lugar: text(3, 160, 'El lugar del servicio').refine(noLinks, 'El lugar no puede incluir enlaces ni correos'),
  modelo: text(1, 60, 'La marca y modelo').refine(noLinks, 'No puede incluir enlaces ni correos').optional().or(z.literal('').transform(() => undefined)),
});

export const accessBody = z.strictObject(creds).refine(needsProof, 'Envía tu celular o el enlace del correo (solo uno)');
export const rescheduleBody = z.strictObject({ ...creds, fecha, hora }).refine(needsProof, 'Envía tu celular o el enlace del correo (solo uno)');

export const actionBody = z.strictObject({ codigo, token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/, 'Enlace inválido') });
export const ownAvailabilityBody = z.strictObject({ ...creds, fecha }).refine(needsProof, 'Envía tu celular o el enlace del correo (solo uno)');
export const availabilityQuery = z.strictObject({ servicio: servicioId, fecha });
export const monthQuery = z.strictObject({ servicio: servicioId, mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes inválido (AAAA-MM)') });

export const adminAgendaQuery = z.strictObject({ fecha });
export const adminCancelBody = z.strictObject({ codigo });
export const adminCalendarQuery = z.strictObject({ desde: fecha.optional(), hasta: fecha.optional() });
export const adminWeekdaysBody = z.strictObject({ dias: z.array(z.number().int().min(0).max(6)).min(1, 'Elige al menos un día').max(7) });
export const adminExceptionBody = z.strictObject({
  fecha,
  tipo: z.enum(['festivo', 'cerrado', 'abierto'], { error: 'Tipo inválido' }),
  motivo: z.string().trim().max(120, 'Motivo demasiado largo').refine(noControl, 'Motivo inválido').optional(),
});
export const adminServiceParam = z.strictObject({ id: servicioId });
export const adminServiceBody = z.strictObject({ activo: z.boolean({ error: 'Indica true o false' }) });
const hhmm30 = z.string().regex(/^([01]\d|2[0-3]):(00|30)$/, 'Hora inválida (usa HH:MM en múltiplos de 30 minutos)');
export const loginBody = z.strictObject({ password: z.string().min(1, 'Escribe tu contraseña').max(200) });
export const passwordBody = z.strictObject({ actual: z.string().min(1).max(200), nueva: z.string().min(12, 'Mínimo 12 caracteres').max(128) });
export const hoursBody = z.strictObject({ apertura: hhmm30, cierre: hhmm30 }).refine((o) => o.apertura < o.cierre, 'La apertura debe ser antes del cierre');
export const blockBody = z.strictObject({
  alcance: z.enum(['dia', 'semana', 'diario'], { error: 'Elige a qué días aplica' }),
  fecha: fecha.optional(), diaSemana: z.number().int().min(0).max(6).optional(),
  desde: hhmm30, hasta: hhmm30,
  motivo: z.string().trim().max(120, 'Motivo demasiado largo').refine(noControl, 'Motivo inválido').optional(),
}).refine((o) => o.desde < o.hasta, 'La hora inicial debe ser antes de la final')
  .refine((o) => (o.alcance === 'dia') === Boolean(o.fecha) && (o.alcance === 'semana') === (o.diaSemana !== undefined), 'Faltan o sobran datos para ese tipo de bloqueo');
export const blockIdParam = z.strictObject({ id: z.coerce.number().int().positive() });
export const adminDateParam = z.strictObject({ fecha });
export const adminCleanupToggleBody = z.strictObject({ habilitada: z.boolean({ error: 'Indica true o false' }) });
export const adminCleanupRunBody = z.strictObject({ confirmToken: z.string().regex(/^[0-9a-f]{24}$/, 'Código de confirmación inválido') });
export const taskParam = z.strictObject({ tarea: z.enum(['resumen', 'limpieza', 'correos', 'respaldo']) });
export const adminTaskParam = z.strictObject({ tarea: z.enum(['resumen', 'correos', 'respaldo']) });

export const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Idempotency-Key inválida (16–64 caracteres: letras, números, _ o -)');

/** Convierte los errores de zod al formato de la API: { campo: mensaje }. */
export function fieldErrors(zodError) {
  const out = {};
  for (const i of zodError.issues) out[i.path.join('.') || '_'] ??= i.message;
  return out;
}
