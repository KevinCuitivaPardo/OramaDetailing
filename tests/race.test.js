import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, openDatabase, syncCatalog } from '../server/db/connection.js';
import { T0 } from './helpers.js';

const worker = fileURLToPath(new URL('./fixtures/race-worker.mjs', import.meta.url));

/** Escenarios 3 y 4 con procesos de verdad: varios procesos del sistema operativo contra el mismo archivo de base de datos. */
describe('concurrencia real entre procesos', () => {
  test('8 procesos reservan el MISMO horario al mismo tiempo: exactamente uno lo consigue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orama-race-'));
    const dbPath = join(dir, 'race.db');
    const setup = openDatabase(dbPath); migrate(setup); syncCatalog(setup); setup.close();

    const startAt = Date.now() + 2500; // margen para que arranquen todos
    const runs = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
      const child = fork(worker, [dbPath, String(startAt), String(i + 1), String(T0)], { silent: true, execArgv: ['--no-warnings'] });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('exit', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { reject(new Error(`sin resultado: ${out} ${err}`)); } });
    }));
    const results = await Promise.all(runs);

    const winners = results.filter((r) => r.ok), losers = results.filter((r) => !r.ok);
    assert.equal(winners.length, 1, `debe ganar exactamente uno: ${JSON.stringify(results)}`);
    assert.equal(losers.length, 7);
    assert.ok(losers.every((l) => l.code === 'HORARIO_NO_DISPONIBLE'), `los demás reciben "horario no disponible": ${JSON.stringify(losers)}`);

    const db = openDatabase(dbPath);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservas').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reserva_slots').get().n, 6, 'sin casilleros huérfanos de los perdedores');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox_correos').get().n, 1, 'sin correos de los perdedores');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reserva_eventos').get().n, 1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('la base de datos por sí sola impide el solapamiento, incluso si el código se saltara las validaciones', () => {
    const db = openDatabase(':memory:'); migrate(db); syncCatalog(db);
    db.prepare("INSERT INTO clientes (telefono_mac, nombre_enc, telefono_enc, correo_enc, correo_mac, creado_en, actualizado_en) VALUES ('m', 'n', 't', 'c', 'cm', 't', 't')").run();
    const cols = 'codigo, cliente_id, servicio_id, vehiculo, fecha, inicio_min, fin_min, bloque_fin_min, precio_monto, precio_desde, token_hash, creada_en, actualizada_en, correo_enc, lugar_enc';
    const ins = (codigo, { servicio = 1, fecha = '2026-11-04', inicio = 480 } = {}) =>
      db.prepare(`INSERT INTO reservas (${cols}) VALUES (?, 1, ?, 'auto', ?, ?, ?, ?, 25, 1, 'h', 't', 't', 'c', 'l')`).run(codigo, servicio, fecha, inicio, inicio + 90, inicio + 120);
    const a = Number(ins('OR-AAAAAA').lastInsertRowid), b = Number(ins('OR-BBBBBB').lastInsertRowid);
    const slot = db.prepare('INSERT INTO reserva_slots (fecha, slot, reserva_id) VALUES (?, ?, ?)');
    for (let s = 16; s < 20; s++) slot.run('2026-11-04', s, a);
    assert.throws(() => slot.run('2026-11-04', 19, b), /UNIQUE|PRIMARY/); // se pisan en el casillero 19 (9:30 a.m.)
    assert.doesNotThrow(() => slot.run('2026-11-04', 20, b));            // contiguo, sin pisarse
    // Restricciones de integridad
    assert.throws(() => ins('OR-AAAAAA'), /UNIQUE/);                     // código repetido
    assert.throws(() => ins('OR-CCCCCC', { fecha: 'ayer' }), /CHECK/);   // fecha con formato inválido
    assert.throws(() => ins('OR-DDDDDD', { servicio: 99 }), /FOREIGN/);  // servicio inexistente
    assert.throws(() => ins('OR-EEEEEE', { inicio: 485 }), /CHECK/);     // no es múltiplo de 30 min
    db.close();
  });
});
