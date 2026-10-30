import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PR, makeCtx } from './helpers.js';

/**
 * Política definitiva de limpieza: semanas de lunes a domingo (hora de Puerto Rico).
 * "Hoy" en estas pruebas es el viernes 2026-10-30, 12:00 p.m.; la semana en curso va del lunes 26/oct al domingo 1/nov.
 */
const FRIDAY = PR('2026-10-30T16:00:00Z');
const SUNDAY_2359 = PR('2026-11-02T03:59:00Z'); // domingo 1/nov, 23:59 en Puerto Rico (UTC-4)
const SUNDAY_NOON = PR('2026-11-01T16:00:00Z'); // domingo 1/nov, 12:00 p.m.: la jornada aún no cerró

const wipe = (ctx) => {
  ctx.db.exec('DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM clientes; DELETE FROM outbox_correos; DELETE FROM job_runs; DELETE FROM limpieza_ejecuciones;');
  ctx.db.exec("UPDATE configuracion SET valor = 'true' WHERE clave = 'limpieza_habilitada'");
  ctx.sent.length = 0; ctx.fail.error = null; ctx.setNow(FRIDAY);
};

function makeSeeder(ctx) {
  let n = 0;
  const fc = ctx.c.fc;
  return function seed({ fecha, estado, slots = false, name, cliente }) {
    const ts = new Date(ctx.state.now).toISOString();
    const phone = cliente ?? `787-555-${String(1000 + ++n)}`;
    const cid = ctx.db.prepare(`INSERT INTO clientes (telefono_mac, nombre_enc, telefono_enc, correo_enc, correo_mac, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (telefono_mac) DO UPDATE SET actualizado_en = excluded.actualizado_en RETURNING id`)
      .get(fc.phoneMac(phone), fc.encrypt('Cliente Viejo'), fc.encrypt(phone), fc.encrypt('v@example.com'), fc.emailMac('v@example.com'), ts, ts).id;
    const cancelada = estado === 'cancelada';
    const codigo = `OR-${name}`;
    const info = ctx.db.prepare(`
      INSERT INTO reservas (codigo, cliente_id, servicio_id, vehiculo, fecha, inicio_min, fin_min, bloque_fin_min, estado, correo_enc, correo_mac, lugar_enc,
        precio_monto, precio_desde, token_hash, creada_en, actualizada_en, cancelada_en, cancelada_por)
      VALUES (?, ?, 1, 'auto', ?, 480, 570, 600, ?, ?, ?, ?, 25, 1, 'h', ?, ?, ?, ?)`)
      .run(codigo, cid, fecha, estado, fc.encrypt('v@example.com'), fc.emailMac('v@example.com'), fc.encrypt('Aguada'), ts, ts, cancelada ? ts : null, cancelada ? 'cliente' : null);
    if (slots) for (let s = 16; s < 20; s++) ctx.db.prepare('INSERT INTO reserva_slots (fecha, slot, reserva_id) VALUES (?, ?, ?)').run(fecha, s, Number(info.lastInsertRowid));
    return codigo;
  };
}

