// Prueba de punta a punta con correos REALES. Arranca el sistema completo (mismo código que producción) con una base de datos
// TEMPORAL y envía los correos de verdad por Gmail al correo de prueba (que también hace de "propietario" para ver sus avisos).
// Verifica: reservar, consultar, cambiar y cancelar con confirmación por correo, resumen del propietario, concurrencia,
// avisos en vivo (SSE) y que los cambios del propietario (cerrar un día, almuerzo, horario) se reflejan al instante.
//   node --env-file=.env scripts/e2e-real.mjs correo-del-cliente@gmail.com [correo-del-propietario@gmail.com]
// No toca la base de datos de producción.
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { buildApp, buildContainer } from '../server/app.js';
import { loadEnv } from '../server/config/env.js';
import { migrate, openDatabase, syncCatalog } from '../server/db/connection.js';
import { createLogger } from '../server/utils/logger.js';
import { isAgendaClosed } from '../server/utils/time.js';

const TO = process.argv[2]; // el cliente de la prueba
const OWNER = process.argv[3] ?? TO; // quien recibe el resumen y los avisos del propietario
if (!TO || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) { console.error('Uso: node --env-file=.env scripts/e2e-real.mjs correo@destino.com (requiere GMAIL_USER y GMAIL_APP_PASSWORD)'); process.exit(2); }
if (isAgendaClosed(Date.now())) { console.error('La agenda está cerrada ahora (11 p. m. – 6 a. m.): vuelve a ejecutar después de las 6:00 a. m.'); process.exit(2); }

const PORT = 3300, dir = mkdtempSync(join(tmpdir(), 'orama-e2e-'));
const PASSWORD = `e2e-${randomBytes(9).toString('base64url')}`;
const env = loadEnv({ ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(PORT), DATABASE_PATH: join(dir, 'e2e.db'), BACKUP_DIR: join(dir, 'b'), JOBS_ENABLED: 'false', OWNER_EMAIL: OWNER, PUBLIC_BASE_URL: `http://localhost:${PORT}`, RATE_LIMITS_ENABLED: 'false', MAX_BOOKINGS_PER_HOUR: '1000' });
const log = createLogger({ level: 'error' });
const db = openDatabase(env.DATABASE_PATH); migrate(db, log); syncCatalog(db);

