export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Escapa texto antes de ponerlo en innerHTML (nunca se inserta texto del servidor o del usuario sin escapar). */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isMobile = matchMedia('(max-width: 767px)').matches || matchMedia('(pointer: coarse)').matches;

export const scrollToEl = (el, block = 'start') =>
  el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block });
