# Despliegue, configuración de producción y recuperación ante fallos

## 0. Estado real del despliegue

**Desplegada (30/oct/2026) en Oracle Cloud Always Free**, región US East (Ashburn), máquina `orama` (VM.Standard.E2.1.Micro, Ubuntu 24.04, IP pública reservada `150.136.0.86`), con Caddy (HTTPS automático) y SQLite en `/var/lib/orama`.
Direcciones: **https://oramas-detailing.duckdns.org** (subdominio gratuito de DuckDNS) y `https://150-136-0-86.sslip.io` (sigue activa para los enlaces ya enviados).
Verificado en producción: carga del sitio, certificado, `/api/salud` y `/api/listo`, reserva real de prueba con correo de confirmación recibido y enlaces `https://` funcionando (la reserva de prueba se eliminó después). **No verificado:** el `Dockerfile` y `fly.toml` (no se usan en este despliegue). Guía seguida: [DESPLIEGUE-ORACLE.md](DESPLIEGUE-ORACLE.md). Decisión de proveedor y costos: [INFRAESTRUCTURA.md](INFRAESTRUCTURA.md).

## 1. Arquitectura de despliegue (y por qué no se separa más)

```
 Navegador ──HTTPS──► [ Proxy (Caddy / el de Fly) ] ──► Node (un proceso)
                                                         ├─ sirve la página compilada (dist/)
                                                         ├─ API /api/*  (Express)
                                                         ├─ tareas programadas (node-cron, hora de Puerto Rico)
                                                         ├─ cola de correos → Gmail (SMTP)
                                                         └─ SQLite en un volumen persistente (/data)
 Cron externo (GitHub Actions) ──POST /api/internal/tareas/*──► red de seguridad idempotente
```

- **Un solo proceso y una sola máquina**: SQLite es un archivo; dos máquinas no pueden compartirlo. Para ~1.000 clientes y decenas de reservas al día, un proceso sobra
  (ver las pruebas de carga). Separar frontend, backend, base de datos, correos y tareas en servicios distintos **añadiría costo, latencia y puntos de fallo sin beneficio** a esta escala.
- **Frontend estático** (`dist/`) podría ir a una CDN gratuita (Cloudflare Pages, etc.), pero entonces habría que configurar CORS y dos orígenes, y el sitio dependería de dos proveedores. Se sirve desde el mismo proceso (mismo origen, sin CORS). Si algún día hay mucho tráfico de lectura, se puede mover sin cambiar el código (`CORS_ORIGINS`).
- **Correos**: Gmail SMTP desde el mismo proceso, con cola (outbox) en la base de datos: un fallo de Gmail nunca pierde ni duplica reservas.
- **Tareas programadas**: dentro del proceso (`node-cron`, zona `America/Puerto_Rico`) **y** una red de seguridad externa (sección 5), porque un proceso que se duerme o reinicia no puede cumplir un cron.

## 2. Variables de entorno

Se cargan en el **gestor de secretos del proveedor** (`fly secrets set …`, `/etc/orama/orama.env`). Nunca en el repositorio. Plantilla comentada: [`.env.example`](../.env.example).

| Variable | Obligatoria | Qué es / cómo se obtiene |
|---|---|---|
| `NODE_ENV=production` | sí | Activa HSTS, exige https y clave de cifrado. |
| `DATA_ENCRYPTION_KEY` | **sí** | Clave AES-256 (`npm run gen:key`). **Guárdala aparte y con copia**: sin ella los datos personales cifrados no se pueden leer. |
| `PUBLIC_BASE_URL` | **sí** | `https://tu-dominio` (va en los enlaces de los correos). |
| `GMAIL_USER` + `GMAIL_APP_PASSWORD` | para enviar correos | Cuenta Gmail con verificación en 2 pasos y contraseña de aplicación (ver [OPERACION.md](OPERACION.md) §3). **Falta aportarla**: sin ella las reservas funcionan y los correos esperan en cola. |
| `OWNER_EMAIL` | ya definida | `oramasdetailing@gmail.com` (valor por defecto). |
| `ADMIN_TOKEN_SECRET` | **opcional** | Solo si algún día quieres usar la API de administración (no hay panel web). Sin ella `/api/admin/*` no existe (404). `npm run gen:admin-token`. |
| `JOBS_TRIGGER_SECRET` | recomendada | `npm run gen:admin-token`. Para el disparador externo de tareas. |
| `WHATSAPP_NUMBER` | ya definida | `17876625851` (el que dio el dueño; ya existe en el proyecto). |
| `TRUST_PROXY=1` | sí (detrás de proxy) | Para que los límites de uso vean la IP real del cliente. |
| `DATABASE_PATH`, `BACKUP_DIR` | sí | En el volumen persistente (`/data/orama.db`, `/data/backups`). |
| `PORT`, `HOST` | sí | `8080`, `0.0.0.0` en contenedor; `127.0.0.1` detrás de Caddy. |

