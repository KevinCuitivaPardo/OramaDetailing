// Uso:  node scripts/load/run.mjs <A|B|C|D|E|todo> [--dur=segundos] [--vus=N]
//   A  uso normal         · usuarios que entran, consultan servicios y disponibilidad, eligen fecha y reservan (con pausas humanas)
//   B  concurrencia       · muchas personas reservando horarios DISTINTOS a la vez (y una segunda oleada con horarios que se pisan)
//   C  conflicto          · muchas personas peleando por EXACTAMENTE el mismo horario (y por horarios que se solapan)
//   D  alta demanda       · escalones de usuarios virtuales hasta encontrar dónde sube la latencia, aparecen errores o se satura
//   E  resistencia        · carga moderada y sostenida (por defecto 10 min) para detectar fugas de memoria o degradación
// Resultados: docs/carga/resultados-<escenario>.json (datos reales medidos, tal cual salieron).
import { mkdirSync, writeFileSync } from 'node:fs';
import { avg, bookBody, checkConsistency, createRecorder, idemKey, machine, newClient, openDays, pct, pick, postJson, runVUs, sleep, startSampler, startServer, summarizeSamples } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(3).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const which = (process.argv[2] ?? 'todo').toUpperCase();
mkdirSync('docs/carga', { recursive: true });
const save = (name, data) => { writeFileSync(`docs/carga/resultados-${name}.json`, JSON.stringify({ escenario: name, fecha: new Date().toISOString(), maquina: machine(), ...data }, null, 2)); };
const think = (a, b) => sleep(a + Math.random() * (b - a));

let adminHeaders = {}; // se completa al arrancar cada servidor de prueba
async function bookingFlow(base, rec, days, { stage = 0, cancel = true, pickHour = true } = {}) {
  const servicio = pick([1, 2]);
  const fecha = pick(days);
  const day = await rec.timed('disponibilidad_dia', `${base}/disponibilidad?servicio=${servicio}&fecha=${fecha}`, undefined, stage);
  const horas = day.body?.horas ?? [];
  if (!horas.length) return { skipped: true };
  const c = newClient();
  const hora = pick(horas).valor;
  const r = await rec.timed('reservar', `${base}/reservas`, postJson(bookBody(c, { servicioId: servicio, fecha, hora }), { 'idempotency-key': idemKey() }), stage);
  if (r.status === 201 && cancel) {
    await rec.timed('consultar', `${base}/reservas/consultar`, postJson({ codigo: r.body.reserva.codigo, telefono: c.telefono }), stage);
    // Los clientes cancelan con confirmación por correo (no medible sin Gmail): para liberar el horario se usa la ruta del propietario
    await rec.timed('cancelar_admin', `${base}/admin/reservas/cancelar`, postJson({ codigo: r.body.reserva.codigo }, adminHeaders), stage);
  }
  return { status: r.status };
}

/* ───────── A · uso normal ───────── */
async function scenarioA() {
  const server = await startServer({ port: 3101 }); adminHeaders = server.adminHeaders; const rec = createRecorder(); const sampler = startSampler(server);
  const vus = Number(args.vus ?? 40), dur = Number(args.dur ?? 90) * 1000;
  const days = await openDays(server.base, 1, rec);
  let ok = 0, conflict = 0, otros = 0;
  await runVUs({ count: vus, durationMs: dur, rampMs: dur / 3, fn: async () => {
    await rec.timed('config', `${server.base}/config`); await think(300, 900);
    await rec.timed('mes', `${server.base}/disponibilidad/mes?servicio=${pick([1, 2])}&mes=${pick(days).slice(0, 7)}`); await think(500, 1500);
    const r = await bookingFlow(server.base, rec, days, { cancel: Math.random() < 0.7 });
    if (r.status === 201) ok++; else if (r.status === 409) conflict++; else if (!r.skipped) otros++;
    await think(800, 2500);
  } });
  sampler.stop(); const final = await server.metrics(); const cons = checkConsistency(server.dbPath);
  const out = { config: { vus, duracionS: dur / 1000, pausas: 'humanas 0.3–2.5 s entre pasos' }, global: rec.summary(), porSolicitud: rec.byLabel(), reservasCreadas: ok, conflictos409: conflict, otrosEstados: otros, servidor: summarizeSamples(sampler.samples), baseDeDatos: final.baseDeDatos, registros: server.logs, consistencia: cons };
  save('A-uso-normal', out); await server.stop(); return out;
}

