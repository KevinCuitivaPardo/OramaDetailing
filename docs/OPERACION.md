# Operación: configuración, correos, tareas y despliegue

## 1. Puesta en marcha

```bash
npm install
cp .env.example .env        # y completa los valores (ver abajo)
npm run gen:key             # genera DATA_ENCRYPTION_KEY → pégala en .env
npm run dev                 # desarrollo: API en :3000 + página en :5173
npm test                    # suite completa de pruebas automáticas (ver docs/SEGURIDAD.md y docs/carga)
npm run build && npm start  # producción: un solo proceso sirve la página y la API
```
Requiere **Node ≥ 22.13** (usa el módulo SQLite incluido en Node; imprime un aviso "experimental" que es normal).

## 2. Variables de entorno

Todas están documentadas en [`.env.example`](../.env.example). Las que **faltan por aportar** (el sistema no las inventa):

| Variable | Qué es | Sin ella… |
|---|---|---|
| `GMAIL_USER` + `GMAIL_APP_PASSWORD` | Cuenta de Gmail que envía los correos (contraseña de aplicación) | Las reservas funcionan, pero **los correos quedan en cola** y la página avisa que no se pueden enviar |
| `OWNER_EMAIL` | Correo del propietario (resumen diario y avisos). **Ya definido: `oramasdetailing@gmail.com`** (valor por defecto) | Se usa el definido |
| `DATA_ENCRYPTION_KEY` | Clave que cifra teléfono, correo y lugar | **Obligatoria en producción** (el servidor no arranca sin ella). En desarrollo usa una clave de pruebas y lo advierte |
| `PUBLIC_BASE_URL` | URL pública del sitio (enlaces de los correos) | Los enlaces apuntan a `http://localhost:5173` |
| `ADMIN_TOKEN_SECRET` | Secreto del administrador (≥ 43 caracteres aleatorios): `npm run gen:admin-token` | El panel y `/api/admin/*` quedan deshabilitados (404) |
| `JOBS_TRIGGER_SECRET` | Secreto del disparador externo de tareas (opcional, recomendado) | La ruta `/api/internal/tareas/*` no existe (404) |
| `WHATSAPP_NUMBER` | Número de WhatsApp con código de país | Usa `17876625851` (el que dio el dueño) |

El resto (`CHANGE_CUTOFF_MINUTES`, `MAX_ACTIVE_PER_PHONE`, `CLEANUP_MAX_DELETE`, horarios de las tareas…) tiene un valor por defecto razonable. La zona horaria no es una variable: está en `shared/catalog.js` (`America/Puerto_Rico`).

## 3. Configurar Gmail (envío de correos)

1. En la cuenta de Google que enviará los correos activa la **verificación en 2 pasos**.
2. Entra a <https://myaccount.google.com/apppasswords>, crea una contraseña de aplicación (nombre: "Orama reservas") y copia los 16 caracteres.
3. En `.env` (o en el gestor de secretos del hosting):
   ```
   GMAIL_USER=tucuenta@gmail.com
   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
   GMAIL_FROM_NAME=Orama’s Detailing
   ```
4. Reinicia el servidor. `GET /api/listo` debe mostrar `"correo": "configurado"`. Los correos que estaban en cola se envían solos.
5. Prueba real: haz una reserva con tu propio correo y revisa que llegue (y que no caiga en spam).

Notas: Gmail limita el envío (≈ 500 correos/día en cuentas personales; cada reserva genera 1–2). Si la contraseña se revoca o cambia,
el sistema **pausa el envío 15 minutos** y registra `correo.gmail_credenciales_rechazadas` sin gastar los intentos de los correos pendientes.
Si Gmail responde con cuota diaria superada o bloqueo temporal (`correo.gmail_cuota_o_limite`), pausa **1 hora** (tampoco gasta intentos). Un correo que no salió tras 8 intentos pasa a *fallido*: corrige la causa y vuelve a encolarlos con `npm run job:requeue`.
Alternativa sin contraseña de aplicación: OAuth2 (`GMAIL_OAUTH_*`).

## 4. Correo del propietario

