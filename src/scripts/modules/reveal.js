import { $$ } from '../utils/dom.js';

/** Las secciones aparecen con movimiento suave al entrar en pantalla. */
export function initReveal() {
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  $$('.rev').forEach((el) => io.observe(el));
}
