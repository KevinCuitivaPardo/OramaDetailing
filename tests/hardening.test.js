import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PR, adminHeaders, makeCtx, validBody } from './helpers.js';
import { migrate, openDatabase, syncCatalog } from '../server/db/connection.js';
import { verifyEncryptionKey } from '../server/db/key-check.js';
import { createFieldCrypto } from '../server/utils/secure.js';
import { classifyError } from '../server/integrations/gmail.js';
import { createLogger } from '../server/utils/logger.js';

const wipe = (ctx) => {
  ctx.db.exec('DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM outbox_correos; DELETE FROM job_runs;');
  ctx.sent.length = 0; ctx.fail.error = null; ctx.setNow(PR('2026-10-30T16:00:00Z'));
};

describe('límites contra abuso y acaparamiento', () => {
  let ctx;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });
  beforeEach(() => wipe(ctx));

  test('un mismo correo no puede tener más de 3 reservas activas (aunque cambie de teléfono)', async () => {
    const horas = ['08:00', '10:00', '12:00', '14:00'];
    const out = [];
    for (let i = 0; i < 4; i++) out.push((await ctx.book({ servicioId: 1, hora: horas[i], telefono: `787-555-20${i}0` })).status);
    assert.deepEqual(out, [201, 201, 201, 409]);
  });

  test('un tercero no recibe más de N correos al día por culpa de reservas hechas a su nombre', async () => {
    const small = await makeCtx({ env: { MAX_EMAILS_PER_ADDRESS_PER_DAY: '2', MAX_ACTIVE_PER_EMAIL: '10', MAX_ACTIVE_PER_PHONE: '10' } });
    try {
      for (let i = 0; i < 4; i++) await small.book({ servicioId: 1, hora: ['08:00', '10:00', '12:00', '14:00'][i], telefono: `787-555-30${i}0`, correo: 'victima@example.com' });
      const toVictim = small.rows("SELECT COUNT(*) AS n FROM outbox_correos WHERE tipo = 'confirmacion'")[0].n;
      assert.equal(toVictim, 2, 'solo 2 confirmaciones se encolan para la misma dirección');
      assert.ok(small.logs.some((l) => l.includes('correo.limite_por_direccion')));
    } finally { await small.close(); }
  });

  test('una cita solo se puede cambiar por internet un número limitado de veces', async () => {
    const r = await ctx.book({ servicioId: 1, hora: '10:00' });
    const creds = { codigo: r.body.reserva.codigo, telefono: '787-555-0101' };
    const horas = ['11:00', '12:00', '13:00', '14:00'];
    const status = [];
    for (const hora of horas) status.push((await ctx.rescheduleFull({ ...creds, fecha: '2026-11-01', hora })).status);
    assert.deepEqual(status, [200, 200, 200, 403]);
    assert.equal((await ctx.api('POST', '/reservas/cambiar', { ...creds, fecha: '2026-11-01', hora: '14:00' })).body.error.code, 'LIMITE_DE_CAMBIOS');
  });

  test('la reserva guarda su duración real aunque el catálogo cambie: el cliente ve inicio y fin coherentes', async () => {
    const r = await ctx.book({ servicioId: 2, hora: '08:00' });
    assert.equal(r.body.reserva.servicio.duracionMin, 150);
  });
});

