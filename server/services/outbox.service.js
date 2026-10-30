import { renderEmail } from '../emails/templates.js';
import { classifyError, sanitizeError } from '../integrations/gmail.js';

const MAX_ATTEMPTS = 8;
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720]; // 1 min, 5, 15, 1 h, 3 h, 6 h, 12 h
const AUTH_PAUSE_MS = 15 * 60e3;
const QUOTA_PAUSE_MS = 60 * 60e3; // cuota diaria / bloqueo temporal de Gmail: insistir solo empeora
const LEASE_MS = 2 * 60e3;

/**
 * Trabajador del outbox: toma correos pendientes de la base de datos y los envía por Gmail.
 *  - La reserva ya está confirmada y guardada; un fallo de correo NUNCA la deshace ni la duplica.
 *  - Cada fila se "reclama" de forma atómica (con un candado temporal), así dos procesos no envían lo mismo.
 *  - Errores temporales → reintento con espera creciente. Errores definitivos (destinatario inválido) → 'fallido'.
 *  - Si Gmail rechaza las credenciales se pausa 15 min sin gastar intentos de los correos (el problema no es del mensaje).
 */
export function createOutboxProcessor({ outbox, mailer, fc, log, env, clock = Date.now, refresh = {} }) {
  let running = false;
  let inFlight = Promise.resolve();
  let pausedUntil = 0;
  let warnedUnconfigured = false;

  async function processBatch({ limit = 10 } = {}) {
    if (running) return { skipped: 'en_curso' };
    if (!mailer.configured) {
      if (!warnedUnconfigured) { log.warn('correo.gmail_no_configurado', { detalle: 'Los correos quedan en cola hasta configurar GMAIL_USER y GMAIL_APP_PASSWORD' }); warnedUnconfigured = true; }
      return { skipped: 'sin_configurar' };
    }
    if (clock() < pausedUntil) return { skipped: 'pausado' };

    running = true;
    const result = { enviados: 0, reintentos: 0, fallidos: 0 };
    let done;
    inFlight = new Promise((r) => { done = r; });
    try {
      const now = new Date(clock()).toISOString();
      // Correos que quedaron "enviando" y ya gastaron todos sus intentos (el proceso murió a mitad del envío) → fallidos, no se reclaman otra vez
      const exhausted = outbox.failExhausted(now, MAX_ATTEMPTS);
      if (exhausted) log.error('correo.intentos_agotados', { cantidad: exhausted });

      const batch = outbox.claim(now, limit, LEASE_MS);
      for (let i = 0; i < batch.length; i++) {
        await sendOne(batch[i], result);
        if (clock() < pausedUntil) {
          // Gmail rechazó las credenciales o la cuota: el resto del lote vuelve a la cola sin gastar intentos
          const next = new Date(pausedUntil).toISOString();
          for (const rest of batch.slice(i + 1)) outbox.release(rest.id, next, 'Envío en pausa por un problema con Gmail');
          break;
        }
      }
    } finally {
      running = false;
      done();
    }
    return result;
  }

  async function sendOne(row, result) {
    let message, to;
    try {
      to = fc.decrypt(row.destinatario_enc);
      const payload = JSON.parse(fc.decrypt(row.payload_enc));
      // Algunos correos (el resumen del dueño) se reconstruyen con el estado ACTUAL de la base de datos justo antes de enviarse
      message = renderEmail(row.tipo, refresh[row.tipo] ? refresh[row.tipo](payload) : payload);
    } catch (err) {
      // Un correo que no se puede ni armar nunca saldrá: marcarlo fallido para que no bloquee la cola
      outbox.markFailed(row.id, sanitizeError(err, env));
      result.fallidos++;
      log.error('correo.no_se_pudo_armar', { id: row.id, tipo: row.tipo, error: sanitizeError(err, env) });
      return;
    }

    try {
      await mailer.send({ to, ...message, outboxId: row.id });
      outbox.markSent(row.id, new Date(clock()).toISOString());
      result.enviados++;
      log.info('correo.enviado', { id: row.id, tipo: row.tipo, intento: row.intentos });
    } catch (err) {
      const kind = classifyError(err);
      const error = sanitizeError(err, env);
      const nowMs = clock();

      if (kind === 'auth') {
        pausedUntil = nowMs + AUTH_PAUSE_MS;
        outbox.release(row.id, new Date(pausedUntil).toISOString(), error);
        result.reintentos++;
        log.error('correo.gmail_credenciales_rechazadas', { id: row.id, error, pausaMin: AUTH_PAUSE_MS / 60e3 });
      } else if (kind === 'quota') {
        pausedUntil = nowMs + QUOTA_PAUSE_MS;
        outbox.release(row.id, new Date(pausedUntil).toISOString(), error);
        result.reintentos++;
        log.error('correo.gmail_cuota_o_limite', { id: row.id, error, pausaMin: QUOTA_PAUSE_MS / 60e3 });
      } else if (kind === 'permanent' || row.intentos >= MAX_ATTEMPTS) {
        outbox.markFailed(row.id, error);
        result.fallidos++;
        log.error('correo.fallido', { id: row.id, tipo: row.tipo, intentos: row.intentos, error });
      } else {
        const waitMin = BACKOFF_MIN[Math.min(row.intentos - 1, BACKOFF_MIN.length - 1)];
        outbox.markRetry(row.id, new Date(nowMs + waitMin * 60e3).toISOString(), error);
        result.reintentos++;
        log.warn('correo.error_envio', { id: row.id, tipo: row.tipo, intento: row.intentos, reintentoEnMin: waitMin, error });
      }
    }
  }

  return {
    processBatch,
    isPaused: () => clock() < pausedUntil,
    /** Se resuelve cuando no hay un lote en curso (apagado ordenado: no cortar un envío a la mitad). */
    idle: () => inFlight,
  };
}
