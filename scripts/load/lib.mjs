// Arnés de pruebas de carga (alternativa a k6: no requiere instalar binarios). Todo se mide de verdad:
//  · cada solicitud HTTP (latencia, estado) desde el generador de carga;
//  · el servidor reporta por su cuenta memoria, CPU, retraso del bucle de eventos y duración de las transacciones de la BD
//    (endpoint /api/admin/metricas, el mismo que ve el administrador);
//  · al final se abre la base de datos y se comprueba la consistencia (sin reservas duplicadas ni casilleros huérfanos).
// SOLO apunta a un servidor que este mismo script arranca, con una base de datos temporal. Nunca a producción.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(2); };
export const avg = (arr) => (arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null);

/** Arranca el servidor real en un puerto libre con una base de datos temporal y límites de uso desactivados (solo pruebas). */
export async function startServer({ port = 3100, env = {} } = {}) {
  const dir = mkdtempSync(join(os.tmpdir(), 'orama-load-'));
  const adminSecret = randomBytes(32).toString('base64url'); // aleatorio en cada corrida, nunca se guarda
  const dbPath = join(dir, 'load.db');
  const child = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'info',
      DATABASE_PATH: dbPath, BACKUP_DIR: join(dir, 'backups'), JOBS_ENABLED: 'false', RATE_LIMITS_ENABLED: 'false', ADMIN_TOKEN_SECRET: adminSecret,
      MAX_BOOKINGS_PER_HOUR: '100000', MAX_ACTIVE_PER_PHONE: '20', MAX_ACTIVE_PER_EMAIL: '20', MAX_EMAILS_PER_ADDRESS_PER_DAY: '50', ...env,
    },
  });
  const logs = { lines: 0, errors: 0, warns: 0 };
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); logs.lines++; if (l.includes('"level":"error"')) logs.errors++; else if (l.includes('"level":"warn"')) logs.warns++; } });
  child.stderr.on('data', () => {});
  const base = `http://127.0.0.1:${port}/api`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/salud`)).ok) break; } catch { /* aún no */ } await sleep(100); }
  const headers = { authorization: `Bearer ${adminSecret}` };
  return {
    base, dbPath, logs, child, adminHeaders: headers,
    metrics: async () => (await fetch(`${base}/admin/metricas`, { headers })).json(),
    async stop() { child.kill(); await sleep(300); try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* temporal */ } },
  };
}

/** Muestrea el servidor (memoria, CPU, bucle de eventos, transacciones) y la CPU de toda la máquina cada segundo. */
export function startSampler(server, everyMs = 1000) {
  const samples = [];
  let last = os.cpus().map((c) => ({ ...c.times }));
  const timer = setInterval(async () => {
    try {
      const m = await server.metrics();
      const now = os.cpus().map((c) => ({ ...c.times }));
      let busy = 0, total = 0;
      now.forEach((t, i) => { const d = Object.fromEntries(Object.keys(t).map((k) => [k, t[k] - last[i][k]])); const all = Object.values(d).reduce((a, b) => a + b, 0); total += all; busy += all - d.idle; });
      last = now;
      samples.push({ t: Date.now(), rssMB: m.proceso.rssMB, heapMB: m.proceso.heapUsadoMB, cpuServerPct: m.proceso.cpuNucleoPct, loopP99: m.bucleDeEventosMs.p99, loopMax: m.bucleDeEventosMs.max, inFlight: m.http.enCurso, cpuMachinePct: total ? +((busy / total) * 100).toFixed(1) : null });
    } catch { /* el servidor puede estar saturado: se omite la muestra */ }
  }, everyMs);
  return { samples, stop: () => clearInterval(timer) };
}

export function summarizeSamples(samples) {
  const col = (k) => samples.map((s) => s[k]).filter((v) => v != null);
  const mx = (k) => (col(k).length ? Math.max(...col(k)) : null);
  return { n: samples.length, rssMB: { inicio: col('rssMB')[0], fin: col('rssMB').at(-1), max: mx('rssMB') }, heapMB: { max: mx('heapMB') }, cpuServerNucleoPct: { avg: avg(col('cpuServerPct')), max: mx('cpuServerPct') }, cpuMaquinaPct: { avg: avg(col('cpuMachinePct')), max: mx('cpuMachinePct') }, bucleP99ms: { max: mx('loopP99') }, bucleMaxMs: mx('loopMax'), enCursoMax: mx('inFlight') };
}

/** Registro de solicitudes: etiqueta, latencia y estado. Soporta ventanas (etapas) para ver la evolución. */
export function createRecorder() {
  const rec = [];
  return {
    rec,
    async timed(label, url, init, stage = 0) {
      const t0 = performance.now(); let status = 0, body = null, err = null;
      try {
        const res = await fetch(url, init);
        status = res.status;
        const text = await res.text();
        try { body = JSON.parse(text); } catch { body = null; }
      } catch (e) { err = e.code ?? e.cause?.code ?? e.name; }
      rec.push({ label, ms: performance.now() - t0, status, err, stage, t: Date.now() });
      return { status, body, err };
    },
    summary(filter = () => true) {
      const rows = rec.filter(filter);
      const lat = rows.map((r) => r.ms);
      const by = {};
      for (const r of rows) { const k = r.err ? `error:${r.err}` : String(r.status); by[k] = (by[k] ?? 0) + 1; }
      const span = rows.length ? (Math.max(...rows.map((r) => r.t)) - Math.min(...rows.map((r) => r.t))) / 1000 || 1 : 0;
      return { solicitudes: rows.length, rps: span ? +(rows.length / span).toFixed(1) : 0, promedioMs: avg(lat), medianaMs: pct(lat, 50), p95Ms: pct(lat, 95), p99Ms: pct(lat, 99), maxMs: lat.length ? +Math.max(...lat).toFixed(1) : null, estados: by };
    },
    byLabel(filter = () => true) { const out = {}; for (const l of new Set(rec.filter(filter).map((r) => r.label))) out[l] = this.summary((r) => filter(r) && r.label === l); return out; },
  };
}

/** Ejecuta `fn(vuId)` en bucle con `count` usuarios virtuales durante `durationMs` (modelo cerrado: cada uno espera su respuesta). */
export async function runVUs({ count, durationMs, rampMs = 0, fn }) {
  const end = Date.now() + durationMs;
  const vus = Array.from({ length: count }, async (_, i) => {
    if (rampMs) await sleep((rampMs * i) / count);
    while (Date.now() < end) await fn(i);
  });
  await Promise.all(vus);
}

/* ───────── datos de prueba ───────── */
let seq = 0;
export const uid = () => ++seq + Math.floor(Math.random() * 1e3) * 1e5;
export function newClient() {
  const n = uid();
  return { nombre: `Cliente Carga ${n}`, telefono: `787${String(1000000 + (n % 9000000)).slice(-7)}`, correo: `carga${n}@example.com`, lugar: 'Urb. Prueba de Carga, Aguada' };
}
export const idemKey = () => `load-${randomBytes(12).toString('hex')}`;

/** Días reservables (con horas libres) para el servicio, según el propio servidor. */
export async function openDays(base, servicio, rec) {
  const w = (await (await fetch(`${base}/config`)).json()).ventana;
  // Todos los meses que toca la ventana de reservas (no solo el primero y el último)
  const months = new Set();
  for (let y = +w.desde.slice(0, 4), m = +w.desde.slice(5, 7); `${y}-${String(m).padStart(2, '0')}` <= w.hasta.slice(0, 7); m === 12 ? (y++, m = 1) : m++) months.add(`${y}-${String(m).padStart(2, '0')}`);
  const days = [];
  for (const m of months) {
    const r = await rec.timed('mes', `${base}/disponibilidad/mes?servicio=${servicio}&mes=${m}`);
    for (const [f, v] of Object.entries(r.body?.dias ?? {})) if (v.estado === 'disponible' && f >= w.desde && f <= w.hasta) days.push(f);
  }
  return days.sort();
}

export const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function bookBody(c, { servicioId, fecha, hora }) {
  return { servicioId, vehiculo: pick(['auto', 'suv', 'pickup']), fecha, hora, nombre: c.nombre, telefono: c.telefono, correo: c.correo, lugar: c.lugar };
}
export const postJson = (body, extra = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });

/** Consistencia final leída directamente de la base de datos (solo lectura). */
export function checkConsistency(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const one = (sql) => db.prepare(sql).get();
  const out = {
    reservas: one('SELECT COUNT(*) AS n FROM reservas').n,
    confirmadas: one("SELECT COUNT(*) AS n FROM reservas WHERE estado = 'confirmada'").n,
    canceladas: one("SELECT COUNT(*) AS n FROM reservas WHERE estado = 'cancelada'").n,
    casilleros: one('SELECT COUNT(*) AS n FROM reserva_slots').n,
    casillerosHuerfanos: one("SELECT COUNT(*) AS n FROM reserva_slots s LEFT JOIN reservas r ON r.id = s.reserva_id WHERE r.id IS NULL OR r.estado <> 'confirmada'").n,
    confirmadasConBloqueIncoherente: one("SELECT COUNT(*) AS n FROM reservas r WHERE r.estado = 'confirmada' AND (SELECT COUNT(*) FROM reserva_slots WHERE reserva_id = r.id) <> (r.bloque_fin_min - r.inicio_min) / 30").n,
    // Dos confirmadas que se pisen en el tiempo (mismo día, intervalos de bloqueo que se cruzan): debe ser 0
    solapamientos: one("SELECT COUNT(*) AS n FROM reservas a JOIN reservas b ON a.fecha = b.fecha AND a.id < b.id AND a.estado = 'confirmada' AND b.estado = 'confirmada' AND a.inicio_min < b.bloque_fin_min AND b.inicio_min < a.bloque_fin_min").n,
    codigosDuplicados: one('SELECT COUNT(*) AS n FROM (SELECT codigo FROM reservas GROUP BY codigo HAVING COUNT(*) > 1)').n,
    clientes: one('SELECT COUNT(*) AS n FROM clientes').n,
    integridadSqlite: db.prepare('PRAGMA integrity_check').all()[0].integrity_check,
    tamanoMB: +(one('PRAGMA page_count').page_count * one('PRAGMA page_size').page_size / 1048576).toFixed(2),
  };
  db.close();
  return out;
}

export const machine = () => ({ cpu: os.cpus()[0].model.trim(), nucleosLogicos: os.cpus().length, ramGB: Math.round(os.totalmem() / 2 ** 30), so: `${os.platform()} ${os.release()}`, node: process.version });