// Transporte REAL de Gmail, con un "espejo" que guarda lo enviado para poder leer los enlaces de confirmación
// Se resuelve smtp.gmail.com con el resolvedor del sistema (el DNS interno de nodemailer falla en algunas redes) y se conecta por IP verificando el certificado de gmail
const { address: smtpIp } = await dns.promises.lookup('smtp.gmail.com', { family: 4 });
const real = nodemailer.createTransport({ host: smtpIp, port: 465, secure: true, tls: { servername: 'smtp.gmail.com' }, auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD } });
const sent = [];
const transport = { async sendMail(m) { const info = await real.sendMail(m); sent.push({ to: String(m.to), subject: m.subject, text: m.text, accepted: info.accepted, response: info.response }); return info; }, verify: () => real.verify() };
const c = buildContainer({ env, db, log, mailTransport: transport });
const server = await new Promise((r) => { const s = buildApp(c, { rateLimits: false }).listen(PORT, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${PORT}/api`;

/* ───────── utilidades ───────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* no es JSON */ }
  return { status: res.status, body: json };
}
async function settle() { for (let i = 0; i < 40; i++) { await c.processor.processBatch({ limit: 50 }); const n = db.prepare("SELECT COUNT(*) AS n FROM outbox_correos WHERE estado IN ('pendiente','enviando')").get().n; if (!n) return; await sleep(250); } }
const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`); }
const last = (re) => [...sent].reverse().find((m) => re.test(m.subject));
const link = (m) => { const x = /#confirmar\/(OR-[A-Z0-9]{6})\/([\w-]{20,64})/.exec(m?.text ?? ''); return x ? { codigo: x[1], token: x[2] } : null; };
const addDays = (s, n) => new Date(Date.parse(`${s}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

// SSE: guarda cada aviso con su hora de llegada
function openStream() {
  const events = [];
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/eventos', agent: false }, (res) => {
    res.setEncoding('utf8'); let buf = '';
    res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); if (/^event: cambio/m.test(b)) events.push(Date.now()); } });
  });
  req.on('error', () => {});
  return { events, close: () => req.destroy() };
}
async function expectEvent(stream, action, label) { const n = stream.events.length, t0 = Date.now(); await action(); for (let i = 0; i < 60 && stream.events.length === n; i++) await sleep(50); const ms = stream.events.at(-1) - t0; check(`Aviso en vivo: ${label}`, stream.events.length > n, stream.events.length > n ? `llegó en ${ms} ms` : 'no llegó'); }

/* ───────── escenario ───────── */
const w = c.reservations.bookingWindow();
const openDays = []; for (let d = w.desde; openDays.length < 3; d = addDays(d, 1)) if (c.calendar.isOpen(d)) openDays.push(d);
const [D1, D2, D3] = openDays;
const me = { nombre: 'Kevin Cuitiva', telefono: '6452207129', correo: TO, lugar: 'Aguada' };
const stream = openStream(); await sleep(300);
console.log(`\nPrueba de punta a punta · correos reales a ${TO}\nDías usados: ${D1}, ${D2}, ${D3}\n`);

console.log('1) Reservar');
const booked = await expectEventResult(() => api('POST', '/reservas', { servicioId: 1, vehiculo: 'auto', fecha: D1, hora: '08:00', ...me }, { 'idempotency-key': `e2e-${randomBytes(8).toString('hex')}-1` }), stream, 'nueva reserva');
async function expectEventResult(fn, st, label) { const n = st.events.length, t0 = Date.now(); const r = await fn(); for (let i = 0; i < 60 && st.events.length === n; i++) await sleep(50); check(`Aviso en vivo: ${label}`, st.events.length > n, st.events.length > n ? `llegó en ${st.events.at(-1) - t0} ms` : 'no llegó'); return r; }
check('La reserva se creó (201) con número', booked.status === 201 && /^OR-/.test(booked.body?.reserva?.codigo), booked.body?.reserva?.codigo);
const code = booked.body.reserva.codigo, creds = { codigo: code, telefono: me.telefono };
await settle();
const conf = last(/^Reserva confirmada/);
check('Correo de confirmación enviado por Gmail al cliente', conf && conf.to.includes(TO) && /250/.test(conf.response ?? ''), conf?.subject);
check('El correo trae número, día, hora de inicio y fin, lugar y enlace', conf && [code, 'Hora de inicio', 'Hora de finalización', 'Aguada', 'localhost'].every((t) => conf.text.includes(t)));
check('Consultar con código + celular', (await api('POST', '/reservas/consultar', creds)).body?.reserva?.estado === 'confirmada');

console.log('\n2) Cambiar la cita (con confirmación por correo)');
const chg = await api('POST', '/reservas/cambiar', { ...creds, fecha: D2, hora: '10:00' });
check('Pedir el cambio responde 202 y NO cambia la cita todavía', chg.status === 202 && c.db.prepare('SELECT fecha FROM reservas WHERE codigo = ?').get(code).fecha === D1);
await settle();
const chgMail = last(/^Confirma el cambio/); const chgLink = link(chgMail);
check('Llegó el correo "Confirma el cambio" con enlace', Boolean(chgLink), chgMail?.subject);
check('Abrir el enlace (vista previa) no ejecuta nada', (await api('POST', '/reservas/accion', chgLink)).status === 200 && c.db.prepare('SELECT fecha FROM reservas WHERE codigo = ?').get(code).fecha === D1);
const okChg = await expectEventResult(() => api('POST', '/reservas/confirmar', chgLink), stream, 'cambio confirmado');
check('Confirmar el enlace aplica el cambio', okChg.status === 200 && okChg.body.reserva.fecha === D2 && okChg.body.reserva.inicio === '10:00 a.m.', `${okChg.body?.reserva?.fecha} ${okChg.body?.reserva?.inicio}`);
await settle();
check('Correo "Cita cambiada" al cliente', Boolean(last(/^Cita cambiada/)));
check('Aviso del cambio al propietario', sent.some((m) => /un cliente cambió su cita/.test(m.text)));
check('El enlace no se puede usar dos veces', (await api('POST', '/reservas/confirmar', chgLink)).status === 409);

console.log('\n3) Cancelar (con confirmación por correo)');
const cnl = await api('POST', '/reservas/cancelar', { codigo: code, telefono: me.telefono });
check('Pedir la cancelación responde 202 y la cita sigue activa', cnl.status === 202 && c.db.prepare('SELECT estado FROM reservas WHERE codigo = ?').get(code).estado === 'confirmada');
await settle();
const cnlLink = link(last(/^Confirma la cancelación/));
check('Llegó el correo "Confirma la cancelación" con enlace', Boolean(cnlLink));
const okCnl = await expectEventResult(() => api('POST', '/reservas/confirmar', cnlLink), stream, 'cancelación confirmada');
check('Confirmar el enlace cancela la cita y libera el horario', okCnl.body?.reserva?.estado === 'cancelada' && c.db.prepare('SELECT COUNT(*) AS n FROM reserva_slots').get().n === 0);
await settle();
check('Correo "Cita cancelada" al cliente', Boolean(last(/^Cita cancelada/)));
check('Aviso de la cancelación al propietario', sent.some((m) => /un cliente canceló su cita/.test(m.text)));
const day2 = await api('GET', `/disponibilidad?servicio=1&fecha=${D2}`);
check('El horario cancelado vuelve a estar disponible', day2.body.horas.some((h) => h.valor === '10:00'));

console.log('\n4) Reservar de nuevo y concurrencia');
const again = await api('POST', '/reservas', { servicioId: 1, vehiculo: 'auto', fecha: D1, hora: '08:00', ...me }, { 'idempotency-key': `e2e-${randomBytes(8).toString('hex')}-2` });
check('Se puede volver a reservar el mismo horario', again.status === 201);
const racers = await Promise.all(Array.from({ length: 12 }, (_, i) => api('POST', '/reservas', { servicioId: 1, vehiculo: 'suv', fecha: D1, hora: '14:00', nombre: `Competidor Numero${i}`, telefono: `78755502${String(i).padStart(2, '0')}`, correo: TO, lugar: 'Aguada' }, { 'idempotency-key': `e2e-${randomBytes(8).toString('hex')}-r${i}` })));
const wins = racers.filter((r) => r.status === 201), losses = racers.filter((r) => r.status === 409);
check('12 personas piden el MISMO horario a la vez: solo 1 lo logra', wins.length === 1 && losses.length === 11, `${wins.length} ganó, ${losses.length} recibieron "horario no disponible"`);
check('En la base de datos hay exactamente 1 reserva para ese horario, sin duplicados', c.db.prepare("SELECT COUNT(*) AS n FROM reservas WHERE fecha = ? AND inicio_min = 840 AND estado = 'confirmada'").get(D1).n === 1);
const slotsOk = c.db.prepare("SELECT COUNT(*) AS n FROM reservas r WHERE estado='confirmada' AND (SELECT COUNT(*) FROM reserva_slots WHERE reserva_id = r.id) <> (bloque_fin_min - inicio_min)/30").get().n === 0;
check('Cada reserva ocupa exactamente los casilleros que le tocan', slotsOk);

console.log('\n5) Resumen del propietario');
await c.tasks.dailySummary({ fecha: D1 }); await settle();
const sum = last(/^Reservas programadas/);
check('Llegó el resumen del día con las reservas activas, ordenadas por hora', sum && sum.text.indexOf('8:00 a.m.') > 0 && sum.text.indexOf('8:00 a.m.') < sum.text.indexOf('2:00 p.m.') && /Total: 2 reservas/.test(sum.text), sum?.subject);
check('El resumen no incluye la reserva cancelada ni las perdedoras', !sum?.text.includes(code) || sum.text.split(code).length <= 2);

console.log('\n6) Lo que cambia el propietario se refleja al instante');
const adm = await (async () => { await c.access.setPassword(PASSWORD); const r = await api('POST', '/admin/login', { password: PASSWORD }); return { authorization: `Bearer ${r.body.token}` }; })();
await expectEvent(stream, () => api('PUT', '/admin/calendario/excepciones', { fecha: D3, tipo: 'cerrado', motivo: 'Prueba' }, adm), 'día cerrado');
const closed = await api('GET', `/disponibilidad?servicio=1&fecha=${D3}`);
check('El día cerrado ya no se puede reservar (disponibilidad y servidor)', closed.body.motivo === 'DIA_NO_LABORABLE' && (await api('POST', '/reservas', { servicioId: 1, vehiculo: 'auto', fecha: D3, hora: '10:00', ...me, telefono: '7875550999' }, { 'idempotency-key': `e2e-${randomBytes(8).toString('hex')}-c` })).status === 422);
await expectEvent(stream, () => api('DELETE', `/admin/calendario/excepciones/${D3}`, undefined, adm), 'día reabierto');
check('Reabrirlo lo vuelve a habilitar', (await api('GET', `/disponibilidad?servicio=1&fecha=${D3}`)).body.reservable === true);
await expectEvent(stream, () => api('POST', '/admin/bloqueos', { alcance: 'diario', desde: '12:00', hasta: '13:00', motivo: 'Almuerzo' }, adm), 'almuerzo bloqueado');
const lunchStarts = (await api('GET', `/disponibilidad?servicio=1&fecha=${D3}`)).body.horas.map((h) => h.valor);
check('Con almuerzo 12–1 no se ofrecen horas que lo toquen (10:30 a 12:30) y sí 10:00 y 1:00 p. m.', ['10:30', '11:00', '11:30', '12:00', '12:30'].every((h) => !lunchStarts.includes(h)) && lunchStarts.includes('10:00') && lunchStarts.includes('13:00'));
const blockId = c.db.prepare('SELECT id FROM bloqueos_horario').get().id;
await expectEvent(stream, () => api('DELETE', `/admin/bloqueos/${blockId}`, undefined, adm), 'almuerzo quitado');
await expectEvent(stream, () => api('PUT', '/admin/horario', { apertura: '09:00', cierre: '16:00' }, adm), 'horario cambiado');
const hrs = (await api('GET', `/disponibilidad?servicio=1&fecha=${D3}`)).body.horas.map((h) => h.valor);
check('Con horario 9:00–4:00 p. m. la primera hora es 9:00 y la última 2:30 p. m.', hrs[0] === '09:00' && hrs.at(-1) === '14:30', `${hrs[0]} … ${hrs.at(-1)}`);
check('El horario público (config) se actualiza', JSON.stringify((await api('GET', '/config')).body.horario) === JSON.stringify({ aperturaMin: 540, cierreMin: 960 }));
await api('PUT', '/admin/horario', { apertura: '08:00', cierre: '17:00' }, adm);
const racerCode = wins[0].body.reserva.codigo;
await expectEvent(stream, () => api('POST', '/admin/reservas/cancelar', { codigo: racerCode }, adm), 'cancelación del propietario');
await settle();
check('El propietario cancela una cita y el cliente recibe el correo', sent.filter((m) => /^Cita cancelada/.test(m.subject)).length >= 2);

console.log('\n7) Estado final de los correos');
const states = Object.fromEntries(db.prepare('SELECT estado, COUNT(*) AS n FROM outbox_correos GROUP BY estado').all().map((r) => [r.estado, r.n]));
check('Todos los correos se enviaron (ninguno pendiente ni fallido)', !states.pendiente && !states.fallido && !states.enviando, JSON.stringify(states));
const integrity = c.cleanup.integrityReport();
check('Integridad de la base de datos', integrity.ok, JSON.stringify(integrity));

stream.close(); c.hub.close(); server.close(); db.close();
try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* temporal */ }
console.log(`\nCorreos enviados por Gmail (${sent.length}) — deben estar en la bandeja de ${TO}:`);
sent.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}. ${m.subject}  [${(m.response ?? '').slice(0, 24)}]`));
const failed = results.filter((r) => !r.ok);
console.log(`\nResultado: ${results.length - failed.length}/${results.length} comprobaciones correctas${failed.length ? ` · FALLARON: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
