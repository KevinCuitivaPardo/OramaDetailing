import '../styles/main.css';

import { initMenu } from './modules/menu.js';
import { initReveal } from './modules/reveal.js';
import { initParallax } from './modules/parallax.js';
import { initTilt } from './modules/tilt.js';
import { initBubbles } from './modules/bubbles.js';
import { initPricing } from './modules/pricing.js';
import { initBooking } from './modules/booking.js';
import { initLookup } from './modules/lookup.js';
import { initCompare } from './modules/compare.js';
import { initGallery } from './modules/gallery.js';
import { initHeroVideo } from './modules/hero-video.js';

initMenu();
initReveal();
initParallax();
initTilt();
initBubbles();
initPricing();
initBooking();
initLookup();
initCompare();
initGallery();
initHeroVideo();
// Three.js pesa bastante: se carga aparte para que la página responda primero
import('./modules/car3d.js').then((m) => m.initCar3D());
