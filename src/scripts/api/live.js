/**
 * Cambios en tiempo real: el servidor avisa (Server-Sent Events) cuando la disponibilidad cambia —una reserva, una cancelación,
 * un día cerrado, un bloqueo de horas— y la página vuelve a pedir lo que muestra. El aviso no trae datos de nadie.
 * Si la conexión se corta, el navegador la reabre sola; mientras la pestaña está oculta se cierra para no gastar conexiones.
 */
const URL_EVENTS = `${import.meta.env.VITE_API_URL ?? '/api'}/eventos`;
const listeners = new Set();
let source = null, timer = null;

const fire = () => { clearTimeout(timer); timer = setTimeout(() => listeners.forEach((fn) => { try { fn(); } catch { /* una página que falla no afecta a las demás */ } }), 200); };

function open() {
  if (source || typeof EventSource === 'undefined' || !listeners.size) return;
  source = new EventSource(URL_EVENTS);
  source.addEventListener('cambio', fire);
}
function close() { source?.close(); source = null; }

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { close(); return; }
  if (listeners.size) { open(); fire(); } // por si hubo cambios mientras la pestaña estaba oculta
});

/** Llama a `fn` cada vez que algo cambia. Devuelve una función para dejar de escuchar. */
export function onChange(fn) {
  listeners.add(fn); open();
  return () => { listeners.delete(fn); if (!listeners.size) close(); };
}
