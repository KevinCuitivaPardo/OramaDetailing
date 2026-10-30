# API de reservas

Base: `/api` (mismo origen que la página; en desarrollo Vite reenvía `/api` al servidor en el puerto 3000).
Todo es JSON. **Los datos sensibles (código de reserva, teléfono, token) viajan en el cuerpo `POST`, nunca en la URL.**
Errores: `{ "error": { "code", "message", "requestId", "campos"?, "whatsapp"? } }` (mensajes en español, seguros de mostrar).
Toda respuesta lleva `X-Request-Id`; la API nunca se guarda en caché (`Cache-Control: no-store`).

## Públicos

| Método y ruta | Qué hace |
|---|---|
| `GET /api/salud` | El proceso responde. |
| `GET /api/listo` | Solo el estado general: `{ "estado": "ok" \| "degradado" }` (503 `caido` si la base de datos no responde). Sin detalles de configuración. |
| `GET /api/config` | Número de WhatsApp, teléfono, ventana de fechas reservables, si la agenda está cerrada y si el correo está activo. |
| `GET /api/disponibilidad?servicio=1&fecha=2026-10-31` | Horas libres reales de un día para un servicio. Si el día está agotado: `agotado: true`, `horas: []` y `whatsapp.url`. |
| `GET /api/disponibilidad/mes?servicio=1&mes=2026-10` | Estado de cada día del mes: `disponible`, `agotado`, `cerrado`, `fuera_de_rango`. |
| `POST /api/reservas` | Crea una reserva (ver abajo). Requiere `Idempotency-Key`. |
| `POST /api/reservas/consultar` | Consulta una reserva. |
| `POST /api/reservas/disponibilidad` | Horas libres para **cambiar** una cita propia (cuenta como libre su bloque actual). |
| `POST /api/reservas/cambiar` | **Pide** cambiar fecha/hora (hasta 1 h antes). Responde `202 pendiente_confirmacion` y envía un correo; la cita no cambia todavía. |
| `POST /api/reservas/cancelar` | **Pide** cancelar (hasta 1 h antes). Responde `202` y envía un correo; la cita sigue activa hasta confirmar. |
| `POST /api/reservas/accion` `{codigo, token}` | Muestra qué hará el enlace del correo, sin ejecutarlo. |
| `POST /api/reservas/confirmar` `{codigo, token}` | Ejecuta la cancelación o el cambio (enlace de un solo uso, vence en 2 h). Errores: `ENLACE_INVALIDO` 404, `ENLACE_VENCIDO` 410, `ENLACE_USADO` 409. |

### `POST /api/reservas`

Cabecera obligatoria: `Idempotency-Key: <16–64 caracteres: letras, números, _ o ->` (un identificador nuevo por intento de envío).
Un reintento con la misma clave y los mismos datos devuelve la misma reserva (`200` + `Idempotent-Replayed: true`); con datos distintos → `409 IDEMPOTENCY_KEY_REUTILIZADA`.

```json
{ "servicioId": 2, "vehiculo": "suv", "fecha": "2026-10-31", "hora": "08:00",
  "nombre": "Ana Pérez", "telefono": "787-555-0101", "correo": "ana@example.com",
  "lugar": "Urb. Las Flores, Aguada", "modelo": "Toyota RAV4" }
```
`modelo` es opcional. Cualquier otro campo se rechaza (`400`). La respuesta `201`:
```json
{ "reserva": { "codigo": "OR-7K3P9X", "estado": "confirmada", "fecha": "2026-10-31", "inicio": "8:00 a.m.", "fin": "10:30 a.m.",
               "precio": { "texto": "desde $45" }, "telefono": "***-***-0101", "correo": "a**@example.com", "…": "…" },
  "tokenGestion": "…se entrega UNA sola vez…",
  "correo": { "estado": "en_cola" } }
```
`correo.estado` es `en_cola` (se enviará en segundos) o `sin_configurar` (Gmail aún no está listo). **Nunca** dice "enviado" por adelantado.

### Acceso a una reserva (consultar / cambiar / cancelar / disponibilidad)

Cuerpo: `{ "codigo": "OR-7K3P9X", "telefono": "787-555-0101" }` **o** `{ "codigo": "…", "token": "…" }` (el token del enlace del correo). Exactamente uno de los dos.
Cambiar añade `"fecha"` y `"hora"`. Cualquier fallo de credenciales responde **el mismo `404 RESERVA_NO_ENCONTRADA`** (no se puede averiguar si un código existe).
La respuesta nunca incluye teléfono ni correo completos (van enmascarados).

### Códigos de error frecuentes

