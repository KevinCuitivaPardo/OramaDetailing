import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFieldCrypto, maskEmail, maskPhone, normalizeCode, newReservationCode } from '../server/utils/secure.js';
import { createLogger } from '../server/utils/logger.js';
import { ADMIN_SECRET, TEST_KEY, adminHeaders, makeCtx, validBody, idem } from './helpers.js';

const ADMIN = adminHeaders();

describe('endpoints protegidos (escenario 15)', () => {
  let ctx;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });

  test('el panel del dueño rechaza solicitudes sin token, con token falso o con formato raro', async () => {
    for (const headers of [{}, { authorization: 'Bearer ' + 'b'.repeat(40) }, { authorization: 'Basic ' + 'a'.repeat(40) }, { authorization: 'Bearer' }, { authorization: 'a'.repeat(40) }]) {
      for (const [method, path, body] of [['GET', '/admin/agenda?fecha=2026-10-31'], ['POST', '/admin/reservas/cancelar', { codigo: 'OR-AAAAAA' }], ['GET', '/admin/correos']]) {
        const r = await ctx.api(method, path, body, headers);
        assert.equal(r.status, 401, `${method} ${path} con ${JSON.stringify(headers)}`);
        assert.equal(r.body.error.code, 'NO_AUTORIZADO');
      }
    }
  });

  test('con el token correcto, el dueño ve la agenda del día completa y ordenada, y puede cancelar', async () => {
    ctx.db.exec('DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM outbox_correos;');
    await ctx.book({ hora: '14:00', servicioId: 1, nombre: 'Luis Tarde', telefono: '787-555-1414' });
    const b = await ctx.book({ hora: '08:00', servicioId: 1, nombre: 'Rosa Mañana', telefono: '787-555-0808', correo: 'rosa@example.com' });
    const agenda = await ctx.api('GET', '/admin/agenda?fecha=2026-10-31', undefined, ADMIN);
    assert.equal(agenda.status, 200);
    assert.deepEqual(agenda.body.reservas.map((r) => r.nombre), ['Rosa Mañana', 'Luis Tarde']);
    assert.equal(agenda.body.reservas[0].telefono, '787-555-0808');

    ctx.sent.length = 0;
    const cancel = await ctx.api('POST', '/admin/reservas/cancelar', { codigo: b.body.reserva.codigo }, ADMIN);
    assert.equal(cancel.status, 200);
    assert.equal(ctx.rows('SELECT estado, cancelada_por FROM reservas WHERE codigo = ?', b.body.reserva.codigo)[0].cancelada_por, 'dueno');
    await ctx.flush();
    assert.deepEqual(ctx.sent.map((m) => m.to), ['rosa@example.com'], 'avisa al cliente; el dueño ya lo sabe');
    assert.equal((await ctx.api('POST', '/admin/reservas/cancelar', { codigo: 'OR-AAAAAA' }, ADMIN)).status, 404);
  });

  test('sin ADMIN_TOKEN_SECRET configurado el panel "no existe" (404), nunca queda abierto', async () => {
    const open = await makeCtx({ env: { ADMIN_TOKEN_SECRET: '' } });
    try {
      for (const headers of [{}, ADMIN]) assert.equal((await open.api('GET', '/admin/agenda?fecha=2026-10-31', undefined, headers)).status, 404);
    } finally { await open.close(); }
  });

  test('un secreto de administrador corto o repetitivo no se acepta al arrancar', async () => {
    await assert.rejects(() => makeCtx({ env: { ADMIN_TOKEN_SECRET: 'corto' } }), /ADMIN_TOKEN_SECRET/);
    await assert.rejects(() => makeCtx({ env: { ADMIN_TOKEN_SECRET: 'a'.repeat(60) } }), /no parece aleatorio/);
  });

  test('el cliente no puede usar rutas del panel ni ver cosas internas', async () => {
    const r = await ctx.api('GET', '/admin/correos');
    assert.equal(r.status, 401);
    for (const path of ['/reservas', '/reservas/1', '/usuarios', '/.env', '/db', '/admin']) {
      const x = await ctx.api('GET', path);
      assert.ok([401, 404].includes(x.status), `${path} → ${x.status}`);
    }
  });
});

