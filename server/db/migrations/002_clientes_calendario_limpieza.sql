-- no-fk
-- Fase 2: registro de clientes, calendario configurable, ajustes del administrador e historiales.
-- Reconstruye `reservas` (SQLite no permite quitar columnas con restricciones): los datos de cada persona pasan a `clientes`
-- (una fila por teléfono) y la reserva solo conserva lo propio de esa cita. Ninguna reserva existente se pierde.

/* ───────── clientes generales ───────── */
-- Una fila por persona (identificada por la huella HMAC de su teléfono). Los datos personales van cifrados.
-- La limpieza semanal NUNCA toca esta tabla.
CREATE TABLE clientes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono_mac   TEXT    NOT NULL UNIQUE,
  nombre_enc     TEXT    NOT NULL,
  telefono_enc   TEXT    NOT NULL,
  correo_enc     TEXT    NOT NULL,
  correo_mac     TEXT    NOT NULL,
  creado_en      TEXT    NOT NULL,
  actualizado_en TEXT    NOT NULL
) STRICT;
CREATE INDEX idx_clientes_correo ON clientes (correo_mac);

INSERT INTO clientes (telefono_mac, nombre_enc, telefono_enc, correo_enc, correo_mac, creado_en, actualizado_en)
SELECT telefono_mac, nombre_enc, telefono_enc, correo_enc, COALESCE(correo_mac, ''), creada_en, actualizada_en
FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY telefono_mac ORDER BY id DESC) AS rn
      FROM reservas WHERE telefono_mac IS NOT NULL AND nombre_enc IS NOT NULL AND telefono_enc IS NOT NULL AND correo_enc IS NOT NULL)
WHERE rn = 1;

/* ───────── reservas (reconstruida) ───────── */
CREATE TABLE reservas_nueva (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo          TEXT    NOT NULL UNIQUE CHECK (codigo GLOB 'OR-??????'),
  cliente_id      INTEGER REFERENCES clientes(id) ON DELETE RESTRICT,
  servicio_id     INTEGER NOT NULL REFERENCES servicios(id) ON DELETE RESTRICT,
  vehiculo        TEXT    NOT NULL CHECK (vehiculo IN ('auto', 'suv', 'pickup')),
  fecha           TEXT    NOT NULL CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(fecha) = fecha),
  inicio_min      INTEGER NOT NULL CHECK (inicio_min BETWEEN 0 AND 1410 AND inicio_min % 30 = 0),
  fin_min         INTEGER NOT NULL,
  bloque_fin_min  INTEGER NOT NULL CHECK (bloque_fin_min <= 1440 AND bloque_fin_min % 30 = 0),
  estado          TEXT    NOT NULL DEFAULT 'confirmada'
                  CHECK (estado IN ('confirmada', 'cancelada', 'completada', 'no_llego')),
  -- Datos propios de ESTA cita (el correo puede ser distinto al del registro del cliente). Se borran al cancelar y al purgar.
  correo_enc      TEXT,
  correo_mac      TEXT,
  lugar_enc       TEXT,
  modelo_enc      TEXT,
  precio_monto    INTEGER NOT NULL CHECK (precio_monto > 0),
  precio_desde    INTEGER NOT NULL CHECK (precio_desde IN (0, 1)),
  token_hash      TEXT    NOT NULL,
  idem_key        TEXT    UNIQUE,
  idem_hash       TEXT,
  cambios         INTEGER NOT NULL DEFAULT 0 CHECK (cambios >= 0),
  creada_en       TEXT    NOT NULL,
  actualizada_en  TEXT    NOT NULL,
  cancelada_en    TEXT,
  cancelada_por   TEXT    CHECK (cancelada_por IN ('cliente', 'dueno', 'sistema')),
  UNIQUE (id, fecha),
  CHECK (fin_min > inicio_min AND bloque_fin_min >= fin_min),
  CHECK ((estado = 'cancelada') = (cancelada_en IS NOT NULL)),
  CHECK ((estado = 'cancelada') = (cancelada_por IS NOT NULL)),
  CHECK ((idem_key IS NULL) = (idem_hash IS NULL)),
  -- Una reserva confirmada SIEMPRE tiene cliente, correo y lugar
  CHECK (estado <> 'confirmada' OR (cliente_id IS NOT NULL AND correo_enc IS NOT NULL AND lugar_enc IS NOT NULL))
) STRICT;

