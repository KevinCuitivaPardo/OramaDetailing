import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PR, makeCtx } from './helpers.js';

const HOY = PR('2026-10-30T16:00:00Z'); // viernes 12:00 p. m. en Puerto Rico
const PASS = 'mi contraseña larga 2026';

const wipe = (ctx) => {
  ctx.db.exec('DELETE FROM acciones_pendientes; DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM clientes; DELETE FROM outbox_correos; DELETE FROM calendario_dias; DELETE FROM bloqueos_horario; DELETE FROM auditoria_admin;');
  ctx.db.exec("DELETE FROM configuracion WHERE clave IN ('hora_apertura_min', 'hora_cierre_min'); UPDATE configuracion SET valor = '3,4,5,6,0' WHERE clave = 'dias_operacion'");
  ctx.sent.length = 0; ctx.setNow(HOY);
};

describe('inicio de sesión del propietario', () => {
  let ctx;
  before(async () => { ctx = await makeCtx({ env: { ADMIN_TOKEN_SECRET: '' } }); }); // sin secreto técnico: solo existe la contraseña
  after(async () => { await ctx.close(); });
  beforeEach(() => { ctx.db.exec('DELETE FROM admin_acceso'); wipe(ctx); });
  const login = (password) => ctx.api('POST', '/admin/login', { password });
  const asOwner = (token) => ({ authorization: `Bearer ${token}` });

  test('mientras no haya contraseña definida, el panel y el inicio de sesión "no existen" (404)', async () => {
    assert.equal((await login(PASS)).status, 404);
    assert.equal((await ctx.api('GET', '/admin/horario')).status, 404);
  });

  test('con contraseña: entra, la sesión sirve en las rutas del panel y los datos incorrectos no', async () => {
    await ctx.c.access.setPassword(PASS);
    assert.equal((await login('otra contraseña distinta')).status, 401);
    assert.equal((await login('')).status, 400);
    const ok = await login(PASS);
    assert.equal(ok.status, 200); assert.match(ok.body.token, /^s1\.\d+\.\d+\.[\w-]{43}$/);
    assert.equal((await ctx.api('GET', '/admin/horario', undefined, asOwner(ok.body.token))).status, 200);
    // Tokens alterados, vencidos o inventados
    const [s, exp, ver, mac] = ok.body.token.split('.');
    for (const bad of [`${s}.${exp}.${ver}.${'A'.repeat(43)}`, `${s}.${Number(exp) + 1}.${ver}.${mac}`, `${s}.${exp}.${Number(ver) + 1}.${mac}`, 's1.1.1.x', 'cualquier cosa']) {
      assert.equal((await ctx.api('GET', '/admin/horario', undefined, asOwner(bad))).status, 401, bad.slice(0, 20));
    }
    ctx.advance(8 * 3600e3 + 1000);
    assert.equal((await ctx.api('GET', '/admin/horario', undefined, asOwner(ok.body.token))).status, 401, 'la sesión vence a las 8 horas');
  });

  test('cambiar la contraseña cierra las demás sesiones, exige la actual y rechaza claves débiles', async () => {
    await ctx.c.access.setPassword(PASS);
    const s1 = (await login(PASS)).body.token;
    const weak = await ctx.api('POST', '/admin/password', { actual: PASS, nueva: 'corta' }, asOwner(s1));
    assert.equal(weak.status, 400);
    assert.equal((await ctx.api('POST', '/admin/password', { actual: 'no es', nueva: 'una contraseña nueva larga' }, asOwner(s1))).status, 401);
    const changed = await ctx.api('POST', '/admin/password', { actual: PASS, nueva: 'otra contraseña nueva larga' }, asOwner(s1));
    assert.equal(changed.status, 200);
    assert.equal((await ctx.api('GET', '/admin/horario', undefined, asOwner(s1))).status, 401, 'la sesión anterior se cerró');
    assert.equal((await ctx.api('GET', '/admin/horario', undefined, asOwner(changed.body.token))).status, 200, 'la que cambió la contraseña sigue abierta');
    assert.equal((await login(PASS)).status, 401);
    assert.equal((await login('otra contraseña nueva larga')).status, 200);
  });

  test('los intentos fallidos y los accesos quedan registrados (sin la contraseña) para que el propietario los vea', async () => {
    await ctx.c.access.setPassword(PASS);
    await login('intento con contraseña ajena'); await login(PASS);
    const t = (await login(PASS)).body.token;
    const rec = (await ctx.api('GET', '/admin/auditoria', undefined, asOwner(t))).body.registros;
    assert.ok(rec.some((x) => x.accion === 'admin.login_fallido') && rec.some((x) => x.accion === 'admin.login'));
    assert.ok(!JSON.stringify(rec).includes('contraseña ajena'));
  });

  test('la contraseña solo se guarda como hash y no aparece en respuestas ni en el registro', async () => {
    await ctx.c.access.setPassword(PASS);
    const row = ctx.rows('SELECT password_hash FROM admin_acceso')[0];
    assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$/);
    assert.ok(!row.password_hash.includes(PASS));
    const r = await login(PASS);
    assert.ok(!JSON.stringify(r.body).includes(PASS));
    await login('mala contraseña ajena');
    assert.ok(!ctx.logs.join('\n').includes('mala contraseña ajena') && !ctx.logs.join('\n').includes(PASS));
  });

  test('fuerza bruta: tras 5 intentos fallidos se bloquea (incluso con la contraseña correcta)', async () => {
    const limited = await makeCtx({ rateLimits: true, env: { ADMIN_TOKEN_SECRET: '' } });
    try {
      await limited.c.access.setPassword(PASS);
      const out = [];
      for (let i = 0; i < 6; i++) out.push((await limited.api('POST', '/admin/login', { password: `intento incorrecto ${i}` })).status);
      assert.deepEqual(out, [401, 401, 401, 401, 401, 429]);
      assert.equal((await limited.api('POST', '/admin/login', { password: PASS })).status, 429);
    } finally { await limited.close(); }
  });
});

