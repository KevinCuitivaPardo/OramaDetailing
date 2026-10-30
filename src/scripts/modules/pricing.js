import { $, $$, reduceMotion } from '../utils/dom.js';
import { IMAGES, PRICES, VEHICLE_NAMES, photo, priceOf } from '../data/services.js';
import { startFromCard } from './booking.js';

let current = 'auto';

/** Cambia la foto con un fundido corto. */
function swapImage(img, src, animate) {
  if (!img || img.getAttribute('src') === src) return;
  if (!animate || reduceMotion) { img.src = src; return; }
  img.classList.add('swap');
  setTimeout(() => { img.src = src; img.onload = () => img.classList.remove('swap'); }, 220);
}
export const currentVehicle = () => current;

function setVehicle(vehicle, animate = true) {
  current = vehicle;
  $('#vtabs').style.setProperty('--i', ['auto', 'suv', 'pickup'].indexOf(vehicle));
  $$('#vtabs .tab').forEach((t) => t.setAttribute('aria-selected', t.dataset.v === vehicle));
  $$('#priceBody tr').forEach((r) => r.setAttribute('aria-current', r.dataset.v === vehicle));
  for (const card of $$('.card[data-svc]')) {
    const [amount, from] = PRICES[vehicle][card.dataset.svc];
    const amt = $('[data-amt]', card), label = $('[data-from]', card);
    label.style.display = from ? '' : 'none';
    swapImage($('[data-img]', card), photo(IMAGES[vehicle][card.dataset.svc]), animate);
    if (animate && !reduceMotion) {
      const old = parseInt(amt.textContent.slice(1), 10), t0 = performance.now();
      amt.classList.remove('flip'); void amt.offsetWidth; amt.classList.add('flip');
      (function tick(now) {
        const k = Math.min((now - t0) / 450, 1);
        amt.textContent = '$' + Math.round(old + (amount - old) * k);
        if (k < 1) requestAnimationFrame(tick);
      })(t0);
    } else amt.textContent = '$' + amount;
  }
}

/** Tabla con todos los precios (misma fuente de datos que las tarjetas). */
function buildTable() {
  const body = $('#priceBody');
  body.innerHTML = Object.keys(VEHICLE_NAMES).map((v) =>
    `<tr data-v="${v}"><th scope="row">${VEHICLE_NAMES[v]}</th>` +
    [1, 2].map((s) => `<td><small>desde</small><b>$${priceOf(v, s).amount}</b></td>`).join('') + '</tr>').join('');
  body.addEventListener('click', (e) => { const r = e.target.closest('tr'); if (r) setVehicle(r.dataset.v); });
}

export function initPricing() {
  buildTable();
  $('#vtabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) setVehicle(t.dataset.v); });
  setVehicle('auto', false);
  $$('[data-pick]').forEach((b) => b.addEventListener('click', () => startFromCard(current, +b.dataset.pick)));
}
