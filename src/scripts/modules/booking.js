import { $, $$, esc, scrollToEl } from '../utils/dom.js';
import { MESES, fmtDate, isClosed } from '../utils/time.js';
import { CLOSE_MIN, SERVICES, VEHICLE_NAMES, WHATSAPP, priceOf } from '../data/services.js';
import { ApiError, api, newIdempotencyKey } from '../api/client.js';
import { onChange } from '../api/live.js';

/**
 * Flujo de reserva. TODA la disponibilidad sale del servidor (base de datos real) y toda reserva se confirma allí;
 * esta página solo muestra, valida lo básico para ayudar al usuario y envía. El servidor repite y decide cada validación.
 *
 *   Paso 1 Servicio (vehículo + servicio) → Paso 2 Día y hora → Paso 3 Datos → Confirmación
 *   Al cambiar una cita (desde "Mi reserva") se salta directo al Paso 2 y se guarda el cambio ahí.
 */
const STEP_NAMES = ['Servicio', 'Día y hora', 'Tus datos'];
const POLL_MS = 20_000;

const state = {
  step: 1, vehicle: null, service: null,
  date: null, time: null, month: null /* 'AAAA-MM' */, monthData: null, dayData: null,
  editing: null /* { creds, codigo } */, idemKey: null, idemSig: null, busy: false,
  config: { whatsapp: WHATSAPP, ventana: null },
};

let panel, steps, progress, nextBtn, backBtn, pollTimer;
const wa = (text) => `https://wa.me/${state.config.whatsapp}?text=${encodeURIComponent(text)}`;

/* ───────── render general ───────── */
const totalSteps = () => 3;
function isStepValid() {
  if (state.busy) return false;
  switch (state.step) {
    case 1: return !!(state.vehicle && state.service);
    case 2: return !!(state.date && state.time && !state.dayData?.agotado);
    case 3: return !isClosed();
    default: return false;
  }
}

function chosenHour() { return state.dayData?.horas?.find((h) => h.valor === state.time); }

function localSummary() {
  const h = chosenHour(), p = priceOf(state.vehicle, state.service), s = SERVICES[state.service];
  return `<div><b>${esc(VEHICLE_NAMES[state.vehicle])}</b> · ${esc(s.name)}</div>` +
         `<div>${esc(fmtDate(state.date))} · ${esc(h?.inicio ?? '')} – ${esc(h?.fin ?? '')}</div>` +
         `<div>Duración ${esc(s.dur)} · <b>${esc(p.text)}</b></div>`;
}

export function summaryFromReserva(r) {
  return `<div><b>${esc(r.vehiculoNombre)}</b> · ${esc(r.servicio.nombre)}</div>` +
         `<div>${esc(r.fechaLarga)} · ${esc(r.inicio)} – ${esc(r.fin)}</div>` +
         `<div><b>${esc(r.precio.texto)}</b>${r.lugar ? ` · 📍 ${esc(r.lugar)}` : ''}</div>`;
}

function render() {
  const { step } = state;
  steps.forEach((s) => s.classList.toggle('on', +s.dataset.s === step));
  progress.forEach((p, i) => p.classList.toggle('on', step === 4 || i < step));
  $('#plabel').innerHTML = step === 4 ? '¡Listo! · <b>Confirmación</b>' : state.editing ? 'Cambiar tu cita · <b>Día y hora</b>' : `Paso ${step} de ${totalSteps()} · <b>${STEP_NAMES[step - 1]}</b>`;
  $('#dayTitle').textContent = state.editing ? 'Escoge el nuevo día y hora' : 'Día y hora';
  $('#bnav').hidden = step === 4;
  backBtn.hidden = step === 1;
  backBtn.textContent = state.editing && step === 2 ? 'Cancelar cambio' : 'Atrás';
  const last = state.editing ? step === 2 : step === 3;
  nextBtn.textContent = state.busy ? 'Guardando…' : last ? (state.editing ? 'Guardar cambio' : 'Confirmar cita') : 'Continuar';
  nextBtn.disabled = !isStepValid();
  if (step === 3) { $('#sum3').innerHTML = localSummary(); $('#closedMsg').hidden = !isClosed(); }
}

const goTo = (n) => { state.step = n; hideMsg(); render(); scrollToEl(panel); if (n === 2) startPolling(); else stopPolling(); };

