# Infraestructura: base de datos, capacidad, proveedores y costos

> **Estado real:** la aplicación **no está desplegada**; hoy solo corre en desarrollo. "Infraestructura gratuita actual" significa, por tanto, *lo que ya es gratis y usamos* (GitHub, Gmail) más lo que se podría alojar sin pagar. Los precios de proveedores salen de búsquedas web hechas el 30/oct/2026 (fuentes al final); **varias cifras vienen de terceros y algunas se contradicen entre sí: están marcadas con ⚠ y deben confirmarse en la página oficial antes de contratar.**
> Los números de capacidad **sí son medidos** (ver [`docs/carga/RESULTADOS.md`](carga/RESULTADOS.md)).

## 1. Respuesta corta

| Pregunta | Respuesta |
|---|---|
| ¿Cambiar de base de datos? | **No.** SQLite (modo WAL, en archivo) cubre de sobra 1.000 clientes y la concurrencia real de este negocio. Cambiar a PostgreSQL añadiría costo y operación sin beneficio medible. |
| ¿Alcanza la aplicación para 1.000 clientes y las ráfagas de reservas? | **Sí, con enorme margen** (ver §3): el cuello de botella real no es el servidor sino la agenda: un solo carro a la vez ⇒ como máximo ~4 citas por día. |
| ¿El plan 100 % gratuito es suficiente? | **Para el frontend, el correo y las tareas externas, sí. Para el backend, no de forma fiable**: la base de datos es un archivo y el proceso debe estar siempre encendido (tareas programadas); los planes gratuitos o duermen el servicio, o no guardan disco, o pueden reclamarse (§4). Hay que pagar **~US$3–6 al mes** por un servidor pequeño con disco persistente. |
| ¿Hay que pagar algo más? | Un dominio (costo del registrador; no investigado). Todo lo demás puede quedarse gratis: Gmail (500 destinatarios/día ⚠), GitHub Actions como red de seguridad de tareas, monitoreo gratuito. |

## 2. Base de datos: análisis y decisión

| Criterio | SQLite (actual) | PostgreSQL gestionado (alternativa) |
|---|---|---|
| **Almacenamiento** | Datos en estado estable: ver §3 (cifras medidas; < 5 MB con 1.000 clientes y la política de limpieza semanal) | Planes gratuitos con 0,5–1 GB y suspensión por inactividad; plan estable desde ~US$5–15/mes ⚠ |
| **Concurrencia** | Un escritor a la vez, lectores simultáneos (WAL). Medido: cientos de reservas/s en ráfaga, sin errores, **cero reservas duplicadas** (escenarios B y C) | Muchos escritores; no se necesita a esta escala |
| **Rendimiento de consultas** | Consultas por clave/índice en microsegundos; transacciones de reserva medidas en ms (ver resultados) | Latencia de red adicional en cada consulta |
| **Integridad** | `UNIQUE`/`CHECK`/`FOREIGN KEY`/triggers + transacciones `BEGIN IMMEDIATE`; verificado con 8 procesos y 200 solicitudes simultáneas | Equivalente |
| **Disponibilidad** | Un solo proceso y un solo disco: si cae la máquina, hay corte hasta que vuelva (minutos). Sin réplica | Réplicas/alta disponibilidad (de pago) |
| **Seguridad** | Datos personales ya cifrados a nivel de campo (AES-256-GCM) antes de llegar al disco; archivo accesible solo al proceso | Cifrado en reposo del proveedor + el nuestro |
| **Copias de seguridad** | `VACUUM INTO` diario verificado + copia previa a migraciones; **falta copiarlas fuera del servidor** (ver DESPLIEGUE) | Copias automáticas del proveedor |
| **Costo** | US$0 (va en el mismo servidor) | US$0 (con límites y suspensión) a US$15+ |
| **Escalamiento** | Vertical (más CPU/RAM en la misma máquina). Una sola instancia | Horizontal |

**Decisión: conservar SQLite y optimizarla** (índices por fecha, código, estado, cliente, disponibilidad; transacciones cortas; modo WAL; respaldo en caliente). **Límite conocido:** no se pueden ejecutar dos instancias a la vez; si el negocio creciera hasta necesitar eso (no es el caso: la agenda física lo impide), el acceso a datos está aislado en `server/repositories` para migrar a PostgreSQL.
**No se almacena información innecesaria ni duplicada:** el cliente vive una vez (`clientes`); la reserva solo guarda lo propio de la cita; la limpieza semanal elimina lo que ya terminó.

