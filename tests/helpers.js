import { randomBytes } from 'node:crypto';
import { buildApp, buildContainer } from '../server/app.js';
import { loadEnv } from '../server/config/env.js';
import { migrate, openDatabase, syncCatalog } from '../server/db/connection.js';
import { createLogger } from '../server/utils/logger.js';

/** Viernes 30 de octubre de 2026, 12:00 p.m. en Puerto Rico (16:00 UTC). Mañana, sábado 31, es el primer día reservable. */
export const T0 = Date.parse('2026-10-30T16:00:00Z');
export const PR = (iso) => Date.parse(iso); // atajo legible en las pruebas
/** Secreto de administrador SOLO para pruebas (aleatorio de apariencia; no es un secreto real). */
export const ADMIN_SECRET = 'Xk7qR2mP9vT4nL8wZ3cB6yH1dF5gJ0sA-uE_iO2tN7bV4xQ9rM3kW8zC1hY6pD5';
export const adminHeaders = (secret = ADMIN_SECRET) => ({ authorization: `Bearer ${secret}` });
export const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

let seq = 0;
export const idem = () => `test-key-${String(++seq).padStart(6, '0')}-abcdefgh`;

export function validBody(over = {}) {
  return {
    servicioId: 2, vehiculo: 'suv', fecha: '2026-10-31', hora: '08:00', nombre: 'Ana Pérez',
    telefono: '787-555-0101', correo: 'ana@example.com', lugar: 'Urb. Las Flores, Aguada', ...over,
  };
}

/**
 * Entorno de pruebas completo: base de datos real en memoria, reloj controlable, transporte de correo de prueba
 * (captura los mensajes; puede forzar errores) y servidor HTTP en un puerto libre.
 * El transporte falso SOLO existe aquí: en producción se usa Gmail real o, si no hay credenciales, no se envía nada.
 */
export async function makeCtx({ env: envOver = {}, now = T0, rateLimits = false, dbPath = ':memory:', withTransport = true, serveStatic = false } = {}) {
  const state = { now };
  const sent = [];
  const fail = { error: null };
  const transport = withTransport ? {
    async sendMail(msg) {
      if (fail.error) throw fail.error;
      sent.push(msg);
      return { accepted: [msg.to?.address ?? msg.to], messageId: msg.messageId };
    },
    async verify() { return true; },
  } : undefined;

  const env = loadEnv({
    NODE_ENV: 'test', DATA_ENCRYPTION_KEY: TEST_KEY, GMAIL_USER: 'orama.test@example.com', OWNER_EMAIL: 'dueno@example.com',
    ADMIN_TOKEN_SECRET: ADMIN_SECRET, PUBLIC_BASE_URL: 'https://orama.example', JOBS_ENABLED: 'false', ...envOver,
  });

  const logs = [];
  const log = createLogger({ level: 'debug', write: (line) => logs.push(line) });
  const db = openDatabase(dbPath);
  migrate(db, log);
  syncCatalog(db);

  const c = buildContainer({ env, db, log, clock: () => state.now, mailTransport: transport });
  const app = buildApp(c, { rateLimits, serveStatic });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  async function api(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* no es JSON */ }
    return { status: res.status, body: json, headers: res.headers, text };
  }

  /** Reserva por HTTP con clave de idempotencia nueva. */
  const book = (over = {}, key = idem()) => api('POST', '/reservas', validBody(over), { 'idempotency-key': key });
  /** Envía todos los correos pendientes ahora (sin esperar al temporizador). */
  const flush = async () => { await new Promise((r) => setImmediate(r)); return c.processor.processBatch({ limit: 50 }); };
  const rows = (sql, ...p) => db.prepare(sql).all(...p);
  /** Envía los correos y devuelve {codigo, token} del ÚLTIMO enlace de confirmación (el que el cliente recibiría). */
  const confirmLink = async () => {
    await flush();
    const m = [...sent].reverse().find((x) => /#confirmar\//.test(x.text ?? ''));
    if (!m) return null;
    const [, codigo, token] = /#confirmar\/(OR-[A-Z0-9]{6})\/([\w-]{20,64})/.exec(m.text);
    return { codigo, token, mail: m };
  };
  /** Abre el enlace del último correo y pulsa "confirmar". */
  const confirmPending = async () => { const l = await confirmLink(); return api('POST', '/reservas/confirmar', { codigo: l.codigo, token: l.token }); };
  /** Flujo completo de cancelar: solicitud + confirmación por correo. Devuelve la respuesta final (o la de la solicitud si fue rechazada). */
  const cancelFull = async (creds) => { const r = await api('POST', '/reservas/cancelar', creds); return r.status === 202 ? confirmPending() : r; };
  const rescheduleFull = async (body) => { const r = await api('POST', '/reservas/cambiar', body); return r.status === 202 ? confirmPending() : r; };

  return {
    c, db, env, api, book, flush, confirmLink, confirmPending, cancelFull, rescheduleFull, sent, fail, logs, rows, state, port: server.address().port,
    setNow: (ms) => { state.now = ms; },
    advance: (ms) => { state.now += ms; },
    close: async () => { c.hub.close(); await new Promise((r) => server.close(r)); try { db.close(); } catch { /* ya cerrada */ } },
  };
}
