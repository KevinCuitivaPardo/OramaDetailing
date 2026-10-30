import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PR, adminHeaders, makeCtx } from './helpers.js';

/** Abre el flujo en vivo (SSE) y junta lo que llega. */
function openStream(port) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/api/eventos', agent: false, headers: { accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); if (/^event: cambio/m.test(block)) events.push(JSON.parse(/^data: (.*)$/m.exec(block)[1])); } });
      resolve({ status: res.statusCode, headers: res.headers, events, close: () => req.destroy() });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
}
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

describe('cambios en tiempo real (SSE)', () => {
  let ctx;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });
  beforeEach(() => { ctx.db.exec('DELETE FROM acciones_pendientes; DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM clientes; DELETE FROM outbox_correos; DELETE FROM calendario_dias;'); ctx.setNow(PR('2026-10-30T16:00:00Z')); });

  test('una reserva nueva avisa al instante a las páginas abiertas, y el aviso no lleva datos de nadie', async () => {
    const s = await openStream(ctx.port);
    try {
      assert.equal(s.status, 200); assert.match(s.headers['content-type'], /text\/event-stream/);
      assert.match(s.headers['cache-control'], /no-store/);
      await ctx.book({ servicioId: 1, hora: '10:00', fecha: '2026-11-04' });
      assert.ok(await until(() => s.events.length >= 1), 'llegó el aviso');
      assert.deepEqual(Object.keys(s.events[0]).sort(), ['t', 'tipo']);
      assert.equal(s.events[0].tipo, 'disponibilidad');
    } finally { s.close(); }
  });

  test('un cambio del propietario (cerrar un día) avisa; una petición rechazada no avisa', async () => {
    const s = await openStream(ctx.port);
    try {
      assert.equal((await ctx.api('PUT', '/admin/calendario/excepciones', { fecha: '2026-11-04', tipo: 'cerrado' })).status, 401);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(s.events.length, 0, 'sin credenciales no cambia nada ni avisa');
      assert.equal((await ctx.api('PUT', '/admin/calendario/excepciones', { fecha: '2026-11-04', tipo: 'cerrado', motivo: 'x' }, adminHeaders())).status, 200);
      assert.ok(await until(() => s.events.length === 1));
      // Y la página, al volver a pedir la disponibilidad, ya ve el día cerrado
      assert.equal((await ctx.api('GET', '/disponibilidad?servicio=1&fecha=2026-11-04')).body.motivo, 'DIA_NO_LABORABLE');
    } finally { s.close(); }
  });

  test('varios cambios seguidos se agrupan en un solo aviso', async () => {
    const s = await openStream(ctx.port);
    try {
      for (const f of ['2026-11-04', '2026-11-05', '2026-11-06']) await ctx.api('PUT', '/admin/calendario/excepciones', { fecha: f, tipo: 'cerrado' }, adminHeaders());
      assert.ok(await until(() => s.events.length >= 1));
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(s.events.length, 1);
    } finally { s.close(); }
  });

  test('límite de conexiones por IP: no se puede agotar el servidor abriendo flujos', async () => {
    const open = [];
    try {
      for (let i = 0; i < 6; i++) open.push(await openStream(ctx.port));
      assert.ok(open.every((s) => s.status === 200));
      const seventh = await openStream(ctx.port);
      assert.equal(seventh.status, 429);
      seventh.close();
    } finally { open.forEach((s) => s.close()); }
  });
});