describe('el propietario modifica horarios y fechas', () => {
  let ctx, H;
  before(async () => { ctx = await makeCtx(); await ctx.c.access.setPassword(PASS); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    wipe(ctx);
    const t = (await ctx.api('POST', '/admin/login', { password: PASS })).body.token;
    H = { authorization: `Bearer ${t}` };
  });
  const day = async (svc, fecha) => (await ctx.api('GET', `/disponibilidad?servicio=${svc}&fecha=${fecha}`)).body;
  const starts = (d) => d.horas.map((h) => h.valor);
  const A = (m, p, b) => ctx.api(m, p, b, H);

  test('"si necesito almorzar": un descanso diario quita las horas cuyo tiempo ocupado choca con el almuerzo', async () => {
    const base = starts(await day(1, '2026-11-04'));
    assert.ok(base.includes('11:00') && base.includes('12:00'));
    const r = await A('POST', '/admin/bloqueos', { alcance: 'diario', desde: '12:00', hasta: '13:00', motivo: 'Almuerzo' });
    assert.equal(r.status, 201);
    // Exterior bloquea 2 h: 10:00 (hasta 12:00) cabe; 10:30–12:30 ya choca
    const withLunch = starts(await day(1, '2026-11-04'));
    assert.ok(withLunch.includes('10:00') && withLunch.includes('13:00'));
    for (const h of ['10:30', '11:00', '11:30', '12:00', '12:30']) assert.ok(!withLunch.includes(h), `${h} no debe ofrecerse`);
    // El servidor también lo impide si alguien intenta reservar a mano
    const forced = await ctx.book({ servicioId: 1, hora: '11:00', fecha: '2026-11-04' });
    assert.equal(forced.status, 409); assert.equal(forced.body.error.code, 'HORARIO_NO_DISPONIBLE');
    assert.equal(ctx.rows('SELECT * FROM reservas').length, 0);
    assert.equal((await ctx.book({ servicioId: 1, hora: '10:00', fecha: '2026-11-04' })).status, 201);
    // Quitar el descanso devuelve las horas
    const id = (await A('GET', '/admin/horario')).body.bloqueos[0].id;
    assert.equal((await A('DELETE', `/admin/bloqueos/${id}`)).status, 200);
    assert.ok(starts(await day(1, '2026-11-05')).includes('11:00'));
  });

  test('bloquear horas de un solo día o de todos los miércoles; no afecta otros días', async () => {
    await A('POST', '/admin/bloqueos', { alcance: 'dia', fecha: '2026-11-05', desde: '14:00', hasta: '17:00', motivo: 'Cita personal' });
    assert.ok(!starts(await day(1, '2026-11-05')).includes('14:00'));
    assert.ok(starts(await day(1, '2026-11-06')).includes('14:00'));
    await A('POST', '/admin/bloqueos', { alcance: 'semana', diaSemana: 3, desde: '08:00', hasta: '10:00' }); // todos los miércoles
    assert.ok(!starts(await day(1, '2026-11-04')).includes('08:00'), 'miércoles 4/nov');
    assert.ok(!starts(await day(1, '2026-11-11')).includes('09:00'), 'miércoles 11/nov');
    assert.ok(starts(await day(1, '2026-11-06')).includes('08:00'), 'el viernes no se afecta');
    const mes = (await ctx.api('GET', '/disponibilidad/mes?servicio=1&mes=2026-11')).body.dias;
    assert.equal(mes['2026-11-06'].estado, 'disponible');
  });

  test('el mismo bloqueo dos veces no se duplica', async () => {
    const b = { alcance: 'diario', desde: '12:00', hasta: '13:00', motivo: 'Almuerzo' };
    const r1 = await A('POST', '/admin/bloqueos', b), r2 = await A('POST', '/admin/bloqueos', b);
    assert.equal(r1.body.id, r2.body.id);
    assert.equal(ctx.rows('SELECT * FROM bloqueos_horario').length, 1);
  });

  test('un bloqueo sobre citas ya hechas no las cancela y avisa cuántas hay', async () => {
    assert.equal((await ctx.book({ servicioId: 1, hora: '12:00', fecha: '2026-11-04' })).status, 201);
    const r = await A('POST', '/admin/bloqueos', { alcance: 'dia', fecha: '2026-11-04', desde: '12:00', hasta: '14:00' });
    assert.equal(r.body.reservasConfirmadas, 1);
    assert.equal(ctx.rows("SELECT estado FROM reservas")[0].estado, 'confirmada');
  });

  test('cambiar el horario de atención cambia las horas que se ofrecen y el servidor no acepta fuera de él', async () => {
    assert.equal((await A('PUT', '/admin/horario', { apertura: '09:00', cierre: '16:00' })).status, 200);
    const s = starts(await day(1, '2026-11-04'));
    assert.equal(s[0], '09:00'); assert.equal(s.at(-1), '14:30'); // Exterior dura 1 h 30: debe terminar a las 4:00 p. m.
    assert.equal((await ctx.book({ servicioId: 1, hora: '08:00', fecha: '2026-11-04' })).status, 400, 'antes de abrir');
    assert.equal((await ctx.book({ servicioId: 1, hora: '15:00', fecha: '2026-11-04' })).status, 400, 'terminaría después de cerrar');
    assert.equal((await ctx.book({ servicioId: 1, hora: '14:30', fecha: '2026-11-04' })).status, 201);
    assert.deepEqual((await ctx.api('GET', '/config')).body.horario, { aperturaMin: 540, cierreMin: 960 });
    const h = (await A('GET', '/admin/horario')).body;
    assert.deepEqual([h.apertura, h.cierre], ['09:00', '16:00']);
  });

  test('"si el miércoles no puedo trabajar": cerrar ese día desde la sesión del propietario', async () => {
    assert.equal((await day(1, '2026-11-04')).reservable, true);
    const r = await A('PUT', '/admin/calendario/excepciones', { fecha: '2026-11-04', tipo: 'cerrado', motivo: 'No puedo trabajar' });
    assert.equal(r.status, 200);
    const d = await day(1, '2026-11-04');
    assert.equal(d.reservable, false); assert.equal(d.motivo, 'DIA_NO_LABORABLE');
    assert.equal((await ctx.book({ servicioId: 1, hora: '10:00', fecha: '2026-11-04' })).status, 422);
    assert.equal((await ctx.api('GET', '/disponibilidad/mes?servicio=1&mes=2026-11')).body.dias['2026-11-04'].estado, 'cerrado');
    assert.equal((await A('DELETE', '/admin/calendario/excepciones/2026-11-04')).status, 200);
    assert.equal((await day(1, '2026-11-04')).reservable, true);
  });

  test('un cambio de cita no puede caer en un bloqueo: se rechaza al pedir y también al confirmar', async () => {
    const b = await ctx.book({ servicioId: 1, hora: '08:00', fecha: '2026-11-06' });
    const creds = { codigo: b.body.reserva.codigo, telefono: '787-555-0101' };
    await A('POST', '/admin/bloqueos', { alcance: 'dia', fecha: '2026-11-07', desde: '12:00', hasta: '14:00' });
    const direct = await ctx.api('POST', '/reservas/cambiar', { ...creds, fecha: '2026-11-07', hora: '12:00' });
    assert.equal(direct.status, 409);
    // Se pide un horario libre y, antes de confirmar, el propietario lo bloquea
    assert.equal((await ctx.api('POST', '/reservas/cambiar', { ...creds, fecha: '2026-11-07', hora: '15:00' })).status, 202);
    const link = await ctx.confirmLink();
    await A('POST', '/admin/bloqueos', { alcance: 'dia', fecha: '2026-11-07', desde: '15:00', hasta: '17:00' });
    const done = await ctx.api('POST', '/reservas/confirmar', { codigo: link.codigo, token: link.token });
    assert.equal(done.status, 409);
    assert.equal(ctx.rows('SELECT fecha FROM reservas')[0].fecha, '2026-11-06', 'la cita original queda intacta');
  });

  test('validación y autorización de horarios y bloqueos', async () => {
    for (const [m, p, b] of [['GET', '/admin/horario'], ['PUT', '/admin/horario', { apertura: '08:00', cierre: '17:00' }], ['POST', '/admin/bloqueos', { alcance: 'diario', desde: '12:00', hasta: '13:00' }], ['DELETE', '/admin/bloqueos/1'], ['POST', '/admin/password', { actual: 'x', nueva: 'y'.repeat(12) }]]) {
      assert.equal((await ctx.api(m, p, b)).status, 401, `${m} ${p} sin sesión`);
    }
    for (const body of [
      { alcance: 'diario', desde: '13:00', hasta: '12:00' }, { alcance: 'diario', desde: '12:10', hasta: '13:00' }, { alcance: 'dia', desde: '12:00', hasta: '13:00' },
      { alcance: 'semana', desde: '12:00', hasta: '13:00' }, { alcance: 'dia', fecha: '2026-02-31', desde: '12:00', hasta: '13:00' }, { alcance: 'diario', desde: '12:00', hasta: '13:00', extra: 1 },
      { alcance: 'todos', desde: '12:00', hasta: '13:00' }, { alcance: 'diario', desde: '12:00', hasta: '13:00', motivo: 'x'.repeat(200) },
    ]) assert.equal((await A('POST', '/admin/bloqueos', body)).status, 400, JSON.stringify(body));
    assert.equal((await A('PUT', '/admin/horario', { apertura: '17:00', cierre: '08:00' })).status, 400);
    assert.equal((await A('PUT', '/admin/horario', { apertura: '08:00', cierre: '17:30', extra: 1 })).status, 400);
    assert.equal((await A('DELETE', '/admin/bloqueos/999')).status, 400);
    assert.equal(ctx.rows('SELECT * FROM bloqueos_horario').length, 0);
    const audit = (await A('GET', '/admin/auditoria')).body.registros;
    assert.ok(audit.some((x) => x.accion === 'admin.login'));
  });
});