**Esquema (migración 002) e índices de las consultas frecuentes:** reservas por fecha (`idx_reservas_fecha`, `idx_reservas_agenda`), por número de reserva (`codigo UNIQUE`), por estado (`idx_reservas_estado_fecha`), disponibilidad (`PRIMARY KEY (fecha, slot)` en `reserva_slots`), por cliente (`idx_reservas_cliente`, `clientes.telefono_mac UNIQUE`), por correo (`idx_reservas_correo`, `idx_clientes_correo`), notificaciones (`idx_outbox_*`), historial de limpieza y auditoría por fecha.

## 3. Capacidad real (medida; detalle completo en [carga/RESULTADOS.md](carga/RESULTADOS.md))

Máquina de prueba: i7-12700H, 20 núcleos lógicos, 16 GB, Node 22, generador de carga y servidor en la misma máquina, sin red real, sin Gmail. **No es el hardware de producción**: un plan de hosting pequeño tiene bastante menos CPU, y eso no se pudo medir (no hay servidor contratado).

| Pregunta | Medido |
|---|---|
| **Tamaño de la base de datos con 1.000 clientes** + 240 reservas futuras (la agenda llena de 60 días) + 240 correos en cola | **≈ 1,0 MB** (`scripts/load/storage.mjs`). Con la limpieza semanal no crece: es un orden de magnitud por debajo de cualquier límite de almacenamiento. |
| **Memoria** | 78 MB al iniciar; 110 MB bajo uso normal; 140 MB tras 10 min sostenidos; **máx. 196 MB con 1.000 usuarios virtuales**. Sin fugas: en la prueba de 10 min el RSS se estabilizó en ~141 MB desde el minuto 1 y el heap oscila sin crecer. |
| **Uso normal** (40 usuarios con pausas humanas, 90 s) | 42 solic./s, p95 **11 ms**, p99 16 ms, 0 errores; 430 reservas creadas correctamente. |
| **Resistencia** (40 usuarios, 10 min) | 79.873 solicitudes (133/s), p95 **15 ms** estable (un pico de 28 ms en el minuto 6, ya recuperado), **0 errores 5xx**, 13.291 reservas creadas y canceladas sin una sola inconsistencia. |
| **Conflicto por el mismo horario** (200 solicitudes simultáneas × 20 horarios) | **Exactamente 1 reserva por horario en las 20 rondas** (199 respuestas "horario no disponible" cada vez), 0 duplicadas, 0 solapadas; doble clic con la misma clave → 1 reserva y 19 reintentos idempotentes. |
| **Concurrencia de horarios distintos** | 150 reservas simultáneas, todas 201 (p95 491 ms con las 150 *a la vez*); 300 más con horarios que se pisan: 11 caben, 289 reciben 409; reservas según respuestas = reservas en BD (161 = 161). |
| **Alta demanda** (escalones de 10 a 1.000 usuarios sin pausas) | **Techo ≈ 1.000 solicitudes/s** (CPU de *un* núcleo de Node al 100 %). Hasta 400 usuarios sin pausas: 0 errores y p95 < 450 ms. Con 800 y 1.000 aparecen **`ECONNREFUSED`** (1.565 y 1.953 solicitudes: la cola de conexiones del servidor, ~511, se desborda) y p99 > 1,2 s. |
| **Cuello de botella identificado** | La **CPU de un solo hilo de Node** (JSON + cifrado + registro), no la base de datos: las transacciones de escritura duran p50 1,4 ms / p95 2,7 ms y la espera por el candado de escritura es < 0,1 ms incluso a 1.000 usuarios. |
| **Conexiones a la base de datos** | 1 (SQLite en el proceso). No hay límite de conexiones que agotar. |
| **Consistencia tras todas las pruebas** | 0 solapamientos, 0 códigos duplicados, 0 casilleros huérfanos, `integrity_check = ok` en las cinco pruebas. |

**Qué significa para tu negocio.** Se pueden pensar tres escenarios distintos, como pediste:
- *1.000 clientes registrados*: ocupan ~1 MB. Irrelevante para cualquier infraestructura.
- *1.000 personas conectadas a la vez*: un humano genera una solicitud cada varios segundos; 1.000 personas ≈ 100–300 solic./s, es decir **entre 10 % y 30 % del techo medido** (en esta máquina). En un hosting con una CPU compartida pequeña el techo será menor; no se midió, pero la prueba de 40 usuarios usó solo ~35 % de un núcleo, así que hay margen incluso si el núcleo rindiera la mitad.
- *1.000 personas intentando reservar el mismo instante*: lo más que el sistema acepta es **una reserva por horario**; las demás reciben un mensaje inmediato. Aun así, 150 reservas distintas simultáneas se procesaron en ~0,5 s. Si de verdad llegaran ~1.000 conexiones **simultáneas** al mismo segundo, algunas serían rechazadas por la cola de conexiones (se observó con 800+): es el límite honesto del servidor único. Ajustable subiendo el *backlog* o poniendo el proxy del proveedor delante (que ya absorbe conexiones).
- **Límite real del negocio**: un solo carro a la vez ⇒ **como máximo 4 citas por día** (Exterior) o 3 (Completo). Con tan poca capacidad física, el servidor nunca será el factor limitante.

