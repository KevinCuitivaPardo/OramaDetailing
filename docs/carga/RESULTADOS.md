# Resultados de las pruebas de carga

> Datos **medidos** por `scripts/load/run.mjs` (se regeneran con `node scripts/load/report.mjs`). Nada está estimado ni inventado; lo que no se pudo medir se dice.

## Condiciones de la prueba (leer antes de interpretar los números)

- **Máquina de pruebas:** 12th Gen Intel(R) Core(TM) i7-12700H, 20 núcleos lógicos, 16 GB de RAM, win32 10.0.26200, Node v22.20.0. **Generador de carga y servidor corren en la MISMA máquina** (compiten por CPU): el servidor real tendría menos competencia y la CPU de un plan de hosting pequeño es mucho menor que esta.
- **Servidor:** el real (`server/index.js`) con SQLite en archivo temporal, `NODE_ENV=development`, `LOG_LEVEL=info` (cada solicitud relevante se registra), límites de uso por IP **desactivados** (`RATE_LIMITS_ENABLED=false`; no permitido en producción) porque todos los usuarios virtuales vienen de la misma IP, tareas programadas apagadas, Gmail sin configurar (los correos quedan en cola: **el tiempo de envío real por Gmail no está medido**).
- **Qué NO se midió:** la descarga de la página estática (HTML, video, modelo 3D: 18 MB en total) ni la red real (todo es localhost, latencia de red ≈ 0). Las latencias son del procesamiento del servidor.
- **Modelo de carga:** *cerrado* (cada usuario virtual espera su respuesta antes de la siguiente). Un humano real hace una solicitud cada varios segundos; por eso **un usuario virtual sin pausas equivale a muchísimos usuarios humanos**.
- **Conexiones a la base de datos:** SQLite corre dentro del proceso (una conexión, sin servidor aparte): no hay "límite de conexiones" que saturar; la contención aparece como espera del candado de escritura (se reporta).

## Escenario A · uso normal

40 usuarios virtuales (rampa de 30 s), 90 s, humanas 0.3–2.5 s entre pasos. Flujo: ver configuración → calendario del mes → disponibilidad del día → reservar → (70 %) consultar y cancelar.

| Solicitudes | Solic./s | Promedio | Mediana | p95 | p99 | Máx | Estados |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3853 | 42.2 | 5.04 ms | 4.19 ms | 10.98 ms | 15.65 ms | 62.8 ms | 200: 3421 · 201: 430 · 409: 2 |

- Reservas creadas correctamente (201): **430** · conflictos (409): 2 · otros: 0
- Servidor: RSS 78.29→109.78 MB (máx 110.45) · CPU del proceso prom 15.02% / máx 44.97% de un núcleo · CPU de la máquina prom 17.88% / máx 43.5% · bucle de eventos p99 máx 23.12 ms
- Base de datos: 735 transacciones de escritura (2 fallidas) · duración p50/p95/p99 = 3.39/9.66/11.29 ms · espera de candado p95/p99 = 0.05/0.08 ms
- Consistencia final: reservas 430 (confirmadas 125, canceladas 305) · casilleros huérfanos 0 · bloques incoherentes 0 · **solapamientos 0** · códigos duplicados 0 · integridad SQLite: ok

| Solicitud | n | p50 | p95 | p99 |
|---|---|---|---|---|
| mes | 939 | 5.55 ms | 9.95 ms | 15.37 ms |
| config | 936 | 2.76 ms | 7.33 ms | 12.25 ms |
| disponibilidad_dia | 936 | 3.2 ms | 6.84 ms | 13.1 ms |
| reservar | 432 | 8.33 ms | 15.52 ms | 19.9 ms |
| consultar | 305 | 3.84 ms | 8.44 ms | 13.54 ms |
| cancelar | 305 | 6.65 ms | 10.84 ms | 16.05 ms |

## Escenario B · concurrencia con horarios distintos

**Oleada 1:** 150 personas reservando a la vez, cada una un horario distinto y compatible → esperado: todas 201. Resultado: 201: 150 · p50 302.38 ms · p95 491.46 ms · p99 509.26 ms.

**Oleada 2:** 300 personas más eligiendo al azar entre horarios que se pisan (servicios 1 y 2, inicios cada 30 min) → solo caben las que no se solapan. Resultado: 201: 11 · 409: 289 · p95 468.62 ms.

