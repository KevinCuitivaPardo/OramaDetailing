import { $, $$ } from '../utils/dom.js';
import { GALLERY } from '../data/gallery.js';

export function initGallery() {
  const grid = $('#gallery');
  grid.innerHTML = GALLERY.map((g, i) =>
    `<button class="g-item" data-i="${i}"><img src="/fotos/${g.f}-sm.webp" width="${g.w}" height="${g.h}" alt="${g.alt}" loading="lazy" decoding="async"><span>${g.label}</span></button>`).join('');

  const dlg = $('#lightbox'), img = $('#lbImg'), cap = $('#lbCap');
  let i = 0;
  const show = (n) => {
    i = (n + GALLERY.length) % GALLERY.length;
    img.src = `/fotos/${GALLERY[i].f}.webp`; img.alt = GALLERY[i].alt;
    cap.textContent = `${GALLERY[i].label} · ${i + 1}/${GALLERY.length}`;
  };
  const open = (n) => { show(n); if (!dlg.open) dlg.showModal(); };

  $$('.g-item', grid).forEach((b) => b.addEventListener('click', () => open(+b.dataset.i)));
  $('#lbClose').addEventListener('click', () => dlg.close());
  $('#lbPrev').addEventListener('click', () => show(i - 1));
  $('#lbNext').addEventListener('click', () => show(i + 1));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(i - 1);
    if (e.key === 'ArrowRight') show(i + 1);
  });

  // Deslizar con el dedo en celular
  let x0 = null;
  dlg.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  dlg.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) show(i + (dx < 0 ? 1 : -1));
  });
}
