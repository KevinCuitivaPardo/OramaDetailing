import '../styles/main.css';
import './admin.css';
import { onChange } from '../scripts/api/live.js';

// Panel del propietario. Todo el contenido se construye con nodos de texto (nunca con HTML dinámico): lo que llegue de la API no
// puede ejecutar código. Se entra con la contraseña del propietario; el servidor entrega una sesión de 8 horas que vive solo en
// esta pestaña (sessionStorage) y viaja en la cabecera Authorization. La contraseña no se guarda en ningún lado de la página.

const app = document.getElementById('app');
const KEY = 'orama-sesion-admin';
let token = '';
try { token = sessionStorage.getItem(KEY) ?? ''; } catch { /* sin almacenamiento */ }

/* ───────── utilidades ───────── */
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}
/** Reemplaza el contenido de un nodo ignorando null/false. */
function fill(node, ...kids) { node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false)); }
const alert = (text, kind = '') => el('div', { class: `alert ap-msg ${kind}` }, text);
const field = (label, input) => el('div', { class: 'field' }, el('span', {}, label), input);
const pad = (n) => String(n).padStart(2, '0');
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const fmtTs = (iso) => new Date(iso).toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico', dateStyle: 'medium', timeStyle: 'short' });
const todayStr = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10); // hora de Puerto Rico
const addDays = (s, n) => new Date(Date.parse(`${s}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const longDate = (s) => { const t = new Date(`${s}T12:00:00Z`).toLocaleDateString('es-PR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); return t[0].toUpperCase() + t.slice(1); };
const h12 = (min) => { const h = Math.floor(min / 60); return `${((h + 11) % 12) + 1}:${pad(min % 60)} ${h < 12 ? 'a. m.' : 'p. m.'}`; };
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
/** <select> con horas cada 30 min (valor "HH:MM", texto en formato de 12 horas). */
function timeSelect(value, { from = 6 * 60, to = 23 * 60 } = {}) {
  const s = el('select', {});
  for (let m = from; m <= to; m += 30) s.append(el('option', { value: hhmm(m), selected: hhmm(m) === value }, h12(m)));
  return s;
}

async function api(method, path, body, { auth = true } = {}) {
  const res = await fetch(`/api/admin${path}`, {
    method, cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (auth && (res.status === 401 || res.status === 404)) { logout('Tu sesión terminó. Entra de nuevo.'); throw new Error('Sesión terminada'); }
  if (!res.ok) throw new Error(res.status === 429 ? 'Demasiados intentos. Espera unos minutos.' : (json?.error?.message ?? `Error ${res.status}`));
  return json;
}
function saveSession(s) { token = s.token; try { sessionStorage.setItem(KEY, token); } catch { /* nada */ } }
function logout(msg) { token = ''; try { sessionStorage.removeItem(KEY); } catch { /* nada */ } renderLogin(msg); }
const logo = () => el('span', { class: 'ap-logo' }, 'Orama’s ', el('em', {}, 'Detailing'));

/* ───────── entrada ───────── */
function renderLogin(message) {
  const input = el('input', { type: 'password', id: 'pw', autocomplete: 'current-password', placeholder: 'Tu contraseña' });
  const msg = el('div'); if (message) fill(msg, alert(message));
  const btn = el('button', { class: 'btn btn-red btn-block', type: 'button' }, 'Entrar');
  const go = async () => {
    btn.disabled = true;
    try { saveSession(await api('POST', '/login', { password: input.value }, { auth: false })); input.value = ''; renderShell(); }
    catch (e) { fill(msg, alert(e.message === 'No autorizado.' ? 'Contraseña incorrecta.' : e.message)); btn.disabled = false; input.select(); }
  };
  btn.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  fill(app, el('div', { class: 'login-wrap' }, el('div', { class: 'login-card' },
    el('div', { class: 'ap-logo', style: 'margin-bottom:18px;color:var(--ink)' }, 'Orama’s ', el('em', { style: 'color:var(--color-orama)' }, 'Detailing')),
    el('h1', {}, 'Hola de nuevo'), el('p', {}, 'Entra para ver tu agenda y manejar tus horarios.'),
    // Campo de usuario oculto: permite que el navegador o el gestor de contraseñas guarde la contraseña y no se escriba a mano
    el('input', { type: 'text', name: 'username', value: 'propietario', autocomplete: 'username', 'aria-hidden': 'true', tabindex: '-1', style: 'position:absolute;opacity:0;height:0;width:0;pointer-events:none' }),
    el('div', { class: 'field' }, el('label', { for: 'pw' }, 'Contraseña'), input), btn, msg)));
  input.focus();
}

/* ───────── estructura ───────── */
let liveRefresh = null; // la vista abierta se actualiza cuando llega un aviso en vivo
onChange(() => { liveRefresh?.().catch(() => {}); });
const TABS = [['agenda', 'Agenda'], ['horarios', 'Horarios'], ['cuenta', 'Cuenta']];
let current = 'agenda';
function renderShell() {
  liveRefresh = null;
  const body = el('div', { class: 'ap-wrap' });
  const menu = el('nav', { class: 'ap-menu', role: 'tablist' }, TABS.map(([id, label]) => el('button', { role: 'tab', 'aria-selected': String(id === current), onclick: () => { current = id; renderShell(); } }, label)));
  const intro = { agenda: ['Tu ', 'agenda', 'Toca un día del calendario para ver sus citas, cerrarlo si no vas a trabajar o bloquear unas horas.'],
    horarios: ['Tus ', 'horarios', 'Aquí defines lo que se repite siempre: los días que trabajas, a qué hora abres y cierras y tu hora de almuerzo.'],
    cuenta: ['Tu ', 'cuenta', 'Cambia tu contraseña cuando quieras.'] }[current];
  fill(app,
    el('header', { class: 'ap-bar' }, el('div', { class: 'container-page in' }, logo(), el('button', { class: 'btn btn-outline btn-sm', onclick: () => logout() }, 'Salir'))),
    el('main', { class: 'container-page' }, el('div', { class: 'ap-head' }, el('span', { class: 'eyebrow' }, 'Panel del propietario'), el('h1', {}, intro[0], el('em', {}, intro[1])), el('p', {}, intro[2])), menu, body));
  views[current](body).catch((e) => { if (e.message !== 'Sesión terminada') fill(body, alert(e.message)); });
}

/* ───────── vistas ───────── */
const views = {
  /** Calendario del mes + detalle del día seleccionado. */
  async agenda(root) {
    let month = todayStr().slice(0, 7), selected = addDays(todayStr(), 1), monthData = {}, blocks = [], formOpen = false;
    const calBox = el('div', { class: 'ap-card ap-cal' }), dayBox = el('div');
    const monthRange = () => { const [y, m] = month.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return [`${month}-01`, `${month}-${pad(last)}`]; };

    async function loadMonth() {
      const [desde, hasta] = monthRange();
      const [cal, hr] = await Promise.all([api('GET', `/calendario?desde=${desde}&hasta=${hasta}`), api('GET', '/horario')]);
      monthData = Object.fromEntries(cal.dias.map((d) => [d.fecha, d])); blocks = hr.bloqueos;
      drawCal();
    }

    function drawCal() {
      const [y, m] = month.split('-').map(Number);
      const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), count = new Date(Date.UTC(y, m, 0)).getUTCDate(), hoy = todayStr();
      const cells = ['D', 'L', 'M', 'M', 'J', 'V', 'S'].map((d) => el('div', { class: 'dow' }, d));
      for (let i = 0; i < lead; i++) cells.push(el('button', { class: 'day empty', disabled: true, tabindex: '-1' }));
      for (let d = 1; d <= count; d++) {
        const f = `${month}-${pad(d)}`, info = monthData[f];
        const cls = ['day', info && !info.abierto ? 'shut' : '', info?.reservas ? 'has' : '', f === hoy ? 'today' : ''].filter(Boolean).join(' ');
        cells.push(el('button', { class: cls, 'aria-pressed': String(f === selected), 'aria-label': `${longDate(f)}${info?.reservas ? `, ${info.reservas} cita(s)` : ''}${info && !info.abierto ? ', cerrado' : ''}`, onclick: () => { selected = f; formOpen = false; drawCal(); drawDay(); } }, String(d)));
      }
      fill(calBox,
        el('div', { class: 'cal-head' }, el('button', { class: 'nav-btn', 'aria-label': 'Mes anterior', onclick: () => shift(-1) }, '‹'), el('b', {}, `${MESES[m - 1]} ${y}`), el('button', { class: 'nav-btn', 'aria-label': 'Mes siguiente', onclick: () => shift(1) }, '›')),
        el('div', { class: 'cal' }, cells),
        el('div', { class: 'ap-legend' }, el('span', {}, el('i'), 'Tiene citas'), el('span', {}, el('s', {}, '15'), ' Día cerrado')));
    }
    async function shift(n) { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); month = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; await loadMonth(); }

    async function drawDay() {
      const fecha = selected;
      const a = await api('GET', `/agenda?fecha=${encodeURIComponent(fecha)}`);
      if (fecha !== selected) return;
      const info = a.abierto, dow = new Date(`${fecha}T12:00:00Z`).getUTCDay(), dowName = DIAS[dow].toLowerCase(), past = fecha < todayStr();
      const msg = el('div'), actions = el('div', { style: 'margin-top:20px' });
      const reload = async () => { formOpen = false; await loadMonth(); await drawDay(); };
      const fail = (e) => fill(msg, alert(e.message));

      const resCard = (r) => {
        const row = el('div', { class: 'a' });
        const cancelBtn = () => el('button', { class: 'btn btn-danger btn-sm', onclick: askCancel }, 'Cancelar cita');
        const askCancel = () => fill(row, el('b', {}, '¿Cancelar esta cita?'), el('span', { class: 'm' }, 'Se libera el horario y se avisa al cliente por correo.'),
          el('button', { class: 'btn btn-red btn-sm', onclick: async () => { try { await api('POST', '/reservas/cancelar', { codigo: r.codigo }); await reload(); } catch (e) { fail(e); } } }, 'Sí, cancelar'),
          el('button', { class: 'btn btn-outline btn-sm', onclick: () => fill(row, cancelBtn()) }, 'No'));
        fill(row, cancelBtn());
        return el('div', { class: 'ap-res' }, el('div', { class: 't' }, el('span', {}, `${r.inicio} – ${r.fin}`), ` · ${r.nombre}`),
          el('div', { class: 'm' }, `${r.servicio} (${r.vehiculo}) · ${r.precio}`), el('div', { class: 'm' }, '📍 ', r.lugar), el('div', { class: 'm' }, '📞 ', el('a', { href: `tel:${r.telefono.replace(/[^\d+]/g, '')}` }, r.telefono), ` · ${r.codigo}`), row);
      };

      /* Horas bloqueadas que afectan a ESTE día (almuerzo, cita personal…) y formulario para agregar más */
      const rules = blocks.filter((b) => b.alcance === 'diario' || (b.alcance === 'semana' && b.diaSemana === dow) || (b.alcance === 'dia' && b.fecha === fecha));
      const scopeText = (b) => (b.alcance === 'dia' ? 'Solo este día' : b.alcance === 'semana' ? `Todos los ${dowName}` : 'Todos los días');
      const scope = el('select', {}, el('option', { value: 'dia' }, 'Solo este día'), el('option', { value: 'semana' }, `Todos los ${dowName}`), el('option', { value: 'diario' }, 'Todos los días de atención'));
      const bd = timeSelect('12:00'), bh = timeSelect('13:00'), bm = el('input', { type: 'text', maxlength: '120', placeholder: 'Ej.: almuerzo, cita personal' });
      const body = () => ({ alcance: scope.value, ...(scope.value === 'dia' ? { fecha } : {}), ...(scope.value === 'semana' ? { diaSemana: dow } : {}), desde: bd.value, hasta: bh.value, motivo: bm.value });
      const addBlock = async () => {
        try { const r = await api('POST', '/bloqueos', body()); await reload(); if (r.reservasConfirmadas) fill(msg, alert(`Bloqueado. Ojo: ${r.reservasConfirmadas} cita(s) ya existentes caen en esas horas; no se cancelaron.`)); } catch (e) { fail(e); }
      };
      const lunch = () => { scope.value = 'diario'; bd.value = '12:00'; bh.value = '13:00'; bm.value = 'Almuerzo'; };
      const hours = el('div', { style: 'margin-top:22px' },
        el('h3', { style: 'font-size:1.1rem;margin:0 0 4px' }, 'Horas bloqueadas'),
        el('p', { class: 'sub' }, 'En estas horas nadie puede reservar. Sirve para tu almuerzo, una cita personal o salir temprano. No afecta las citas que ya tengas.'),
        rules.map((b) => el('div', { class: 'ap-block' }, el('span', {}, el('b', {}, `${h12(b.desdeMin)} – ${h12(b.hastaMin)}`), ` · ${scopeText(b)}${b.motivo ? ` · ${b.motivo}` : ''}`),
          el('button', { class: 'btn btn-outline btn-sm', onclick: async () => { try { await api('DELETE', `/bloqueos/${b.id}`); await reload(); } catch (e) { fail(e); } } }, b.alcance === 'dia' ? 'Quitar' : 'Quitar de todos'))),
        !rules.length ? el('p', { class: 'sub' }, 'Este día no tiene horas bloqueadas.') : null,
        past || !info.abierto ? null : el('div', { style: 'margin-top:14px' },
          el('div', { class: 'ap-row' }, field('Aplica a', scope), field('Desde', bd), field('Hasta', bh), field('Motivo (opcional)', bm)),
          el('div', { class: 'ap-row', style: 'margin-top:12px' }, el('button', { class: 'btn btn-red btn-sm', onclick: addBlock }, 'Bloquear estas horas'), el('button', { class: 'btn btn-outline btn-sm', onclick: lunch }, 'Poner mi almuerzo (12:00 – 1:00)'))));

      /* Cerrar / abrir el día completo, con la explicación a la vista */
      function closeForm() {
        formOpen = true;
        const mo = el('input', { type: 'text', maxlength: '120', placeholder: 'Ej.: cita médica, imprevisto…' });
        fill(actions,
          el('p', { class: 'sub' }, el('b', {}, 'Si cierras este día, los clientes ya no podrán reservarlo. '), a.total ? `Ojo: ya tiene ${a.total} cita(s) y NO se cancelan solas: cancélalas arriba o avísales tú.` : 'No tiene citas.'),
          el('div', { class: 'ap-row' }, field('Motivo (opcional)', mo),
            el('button', { class: 'btn btn-red btn-sm', onclick: async () => { try { await api('PUT', '/calendario/excepciones', { fecha, tipo: 'cerrado', motivo: mo.value }); await reload(); } catch (e) { fail(e); } } }, 'Cerrar este día'),
            el('button', { class: 'btn btn-outline btn-sm', onclick: () => { formOpen = false; drawActions(); } }, 'Volver')));
      }
      function drawActions() {
        if (past) return fill(actions, el('p', { class: 'sub' }, 'Este día ya pasó.'));
        if (info.abierto && info.origen === 'excepcion') fill(actions, el('p', { class: 'sub' }, 'Abriste este día de forma especial.'), el('button', { class: 'btn btn-outline btn-sm', onclick: async () => { await api('DELETE', `/calendario/excepciones/${fecha}`); await reload(); } }, 'Quitar apertura especial'));
        else if (info.abierto) fill(actions, el('button', { class: 'btn btn-danger btn-sm', onclick: closeForm }, 'No trabajo este día'));
        else if (info.origen === 'excepcion') fill(actions, el('p', { class: 'sub' }, 'Cerraste este día. Los clientes no pueden reservarlo.'), el('button', { class: 'btn btn-red btn-sm', onclick: async () => { await api('DELETE', `/calendario/excepciones/${fecha}`); await reload(); } }, 'Volver a abrir este día'));
        else fill(actions, el('p', { class: 'sub' }, `Normalmente no atiendes los ${dowName}. Si quieres atender solo este día, ábrelo.`),
          el('button', { class: 'btn btn-red btn-sm', onclick: async () => { try { await api('PUT', '/calendario/excepciones', { fecha, tipo: 'abierto', motivo: 'Apertura especial' }); await reload(); } catch (e) { fail(e); } } }, 'Abrir este día'));
      }
      drawActions();

      fill(dayBox, el('div', { class: 'ap-card' },
        el('h2', {}, longDate(fecha)),
        el('p', { class: 'sub' }, info.abierto ? el('span', { class: 'ap-pill ok' }, 'Día de atención') : el('span', { class: 'ap-pill warn' }, `Cerrado${info.motivo ? `: ${info.motivo}` : ''}`), ` ${a.total ? `${a.total} cita(s)` : 'Sin citas'}`),
        a.reservas.map(resCard), msg, actions, hours));
    }

    // Tiempo real: si alguien reserva o el propietario cambia algo, el calendario y el día se actualizan solos (sin pisar lo que está escribiendo)
    const typing = () => dayBox.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
    liveRefresh = async () => { await loadMonth(); if (!formOpen && !typing()) await drawDay(); };

    fill(root, el('div', { class: 'ap-grid two' }, calBox, dayBox));
    await loadMonth(); await drawDay();
  },

  /** Lo que se repite siempre: días de atención, horario y almuerzo. */
  async horarios(root) {
    const [h, cal] = await Promise.all([api('GET', '/horario'), api('GET', '/calendario')]);
    const msg = el('div');
    const done = (text) => fill(msg, alert(text));
    const on = new Set(cal.diasOperacion);

    const dayBtns = DIAS.map((n, i) => el('button', { type: 'button', 'aria-pressed': String(on.has(i)), onclick: (e) => { const b = e.currentTarget; const p = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(p)); p ? on.add(i) : on.delete(i); } }, n.slice(0, 3)));
    const saveDays = async () => { try { await api('PUT', '/calendario/dias-operacion', { dias: [...on] }); done('Listo. Tus días de atención quedaron guardados.'); } catch (e) { done(e.message); } };

    const ap = timeSelect(h.apertura, { from: 6 * 60, to: 22 * 60 + 30 }), ci = timeSelect(h.cierre, { from: 6 * 60 + 30, to: 23 * 60 });
    const saveHours = async () => { try { await api('PUT', '/horario', { apertura: ap.value, cierre: ci.value }); done('Listo. Tu horario de atención quedó guardado.'); } catch (e) { done(e.message); } };

    fill(root, el('div', { class: 'ap-grid', style: 'max-width:760px' },
      el('div', {},
        el('div', { class: 'ap-card' }, el('h2', {}, '¿Qué días trabajas?'),
          el('p', { class: 'sub' }, 'Marca los días en que normalmente atiendes. Si un día suelto no puedes trabajar (por ejemplo, un miércoles), no lo quites de aquí: ve a la Agenda, toca ese día en el calendario y pulsa “No trabajo este día”.'),
          el('div', { class: 'ap-days' }, dayBtns), el('div', { class: 'ap-row', style: 'margin-top:16px' }, el('button', { class: 'btn btn-red btn-sm', onclick: saveDays }, 'Guardar días'))),
        el('div', { class: 'ap-card' }, el('h2', {}, 'Horario de atención'),
          el('p', { class: 'sub' }, 'A qué hora abres y a qué hora cierras. El cambio se ve al instante en la página de reservas. Cada servicio debe terminar antes de la hora de cierre. No cambia las citas que ya existen.'),
          el('div', { class: 'ap-row' }, field('Abrimos', ap), field('Cerramos', ci), el('button', { class: 'btn btn-red btn-sm', onclick: saveHours }, 'Guardar horario'))),
        el('div', { class: 'ap-card' }, el('h2', {}, '¿Almuerzo o una cita personal?'),
          el('p', { class: 'sub' }, 'Eso se pone en la Agenda: toca el día en el calendario y en “Horas bloqueadas” elige las horas y si aplican solo ese día, todos los miércoles (por ejemplo) o todos los días.')),
        msg)));
  },

  async cuenta(root) {
    const a = el('input', { type: 'password', autocomplete: 'current-password' }), n = el('input', { type: 'password', autocomplete: 'new-password' }), n2 = el('input', { type: 'password', autocomplete: 'new-password' });
    const msg = el('div');
    const save = async () => {
      if (n.value !== n2.value) return fill(msg, alert('Las contraseñas nuevas no coinciden.'));
      try { saveSession(await api('POST', '/password', { actual: a.value, nueva: n.value })); a.value = n.value = n2.value = ''; fill(msg, alert('Listo. Cambiaste tu contraseña; las demás sesiones abiertas se cerraron.')); }
      catch (e) { fill(msg, alert(e.message)); }
    };
    const recent = el('div');
    api('GET', '/auditoria').then((r) => {
      const rows = r.registros.filter((x) => x.accion === 'admin.login' || x.accion === 'admin.login_fallido').slice(0, 8);
      fill(recent, el('div', { class: 'ap-card', style: 'max-width:520px' }, el('h2', {}, 'Accesos recientes'),
        el('p', { class: 'sub' }, 'Si ves un intento fallido que no fuiste tú, no pasa nada: el sistema bloquea los intentos repetidos. Cambia tu contraseña si te preocupa.'),
        rows.length ? rows.map((x) => el('div', { class: 'ap-block' }, el('span', {}, x.accion === 'admin.login' ? 'Entraste al panel' : 'Intento fallido de contraseña'), el('small', {}, fmtTs(x.ts)))) : el('p', { class: 'sub' }, 'Todavía no hay accesos registrados.')));
    }).catch(() => {});
    fill(root, el('div', { class: 'ap-card', style: 'max-width:520px' }, el('h2', {}, 'Cambiar contraseña'), el('p', { class: 'sub' }, 'Mínimo 12 caracteres. Una frase larga es más segura y más fácil de recordar.'),
      field('Contraseña actual', a), field('Contraseña nueva', n), field('Repite la nueva', n2), el('button', { class: 'btn btn-red btn-sm', onclick: save }, 'Cambiar contraseña'), msg), recent);
  },
};

/* ───────── arranque ───────── */
if (token) api('GET', '/horario').then(renderShell).catch(() => {});
else renderLogin();