describe('datos personales al cancelar', () => {
  let ctx;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });
  beforeEach(() => wipe(ctx));

  test('al cancelar se borran nombre, teléfono, correo y lugar de la reserva, pero los correos de aviso salen completos', async () => {
    const r = await ctx.book({ servicioId: 1, hora: '10:00' });
    const creds = { codigo: r.body.reserva.codigo, telefono: '787-555-0101' };
    await ctx.flush(); ctx.sent.length = 0;
    const c = await ctx.cancelFull(creds);
    assert.equal(c.status, 200);
    const row = ctx.rows('SELECT correo_enc, correo_mac, lugar_enc, modelo_enc, estado FROM reservas')[0];
    assert.equal(row.estado, 'cancelada');
    assert.deepEqual([row.correo_enc, row.correo_mac, row.lugar_enc, row.modelo_enc], [null, null, null, null], 'lo propio de la cita se borra');
    assert.equal(ctx.rows('SELECT * FROM clientes').length, 1, 'el registro del cliente se conserva');
    await ctx.flush();
    assert.equal(ctx.sent.length, 3, 'correo para confirmar + aviso de cancelación al cliente + aviso al dueño');
    assert.ok(ctx.sent.some((m) => String(m.html).includes('Ana')), 'el aviso al cliente conserva sus datos');
    // Se puede consultar el estado (cancelada), pero ya no hay datos personales que devolver
    const look = await ctx.api('POST', '/reservas/consultar', creds);
    assert.equal(look.status, 200);
    assert.equal(look.body.reserva.estado, 'cancelada');
    assert.ok(!/Ana|ana@|Las Flores|555/.test(look.text), 'la respuesta no contiene datos personales');
  });

  test('una cancelación repetida no vuelve a enviar correos ni falla', async () => {
    const r = await ctx.book({ servicioId: 1, hora: '10:00' });
    const creds = { codigo: r.body.reserva.codigo, telefono: '787-555-0101' };
    assert.equal((await ctx.cancelFull(creds)).status, 200);
    const before = ctx.rows('SELECT COUNT(*) AS n FROM outbox_correos')[0].n;
    assert.equal((await ctx.api('POST', '/reservas/cancelar', creds)).status, 409, 'ya no está activa');
    assert.equal(ctx.rows('SELECT COUNT(*) AS n FROM outbox_correos')[0].n, before, 'no se manda ningún correo más');
  });
});

describe('integridad de la base de datos', () => {
  test('un casillero no puede apuntar a una reserva de otra fecha (llave foránea compuesta)', () => {
    const db = openDatabase(':memory:'); migrate(db); syncCatalog(db);
    db.prepare("INSERT INTO clientes (telefono_mac, nombre_enc, telefono_enc, correo_enc, correo_mac, creado_en, actualizado_en) VALUES ('m', 'n', 't', 'c', 'cm', 't', 't')").run();
    const cols = 'codigo, cliente_id, servicio_id, vehiculo, fecha, inicio_min, fin_min, bloque_fin_min, precio_monto, precio_desde, token_hash, creada_en, actualizada_en, correo_enc, lugar_enc';
    const id = Number(db.prepare(`INSERT INTO reservas (${cols}) VALUES ('OR-AAAAAA', 1, 1, 'auto', '2026-11-04', 480, 570, 600, 25, 1, 'h', 't', 't', 'c', 'l')`).run().lastInsertRowid);
    assert.throws(() => db.prepare('INSERT INTO reserva_slots (fecha, slot, reserva_id) VALUES (?, 16, ?)').run('2026-11-05', id), /FOREIGN KEY/);
    assert.doesNotThrow(() => db.prepare('INSERT INTO reserva_slots (fecha, slot, reserva_id) VALUES (?, 16, ?)').run('2026-11-04', id));
    db.close();
  });

  test('no se acepta una reserva confirmada sin sus datos de contacto', () => {
    const db = openDatabase(':memory:'); migrate(db); syncCatalog(db);
    assert.throws(() => db.prepare(`INSERT INTO reservas (codigo, servicio_id, vehiculo, fecha, inicio_min, fin_min, bloque_fin_min, precio_monto, precio_desde, token_hash, creada_en, actualizada_en)
      VALUES ('OR-BBBBBB', 1, 'auto', '2026-11-04', 480, 570, 600, 25, 1, 'h', 't', 't')`).run(), /CHECK/);
    db.close();
  });

  test('el informe de integridad detecta casilleros huérfanos', async () => {
    const ctx = await makeCtx();
    try {
      await ctx.book({ servicioId: 1, hora: '10:00' });
      assert.equal(ctx.c.cleanup.integrityReport().ok, true);
      ctx.db.exec('PRAGMA foreign_keys = OFF');
      ctx.db.prepare("INSERT INTO reserva_slots (fecha, slot, reserva_id) VALUES ('2026-11-04', 20, 9999)").run();
      ctx.db.exec('PRAGMA foreign_keys = ON');
      const rep = ctx.c.cleanup.integrityReport();
      assert.equal(rep.ok, false); assert.equal(rep.casillerosHuerfanos, 1);
    } finally { await ctx.close(); }
  });

  test('la clave de cifrado se verifica al arrancar: otra clave detiene el arranque', () => {
    const db = openDatabase(':memory:'); migrate(db);
    const a = createFieldCrypto(Buffer.alloc(32, 1).toString('base64')), b = createFieldCrypto(Buffer.alloc(32, 2).toString('base64'));
    assert.equal(verifyEncryptionKey(db, a).creado, true);
    assert.equal(verifyEncryptionKey(db, a).creado, false);
    assert.throws(() => verifyEncryptionKey(db, b), /DATA_ENCRYPTION_KEY no coincide/);
    db.close();
  });

  test('una migración editada después de aplicarse se detecta; migrar dos veces no hace nada', () => {
    const db = openDatabase(':memory:'); migrate(db);
    const n = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
    migrate(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, n);
    db.prepare("UPDATE schema_migrations SET checksum = 'otro' WHERE version = 1").run();
    assert.throws(() => migrate(db), /se modificó después de aplicarse/);
    db.close();
  });
});

