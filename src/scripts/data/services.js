import { BUSINESS, PRICES, SERVICES as CATALOG, VEHICLES, lastStartMin, priceOf } from '../../../shared/catalog.js';

// El catálogo y los precios viven en /shared/catalog.js (los usa también el servidor).
export { PRICES, priceOf };
export const MAX_DAYS = BUSINESS.bookAheadDays;
export const CLOSE_MIN = BUSINESS.closeMin;
export const WHATSAPP = '17876625851'; // número de contacto actual; el del servidor sale de WHATSAPP_NUMBER
export const VEHICLE_NAMES = VEHICLES;

const fmtDur = (m) => `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;

/** Vista del catálogo para la interfaz (nombre, duración legible, hora límite de inicio). */
export const SERVICES = Object.fromEntries(Object.values(CATALOG).map((s) => [s.id, {
  name: s.nombre, short: s.corto, min: s.duracionMin, block: s.bloqueMin,
  last: lastStartMin(s.id) / 60, dur: fmtDur(s.duracionMin), inc: s.incluye,
}]));

/** Foto de cada servicio según el vehículo (carpeta public/fotos). */
export const IMAGES = {
  auto:   { 1: 'bmw-x6m-frente',  2: 'bmw-interior-rojo' },
  suv:    { 1: 'kia-frente', 2: 'kia-volante' },
  pickup: { 1: 'ford-frente', 2: 'ford-interior' },
};
export const photo = (name, small = false) => `/fotos/${name}${small ? '-sm' : ''}.webp`;
