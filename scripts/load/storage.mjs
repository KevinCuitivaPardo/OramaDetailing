// Mide el tamaño real de la base de datos con 1.000 clientes y la agenda completa de 60 días (peor caso con la limpieza semanal).
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, syncCatalog } from '../../server/db/connection.js';
import { createFieldCrypto } from '../../server/utils/secure.js';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'orama-size-')), path = join(dir, 's.db');
const db = openDatabase(path); migrate(db); syncCatalog(db);
const fc = createFieldCrypto(randomBytes(32).toString('base64'));
const ts = new Date().toISOString();
const cli = db.prepare('INSERT INTO clientes (telefono_mac, nombre_enc, telefono_enc, correo_enc, correo_mac, creado_en, actualizado_en) VALUES (?,?,?,?,?,?,?)');
for (let i = 0; i < 1000; i++) { const p = `787555${String(i).padStart(4, '0')}`; cli.run(fc.phoneMac(p), fc.encrypt(`Cliente Numero ${i}`), fc.encrypt(p), fc.encrypt(`cliente${i}@gmail.com`), fc.emailMac(`cliente${i}@gmail.com`), ts, ts); }
const res = db.prepare(`INSERT INTO reservas (codigo, cliente_id, servicio_id, vehiculo, fecha, inicio_min, fin_min, bloque_fin_min, correo_enc, correo_mac, lugar_enc, modelo_enc, precio_monto, precio_desde, token_hash, creada_en, actualizada_en) VALUES (?,?,1,'auto',?,480,570,600,?,?,?,?,25,1,?,?,?)`);
const slot = db.prepare('INSERT INTO reserva_slots (fecha, slot, reserva_id) VALUES (?,?,?)');
const out = db.prepare("INSERT INTO outbox_correos (tipo, dedupe_key, reserva_id, destinatario_enc, destino_mac, payload_enc, estado, proximo_intento, creado_en, enviado_en) VALUES ('confirmacion', ?, ?, '-', ?, '-', 'enviado', ?, ?, ?)");
let n = 0;
for (let d = 0; d < 60; d++) for (const m of [480, 600, 720, 840]) {
  const fecha = new Date(Date.UTC(2027, 0, 1) + d * 86400e3).toISOString().slice(0, 10);
  const id = Number(res.run(`OR-${String(100000 + n).slice(-6)}`.replace(/\d/g, (x) => 'ABCDEFGHJK'[x]), (n % 1000) + 1, fecha, fc.encrypt(`cliente${n}@gmail.com`), fc.emailMac(`c${n}`), fc.encrypt('Urb. Las Flores 123, Aguada'), fc.encrypt('Toyota RAV4'), randomBytes(32).toString('hex'), ts, ts).lastInsertRowid);
  for (let s = m / 30; s < m / 30 + 4; s++) slot.run(fecha, s, id);
  out.run(`c${n}`, id, fc.emailMac(`c${n}`), ts, ts, ts); n++;
}
db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM');
db.close();
console.log(JSON.stringify({ clientes: 1000, reservasFuturas: n, correosEnCola30Dias: n, tamanoArchivoKB: Math.round(statSync(path).size / 1024) }));
rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
