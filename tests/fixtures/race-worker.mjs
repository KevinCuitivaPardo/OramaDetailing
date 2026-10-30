// Proceso independiente para la prueba de concurrencia real: cada instancia abre el MISMO archivo de base de datos
// y, a una hora de arranque común, intenta reservar el mismo horario.
import { buildContainer } from '../../server/app.js';
import { loadEnv } from '../../server/config/env.js';
import { openDatabase } from '../../server/db/connection.js';
import { silentLogger } from '../../server/utils/logger.js';

const [, , dbPath, startAt, who, now] = process.argv;
const env = loadEnv({ NODE_ENV: 'test', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), OWNER_EMAIL: 'dueno@example.com', JOBS_ENABLED: 'false' });
const db = openDatabase(dbPath);
const c = buildContainer({ env, db, log: silentLogger, clock: () => Number(now) });

// Barrera: todos esperan al mismo instante para chocar de verdad
while (Date.now() < Number(startAt)) { /* espera activa breve */ }

try {
  const r = c.reservations.create({
    servicioId: 2, vehiculo: 'suv', fecha: '2026-10-31', hora: '08:00', nombre: `Cliente ${who} Apellido`,
    telefono: `787-555-${String(2000 + Number(who))}`, correo: `c${who}@example.com`, lugar: 'Aguada',
  }, { idempotencyKey: `race-worker-key-${who}-abcdefgh`, requestId: `w${who}` });
  console.log(JSON.stringify({ ok: true, codigo: r.reserva.codigo }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, code: err.code ?? 'ERROR', message: String(err.message).slice(0, 120) }));
}
db.close();