/* ───────── B · concurrencia, horarios distintos ───────── */
async function scenarioB() {
  const server = await startServer({ port: 3102 }); adminHeaders = server.adminHeaders; const rec = createRecorder(); const sampler = startSampler(server);
  const days = await openDays(server.base, 1, rec);
  const slots = days.flatMap((d) => ['08:00', '10:00', '12:00', '14:00'].map((h) => [d, h])).sort(() => Math.random() - 0.5);
  const wave1 = slots.slice(0, Math.min(150, slots.length));
  // Oleada 1: 150 personas, cada una con un horario distinto que no choca con ningún otro → deben salir TODAS bien
  await Promise.all(wave1.map(([fecha, hora]) => { const c = newClient(); return rec.timed('reservar_distintos', `${server.base}/reservas`, postJson(bookBody(c, { servicioId: 1, fecha, hora }), { 'idempotency-key': idemKey() }), 1); }));
  const w1 = rec.summary((r) => r.stage === 1);
  const afterW1 = checkConsistency(server.dbPath);
  // Oleada 2: 300 personas eligen al azar entre los horarios que quedan (hay choques por solapamiento): solo caben los que no se pisan
  const free = slots.slice(wave1.length);
  const starts = ['08:00', '08:30', '09:00', '10:00', '10:30', '11:00', '12:00', '12:30', '13:00', '14:00'];
  await Promise.all(Array.from({ length: 300 }, () => { const c = newClient(); const fecha = pick(free.length ? free.map((s) => s[0]) : days); return rec.timed('reservar_solapados', `${server.base}/reservas`, postJson(bookBody(c, { servicioId: pick([1, 2]), fecha, hora: pick(starts) }), { 'idempotency-key': idemKey() }), 2); }));
  const w2 = rec.summary((r) => r.stage === 2);
  sampler.stop(); const final = await server.metrics(); const cons = checkConsistency(server.dbPath);
  const created = rec.rec.filter((r) => r.status === 201).length;
  const out = { oleada1_distintos: { intentos: wave1.length, resultado: w1, esperado: 'todas 201' }, oleada2_solapados: { intentos: 300, resultado: w2, esperado: '201 solo para las que caben sin pisarse; el resto 409' }, reservasCreadasSegunRespuestas: created, consistenciaTrasOleada1: afterW1, consistenciaFinal: cons, servidor: summarizeSamples(sampler.samples), baseDeDatos: final.baseDeDatos, registros: server.logs, coincideRespuestasConBD: created === cons.confirmadas };
  save('B-concurrencia', out); await server.stop(); return out;
}