INSERT INTO reservas_nueva (id, codigo, cliente_id, servicio_id, vehiculo, fecha, inicio_min, fin_min, bloque_fin_min, estado,
  correo_enc, correo_mac, lugar_enc, modelo_enc, precio_monto, precio_desde, token_hash, idem_key, idem_hash, cambios,
  creada_en, actualizada_en, cancelada_en, cancelada_por)
SELECT r.id, r.codigo, (SELECT c.id FROM clientes c WHERE c.telefono_mac = r.telefono_mac), r.servicio_id, r.vehiculo, r.fecha,
  r.inicio_min, r.fin_min, r.bloque_fin_min, r.estado, r.correo_enc, r.correo_mac, r.lugar_enc, r.modelo_enc, r.precio_monto,
  r.precio_desde, r.token_hash, r.idem_key, r.idem_hash, r.cambios, r.creada_en, r.actualizada_en, r.cancelada_en, r.cancelada_por
FROM reservas r;

DROP TABLE reservas;
ALTER TABLE reservas_nueva RENAME TO reservas;

CREATE INDEX idx_reservas_agenda       ON reservas (fecha, inicio_min) WHERE estado = 'confirmada';
CREATE INDEX idx_reservas_estado_fecha ON reservas (estado, fecha);
CREATE INDEX idx_reservas_fecha        ON reservas (fecha);
CREATE INDEX idx_reservas_cliente      ON reservas (cliente_id, fecha);
CREATE INDEX idx_reservas_correo       ON reservas (correo_mac, fecha) WHERE estado = 'confirmada';
CREATE INDEX idx_reservas_idem         ON reservas (creada_en) WHERE idem_key IS NOT NULL;
CREATE INDEX idx_reservas_creada       ON reservas (creada_en);

-- Solo las reservas CONFIRMADAS retienen casilleros
CREATE TRIGGER trg_reserva_libera_slots AFTER UPDATE OF estado ON reservas
WHEN NEW.estado <> 'confirmada'
BEGIN
  DELETE FROM reserva_slots WHERE reserva_id = NEW.id;
END;

/* ───────── configuración, calendario, limpieza y auditoría ───────── */
-- Ajustes centralizados (días de operación, limpieza automática…). Se siembran al arrancar con valores por defecto.
CREATE TABLE configuracion (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Excepciones al calendario semanal: festivos y cierres (cerrado) o aperturas extraordinarias (abierto)
CREATE TABLE calendario_dias (
  fecha     TEXT PRIMARY KEY CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(fecha) = fecha),
  tipo      TEXT NOT NULL CHECK (tipo IN ('festivo', 'cerrado', 'abierto')),
  motivo    TEXT NOT NULL DEFAULT '' CHECK (length(motivo) <= 120),
  creado_en TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Historial de limpiezas (y simulaciones) con su resultado
CREATE TABLE limpieza_ejecuciones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  inicio      TEXT NOT NULL,
  fin         TEXT,
  modo        TEXT NOT NULL CHECK (modo IN ('automatica', 'manual', 'simulacion')),
  estado      TEXT NOT NULL CHECK (estado IN ('en_curso', 'ok', 'error', 'abortada', 'omitida')),
  corte_fecha TEXT,
  resumen     TEXT,
  error       TEXT,
  actor       TEXT NOT NULL DEFAULT 'sistema'
) STRICT;
CREATE INDEX idx_limpieza_inicio ON limpieza_ejecuciones (inicio DESC);

-- Registro de lo que hace el administrador (sin datos personales)
CREATE TABLE auditoria_admin (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  accion     TEXT NOT NULL,
  detalle    TEXT,
  request_id TEXT
) STRICT;
CREATE INDEX idx_auditoria_ts ON auditoria_admin (ts DESC);