**Límites del correo:** Gmail personal ≈ 500 destinatarios/día ⚠ (fuente de terceros; Workspace ≈ 2.000). El sistema envía ~1–3 correos por reserva y 1 resumen al día: **< 20 correos/día** en el peor caso. Sobra más de 25 veces. El tiempo real de envío de Gmail **no está medido** (faltan credenciales).

## 4. Proveedores: qué ofrecen y qué exige nuestra aplicación

**Lo que la aplicación exige:** (a) *disco persistente* (SQLite); (b) *un proceso siempre encendido* (tareas programadas y cola de correos); (c) *una sola instancia*; (d) ~256–512 MB de RAM (medido: 78–196 MB); (e) HTTPS.

| Proveedor / plan | Qué dice (⚠ = confirmar) | ¿Sirve para el backend? |
|---|---|---|
| **Render – plan gratis** | Se **duerme tras 15 min sin tráfico**; **sin disco persistente**: la base SQLite se pierde en cada reinicio/redespliegue; si agota las horas gratis se suspende. | **No.** Perdería reservas y no cumpliría el resumen de las 11 p. m. |
| **Oracle Cloud Always Free** | VM AMD Micro (1/8 OCPU, 1 GB) siempre gratis; Ampere A1 recortado a 2 OCPU/12 GB desde jun/2026 ⚠; disco hasta 200 GB; los A1 inactivos pueden reclamarse; trámites con tarjeta, capacidad no garantizada, sin SLA. | **Técnicamente sí** (el proceso cabe sobrado), pero con **riesgo operativo**: tú mantienes el sistema operativo, el proxy HTTPS y los respaldos, y Oracle puede cambiar o retirar el plan sin aviso (ya lo recortó). |
| **Railway** | Plan gratuito ≈ US$1 de crédito/mes tras la prueba; Hobby US$5/mes con US$5 de crédito de uso; cobra CPU/RAM por uso ⚠ (comportamiento al agotar el crédito: contradictorio entre fuentes). | Sí en Hobby (volúmenes persistentes), costo variable. |
| **Fly.io** | Máquina `shared-cpu-1x` 256 MB ≈ **US$1,94–2,19/mes** ⚠ (hay un alza de RAM de US$5→6/GB anunciada para el 1/oct/2026); volumen ≈ US$0,15/GB/mes; sin nivel gratuito para cuentas nuevas ⚠. Máquina siempre encendida (`min_machines_running = 1`). | **Sí.** 512 MB ≈ US$3–4/mes + volumen < US$1. Región Puerto Rico disponible ⚠. |
| **Hetzner Cloud (VPS)** | CAX11 / CX23 (2 vCPU, 4 GB) ≈ **€4–5/mes** ⚠ (hubo alzas en abril y junio/2026; las fuentes difieren: €3,79–4,99); mucho más recurso que el necesario; tú administras el servidor. Copias gestionadas aparte (≈ +20 % ⚠). | **Sí**, sobradamente; más trabajo operativo. |
| **Cloudflare Pages (solo frontend)** | Gratis: 500 compilaciones/mes, 20.000 archivos, 25 MiB por archivo; ancho de banda "ilimitado" según terceros ⚠ (no confirmado en la página oficial). Nuestro sitio: 74 archivos, el mayor 4,9 MB. | Sí para el frontend, pero **no hace falta separarlo** (§ DESPLIEGUE). |
| **GitHub Actions (cron externo)** | Gratis; puede retrasar los cron y los desactiva tras 60 días sin actividad en el repositorio ⚠. | Solo como **red de seguridad** de las tareas, no como mecanismo principal. |
| **Gmail** | Gratis; ≈ 500 destinatarios/día (personal) ⚠; la contraseña de aplicación se revoca si cambias tu contraseña. | Sí (volumen < 20/día). |

## 5. Comparación de las tres infraestructuras

