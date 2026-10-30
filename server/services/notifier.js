import { SERVICES, VEHICLES } from '../../shared/catalog.js';
import { diaNombre, fmtFechaLarga, fmtHora } from '../utils/time.js';
import { sha256 } from '../utils/secure.js';

/**
 * Encola correos en el outbox. NO envía nada: solo escribe filas (dentro de la misma transacción que la reserva),
 * y el trabajador de correos las envía después. Cada correo lleva una `dedupe_key`, así no se encola dos veces.
 * El destinatario y los datos del correo se guardan cifrados; el HTML se arma al momento de enviar.
 */
export function createNotifier({ outbox, fc, env, log }) {
  const ownerEnabled = Boolean(env.OWNER_EMAIL);

  const empresa = { telefono: env.BUSINESS_PHONE, instagram: env.BUSINESS_INSTAGRAM, whatsappUrl: `https://wa.me/${env.WHATSAPP_NUMBER}`, cutoffMin: env.CHANGE_CUTOFF_MINUTES };

  const common = (row) => {
    const svc = SERVICES[row.servicio_id];
    return {
      nombre: fc.decrypt(row.nombre_enc), codigo: row.codigo, servicio: svc.nombre, servicioCorto: svc.corto,
      vehiculo: VEHICLES[row.vehiculo], fecha: row.fecha, dia: diaNombre(row.fecha), fechaLarga: fmtFechaLarga(row.fecha),
      inicio: fmtHora(row.inicio_min), fin: fmtHora(row.fin_min), lugar: fc.decrypt(row.lugar_enc),
      precio: `${row.precio_desde ? 'desde ' : ''}$${row.precio_monto}`, empresa,
    };
  };

  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  /** Enlace de gestión: el token va en el fragmento (#), que el navegador nunca envía al servidor ni en cabeceras. */
  const manageUrl = (codigo, token) => `${base}/#mi-reserva/${codigo}${token ? `/${token}` : ''}`;

  /** Enlace de confirmación: el token de la acción va en el fragmento (#) y solo sirve una vez. */
  const confirmUrl = (codigo, token) => `${base}/#confirmar/${codigo}/${token}`;
  const expiraTexto = (expiraIso, tsIso) => `${Math.round((Date.parse(expiraIso) - Date.parse(tsIso)) / 60e3)} minutos`;

  const push = (tipo, dedupe_key, row, to, data, ts) => {
    // Tope de correos por dirección y por día (no se usa el sistema para bombardear a un tercero). El dueño no cuenta.
    const destino_mac = fc.emailMac(to);
    const isOwner = env.OWNER_EMAIL && to.toLowerCase() === env.OWNER_EMAIL.toLowerCase();
    if (!isOwner && outbox.countToAddress(destino_mac, new Date(Date.parse(ts) - 86400e3).toISOString()) >= env.MAX_EMAILS_PER_ADDRESS_PER_DAY) {
      log.warn('correo.limite_por_direccion', { tipo, reserva: row?.codigo });
      return false;
    }
    const added = outbox.enqueue({
      tipo, dedupe_key, reserva_id: row?.id ?? null, destinatario_enc: fc.encrypt(to), destino_mac, payload_enc: fc.encrypt(JSON.stringify(data)), ts,
    });
    if (added) log.info('correo.encolado', { tipo, reserva: row?.codigo });
    return added;
  };

  const ownerNotice = (tipo, key, row, data, ts) => {
    if (!ownerEnabled) { log.warn('correo.dueno_no_configurado', { tipo, reserva: row.codigo }); return; }
    push('aviso_dueno', key, row, env.OWNER_EMAIL, data, ts);
  };

  return {
    ownerEnabled,

    confirmacion(row, token, ts) {
      const data = { ...common(row), gestionUrl: manageUrl(row.codigo, token), consultaUrl: manageUrl(row.codigo) };
      push('confirmacion', `confirmacion:${row.codigo}`, row, fc.decrypt(row.correo_enc), data, ts);
    },

    /** Cambio de fecha/hora: avisa al cliente y al dueño (si hay correo del dueño configurado). */
    cambio(row, antes, ts) {
      const data = { ...common(row), antes: { fechaLarga: fmtFechaLarga(antes.fecha), inicio: fmtHora(antes.inicio_min), fin: fmtHora(antes.fin_min) }, consultaUrl: manageUrl(row.codigo) };
      push('cambio', `cambio:${row.codigo}:${row.cambios}`, row, fc.decrypt(row.correo_enc), data, ts);
      ownerNotice('cambio', `aviso:${row.codigo}:cambio:${row.cambios}`, row, {
        ...common(row), telefono: fc.decrypt(row.telefono_enc), accion: 'cambió su cita',
        antes: `${fmtFechaLarga(antes.fecha)}, ${fmtHora(antes.inicio_min)} – ${fmtHora(antes.fin_min)}`,
        ahora: `${fmtFechaLarga(row.fecha)}, ${fmtHora(row.inicio_min)} – ${fmtHora(row.fin_min)}`,
      }, ts);
    },

    /** `actor`: 'cliente' (avisa también al dueño) o 'dueno' (avisa solo al cliente). */
    cancelacion(row, actor, ts) {
      push('cancelacion', `cancelacion:${row.codigo}`, row, fc.decrypt(row.correo_enc), { ...common(row), por: actor }, ts);
      if (actor === 'cliente') {
        ownerNotice('cancelacion', `aviso:${row.codigo}:cancelacion`, row, {
          ...common(row), telefono: fc.decrypt(row.telefono_enc), accion: 'canceló su cita',
          antes: `${fmtFechaLarga(row.fecha)}, ${fmtHora(row.inicio_min)} – ${fmtHora(row.fin_min)}`, ahora: null,
        }, ts);
      }
    },

    /** Segunda verificación: el cliente pidió cancelar. La cita NO cambia hasta que abra el enlace y confirme. */
    confirmarCancelacion(row, token, expiraEn, ts) {
      return push('confirmar_cancelacion', `confcancel:${row.codigo}:${sha256(token).slice(0, 12)}`, row, fc.decrypt(row.correo_enc),
        { ...common(row), confirmUrl: confirmUrl(row.codigo, token), expira: expiraTexto(expiraEn, ts) }, ts);
    },

    confirmarCambio(row, nueva, token, expiraEn, ts) {
      return push('confirmar_cambio', `confcambio:${row.codigo}:${sha256(token).slice(0, 12)}`, row, fc.decrypt(row.correo_enc),
        { ...common(row), nueva, confirmUrl: confirmUrl(row.codigo, token), expira: expiraTexto(expiraEn, ts) }, ts);
    },

    resumenDueno(fecha, texto, ts) {
      if (!ownerEnabled) return false;
      return push('resumen_dueno', `resumen:${fecha}`, null, env.OWNER_EMAIL, { fecha, fechaLarga: fmtFechaLarga(fecha), texto, empresa }, ts);
    },
  };
}
