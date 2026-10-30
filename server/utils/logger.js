/**
 * Logger JSON estructurado, sin dependencias.
 * - Una línea por evento (`event` en tiempo pasado: "reserva.creada").
 * - Redacta por nombre de campo: contraseñas, tokens y datos personales NUNCA llegan al log.
 *   Para identificar una reserva se usa su código, no los datos del cliente.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE = /pass|secret|token|authorization|cookie|api[-_]?key|nombre|telefono|phone|correo|email|lugar|direccion|address|marca|modelo|body/i;

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;

function redact(value, depth = 0) {
  if (typeof value === 'string') {
    const v = value.length > 2000 ? `${value.slice(0, 2000)}…` : value; // acota el costo de la expresión y evita inundar el registro
    return v.includes('@') ? v.replace(EMAIL, '[correo]') : v; // un mensaje de error puede traer una dirección
  }
  if (value == null || depth > 4) return value;
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[redactado]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function createLogger({ level = 'info', base = {}, write = (line) => process.stdout.write(line + '\n') } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, event, fields) => {
    if (LEVELS[lvl] < min) return;
    write(JSON.stringify({ level: lvl, time: new Date().toISOString(), event, ...redact(base), ...redact(fields) }));
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (extra) => createLogger({ level, base: { ...base, ...extra }, write }),
  };
}

/** Logger que no escribe nada (pruebas). */
export const silentLogger = createLogger({ level: 'error', write: () => {} });
