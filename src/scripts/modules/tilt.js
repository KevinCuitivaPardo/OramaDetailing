import { $$, isMobile, reduceMotion } from '../utils/dom.js';

/** Las tarjetas se inclinan en 3D con el mouse o el dedo. */
export function initTilt() {
  if (reduceMotion) return;
  const max = isMobile ? 2 : 4;
  for (const card of $$('.tilt')) {
    const reset = () => { card.style.transform = ''; };
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(900px) rotateY(${x * max * 2}deg) rotateX(${-y * max * 2}deg)`;
    });
    card.addEventListener('pointerleave', reset);
    card.addEventListener('pointercancel', reset);
    card.addEventListener('pointerup', () => setTimeout(reset, 250));
  }
}
