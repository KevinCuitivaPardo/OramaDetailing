import { $, reduceMotion } from '../utils/dom.js';

const DESKTOP = matchMedia('(min-width: 68.75rem)');

/**
 * Video de portada en bucle: termina sosteniendo unos segundos el último cuadro (el carro) y vuelve a empezar.
 * - Elige un archivo grande en computadora y uno liviano en celular.
 * - En computadora pinta un fondo difuminado con los colores del video (canvas diminuto).
 * - No arranca si el usuario pidió menos movimiento o ahorro de datos: se ve el carro fijo.
 */
export function initHeroVideo() {
  const v = $('#heroVideo'), amb = $('#heroAmbient');
  if (!v) return;
  const actx = amb?.getContext('2d');
  const paintAmbient = (src) => { try { actx?.drawImage(src, 0, 0, amb.width, amb.height); } catch { /* aún sin cuadro */ } };
  const paintImage = (url) => { const i = new Image(); i.onload = () => paintAmbient(i); i.src = url; };

  const saveData = navigator.connection?.saveData;
  if (reduceMotion || saveData) {
    v.removeAttribute('loop'); v.poster = '/video/hero-end.jpg'; paintImage('/video/hero-end.jpg');
    return;
  }
  paintImage('/video/hero-poster.jpg');
  v.src = DESKTOP.matches ? '/video/hero-lg.mp4' : '/video/hero.mp4';

  let visible = true, raf = 0, last = 0;
  const play = () => { if (visible) v.play().catch(() => {}); };

  // Fondo ambiente: ~12 cuadros por segundo es de sobra para algo difuminado
  const loop = (t) => {
    raf = requestAnimationFrame(loop);
    if (t - last > 80) { last = t; paintAmbient(v); }
  };
  const startAmbient = () => { if (actx && DESKTOP.matches && !raf) raf = requestAnimationFrame(loop); };
  const stopAmbient = () => { cancelAnimationFrame(raf); raf = 0; paintAmbient(v); };

  v.addEventListener('loadeddata', play);
  v.addEventListener('canplay', play);
  v.addEventListener('playing', startAmbient);
  v.addEventListener('pause', stopAmbient);
  if (v.readyState >= 3) play();

  // Se pausa fuera de pantalla para ahorrar batería
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) play(); else v.pause(); }).observe(v);
}