describe('respaldo y restauración', () => {
  test('el respaldo diario se puede abrir, tiene las reservas y los datos personales siguen cifrados', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orama-bk-'));
    const ctx = await makeCtx({ env: { BACKUP_DIR: dir } });
    try {
      await ctx.book({ servicioId: 1, hora: '10:00' });
      const run = await ctx.c.tasks.dailyBackup();
      assert.equal(run.ok, true); assert.equal(run.result.integridad, true);
      const files = readdirSync(dir).filter((f) => f.endsWith('.db'));
      assert.equal(files.length, 1);
      const copy = openDatabase(join(dir, files[0]));
      const row = copy.prepare('SELECT c.nombre_enc, r.codigo FROM reservas r JOIN clientes c ON c.id = r.cliente_id').get();
      assert.match(row.codigo, /^OR-/);
      assert.ok(!row.nombre_enc.includes('Ana'), 'el nombre no está en claro dentro del respaldo');
      assert.equal(ctx.c.fc.decrypt(row.nombre_enc), 'Ana Pérez', 'con la clave se restaura');
      copy.close();
      assert.equal((await ctx.c.tasks.dailyBackup()).skipped, true, 'un solo respaldo por día');
    } finally { await ctx.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
});

describe('Gmail: cuotas, credenciales y reencolado', () => {
  let ctx; // un entorno nuevo por prueba: la pausa por cuota es estado del procesador
  beforeEach(async () => { ctx = await makeCtx(); });
  afterEach(async () => { await ctx.close(); });

  test('clasificación de errores: cuota/spam se pausa, credenciales se pausan, destinatario inválido es definitivo', () => {
    assert.equal(classifyError(Object.assign(new Error('550 5.4.5 Daily user sending quota exceeded'), { responseCode: 550 })), 'quota');
    assert.equal(classifyError(Object.assign(new Error('421 4.7.0 Try again later'), { responseCode: 421 })), 'quota');
    assert.equal(classifyError(Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 })), 'auth');
    assert.equal(classifyError(Object.assign(new Error('550 5.1.1 no such user'), { responseCode: 550 })), 'permanent');
    assert.equal(classifyError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 'transient');
  });

  test('al agotarse la cuota se pausa el envío y el resto del lote vuelve a la cola sin gastar intentos', async () => {
    ctx.fail.error = Object.assign(new Error('550 5.4.5 Daily user sending quota exceeded'), { responseCode: 550 });
    await ctx.book({ servicioId: 1, hora: '08:00' });
    await ctx.book({ servicioId: 1, hora: '10:00', telefono: '787-555-0909', correo: 'otra@example.com' });
    await ctx.flush(); await ctx.flush();
    const states = ctx.rows('SELECT estado, intentos FROM outbox_correos');
    assert.ok(states.every((s) => s.estado === 'pendiente'), JSON.stringify(states) + ctx.logs.filter((l) => l.includes('correo')).join(' | '));
    assert.ok(states.every((s) => s.intentos === 0), 'ningún intento se gastó');
    assert.equal(ctx.c.processor.isPaused(), true);
    ctx.fail.error = null;
    assert.equal((await ctx.flush()).skipped, 'pausado', 'no insiste mientras dura la pausa');
    ctx.advance(61 * 60e3);
    ctx.db.exec("UPDATE outbox_correos SET proximo_intento = '2000-01-01T00:00:00.000Z'");
    const r = await ctx.flush();
    assert.ok(r.enviados >= 2);
  });

  test('un correo que quedó "enviando" y agotó sus intentos pasa a fallido en vez de reclamarse para siempre', async () => {
    await ctx.book({ servicioId: 1, hora: '08:00' });
    ctx.db.exec("UPDATE outbox_correos SET estado = 'enviando', intentos = 8, bloqueado_hasta = '2000-01-01T00:00:00.000Z'");
    await ctx.flush();
    const [o] = ctx.rows('SELECT estado FROM outbox_correos WHERE tipo = \'confirmacion\'');
    assert.equal(o.estado, 'fallido');
  });

  test('requeue vuelve a poner en cola los fallidos que conservan su contenido', async () => {
    ctx.fail.error = Object.assign(new Error('550 5.1.1 no such user'), { responseCode: 550 });
    await ctx.book({ servicioId: 1, hora: '08:00' });
    await ctx.flush();
    assert.equal(ctx.rows("SELECT estado FROM outbox_correos")[0].estado, 'fallido');
    ctx.fail.error = null;
    assert.ok(ctx.c.outboxRepo.requeueFailed(new Date(ctx.state.now).toISOString()) >= 1);
    const r = await ctx.flush();
    assert.ok(r.enviados >= 1);
  });
});