function showMsg(el, html) { el.innerHTML = html; el.hidden = false; }
function hideMsg() { $('#bookErr').hidden = true; $('#slotMsg').hidden = true; }

/* ───────── paso 1: servicio ───────── */
function buildServices() {
  const box = $('#optS');
  if (!state.vehicle) { box.innerHTML = ''; return; }
  box.innerHTML = [1, 2].map((s) => {
    const p = priceOf(state.vehicle, s);
    return `<button class="opt" data-s="${s}" aria-pressed="${state.service === s}">
      <div><strong>${esc(SERVICES[s].name)}${s === 2 ? ' ★' : ''}</strong><span class="d">${esc(SERVICES[s].dur)} · ${esc(SERVICES[s].inc)}</span></div>
      <span class="p">${esc(p.text)}</span></button>`;
  }).join('');
}

/* ───────── paso 2: calendario y horas (disponibilidad real) ───────── */
const monthKey = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`;
const parseMonth = (k) => { const [y, m] = k.split('-').map(Number); return { y, m: m - 1 }; };

function ensureMonth() {
  if (state.month) return;
  const first = state.config.ventana?.desde;
  if (first) state.month = first.slice(0, 7);
  else { const d = new Date(Date.now() - 4 * 3600e3); d.setUTCDate(d.getUTCDate() + 1); state.month = monthKey(d.getUTCFullYear(), d.getUTCMonth()); }
}

async function loadMonth({ silent = false } = {}) {
  ensureMonth();
  const key = state.month;
  if (!silent) buildCalendar(); // primero la cuadrícula vacía; los días se habilitan cuando llegan los datos (en las actualizaciones en vivo no se vacía)
  try {
    const data = await api.month(state.service, key);
    if (key !== state.month) return; // el usuario ya cambió de mes
    state.monthData = data.dias; buildCalendar();
  } catch (err) { showMsg($('#slotMsg'), esc(err.message)); }
}

function buildCalendar() {
  const { y, m } = parseMonth(state.month);
  $('#calTitle').textContent = `${MESES[m]} ${y}`;
  const v = state.config.ventana;
  $('#calPrev').disabled = !!v && state.month <= v.desde.slice(0, 7);
  $('#calNext').disabled = !!v && state.month >= v.hasta.slice(0, 7);
  let html = ['D', 'L', 'M', 'M', 'J', 'V', 'S'].map((d) => `<div class="dow">${d}</div>`).join('');
  const lead = new Date(Date.UTC(y, m, 1)).getUTCDay(), days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  for (let i = 0; i < lead; i++) html += '<button class="day empty" disabled tabindex="-1"></button>';
  for (let d = 1; d <= days; d++) {
    const fecha = `${state.month}-${String(d).padStart(2, '0')}`;
    const info = state.monthData?.[fecha];
    const open = info && (info.estado === 'disponible' || info.estado === 'agotado');
    const sold = info?.estado === 'agotado';
    html += `<button class="day${sold ? ' sold' : ''}" data-d="${fecha}" ${open ? '' : 'disabled'} aria-pressed="${state.date === fecha}" aria-label="${esc(fmtDate(fecha))}${sold ? ', sin disponibilidad' : ''}">${d}</button>`;
  }
  $('#cal').innerHTML = html;
}

async function loadDay({ silent = false } = {}) {
  if (!state.date) return;
  const fecha = state.date;
  try {
    const data = state.editing ? await api.ownDay(state.editing.creds, fecha) : await api.day(state.service, fecha);
    if (fecha !== state.date) return;
    const had = state.time;
    state.dayData = data;
    if (had && !data.horas.some((h) => h.valor === had)) {
      state.time = null;
      showMsg($('#slotMsg'), 'Ese horario se ocupó mientras elegías. Escoge otro, por favor.');
    }
    buildTimes(); render();
  } catch (err) {
    if (!silent) showMsg($('#slotMsg'), esc(err.message));
  }
}

function buildTimes() {
  const box = $('#timesBox'), d = state.dayData;
  if (!state.date || !d) { box.hidden = true; return; }
  box.hidden = false;
  $('#timesT').textContent = `Horas libres · ${fmtDate(state.date)}`;
  // Explica por qué la lista no llega hasta las 5:00 p. m.: el servicio debe TERMINAR a la hora de cierre
  const svc = SERVICES[state.service];
  const closeMin = state.config?.horario?.cierreMin ?? CLOSE_MIN; // el propietario puede cambiar el horario
  const clock = (min) => { const h = Math.floor(min / 60), m = String(min % 60).padStart(2, '0'); return `${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'a. m.' : 'p. m.'}`; };
  $('#timesNote').textContent = svc ? `Este servicio dura ${svc.dur} y terminamos a las ${clock(closeMin)}. Por eso la última cita empieza a las ${clock(closeMin - svc.min)}` : '';
  const sold = $('#soldOut');
  sold.hidden = !d.agotado;
  if (d.agotado) $('#soldOutWa').href = d.whatsapp?.url ?? wa(`Hola, quisiera consultar si hay disponibilidad el ${state.date}.`);
  $('#times').innerHTML = d.agotado ? '' : (d.horas.length
    ? d.horas.map((h) => `<button class="time" data-t="${esc(h.valor)}" aria-pressed="${state.time === h.valor}">${esc(h.inicio)}</button>`).join('')
    : '<p class="empty-msg">Ese día no se puede reservar en línea. Para el mismo día, escríbenos por WhatsApp.</p>');
}

/** Refresca la disponibilidad cada 20 s mientras el cliente está eligiendo (otros clientes pueden estar reservando). */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.hidden || state.step !== 2) return;
    loadMonth({ silent: true }); loadDay({ silent: true });
  }, POLL_MS);
}
function stopPolling() { clearInterval(pollTimer); }

/* ───────── paso 3: datos ───────── */
const FIELD_IDS = { nombre: '#fn', telefono: '#ph', correo: '#em', lugar: '#pl', modelo: '#mm' };

function readForm() {
  return { nombre: $('#fn').value.trim(), telefono: $('#ph').value.trim(), correo: $('#em').value.trim(), lugar: $('#pl').value.trim(), modelo: $('#mm').value.trim() };
}

function checkForm(v) {
  const bad = {};
  if (v.nombre.split(/\s+/).filter(Boolean).length < 2 || v.nombre.length < 3) bad.nombre = 'Escribe tu nombre y apellido.';
  if (v.telefono.replace(/\D/g, '').length < 10 || v.telefono.replace(/\D/g, '').length > 11) bad.telefono = 'Escribe un celular de 10 dígitos.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.correo)) bad.correo = 'Escribe un correo válido.';
  if (v.lugar.length < 3) bad.lugar = 'Dinos dónde será el servicio.';
  return bad;
}

function markFields(bad) {
  for (const [name, id] of Object.entries(FIELD_IDS)) {
    const input = $(id), field = input.closest('.field');
    field.classList.toggle('bad', !!bad[name]);
    if (bad[name]) $('.err', field).textContent = bad[name];
  }
  const first = Object.keys(bad).map((k) => FIELD_IDS[k]).find(Boolean);
  if (first) $(first).focus();
}

/* ───────── enviar ───────── */
async function submitBooking() {
  const form = readForm(), bad = checkForm(form);
  markFields(bad);
  if (Object.keys(bad).length) return;
  if (isClosed()) { $('#closedMsg').hidden = false; return; }

  const payload = { servicioId: state.service, vehiculo: state.vehicle, fecha: state.date, hora: state.time, ...form, modelo: form.modelo || undefined };
  // La misma clave se reutiliza mientras los datos no cambien: un reintento NUNCA crea una segunda reserva
  const sig = JSON.stringify(payload);
  if (state.idemSig !== sig) { state.idemKey = newIdempotencyKey(); state.idemSig = sig; }

  state.busy = true; hideMsg(); render();
  try {
    const res = await api.create(payload, state.idemKey);
    state.idemKey = state.idemSig = null;
    showDone(res.reserva, { updated: false, email: res.reserva.correo, mail: res.correo?.estado });
  } catch (err) {
    handleError(err);
  } finally {
    state.busy = false; render();
  }
}

async function submitReschedule() {
  state.busy = true; hideMsg(); render();
  try {
    // El cambio NO se aplica todavía: se envía un correo y la cita cambia cuando el cliente lo confirma
    showPending(await api.reschedule(state.editing.creds, state.date, state.time));
  } catch (err) {
    handleError(err);
  } finally {
    state.busy = false; render();
  }
}

function handleError(err) {
  if (!(err instanceof ApiError)) { showMsg($('#bookErr'), 'Ocurrió un error inesperado. Inténtalo de nuevo.'); return; }
  const box = state.step === 3 ? $('#bookErr') : $('#slotMsg');
  switch (err.code) {
    case 'HORARIO_NO_DISPONIBLE':
      // Otro cliente se quedó con ese horario justo antes: se vuelve a las horas libres, ya actualizadas
      state.time = null; state.idemKey = state.idemSig = null;
      goTo(2); loadMonth(); loadDay();
      showMsg($('#slotMsg'), '<b>Ese horario ya no está disponible.</b> Otra persona lo reservó hace un momento. Escoge otra hora.');
      break;
    case 'DATOS_INVALIDOS': {
      const fields = err.data?.campos ?? {};
      const mapped = Object.fromEntries(Object.entries(fields).filter(([k]) => FIELD_IDS[k]));
      if (Object.keys(mapped).length) { markFields(mapped); showMsg($('#bookErr'), 'Revisa los datos marcados.'); }
      else showMsg(box, esc(err.message));
      break;
    }
    case 'FUERA_DE_PLAZO': case 'AGENDA_CERRADA':
      showMsg(box, `${esc(err.message)} <a class="underline" target="_blank" rel="noopener" href="${esc(err.data?.whatsapp ?? wa('Hola, necesito ayuda con mi reserva.'))}">Escribir por WhatsApp</a>`);
      break;
    case 'FECHA_NO_PERMITIDA':
      showMsg($('#slotMsg'), esc(err.message)); goTo(2);
      break;
    default:
      showMsg(box, esc(err.message));
  }
}

function showPending(res) {
  const r = res.reserva;
  $('#doneEy').textContent = 'Falta un paso: confirma el cambio en tu correo';
  $('#bcode').textContent = r.codigo;
  $('#sum4').innerHTML = `<div><b>Nuevo horario solicitado</b></div><div>${esc(res.nueva.fechaLarga)} · ${esc(res.nueva.inicio)} – ${esc(res.nueva.fin)}</div>
    <div class="note">Tu cita sigue como estaba (${esc(r.fechaLarga)} · ${esc(r.inicio)} – ${esc(r.fin)}) hasta que confirmes.</div>`;
  $('#mailNote').textContent = `Te enviamos un correo a ${res.correo ?? 'tu correo'}. Ábrelo y pulsa «Sí, cambiar mi cita» para terminar. El enlace vence en ${Math.round(res.venceEnMin / 60)} horas.`;
  $('#spamNote').hidden = false;
  $('#waSave').href = wa(`Hola Orama’s Detailing 👋 Quiero cambiar mi reserva ${r.codigo}`);
  state.editing = null;
  stopPolling();
  state.step = 4; render(); scrollToEl(panel);
}

function showDone(r, { updated, email, mail }) {
  $('#doneEy').textContent = updated ? '¡Cita actualizada!' : '¡Cita confirmada!';
  $('#bcode').textContent = r.codigo;
  $('#sum4').innerHTML = summaryFromReserva(r);
  // Solo se dice que se envía correo si el servidor realmente puede enviarlo
  $('#mailNote').textContent = mail === 'sin_configurar'
    ? 'Tu cita ya está guardada. Por ahora no podemos enviar correos de confirmación: guarda tu número de reserva, o envíatelo por WhatsApp con el botón de abajo.'
    : email
      ? `Te estamos enviando un correo a ${email} con los detalles y los enlaces para consultar, cambiar o cancelar tu cita. `
      : '';
  // Aviso visible: los primeros correos de una cuenta nueva pueden caer en spam
  $('#spamNote').hidden = mail === 'sin_configurar' || !email;
  const msg = `Hola Orama’s Detailing 👋 Mi reserva: ${r.codigo}\n${r.vehiculoNombre} · ${r.servicio.nombre}\n${r.fechaLarga} · ${r.inicio} – ${r.fin}\nPrecio: ${r.precio.texto}`;
  $('#waSave').href = wa(msg);
  state.editing = null;
  stopPolling();
  state.step = 4; render(); scrollToEl(panel);
}

/* ───────── reinicio y atajos desde otras secciones ───────── */
function reset() {
  Object.assign(state, { step: 1, vehicle: null, service: null, date: null, time: null, month: null, monthData: null, dayData: null, editing: null, idemKey: null, idemSig: null, busy: false });
  $('#form').reset(); $$('.field.bad').forEach((f) => f.classList.remove('bad'));
  $$('#optV .opt').forEach((o) => o.setAttribute('aria-pressed', false));
  $('#optS').innerHTML = ''; $('#timesBox').hidden = true; hideMsg(); stopPolling();
  render();
}

function jumpToCalendar() {
  $$('#optV .opt').forEach((o) => o.setAttribute('aria-pressed', o.dataset.v === state.vehicle));
  buildServices(); state.month = null; state.monthData = null; state.dayData = null;
  loadMonth(); goTo(2);
  scrollToEl($('#reservar'));
}

/** Desde las tarjetas de precios: ya trae vehículo y servicio. */
export function startFromCard(vehicle, service) {
  reset(); Object.assign(state, { vehicle, service }); jumpToCalendar();
}

/** Desde "Mi reserva": cambiar fecha u hora de una cita ya hecha (mismo servicio). */
export function startEdit(reserva, creds) {
  reset();
  Object.assign(state, { vehicle: reserva.vehiculo, service: reserva.servicio.id, editing: { creds, codigo: reserva.codigo } });
  jumpToCalendar();
}

/* ───────── eventos ───────── */
export async function initBooking() {
  // Cambios en vivo: si el propietario cierra un día o alguien reserva, el calendario y las horas se actualizan al instante
  onChange(() => {
    api.config().then((c) => { state.config.ventana = c.ventana; state.config.horario = c.horario; }).catch(() => {});
    if (state.step === 2) { loadMonth({ silent: true }); loadDay({ silent: true }); }
  });
  panel = $('#panel'); steps = $$('.bstep'); progress = $$('#prog i'); nextBtn = $('#next'); backBtn = $('#back');

  api.config().then((c) => { state.config.whatsapp = c.whatsapp; state.config.ventana = c.ventana; state.config.correoActivo = c.correoActivo; state.config.horario = c.horario; }).catch(() => { /* se usan los valores por defecto */ });

  $('#optV').addEventListener('click', (e) => {
    const b = e.target.closest('.opt'); if (!b) return;
    state.vehicle = b.dataset.v;
    if (state.service && !SERVICES[state.service]) state.service = null;
    $$('#optV .opt').forEach((o) => o.setAttribute('aria-pressed', o === b));
    buildServices(); render();
  });
  $('#optS').addEventListener('click', (e) => {
    const b = e.target.closest('.opt'); if (!b) return;
    Object.assign(state, { service: +b.dataset.s, date: null, time: null, dayData: null, monthData: null });
    $$('#optS .opt').forEach((o) => o.setAttribute('aria-pressed', o === b)); render();
  });

  const shiftMonth = (delta) => {
    const { y, m } = parseMonth(state.month), d = new Date(Date.UTC(y, m + delta, 1));
    state.month = monthKey(d.getUTCFullYear(), d.getUTCMonth()); state.monthData = null; loadMonth();
  };
  $('#calPrev').onclick = () => shiftMonth(-1);
  $('#calNext').onclick = () => shiftMonth(1);
  $('#cal').addEventListener('click', (e) => {
    const b = e.target.closest('.day[data-d]'); if (!b || b.disabled) return;
    Object.assign(state, { date: b.dataset.d, time: null, dayData: null });
    $('#slotMsg').hidden = true; buildCalendar(); buildTimes(); render();
    loadDay().then(() => scrollToEl($('#timesBox'), 'nearest'));
  });
  $('#times').addEventListener('click', (e) => {
    const b = e.target.closest('.time'); if (!b) return;
    state.time = b.dataset.t; $('#slotMsg').hidden = true;
    $$('#times .time').forEach((o) => o.setAttribute('aria-pressed', o === b)); render();
  });

  nextBtn.addEventListener('click', () => {
    if (state.step === 1) { loadMonth(); return goTo(2); }
    if (state.step === 2) return state.editing ? submitReschedule() : goTo(3);
    if (state.step === 3) return submitBooking();
  });
  backBtn.addEventListener('click', () => {
    if (state.editing && state.step === 2) { reset(); scrollToEl($('#mi-reserva')); return; }
    goTo(state.step - 1);
  });
  $('#again').addEventListener('click', () => { reset(); scrollToEl(panel); });
  $$('.field input').forEach((i) => i.addEventListener('input', () => i.closest('.field').classList.remove('bad')));
  $$('#form input').forEach((i) => i.addEventListener('input', () => { $('#bookErr').hidden = true; }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.step === 2) { loadMonth(); loadDay({ silent: true }); } });

  render();
  setInterval(() => { if (state.step === 3) render(); }, 60_000); // actualiza el aviso de agenda cerrada
}
