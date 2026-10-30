import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Métricas del propio proceso (sin dependencias): solicitudes, latencias, errores, transacciones de la base de datos,
 * memoria, CPU y retraso del bucle de eventos. Solo se exponen al administrador (/api/admin/metricas).
 * Las latencias se guardan en un anillo de las últimas N muestras (memoria acotada) y se calculan percentiles al consultar.
 */
const RING = 20000;

function ring(size) {
  const buf = new Float64Array(size);
  let n = 0;
  return {
    push(v) { buf[n % size] = v; n++; },
    get count() { return n; },
    percentiles(ps = [50, 95, 99]) {
      const len = Math.min(n, size);
      if (!len) return { n: 0, avg: null, ...Object.fromEntries(ps.map((p) => [`p${p}`, null])), max: null };
      const sorted = Array.from(buf.subarray(0, len)).sort((a, b) => a - b);
      const at = (p) => sorted[Math.min(len - 1, Math.ceil((p / 100) * len) - 1)];
      const avg = sorted.reduce((s, v) => s + v, 0) / len;
      return { n, avg: round(avg), ...Object.fromEntries(ps.map((p) => [`p${p}`, round(at(p))])), max: round(sorted[len - 1]) };
    },
  };
}
const round = (v) => Math.round(v * 100) / 100;

export function createMetrics() {
  const startedAt = Date.now();
  const http = ring(RING);
  const tx = ring(RING);
  const txWait = ring(RING);
  const statusCount = new Map();
  const byRoute = new Map();
  let txOk = 0, txFail = 0, inFlight = 0, maxInFlight = 0;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let lastCpu = process.cpuUsage(), lastCpuAt = performance.now();

  return {
    /** Middleware de Express: mide cada solicitud HTTP. */
    middleware: (req, res, next) => {
      const t0 = performance.now();
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      res.on('close', () => {
        inFlight--;
        const ms = performance.now() - t0;
        http.push(ms);
        const cls = `${Math.floor(res.statusCode / 100)}xx`;
        statusCount.set(cls, (statusCount.get(cls) ?? 0) + 1);
        const route = `${req.method} ${req.route?.path ?? (req.baseUrl ? req.baseUrl + '/*' : req.path.startsWith('/api') ? '/api/*' : 'estatico')}`;
        const r = byRoute.get(route) ?? { n: 0, totalMs: 0, maxMs: 0 };
        r.n++; r.totalMs += ms; r.maxMs = Math.max(r.maxMs, ms);
        byRoute.set(route, r);
      });
      next();
    },
    /** Observador de transacciones de escritura de la base de datos (ver `setTxObserver`). */
    txObserver: ({ ok, ms, waitedMs }) => { (ok ? txOk++ : txFail++); tx.push(ms); txWait.push(waitedMs); },
    snapshot() {
      const cpu = process.cpuUsage(lastCpu);
      const elapsedMs = performance.now() - lastCpuAt;
      const cpuPct = round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 100); // % de UN núcleo desde la última lectura
      lastCpu = process.cpuUsage(); lastCpuAt = performance.now();
      const mem = process.memoryUsage();
      const total = [...statusCount.values()].reduce((s, v) => s + v, 0);
      return {
        procesoDesdeSeg: Math.round((Date.now() - startedAt) / 1000),
        http: { total, porEstado: Object.fromEntries(statusCount), enCurso: inFlight, maxEnCurso: maxInFlight, latenciaMs: http.percentiles() },
        rutas: [...byRoute].map(([ruta, r]) => ({ ruta, n: r.n, promedioMs: round(r.totalMs / r.n), maxMs: round(r.maxMs) })).sort((a, b) => b.n - a.n).slice(0, 20),
        baseDeDatos: { conexiones: 1, motor: 'SQLite (en proceso, una conexión)', transaccionesOk: txOk, transaccionesFallidas: txFail, transaccionMs: tx.percentiles(), esperaDeCandadoMs: txWait.percentiles() },
        proceso: { rssMB: round(mem.rss / 1048576), heapUsadoMB: round(mem.heapUsed / 1048576), heapTotalMB: round(mem.heapTotal / 1048576), cpuNucleoPct: cpuPct },
        bucleDeEventosMs: { p50: round(loop.percentile(50) / 1e6), p99: round(loop.percentile(99) / 1e6), max: round(loop.max / 1e6) },
      };
    },
    reset() { loop.reset(); },
  };
}
