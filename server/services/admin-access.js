import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 32;
const SESSION_MS = 8 * 3600e3; // una sesión dura 8 horas

/**
 * Acceso del propietario: contraseña propia + sesión firmada.
 *  - La contraseña se guarda solo como hash scrypt con sal (tabla `admin_acceso`); nunca en claro ni en el repositorio.
 *  - Al iniciar sesión se entrega un token firmado (HMAC con una clave derivada de DATA_ENCRYPTION_KEY) que vence a las 8 horas.
 *    Va en la cabecera Authorization (no en cookies: no hay CSRF) y se invalida al cambiar la contraseña (`version`).
 *  - El token largo `ADMIN_TOKEN_SECRET` (si existe) sigue sirviendo para automatizaciones; no es lo que usa el propietario.
 */
export function createAdminAccess({ db, fc, clock = Date.now }) {
  const q = {
    get: db.prepare('SELECT password_hash, version FROM admin_acceso WHERE id = 1'),
    upsert: db.prepare(`INSERT INTO admin_acceso (id, password_hash, version, actualizado_en) VALUES (1, @hash, 1, @ts)
      ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash, version = admin_acceso.version + 1, actualizado_en = excluded.actualizado_en`),
  };

  const hasPassword = () => Boolean(q.get.get());

  /** Reglas mínimas de la contraseña nueva. Devuelve un mensaje de error o null. */
  function passwordProblem(pw) {
    if (typeof pw !== 'string' || pw.length < 12) return 'La contraseña debe tener al menos 12 caracteres.';
    if (pw.length > 128) return 'La contraseña es demasiado larga.';
    if (new Set(pw).size < 5) return 'La contraseña es demasiado repetitiva.';
    if (/^(0123456789|123456789|abcdefghij|qwertyuiop|password|contrase)/i.test(pw)) return 'Esa contraseña es demasiado común.';
    return null;
  }

  async function hash(pw) {
    const salt = randomBytes(16);
    const key = await scryptAsync(pw, salt, KEYLEN, { N, r: R, p: P });
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  async function setPassword(pw) {
    const problem = passwordProblem(pw);
    if (problem) throw new Error(problem);
    q.upsert.run({ hash: await hash(pw), ts: new Date(clock()).toISOString() });
    return q.get.get().version;
  }

  async function verifyPassword(pw) {
    const row = q.get.get();
    // Sin contraseña guardada (o formato raro) se hace igual el cálculo: el tiempo no revela si existe
    const [, n, r, p, saltB64, keyB64] = (row?.password_hash ?? `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`).split('$');
    const expected = Buffer.from(keyB64, 'base64');
    const got = await scryptAsync(String(pw ?? '').slice(0, 256), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return Boolean(row) && timingSafeEqual(got, expected);
  }

  /** Token de sesión: s1.<vence>.<versión>.<firma> */
  function issue() {
    const exp = clock() + SESSION_MS, ver = q.get.get()?.version ?? 0;
    return { token: `s1.${exp}.${ver}.${fc.sessionMac(`${exp}.${ver}`)}`, venceEn: new Date(exp).toISOString() };
  }

  function verify(token) {
    const m = /^s1\.(\d{10,16})\.(\d{1,9})\.([A-Za-z0-9_-]{43})$/.exec(token ?? '');
    if (!m) return false;
    const [, exp, ver, mac] = m;
    const good = Buffer.from(fc.sessionMac(`${exp}.${ver}`)), given = Buffer.from(mac);
    if (good.length !== given.length || !timingSafeEqual(good, given)) return false;
    return Number(exp) > clock() && Number(ver) === (q.get.get()?.version ?? -1);
  }

  return { hasPassword, passwordProblem, setPassword, verifyPassword, issue, verify };
}
