import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PR, adminHeaders, makeCtx } from './helpers.js';

const JOBS_SECRET = 'Qm4vR8tY2nB6xK1pL9wZ3cD7fH5gJ0sA-uE_iO2tN7bV4xQ9rM3kW8zC1hY6pD5';
const NIGHT = PR('2026-10-31T03:00:00Z'); // viernes 30/oct, 11:00 p.m. en Puerto Rico (UTC-4)
const wipe = (ctx) => {
  ctx.db.exec('DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM clientes; DELETE FROM outbox_correos; DELETE FROM job_runs; DELETE FROM calendario_dias; DELETE FROM limpieza_ejecuciones; DELETE FROM auditoria_admin;'); ctx.db.exec('UPDATE servicios SET activo = 1');
  ctx.db.exec("UPDATE configuracion SET valor = '3,4,5,6,0' WHERE clave = 'dias_operacion'");
  ctx.sent.length = 0; ctx.fail.error = null; ctx.setNow(PR('2026-10-30T16:00:00Z'));
};

describe('calendario configurable: días de operación, festivos y excepciones', () => {
  let ctx;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });
  beforeEach(() => wipe(ctx));

  const A = (method, path, body) => ctx.api(method, path, body, adminHeaders());
  const day = async (fecha) => (await ctx.api('GET', `/disponibilidad?servicio=1&fecha=${fecha}`)).body;

  test('los valores por defecto son miércoles a domingo, pero nada está fijo en el código', async () => {
    assert.deepEqual(ctx.c.calendar.weekdays(), [0, 3, 4, 5, 6]);
    assert.equal((await day('2026-11-03')).motivo, 'DIA_NO_LABORABLE'); // martes
    // El administrador decide que los sábados NO se trabaja
    const r = await A('PUT', '/admin/calendario/dias-operacion', { dias: [3, 4, 5, 0] });
    assert.equal(r.status, 200); assert.deepEqual(r.body.diasOperacion, [0, 3, 4, 5]);
    assert.equal((await day('2026-10-31')).motivo, 'DIA_NO_LABORABLE', 'el sábado ya no es laborable');
    assert.equal((await ctx.book({ fecha: '2026-10-31' })).status, 422);
    assert.equal((await ctx.book({ fecha: '2026-11-01' })).status, 201, 'el domingo sigue abierto: no se asume que sea festivo');
  });

  test('un festivo cierra un día normalmente abierto; una apertura excepcional abre uno cerrado', async () => {
    assert.equal((await day('2026-11-04')).reservable, true); // miércoles
    assert.equal((await A('PUT', '/admin/calendario/excepciones', { fecha: '2026-11-04', tipo: 'festivo', motivo: 'Festivo de prueba' })).status, 200);
    assert.equal((await day('2026-11-04')).motivo, 'DIA_NO_LABORABLE');
    assert.equal((await ctx.book({ fecha: '2026-11-04' })).status, 422);

    assert.equal((await day('2026-11-03')).reservable, false); // martes cerrado
    await A('PUT', '/admin/calendario/excepciones', { fecha: '2026-11-03', tipo: 'abierto', motivo: 'Apertura extraordinaria' });
    assert.equal((await ctx.book({ fecha: '2026-11-03' })).status, 201);

    // Quitar la excepción devuelve el comportamiento semanal
    assert.equal((await A('DELETE', '/admin/calendario/excepciones/2026-11-04')).status, 200);
    assert.equal((await day('2026-11-04')).reservable, true);
    const cal = (await A('GET', '/admin/calendario?desde=2026-11-01&hasta=2026-11-07')).body;
    assert.equal(cal.zona, 'America/Puerto_Rico');
    assert.equal(cal.dias.find((d) => d.fecha === '2026-11-03').origen, 'excepcion');
  });

  test('cerrar un día con citas no las cancela: avisa cuántas hay', async () => {
    await ctx.book({ fecha: '2026-11-05', hora: '10:00' });
    const r = await A('PUT', '/admin/calendario/excepciones', { fecha: '2026-11-05', tipo: 'cerrado' });
    assert.equal(r.body.reservasConfirmadas, 1);
    assert.equal(ctx.rows("SELECT estado FROM reservas")[0].estado, 'confirmada');
  });

  test('validación y autorización del calendario', async () => {
    for (const [m, p, b] of [['GET', '/admin/calendario'], ['PUT', '/admin/calendario/dias-operacion', { dias: [1] }], ['PUT', '/admin/calendario/excepciones', { fecha: '2026-11-04', tipo: 'festivo' }], ['DELETE', '/admin/calendario/excepciones/2026-11-04']]) {
      assert.equal((await ctx.api(m, p, b)).status, 401, `${m} ${p} sin credenciales`);
    }
    assert.equal((await A('PUT', '/admin/calendario/dias-operacion', { dias: [] })).status, 400);
    assert.equal((await A('PUT', '/admin/calendario/dias-operacion', { dias: [7] })).status, 400);
    assert.equal((await A('PUT', '/admin/calendario/dias-operacion', { dias: ['3'] })).status, 400);
    assert.equal((await A('PUT', '/admin/calendario/excepciones', { fecha: '2026-02-31', tipo: 'festivo' })).status, 400);
    assert.equal((await A('PUT', '/admin/calendario/excepciones', { fecha: '2026-11-04', tipo: 'otro' })).status, 400);
    assert.equal((await A('PUT', '/admin/calendario/excepciones', { fecha: '2026-11-04', tipo: 'festivo', extra: 1 })).status, 400, 'campos desconocidos rechazados');
    assert.equal((await A('DELETE', '/admin/calendario/excepciones/x')).status, 400);
  });

  test('las acciones del administrador quedan en el registro de auditoría', async () => {
    await A('PUT', '/admin/calendario/excepciones', { fecha: '2026-11-04', tipo: 'festivo' });
    const r = (await A('GET', '/admin/auditoria')).body.registros;
    assert.ok(r.some((x) => x.accion === 'calendario.excepcion'));
  });
});