/* ───────── C · conflicto por el mismo horario ───────── */
async function scenarioC() {
  const server = await startServer({ port: 3103 }); adminHeaders = server.adminHeaders; const rec = createRecorder(); const sampler = startSampler(server);
  const days = await openDays(server.base, 1, rec);
  const rounds = [];
  const N = Number(args.vus ?? 200);
  for (let i = 0; i < 20; i++) {
    const fecha = days[i]; const hora = ['08:00', '10:00', '12:00', '14:00'][i % 4];
    const results = await Promise.all(Array.from({ length: N }, () => { const c = newClient(); return rec.timed('mismo_horario', `${server.base}/reservas`, postJson(bookBody(c, { servicioId: 1, fecha, hora }), { 'idempotency-key': idemKey() }), i); }));
    const count = (s) => results.filter((r) => r.status === s).length;
    rounds.push({ ronda: i + 1, fecha, hora, solicitudes: N, creadas201: count(201), conflicto409: count(409), otros: N - count(201) - count(409) });
  }
  // Variante: horarios que se solapan (inicios distintos, servicios mezclados) el mismo día
  const dayX = days[25]; const starts = ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00'];
  const mixed = await Promise.all(Array.from({ length: N }, () => { const c = newClient(); return rec.timed('solapados_mismo_dia', `${server.base}/reservas`, postJson(bookBody(c, { servicioId: pick([1, 2]), fecha: dayX, hora: pick(starts) }), { 'idempotency-key': idemKey() }), 99); }));
  // Variante: el MISMO cliente con la MISMA clave de idempotencia (doble clic / reintento): una sola reserva
  const c1 = newClient(); const key = idemKey(); const dayY = days[26];
  const dupBody = bookBody(c1, { servicioId: 1, fecha: dayY, hora: '08:00' }); // el MISMO envío repetido (mismo cuerpo y misma clave)
  const dup = await Promise.all(Array.from({ length: 20 }, () => rec.timed('mismo_cliente_misma_clave', `${server.base}/reservas`, postJson(dupBody, { 'idempotency-key': key }), 98)));
  sampler.stop(); const final = await server.metrics(); const cons = checkConsistency(server.dbPath);
  const out = {
    solicitudesPorRonda: N, rondas: rounds,
    todasLasRondasExactamenteUnaReserva: rounds.every((r) => r.creadas201 === 1 && r.otros === 0),
    solapados: { solicitudes: N, creadas: mixed.filter((r) => r.status === 201).length, conflicto409: mixed.filter((r) => r.status === 409).length, otros: mixed.filter((r) => ![201, 409].includes(r.status)).length },
    dobleClic: { solicitudes: 20, respuestas201: dup.filter((r) => r.status === 201).length, reintentos200: dup.filter((r) => r.status === 200).length, otros: dup.filter((r) => ![200, 201].includes(r.status)).length },
    resumenHttp: rec.summary(), servidor: summarizeSamples(sampler.samples), baseDeDatos: final.baseDeDatos, registros: server.logs, consistencia: cons,
    reservasEsperadas: 20 + mixed.filter((r) => r.status === 201).length + 1, reservasEnBD: cons.reservas,
  };
  save('C-conflicto', out); await server.stop(); return out;
}

/* ───────── D · alta demanda, escalones ───────── */
async function scenarioD() {
  const server = await startServer({ port: 3104 }); adminHeaders = server.adminHeaders; const rec = createRecorder(); const sampler = startSampler(server);
  const days = await openDays(server.base, 1, rec);
  const steps = (args.steps ? String(args.steps).split(',').map(Number) : [10, 25, 50, 100, 200, 400, 800, 1000]); const per = Number(args.dur ?? 20) * 1000;
  const stages = [];
  for (let s = 0; s < steps.length; s++) {
    const from = Date.now();
    await runVUs({ count: steps[s], durationMs: per, rampMs: 2000, fn: async () => {
      const x = Math.random();
      if (x < 0.1) await rec.timed('config', `${server.base}/config`, undefined, s + 1);
      else if (x < 0.3) await rec.timed('mes', `${server.base}/disponibilidad/mes?servicio=${pick([1, 2])}&mes=${pick(days).slice(0, 7)}`, undefined, s + 1);
      else if (x < 0.85) await rec.timed('disponibilidad_dia', `${server.base}/disponibilidad?servicio=${pick([1, 2])}&fecha=${pick(days)}`, undefined, s + 1);
      else await bookingFlow(server.base, rec, days, { stage: s + 1, cancel: true });
    } });
    const sm = sampler.samples.filter((m) => m.t >= from);
    const sum = rec.summary((r) => r.stage === s + 1);
    stages.push({ usuariosVirtuales: steps[s], ...sum, servidor: summarizeSamples(sm), porSolicitud: rec.byLabel((r) => r.stage === s + 1) });
    const errRate = 1 - ((sum.estados['200'] ?? 0) + (sum.estados['201'] ?? 0) + (sum.estados['409'] ?? 0)) / Math.max(1, sum.solicitudes);
    console.log(`  ${steps[s]} VU → ${sum.rps} rps · p95 ${sum.p95Ms} ms · errores ${(errRate * 100).toFixed(1)} %`);
    if (errRate > 0.3 || (sum.p95Ms > 10000)) { console.log('  (se detiene: sistema saturado)'); break; }
    await sleep(2000);
  }
  sampler.stop(); const final = await server.metrics().catch(() => null); const cons = checkConsistency(server.dbPath);
  const out = { config: { modelo: 'cerrado (cada usuario espera su respuesta y repite sin pausa)', mezcla: '85 % lecturas, 15 % flujo reservar→consultar→cancelar', segundosPorEscalon: per / 1000 }, escalones: stages, baseDeDatos: final?.baseDeDatos, registros: server.logs, consistencia: cons };
  save('D-alta-demanda', out); await server.stop(); return out;
}

