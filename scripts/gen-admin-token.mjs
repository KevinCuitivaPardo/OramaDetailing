// Genera un secreto criptográficamente seguro (256 bits, base64url, 43 caracteres) para ADMIN_TOKEN_SECRET
// (o JOBS_TRIGGER_SECRET). Se imprime UNA vez: cópialo al gestor de secretos del hosting o a tu .env local. No se guarda en ningún archivo.
import { randomBytes } from 'node:crypto';

console.log(randomBytes(32).toString('base64url'));
console.error('\nPégalo como ADMIN_TOKEN_SECRET (o JOBS_TRIGGER_SECRET) en las variables de entorno del servidor.');
console.error('No lo subas al repositorio ni lo pegues en el frontend. Para rotarlo: ver docs/OPERACION.md.');
