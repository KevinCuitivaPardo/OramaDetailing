/**
 * Cambios en tiempo real (Server-Sent Events). Cuando algo cambia en la agenda (una reserva, una cancelación, un día cerrado,
 * un bloqueo de horas, el horario…) el servidor avisa a las páginas abiertas con un mensaje mínimo: "la disponibilidad cambió".
 * El mensaje NO lleva datos de clientes ni de reservas; cada página vuelve a pedir lo que necesita (y las rutas protegidas
 * siguen exigiendo sesión). Si la conexión se corta, el navegador la reabre sola y la página sigue refrescándose por temporizador.
 */
const MAX_TOTAL = 400, MAX_PER_IP = 6, HEARTBEAT_MS = 25_000, COALESCE_MS = 150;

export function createEventHub({ log, clock = Date.now } = {}) {
  const clients = new Map(); // res → ip
  let pending = null, heartbeat = null;

  const perIp = (ip) => { let n = 0; for (const v of clients.values()) if (v === ip) n++; return n; };

  function write(res, text) { try { res.write(text); } catch { clients.delete(res); } }

  function ensureHeartbeat() {
    if (heartbeat || !clients.size) return;
    heartbeat = setInterval(() => {
      for (const res of clients.keys()) write(res, ': latido\n\n');
      if (!clients.size) { clearInterval(heartbeat); heartbeat = null; }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  return {
    get size() { return clients.size; },

    /** Abre un flujo. Devuelve false si se alcanzó el límite (el llamador responde 503/429). */
    add(req, res) {
      const ip = req.ip ?? 'x';
      if (clients.size >= MAX_TOTAL || perIp(ip) >= MAX_PER_IP) return false;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.set(res, ip);
      ensureHeartbeat();
      const drop = () => { clients.delete(res); };
      req.on('close', drop); res.on('close', drop); res.on('error', drop);
      return true;
    },

    /** Avisa a todos que la disponibilidad cambió (varios avisos seguidos se agrupan en uno). */
    publish(kind = 'disponibilidad') {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        const msg = `event: cambio\ndata: ${JSON.stringify({ tipo: kind, t: clock() })}\n\n`;
        for (const res of clients.keys()) write(res, msg);
        if (clients.size) log?.debug?.('eventos.enviado', { suscriptores: clients.size });
      }, COALESCE_MS);
      pending.unref?.();
    },

    close() {
      if (pending) clearTimeout(pending);
      if (heartbeat) clearInterval(heartbeat);
      for (const res of clients.keys()) { try { res.end(); } catch { /* ya cerrada */ } }
      clients.clear();
    },
  };
}
