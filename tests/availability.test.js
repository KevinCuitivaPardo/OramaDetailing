import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, validBody } from './helpers.js';

/** Escenarios 5, 6, 10 y 11: disponibilidad real, bloqueo por duración, día agotado y contacto por WhatsApp. */
describe('disponibilidad y bloqueo por duración', () => {
  let ctx;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });

  const day = async (servicio, fecha = '2026-10-31') => (await ctx.api('GET', `/disponibilidad?servicio=${servicio}&fecha=${fecha}`)).body;
  const starts = (d) => d.horas.map((h) => h.valor);
  let n = 0;
  const nextPhone = () => `787-555-${String(1000 + ++n)}`; // cada cliente de prueba con su propio teléfono
  const book = (over) => ctx.book({ telefono: nextPhone(), correo: `cliente${n}@example.com`, ...over });
  const reset = () => { ctx.db.exec('DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM outbox_correos;'); };

  test('un día vacío ofrece todas las horas válidas: Completo 8:00–2:30 p.m., Exterior 8:00–3:30 p.m.', async () => {
    reset();
    const completo = starts(await day(2)), exterior = starts(await day(1));
    assert.equal(completo[0], '08:00'); assert.equal(completo.at(-1), '14:30'); assert.equal(completo.length, 14);
    assert.equal(exterior[0], '08:00'); assert.equal(exterior.at(-1), '15:30'); assert.equal(exterior.length, 16);
  });

  test('el servicio Completo a las 8:00 bloquea 3 h: nada se puede reservar hasta las 11:00', async () => {
    reset();
    const r = await book({ servicioId: 2, hora: '08:00' });
    assert.equal(r.status, 201);
    // Duración 2 h 30 → termina 10:30 (lo que ve el cliente); la agenda queda bloqueada 3 h → libre desde las 11:00
    assert.equal(r.body.reserva.fin, '10:30 a.m.');
    assert.equal(starts(await day(2))[0], '11:00');
    assert.equal(starts(await day(1))[0], '11:00');
    for (const h of ['08:30', '09:00', '10:30']) {
      const x = await book({ servicioId: 1, hora: h });
      assert.equal(x.status, 409, `a las ${h} debe estar ocupado`);
      assert.equal(x.body.error.code, 'HORARIO_NO_DISPONIBLE');
    }
    const ok = await book({ servicioId: 1, hora: '11:00' });
    assert.equal(ok.status, 201, 'a las 11:00 ya está libre');
  });

  test('el servicio Exterior a las 8:00 bloquea 2 h: libre desde las 10:00', async () => {
    reset();
    assert.equal((await book({ servicioId: 1, hora: '08:00' })).status, 201);
    assert.equal(starts(await day(1))[0], '10:00');
    assert.equal((await book({ servicioId: 1, hora: '09:30' })).status, 409);
  });

  test('un bloque nuevo no puede pisar el inicio de una reserva posterior (solapamiento hacia adelante)', async () => {
    reset();
    assert.equal((await book({ servicioId: 1, hora: '10:00' })).status, 201); // ocupa 10:00–12:00
    // Completo bloquearía 3 h: 8:00–11:00 pisa las 10:00 → no debe ofrecerse ninguna hora de Completo antes de las 12:00
    const completo = starts(await day(2));
    assert.ok(!completo.includes('08:00') && !completo.includes('09:00') && !completo.includes('10:00') && !completo.includes('11:30'));
    assert.equal(completo[0], '12:00');
    const x = await book({ servicioId: 2, hora: '08:00' });
    assert.equal(x.status, 409);
  });

  test('la última hora de inicio respeta que el servicio termine antes de las 5:00 p.m.', async () => {
    reset();
    const tarde = await book({ servicioId: 2, hora: '15:00' });
    assert.equal(tarde.status, 400);
    assert.equal(tarde.body.error.code, 'DATOS_INVALIDOS');
    assert.equal((await book({ servicioId: 2, hora: '14:30' })).status, 201);
    reset();
    assert.equal((await book({ servicioId: 1, hora: '15:30' })).status, 201);
    assert.equal((await book({ servicioId: 1, hora: '16:00' })).status, 400);
    assert.equal((await book({ servicioId: 1, hora: '07:30' })).status, 400);
    assert.equal((await book({ servicioId: 1, hora: '08:15' })).status, 400, 'solo cada 30 minutos');
  });

  test('día agotado: no hay horas, se ofrece WhatsApp y la API no deja reservar', async () => {
    reset();
    for (const hora of ['08:00', '10:00', '12:00', '14:00']) {
      assert.equal((await book({ servicioId: 1, hora })).status, 201);
    }
    const d = await day(1);
    assert.equal(d.reservable, true);
    assert.equal(d.agotado, true);
    assert.deepEqual(d.horas, []);
    // Opción de contacto por WhatsApp (número configurable)
    assert.match(d.whatsapp.url, /^https:\/\/wa\.me\/17876625851\?text=/);
    // Aunque alguien intente forzar la reserva a mano, el servidor la rechaza
    for (const hora of ['08:00', '10:30', '15:30']) {
      const x = await book({ servicioId: 1, hora });
      assert.equal(x.status, 409, `forzar ${hora} debe fallar`);
    }
    // El estado del mes lo marca como agotado
    const mes = (await ctx.api('GET', '/disponibilidad/mes?servicio=1&mes=2026-10')).body;
    assert.equal(mes.dias['2026-10-31'].estado, 'agotado');
    assert.equal(mes.dias['2026-10-30'].estado, 'fuera_de_rango'); // hoy: solo por WhatsApp
    assert.equal((await day(1, '2026-11-01')).agotado, false, 'el día siguiente sigue disponible');
  });

  test('un día con hueco para un servicio pero no para el otro', async () => {
    reset();
    // Quedan libres solo las 8:00–10:00 para Exterior, pero Completo (3 h) no cabe antes de la siguiente cita
    assert.equal((await book({ servicioId: 1, hora: '10:00' })).status, 201);
    assert.equal((await book({ servicioId: 1, hora: '12:00' })).status, 201);
    assert.equal((await book({ servicioId: 1, hora: '14:00' })).status, 201);
    assert.deepEqual(starts(await day(1)), ['08:00'], 'Exterior (2 h) solo cabe de 8:00 a 10:00');
    assert.equal((await day(2)).agotado, true, 'Completo (3 h) ya no cabe en ningún hueco');
  });

  test('lunes y martes no son laborables; hoy y el pasado no se reservan en línea; hay un límite de días', async () => {
    assert.equal((await day(1, '2026-11-02')).motivo, 'DIA_NO_LABORABLE'); // lunes
    assert.equal((await day(1, '2026-11-03')).motivo, 'DIA_NO_LABORABLE'); // martes
    assert.equal((await day(1, '2026-10-30')).motivo, 'FECHA_PASADA_O_HOY'); // hoy: se atiende por WhatsApp
    assert.equal((await day(1, '2026-10-20')).motivo, 'FECHA_PASADA_O_HOY');
    assert.equal((await day(1, '2026-12-27')).reservable, true);  // día 58, domingo
    assert.equal((await day(1, '2027-01-03')).motivo, 'FECHA_MUY_LEJANA');
    const bad = await ctx.api('GET', '/disponibilidad?servicio=1&fecha=2026-02-31');
    assert.equal(bad.status, 400);
    const bad2 = await ctx.api('GET', '/disponibilidad?servicio=9&fecha=2026-10-31');
    assert.equal(bad2.status, 400);
    const post = await book({ fecha: '2026-11-02', hora: '08:00' }); // lunes
    assert.equal(post.status, 422);
    assert.equal(post.body.error.code, 'FECHA_NO_PERMITIDA');
  });
});
