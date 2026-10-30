import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PR, makeCtx } from './helpers.js';

const HOY = PR('2026-10-30T16:00:00Z'); // viernes 12:00 p. m. en Puerto Rico

describe('segunda verificación por correo para cancelar y cambiar', () => {
  let ctx, code, creds;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ctx.db.exec('DELETE FROM acciones_pendientes; DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM clientes; DELETE FROM outbox_correos;');
    ctx.sent.length = 0; ctx.fail.error = null; ctx.setNow(HOY);
    const r = await ctx.book({ servicioId: 1, hora: '10:00' });
    code = r.body.reserva.codigo; creds = { codigo: code, telefono: '787-555-0101' };
    await ctx.flush(); ctx.sent.length = 0;
  });
  const estado = () => ctx.rows('SELECT estado, fecha, inicio_min FROM reservas WHERE codigo = ?', code)[0];

  test('pedir cancelar NO cancela: manda un correo a la dirección de la reserva y la cita sigue activa', async () => {
    const r = await ctx.api('POST', '/reservas/cancelar', creds);
    assert.equal(r.status, 202);
    assert.equal(r.body.estado, 'pendiente_confirmacion'); assert.equal(r.body.accion, 'cancelar');
    assert.equal(r.body.correo, 'a**@example.com', 'solo se muestra el correo enmascarado');
    assert.equal(estado().estado, 'confirmada');
    assert.equal(ctx.rows('SELECT * FROM reserva_slots').length, 4, 'el horario sigue ocupado');
    const l = await ctx.confirmLink();
    assert.equal(l.mail.to, 'ana@example.com');
    assert.match(l.mail.subject, /Confirma la cancelación/);
    assert.match(l.mail.text, /Tu cita sigue activa hasta que confirmes/);
    assert.ok(!ctx.sent.some((m) => m.to === 'dueno@example.com'), 'el dueño no recibe aviso hasta que el cliente confirme');
  });

  test('ver el enlace no hace nada; confirmarlo cancela UNA vez y el enlace no se puede reutilizar', async () => {
    await ctx.api('POST', '/reservas/cancelar', creds);
    const l = await ctx.confirmLink();
    const prev = await ctx.api('POST', '/reservas/accion', { codigo: l.codigo, token: l.token });
    assert.equal(prev.status, 200); assert.equal(prev.body.accion, 'cancelar');
    assert.equal(estado().estado, 'confirmada', 'mirar el enlace (o que un escáner lo abra) no cancela');
    const done = await ctx.api('POST', '/reservas/confirmar', { codigo: l.codigo, token: l.token });
    assert.equal(done.status, 200); assert.equal(done.body.accion, 'cancelar'); assert.equal(done.body.reserva.estado, 'cancelada');
    assert.equal(ctx.rows('SELECT * FROM reserva_slots').length, 0);
    const again = await ctx.api('POST', '/reservas/confirmar', { codigo: l.codigo, token: l.token });
    assert.equal(again.status, 409); assert.equal(again.body.error.code, 'ENLACE_USADO');
    await ctx.flush();
    assert.ok(ctx.sent.some((m) => m.to === 'dueno@example.com' && /canceló su cita/.test(m.text)), 'ahora sí avisa al dueño');
    const aviso = ctx.sent.find((m) => m.to === 'dueno@example.com' && /canceló su cita/.test(m.text));
    assert.match(aviso.subject, /^Cita cancelada por el cliente · Ana Pérez · OR-/);
    assert.match(aviso.html, /Un cliente canceló su cita/); assert.match(aviso.html, /Llamar al cliente/); assert.match(aviso.html, /href="tel:\+?7875550101"/);
    assert.ok(!aviso.html.includes('<pre'), 'el aviso ya no es texto sin formato');
  });

  test('dos clics a la vez en el enlace: solo uno ejecuta', async () => {
    await ctx.api('POST', '/reservas/cancelar', creds);
    const l = await ctx.confirmLink();
    const [a, b] = await Promise.all([1, 2].map(() => ctx.api('POST', '/reservas/confirmar', { codigo: l.codigo, token: l.token })));
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(ctx.rows("SELECT * FROM outbox_correos WHERE tipo = 'cancelacion'").length, 1, 'un solo correo de cancelación');
  });

  test('el enlace vence (2 h) y también si ya pasó el plazo de 60 min antes de la cita', async () => {
    await ctx.api('POST', '/reservas/cancelar', creds);
    const l = await ctx.confirmLink();
    ctx.advance(2 * 3600e3 + 1000);
    const exp = await ctx.api('POST', '/reservas/confirmar', { codigo: l.codigo, token: l.token });
    assert.equal(exp.status, 410); assert.equal(exp.body.error.code, 'ENLACE_VENCIDO');
    assert.equal(estado().estado, 'confirmada');
    // Plazo: la cita es el sábado 10:00 a. m. PR; 30 min antes ya no se puede aunque el enlace no haya vencido
    ctx.setNow(PR('2026-10-31T14:00:00Z') - 90 * 60e3); // 90 min antes: aún se puede pedir
    await ctx.api('POST', '/reservas/cancelar', creds);
    const l2 = await ctx.confirmLink();
    ctx.advance(40 * 60e3); // el cliente abre el correo 50 min antes de la cita
    const late = await ctx.api('POST', '/reservas/confirmar', { codigo: l2.codigo, token: l2.token });
    assert.equal(late.status, 403); assert.equal(late.body.error.code, 'FUERA_DE_PLAZO');
    assert.equal(estado().estado, 'confirmada');
  });

  test('un enlace no sirve con otro código, ni inventado: todos los fallos se ven igual', async () => {
    const other = await ctx.book({ servicioId: 1, hora: '14:00', telefono: '787-555-0909', correo: 'otro@example.com', nombre: 'Otro Cliente' });
    await ctx.api('POST', '/reservas/cancelar', creds);
    const l = await ctx.confirmLink();
    const bad = [
      { codigo: other.body.reserva.codigo, token: l.token }, { codigo: l.codigo, token: 'x'.repeat(43) }, { codigo: 'OR-AAAAAA', token: l.token },
    ];
    const bodies = new Set();
    for (const b of bad) {
      const r = await ctx.api('POST', '/reservas/confirmar', b);
      assert.equal(r.status, 404);
      bodies.add(JSON.stringify({ ...r.body.error, requestId: undefined }));
      assert.equal((await ctx.api('POST', '/reservas/accion', b)).status, 404);
    }
    assert.equal(bodies.size, 1);
    assert.equal(estado().estado, 'confirmada'); assert.equal(ctx.rows("SELECT estado FROM reservas WHERE codigo = ?", other.body.reserva.codigo)[0].estado, 'confirmada');
  });

  test('pedirlo dos veces seguidas no manda dos correos; pasado 1 minuto sí y el enlace anterior deja de servir', async () => {
    await ctx.api('POST', '/reservas/cancelar', creds);
    await ctx.api('POST', '/reservas/cancelar', creds);
    await ctx.flush();
    assert.equal(ctx.sent.filter((m) => /Confirma la cancelación/.test(m.subject)).length, 1);
    const first = await ctx.confirmLink();
    ctx.advance(61e3);
    await ctx.api('POST', '/reservas/cancelar', creds);
    const second = await ctx.confirmLink();
    assert.notEqual(first.token, second.token);
    assert.equal((await ctx.api('POST', '/reservas/confirmar', { codigo: first.codigo, token: first.token })).status, 404, 'el enlace viejo ya no existe');
    assert.equal((await ctx.api('POST', '/reservas/confirmar', { codigo: second.codigo, token: second.token })).status, 200);
  });

  test('cambiar: se valida al pedir, la cita no cambia hasta confirmar y se confirma con el horario libre', async () => {
    const r = await ctx.api('POST', '/reservas/cambiar', { ...creds, fecha: '2026-11-01', hora: '13:30' });
    assert.equal(r.status, 202); assert.equal(r.body.accion, 'cambiar');
    assert.deepEqual({ fecha: r.body.nueva.fecha, inicio: r.body.nueva.inicio, fin: r.body.nueva.fin }, { fecha: '2026-11-01', inicio: '1:30 p.m.', fin: '3:00 p.m.' });
    assert.deepEqual({ ...estado() }, { estado: 'confirmada', fecha: '2026-10-31', inicio_min: 600 }, 'sin cambios hasta confirmar');
    const l = await ctx.confirmLink();
    assert.match(l.mail.subject, /Confirma el cambio/);
    assert.match(l.mail.text, /Nueva fecha: domingo 1 de noviembre de 2026/);
    const prev = await ctx.api('POST', '/reservas/accion', { codigo: l.codigo, token: l.token });
    assert.equal(prev.body.nueva.inicio, '1:30 p.m.');
    const done = await ctx.api('POST', '/reservas/confirmar', { codigo: l.codigo, token: l.token });
    assert.equal(done.status, 200); assert.equal(done.body.reserva.fecha, '2026-11-01'); assert.equal(done.body.reserva.inicio, '1:30 p.m.');
    assert.equal(ctx.rows('SELECT DISTINCT fecha FROM reserva_slots').length, 1);
  });

  test('cambiar a un horario ocupado se rechaza al pedir; si lo toman mientras tanto, la confirmación falla y la cita original queda intacta', async () => {
    await ctx.book({ servicioId: 1, hora: '14:00', telefono: '787-555-4444', correo: 'x@example.com', nombre: 'Otra Persona' });
    const taken = await ctx.api('POST', '/reservas/cambiar', { ...creds, fecha: '2026-10-31', hora: '14:30' });
    assert.equal(taken.status, 409); assert.equal(taken.body.error.code, 'HORARIO_NO_DISPONIBLE');
    assert.equal(ctx.rows('SELECT * FROM acciones_pendientes').length, 0, 'no se creó ninguna acción');

    assert.equal((await ctx.api('POST', '/reservas/cambiar', { ...creds, fecha: '2026-11-01', hora: '09:00' })).status, 202);
    const l = await ctx.confirmLink();
    await ctx.book({ servicioId: 1, hora: '09:00', fecha: '2026-11-01', telefono: '787-555-7777', correo: 'y@example.com', nombre: 'Tercera Persona' }); // alguien la toma antes
    const done = await ctx.api('POST', '/reservas/confirmar', { codigo: l.codigo, token: l.token });
    assert.equal(done.status, 409); assert.equal(done.body.error.code, 'HORARIO_NO_DISPONIBLE');
    assert.deepEqual({ ...estado() }, { estado: 'confirmada', fecha: '2026-10-31', inicio_min: 600 });
    assert.equal(ctx.rows('SELECT usada_en FROM acciones_pendientes')[0].usada_en, null, 'el enlace no se gasta: se puede pedir otro horario');
  });

  test('al cambiar o cancelar, los enlaces pendientes de la misma reserva dejan de servir', async () => {
    await ctx.api('POST', '/reservas/cancelar', creds);
    const cancelLink = await ctx.confirmLink();
    ctx.advance(61e3);
    assert.equal((await ctx.api('POST', '/reservas/cambiar', { ...creds, fecha: '2026-11-01', hora: '09:00' })).status, 202);
    const changeLink = await ctx.confirmLink();
    assert.equal((await ctx.api('POST', '/reservas/confirmar', { codigo: changeLink.codigo, token: changeLink.token })).status, 200);
    const stale = await ctx.api('POST', '/reservas/confirmar', { codigo: cancelLink.codigo, token: cancelLink.token });
    assert.equal(stale.status, 404, 'el enlace de cancelar pedido antes del cambio ya no existe');
    assert.equal(estado().estado, 'confirmada');
  });

  test('sin correo configurado no se finge nada: se avisa y se ofrece WhatsApp, sin crear acciones pendientes', async () => {
    const bare = await makeCtx({ withTransport: false, env: { GMAIL_USER: '' } });
    try {
      const b = await bare.book({ servicioId: 1, hora: '10:00' });
      const r = await bare.api('POST', '/reservas/cancelar', { codigo: b.body.reserva.codigo, telefono: '787-555-0101' });
      assert.equal(r.status, 503); assert.equal(r.body.error.code, 'CORREO_NO_DISPONIBLE');
      assert.match(r.body.error.whatsapp, /wa\.me/);
      assert.equal(bare.rows('SELECT * FROM acciones_pendientes').length, 0);
    } finally { await bare.close(); }
  });

  test('el propietario sí cancela directo (por WhatsApp acordado) y se avisa al cliente', async () => {
    const { ADMIN_SECRET } = await import('./helpers.js');
    const r = await ctx.api('POST', '/admin/reservas/cancelar', { codigo: code }, { authorization: `Bearer ${ADMIN_SECRET}` });
    assert.equal(r.status, 200); assert.equal(estado().estado, 'cancelada');
    await ctx.flush();
    assert.ok(ctx.sent.some((m) => m.to === 'ana@example.com' && /Cita cancelada/.test(m.subject)));
  });

  test('las acciones vencidas se borran con la limpieza y las pendientes se borran si la reserva se elimina', async () => {
    await ctx.api('POST', '/reservas/cancelar', creds);
    assert.equal(ctx.rows('SELECT * FROM acciones_pendientes').length, 1);
    ctx.db.exec("UPDATE acciones_pendientes SET expira_en = '2000-01-01T00:00:00.000Z'");
    ctx.c.cleanup.run({ modo: 'automatica' });
    assert.equal(ctx.rows('SELECT * FROM acciones_pendientes').length, 0);
  });
});