describe('resumen diario al propietario: estado real de las reservas', () => {
  let ctx;
  before(async () => { ctx = await makeCtx({ env: { OWNER_EMAIL: '' } }); }); // vacío = correo por defecto del propietario
  after(async () => { await ctx.close(); });
  beforeEach(() => wipe(ctx));

  const A = (method, path, body) => ctx.api(method, path, body, adminHeaders());
  const clients = [
    { hora: '14:00', nombre: 'Carlos Rivera', telefono: '787-555-1400', correo: 'carlos@example.com' },
    { hora: '08:00', nombre: 'María Soto', telefono: '787-555-0800', correo: 'maria@example.com' },
    { hora: '11:00', nombre: 'José Lugo', telefono: '787-555-1100', correo: 'jose@example.com' },
  ];
  const seed = async () => { const out = []; for (const c of clients) out.push((await ctx.book({ servicioId: 1, fecha: '2026-10-31', ...c })).body.reserva); await ctx.flush(); ctx.sent.length = 0; return out; };
  const summaryMail = () => ctx.sent.find((m) => /RESERVAS PROGRAMADAS/.test(m.text ?? ''));

  test('va a oramasdetailing@gmail.com, con las reservas ordenadas por hora y sin canceladas', async () => {
    const [carlos] = await seed();
    assert.equal((await ctx.cancelFull({ codigo: carlos.codigo, telefono: '787-555-1400' })).status, 200); // se cancela (con confirmación por correo) ANTES del resumen
    ctx.setNow(NIGHT);
    const run = await ctx.c.tasks.dailySummary();
    assert.equal(run.ok, true); assert.equal(run.result.reservas, 2);
    ctx.sent.length = 0; await ctx.flush();
    const m = summaryMail();
    assert.equal(m.to.address ?? m.to, 'oramasdetailing@gmail.com');
    assert.ok(!m.text.includes('Carlos Rivera'), 'la cancelada no aparece');
    assert.ok(m.text.indexOf('María Soto') < m.text.indexOf('José Lugo'), 'orden cronológico');
    assert.match(m.text, /Estado al momento de generar: 2026-10-30 11:00 p\.m\./);
  });

  test('una reserva movida a otro día aparece con su nueva fecha y no en la anterior', async () => {
    const [carlos] = await seed();
    const mv = await ctx.rescheduleFull({ codigo: carlos.codigo, telefono: '787-555-1400', fecha: '2026-11-01', hora: '10:00' });
    assert.equal(mv.status, 200);
    ctx.setNow(NIGHT);
    await ctx.c.tasks.dailySummary(); ctx.sent.length = 0; await ctx.flush();
    assert.ok(!summaryMail().text.includes('Carlos Rivera'));
    // El resumen del día siguiente (domingo 1) sí la incluye, con el horario nuevo
    ctx.setNow(PR('2026-11-01T03:00:00Z'));
    await ctx.c.tasks.dailySummary(); ctx.sent.length = 0; await ctx.flush();
    const next = ctx.sent.filter((m) => /RESERVAS PROGRAMADAS/.test(m.text ?? '')).at(-1);
    assert.match(next.text, /Carlos Rivera[\s\S]*10:00 a\.m\. - 11:30 a\.m\./);
  });

  test('si una reserva se cancela después de encolar el resumen y antes de enviarlo, el correo sale actualizado', async () => {
    const [carlos] = await seed();
    ctx.setNow(NIGHT);
    ctx.fail.error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); // Gmail falla: el resumen queda en cola
    await ctx.c.tasks.dailySummary(); await ctx.flush();
    ctx.fail.error = null;
    await A('POST', '/admin/reservas/cancelar', { codigo: carlos.codigo }); // el dueño cancela por WhatsApp
    ctx.advance(10 * 60e3); ctx.sent.length = 0;
    await ctx.flush();
    const m = summaryMail();
    assert.ok(m, 'el resumen salió');
    assert.ok(!m.text.includes('Carlos Rivera'), 'no se envía información desactualizada');
    assert.match(m.text, /Total: 2 reservas/);
  });

  test('día siguiente no laborable (festivo / día cerrado): no se envía resumen y se registra', async () => {
    await seed();
    await A('PUT', '/admin/calendario/excepciones', { fecha: '2026-10-31', tipo: 'festivo', motivo: 'Prueba' });
    ctx.setNow(NIGHT);
    const run = await ctx.c.tasks.dailySummary();
    assert.equal(run.result.omitido, 'dia_no_laborable');
    assert.equal(ctx.rows("SELECT * FROM outbox_correos WHERE tipo = 'resumen_dueno'").length, 0);
    assert.equal(ctx.rows("SELECT estado FROM job_runs WHERE job = 'resumen_diario'")[0].estado, 'ok');
  });

  test('día laborable sin reservas: se envía un resumen que lo dice; y nunca se duplica', async () => {
    ctx.setNow(NIGHT);
    await ctx.c.tasks.dailySummary(); await ctx.c.tasks.dailySummary();
    await ctx.flush();
    const all = ctx.sent.filter((m) => /RESERVAS PROGRAMADAS/.test(m.text ?? ''));
    assert.equal(all.length, 1);
    assert.match(all[0].text, /No hay reservas confirmadas/);
  });
});

