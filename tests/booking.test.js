import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PR, idem, makeCtx, validBody } from './helpers.js';

const CODE = /^OR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

describe('reservas: crear, confirmar y correo', () => {
  let ctx;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });
  beforeEach(() => { ctx.db.exec('DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM outbox_correos;'); ctx.sent.length = 0; ctx.fail.error = null; ctx.setNow(PR('2026-10-30T16:00:00Z')); });

  test('1 · un cliente reserva correctamente: queda confirmada, con número único, horas y casilleros', async () => {
    const r = await ctx.book();
    assert.equal(r.status, 201);
    const rv = r.body.reserva;
    assert.match(rv.codigo, CODE);
    assert.equal(rv.estado, 'confirmada');
    assert.equal(rv.fecha, '2026-10-31');
    assert.equal(rv.inicio, '8:00 a.m.');
    assert.equal(rv.fin, '10:30 a.m.');                       // 2 h 30 de duración
    assert.equal(rv.precio.texto, 'desde $45');               // SUV + Completo, precio fijado por el servidor
    assert.ok(r.body.tokenGestion.length >= 20);

    const [row] = ctx.rows('SELECT * FROM reservas');
    assert.equal(row.estado, 'confirmada');
    assert.equal(row.inicio_min, 480); assert.equal(row.fin_min, 630); assert.equal(row.bloque_fin_min, 660);
    assert.ok(row.creada_en);
    assert.equal(ctx.rows('SELECT * FROM reserva_slots').length, 6);   // 3 h = 6 casilleros de 30 min
    assert.equal(ctx.rows('SELECT * FROM reserva_eventos').length, 1);
  });

  test('2 · el cliente recibe el correo de confirmación con todos los datos y cómo gestionar su reserva', async () => {
    const r = await ctx.book({ lugar: 'Calle Sol #5, Aguada' });
    assert.equal(r.status, 201);
    assert.equal(r.body.correo.estado, 'en_cola', 'la respuesta no afirma "enviado": solo que quedó en cola');
    await ctx.flush();

    assert.equal(ctx.sent.length, 1);
    const m = ctx.sent[0];
    assert.equal(m.to, 'ana@example.com');
    assert.match(m.subject, /OR-[A-Z0-9]{6}/);
    const code = r.body.reserva.codigo;
    for (const dato of [code, 'Ana Pérez', 'Servicio #2 · Completo', 'sábado', 'sábado 31 de octubre de 2026', '8:00 a.m.', '10:30 a.m.', 'Calle Sol #5, Aguada', '787-662-5851']) {
      assert.ok(m.text.includes(dato), `el texto debe incluir: ${dato}`);
      assert.ok(m.html.includes(dato.replace('#', '#')), `el HTML debe incluir: ${dato}`);
    }
    // Instrucciones de consulta, cancelación y cambio + enlace personal (token en el fragmento #, no en la URL que viaja al servidor)
    assert.match(m.text, /Consultar:/); assert.match(m.text, /Cancelar:/); assert.match(m.text, /Cambiar fecha u hora:/);
    assert.ok(m.text.includes(`https://orama.example/#mi-reserva/${code}/${r.body.tokenGestion}`));
    assert.equal(m.messageId.startsWith('<orama-'), true);

    const [o] = ctx.rows('SELECT estado, intentos, enviado_en FROM outbox_correos');
    assert.deepEqual({ estado: o.estado, intentos: o.intentos }, { estado: 'enviado', intentos: 1 });
    assert.ok(o.enviado_en);
  });

  test('el correo escapa lo que escribe el cliente (no se puede inyectar HTML ni cabeceras)', async () => {
    await ctx.book({ lugar: '<script>alert(1)</script>"><img src=x onerror=alert(1)>' });
    await ctx.flush();
    const m = ctx.sent[0];
    assert.ok(!m.html.includes('<script>') && !m.html.includes('<img'), 'el HTML no debe contener etiquetas del cliente');
    assert.ok(m.html.includes('&lt;script&gt;'));
    assert.ok(!/[\r\n]/.test(m.subject), 'el asunto no tiene saltos de línea');
  });

  test('3 y 4 · dos clientes quieren el mismo horario a la vez: solo uno lo logra, el otro recibe aviso y no hay duplicados', async () => {
    const [a, b] = await Promise.all([
      ctx.book({ nombre: 'Cliente Uno', telefono: '787-555-1111', correo: 'uno@example.com' }),
      ctx.book({ nombre: 'Cliente Dos', telefono: '787-555-2222', correo: 'dos@example.com' }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.body.error.code, 'HORARIO_NO_DISPONIBLE');
    assert.match(loser.body.error.message, /ya no está disponible/);

    assert.equal(ctx.rows('SELECT * FROM reservas').length, 1);
    assert.equal(ctx.rows('SELECT * FROM reserva_slots').length, 6);
    assert.equal(ctx.rows('SELECT * FROM outbox_correos').length, 1, 'el perdedor no genera correo');
    assert.ok(ctx.logs.some((l) => l.includes('reserva.intento_duplicado')), 'el intento duplicado queda registrado');
  });

  test('6 · reservar un horario ocupado falla con un mensaje claro', async () => {
    assert.equal((await ctx.book()).status, 201);
    const again = await ctx.book({ telefono: '787-555-3333', correo: 'otro@example.com', nombre: 'Otra Persona' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'HORARIO_NO_DISPONIBLE');
  });

  test('un reintento con la misma Idempotency-Key devuelve la misma reserva, sin duplicar nada', async () => {
    const key = idem();
    const first = await ctx.book({}, key);
    const second = await ctx.book({}, key);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');
    assert.equal(second.body.reserva.codigo, first.body.reserva.codigo);
    assert.equal(second.body.tokenGestion, undefined, 'el token solo se entrega una vez');
    assert.equal(ctx.rows('SELECT * FROM reservas').length, 1);
    assert.equal(ctx.rows('SELECT * FROM outbox_correos').length, 1);
    // La misma clave con datos distintos no se acepta
    const clash = await ctx.book({ hora: '12:00' }, key);
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'IDEMPOTENCY_KEY_REUTILIZADA');
    // Sin clave: se rechaza
    const none = await ctx.api('POST', '/reservas', validBody({ hora: '14:00' }));
    assert.equal(none.status, 400);
  });

  test('validación: todos los campos obligatorios y con formato correcto', async () => {
    const cases = [
      [{ nombre: 'Ana' }, 'nombre'], [{ nombre: '' }, 'nombre'], [{ telefono: '123' }, 'telefono'], [{ telefono: 'abc' }, 'telefono'],
      [{ correo: 'no-es-correo' }, 'correo'], [{ correo: 'a@b' }, 'correo'], [{ lugar: '' }, 'lugar'], [{ fecha: '31-10-2026' }, 'fecha'],
      [{ vehiculo: 'moto' }, 'vehiculo'], [{ servicioId: 3 }, 'servicioId'], [{ hora: '8am' }, 'hora'],
    ];
    for (const [over, campo] of cases) {
      const r = await ctx.book(over);
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.ok(r.body.error.campos[campo], `debe señalar el campo ${campo}`);
    }
    assert.equal(ctx.rows('SELECT * FROM reservas').length, 0);
    // Campos que el cliente no debe poder fijar (asignación masiva)
    for (const extra of [{ estado: 'completada' }, { codigo: 'OR-AAAAAA' }, { precio: 1 }, { id: 7 }]) {
      assert.equal((await ctx.book(extra)).status, 400, `rechaza ${Object.keys(extra)[0]}`);
    }
  });

  test('un mismo teléfono no puede acaparar la agenda (máx. 3 reservas activas)', async () => {
    for (const hora of ['08:00', '11:00', '14:00']) assert.equal((await ctx.book({ hora, servicioId: 1 })).status, 201);
    const fourth = await ctx.book({ hora: '09:00', servicioId: 1, fecha: '2026-11-01' });
    assert.equal(fourth.status, 409);
    assert.equal(fourth.body.error.code, 'LIMITE_DE_RESERVAS');
  });

  test('la agenda cerrada (11:00 p.m. – 6:00 a.m.) no admite reservas; a las 6:00 a.m. sí', async () => {
    for (const [iso, esperado] of [['2026-10-31T02:59:00Z', 201], ['2026-10-31T03:00:00Z', 423], ['2026-10-31T09:59:00Z', 423], ['2026-10-31T10:00:00Z', 201]]) {
      ctx.db.exec('DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM outbox_correos;');
      ctx.setNow(PR(iso));
      const fecha = iso >= '2026-10-31T05:00' ? '2026-11-01' : '2026-10-31';
      const r = await ctx.book({ fecha });
      assert.equal(r.status, esperado, `${iso} → ${esperado}`);
      if (esperado === 423) assert.equal(r.body.error.code, 'AGENDA_CERRADA');
    }
  });
});

