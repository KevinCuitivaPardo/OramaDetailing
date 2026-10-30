// Genera una clave de 32 bytes (base64) para DATA_ENCRYPTION_KEY.
import { randomBytes } from 'node:crypto';

console.log(randomBytes(32).toString('base64'));
console.error('\nCopia el valor de arriba en DATA_ENCRYPTION_KEY (en .env o en el gestor de secretos del hosting).');
console.error('Guárdala aparte: si se pierde, los teléfonos, correos y lugares cifrados no se pueden recuperar.');
