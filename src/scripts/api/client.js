/**
 * Cliente de la API. Toda la comunicación con el servidor pasa por aquí:
 *  - Tiempo máximo de espera y mensajes claros cuando no hay conexión.
 *  - Los datos sensibles (código, teléfono, token) viajan en el cuerpo POST, nunca en la URL.
 *  - Cada envío de una reserva lleva su propia Idempotency-Key: un doble clic o un reintento no duplica nada.
 */
const BASE = import.meta.env.VITE_API_URL ?? '/api';
const TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.status = status; this.code = code; this.data = data;
  }
}

async function request(method, path, { body, headers } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BASE + path, {
      method, signal: ctl.signal, cache: 'no-store', credentials: 'omit',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'SIN_CONEXION', 'No pudimos conectar con el servidor. Revisa tu internet e inténtalo de nuevo.');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await res.json(); } catch { /* respuesta sin cuerpo */ }
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? 'Ocurrió un error. Inténtalo de nuevo.', { campos: e.campos, whatsapp: e.whatsapp });
  }
  return json;
}

const qs = (o) => new URLSearchParams(o).toString();
export const newIdempotencyKey = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random().toString(16).slice(2)}`).replace(/-/g, '');

export const api = {
  config: () => request('GET', '/config'),
  day: (servicio, fecha) => request('GET', `/disponibilidad?${qs({ servicio, fecha })}`),
  month: (servicio, mes) => request('GET', `/disponibilidad/mes?${qs({ servicio, mes })}`),
  create: (data, key) => request('POST', '/reservas', { body: data, headers: { 'Idempotency-Key': key } }),
  lookup: (creds) => request('POST', '/reservas/consultar', { body: creds }),
  ownDay: (creds, fecha) => request('POST', '/reservas/disponibilidad', { body: { ...creds, fecha } }),
  reschedule: (creds, fecha, hora) => request('POST', '/reservas/cambiar', { body: { ...creds, fecha, hora } }),
  cancel: (creds) => request('POST', '/reservas/cancelar', { body: creds }), // pide la cancelación: el correo la confirma
  preview: (codigo, token) => request('POST', '/reservas/accion', { body: { codigo, token } }),
  confirm: (codigo, token) => request('POST', '/reservas/confirmar', { body: { codigo, token } }),
};
