-- Esquema inicial. Las restricciones (CHECK / UNIQUE / FK / triggers) son la última línea de defensa:
-- aunque el código tuviera un error, la base de datos NO acepta datos inválidos ni horarios duplicados.
-- Las reglas de horario laboral (miércoles a domingo, 8:00–5:00) NO se fijan aquí a propósito: son configuración
-- del negocio (shared/catalog.js) y cambiarlas no debe exigir reconstruir tablas.

CREATE TABLE servicios (
  id            INTEGER PRIMARY KEY,
  codigo        TEXT    NOT NULL UNIQUE,
  nombre        TEXT    NOT NULL,
  duracion_min  INTEGER NOT NULL CHECK (duracion_min BETWEEN 30 AND 720 AND duracion_min % 30 = 0),
  bloque_min    INTEGER NOT NULL CHECK (bloque_min   BETWEEN 30 AND 720 AND bloque_min   % 30 = 0),
  activo        INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  CHECK (bloque_min >= duracion_min)
) STRICT;

CREATE TABLE precios (
  servicio_id INTEGER NOT NULL REFERENCES servicios(id) ON DELETE RESTRICT,
  vehiculo    TEXT    NOT NULL CHECK (vehiculo IN ('auto', 'suv', 'pickup')),
  monto       INTEGER NOT NULL CHECK (monto > 0),
  es_desde    INTEGER NOT NULL DEFAULT 1 CHECK (es_desde IN (0, 1)),
  PRIMARY KEY (servicio_id, vehiculo)
) STRICT, WITHOUT ROWID;

CREATE TABLE reservas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo          TEXT    NOT NULL UNIQUE CHECK (codigo GLOB 'OR-??????'),
  servicio_id     INTEGER NOT NULL REFERENCES servicios(id) ON DELETE RESTRICT,
  vehiculo        TEXT    NOT NULL CHECK (vehiculo IN ('auto', 'suv', 'pickup')),
  fecha           TEXT    NOT NULL CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(fecha) = fecha),
  inicio_min      INTEGER NOT NULL CHECK (inicio_min BETWEEN 0 AND 1410 AND inicio_min % 30 = 0),
  fin_min         INTEGER NOT NULL,                 -- inicio + duración: la hora de fin que ve el cliente
  bloque_fin_min  INTEGER NOT NULL CHECK (bloque_fin_min <= 1440 AND bloque_fin_min % 30 = 0), -- inicio + bloque: hasta cuándo queda ocupada la agenda
  estado          TEXT    NOT NULL DEFAULT 'confirmada'
                  CHECK (estado IN ('confirmada', 'cancelada', 'completada', 'no_llego')),
  -- Datos personales cifrados (AES-256-GCM). Se ponen en NULL al cancelar y al anonimizar.
  nombre_enc      TEXT,
  telefono_enc    TEXT,
  telefono_mac    TEXT,                             -- HMAC del teléfono: permite verificar "código + teléfono" sin descifrar
  correo_enc      TEXT,
  correo_mac      TEXT,                             -- HMAC del correo: para limitar reservas activas por dirección
  lugar_enc       TEXT,
  modelo_enc      TEXT,
  precio_monto    INTEGER NOT NULL CHECK (precio_monto > 0),
  precio_desde    INTEGER NOT NULL CHECK (precio_desde IN (0, 1)),
  token_hash      TEXT    NOT NULL,                 -- SHA-256 del token de gestión del correo
  idem_key        TEXT    UNIQUE,                   -- Idempotency-Key del cliente (se limpia a los 7 días)
  idem_hash       TEXT,
  cambios         INTEGER NOT NULL DEFAULT 0 CHECK (cambios >= 0),
  creada_en       TEXT    NOT NULL,
  actualizada_en  TEXT    NOT NULL,
  cancelada_en    TEXT,
  cancelada_por   TEXT    CHECK (cancelada_por IN ('cliente', 'dueno', 'sistema')),
  UNIQUE (id, fecha),                               -- permite que los casilleros se amarren a la fecha de SU reserva
  CHECK (fin_min > inicio_min AND bloque_fin_min >= fin_min),
  CHECK ((estado = 'cancelada') = (cancelada_en IS NOT NULL)),
  CHECK ((estado = 'cancelada') = (cancelada_por IS NOT NULL)),
  CHECK ((idem_key IS NULL) = (idem_hash IS NULL)),
  -- Una reserva confirmada SIEMPRE conserva los datos que el dueño necesita para atender al cliente
  CHECK (estado <> 'confirmada' OR (nombre_enc IS NOT NULL AND telefono_enc IS NOT NULL AND telefono_mac IS NOT NULL AND correo_enc IS NOT NULL AND lugar_enc IS NOT NULL))
) STRICT;

CREATE INDEX idx_reservas_agenda   ON reservas (fecha, inicio_min) WHERE estado = 'confirmada';
CREATE INDEX idx_reservas_estado_fecha ON reservas (estado, fecha);
CREATE INDEX idx_reservas_telefono ON reservas (telefono_mac, fecha) WHERE estado = 'confirmada';
CREATE INDEX idx_reservas_correo   ON reservas (correo_mac, fecha) WHERE estado = 'confirmada';
CREATE INDEX idx_reservas_idem     ON reservas (creada_en) WHERE idem_key IS NOT NULL;
CREATE INDEX idx_reservas_creada   ON reservas (creada_en);