describe('reservas: consultar, cambiar, cancelar y accesos ajenos', () => {
  let ctx, mine, code, token;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ctx.db.exec('DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM outbox_correos;'); ctx.sent.length = 0; ctx.fail.error = null;
    ctx.setNow(PR('2026-10-30T16:00:00Z'));
    mine = await ctx.book({ servicioId: 1, hora: '10:00' });
    code = mine.body.reserva.codigo; token = mine.body.tokenGestion;
    await ctx.flush(); ctx.sent.length = 0;
  });

  const phoneCreds = () => ({ codigo: code, telefono: '787-555-0101' });

  test('consultar con código + teléfono, y con código + token del correo (datos de contacto enmascarados)', async () => {
    for (const creds of [phoneCreds(), { codigo: code.toLowerCase(), token }, { codigo: code.replace('OR-', 'or'), telefono: '(787) 555-0101' }]) {
      const r = await ctx.api('POST', '/reservas/consultar', creds);
      assert.equal(r.status, 200, JSON.stringify(creds));
      assert.equal(r.body.reserva.codigo, code);
      assert.equal(r.body.reserva.telefono, '***-***-0101');
      assert.equal(r.body.reserva.correo, 'a**@example.com');
      assert.equal(r.body.reserva.puedeGestionar, true);
    }
    assert.ok(!JSON.stringify((await ctx.api('POST', '/reservas/consultar', phoneCreds())).body).includes('ana@example.com'));
  });

  test('7 · cambiar fecha/hora: libera el horario viejo, ocupa el nuevo y avisa al cliente y al dueño', async () => {
    const r = await ctx.rescheduleFull({ ...phoneCreds(), fecha: '2026-11-01', hora: '13:30' });
    assert.equal(r.status, 200);
    assert.equal(r.body.reserva.fecha, '2026-11-01');
    assert.equal(r.body.reserva.inicio, '1:30 p.m.');
    assert.equal(r.body.reserva.fin, '3:00 p.m.');

    const slots = ctx.rows('SELECT fecha, slot FROM reserva_slots ORDER BY fecha, slot');
    assert.equal(slots.length, 4);
    assert.ok(slots.every((s) => s.fecha === '2026-11-01'), 'el horario anterior quedó libre');
    // El horario viejo vuelve a estar disponible para otros
    const free = (await ctx.api('GET', '/disponibilidad?servicio=1&fecha=2026-10-31')).body;
    assert.ok(free.horas.some((h) => h.valor === '10:00'));

    await ctx.flush();
    const tos = ctx.sent.map((m) => m.to).sort();
    assert.deepEqual(tos, ['ana@example.com', 'ana@example.com', 'dueno@example.com'], 'confirmación del cambio + aviso de cambio al cliente, y aviso al dueño');
    assert.match(ctx.sent.find((m) => m.to === 'dueno@example.com').text, /cambió su cita/);
    assert.equal(ctx.rows('SELECT cambios FROM reservas')[0].cambios, 1);
  });

  test('cambiar a un horario ocupado: falla y la reserva original queda intacta', async () => {
    assert.equal((await ctx.book({ servicioId: 1, hora: '14:00', telefono: '787-555-4444', correo: 'x@example.com', nombre: 'Otra Persona' })).status, 201);
    const slotsOf = () => ctx.rows('SELECT fecha, slot FROM reserva_slots WHERE reserva_id = (SELECT id FROM reservas WHERE codigo = ?) ORDER BY slot', code);
    const before = slotsOf();
    assert.equal(before.length, 4);
    const r = await ctx.api('POST', '/reservas/cambiar', { ...phoneCreds(), fecha: '2026-10-31', hora: '14:30' }); // pisa la cita de las 14:00
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'HORARIO_NO_DISPONIBLE');
    assert.deepEqual(slotsOf(), before, 'sus casilleros originales siguen ocupados');
    const row = ctx.rows('SELECT fecha, inicio_min, cambios FROM reservas WHERE codigo = ?', code)[0];
    assert.deepEqual({ ...row }, { fecha: '2026-10-31', inicio_min: 600, cambios: 0 });
  });

  test('puede moverse 30 min dentro de su propio bloque (no choca consigo misma) y repetir el mismo cambio es inofensivo', async () => {
    const r = await ctx.rescheduleFull({ ...phoneCreds(), fecha: '2026-10-31', hora: '10:30' });
    assert.equal(r.status, 200);
    assert.equal(r.body.reserva.inicio, '10:30 a.m.');
    // Pedir de nuevo el mismo horario ya no es un cambio: se avisa y no se manda otro correo
    ctx.sent.length = 0;
    const again = await ctx.api('POST', '/reservas/cambiar', { ...phoneCreds(), fecha: '2026-10-31', hora: '10:30' });
    assert.equal(again.status, 400);
    assert.equal(ctx.rows('SELECT cambios FROM reservas')[0].cambios, 1, 'no cuenta como otro cambio');
    await ctx.flush();
    assert.equal(ctx.sent.length, 0);
  });

  test('el plazo para cambiar/cancelar: hasta 60 min antes sí; después, WhatsApp', async () => {
    // La cita es el sáb 31 a las 10:00 a.m. PR = 14:00Z
    const start = PR('2026-10-31T14:00:00Z');
    ctx.setNow(start - 61 * 60e3);
    assert.equal((await ctx.api('POST', '/reservas/consultar', phoneCreds())).body.reserva.puedeGestionar, true);
    ctx.setNow(start - 60 * 60e3);   // exactamente 1 h antes: todavía se puede
    assert.equal((await ctx.api('POST', '/reservas/consultar', phoneCreds())).body.reserva.puedeGestionar, true);
    ctx.setNow(start - 59 * 60e3);   // 59 min: ya no
    const view = (await ctx.api('POST', '/reservas/consultar', phoneCreds())).body.reserva;
    assert.equal(view.puedeGestionar, false); assert.equal(view.motivoNoGestion, 'FUERA_DE_PLAZO');

    const cancel = await ctx.api('POST', '/reservas/cancelar', phoneCreds());
    assert.equal(cancel.status, 403);
    assert.equal(cancel.body.error.code, 'FUERA_DE_PLAZO');
    assert.match(cancel.body.error.whatsapp, /^https:\/\/wa\.me\/17876625851/);
    const change = await ctx.api('POST', '/reservas/cambiar', { ...phoneCreds(), fecha: '2026-11-01', hora: '09:00' });
    assert.equal(change.status, 403);
    assert.equal(ctx.rows('SELECT estado FROM reservas')[0].estado, 'confirmada', 'nada cambió');
  });

  test('de 11:00 p.m. a 6:00 a.m. tampoco se cambia ni se cancela por internet', async () => {
    ctx.setNow(PR('2026-10-31T09:00:00Z')); // 5:00 a.m. PR
    const r = await ctx.api('POST', '/reservas/cancelar', phoneCreds());
    assert.equal(r.status, 423);
    assert.equal(r.body.error.code, 'AGENDA_CERRADA');
  });

  test('8 · cancelar: libera el horario para otro cliente y avisa al cliente y al dueño', async () => {
    const r = await ctx.cancelFull({ codigo: code, token });
    assert.equal(r.status, 200);
    assert.equal(r.body.reserva.estado, 'cancelada');
    assert.equal(ctx.rows('SELECT * FROM reserva_slots').length, 0);
    // Otro cliente ya puede tomar ese horario
    const other = await ctx.book({ servicioId: 1, hora: '10:00', telefono: '787-555-5555', correo: 'otro@example.com', nombre: 'Otro Cliente' });
    assert.equal(other.status, 201);

    await ctx.flush();
    const tos = ctx.sent.map((m) => m.to).sort();
    assert.deepEqual(tos, ['ana@example.com', 'ana@example.com', 'dueno@example.com', 'otro@example.com'], 'confirmación de cancelación + aviso al cliente, aviso al dueño y la confirmación del otro cliente');
    assert.match(ctx.sent.find((m) => m.to === 'dueno@example.com').text, /canceló su cita/);

    // Repetir la cancelación (respuesta perdida) es inofensivo: la reserva ya no está activa y no se manda ningún correo
    ctx.sent.length = 0;
    const again = await ctx.api('POST', '/reservas/cancelar', { codigo: code, token });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'RESERVA_NO_ACTIVA');
    await ctx.flush();
    assert.equal(ctx.sent.length, 0);
    // y una reserva cancelada no se puede cambiar
    const change = await ctx.api('POST', '/reservas/cambiar', { codigo: code, token, fecha: '2026-11-01', hora: '09:00' });
    assert.equal(change.status, 409);
    assert.equal(change.body.error.code, 'RESERVA_NO_ACTIVA');
  });

  test('9 · nadie accede, cambia ni cancela una reserva ajena; todos los fallos se ven iguales', async () => {
    const other = await ctx.book({ servicioId: 1, hora: '14:00', telefono: '787-555-9999', correo: 'otro@example.com', nombre: 'Otro Cliente' });
    const otherCode = other.body.reserva.codigo;
    const attempts = [
      ['/reservas/consultar', { codigo: code, telefono: '787-555-9999' }],            // mi código, teléfono de otro
      ['/reservas/consultar', { codigo: otherCode, telefono: '787-555-0101' }],       // código de otro, mi teléfono
      ['/reservas/consultar', { codigo: 'OR-AAAAAA', telefono: '787-555-0101' }],     // código inexistente
      ['/reservas/consultar', { codigo: code, token: 'x'.repeat(32) }],               // token falso
      ['/reservas/cancelar', { codigo: otherCode, telefono: '787-555-0101' }],
      ['/reservas/cambiar', { codigo: otherCode, telefono: '787-555-0101', fecha: '2026-11-01', hora: '09:00' }],
      ['/reservas/cambiar', { codigo: otherCode, token, fecha: '2026-11-01', hora: '09:00' }], // mi token con su código
    ];
    const bodies = new Set();
    for (const [path, body] of attempts) {
      const r = await ctx.api('POST', path, body);
      assert.equal(r.status, 404, `${path} ${JSON.stringify(body)}`);
      bodies.add(JSON.stringify({ ...r.body.error, requestId: undefined }));
    }
    assert.equal(bodies.size, 1, 'el mensaje es idéntico: no se puede averiguar si un código existe');
    // La reserva ajena sigue confirmada y en su horario
    const row = ctx.rows('SELECT estado, inicio_min FROM reservas WHERE codigo = ?', otherCode)[0];
    assert.deepEqual({ ...row }, { estado: 'confirmada', inicio_min: 840 });
    // Pedir con teléfono Y token a la vez, o sin ninguno, se rechaza
    assert.equal((await ctx.api('POST', '/reservas/consultar', { codigo: code })).status, 400);
    assert.equal((await ctx.api('POST', '/reservas/consultar', { codigo: code, telefono: '787-555-0101', token })).status, 400);
  });

  test('cambiar solo permite fecha y hora: el servicio no se puede modificar', async () => {
    const r = await ctx.api('POST', '/reservas/cambiar', { ...phoneCreds(), fecha: '2026-11-01', hora: '09:00', servicioId: 2 });
    assert.equal(r.status, 400);
  });
});