describe('administración: limpieza, tareas, servicios, métricas y disparador externo', () => {
  let ctx;
  before(async () => { ctx = await makeCtx({ env: { JOBS_TRIGGER_SECRET: JOBS_SECRET } }); });
  after(async () => { await ctx.close(); });
  beforeEach(() => wipe(ctx));
  const A = (method, path, body) => ctx.api(method, path, body, adminHeaders());

  test('panel de limpieza: estado, checkbox, simulación y ejecución con confirmación', async () => {
    const st = (await A('GET', '/admin/limpieza')).body;
    assert.equal(st.habilitada, true); assert.equal(st.ultima, null); assert.equal(st.politica.corte, '2026-10-26');
    const off = await A('PUT', '/admin/limpieza/habilitada', { habilitada: false });
    assert.equal(off.body.habilitada, false);
    assert.equal((await A('PUT', '/admin/limpieza/habilitada', { habilitada: 'no' })).status, 400);
    await A('PUT', '/admin/limpieza/habilitada', { habilitada: true });

    // Una reserva vieja (semana anterior) para borrar
    await ctx.book({ fecha: '2026-10-31', hora: '08:00' });
    ctx.db.exec("UPDATE reservas SET fecha = '2026-10-10', estado = 'completada'");
    const sim = await A('POST', '/admin/limpieza/simulacion');
    assert.equal(sim.status, 200); assert.equal(sim.body.total, 1); assert.equal(sim.body.corte, '2026-10-26');
    assert.ok(!JSON.stringify(sim.body).includes('ana@'), 'la simulación no revela datos personales');
    assert.equal(ctx.rows('SELECT * FROM reservas').length, 1, 'simular no borra');

    assert.equal((await A('POST', '/admin/limpieza/ejecutar', {})).status, 400, 'sin código de confirmación');
    assert.equal((await A('POST', '/admin/limpieza/ejecutar', { confirmToken: '0'.repeat(24) })).status, 409, 'código que no corresponde');
    const run = await A('POST', '/admin/limpieza/ejecutar', { confirmToken: sim.body.token });
    assert.equal(run.status, 200); assert.equal(run.body.borradas, 1);
    const after = (await A('GET', '/admin/limpieza')).body;
    assert.equal(after.ultima.estado, 'ok'); assert.equal(after.ultima.modo, 'manual');
    assert.ok(after.historial.length >= 2);
    for (const [m, p] of [['GET', '/admin/limpieza'], ['POST', '/admin/limpieza/simulacion'], ['POST', '/admin/limpieza/ejecutar']]) assert.equal((await ctx.api(m, p, m === 'GET' ? undefined : {})).status, 401);
  });

  test('historial de notificaciones, servicios, métricas y estado (solo administrador)', async () => {
    await ctx.book({ fecha: '2026-10-31' }); await ctx.flush();
    const mails = (await A('GET', '/admin/correos')).body;
    assert.ok(mails.recientes.length >= 1);
    assert.ok(!JSON.stringify(mails).includes('ana@example.com'));
    const svc = (await A('GET', '/admin/servicios')).body;
    assert.equal(svc.servicios.length, 2); assert.equal(svc.servicios[0].precios.auto, 'desde $25'); assert.equal(svc.horario.zona, 'America/Puerto_Rico');
    const met = (await A('GET', '/admin/metricas')).body;
    assert.ok(met.http.total > 0); assert.equal(met.baseDeDatos.conexiones, 1);
    for (const p of ['/admin/correos', '/admin/servicios', '/admin/metricas', '/admin/estado', '/admin/auditoria']) assert.equal((await ctx.api('GET', p)).status, 401);
  });

  test('disparador externo de tareas: exige JOBS_TRIGGER_SECRET, es idempotente y no revela datos', async () => {
    const H = { authorization: `Bearer ${JOBS_SECRET}` };
    assert.equal((await ctx.api('POST', '/internal/tareas/correos')).status, 401);
    assert.equal((await ctx.api('POST', '/internal/tareas/correos', undefined, { authorization: `Bearer ${JOBS_SECRET}x` })).status, 401);
    assert.equal((await ctx.api('POST', '/internal/tareas/correos', undefined, adminHeaders())).status, 401, 'el secreto del administrador no sirve aquí');
    assert.equal((await ctx.api('POST', '/internal/tareas/borrar-todo', undefined, H)).status, 400);
    assert.equal((await ctx.api('POST', '/internal/tareas/correos', undefined, H)).status, 200);
    ctx.setNow(NIGHT);
    const a = await ctx.api('POST', '/internal/tareas/resumen', undefined, H);
    const b = await ctx.api('POST', '/internal/tareas/resumen', undefined, H);
    assert.equal(a.status, 200); assert.equal(a.body.omitida, false);
    assert.equal(b.body.omitida, true, 'la segunda llamada no repite el trabajo');
    assert.equal(ctx.rows("SELECT * FROM outbox_correos WHERE tipo = 'resumen_dueno'").length, 1);
    const none = await makeCtx();
    try { assert.equal((await none.api('POST', '/internal/tareas/correos', undefined, H)).status, 404, 'sin secreto configurado la ruta no existe'); } finally { await none.close(); }
  });

  test('servicios: el administrador puede desactivar uno; no admite nuevas reservas, sobrevive al reinicio y las existentes no se tocan', async () => {
    const existing = await ctx.book({ servicioId: 2, hora: '08:00' });
    assert.equal(existing.status, 201);
    const svc = (await A('GET', '/admin/servicios')).body.servicios;
    assert.deepEqual(svc.map((s) => s.activo), [true, true]);
    assert.equal((await A('PUT', '/admin/servicios/2/activo', { activo: false })).body.activo, false);
    assert.equal((await ctx.api('GET', '/disponibilidad?servicio=2&fecha=2026-11-01')).body.motivo, 'SERVICIO_INACTIVO');
    assert.equal((await ctx.api('GET', '/disponibilidad/mes?servicio=2&mes=2026-11')).body.dias['2026-11-01'].estado, 'cerrado');
    const blocked = await ctx.book({ servicioId: 2, hora: '10:00', fecha: '2026-11-01', telefono: '787-555-0303', correo: 'otro@example.com' });
    assert.equal(blocked.status, 422); assert.equal(blocked.body.error.code, 'SERVICIO_INACTIVO');
    assert.equal((await ctx.book({ servicioId: 1, hora: '14:00', fecha: '2026-11-01', telefono: '787-555-0303', correo: 'otro@example.com' })).status, 201, 'el otro servicio sigue');
    assert.equal(ctx.rows("SELECT estado FROM reservas WHERE codigo = ?", existing.body.reserva.codigo)[0].estado, 'confirmada');
    // Un reinicio (volver a sincronizar el catálogo) no reactiva lo que el administrador desactivó
    const { syncCatalog } = await import('../server/db/connection.js'); syncCatalog(ctx.db);
    assert.equal((await A('GET', '/admin/servicios')).body.servicios[1].activo, false);
    assert.equal((await A('PUT', '/admin/servicios/2/activo', { activo: true })).body.activo, true);
    assert.equal((await A('PUT', '/admin/servicios/9/activo', { activo: true })).status, 400);
    assert.equal((await A('PUT', '/admin/servicios/1/activo', { activo: 'no' })).status, 400);
    assert.equal((await ctx.api('PUT', '/admin/servicios/1/activo', { activo: false })).status, 401);
  });

  test('rotación del secreto de administrador: el anterior sigue valiendo mientras está configurado', async () => {
    const NEW = 'Pw9xT3vK7mN2bR6yH1dF5gJ8sA4uE0iO-tL_zC2qV9nB3xM7rW4kY1hD6pG5jS8';
    const rot = await makeCtx({ env: { ADMIN_TOKEN_SECRET: NEW, ADMIN_TOKEN_SECRET_PREVIOUS: adminHeaders().authorization.slice(7) } });
    try {
      assert.equal((await rot.api('GET', '/admin/estado', undefined, { authorization: `Bearer ${NEW}` })).status, 200);
      assert.equal((await rot.api('GET', '/admin/estado', undefined, adminHeaders())).status, 200);
      assert.equal((await rot.api('GET', '/admin/estado', undefined, { authorization: 'Bearer ' + 'z'.repeat(60) })).status, 401);
    } finally { await rot.close(); }
  });
});