Valores que **no** se pueden poner en producción: `RATE_LIMITS_ENABLED=false` (el servidor se niega a arrancar); `PUBLIC_BASE_URL` sin https; secretos cortos o repetitivos (se validan al arrancar).

## 3. Base de datos y migraciones

SQLite (`node:sqlite`, modo WAL, `synchronous=FULL`, llaves foráneas activas). Las migraciones (`server/db/migrations/*.sql`) **se aplican solas al arrancar**:
cada una en su transacción, con checksum (si alguien edita una ya aplicada, el arranque se detiene) y **copia de seguridad automática antes de migrar** (`pre-migracion-*.db` en `BACKUP_DIR`).
La migración 002 convierte los datos existentes (agrupa las personas en `clientes`) sin perder reservas. Verificado con pruebas automáticas.

## 4. Despliegue paso a paso

### Opción A · Fly.io (archivos listos: `Dockerfile`, `fly.toml`)
```bash
fly launch --no-deploy --copy-config          # usa fly.toml; elige un nombre de app libre
fly volumes create orama_data --size 1 --region mia
fly secrets set DATA_ENCRYPTION_KEY="$(node scripts/gen-key.mjs 2>/dev/null)" PUBLIC_BASE_URL="https://tu-dominio"
fly secrets set ADMIN_TOKEN_SECRET="$(node scripts/gen-admin-token.mjs 2>/dev/null)" JOBS_TRIGGER_SECRET="$(node scripts/gen-admin-token.mjs 2>/dev/null)"
fly secrets set GMAIL_USER="cuenta@gmail.com" GMAIL_APP_PASSWORD="…"      # cuando la tengas
fly deploy
```
Apunta el dominio con `fly certs add tu-dominio`. **Una sola máquina** (`fly scale count 1`) y sin auto-apagado (ya está en `fly.toml`).

### Opción A2 · Oracle Cloud gratis (elegida por el dueño)
Guía completa y script: [DESPLIEGUE-ORACLE.md](DESPLIEGUE-ORACLE.md) (`deploy/oracle-setup.sh`).

### Opción B · VPS con systemd + Caddy (`deploy/orama.service`, `deploy/Caddyfile`)
```bash
git clone <repo> /opt/orama && cd /opt/orama && npm ci && npm run build && npm prune --omit=dev
sudo install -d -o orama /var/lib/orama && sudo install -m 600 /dev/null /etc/orama/orama.env   # pega las variables ahí
sudo cp deploy/orama.service /etc/systemd/system/ && sudo systemctl enable --now orama
```
Caddy da HTTPS automático. Ajusta `DATABASE_PATH=/var/lib/orama/orama.db` y `BACKUP_DIR=/var/lib/orama/backups`.

### Nuevas versiones
1. `npm test` y `npm run build` en limpio. 2. `fly deploy` (o `git pull && npm ci && npm run build && systemctl restart orama`).
3. Al arrancar se aplican migraciones nuevas con copia previa. 4. Comprobar `GET /api/salud`, `GET /api/listo` y el panel (`Estado`).
**Revertir:** volver a la versión anterior del código; si una migración ya se aplicó, restaurar el `pre-migracion-*.db` correspondiente (sección 7).

## 5. Tareas programadas fiables

| Tarea | Cuándo (Puerto Rico) | Quién la dispara |
|---|---|---|
| Resumen del propietario | 11:00 p. m. diario (si el día siguiente es laborable) | cron interno + repaso cada 10 min (hasta el mediodía) + GitHub Actions + `POST /api/internal/tareas/resumen` |
| Limpieza semanal | domingo 11:59 p. m. | cron interno + repaso cada 10 min + Actions (lunes 00:15) |
| Envío de correos | cada 30 s y al confirmar una reserva | proceso interno + `…/tareas/correos` |
| Respaldo | 2:00 a. m. | cron interno + `…/tareas/respaldo` |