describe('limpieza semanal: política de semanas de lunes a domingo', () => {
  let ctx, seed;
  before(async () => { ctx = await makeCtx(); seed = makeSeeder(ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(() => wipe(ctx));

  const codes = () => new Set(ctx.rows('SELECT codigo FROM reservas').map((r) => r.codigo));
  function seedAll() {
    return {
      A_domAnterior: seed({ name: 'AAAAAA', fecha: '2026-10-25', estado: 'completada' }),   // domingo de la semana pasada
      B_lunesActual: seed({ name: 'BBBBBB', fecha: '2026-10-26', estado: 'completada' }),   // lunes de ESTA semana
      C_noLlego: seed({ name: 'CCCCCC', fecha: '2026-10-18', estado: 'no_llego' }),
      D_cancelAnterior: seed({ name: 'DDDDDD', fecha: '2026-10-20', estado: 'cancelada' }),
      E_cancelActual: seed({ name: 'EEEEEE', fecha: '2026-10-28', estado: 'cancelada' }),
      F_cancelFutura: seed({ name: 'FFFFFF', fecha: '2026-11-10', estado: 'cancelada' }),
      G_futura: seed({ name: 'GGGGGG', fecha: '2026-11-05', estado: 'confirmada', slots: true }),
      H_hoy: seed({ name: 'HHHHHH', fecha: '2026-10-30', estado: 'confirmada', slots: true }),
      J_pasadaSinMarcar: seed({ name: 'JJJJJJ', fecha: '2026-10-22', estado: 'confirmada' }),
      K_muyVieja: seed({ name: 'KKKKKK', fecha: '2026-09-01', estado: 'confirmada' }),
    };
  }

  test('una reserva de noviembre creada en octubre NO se borra el domingo; solo cuando su semana termina', async () => {
    const s = seedAll();
    // Domingo 1/nov 23:59: se borra la semana 26/oct–1/nov y las anteriores; la reserva del 5 de noviembre sigue
    ctx.setNow(SUNDAY_2359);
    const r = ctx.c.cleanup.run({ modo: 'automatica' });
    assert.equal(r.estado, 'ok');
    assert.ok(codes().has(s.G_futura), 'la reserva futura se conserva');
    assert.ok(codes().has(s.F_cancelFutura), 'una cancelada de semana futura tampoco se borra todavía');
    for (const k of ['A_domAnterior', 'B_lunesActual', 'C_noLlego', 'D_cancelAnterior', 'E_cancelActual', 'H_hoy', 'J_pasadaSinMarcar', 'K_muyVieja']) assert.ok(!codes().has(s[k]), `${k} debe borrarse`);
    // Una semana después, ya terminó la semana del 2 al 8 de noviembre: ahora sí se borra la reserva del 5
    ctx.setNow(PR('2026-11-09T03:59:00Z'));
    ctx.c.cleanup.run({ modo: 'automatica' });
    assert.ok(!codes().has(s.G_futura));
    assert.ok(codes().has(s.F_cancelFutura));
  });

  test('un día de semana (o el domingo antes de cerrar) solo se borran las semanas anteriores a la actual', () => {
    const s = seedAll();
    for (const now of [FRIDAY, SUNDAY_NOON]) {
      ctx.setNow(now);
      const plan = ctx.c.cleanup.plan();
      assert.equal(plan.corte, '2026-10-26', 'el corte es el lunes de la semana en curso');
      assert.equal(plan.total, 5); // A, C, D, J (marcada como realizada) y K
    }
    ctx.c.cleanup.run({ modo: 'automatica' });
    const left = codes();
    for (const k of ['B_lunesActual', 'E_cancelActual', 'F_cancelFutura', 'G_futura', 'H_hoy']) assert.ok(left.has(s[k]), `${k} se conserva`);
    for (const k of ['A_domAnterior', 'C_noLlego', 'D_cancelAnterior', 'J_pasadaSinMarcar', 'K_muyVieja']) assert.ok(!left.has(s[k]), `${k} se borra`);
  });

  test('el domingo después de cerrar la jornada, la semana en curso ya terminó (corte = lunes siguiente)', () => {
    ctx.setNow(PR('2026-11-01T21:00:00Z')); // 5:00 p.m. exactos
    assert.equal(ctx.c.cleanup.policy(ctx.state.now).corte, '2026-11-02');
    ctx.setNow(PR('2026-11-01T20:59:00Z')); // 4:59 p.m.
    assert.equal(ctx.c.cleanup.policy(ctx.state.now).corte, '2026-10-26');
  });

  test('las reservas confirmadas de hoy o futuras jamás se borran, ni siquiera con un reloj adelantado años', () => {
    const futura = seed({ name: 'LLLLLL', fecha: '2027-03-01', estado: 'confirmada', slots: true });
    const hoy = seed({ name: 'MMMMMM', fecha: '2026-10-30', estado: 'confirmada', slots: true });
    ctx.setNow(PR('2026-12-07T03:59:00Z')); // domingo 6/dic 23:59
    assert.equal(ctx.c.cleanup.plan().corte, '2026-12-07');
    ctx.c.cleanup.run({ modo: 'manual', confirmToken: ctx.c.cleanup.plan().token, actor: 'prueba' });
    assert.ok(codes().has(futura), 'la de marzo de 2027 sigue');
    assert.ok(!codes().has(hoy), 'la del 30/oct ya es de una semana terminada');
    assert.equal(ctx.rows('SELECT * FROM reserva_slots WHERE fecha >= ?', '2027-03-01').length, 4);
  });

  test('propiedad: con fechas y estados aleatorios, nunca se pierde una reserva de la semana en curso o futura', () => {
    let seedN = 12345;
    const rnd = () => (seedN = (seedN * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const estados = ['confirmada', 'completada', 'cancelada', 'no_llego'];
    for (let round = 0; round < 25; round++) {
      wipe(ctx);
      const nowMs = FRIDAY + Math.floor(rnd() * 20) * 86400e3 + Math.floor(rnd() * 24) * 3600e3;
      ctx.setNow(nowMs);
      const created = [];
      for (let i = 0; i < 40; i++) {
        const day = new Date(Date.UTC(2026, 8, 1) + Math.floor(rnd() * 120) * 86400e3).toISOString().slice(0, 10);
        const estado = estados[Math.floor(rnd() * 4)];
        created.push({ fecha: day, estado, codigo: seed({ name: `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (round % 26))}${String(i).padStart(4, 'X')}`.slice(0, 6), fecha: day, estado, slots: false }) });
      }
      const corte = ctx.c.cleanup.policy(nowMs).corte;
      const hoy = ctx.c.cleanup.policy(nowMs).hoy;
      ctx.c.cleanup.run({ modo: 'automatica' });
      const left = codes();
      for (const r of created) {
        if (r.fecha >= corte) assert.ok(left.has(r.codigo), `ronda ${round}: ${r.fecha} (${r.estado}) es de la semana en curso o futura y no debe borrarse (corte ${corte}, hoy ${hoy})`);
        else assert.ok(!left.has(r.codigo), `ronda ${round}: ${r.fecha} es de una semana terminada y debe borrarse`);
      }
      assert.equal(ctx.c.cleanup.integrityReport().casillerosHuerfanos, 0);
    }
  });

  test('la simulación no borra nada, informa lo que se eliminaría y queda en el historial', () => {
    seedAll();
    const before = codes().size;
    const sim = ctx.c.cleanup.simulate({ actor: 'prueba' });
    assert.equal(sim.total, 5);
    assert.deepEqual(sim.porEstado, { completada: 1, no_llego: 1, cancelada: 1, confirmada_vencida: 2 });
    assert.equal(sim.rango.desde, '2026-09-01');
    assert.ok(sim.muestra.length === 5 && !('ids' in sim));
    assert.match(sim.token, /^[0-9a-f]{24}$/);
    assert.equal(codes().size, before);
    const h = ctx.c.config.cleanupRecent(5);
    assert.equal(h[0].modo, 'simulacion'); assert.equal(h[0].estado, 'ok');
  });

  test('la ejecución manual exige el código de la simulación; si los datos cambian, hay que simular de nuevo', () => {
    seedAll();
    assert.throws(() => ctx.c.cleanup.run({ modo: 'manual' }), /confirmación/);
    const sim = ctx.c.cleanup.simulate();
    seed({ name: 'NNNNNN', fecha: '2026-10-10', estado: 'completada' }); // aparece algo nuevo después de simular
    assert.throws(() => ctx.c.cleanup.run({ modo: 'manual', confirmToken: sim.token }), /cambiaron/);
    assert.equal(codes().size, 11, 'no se borró nada');
    const sim2 = ctx.c.cleanup.simulate();
    const out = ctx.c.cleanup.run({ modo: 'manual', confirmToken: sim2.token, actor: 'admin' });
    assert.equal(out.estado, 'ok'); assert.equal(out.borradas, 6);
    const last = ctx.c.config.cleanupLast();
    assert.equal(last.modo, 'manual'); assert.equal(last.estado, 'ok'); assert.equal(last.actor, 'admin');
  });

  test('es idempotente: ejecutarla dos veces no daña nada; la segunda no encuentra qué borrar', () => {
    const s = seedAll();
    ctx.c.cleanup.run({ modo: 'automatica' });
    const first = [...codes()].sort();
    const again = ctx.c.cleanup.run({ modo: 'automatica' });
    assert.equal(again.borradas, 0);
    assert.deepEqual([...codes()].sort(), first);
    assert.ok(codes().has(s.G_futura));
  });

  test('por el programador: una sola ejecución por semana (misma fecha de corte), aunque se dispare varias veces', async () => {
    seedAll();
    const a = await ctx.c.tasks.weeklyCleanup({ origen: 'cron' });
    assert.equal(a.ok, true);
    const b = await ctx.c.tasks.weeklyCleanup({ origen: 'repaso' });
    assert.equal(b.skipped, true);
    assert.equal(ctx.rows("SELECT * FROM job_runs WHERE job = 'limpieza_semanal'").length, 1);
  });

  test('NO toca clientes, configuración, calendario, servicios ni precios', async () => {
    seedAll();
    ctx.c.calendar.setException({ fecha: '2026-12-25', tipo: 'festivo', motivo: 'Navidad' }, new Date(ctx.state.now).toISOString());
    const snap = () => ({
      clientes: ctx.rows('SELECT * FROM clientes').length, config: ctx.rows('SELECT * FROM configuracion').length, cal: ctx.rows('SELECT * FROM calendario_dias').length,
      servicios: ctx.rows('SELECT * FROM servicios').length, precios: ctx.rows('SELECT * FROM precios').length,
    });
    const before = snap();
    ctx.setNow(SUNDAY_2359);
    ctx.c.cleanup.run({ modo: 'automatica' });
    assert.deepEqual(snap(), before);
  });

  test('el checkbox: con la limpieza automática desactivada no se borra nada (la manual sigue disponible)', async () => {
    seedAll();
    ctx.c.cleanup.setEnabled(false);
    const r = await ctx.c.tasks.weeklyCleanup({ origen: 'cron' });
    assert.equal(r.skipped, true);
    assert.equal(codes().size, 10);
    assert.equal(ctx.c.config.cleanupRecent(1)[0].estado, 'omitida');
    const sim = ctx.c.cleanup.simulate();
    assert.equal(ctx.c.cleanup.run({ modo: 'manual', confirmToken: sim.token }).estado, 'ok');
    ctx.c.cleanup.setEnabled(true);
    assert.equal(ctx.c.cleanup.enabled(), true);
  });

  test('guarda de seguridad: la limpieza automática se aborta si propone borrar más del tope', async () => {
    const small = await makeCtx({ env: { CLEANUP_MAX_DELETE: '2' } });
    try {
      small.setNow(FRIDAY);
      const sd = makeSeeder(small);
      for (let i = 0; i < 5; i++) sd({ name: `ZZZZ${String(i).padStart(2, '0')}`, fecha: '2026-10-05', estado: 'completada' });
      const r = small.c.cleanup.run({ modo: 'automatica' });
      assert.equal(r.estado, 'abortada'); assert.equal(r.motivo, 'tope_de_borrado');
      assert.equal(small.rows('SELECT * FROM reservas').length, 5, 'no se borró nada');
      const sim = small.c.cleanup.simulate();
      assert.equal(small.c.cleanup.run({ modo: 'manual', confirmToken: sim.token }).borradas, 5, 'la manual, ya revisada por el administrador, sí puede');
    } finally { await small.close(); }
  });

  test('guarda de seguridad: un reloj sospechoso (muchos días sin actividad) aborta la automática', () => {
    seedAll();
    ctx.db.prepare("INSERT INTO job_runs (job, run_key, estado, iniciado) VALUES ('x', 'ultimo', 'ok', ?)").run(new Date(FRIDAY - 40 * 86400e3).toISOString());
    ctx.db.exec("UPDATE reservas SET creada_en = '2019-12-31T23:00:00.000Z'");
    const r = ctx.c.cleanup.run({ modo: 'automatica' });
    assert.equal(r.estado, 'abortada'); assert.equal(r.motivo, 'reloj_sospechoso');
    assert.equal(codes().size, 10);
  });

  test('un error a mitad de la limpieza revierte todo (nada queda a medias) y se registra', () => {
    seedAll();
    ctx.db.exec("CREATE TRIGGER boom BEFORE DELETE ON reservas WHEN OLD.codigo = 'OR-KKKKKK' BEGIN SELECT RAISE(ABORT, 'falla simulada'); END;");
    try {
      assert.throws(() => ctx.c.cleanup.run({ modo: 'automatica' }), /falla simulada/);
      assert.equal(codes().size, 10, 'todo se revirtió');
      assert.equal(ctx.rows("SELECT estado FROM reservas WHERE codigo = 'OR-JJJJJJ'")[0].estado, 'confirmada', 'ni siquiera quedó marcada como realizada');
      assert.equal(ctx.c.config.cleanupLast().estado, 'error');
    } finally { ctx.db.exec('DROP TRIGGER boom'); }
  });

  test('al borrar una reserva se conservan el cliente y los correos pendientes (sin apuntar a la reserva borrada)', () => {
    const code = seed({ name: 'PPPPPP', fecha: '2026-10-10', estado: 'completada', cliente: '787-555-7777' });
    const id = ctx.rows('SELECT id FROM reservas WHERE codigo = ?', code)[0].id;
    const ins = ctx.db.prepare("INSERT INTO outbox_correos (tipo, dedupe_key, reserva_id, destinatario_enc, payload_enc, estado, proximo_intento, creado_en) VALUES ('confirmacion', ?, ?, 'dest', 'carga', ?, ?, ?)");
    const t = new Date().toISOString();
    ins.run('x-A', id, 'fallido', t, t); ins.run('x-B', id, 'pendiente', t, t);
    ctx.c.cleanup.run({ modo: 'automatica' });
    assert.equal(ctx.rows('SELECT * FROM reservas WHERE id = ?', id).length, 0);
    assert.equal(ctx.rows("SELECT * FROM outbox_correos WHERE dedupe_key = 'x-A'").length, 0);
    assert.equal(ctx.rows("SELECT reserva_id FROM outbox_correos WHERE dedupe_key = 'x-B'")[0].reserva_id, null);
    assert.equal(ctx.rows('SELECT * FROM clientes').length, 1, 'el cliente general se conserva');
  });
});