Destinatario: **`oramasdetailing@gmail.com`** (ya configurado por defecto; se puede cambiar con `OWNER_EMAIL`). Recibe: (a) cada noche a las 11:00 p. m. (Puerto Rico) el resumen del día siguiente, **solo si ese día es laborable** según el calendario del panel; (b) un aviso inmediato cuando un cliente cambia o cancela.
El resumen se arma con la base de datos al encolarse y otra vez justo antes de enviarse. Si Gmail no está configurado, queda en cola (`sin_configurar`) y sale solo cuando se configure.

## 5. WhatsApp

El número sale de `WHATSAPP_NUMBER` (solo dígitos con código de país, p. ej. `17876625851`). Se usa en: el aviso de "día agotado", el aviso de
"fuera de plazo", los correos y el botón de guardar la reserva. Cambiarlo no requiere tocar el código.

## 6. Tareas programadas (hora de Puerto Rico, dentro del mismo proceso + red de seguridad externa; ver [DESPLIEGUE.md](DESPLIEGUE.md) §5)

| Tarea | Cuándo | Qué hace | A mano |
|---|---|---|---|
| Resumen del propietario | 11:00 p. m. (`OWNER_SUMMARY_CRON`) + repaso cada 10 min (hasta el mediodía) | Si el día siguiente es laborable (calendario), encola el correo con sus reservas confirmadas ordenadas por hora; el texto se vuelve a leer de la BD al enviar | `npm run job:summary [AAAA-MM-DD]` |
| Envío de correos | cada 30 s (`OUTBOX_INTERVAL_SECONDS`) y al confirmar una reserva | Envía la cola; reintenta con espera creciente (1 min → 12 h, máx. 8 intentos) | `npm run job:outbox` |
| Limpieza semanal | domingos 11:59 p. m. (`CLEANUP_CRON`) + repaso cada 10 min + Actions | Elimina reservas de semanas (lunes–domingo) ya terminadas; panel con simulación, confirmación e historial ([POLITICAS.md](POLITICAS.md) §3) | `npm run job:cleanup [-- --dry-run]` |
| Respaldo | 2:00 a.m. (`BACKUP_CRON`) | Copia consistente en caliente a `BACKUP_DIR`; verifica la copia y borra las de más de `BACKUP_KEEP_DAYS` días | `npm run backup` |

- Son **idempotentes** (`job_runs` con clave única): si el cron se dispara dos veces o el servidor se reinicia, no se duplica nada.
- Si el servidor estuvo apagado a las 11:00 p. m., el "repaso" genera el resumen que faltaba al volver (hasta el mediodía del día a resumir); lo mismo con la limpieza del domingo.
- Cada tarea tiene su propio manejo de errores: una falla se registra (`tarea.fallida`) y no tumba al servidor ni a las demás.
- Para ejecutar varios procesos, deja `JOBS_ENABLED=true` en **uno solo** (o confía en `job_runs`, que evita duplicados).

## 7. Registros (logs) y monitoreo

JSON por línea en la salida estándar. Eventos clave: `reserva.creada`, `reserva.confirmada`, `reserva.intento_duplicado`, `reserva.cambiada`,
`reserva.cancelada`, `reserva.acceso_denegado`, `correo.encolado`, `correo.enviado`, `correo.error_envio`, `correo.fallido`,
`correo.gmail_credenciales_rechazadas`, `tarea.iniciada/terminada/fallida`, `limpieza.completada`. **Nunca** se registran contraseñas, tokens ni
datos personales (el logger los oculta por nombre de campo; hay una prueba automática). Chequeos: `GET /api/salud` (vivo), `GET /api/listo` (estado general, público y mínimo) y `GET /api/admin/estado` (detalle con `Authorization: Bearer ADMIN_TOKEN`: correo configurado, cola, fallidos, última ejecución de cada tarea). Con TRUST_PROXY=0 en producción el servidor lo advierte al arrancar.

## 8. Despliegue