Todas son **idempotentes** (`job_runs`: una sola ejecución por clave; el correo del resumen además tiene clave única por fecha). Si el servidor estuvo apagado a la hora exacta,
el repaso las ejecuta al volver; si el proceso está dormido, la llamada externa lo despierta y lo pone al día. Para activar la red externa: crea en GitHub los secretos `APP_URL` y
`JOBS_TRIGGER_SECRET` (el flujo `.github/workflows/tareas.yml` ya está en el repositorio; GitHub puede retrasar los cron y los pausa tras 60 días sin actividad en el repo — es solo un respaldo, no el mecanismo principal).

## 6. Health checks, logs y monitoreo

- `GET /api/salud` (proceso vivo) · `GET /api/listo` (`ok`/`degradado`, 503 si la BD cae) · `GET /api/admin/estado` (detalle) · `GET /api/admin/metricas` (latencias, memoria, CPU, transacciones).
- Logs: JSON por línea en stdout (`fly logs`, `journalctl -u orama`). Nunca contienen contraseñas, tokens ni datos personales. Eventos críticos para alertar: `limpieza.abortada`, `limpieza.error`, `correo.gmail_credenciales_rechazadas`, `correo.fallido`, `tarea.fallida`, `reserva.pico_sospechoso`, `limpieza.integridad_fallida`.
- Monitoreo externo gratuito: un chequeo HTTP a `/api/listo` cada 5 min (UptimeRobot, Better Stack, etc.) con aviso al correo del propietario.

## 7. Procedimientos de recuperación

| Falla | Qué hacer |
|---|---|
| **El proceso se cae / reinicia** | El supervisor (Fly, systemd) lo levanta solo. Al volver: migraciones (si hay), repaso de tareas, envío de correos pendientes. No se pierde nada: las reservas están en SQLite con `synchronous=FULL` y los correos en la cola. |
| **Base de datos dañada o borrada** | 1) Detener el servicio. 2) Copiar el respaldo más reciente de `BACKUP_DIR` (o del almacenamiento externo) sobre `DATABASE_PATH` y borrar `-wal`/`-shm`. 3) Misma `DATA_ENCRYPTION_KEY`. 4) Arrancar: el "canario" confirma que la clave corresponde. Se pierde, como máximo, lo ocurrido desde el último respaldo (diario) — por eso conviene copiar `BACKUP_DIR` **fuera del servidor**. |
| **Se perdió `DATA_ENCRYPTION_KEY`** | Los nombres, teléfonos, correos y lugares guardados **no se pueden recuperar**. Las reservas futuras tendrían que reconstruirse con los clientes (WhatsApp). Por eso: guardar la clave en un gestor de contraseñas **y** en una copia aparte. |
| **Gmail rechaza credenciales / cuota** | El envío se pausa solo (15 min / 1 h) sin gastar intentos. Regenerar la contraseña de aplicación, actualizar el secreto, reiniciar. Reenviar fallidos: `npm run job:requeue`. |
| **Se filtró un secreto del administrador** | `npm run gen:admin-token`; poner el nuevo en `ADMIN_TOKEN_SECRET` y el viejo en `ADMIN_TOKEN_SECRET_PREVIOUS`; reiniciar; cuando todo funcione, quitar el anterior. Revisar `Auditoría` en el panel. |
| **Limpieza abortada** | Es una protección (reloj sospechoso o demasiadas reservas): revisar `Limpieza → Historial`, simular, y ejecutar la manual si todo es correcto. |
| **Disco lleno** | La API responde 503 en escrituras (no corrompe datos). Borrar respaldos viejos o ampliar el volumen (`fly volumes extend`). |
| **Reloj del servidor desfasado** | Sincronizar NTP; revisar `limpieza.abortada`. Las reglas de horario usan el reloj del servidor. |
| **Despliegue defectuoso** | Volver a la versión anterior; restaurar `pre-migracion-*.db` solo si la migración nueva ya se aplicó. |
