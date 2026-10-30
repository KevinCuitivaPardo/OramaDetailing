import { $, reduceMotion } from '../utils/dom.js';

// Pon aquí las URLs de las fotos reales (por ejemplo '/fotos/antes.jpg').
const PHOTOS = { before: '', after: '' };

export function initCompare() {
  // Mientras no haya fotos de antes y después, el comparador permanece oculto
  if (!PHOTOS.before || !PHOTOS.after) return;
  $('#baWrap').hidden = false;
  const ba = $('#ba'), range = $('#baR');
  const update = () => ba.style.setProperty('--pos', range.value + '%');
  range.addEventListener('input', update); update();

  for (const [key, sel] of [['before', '#baB'], ['after', '#baA']]) {
    if (!PHOTOS[key]) continue;
    const el = $(sel); el.style.backgroundImage = `url(${PHOTOS[key]})`; el.innerHTML = '';
  }

  if (reduceMotion) return;
  // Pequeña pista animada la primera vez que se ve
  new IntersectionObserver((entries, obs) => {
    if (!entries[0].isIntersecting) return;
    obs.disconnect();
    let t0 = null;
    const hint = (now) => {
      t0 ??= now;
      const k = (now - t0) / 1400;
      if (k < 1) { range.value = 50 + Math.sin(k * Math.PI * 2) * 22; update(); requestAnimationFrame(hint); }
      else { range.value = 50; update(); }
    };
    requestAnimationFrame(hint);
  }, { threshold: 0.6 }).observe(ba);
}
