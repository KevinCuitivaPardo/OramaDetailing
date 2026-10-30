import { $ } from '../utils/dom.js';

export function initMenu() {
  const bar = $('#topbar');
  const onScroll = () => bar.classList.toggle('scrolled', scrollY > 24);
  onScroll(); addEventListener('scroll', onScroll, { passive: true });

  const burger = $('#burger'), menu = $('#menu');
  const set = (open) => {
    menu.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', open);
    burger.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
  };
  burger.addEventListener('click', () => set(!menu.classList.contains('open')));
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
}
