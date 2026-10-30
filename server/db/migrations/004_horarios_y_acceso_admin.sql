-- Horarios editables por el propietario y acceso con contraseña.

-- Bloqueos de horario: horas en las que NO se puede reservar (almuerzo, una cita personal, salir temprano…).
--   · fecha = 'AAAA-MM-DD'          → solo ese día
--   · dia_semana = 0..6             → todos los miércoles (por ejemplo)
--   · ambos vacíos                  → todos los días de operación (descanso diario)
-- No cancelan citas ya hechas: el panel avisa cuántas caen dentro del bloqueo.
CREATE TABLE bloqueos_horario (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha       TEXT    CHECK (fecha IS NULL OR (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(fecha) = fecha)),
  dia_semana  INTEGER CHECK (dia_semana IS NULL OR dia_semana BETWEEN 0 AND 6),
  desde_min   INTEGER NOT NULL CHECK (desde_min BETWEEN 0 AND 1410 AND desde_min % 30 = 0),
  hasta_min   INTEGER NOT NULL CHECK (hasta_min BETWEEN 30 AND 1440 AND hasta_min % 30 = 0),
  motivo      TEXT    NOT NULL DEFAULT '' CHECK (length(motivo) <= 120),
  creado_en   TEXT    NOT NULL,
  CHECK (desde_min < hasta_min),
  CHECK (fecha IS NULL OR dia_semana IS NULL)
) STRICT;
CREATE INDEX idx_bloqueos_fecha ON bloqueos_horario (fecha) WHERE fecha IS NOT NULL;

-- Contraseña del propietario (una sola fila). Solo se guarda un hash scrypt con sal; `version` sube al cambiarla
-- y así se cierran todas las sesiones abiertas.
CREATE TABLE admin_acceso (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash  TEXT    NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  actualizado_en TEXT    NOT NULL
) STRICT;