- Reservas creadas según las respuestas HTTP: **161** · reservas confirmadas en la BD: **161** → coinciden: **sí**
- Servidor: RSS 108.35→108.35 MB (máx 108.35) · CPU del proceso prom 93.12% / máx 93.12% de un núcleo · CPU de la máquina prom 21.3% / máx 21.3% · bucle de eventos p99 máx 174.85 ms
- Base de datos: 161 transacciones de escritura (289 fallidas) · duración p50/p95/p99 = 0.54/1.88/3.36 ms · espera de candado p95/p99 = 0.02/0.03 ms
- Consistencia final: reservas 161 (confirmadas 161, canceladas 0) · casilleros huérfanos 0 · bloques incoherentes 0 · **solapamientos 0** · códigos duplicados 0 · integridad SQLite: ok

## Escenario C · conflicto por el mismo horario

200 solicitudes simultáneas por el MISMO horario, 20 rondas en 20 horarios distintos.

| Ronda | Fecha | Hora | Solicitudes | 201 | 409 | Otros |
|---|---|---|---|---|---|---|
| 1 | 2026-10-31 | 08:00 | 200 | 1 | 199 | 0 |
| 2 | 2026-11-01 | 10:00 | 200 | 1 | 199 | 0 |
| 3 | 2026-11-04 | 12:00 | 200 | 1 | 199 | 0 |
| 4 | 2026-11-05 | 14:00 | 200 | 1 | 199 | 0 |
| 5 | 2026-11-06 | 08:00 | 200 | 1 | 199 | 0 |
| 6 | 2026-11-07 | 10:00 | 200 | 1 | 199 | 0 |
| 7 | 2026-11-08 | 12:00 | 200 | 1 | 199 | 0 |
| 8 | 2026-11-11 | 14:00 | 200 | 1 | 199 | 0 |
| 9 | 2026-11-12 | 08:00 | 200 | 1 | 199 | 0 |
| 10 | 2026-11-13 | 10:00 | 200 | 1 | 199 | 0 |
| 11 | 2026-11-14 | 12:00 | 200 | 1 | 199 | 0 |
| 12 | 2026-11-15 | 14:00 | 200 | 1 | 199 | 0 |
| 13 | 2026-11-18 | 08:00 | 200 | 1 | 199 | 0 |
| 14 | 2026-11-19 | 10:00 | 200 | 1 | 199 | 0 |
| 15 | 2026-11-20 | 12:00 | 200 | 1 | 199 | 0 |
| 16 | 2026-11-21 | 14:00 | 200 | 1 | 199 | 0 |
| 17 | 2026-11-22 | 08:00 | 200 | 1 | 199 | 0 |
| 18 | 2026-11-25 | 10:00 | 200 | 1 | 199 | 0 |
| 19 | 2026-11-26 | 12:00 | 200 | 1 | 199 | 0 |
| 20 | 2026-11-27 | 14:00 | 200 | 1 | 199 | 0 |

- **¿Exactamente una reserva por horario en todas las rondas?** **Sí**
- Horarios que se solapan (inicios 8:00–11:00, servicios mezclados, 200 solicitudes, un mismo día): creadas 2 · 409 198 · otros 0
- Doble clic (misma clave de idempotencia, 20 solicitudes simultáneas): 201 ×1 · reintento 200 ×19 · otros 0
- Reservas esperadas 23 · en la BD 23
- Servidor: RSS 111.75→139.66 MB (máx 141.19) · CPU del proceso prom 92.55% / máx 122.02% de un núcleo · CPU de la máquina prom 17.34% / máx 24.7% · bucle de eventos p99 máx 509.61 ms
- Base de datos: 42 transacciones de escritura (4178 fallidas) · duración p50/p95/p99 = 1.1/1.99/3.52 ms · espera de candado p95/p99 = 0.05/0.08 ms
- Consistencia final: reservas 23 (confirmadas 23, canceladas 0) · casilleros huérfanos 0 · bloques incoherentes 0 · **solapamientos 0** · códigos duplicados 0 · integridad SQLite: ok

## Escenario D · alta demanda (escalones)

cerrado (cada usuario espera su respuesta y repite sin pausa); mezcla: 85 % lecturas, 15 % flujo reservar→consultar→cancelar; 20 s por escalón.