- La base de datos es un archivo SQLite (`DATABASE_PATH`): **necesita un disco persistente** (VPS, Fly.io con volumen, Railway con volumen, un servidor propio). No sirve en hosting "serverless" sin disco.
- Ejecuta **un solo proceso** de la API (los límites de solicitudes están en memoria). Si algún día se necesitan varias instancias, hay que pasar a PostgreSQL y a un almacén compartido para los límites; el acceso a datos está aislado en `server/repositories` para facilitar el cambio.
- Pon HTTPS por delante (Nginx/Caddy o el proxy del hosting), `NODE_ENV=production` y `TRUST_PROXY=1` (nº de proxies). Un supervisor (systemd, pm2, NSSM, el propio hosting) debe reiniciar el proceso si cae.
- **Respaldos:** la tarea diaria guarda copias en `BACKUP_DIR` (`VACUUM INTO`, seguras en caliente) y antes de cada migración se crea `pre-migracion-*.db`. **Copia esa carpeta FUERA del servidor** (otro disco o almacenamiento externo): un respaldo en el mismo disco no protege contra la pérdida del disco. Contienen datos personales cifrados: guárdalos protegidos, **junto con la `DATA_ENCRYPTION_KEY` guardada aparte**.
- **Restaurar:** detén el servidor, copia el respaldo elegido sobre `DATABASE_PATH` (borra los archivos `-wal` y `-shm` de la base dañada), vuelve a poner la misma `DATA_ENCRYPTION_KEY` y arranca. Al iniciar, el servidor verifica la clave con un "canario": si no coincide, se niega a arrancar con un mensaje claro en vez de fallar en cada consulta.
- **Reloj:** el servidor debe tener la hora sincronizada (NTP); las reglas de horario y plazos dependen de ella.
- Perder `DATA_ENCRYPTION_KEY` = perder la capacidad de leer nombres, teléfonos, correos y lugares. Guárdala en un gestor de secretos.


## 9. Panel del propietario (`/admin.html`)

**Entrada:** la dirección `…/admin.html` (no hay enlaces desde el sitio) y una contraseña propia. La contraseña se define en el servidor, una vez:
`cd /opt/orama && sudo -u orama node --no-warnings --env-file=/etc/orama/orama.env scripts/admin-password.mjs --generar` (imprime una contraseña aleatoria que se muestra una sola vez). Luego el propietario la cambia desde **Cuenta** (mínimo 12 caracteres; cambiarla cierra las demás sesiones). Si se olvida, se repite el comando en el servidor. Se guarda solo como hash (scrypt); la sesión dura 8 horas.

**Qué se puede hacer:**
- **Agenda:** calendario del mes (punto rojo = tiene citas; tachado = día cerrado). Al tocar un día: sus citas (se pueden cancelar; se avisa al cliente por correo), **"No trabajo este día"** (los clientes ya no pueden reservarlo; las citas existentes no se cancelan solas), y **"Horas bloqueadas"**: almuerzo, cita personal o salir temprano, para solo ese día, para todos los miércoles (por ejemplo) o para todos los días. Una cita no se ofrece si su tiempo ocupado (servicio + traslado) toca un bloqueo; los bloqueos no cancelan citas ya hechas.
- **Horarios:** qué días de la semana trabajas y a qué hora abres y cierras.
- **Cuenta:** cambiar la contraseña.
La limpieza semanal y los servicios no se manejan desde el panel (la limpieza corre sola cada domingo; los servicios se cambian en el código).

**Tiempo real:** cualquier cambio (una reserva, una cancelación, un día cerrado, un bloqueo) llega al instante a las páginas abiertas —el calendario de los clientes y el del propietario— mediante un flujo en vivo (`GET /api/eventos`, Server-Sent Events) que solo avisa "la disponibilidad cambió" y no lleva datos de nadie. Si la conexión se corta, la página se refresca sola cada 20 s. En Caddy la ruta `/api/eventos` va sin compresión ni acumulación (`deploy/Caddyfile`).
Los textos de la página pública (por ejemplo "Miércoles a domingo, 8:00 a. m. – 5:00 p. m.") son fijos: si el horario cambia de forma permanente, hay que editarlos.

**Automatizaciones:** además existe el secreto largo `ADMIN_TOKEN_SECRET` (opcional; `npm run gen:admin-token`, rotación con `ADMIN_TOKEN_SECRET_PREVIOUS`) para llamar a la API sin sesión. El propietario no lo necesita.
