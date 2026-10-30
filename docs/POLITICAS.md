# Políticas del sistema de reservas

Estas son las decisiones de negocio que se tomaron para implementar el sistema. Salen del plan de la app (PDF) y de tus
instrucciones, y **todas se pueden cambiar con variables de entorno** (ver [OPERACION.md](OPERACION.md)) sin tocar el código.
Si el dueño quiere otra regla, solo hay que decirlo.

## 0. Cancelar o cambiar una cita: segunda verificación por correo

Por seguridad, **ningún cambio ni cancelación se aplica al instante**. El cliente pide la acción en “Mi reserva” (la página le vuelve a preguntar “¿seguro?”), el sistema envía un correo **a la dirección de esa reserva** con un enlace de un solo uso (vence en 2 horas) y la cita **sigue activa hasta que el cliente abre el enlace y pulsa “Sí, confirmar”**. Al abrir el enlace solo se *muestra* lo que se hará (un escáner de enlaces no puede cancelar por accidente). Al confirmar se vuelven a aplicar todas las reglas (plazo de 60 min, agenda abierta, horario libre): si el nuevo horario lo tomó otra persona mientras tanto, la cita original se mantiene. Si el correo no está disponible, la página lo dice y ofrece WhatsApp (no se finge nada). El propietario sigue pudiendo cancelar directo desde la API de administración.

## 1. Cambios de fecha u hora → el cliente los hace directamente (con la confirmación por correo de arriba)

- El cliente puede cambiar el **día y la hora** de su cita por su cuenta, hasta **1 hora antes** de la hora de inicio
  (`CHANGE_CUTOFF_MINUTES`, por defecto 60).
- El servidor revisa la disponibilidad real **dentro de la misma transacción**: libera el horario viejo y ocupa el nuevo
  de forma atómica. Si el nuevo horario no está libre, **la reserva original queda exactamente igual**.
- Solo se puede cambiar la fecha y la hora. Para cambiar de **servicio** o de vehículo se cancela y se reserva de nuevo.
- Pasado el plazo (o entre 11:00 p.m. y 6:00 a.m.), la página muestra el botón de WhatsApp y el cambio se gestiona con el dueño.
- El cliente recibe un correo con el nuevo horario y el dueño recibe un aviso inmediato.

## 2. Cancelaciones → automáticas, sin autorización del dueño

- El cliente cancela por su cuenta hasta **1 hora antes**. El horario queda libre al instante para otros clientes.
- No requiere autorización del dueño; el dueño recibe un correo de aviso por cada cancelación.
- Dentro de la última hora: se cancela por WhatsApp. El dueño puede cancelar una cita acordada por WhatsApp desde el
  panel (`POST /api/admin/reservas/cancelar`), y el cliente recibe el correo de cancelación.
- Repetir una cancelación (por una respuesta perdida) es inofensivo: devuelve "cancelada" sin repetir correos.

## 3. Conservación de datos y limpieza semanal (política definitiva)

Referencia: **semanas de lunes a domingo**, hora de `America/Puerto_Rico`. La limpieza automática corre **los domingos a las 11:59 p. m.**
(`CLEANUP_CRON`, `59 23 * * 0`). Una reserva se elimina únicamente cuando **su semana ya terminó**:

| Reservas | Qué pasa |
|---|---|
| De semanas **futuras** (aunque se hayan hecho meses antes) | **Se conservan** hasta que llegue y termine su semana |
| De la semana **actual** | **Se conservan** hasta que la semana finalice |
| De semanas **anteriores ya finalizadas** (realizadas, "no se presentó", canceladas) | **Se eliminan** (todas bajo la misma regla) |
| Confirmadas de hoy o de fechas futuras | **Nunca se eliminan** (la regla está en cada consulta SQL) |

**Fecha de corte** (se elimina todo lo anterior a ella; siempre es un lunes y nunca pasa de mañana):
- Domingo, **ya cerrada la jornada** (desde las 5:00 p. m.): la semana en curso terminó → corte = lunes siguiente. Es el caso de la ejecución de las 11:59 p. m.
- Cualquier otro momento (ejecución manual, recuperación tras un apagón): corte = lunes de la semana en curso.

*Ejemplo:* hoy es viernes 30/oct; el cliente reserva para el jueves 5/nov. El domingo 1/nov a las 11:59 p. m. el corte es el lunes 2/nov: se elimina
la semana 26/oct–1/nov y las anteriores, pero la reserva del 5/nov **se conserva**. Recién el domingo 8/nov a las 11:59 p. m. (corte lunes 9/nov) se elimina.

