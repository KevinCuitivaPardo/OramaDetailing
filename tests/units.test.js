import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS, PRICES, SERVICES, lastStartMin, startTimes } from '../shared/catalog.js';
import { migrate, openDatabase, syncCatalog } from '../server/db/connection.js';
import { addDays, diffDays, fmtFechaLarga, fmtHora, isAgendaClosed, isValidDate, zoneNow, toEpoch, weekdayOf, mondayOf } from '../server/utils/time.js';
import { PR } from './helpers.js';

describe('hora de Puerto Rico y cierre de agenda', () => {
  test('la agenda se cierra de 11:00 p.m. a 6:00 a.m. (bordes exactos)', () => {
    const cases = [['2026-10-31T02:59:59Z', false], ['2026-10-31T03:00:00Z', true], ['2026-10-31T09:59:59Z', true], ['2026-10-31T10:00:00Z', false], ['2026-10-30T16:00:00Z', false]];
    for (const [iso, closed] of cases) assert.equal(isAgendaClosed(PR(iso)), closed, iso);
  });

  test('zoneNow convierte de UTC a Puerto Rico (UTC-4) sin depender de la zona del servidor', () => {
    assert.deepEqual(zoneNow(PR('2026-10-31T03:30:00Z')), { fecha: '2026-10-30', minutos: 23 * 60 + 30, diaSemana: 5 });
    assert.equal(toEpoch('2026-10-31', 480), PR('2026-10-31T12:00:00Z'));
  });

  test('fechas: validación real de calendario, días laborables y formatos en español', () => {
    assert.equal(isValidDate('2026-02-31'), false); assert.equal(isValidDate('2028-02-29'), true); assert.equal(isValidDate('2026-13-01'), false);
    assert.equal(weekdayOf('2026-10-31'), 6);
    assert.deepEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'].map((f) => BUSINESS.defaultOpenDays.includes(weekdayOf(f))), [true, false, false, true]); // dom, lun, mar, mié (valores por defecto)
    assert.equal(addDays('2026-12-30', 3), '2027-01-02'); assert.equal(diffDays('2026-10-30', '2026-12-29'), 60);
    assert.equal(fmtHora(480), '8:00 a.m.'); assert.equal(fmtHora(720), '12:00 p.m.'); assert.equal(fmtHora(750), '12:30 p.m.'); assert.equal(fmtHora(1020), '5:00 p.m.');
    assert.equal(fmtFechaLarga('2026-10-31'), 'sábado 31 de octubre de 2026');
  });
});

describe('catálogo y reglas (fuente única)', () => {
  test('los servicios y precios de la base de datos coinciden con shared/catalog.js', () => {
    const db = openDatabase(':memory:'); migrate(db); syncCatalog(db);
    const rows = db.prepare('SELECT * FROM servicios ORDER BY id').all();
    assert.deepEqual(rows.map((r) => [r.id, r.duracion_min, r.bloque_min]), Object.values(SERVICES).map((s) => [s.id, s.duracionMin, s.bloqueMin]));
    for (const p of db.prepare('SELECT * FROM precios').all()) assert.deepEqual([p.monto, !!p.es_desde], PRICES[p.vehiculo][p.servicio_id]);
    syncCatalog(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM precios').get().n, 6, 'sincronizar de nuevo no duplica');
    db.close();
  });

  test('duraciones, bloques, horas límite y precios (todos "desde")', () => {
    assert.equal(SERVICES[1].duracionMin, 90); assert.equal(SERVICES[1].bloqueMin, 120);
    assert.equal(SERVICES[2].duracionMin, 150); assert.equal(SERVICES[2].bloqueMin, 180);
    assert.equal(lastStartMin(1), 15 * 60 + 30); assert.equal(lastStartMin(2), 14 * 60 + 30);
    assert.equal(startTimes(2)[0], BUSINESS.openMin);
    for (const [v, s] of [['auto', 1], ['auto', 2], ['suv', 1], ['suv', 2], ['pickup', 1], ['pickup', 2]]) assert.equal(PRICES[v][s][1], true, `${v} #${s} es "desde"`);
    assert.deepEqual([PRICES.auto[1][0], PRICES.auto[2][0], PRICES.suv[1][0], PRICES.suv[2][0], PRICES.pickup[1][0], PRICES.pickup[2][0]], [25, 35, 35, 45, 45, 50]);
  });
});