| | **1 · Gratuita** | **2 · Optimizada de bajo costo** (recomendada) | **3 · Producción holgada** |
|---|---|---|---|
| Frontend | Dentro del mismo proceso (o Cloudflare Pages) | Dentro del mismo proceso | Cloudflare Pages (gratis) + proceso |
| Backend + BD | **Oracle Always Free (AMD Micro)** con SQLite en su disco, Caddy para HTTPS | **Fly.io** `shared-cpu-1x` 512 MB + volumen 1 GB, siempre encendida | VPS Hetzner (2 vCPU/4 GB) con systemd + Caddy, o Fly con 1 GB |
| Correo | Gmail gratis | Gmail gratis | Gmail (o Workspace si el volumen crece) |
| Tareas | Cron interno + GitHub Actions | Cron interno + GitHub Actions | Cron interno + GitHub Actions + monitor externo |
| Monitoreo | Chequeo gratuito de `/api/listo` | Ídem + `fly logs` | Ídem + alertas por correo |
| **Precio mensual** | **US$0** (+ dominio) | **≈ US$3,5–5** ⚠ (+ dominio) | **≈ US$5–8** ⚠ (+ dominio) |
| Capacidad esperada | Muy inferior a este equipo de prueba (1/8 de núcleo): alcanza para el tráfico real, **no medido** en ese hardware | Un núcleo compartido: el techo medido en un núcleo rápido fue ~1.000 solic./s; el real será menor, **no medido** | Más CPU/RAM; el hilo único de Node sigue siendo el techo (~1.000 solic./s en un núcleo rápido) |
| Ventajas | Cuesta cero | Siempre encendido, HTTPS, volumen, despliegue con un comando, redundancia razonable | Mucho margen; control total |
| Desventajas / riesgos | Sin SLA; Oracle puede recortar/retirar; mantenimiento del SO y respaldos a tu cargo; un solo disco | Costo recurrente pequeño; precios cambian (⚠); una sola máquina ⇒ corte si cae | Más administración (parches, seguridad del servidor) |
| Cuándo elegirla | Solo si el costo cero pesa más que el riesgo y alguien sabe administrar un servidor | **Es la que equilibra costo y fiabilidad para un negocio de ~4 citas/día** | Si el negocio crece, o se quiere un solo servidor para otras apps |

**Conclusión basada en los límites publicados y las pruebas:**
1. *No hace falta pagar* por frontend, correo (< 20/día), tareas externas ni monitoreo básico: todo eso es gratis y suficiente.
2. *El backend no debe ir en un plan gratuito que duerma o no tenga disco* (Render): falla de forma silenciosa y pierde datos.
3. *Oracle gratis es la única opción de US$0 que técnicamente funciona*, pero depende de un proveedor que ya recortó el plan y de que tú administres un servidor. No la recomiendo para un negocio que cobra citas.
4. **Recomendación: infraestructura 2 (Fly.io o equivalente, ≈ US$3,5–5/mes).** El gasto es pequeño frente al riesgo de perder reservas, y la aplicación ya está preparada (`Dockerfile`, `fly.toml`, volumen, health checks). *Esta recomendación no se probó en un proveedor real: el `Dockerfile` y `fly.toml` no se ejecutaron.*
5. **Siempre**: copiar `BACKUP_DIR` fuera del servidor y guardar `DATA_ENCRYPTION_KEY` aparte; eso importa más que el plan.

### Fuentes (consultadas el 30/oct/2026)
- Fly.io: [fly.io/pricing](https://fly.io/pricing.md) · [fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/) · [artículo de precios 2026](https://temps.sh/blog/fly-io-pricing-2026)
- Render (plan gratuito): [render.com/docs/free](https://render.com/docs/free)
- Railway: [docs.railway.com/pricing/plans](https://docs.railway.com/pricing/plans)
- Hetzner: [bitdoze](https://www.bitdoze.com/md/hetzner-cloud-review.md) · [vpsbenchmarks CAX11](https://www.vpsbenchmarks.com/hosters/hetzner/plans/cax11) · [alza de junio 2026](https://privatedevops.com/news/hetzner-june-2026-cloud-price-increase-what-to-do)
- Oracle: [docs.oracle.com Always Free](https://docs.oracle.com/iaas/Content/FreeTier/resourceref.htm) · [recorte A1](https://linuxiac.com/?p=214114)
- Cloudflare Pages: [developers.cloudflare.com/pages/platform/limits](https://developers.cloudflare.com/pages/platform/limits)
- GitHub Actions cron: [keepalive-workflow](https://github.com/gautamkrishnar/keepalive-workflow) · [cronuru](https://cronuru.com/guides/github-actions-scheduled-workflows)
- Gmail: [serversmtp.com](https://serversmtp.com/limits-of-gmail-smtp-server/) · [nodemailer](https://nodemailer.com/usage/using-gmail)