| Código | HTTP | Significado |
|---|---|---|
| `DATOS_INVALIDOS` | 400 | Validación de campos (`campos` indica cuáles). |
| `HORARIO_NO_DISPONIBLE` | 409 | Otro cliente se quedó con ese horario. |
| `FECHA_NO_PERMITIDA` | 422 | Hoy/pasado, lunes/martes, o más allá de 60 días. |
| `AGENDA_CERRADA` | 423 | Entre 11:00 p.m. y 6:00 a.m. |
| `FUERA_DE_PLAZO` | 403 | Falta menos de 1 hora (incluye `whatsapp`). |
| `RESERVA_NO_ENCONTRADA` | 404 | Código o credencial incorrectos. |
| `RESERVA_NO_ACTIVA` | 409 | Ya cancelada o realizada. |
| `LIMITE_DE_RESERVAS` | 409 | El teléfono ya tiene 3 reservas activas. |
| `DEMASIADAS_SOLICITUDES` | 429 | Límite de solicitudes (con `Retry-After`). |

## Panel del dueño (`Authorization: Bearer <ADMIN_TOKEN>`)

Si `ADMIN_TOKEN` no está configurado, estas rutas responden `404` (no existen). Sin CORS.

| Método y ruta | Qué hace |
|---|---|
| `GET /api/admin/agenda?fecha=2026-10-31` | Reservas confirmadas del día, ordenadas por hora, con los datos completos del cliente. |
| `POST /api/admin/reservas/cancelar` `{ "codigo": "OR-…" }` | Cancela una cita acordada por WhatsApp (libera el horario y avisa al cliente). |
| `GET /api/admin/correos` | Estado de la cola de correos y los fallidos (sin contenido ni destinatarios). |

Ejemplo: `curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:3000/api/admin/agenda?fecha=2026-10-31"`

- `GET /api/admin/estado` (Bearer `ADMIN_TOKEN`): correo y correo del dueño configurados, correos pendientes/fallidos, antigüedad del más viejo y última ejecución correcta del resumen, la limpieza y el respaldo.
- Código de error nuevo: `LIMITE_DE_CAMBIOS` (403): la cita ya se cambió `MAX_CHANGES_PER_BOOKING` veces por internet.

## Administración (Bearer `ADMIN_TOKEN_SECRET`)

Todas devuelven `401` sin el secreto correcto y `404` si el servidor no tiene `ADMIN_TOKEN_SECRET` configurado. Cada cambio queda en `auditoria_admin`.

| Ruta | Qué hace |
|---|---|
| `GET /api/admin/estado` | Estado general, Gmail y correo del propietario, cola, última ejecución de resumen/limpieza/respaldo. |
| `GET /api/admin/agenda?fecha=` | Reservas confirmadas de un día, con datos de contacto y si el día está abierto. |
| `POST /api/admin/reservas/cancelar` `{codigo}` | Cancela una cita (libera el horario y avisa al cliente). |
| `GET /api/admin/servicios` | Servicios y precios del catálogo (solo lectura). |
| `GET /api/admin/calendario?desde=&hasta=` | Días de operación, excepciones y estado de cada fecha. |
| `PUT /api/admin/calendario/dias-operacion` `{dias:[0..6]}` | Días de la semana en que se trabaja (0 = domingo). |
| `PUT /api/admin/calendario/excepciones` `{fecha,tipo,motivo?}` | `festivo` / `cerrado` / `abierto` para una fecha. Devuelve cuántas reservas confirmadas ya tiene. |
| `DELETE /api/admin/calendario/excepciones/:fecha` | Quita la excepción. |
| `GET /api/admin/limpieza` | Interruptor, última ejecución, historial y corte que aplicaría hoy. |
| `PUT /api/admin/limpieza/habilitada` `{habilitada}` | Activa o desactiva la limpieza **automática**. |
| `POST /api/admin/limpieza/simulacion` | Qué se eliminaría (conteos por estado, rango, muestra de códigos) + código de confirmación. No borra nada. |
| `POST /api/admin/limpieza/ejecutar` `{confirmToken}` | Ejecuta la limpieza manual con el código de la simulación. |
| `POST /api/admin/tareas/{resumen\|correos\|respaldo}` | Dispara una tarea ahora (idempotente). |
| `GET /api/admin/correos` | Historial de notificaciones (sin destinatarios ni contenido). |
| `GET /api/admin/auditoria` · `GET /api/admin/metricas` | Registro de acciones · métricas del proceso (latencias, memoria, CPU, transacciones). |

## Disparador externo de tareas (Bearer `JOBS_TRIGGER_SECRET`)

`POST /api/internal/tareas/{resumen|limpieza|correos|respaldo}`: red de seguridad para un cron externo. Idempotente; `404` si el secreto no está configurado; el secreto del administrador **no** sirve aquí.
