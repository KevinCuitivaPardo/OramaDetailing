-- no-fk
-- Cancelar o cambiar una cita por internet exige una SEGUNDA confirmación por correo (al correo de la reserva).
-- La solicitud queda como "acción pendiente" con un token de un solo uso; la cita no cambia hasta que se confirma.

CREATE TABLE acciones_pendientes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reserva_id        INTEGER NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
  tipo              TEXT    NOT NULL CHECK (tipo IN ('cancelar', 'cambiar')),
  fecha_nueva       TEXT    CHECK (fecha_nueva IS NULL OR (fecha_nueva GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(fecha_nueva) = fecha_nueva)),
  inicio_nuevo_min  INTEGER CHECK (inicio_nuevo_min IS NULL OR (inicio_nuevo_min BETWEEN 0 AND 1410 AND inicio_nuevo_min % 30 = 0)),
  token_hash        TEXT    NOT NULL UNIQUE,            -- SHA-256 del token del enlace (el token en claro solo viaja en el correo)
  creada_en         TEXT    NOT NULL,
  expira_en         TEXT    NOT NULL,
  usada_en          TEXT,
  CHECK ((tipo = 'cambiar') = (fecha_nueva IS NOT NULL AND inicio_nuevo_min IS NOT NULL))
) STRICT;
CREATE INDEX idx_acciones_reserva ON acciones_pendientes (reserva_id, tipo);
CREATE INDEX idx_acciones_expira  ON acciones_pendientes (expira_en);

-- La cola de correos admite dos tipos nuevos: reconstruir la tabla para ampliar el CHECK (los datos se conservan)
CREATE TABLE outbox_nueva (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo             TEXT    NOT NULL CHECK (tipo IN ('confirmacion', 'cambio', 'cancelacion', 'resumen_dueno', 'aviso_dueno', 'confirmar_cancelacion', 'confirmar_cambio')),
  dedupe_key       TEXT    NOT NULL UNIQUE,
  reserva_id       INTEGER REFERENCES reservas(id) ON DELETE SET NULL,
  destinatario_enc TEXT    NOT NULL,
  destino_mac      TEXT,
  payload_enc      TEXT    NOT NULL,
  estado           TEXT    NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'enviando', 'enviado', 'fallido')),
  intentos         INTEGER NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  proximo_intento  TEXT    NOT NULL,
  bloqueado_hasta  TEXT,
  ultimo_error     TEXT,
  creado_en        TEXT    NOT NULL,
  enviado_en       TEXT,
  CHECK (estado <> 'enviando' OR bloqueado_hasta IS NOT NULL),
  CHECK (estado <> 'enviado'  OR enviado_en IS NOT NULL)
) STRICT;

INSERT INTO outbox_nueva (id, tipo, dedupe_key, reserva_id, destinatario_enc, destino_mac, payload_enc, estado, intentos, proximo_intento, bloqueado_hasta, ultimo_error, creado_en, enviado_en)
SELECT id, tipo, dedupe_key, reserva_id, destinatario_enc, destino_mac, payload_enc, estado, intentos, proximo_intento, bloqueado_hasta, ultimo_error, creado_en, enviado_en FROM outbox_correos;

DROP TABLE outbox_correos;
ALTER TABLE outbox_nueva RENAME TO outbox_correos;

CREATE INDEX idx_outbox_pendientes ON outbox_correos (estado, proximo_intento) WHERE estado IN ('pendiente', 'enviando');
CREATE INDEX idx_outbox_reserva    ON outbox_correos (reserva_id) WHERE reserva_id IS NOT NULL;
CREATE INDEX idx_outbox_limpieza   ON outbox_correos (estado, creado_en);
CREATE INDEX idx_outbox_destino    ON outbox_correos (destino_mac, creado_en) WHERE destino_mac IS NOT NULL;