/* ───────── E · resistencia ───────── */
async function scenarioE() {
  const server = await startServer({ port: 3105 }); adminHeaders = server.adminHeaders; const rec = createRecorder(); const sampler = startSampler(server, 5000);
  const days = await openDays(server.base, 1, rec);
  const vus = Number(args.vus ?? 40), dur = Number(args.dur ?? 600) * 1000, t0 = Date.now();
  await runVUs({ count: vus, durationMs: dur, rampMs: 5000, fn: async () => {
    await rec.timed('config', `${server.base}/config`); await think(200, 600);
    await rec.timed('mes', `${server.base}/disponibilidad/mes?servicio=${pick([1, 2])}&mes=${pick(days).slice(0, 7)}`); await think(300, 900);
    await bookingFlow(server.base, rec, days, { cancel: true }); await think(300, 1200);
  } });
  sampler.stop(); const final = await server.metrics(); const cons = checkConsistency(server.dbPath);
  const minutes = Math.ceil(dur / 60000), perMin = [];
  for (let m = 0; m < minutes; m++) { const from = t0 + m * 60000, to = from + 60000; const rows = rec.rec.filter((r) => r.t >= from && r.t < to); const sm = sampler.samples.filter((s) => s.t >= from && s.t < to); perMin.push({ minuto: m + 1, solicitudes: rows.length, p50Ms: pct(rows.map((r) => r.ms), 50), p95Ms: pct(rows.map((r) => r.ms), 95), p99Ms: pct(rows.map((r) => r.ms), 99), errores: rows.filter((r) => r.err || r.status >= 500).length, rssMB: sm.at(-1)?.rssMB ?? null, heapMB: sm.at(-1)?.heapMB ?? null }); }
  const out = { config: { vus, duracionS: dur / 1000, pausas: 'humanas 0.2–1.2 s' }, global: rec.summary(), porMinuto: perMin, servidor: summarizeSamples(sampler.samples), baseDeDatos: final.baseDeDatos, registros: server.logs, consistencia: cons };
  save('E-resistencia', out); await server.stop(); return out;
}

const all = { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE };
const todo = which === 'TODO' ? ['A', 'B', 'C', 'D', 'E'] : [which];
for (const k of todo) {
  console.log(`\n▶ Escenario ${k}`);
  const out = await all[k]();
  console.log(JSON.stringify(out.global ?? out.resumenHttp ?? out.escalones?.map((e) => ({ vu: e.usuariosVirtuales, rps: e.rps, p95: e.p95Ms })) ?? out.oleada1_distintos?.resultado, null, 1).slice(0, 1500));
  console.log('  consistencia:', JSON.stringify(out.consistencia ?? out.consistenciaFinal));
}
process.exit(0);
