import { $, $$, reduceMotion } from '../utils/dom.js';

/** Velocidad de scroll suavizada; la usan las burbujas. */
export const scroll = { velocity: 0 };

export function initParallax() {
  const items = $$('[data-par]');
  const bar = $('#readProgress');
  let lastY = scrollY;
  (function frame() {
    scroll.velocity = scroll.velocity * 0.9 + Math.abs(scrollY - lastY) * 0.1;
    lastY = scrollY;
    if (bar) bar.style.transform = `scaleX(${Math.min(scrollY / Math.max(document.documentElement.scrollHeight - innerHeight, 1), 1)})`;
    if (!reduceMotion) {
      for (const el of items) {
        const r = el.parentElement.getBoundingClientRect();
        if (r.bottom < -200 || r.top > innerHeight + 200) continue;
        const offset = (r.top + r.height / 2 - innerHeight / 2) * parseFloat(el.dataset.par);
        el.style.transform = `translate3d(0,${offset}px,0)`;
      }
    }
    requestAnimationFrame(frame);
  })();
}
