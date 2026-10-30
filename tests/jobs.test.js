import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PR, adminHeaders, makeCtx } from './helpers.js';
import { summaryTarget } from '../server/jobs/tasks.js';

const wipe = (ctx) => { ctx.db.exec('DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM outbox_correos; DELETE FROM job_runs;'); ctx.sent.length = 0; ctx.fail.error = null; };

describe('resumen diario para el dueño (escenarios 12 y 13)', () => {
  let ctx;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });
  beforeEach(() => { wipe(ctx); ctx.setNow(PR('2026-10-30T16:00:00Z')); });

  const clients = [
    { hora: '14:00', servicioId: 1, nombre: 'Carlos Rivera', telefono: '787-555-1400', correo: 'carlos@example.com', lugar: 'Calle Luna 14, Aguada' },
    { hora: '08:00', servicioId: 2, nombre: 'María Soto', telefono: '787-555-0800', correo: 'maria@example.com', lugar: 'Urb. Brisas 3, Aguadilla' },
    { hora: '11:00', servicioId: 1, nombre: 'José Lugo', telefono: '787-555-1100', correo: 'jose@example.com', lugar: 'Carr. 115 km 2, Aguada' },
  ];
  async function seedDay() {
    const out = [];
    for (const c of clients) out.push((await ctx.book(c)).body.reserva.codigo); // se crean FUERA de orden cronológico
    await ctx.flush(); ctx.sent.length = 0;
    return out;
  }
  const atNightBefore = () => ctx.setNow(PR('2026-10-31T03:00:00Z')); // 11:00 p.m. del viernes 30 → resume el sábado 31

  test('el resumen lista a TODOS los clientes del día siguiente, ordenados por hora, con el formato pedido', async () => {
    const [c14, c8, c11] = await seedDay();
    atNightBefore();
    const run = await ctx.c.tasks.dailySummary();
    assert.equal(run.ok, true);
    await ctx.flush();

    const mails = ctx.sent.filter((m) => m.to === 'dueno@example.com');
    assert.equal(mails.length, 1);
    const t = mails[0].text;
    assert.match(t, /^RESERVAS PROGRAMADAS PARA EL DÍA SIGUIENTE\nFecha: sábado 31 de octubre de 2026\n/);
    // Orden cronológico: 8:00, 11:00, 14:00 (aunque se crearon 14:00, 8:00, 11:00)
    const order = [...t.matchAll(/Número de reserva: (OR-\w+)/g)].map((m) => m[1]);
    assert.deepEqual(order, [c8, c11, c14]);
    assert.ok(t.indexOf('CLIENTE 1') < t.indexOf('CLIENTE 2') && t.indexOf('CLIENTE 2') < t.indexOf('CLIENTE 3'));
    assert.ok(t.includes(['CLIENTE 1', 'Nombre: María Soto', 'Teléfono: 787-555-0800', 'Lugar: Urb. Brisas 3, Aguadilla', `Número de reserva: ${c8}`, 'Servicio: Servicio #2 · Completo', 'Horario: 8:00 a.m. - 10:30 a.m.'].join('\n')));
    assert.ok(t.includes('Horario: 11:00 a.m. - 12:30 p.m.'));
    assert.ok(t.includes('Horario: 2:00 p.m. - 3:30 p.m.'));
    assert.match(t, /Total: 3 reservas/);
    assert.match(mails[0].subject, /sábado 31 de octubre/);
  });

  test('las canceladas no aparecen; y se omite un cliente solo si de verdad se canceló', async () => {
    const [, c8, c11] = await seedDay();
    ctx.db.prepare("UPDATE reservas SET estado = 'cancelada', cancelada_en = '2026-10-30T20:00:00Z', cancelada_por = 'cliente' WHERE codigo = ?").run(c8);
    atNightBefore();
    await ctx.c.tasks.dailySummary(); await ctx.flush();
    const t = ctx.sent.find((m) => m.to === 'dueno@example.com').text;
    assert.ok(!t.includes(c8)); assert.ok(t.includes(c11));
    assert.match(t, /Total: 2 reservas/);
  });

  test('es idempotente: ejecutarlo dos veces (o desde dos procesos) envía un solo correo', async () => {
    await seedDay(); atNightBefore();
    const a = await ctx.c.tasks.dailySummary();
    const b = await ctx.c.tasks.dailySummary();
    assert.equal(a.ok, true); assert.equal(b.skipped, true);
    await ctx.flush();
    assert.equal(ctx.sent.filter((m) => m.to === 'dueno@example.com').length, 1);
    assert.equal(ctx.rows("SELECT * FROM outbox_correos WHERE tipo = 'resumen_dueno'").length, 1);
    assert.equal(ctx.rows('SELECT estado FROM job_runs')[0].estado, 'ok');
  });

  test('día sin reservas: el correo lo dice claramente', async () => {
    ctx.setNow(PR('2026-11-01T03:00:00Z')); // 11 p.m. del sábado → resume el domingo 1 de noviembre
    const run = await ctx.c.tasks.dailySummary(); assert.equal(run.ok, true);
    await ctx.flush();
    const m = ctx.sent.find((x) => x.to === 'dueno@example.com');
    assert.match(m.text, /Fecha: domingo 1 de noviembre de 2026/);
    assert.match(m.text, /No hay reservas confirmadas para esta fecha\./);
    assert.ok(!m.text.includes('CLIENTE 1'));
  });

  test('si el día siguiente no es laborable (lunes/martes) no se envía correo, y queda registrado', async () => {
    ctx.setNow(PR('2026-11-02T03:00:00Z')); // 11 p.m. del domingo → lunes 2
    const run = await ctx.c.tasks.dailySummary();
    assert.equal(run.ok, true);
    assert.equal(ctx.rows("SELECT * FROM outbox_correos WHERE tipo = 'resumen_dueno'").length, 0);
    assert.match(ctx.rows('SELECT detalle FROM job_runs')[0].detalle, /dia_no_laborable/);
  });

  test('qué día resume y cuándo: 23:00 → mañana; madrugada → hoy (recuperación tras reinicio); de día → nada', () => {
    assert.equal(summaryTarget(PR('2026-10-31T02:59:00Z')), null);          // 10:59 p.m.
    assert.equal(summaryTarget(PR('2026-10-31T03:00:00Z')), '2026-10-31');  // 11:00 p.m. del 30
    assert.equal(summaryTarget(PR('2026-10-31T06:30:00Z')), '2026-10-31');  // 2:30 a.m. del 31 (recuperación)
    assert.equal(summaryTarget(PR('2026-10-31T09:59:00Z')), '2026-10-31');  // 5:59 a.m.
    assert.equal(summaryTarget(PR('2026-10-31T10:00:00Z')), '2026-10-31');  // 6:00 a.m.: todavía se recupera un resumen pendiente
    assert.equal(summaryTarget(PR('2026-10-31T15:59:00Z')), '2026-10-31');  // 11:59 a.m.
    assert.equal(summaryTarget(PR('2026-10-31T16:00:00Z')), null);          // mediodía: ya no
  });

  test('si el servidor estuvo apagado a las 11:00 p.m., al volver de madrugada genera el resumen que faltaba', async () => {
    await seedDay();
    ctx.setNow(PR('2026-10-31T07:15:00Z')); // 3:15 a.m. del sábado 31
    const run = await ctx.c.tasks.dailySummary();
    assert.equal(run.ok, true);
    assert.equal(ctx.rows("SELECT * FROM outbox_correos WHERE tipo = 'resumen_dueno'").length, 1);
  });

  test('una ejecución abandonada a medias (el proceso murió) se retoma; una reciente no se duplica', async () => {
    atNightBefore();
    const now = ctx.state.now;
    ctx.db.prepare("INSERT INTO job_runs (job, run_key, estado, iniciado) VALUES ('resumen_diario', '2026-10-31', 'en_curso', ?)").run(new Date(now - 5 * 60e3).toISOString());
    assert.equal((await ctx.c.tasks.dailySummary()).skipped, true, 'otra ejecución sigue en curso');
    ctx.db.prepare("UPDATE job_runs SET iniciado = ?").run(new Date(now - 2 * 3600e3).toISOString());
    assert.equal((await ctx.c.tasks.dailySummary()).ok, true, 'abandonada hace 2 h: se retoma');
  });

  test('a las 22:59 aún se puede reservar (y entra al resumen); a las 23:00 ya no', async () => {
    ctx.setNow(PR('2026-10-31T02:59:00Z'));
    const last = await ctx.book({ hora: '09:00', servicioId: 1 });
    assert.equal(last.status, 201);
    ctx.setNow(PR('2026-10-31T03:00:00Z'));
    assert.equal((await ctx.book({ hora: '12:00', servicioId: 1, telefono: '787-555-7777' })).status, 423);
    await ctx.c.tasks.dailySummary(); await ctx.flush();
    const t = ctx.sent.find((m) => m.to === 'dueno@example.com').text;
    assert.ok(t.includes(last.body.reserva.codigo));
    assert.match(t, /Total: 1 reserva$/m);
  });

  test('el resumen va al correo definido por el propietario (por defecto oramasdetailing@gmail.com), configurable por variable de entorno', async () => {
    const def = await makeCtx({ env: { OWNER_EMAIL: '' } }); // vacío = valor por defecto
    try {
      assert.equal(def.env.OWNER_EMAIL, 'oramasdetailing@gmail.com');
      def.setNow(PR('2026-10-31T03:00:00Z'));
      await def.book({ servicioId: 1, hora: '10:00' });
      def.sent.length = 0;
      const run = await def.c.tasks.dailySummary();
      assert.equal(run.ok, true);
      await def.flush();
      const m = def.sent.find((x) => /RESERVAS PROGRAMADAS/.test(x.text ?? ''));
      assert.equal(m.to.address ?? m.to, 'oramasdetailing@gmail.com');
    } finally { await def.close(); }
  });
});

