import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { AppError, E } from '../utils/errors.js';
import { normalizeCode, safeEqual, sha256 } from '../utils/secure.js';
import { fieldErrors } from '../validation/schemas.js';

/** Identificador de la solicitud: llega en X-Request-Id (si es válido) o se genera; vuelve en la respuesta y en los logs. */
export function requestContext(log) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.log = log.child({ request: req.id });
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}

/** Cabeceras de seguridad. La API nunca se cachea (contiene datos de reservas). */
export function security(env) {
  const csp = {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'wasm-unsafe-eval'"], // wasm: decodificador del modelo 3D
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'"],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'", 'blob:'], // blob: lo usa el cargador del modelo 3D para leer sus texturas
      'worker-src': ["'self'", 'blob:'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
  };
  const h = helmet({
    contentSecurityPolicy: csp,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: env.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    hidePoweredBy: true,
  });
  return [h, (req, res, next) => {
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  }];
}

/** CORS con lista blanca (por defecto, solo mismo origen). Sin credenciales ni cookies. */
export function cors(env) {
  const allowed = new Set(env.corsOrigins);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowed.has(origin) && !req.path.startsWith('/api/admin')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

/* ───────── límites de solicitudes ───────── */
const handler = (req, res, _next, options) => {
  res.setHeader('Retry-After', String(Math.ceil(options.windowMs / 1000)));
  req.log?.warn('http.limite_excedido', { ruta: req.path });
  sendError(res, E.tooMany(), req);
};
const base = { standardHeaders: 'draft-7', legacyHeaders: false, handler };

export function createLimiters({ disabled = false, internal = false } = {}) {
  const make = (opts) => (disabled ? (_q, _s, next) => next() : rateLimit({ ...base, ...opts }));
  return {
    global: make({ windowMs: 15 * 60e3, limit: 300, skip: (req) => req.path === '/eventos' }), // el flujo en vivo tiene su propio límite
    events: make({ windowMs: 60e3, limit: 20 }),
    availability: make({ windowMs: 60e3, limit: 120 }),
    create: make({ windowMs: 60 * 60e3, limit: 10 }),
    // Acceso a una reserva: por IP y, además, por código (frena ataques distribuidos). Solo cuentan los intentos fallidos.
    accessIp: make({ windowMs: 15 * 60e3, limit: 15, skipSuccessfulRequests: true }),
    accessCode: make({ windowMs: 60 * 60e3, limit: 10, skipSuccessfulRequests: true, skip: (req) => Boolean(req.body?.token), keyGenerator: (req) => `codigo:${normalizeCode(req.body?.codigo) ?? 'x'}`, validate: { keyGeneratorIpFallback: false } }),
    manage: make({ windowMs: 60 * 60e3, limit: 20 }),
    adminFail: make({ windowMs: 15 * 60e3, limit: 5, skipSuccessfulRequests: true }),
    admin: make({ windowMs: 15 * 60e3, limit: 300 }),
    // Tope global de intentos fallidos de contraseña (frena los ataques repartidos entre muchas IP)
    adminLogin: make({ windowMs: 60 * 60e3, limit: 40, skipSuccessfulRequests: true, keyGenerator: () => 'login-global', validate: { keyGeneratorIpFallback: false } }),
    internal: make({ windowMs: 60e3, limit: 30 }),
  };
}

/* ───────── autenticación del panel del dueño ───────── */
/**
 * Comparación del secreto contra uno o dos valores esperados (rotación). Se compara el SHA-256 de ambos en tiempo constante:
 * no se filtra la longitud ni el contenido, y ningún secreto se guarda ni se registra en claro.
 */
function bearerMatcher(secrets) {
  const expected = secrets.filter(Boolean).map((s) => sha256(s));
  return (req) => {
    const m = /^Bearer\s+(\S{1,512})$/.exec(req.get('authorization') ?? '');
    const given = sha256(m ? m[1] : '');
    let ok = false;
    for (const e of expected) ok = safeEqual(given, e) || ok; // recorre todos: el tiempo no depende de cuál coincide
    return Boolean(m) && ok;
  };
}

function guard(secrets, logEvent) {
  const configured = secrets.some(Boolean);
  const matches = bearerMatcher(secrets);
  return (req, res, next) => {
    if (!configured) return sendError(res, new AppError('NO_ENCONTRADO', 404, 'No encontrado.'), req); // sin secreto, la ruta "no existe"
    if (!matches(req)) {
      req.log?.warn(logEvent, { ruta: req.path });
      return sendError(res, E.unauthorized(), req);
    }
    next();
  };
}

/**
 * Autenticación del administrador. Acepta (1) la sesión que entrega el inicio de sesión del propietario (token `s1.…`, firmado y con vencimiento)
 * o (2) el secreto largo ADMIN_TOKEN_SECRET (automatizaciones). Va en la cabecera Authorization: sin cookies no hay CSRF.
 * Mientras no exista ni contraseña ni secreto, estas rutas "no existen" (404).
 */
export function adminAuth(env, access) {
  const secrets = [env.ADMIN_TOKEN_SECRET, env.ADMIN_TOKEN_SECRET_PREVIOUS];
  const matchesSecret = bearerMatcher(secrets);
  return (req, res, next) => {
    if (!secrets.some(Boolean) && !access.hasPassword()) return sendError(res, new AppError('NO_ENCONTRADO', 404, 'No encontrado.'), req);
    const m = /^Bearer\s+(\S{1,512})$/.exec(req.get('authorization') ?? '');
    const ok = m && (m[1].startsWith('s1.') ? access.verify(m[1]) : matchesSecret(req));
    if (!ok) {
      req.log?.warn('admin.acceso_denegado', { ruta: req.path });
      return sendError(res, E.unauthorized(), req);
    }
    next();
  };
}
/** Autenticación del disparador externo de tareas programadas (JOBS_TRIGGER_SECRET). */
export const jobsAuth = (env) => guard([env.JOBS_TRIGGER_SECRET], 'tareas.acceso_denegado');

/* ───────── validación y errores ───────── */
export const validate = (schema, where = 'body') => (req, _res, next) => {
  const parsed = schema.safeParse(req[where]);
  if (!parsed.success) return next(E.validation('Revisa los datos marcados.', fieldErrors(parsed.error)));
  req.valid = parsed.data; // (req.query es de solo lectura en Express 5)
  next();
};

export function sendError(res, err, req) {
  res.status(err.status).json({ error: { code: err.code, message: err.message, requestId: req?.id, ...(err.extra?.fields ? { campos: err.extra.fields } : {}), ...(err.extra?.whatsapp ? { whatsapp: err.extra.whatsapp } : {}) } });
}

/** Manejador global: los errores esperados se traducen; los inesperados se registran completos y al cliente solo le llega un mensaje genérico. */
export function errorHandler(env) {
  const whatsappUrl = `https://wa.me/${env.WHATSAPP_NUMBER}`;
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err instanceof AppError) {
      if (['FUERA_DE_PLAZO', 'AGENDA_CERRADA', 'CORREO_NO_DISPONIBLE', 'ENLACE_VENCIDO'].includes(err.code)) err.extra = { ...err.extra, whatsapp: whatsappUrl };
      return sendError(res, err, req);
    }
    if (err?.type === 'entity.too.large') return sendError(res, new AppError('CUERPO_MUY_GRANDE', 413, 'La solicitud es demasiado grande.'), req);
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return sendError(res, new AppError('JSON_INVALIDO', 400, 'El cuerpo de la solicitud no es JSON válido.'), req);
    (req.log ?? console).error('http.error_no_controlado', { error: err, ruta: req.path });
    return sendError(res, new AppError('ERROR_INTERNO', 500, 'Ocurrió un error. Inténtalo de nuevo en unos minutos.'), req);
  };
}
