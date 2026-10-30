import { $, esc, scrollToEl } from '../utils/dom.js';
import { WHATSAPP } from '../data/services.js';
import { ApiError, api } from '../api/client.js';
import { startEdit, summaryFromReserva } from './booking.js';

/**
 * "Mi reserva": consultar, cambiar o cancelar una cita con el número de reserva + el celular
 * (o con el enlace personal que llega en el correo de confirmación).
 * El servidor valida cada acción; aquí solo se muestran los resultados. Nunca se muestran teléfono ni correo completos.
 */
const REASONS = {
  FUERA_DE_PLAZO: 'Ya falta muy poco para tu cita, así que no se puede cambiar o cancelar desde aquí.',
  AGENDA_CERRADA: 'La agenda está cerrada de 11:00 p.m. a 6:00 a.m. Podrás gestionar tu cita a partir de las 6:00 a.m.',
  NO_ACTIVA: 'Esta reserva ya no está activa.',
};
const STATES = { confirmada: 'Confirmada', cancelada: 'Cancelada', completada: 'Realizada', no_llego: 'No se presentó' };

export function initLookup() {
  const box = $('#found'), form = $('#lookup');
  let creds = null; // credenciales de ESTA consulta (solo en memoria, nunca se guardan en el navegador)

  const waHelp = (code) => `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(`Hola, necesito ayuda con mi reserva ${code}`)}`;

  function show(r) {
    const active = r.estado === 'confirmada';
    let actions = '';
    if (active && r.puedeGestionar) {
      actions = `<div class="row"><button class="btn btn-red" id="chg" type="button">Cambiar fecha u hora</button><button class="btn btn-outline" id="cnl" type="button">Cancelar cita</button></div>`;
    } else if (active) {
      actions = `<div class="alert">${esc(REASONS[r.motivoNoGestion] ?? REASONS.FUERA_DE_PLAZO)}</div>
        <p class="mt-3"><a class="btn btn-outline" target="_blank" rel="noopener" href="${esc(waHelp(r.codigo))}">Escribir por WhatsApp</a></p>`;
    }
    box.innerHTML = `<div class="summary"><div><b>${esc(r.codigo)}</b> · ${esc(STATES[r.estado] ?? r.estado)}</div><div>${esc(r.nombre ?? '')}</div></div>
      <div class="summary">${summaryFromReserva(r)}</div>` + actions;
    $('#chg')?.addEventListener('click', () => startEdit(r, creds));
    $('#cnl')?.addEventListener('click', () => askCancel(r));
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function fail(err) {
    box.innerHTML = `<div class="alert" role="alert">${esc(err instanceof ApiError ? err.message : 'Ocurrió un error. Inténtalo de nuevo.')}</div>`;
  }

  async function consult() {
    box.innerHTML = '<p class="note">Buscando tu cita…</p>';
    try { show((await api.lookup(creds)).reserva); } catch (err) { fail(err); }
  }

  /** Segunda verificación: antes de enviar nada se le pregunta de nuevo al cliente (dentro de la página, no con una ventana del navegador). */
  function askCancel(r) {
    box.innerHTML = `<div class="alert" role="alertdialog" aria-labelledby="cx-t"><b id="cx-t">¿Seguro que quieres cancelar tu cita?</b>
      <p class="mt-2">${esc(r.fechaLarga)} · ${esc(r.inicio)} – ${esc(r.fin)}</p>
      <p class="mt-2">Te enviaremos un correo a <b>${esc(r.correo ?? 'la dirección de tu reserva')}</b> para que lo confirmes. <b>Tu cita sigue activa hasta que lo hagas.</b></p></div>
      <div class="row"><button class="btn btn-red" id="cx-yes" type="button">Sí, enviar correo de confirmación</button><button class="btn btn-outline" id="cx-no" type="button">No, mantener mi cita</button></div>`;
    $('#cx-no').addEventListener('click', () => show(r));
    $('#cx-yes').addEventListener('click', () => sendCancel(r));
    $('#cx-yes').focus({ preventScroll: true });
  }

  function pendingBox(res, verb) {
    box.innerHTML = `<div class="summary"><div><b>Revisa tu correo</b></div>
      <div>Enviamos un mensaje a <b>${esc(res.correo ?? 'tu correo')}</b>. Ábrelo y pulsa el botón para confirmar ${esc(verb)}.</div></div>
      <p class="note">Tu cita sigue activa hasta que confirmes. El enlace vence en ${Math.round(res.venceEnMin / 60)} horas y se puede usar una sola vez.</p>
      <p class="note"><b>¿No lo ves?</b> Revisa la carpeta de <b>spam o correo no deseado</b> y márcalo como «No es spam».</p>`;
  }

  async function sendCancel(r) {
    const btn = $('#cx-yes'); if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
    try {
      pendingBox(await api.cancel(creds), 'la cancelación');
    } catch (err) {
      if (err instanceof ApiError && ['FUERA_DE_PLAZO', 'AGENDA_CERRADA', 'CORREO_NO_DISPONIBLE'].includes(err.code)) {
        box.innerHTML = `<div class="alert" role="alert">${esc(err.message)}</div><p class="mt-3"><a class="btn btn-outline" target="_blank" rel="noopener" href="${esc(waHelp(r.codigo))}">Escribir por WhatsApp</a></p>`;
      } else fail(err);
    }
  }

  /** Enlace del correo (#confirmar/CÓDIGO/TOKEN): primero se muestra qué se va a hacer y recién al pulsar el botón se ejecuta. */
  async function handleConfirm(codigo, token) {
    box.innerHTML = '<p class="note">Verificando el enlace…</p>';
    try {
      const p = await api.preview(codigo, token);
      const r = p.reserva, isCancel = p.accion === 'cancelar';
      box.innerHTML = `<div class="alert"><b>${isCancel ? 'Confirma la cancelación de tu cita' : 'Confirma el cambio de tu cita'}</b></div>
        <div class="summary"><div><b>${esc(r.codigo)}</b> · ${isCancel ? 'Cita actual' : 'Horario actual'}</div>${summaryFromReserva(r)}</div>
        ${isCancel ? '' : `<div class="summary"><div><b>Nuevo horario</b></div><div>${esc(p.nueva.fechaLarga)} · ${esc(p.nueva.inicio)} – ${esc(p.nueva.fin)}</div></div>`}
        <div class="row"><button class="btn btn-red" id="ac-yes" type="button">${isCancel ? 'Sí, cancelar mi cita' : 'Sí, cambiar mi cita'}</button><button class="btn btn-outline" id="ac-no" type="button">${isCancel ? 'No, mantener mi cita' : 'No, dejarla como está'}</button></div>`;
      $('#ac-no').addEventListener('click', () => { box.innerHTML = '<p class="note">Listo, no se hizo ningún cambio. Tu cita sigue como estaba.</p>'; });
      $('#ac-yes').addEventListener('click', async () => {
        const btn = $('#ac-yes'); btn.disabled = true; btn.textContent = 'Un momento…';
        try {
          const done = await api.confirm(codigo, token);
          box.innerHTML = done.accion === 'cancelar'
            ? `<div class="summary"><div><b>Tu cita fue cancelada</b></div><div>${esc(done.reserva.codigo)} · ${esc(done.reserva.fechaLarga)}</div></div><p class="note">El horario quedó libre. Te enviamos un correo con la confirmación. Cuando quieras, puedes agendar de nuevo.</p>`
            : `<div class="summary"><div><b>Tu cita quedó actualizada</b></div>${summaryFromReserva(done.reserva)}</div><p class="note">Te enviamos un correo con el nuevo horario.</p>`;
        } catch (err) {
          const needHelp = err instanceof ApiError && ['FUERA_DE_PLAZO', 'AGENDA_CERRADA', 'ENLACE_VENCIDO', 'HORARIO_NO_DISPONIBLE'].includes(err.code);
          box.innerHTML = `<div class="alert" role="alert">${esc(err instanceof ApiError ? err.message : 'Ocurrió un error. Inténtalo de nuevo.')}${err?.code === 'HORARIO_NO_DISPONIBLE' ? ' Tu cita original se mantiene.' : ''}</div>`
            + (needHelp ? `<p class="mt-3"><a class="btn btn-outline" target="_blank" rel="noopener" href="${esc(waHelp(codigo))}">Escribir por WhatsApp</a></p>` : '');
        }
      });
    } catch (err) { fail(err); }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const codigo = $('#lc').value.trim(), telefono = $('#lp').value.trim();
    $('#lc').closest('.field').classList.toggle('bad', !codigo);
    const badPhone = telefono.replace(/\D/g, '').length < 10;
    $('#lp').closest('.field').classList.toggle('bad', badPhone);
    if (!codigo || badPhone) return;
    creds = { codigo, telefono };
    consult();
  });

  // Enlace de confirmación del correo: #confirmar/OR-XXXXXX/TOKEN (se quita de la barra de direcciones apenas se lee)
  const c = /^#confirmar\/(OR-[A-Z0-9]{6})\/([\w-]{20,64})$/.exec(location.hash);
  if (c) {
    history.replaceState(null, '', `${location.pathname}${location.search}#mi-reserva`);
    scrollToEl($('#mi-reserva'));
    handleConfirm(c[1], c[2]);
    return;
  }

  // Enlace personal del correo: #mi-reserva/OR-XXXXXX/TOKEN (el token va en el fragmento y no llega a ningún servidor ni registro)
  const m = /^#mi-reserva\/(OR-[A-Z0-9]{6})(?:\/([\w-]{20,64}))?$/.exec(location.hash);
  if (m) {
    $('#lc').value = m[1];
    history.replaceState(null, '', `${location.pathname}${location.search}#mi-reserva`); // se quita el token de la barra de direcciones
    scrollToEl($('#mi-reserva'));
    if (m[2]) { creds = { codigo: m[1], token: m[2] }; consult(); }
    else $('#lp').focus({ preventScroll: true });
  }
}