| Usuarios virtuales | Solic./s | Solicitudes | p50 | p95 | p99 | Máx | Estados | RSS máx | CPU proceso máx (núcleo) | CPU máquina prom | Bucle p99 máx |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 1014.5 | 20308 | 9.06 ms | 15.32 ms | 20.03 ms | 41 ms | 200: 18221 · 201: 2066 · 409: 21 | 167.96 MB | 124.89% | 14.76% | 25.77 ms |
| 25 | 1033.1 | 20671 | 22.25 ms | 35.54 ms | 41.28 ms | 61.4 ms | 200: 18543 · 201: 2062 · 409: 66 | 170.32 MB | 102.95% | 13.53% | 36.24 ms |
| 50 | 935.3 | 18784 | 50.28 ms | 71.4 ms | 89.99 ms | 126.7 ms | 200: 16777 · 201: 1888 · 409: 119 | 172.28 MB | 100.5% | 20.46% | 66.36 ms |
| 100 | 1014.8 | 20471 | 94.29 ms | 120.59 ms | 135.16 ms | 197.6 ms | 200: 18332 · 201: 1869 · 409: 270 | 172.88 MB | 103.63% | 14.54% | 107.28 ms |
| 200 | 995.3 | 20279 | 193.63 ms | 229.09 ms | 274.79 ms | 334.2 ms | 200: 18097 · 201: 1680 · 409: 502 | 173.39 MB | 102.53% | 14.4% | 134.48 ms |
| 400 | 998.2 | 20698 | 384.74 ms | 443.81 ms | 482.71 ms | 1298.5 ms | 200: 18513 · 201: 1308 · 409: 877 | 175.14 MB | 109.35% | 18.26% | 143.52 ms |
| 800 | 1242 | 26113 | 650.14 ms | 720.98 ms | 1217.69 ms | 3949.8 ms | 200: 22470 · 201: 862 · 409: 1216 · error:ECONNREFUSED: 1565 | 189.27 MB | 106.04% | 14.74% | 143.52 ms |
| 1000 | 1290.1 | 27330 | 787.41 ms | 895.77 ms | 1453.15 ms | 5479.9 ms | 200: 23769 · 201: 559 · 409: 1049 · error:ECONNREFUSED: 1953 | 196.14 MB | 109.07% | 17.44% | 144.83 ms |

- Base de datos (acumulado): 24518 transacciones de escritura (4120 fallidas) · duración p50/p95/p99 = 1.44/2.71/13.68 ms · espera de candado p95/p99 = 0.02/0.04 ms
- Consistencia final: reservas 12294 (confirmadas 70, canceladas 12224) · casilleros huérfanos 0 · bloques incoherentes 0 · **solapamientos 0** · códigos duplicados 0 · integridad SQLite: ok

## Escenario E · resistencia

40 usuarios virtuales durante 600 s (humanas 0.2–1.2 s).

Total: 79873 solicitudes · 132.9 solic./s · p50 4.53 ms · p95 14.98 ms · p99 31.43 ms · 200: 66551 · 201: 13291 · 409: 31

| Minuto | Solicitudes | p50 | p95 | p99 | Errores | RSS | Heap usado |
|---|---|---|---|---|---|---|---|
| 1 | 7780 | 4.96 ms | 12.73 ms | 18.26 ms | 0 | 136.05 MB | 32.27 MB |
| 2 | 7962 | 4.3 ms | 11.4 ms | 20.24 ms | 0 | 140.51 MB | 21.49 MB |
| 3 | 8008 | 4.3 ms | 11.57 ms | 22 ms | 0 | 140.23 MB | 23.18 MB |
| 4 | 8016 | 4.27 ms | 12.35 ms | 23.19 ms | 0 | 141.34 MB | 27.13 MB |
| 5 | 7987 | 3.8 ms | 11.46 ms | 22.42 ms | 0 | 140.72 MB | 18.88 MB |
| 6 | 8006 | 5.72 ms | 27.51 ms | 52.67 ms | 0 | 141.43 MB | 24.74 MB |
| 7 | 7891 | 5.19 ms | 20.02 ms | 44.09 ms | 0 | 141.09 MB | 27.47 MB |
| 8 | 8046 | 5.22 ms | 18.41 ms | 39.03 ms | 0 | 141.36 MB | 21.51 MB |
| 9 | 8015 | 4.18 ms | 13 ms | 28.15 ms | 0 | 141.74 MB | 31.12 MB |
| 10 | 8063 | 4.16 ms | 13.36 ms | 27.36 ms | 0 | 141.3 MB | 18.85 MB |

- Servidor: RSS 101.38→141.56 MB (máx 141.84) · CPU del proceso prom 34.44% / máx 57.72% de un núcleo · CPU de la máquina prom 13.88% / máx 40.4% · bucle de eventos p99 máx 29.52 ms
- Base de datos: 26582 transacciones de escritura (31 fallidas) · duración p50/p95/p99 = 2.88/8.02/25.56 ms · espera de candado p95/p99 = 0.05/0.09 ms
- Consistencia final: reservas 13291 (confirmadas 0, canceladas 13291) · casilleros huérfanos 0 · bloques incoherentes 0 · **solapamientos 0** · códigos duplicados 0 · integridad SQLite: ok