describe('fallos de Gmail (escenario 16): nunca duplican ni dejan inconsistencias', () => {
  let ctx;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });
  beforeEach(() => { wipe(ctx); ctx.setNow(PR('2026-10-30T16:00:00Z')); });

  test('si Gmail falla, la reserva queda confirmada UNA vez y el correo se reintenta hasta salir', async () => {
    ctx.fail.error = Object.assign(new Error('connect ETIMEDOUT smtp.gmail.com:465 para ana@example.com'), { code: 'ETIMEDOUT' });
    const key = 'clave-de-reintento-0001';
    const r = await ctx.book({}, key);
    assert.equal(r.status, 201, 'la reserva se confirma aunque Gmail esté caído');
    await ctx.flush();

    const [o] = ctx.rows('SELECT estado, intentos, ultimo_error, proximo_intento FROM outbox_correos');
    assert.equal(o.estado, 'pendiente'); assert.equal(o.intentos, 1);
    assert.ok(!/@/.test(o.ultimo_error), 'el error guardado no incluye correos');
    assert.ok(!o.ultimo_error.includes('ana'));
    assert.ok(Date.parse(o.proximo_intento) > ctx.state.now, 'espera antes del siguiente intento');
    assert.equal(ctx.sent.length, 0);

    // El cliente (o su navegador) reintenta el envío del formulario: sigue siendo la misma reserva
    const retry = await ctx.book({}, key);
    assert.equal(retry.status, 200); assert.equal(retry.body.reserva.codigo, r.body.reserva.codigo);

    // Gmail vuelve: pasa el tiempo de espera y sale exactamente un correo
    ctx.fail.error = null; ctx.advance(2 * 60e3);
    await ctx.flush();
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.rows('SELECT * FROM reservas').length, 1);
    assert.equal(ctx.rows('SELECT estado FROM outbox_correos')[0].estado, 'enviado');
    await ctx.flush();
    assert.equal(ctx.sent.length, 1, 'no se reenvía lo ya enviado');
  });

  test('destinatario rechazado (error definitivo): se marca fallido sin reintentar; la reserva sigue válida', async () => {
    ctx.fail.error = Object.assign(new Error('550 5.1.1 The email account that you tried to reach does not exist'), { responseCode: 550 });
    assert.equal((await ctx.book()).status, 201);
    await ctx.flush();
    const [o] = ctx.rows('SELECT estado, intentos FROM outbox_correos');
    assert.deepEqual({ estado: o.estado, intentos: o.intentos }, { estado: 'fallido', intentos: 1 });
    ctx.fail.error = null; ctx.advance(24 * 3600e3); await ctx.flush();
    assert.equal(ctx.sent.length, 0);
    assert.equal(ctx.rows("SELECT estado FROM reservas")[0].estado, 'confirmada');
    // El dueño puede ver que falló (sin datos personales)
    const adm = await ctx.api('GET', '/admin/correos', undefined, adminHeaders());
    assert.equal(adm.body.conteo.fallido, 1);
    assert.equal(adm.body.fallidos.length, 1);
    assert.ok(!JSON.stringify(adm.body).includes('ana@example.com'));
  });

  test('credenciales rechazadas: se pausa el envío 15 min y los correos no gastan intentos', async () => {
    ctx.fail.error = Object.assign(new Error('Invalid login: 535 5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });
    await ctx.book({ servicioId: 1, hora: '08:00' }); await ctx.book({ servicioId: 1, hora: '10:00', telefono: '787-555-2020', nombre: 'Otro Cliente', correo: 'b@example.com' });
    await ctx.flush();
    const rows = ctx.rows('SELECT estado, intentos FROM outbox_correos');
    assert.ok(rows.every((r) => r.estado === 'pendiente' && r.intentos === 0), 'intentos intactos');
    assert.equal(ctx.c.processor.isPaused(), true);
    ctx.fail.error = null;
    assert.equal((await ctx.flush()).skipped, 'pausado');
    ctx.advance(16 * 60e3);
    await ctx.flush();
    assert.equal(ctx.sent.length, 2);
  });

  test('tras demasiados intentos fallidos el correo se marca fallido', async () => {
    ctx.fail.error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await ctx.book();
    for (let i = 0; i < 9; i++) { await ctx.flush(); ctx.advance(13 * 3600e3); }
    const [o] = ctx.rows('SELECT estado, intentos FROM outbox_correos');
    assert.equal(o.estado, 'fallido'); assert.equal(o.intentos, 8);
  });

  test('un fallo al enviar NO deshace ni duplica la reserva, incluso si el cliente reintenta varias veces', async () => {
    ctx.fail.error = new Error('boom');
    const key = 'clave-reintento-multiple-1';
    for (let i = 0; i < 4; i++) await ctx.book({}, key);
    assert.equal(ctx.rows('SELECT * FROM reservas').length, 1);
    assert.equal(ctx.rows('SELECT * FROM outbox_correos').length, 1);
  });

  test('dos procesadores a la vez no envían el mismo correo dos veces (cada fila se reclama una sola vez)', async () => {
    for (let i = 0; i < 3; i++) await ctx.book({ servicioId: 1, hora: ['08:00', '10:00', '12:00'][i], telefono: `787-555-30${i}0`, correo: `c${i}@example.com`, nombre: `Cliente Numero${i}` });
    await ctx.flush(); ctx.sent.length = 0;
    ctx.db.exec("UPDATE outbox_correos SET estado = 'pendiente', intentos = 0, enviado_en = NULL");
    const claimA = ctx.c.outboxRepo.claim(new Date(ctx.state.now).toISOString(), 10, 120000);
    const claimB = ctx.c.outboxRepo.claim(new Date(ctx.state.now).toISOString(), 10, 120000);
    assert.equal(claimA.length, 3); assert.equal(claimB.length, 0, 'lo reclamado por A no lo puede reclamar B');
  });

  test('sin credenciales de Gmail no se finge ningún envío: los correos esperan en la cola', async () => {
    const bare = await makeCtx({ withTransport: false, env: { GMAIL_USER: '' } });
    try {
      const created = await bare.book();
      assert.equal(created.status, 201);
      assert.equal(created.body.correo.estado, 'sin_configurar', 'la respuesta no promete un correo que no puede salir');
      assert.equal((await bare.api('GET', '/config')).body.correoActivo, false);
      const r = await bare.flush();
      assert.equal(r.skipped, 'sin_configurar');
      assert.equal(bare.rows('SELECT estado FROM outbox_correos')[0].estado, 'pendiente');
      const health = (await bare.api('GET', '/listo')).body;
      assert.deepEqual(health, { estado: 'degradado' }, '/listo público no revela detalles');
      const detail = (await bare.api('GET', '/admin/estado', undefined, adminHeaders())).body;
      assert.equal(detail.correo, 'no_configurado'); assert.equal(detail.correosPendientes, 1);
      assert.equal((await bare.api('GET', '/admin/estado')).status, 401);
    } finally { await bare.close(); }
  });
});