**Qué se elimina exactamente:** las filas de `reservas` (junto con sus casilleros, su historial de eventos y los correos *ya resueltos* ligados a ellas) cuyo
`fecha < corte` **y** `fecha <= hoy` y cuyo estado es realizada / no se presentó / cancelada. Las confirmadas vencidas (fecha anterior al corte, nunca marcadas)
primero se marcan como realizadas y luego se eliminan con las demás. Antes de borrar, se sobrescriben los datos propios de la cita (correo, lugar, modelo).
**Qué NO se toca:** clientes generales (`clientes`), servicios y precios, configuración (`configuracion`), calendario y festivos (`calendario_dias`), historial de
limpiezas, auditoría reciente, credenciales (viven en variables de entorno) ni correos *pendientes* (si su reserva se borra, el correo queda sin enlace pero no se pierde).
También se depuran los casilleros pasados, las claves de idempotencia (7 días), los correos enviados/fallidos (30 días), el registro de tareas (180 días) y la auditoría (365 días).

**Controles de seguridad antes de borrar** (cualquiera que falle → no se borra nada):
1. *Autocomprobación del plan*: el corte debe ser lunes, no pasar de mañana, y ninguna candidata puede tener fecha ≥ corte o futura.
2. *Doble guarda en SQL*: cada `UPDATE`/`DELETE` repite `fecha < corte AND fecha <= hoy AND estado …`; un error de cálculo no basta para borrar una reserva futura.
3. *Todo en una transacción*: el plan se recalcula dentro de ella, y si lo borrado no coincide con lo planeado, se revierte todo.
4. *Reloj sospechoso* (solo automática): si pasaron más de 14 días sin ninguna actividad registrada, se aborta y avisa (un reloj adelantado haría ver como pasado lo futuro).
5. *Tope de borrado* (solo automática): si propone eliminar más de `CLEANUP_MAX_DELETE` (500) reservas, se aborta y avisa.
6. *Confirmación explícita* (manual): se ejecuta solo con el código que devolvió la simulación; si los datos cambiaron desde entonces, hay que simular de nuevo.
7. *Idempotencia*: una sola ejecución por semana (clave = fecha de corte); ejecutarla otra vez no encuentra nada que borrar. Un "repaso" cada 10 min y el disparador externo la recuperan si el servidor estaba apagado el domingo.
8. *Interruptor*: el administrador puede desactivar la limpieza automática (la manual sigue disponible). Todo queda en el **historial** (`limpieza_ejecuciones`) con resultado y detalle.

**Relación reservas ↔ clientes:** `clientes` guarda una fila por persona (huella del teléfono; nombre, teléfono y correo cifrados). Cada reserva apunta a su cliente con
`ON DELETE RESTRICT`: borrar reservas nunca borra clientes, y no se puede borrar un cliente que aún tiene reservas. Los datos propios de cada cita (correo de esa cita, lugar, modelo) viven en la reserva y desaparecen con ella.

> El respaldo de la base de datos contiene datos personales cifrados; se conserva `BACKUP_KEEP_DAYS` días (14) y debe protegerse como la base de datos.

## 4. Otras reglas fijadas

- **Zona horaria única: `America/Puerto_Rico`** (UTC-4, `shared/catalog.js → BUSINESS.timezone`). Reglas, plazos, correos y tareas usan esa zona, no la del servidor.
- **Horario:** 8:00 a.m. – 5:00 p.m. Un carro a la vez. **Días de operación:** por defecto miércoles a domingo, pero es una configuración (panel → Calendario): se pueden cambiar los días de la semana y agregar **festivos, cierres y aperturas excepcionales**. Cerrar un día que ya tiene citas no las cancela (el panel avisa cuántas hay).
- **Duración vs. bloqueo:** el Servicio #1 dura 1 h 30 y bloquea 2 h; el Servicio #2 dura 2 h 30 y bloquea 3 h (tiempo de
  traslado y preparación). La hora de fin que ve el cliente es la de la duración (8:00 → 10:30), pero la agenda queda
  ocupada hasta las 11:00. Para bloquear solo la duración, iguala `bloqueMin` a `duracionMin` en `shared/catalog.js`.
- **Última hora de inicio:** el servicio debe terminar antes de las 5:00 p.m. → Exterior hasta 3:30 p.m., Completo hasta 2:30 p.m.
- **Se reserva desde el día siguiente** y hasta 60 días. El mismo día se atiende por WhatsApp.
- **Cierre de agenda:** de 11:00 p.m. a 6:00 a.m. no se crean, cambian ni cancelan citas por internet.
- **Límite por teléfono:** máximo 3 reservas futuras activas (`MAX_ACTIVE_PER_PHONE`), para que nadie acapare la agenda.
- **Día agotado:** la API devuelve `agotado: true` y el botón de WhatsApp; **no existe forma de reservar ese día desde la
  página ni desde la API**. Lo gestiona el dueño.
- **Resumen del propietario** (`oramasdetailing@gmail.com`): a las 11:00 p. m. (Puerto Rico), solo si el día siguiente es laborable según el calendario configurado. Lista las reservas *confirmadas* de **ese día**, ordenadas por hora, leídas de la base de datos al generar el correo **y otra vez justo antes de enviarlo** (una reserva cancelada o movida no sale con datos viejos). Sin reservas, se envía un resumen que lo dice. No se envía dos veces (clave por fecha) y el resultado queda registrado en `job_runs` y en el historial de correos.
- **Todos los precios son "desde"** (Auto $25/$35, SUV $35/$45, Pickup $45/$50).