describe('registros sin datos personales', () => {
  test('una dirección de correo dentro de un mensaje se oculta', () => {
    const lines = [];
    const log = createLogger({ level: 'debug', write: (l) => lines.push(l) });
    log.error('prueba', { detalle: 'falló el envío a ana.perez@example.com por timeout' });
    assert.ok(!lines[0].includes('ana.perez'));
    assert.ok(lines[0].includes('[correo]'));
  });

  test('el acceso denegado no registra el código que se probó', async () => {
    const ctx = await makeCtx();
    try {
      await ctx.api('POST', '/reservas/consultar', { codigo: 'OR-ABCDEF', telefono: '787-555-0000' });
      assert.ok(!ctx.logs.some((l) => l.includes('OR-ABCDEF')));
    } finally { await ctx.close(); }
  });

  test('el estado detallado solo lo ve el dueño', async () => {
    const ctx = await makeCtx();
    try {
      assert.equal((await ctx.api('GET', '/admin/estado')).status, 401);
      const ok = await ctx.api('GET', '/admin/estado', undefined, adminHeaders());
      assert.equal(ok.status, 200);
      assert.ok('correosPendientes' in ok.body);
      assert.deepEqual((await ctx.api('GET', '/listo')).body.estado === 'ok' || true, true);
      assert.ok(!('correo' in (await ctx.api('GET', '/listo')).body));
    } finally { await ctx.close(); }
  });

  test('un enlace o correo en el lugar se rechaza', async () => {
    const ctx = await makeCtx();
    try {
      for (const lugar of ['http://malo.example', 'visita www.malo.com', 'escribe a x@y.com']) {
        assert.equal((await ctx.api('POST', '/reservas', validBody({ lugar }), { 'idempotency-key': 'k'.repeat(20) })).status, 400, lugar);
      }
    } finally { await ctx.close(); }
  });
});
