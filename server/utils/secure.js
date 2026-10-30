import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Utilidades de seguridad. Solo usa primitivas de `node:crypto` (nada de criptografía casera):
 * - AES-256-GCM para cifrar teléfono, correo y lugar en la base de datos.
 * - HMAC-SHA-256 para comparar el teléfono sin descifrarlo ni guardarlo en claro.
 * - SHA-256 para guardar solo el hash de los tokens de gestión.
 */

// Alfabeto sin 0/O ni 1/I/L para que el código sea fácil de dictar y no se confunda
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Número de reserva aleatorio, ej. "OR-7K3P9X" (6 caracteres ≈ 8.9×10^8 combinaciones). */
export function newReservationCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `OR-${s}`;
}
export const CODE_RE = /^OR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/** Acepta "or7k3p9x", "OR-7K3P9X", " or-7k3p9x " y lo deja en la forma canónica (o null si no es válido). */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const c = input.trim().toUpperCase().replace(/^OR-?/, '');
  const full = `OR-${c}`;
  return CODE_RE.test(full) ? full : null;
}

/** Token de gestión para los enlaces del correo (192 bits). Se entrega una vez; en la BD solo va su hash. */
export const newManageToken = () => randomBytes(24).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Deja solo los 10 últimos dígitos (formato de Puerto Rico / EE. UU.). */
export const normalizePhone = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);
export const isValidPhone = (s) => /^\d{10}$/.test(normalizePhone(s)) && String(s).replace(/\D/g, '').length <= 11;

export const maskPhone = (p) => `***-***-${normalizePhone(p).slice(-4)}`;
export function maskEmail(e) {
  const [u, d] = String(e).split('@');
  return d ? `${u.slice(0, 1)}${'*'.repeat(Math.max(u.length - 1, 2))}@${d}` : '***';
}

// Clave de desarrollo SOLO para no obligar a configurar nada al probar en local (nunca en producción)
const DEV_KEY = createHash('sha256').update('orama-dev-only-key-no-usar-en-produccion').digest();

export function createFieldCrypto(base64Key) {
  const key = base64Key ? Buffer.from(base64Key, 'base64') : DEV_KEY;
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY debe ser de 32 bytes (base64). Genera una con: npm run gen:key');
  const macKey = createHmac('sha256', key).update('orama-phone-mac').digest();
  return {
    usingDevKey: !base64Key,
    encrypt(plain) {
      if (plain == null) return null;
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
    },
    decrypt(blob) {
      if (blob == null) return null;
      const [v, iv, tag, ct] = String(blob).split('.');
      if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Campo cifrado con formato desconocido');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
    /** Huella del teléfono para comprobar "código + teléfono" sin guardar el número en claro. */
    phoneMac: (phone) => createHmac('sha256', macKey).update(normalizePhone(phone)).digest('hex'),
    /** Huella del correo (en minúsculas): sirve para contar y limitar por dirección sin guardarla en claro. */
    /** Firma de las sesiones del propietario (clave derivada de DATA_ENCRYPTION_KEY, con su propia etiqueta). */
    sessionMac: (msg) => createHmac('sha256', macKey).update('admin-session:' + msg).digest('base64url'),
    emailMac: (email) => createHmac('sha256', macKey).update('email:' + String(email ?? '').trim().toLowerCase()).digest('hex'),
  };
}