describe('protección de datos y entradas', () => {
  let ctx;
  before(async () => { ctx = await makeCtx(); });
  after(async () => { await ctx.close(); });
  beforeEach(() => { ctx.db.exec('DELETE FROM reserva_slots; DELETE FROM reservas; DELETE FROM outbox_correos;'); ctx.logs.length = 0; });

  test('las respuestas nunca traen teléfono ni correo completos', async () => {
    const r = await ctx.book({ telefono: '787-555-0101', correo: 'ana.secreta@example.com' });
    const txt = JSON.stringify(r.body);
    assert.ok(!txt.includes('787-555-0101') && !txt.includes('7875550101') && !txt.includes('ana.secreta@example.com'));
    const look = await ctx.api('POST', '/reservas/consultar', { codigo: r.body.reserva.codigo, telefono: '787-555-0101' });
    assert.ok(!JSON.stringify(look.body).includes('ana.secreta'));
    assert.equal(maskPhone('787-555-0101'), '***-***-0101');
    assert.equal(maskEmail('ana.secreta@example.com'), 'a**********@example.com');
  });

  test('en la base de datos los datos personales están cifrados (no se leen en claro)', async () => {
    await ctx.book({ nombre: 'Persona Privada', telefono: '787-555-9876', correo: 'privado@example.com', lugar: 'Calle Secreta 123', modelo: 'Toyota Corolla' });
    const raw = JSON.stringify(ctx.rows('SELECT * FROM reservas'));
    for (const dato of ['Persona Privada', '7875559876', '787-555-9876', 'privado@example.com', 'Calle Secreta', 'Corolla']) assert.ok(!raw.includes(dato), `no debe verse "${dato}" en la BD`);
    const outbox = JSON.stringify(ctx.rows('SELECT * FROM outbox_correos'));
    assert.ok(!outbox.includes('privado@example.com') && !outbox.includes('Calle Secreta'));
    // El token de gestión solo se guarda como hash
    assert.ok(!raw.includes((await ctx.book({ hora: '12:00', servicioId: 1, telefono: '787-555-0002', nombre: 'Otra Persona' })).body.tokenGestion));
  });

  test('los registros (logs) no contienen contraseñas, tokens ni datos personales', async () => {
    const r = await ctx.book({ nombre: 'Persona Privada', telefono: '787-555-9876', correo: 'privado@example.com', lugar: 'Calle Secreta 123' });
    await ctx.flush();
    await ctx.api('POST', '/reservas/consultar', { codigo: r.body.reserva.codigo, telefono: '787-555-0000' }); // fallo de acceso
    await ctx.book({ nombre: 'Persona Privada', telefono: '787-555-9876', correo: 'privado@example.com', lugar: 'Calle Secreta 123' }); // choque
    const all = ctx.logs.join('\n');
    assert.ok(all.length > 100, 'sí se registran eventos');
    for (const dato of ['Persona Privada', '787-555-9876', '7875559876', 'privado@example.com', 'Calle Secreta', r.body.tokenGestion, ADMIN_SECRET]) assert.ok(!all.includes(dato), `el log no debe contener "${dato}"`);
    for (const ev of ['reserva.creada', 'reserva.confirmada', 'reserva.intento_duplicado', 'correo.encolado', 'correo.enviado', 'reserva.acceso_denegado']) assert.ok(all.includes(`"${ev}"`), `falta el evento ${ev}`);
  });

  test('el redactor del logger oculta campos sensibles aunque vengan anidados', () => {
    const out = [];
    const log = createLogger({ write: (l) => out.push(l) });
    log.info('x', { password: 'p', GMAIL_APP_PASSWORD: 'abc', token: 't', authorization: 'Bearer z', anidado: { correo: 'a@b.c', telefono: '1', ok: 'visible' }, codigo: 'OR-AAAAAA' });
    const line = out[0];
    for (const secreto of ['"p"', 'abc', 'Bearer z', 'a@b.c']) assert.ok(!line.includes(secreto));
    assert.ok(line.includes('visible') && line.includes('OR-AAAAAA'));
  });

  test('entradas hostiles: JSON roto, cuerpo enorme, tipos raros, campos extra, inyección SQL y XSS', async () => {
    assert.equal((await ctx.api('POST', '/reservas/consultar', '{"codigo": ')).status, 400);
    assert.equal((await ctx.api('POST', '/reservas/consultar', 'x'.repeat(20_000), { 'content-type': 'application/json' })).status, 413);
    assert.equal((await ctx.api('POST', '/reservas', { servicioId: [1], vehiculo: { $ne: 1 }, fecha: 1, hora: null, nombre: 5 }, { 'idempotency-key': idem() })).status, 400);
    assert.equal((await ctx.api('POST', '/reservas/consultar', { codigo: ['OR-AAAAAA'], telefono: '787-555-0101' })).status, 400);
    assert.equal((await ctx.api('POST', '/reservas/consultar', { codigo: "OR-AAAAAA' OR '1'='1", telefono: '787-555-0101' })).status, 400);
    assert.equal((await ctx.api('GET', "/disponibilidad?servicio=1&fecha=2026-10-31'; DROP TABLE reservas;--")).status, 400);
    assert.equal((await ctx.api('GET', '/disponibilidad?servicio=1&fecha=2026-10-31&fecha=2026-11-01')).status, 400, 'parámetro repetido');
    assert.equal((await ctx.api('GET', '/disponibilidad?servicio=1&fecha=2026-10-31&extra=1')).status, 400, 'parámetro desconocido');
    // Un texto con comillas y SQL es solo texto: se guarda tal cual y no rompe nada
    const text = "Robert'); DROP TABLE reservas;--";
    const r = await ctx.book({ lugar: text });
    assert.equal(r.status, 201);
    assert.equal(ctx.rows('SELECT COUNT(*) AS n FROM reservas')[0].n, 1);
    assert.equal((await ctx.book({ nombre: text, telefono: '787-555-0202', hora: '12:00' })).status, 400, 'el nombre solo admite letras, números y puntuación simple');
    assert.equal((await ctx.book({ lugar: 'Visita https://malo.example/pago', telefono: '787-555-0203', hora: '12:00' })).status, 400, 'sin enlaces en textos libres');
    // Saltos de línea / caracteres de control en campos (inyección de cabeceras de correo)
    assert.equal((await ctx.book({ nombre: 'Ana\r\nBcc: x@y.com Pérez', hora: '12:00', servicioId: 1 })).status, 400);
    assert.equal((await ctx.book({ correo: 'a@b.com\r\nBcc: x@y.com', hora: '12:00', servicioId: 1 })).status, 400);
  });

  test('cabeceras de seguridad, sin huella del framework y respuestas de la API sin caché', async () => {
    const r = await ctx.api('GET', '/config');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(r.headers.get('content-security-policy'), /connect-src 'self' blob:/, 'el modelo 3D necesita leer sus texturas desde blob:');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(r.headers.get('x-request-id'));
    // Los errores no revelan detalles internos
    const nf = await ctx.api('GET', '/no-existe');
    assert.equal(nf.status, 404);
    assert.ok(!/at |node_modules|sqlite|\.js/i.test(nf.text));
  });

  test('CORS: solo los orígenes autorizados (por defecto ninguno) y nunca en el panel', async () => {
    const r = await ctx.api('GET', '/config', undefined, { origin: 'https://malo.example' });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const ok = await makeCtx({ env: { CORS_ORIGINS: 'https://orama.example' } });
    try {
      const good = await ok.api('GET', '/config', undefined, { origin: 'https://orama.example' });
      assert.equal(good.headers.get('access-control-allow-origin'), 'https://orama.example');
      const adm = await ok.api('GET', '/admin/correos', undefined, { origin: 'https://orama.example', ...ADMIN });
      assert.equal(adm.headers.get('access-control-allow-origin'), null);
    } finally { await ok.close(); }
  });

  test('el código de reserva y los campos cifrados: formato, normalización y manipulación', () => {
    assert.match(newReservationCode(), /^OR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    const set = new Set(Array.from({ length: 2000 }, newReservationCode)); assert.ok(set.size > 1990, 'códigos aleatorios');
    assert.equal(normalizeCode(' or-7k3p9x '), 'OR-7K3P9X');
    assert.equal(normalizeCode('OR7K3P9X'), 'OR-7K3P9X');
    for (const bad of ['OR-7K3P9', 'OR-7K3P9XX', 'OR-0O1I2L', "OR-'; --", '', null, 12, ['OR-7K3P9X']]) assert.equal(normalizeCode(bad), null, String(bad));

    const fc = createFieldCrypto(TEST_KEY);
    const blob = fc.encrypt('hola');
    assert.equal(fc.decrypt(blob), 'hola');
    assert.notEqual(fc.encrypt('hola'), blob, 'cada cifrado usa su propio IV');
    const i = blob.lastIndexOf('.') + 1; // primer carácter del texto cifrado: los últimos de cada parte pueden ser relleno base64 y no cambiar ningún byte
    const tampered = blob.slice(0, i) + (blob[i] === 'A' ? 'B' : 'A') + blob.slice(i + 1);
    assert.throws(() => fc.decrypt(tampered), 'un dato alterado no se descifra (AES-GCM autentica)');
    assert.throws(() => createFieldCrypto(Buffer.alloc(16).toString('base64')), /32 bytes/);
    assert.notEqual(fc.phoneMac('787-555-0101'), fc.phoneMac('787-555-0102'));
    assert.equal(fc.phoneMac('787-555-0101'), fc.phoneMac('(787) 555 0101'));
  });
});

describe('límite de solicitudes (rate limiting)', () => {
  test('frena la adivinación de códigos: tras varios intentos fallidos responde 429 aun con otra IP lógica', async () => {
    const ctx = await makeCtx({ rateLimits: true });
    try {
      const r = await ctx.book(); const code = r.body.reserva.codigo;
      let last;
      for (let i = 0; i < 12; i++) last = await ctx.api('POST', '/reservas/consultar', { codigo: code, telefono: `787-555-${String(1000 + i)}` });
      assert.equal(last.status, 429, 'más de 10 fallos con el mismo código se bloquean');
      assert.equal(last.body.error.code, 'DEMASIADAS_SOLICITUDES');
      assert.ok(last.headers.get('retry-after'));
      // Ni siquiera el teléfono correcto pasa mientras dura el bloqueo del código
      assert.equal((await ctx.api('POST', '/reservas/consultar', { codigo: code, telefono: '787-555-0101' })).status, 429);
    } finally { await ctx.close(); }
  });

  test('crear reservas tiene su propio tope por IP, y el panel frena los intentos fallidos', async () => {
    const ctx = await makeCtx({ rateLimits: true });
    try {
      const statuses = [];
      for (let i = 0; i < 12; i++) statuses.push((await ctx.api('POST', '/reservas', validBody({ hora: '08:00' }), { 'idempotency-key': idem() })).status);
      assert.ok(statuses.includes(429), 'después de 10 intentos por hora se bloquea');
      const adm = [];
      for (let i = 0; i < 7; i++) adm.push((await ctx.api('GET', '/admin/correos', undefined, { authorization: 'Bearer ' + 'x'.repeat(40) })).status);
      assert.deepEqual(adm.slice(0, 5), [401, 401, 401, 401, 401]);
      assert.equal(adm[6], 429);
      // Con el token correcto igual se frena mientras dure el bloqueo (la IP ya quedó marcada)
      assert.equal((await ctx.api('GET', '/admin/correos', undefined, ADMIN)).status, 429);
    } finally { await ctx.close(); }
  });
});