-- Cada reserva confirmada ocupa un casillero por cada 30 minutos de su bloque.
-- PRIMARY KEY (fecha, slot) es el candado real contra reservas duplicadas o solapadas:
-- si dos clientes intentan el mismo horario, el segundo INSERT falla dentro de la base de datos.
-- La llave foránea compuesta obliga a que el casillero tenga la MISMA fecha que su reserva (se verifica al
-- confirmar la transacción, para poder mover una cita: primero se mueven los casilleros y luego la reserva).
CREATE TABLE reserva_slots (
  fecha      TEXT    NOT NULL,
  slot       INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 47),   -- 0 = 00:00, 16 = 8:00 a.m., ...
  reserva_id INTEGER NOT NULL,
  PRIMARY KEY (fecha, slot),
  FOREIGN KEY (reserva_id, fecha) REFERENCES reservas (id, fecha) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_slots_reserva ON reserva_slots (reserva_id);

-- Solo las reservas CONFIRMADAS retienen casilleros: al cancelarse, completarse o no presentarse, el horario se libera solo.
CREATE TRIGGER trg_reserva_libera_slots AFTER UPDATE OF estado ON reservas
WHEN NEW.estado <> 'confirmada'
BEGIN
  DELETE FROM reserva_slots WHERE reserva_id = NEW.id;
END;

-- Historial de lo que le pasó a cada reserva (sin datos personales)
CREATE TABLE reserva_eventos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  reserva_id INTEGER NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
  tipo       TEXT    NOT NULL CHECK (tipo IN ('creada', 'cambiada', 'cancelada', 'completada', 'no_llego')),
  actor      TEXT    NOT NULL CHECK (actor IN ('cliente', 'dueno', 'sistema')),
  detalle    TEXT,
  creado_en  TEXT    NOT NULL
) STRICT;

CREATE INDEX idx_eventos_reserva ON reserva_eventos (reserva_id);

-- Cola de correos (patrón outbox): se escribe en la MISMA transacción que la reserva,
-- y un trabajador la envía después. Así un fallo de Gmail nunca deja una reserva a medias.
CREATE TABLE outbox_correos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo             TEXT    NOT NULL CHECK (tipo IN ('confirmacion', 'cambio', 'cancelacion', 'resumen_dueno', 'aviso_dueno')),
  dedupe_key       TEXT    NOT NULL UNIQUE,         -- un mismo correo lógico no se encola dos veces
  reserva_id       INTEGER REFERENCES reservas(id) ON DELETE SET NULL,
  destinatario_enc TEXT    NOT NULL,                -- el destinatario es un dato personal: va cifrado
  destino_mac      TEXT,                            -- HMAC de la dirección: para limitar cuántos correos recibe una misma persona
  payload_enc      TEXT    NOT NULL,                -- datos para armar el correo (cifrados); se renderiza al enviar
  estado           TEXT    NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'enviando', 'enviado', 'fallido')),
  intentos         INTEGER NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  proximo_intento  TEXT    NOT NULL,
  bloqueado_hasta  TEXT,                            -- "lease" mientras un trabajador lo envía
  ultimo_error     TEXT,                            -- mensaje sanitizado, sin credenciales ni datos personales
  creado_en        TEXT    NOT NULL,
  enviado_en       TEXT,
  CHECK (estado <> 'enviando' OR bloqueado_hasta IS NOT NULL),
  CHECK (estado <> 'enviado'  OR enviado_en IS NOT NULL)
) STRICT;

CREATE INDEX idx_outbox_pendientes ON outbox_correos (estado, proximo_intento) WHERE estado IN ('pendiente', 'enviando');
CREATE INDEX idx_outbox_reserva    ON outbox_correos (reserva_id) WHERE reserva_id IS NOT NULL;
CREATE INDEX idx_outbox_limpieza   ON outbox_correos (estado, creado_en);
CREATE INDEX idx_outbox_destino    ON outbox_correos (destino_mac, creado_en) WHERE destino_mac IS NOT NULL;

-- Ejecuciones de tareas programadas: UNIQUE(job, run_key) las hace idempotentes
-- (si el cron se dispara dos veces o hay dos procesos, solo una ejecución cuenta)
CREATE TABLE job_runs (
  job        TEXT NOT NULL,
  run_key    TEXT NOT NULL,
  estado     TEXT NOT NULL CHECK (estado IN ('en_curso', 'ok', 'error')),
  iniciado   TEXT NOT NULL,
  terminado  TEXT,
  detalle    TEXT,
  PRIMARY KEY (job, run_key)
) STRICT, WITHOUT ROWID;

-- Datos internos (p. ej. el "canario" que verifica que DATA_ENCRYPTION_KEY es la misma con la que se cifró la base)
CREATE TABLE meta (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
) STRICT, WITHOUT ROWID;
