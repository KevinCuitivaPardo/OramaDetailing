import { z } from 'zod';

/**
 * Configuración desde variables de entorno, validada al arrancar.
 * Nada de secretos en el código: lo que falta se documenta en .env.example y el README.
 * Si falta algo opcional (Gmail, correo del dueño) el sistema arranca, lo dice en los logs y NO finge enviar correos.
 */
const bool = (def) => z.enum(['true', 'false']).default(def ? 'true' : 'false').transform((v) => v === 'true');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opt = (schema) => z.preprocess(emptyToUndef, schema.optional());

/**
 * Secreto fuerte: al menos 43 caracteres (256 bits en base64url) y variedad suficiente. Rechaza cadenas repetitivas
 * como "aaaa…" o "123456…" que cumplirían la longitud pero no la entropía.
 */
const strongSecret = (name) => z.string().min(43, `${name} debe tener al menos 43 caracteres (genera uno con npm run gen:admin-token)`)
  .refine((s) => new Set(s).size >= 16, `${name} no parece aleatorio (muy pocos caracteres distintos)`);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_PATH: z.string().default('./data/orama.db'),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

  // URL pública del sitio: se usa en los enlaces de los correos
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'), // en producción debe ser https://
  CORS_ORIGINS: z.string().default(''), // lista separada por comas; vacío = solo mismo origen

  // Datos personales cifrados en reposo (AES-256-GCM). 32 bytes en base64: `npm run gen:key`
  DATA_ENCRYPTION_KEY: opt(z.string().refine((k) => { try { const b = Buffer.from(k, 'base64'); return b.length === 32 && b.toString('base64') === k; } catch { return false; } }, 'DATA_ENCRYPTION_KEY inválida: debe ser base64 de 32 bytes (genera una con npm run gen:key)')),

  // Gmail (contraseña de aplicación) — NO inventar: lo aporta el dueño
  GMAIL_USER: opt(z.string().email()),
  GMAIL_APP_PASSWORD: opt(z.string().min(8)),
  GMAIL_FROM_NAME: z.string().default('Orama’s Detailing'),
  // Alternativa OAuth2 (si se prefiere a la contraseña de aplicación)
  GMAIL_OAUTH_CLIENT_ID: opt(z.string()),
  GMAIL_OAUTH_CLIENT_SECRET: opt(z.string()),
  GMAIL_OAUTH_REFRESH_TOKEN: opt(z.string()),

  // Destinatario del resumen diario y de los avisos del propietario (dato definido por el dueño; se puede cambiar por variable de entorno)
  OWNER_EMAIL: z.preprocess(emptyToUndef, z.string().email().default('oramasdetailing@gmail.com')),

  // Contacto de la empresa (datos que ya dio el dueño; se pueden cambiar sin tocar código)
  WHATSAPP_NUMBER: z.string().regex(/^\d{10,15}$/, 'Solo dígitos, con código de país').default('17876625851'),
  BUSINESS_PHONE: z.string().default('787-662-5851'),
  BUSINESS_INSTAGRAM: z.string().default('@oramaautodetailing'),

  // Reglas de gestión de reservas
  CHANGE_CUTOFF_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(60),
  // Máximo de reservas futuras activas por teléfono (evita que una persona acapare la agenda)
  MAX_ACTIVE_PER_PHONE: z.coerce.number().int().min(1).max(20).default(3),
  MAX_ACTIVE_PER_EMAIL: z.coerce.number().int().min(1).max(20).default(3),
  // Cuántas veces puede cambiar una reserva su fecha/hora por internet (después, por WhatsApp)
  MAX_CHANGES_PER_BOOKING: z.coerce.number().int().min(0).max(20).default(3),
  // Tope de correos a una misma dirección por día (frena que el sistema se use para bombardear a terceros)
  MAX_EMAILS_PER_ADDRESS_PER_DAY: z.coerce.number().int().min(1).max(50).default(20),
  // Tope global de reservas nuevas por hora (alarma contra acaparamiento de la agenda)
  MAX_BOOKINGS_PER_HOUR: z.coerce.number().int().min(1).max(100000).default(40),

  // API de administración OPCIONAL (no hay panel web). Deshabilitada (404) si no hay secreto.
  // Genera uno con `npm run gen:admin-token` (256 bits aleatorios). Nunca va en el repositorio ni en el frontend.
  ADMIN_TOKEN_SECRET: opt(strongSecret('ADMIN_TOKEN_SECRET')),
  // Durante una rotación se aceptan los dos a la vez; al terminar, se elimina el anterior.
  ADMIN_TOKEN_SECRET_PREVIOUS: opt(strongSecret('ADMIN_TOKEN_SECRET_PREVIOUS')),
  // Secreto para que un programador externo (GitHub Actions, cron-job.org…) dispare las tareas: POST /api/internal/tareas/:tarea
  JOBS_TRIGGER_SECRET: opt(strongSecret('JOBS_TRIGGER_SECRET')),
  // Solo para pruebas de carga en un entorno que NO sea producción
  RATE_LIMITS_ENABLED: bool(true),

  // Tareas programadas (zona horaria del negocio: BUSINESS.timezone, America/Puerto_Rico)
  JOBS_ENABLED: bool(true),
  OWNER_SUMMARY_CRON: z.string().default('0 23 * * *'), // 11:00 p.m., cuando se cierra la agenda
  CLEANUP_CRON: z.string().default('59 23 * * 0'),      // domingos 11:59 p.m. (la semana de lunes a domingo ya terminó)
  BACKUP_CRON: z.string().default('0 2 * * *'),         // todos los días 2:00 a.m.
  BACKUP_DIR: z.string().default('./data/backups'),
  BACKUP_KEEP_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  OUTBOX_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),

  // Tope de reservas que la limpieza AUTOMÁTICA puede borrar de una vez (si propone más, se aborta y avisa)
  CLEANUP_MAX_DELETE: z.coerce.number().int().min(1).max(100000).default(500),
});

export function loadEnv(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${detail}`);
  }
  const env = parsed.data;

  // La clave de desarrollo (pública, está en el código) SOLO se tolera en una máquina local de desarrollo o pruebas.
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(env.HOST);
  const localUrl = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(env.PUBLIC_BASE_URL);
  if (!env.DATA_ENCRYPTION_KEY && !(env.NODE_ENV !== 'production' && loopback && localUrl)) {
    throw new Error('Falta DATA_ENCRYPTION_KEY. Solo puede omitirse en desarrollo local (NODE_ENV≠production, HOST=127.0.0.1 y PUBLIC_BASE_URL=http://localhost…). Genera una con: npm run gen:key');
  }
  if (env.NODE_ENV === 'production' && !env.RATE_LIMITS_ENABLED) {
    throw new Error('RATE_LIMITS_ENABLED=false no está permitido en producción (solo para pruebas de carga en otro entorno)');
  }
  if (env.NODE_ENV === 'production' && !env.PUBLIC_BASE_URL.startsWith('https://')) {
    throw new Error('En producción PUBLIC_BASE_URL debe empezar con https:// (los enlaces de los correos llevan un token personal)');
  }

  return Object.freeze({
    ...env,
    corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    gmailMode: env.GMAIL_USER && env.GMAIL_APP_PASSWORD ? 'app-password'
      : env.GMAIL_USER && env.GMAIL_OAUTH_CLIENT_ID && env.GMAIL_OAUTH_CLIENT_SECRET && env.GMAIL_OAUTH_REFRESH_TOKEN ? 'oauth2'
        : 'none',
    isProd: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  });
}
