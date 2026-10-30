// Genera docs/carga/RESULTADOS.md a partir de los JSON medidos (docs/carga/resultados-*.json). No escribe ningún número a mano.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const load = (n) => (existsSync(`docs/carga/resultados-${n}.json`) ? JSON.parse(readFileSync(`docs/carga/resultados-${n}.json`, 'utf8')) : null);
const A = load('A-uso-normal'), B = load('B-concurrencia'), C = load('C-conflicto'), D = load('D-alta-demanda'), E = load('E-resistencia');
const est = (e) => Object.entries(e ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
const row = (...c) => `| ${c.join(' | ')} |`;
const out = [];
const m = (A ?? B ?? C ?? D ?? E)?.maquina;

out.push('# Resultados de las pruebas de carga', '',
  '> Datos **medidos** por `scripts/load/run.mjs` (se regeneran con `node scripts/load/report.mjs`). Nada está estimado ni inventado; lo que no se pudo medir se dice.', '',
  '## Condiciones de la prueba (leer antes de interpretar los números)', '',
  m ? `- **Máquina de pruebas:** ${m.cpu}, ${m.nucleosLogicos} núcleos lógicos, ${m.ramGB} GB de RAM, ${m.so}, Node ${m.node}. **Generador de carga y servidor corren en la MISMA máquina** (compiten por CPU): el servidor real tendría menos competencia y la CPU de un plan de hosting pequeño es mucho menor que esta.` : '',
  '- **Servidor:** el real (`server/index.js`) con SQLite en archivo temporal, `NODE_ENV=development`, `LOG_LEVEL=info` (cada solicitud relevante se registra), límites de uso por IP **desactivados** (`RATE_LIMITS_ENABLED=false`; no permitido en producción) porque todos los usuarios virtuales vienen de la misma IP, tareas programadas apagadas, Gmail sin configurar (los correos quedan en cola: **el tiempo de envío real por Gmail no está medido**).',
  '- **Qué NO se midió:** la descarga de la página estática (HTML, video, modelo 3D: 18 MB en total) ni la red real (todo es localhost, latencia de red ≈ 0). Las latencias son del procesamiento del servidor.',
  '- **Modelo de carga:** *cerrado* (cada usuario virtual espera su respuesta antes de la siguiente). Un humano real hace una solicitud cada varios segundos; por eso **un usuario virtual sin pausas equivale a muchísimos usuarios humanos**.',
  '- **Conexiones a la base de datos:** SQLite corre dentro del proceso (una conexión, sin servidor aparte): no hay "límite de conexiones" que saturar; la contención aparece como espera del candado de escritura (se reporta).', '');

const sv = (s) => s ? `RSS ${s.rssMB.inicio}→${s.rssMB.fin} MB (máx ${s.rssMB.max}) · CPU del proceso prom ${s.cpuServerNucleoPct.avg}% / máx ${s.cpuServerNucleoPct.max}% de un núcleo · CPU de la máquina prom ${s.cpuMaquinaPct.avg}% / máx ${s.cpuMaquinaPct.max}% · bucle de eventos p99 máx ${s.bucleP99ms.max} ms` : '—';
const tx = (b) => b ? `${b.transaccionesOk} transacciones de escritura (${b.transaccionesFallidas} fallidas) · duración p50/p95/p99 = ${b.transaccionMs.p50}/${b.transaccionMs.p95}/${b.transaccionMs.p99} ms · espera de candado p95/p99 = ${b.esperaDeCandadoMs.p95}/${b.esperaDeCandadoMs.p99} ms` : '—';
const cons = (c) => c ? `reservas ${c.reservas} (confirmadas ${c.confirmadas}, canceladas ${c.canceladas}) · casilleros huérfanos ${c.casillerosHuerfanos} · bloques incoherentes ${c.confirmadasConBloqueIncoherente} · **solapamientos ${c.solapamientos}** · códigos duplicados ${c.codigosDuplicados} · integridad SQLite: ${c.integridadSqlite}` : '—';

if (A) {
  const g = A.global;
  out.push('## Escenario A · uso normal', '', `${A.config.vus} usuarios virtuales (rampa de ${Math.round(A.config.duracionS / 3)} s), ${A.config.duracionS} s, ${A.config.pausas}. Flujo: ver configuración → calendario del mes → disponibilidad del día → reservar → (70 %) consultar y cancelar.`, '',
    row('Solicitudes', 'Solic./s', 'Promedio', 'Mediana', 'p95', 'p99', 'Máx', 'Estados'), row('---', '---', '---', '---', '---', '---', '---', '---'),
    row(g.solicitudes, g.rps, `${g.promedioMs} ms`, `${g.medianaMs} ms`, `${g.p95Ms} ms`, `${g.p99Ms} ms`, `${g.maxMs} ms`, est(g.estados)), '',
    `- Reservas creadas correctamente (201): **${A.reservasCreadas}** · conflictos (409): ${A.conflictos409} · otros: ${A.otrosEstados}`, `- Servidor: ${sv(A.servidor)}`, `- Base de datos: ${tx(A.baseDeDatos)}`, `- Consistencia final: ${cons(A.consistencia)}`, '',
    '| Solicitud | n | p50 | p95 | p99 |', '|---|---|---|---|---|', ...Object.entries(A.porSolicitud).map(([k, v]) => row(k, v.solicitudes, `${v.medianaMs} ms`, `${v.p95Ms} ms`, `${v.p99Ms} ms`)), '');
}
if (B) {
  const w1 = B.oleada1_distintos, w2 = B.oleada2_solapados;
  out.push('## Escenario B · concurrencia con horarios distintos', '',
    `**Oleada 1:** ${w1.intentos} personas reservando a la vez, cada una un horario distinto y compatible → esperado: todas 201. Resultado: ${est(w1.resultado.estados)} · p50 ${w1.resultado.medianaMs} ms · p95 ${w1.resultado.p95Ms} ms · p99 ${w1.resultado.p99Ms} ms.`, '',
    `**Oleada 2:** ${w2.intentos} personas más eligiendo al azar entre horarios que se pisan (servicios 1 y 2, inicios cada 30 min) → solo caben las que no se solapan. Resultado: ${est(w2.resultado.estados)} · p95 ${w2.resultado.p95Ms} ms.`, '',
    `- Reservas creadas según las respuestas HTTP: **${B.reservasCreadasSegunRespuestas}** · reservas confirmadas en la BD: **${B.consistenciaFinal.confirmadas}** → coinciden: **${B.coincideRespuestasConBD ? 'sí' : 'NO'}**`, `- Servidor: ${sv(B.servidor)}`, `- Base de datos: ${tx(B.baseDeDatos)}`, `- Consistencia final: ${cons(B.consistenciaFinal)}`, '');
}
if (C) {
  out.push('## Escenario C · conflicto por el mismo horario', '', `${C.solicitudesPorRonda} solicitudes simultáneas por el MISMO horario, 20 rondas en 20 horarios distintos.`, '',
    '| Ronda | Fecha | Hora | Solicitudes | 201 | 409 | Otros |', '|---|---|---|---|---|---|---|', ...C.rondas.map((r) => row(r.ronda, r.fecha, r.hora, r.solicitudes, r.creadas201, r.conflicto409, r.otros)), '',
    `- **¿Exactamente una reserva por horario en todas las rondas?** ${C.todasLasRondasExactamenteUnaReserva ? '**Sí**' : '**NO**'}`,
    `- Horarios que se solapan (inicios 8:00–11:00, servicios mezclados, ${C.solapados.solicitudes} solicitudes, un mismo día): creadas ${C.solapados.creadas} · 409 ${C.solapados.conflicto409} · otros ${C.solapados.otros}`,
    `- Doble clic (misma clave de idempotencia, 20 solicitudes simultáneas): 201 ×${C.dobleClic.respuestas201} · reintento 200 ×${C.dobleClic.reintentos200} · otros ${C.dobleClic.otros}`,
    `- Reservas esperadas ${C.reservasEsperadas} · en la BD ${C.reservasEnBD}`, `- Servidor: ${sv(C.servidor)}`, `- Base de datos: ${tx(C.baseDeDatos)}`, `- Consistencia final: ${cons(C.consistencia)}`, '');
}
if (D) {
  out.push('## Escenario D · alta demanda (escalones)', '', `${D.config.modelo}; mezcla: ${D.config.mezcla}; ${D.config.segundosPorEscalon} s por escalón.`, '',
    '| Usuarios virtuales | Solic./s | Solicitudes | p50 | p95 | p99 | Máx | Estados | RSS máx | CPU proceso máx (núcleo) | CPU máquina prom | Bucle p99 máx |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...D.escalones.map((e) => row(e.usuariosVirtuales, e.rps, e.solicitudes, `${e.medianaMs} ms`, `${e.p95Ms} ms`, `${e.p99Ms} ms`, `${e.maxMs} ms`, est(e.estados), `${e.servidor.rssMB.max} MB`, `${e.servidor.cpuServerNucleoPct.max}%`, `${e.servidor.cpuMaquinaPct.avg}%`, `${e.servidor.bucleP99ms.max} ms`)), '',
    `- Base de datos (acumulado): ${tx(D.baseDeDatos)}`, `- Consistencia final: ${cons(D.consistencia)}`, '');
}
if (E) {
  const g = E.global;
  out.push('## Escenario E · resistencia', '', `${E.config.vus} usuarios virtuales durante ${E.config.duracionS} s (${E.config.pausas}).`, '',
    `Total: ${g.solicitudes} solicitudes · ${g.rps} solic./s · p50 ${g.medianaMs} ms · p95 ${g.p95Ms} ms · p99 ${g.p99Ms} ms · ${est(g.estados)}`, '',
    '| Minuto | Solicitudes | p50 | p95 | p99 | Errores | RSS | Heap usado |', '|---|---|---|---|---|---|---|---|', ...E.porMinuto.map((r) => row(r.minuto, r.solicitudes, `${r.p50Ms} ms`, `${r.p95Ms} ms`, `${r.p99Ms} ms`, r.errores, `${r.rssMB} MB`, `${r.heapMB} MB`)), '',
    `- Servidor: ${sv(E.servidor)}`, `- Base de datos: ${tx(E.baseDeDatos)}`, `- Consistencia final: ${cons(E.consistencia)}`, '');
}
writeFileSync('docs/carga/RESULTADOS.md', out.join('\n'));
console.log('docs/carga/RESULTADOS.md generado');
