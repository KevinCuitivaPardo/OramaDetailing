import { $, isMobile, reduceMotion } from '../utils/dom.js';
import { scroll } from './parallax.js';

/** Burbujas y gotas que suben más cuanto más rápido haces scroll. */
export function initBubbles() {
  if (reduceMotion) return;
  const cv = $('#fx'), ctx = cv.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, isMobile ? 1 : 1.5);
  const max = isMobile ? 8 : 18, parts = [];
  let W, H, acc = 0, active = true;

  const size = () => { W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  size(); addEventListener('resize', size);
  document.addEventListener('visibilitychange', () => { active = !document.hidden; });

  const spawn = () => parts.push({
    x: Math.random() * W, y: H + 20, r: 3 + Math.random() * (isMobile ? 7 : 12),
    vy: 1 + Math.random() * 2, ph: Math.random() * 6, a: 0.2 + Math.random() * 0.35, drop: Math.random() < 0.35,
  });

  (function loop() {
    requestAnimationFrame(loop);
    if (!active) return;
    ctx.clearRect(0, 0, W, H);
    acc += Math.min(scroll.velocity, 60) * (isMobile ? 0.02 : 0.05);
    while (acc > 1 && parts.length < max) { spawn(); acc--; }
    acc = Math.min(acc, 2);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.y -= p.vy + scroll.velocity * 0.08; p.ph += 0.05; p.x += Math.sin(p.ph) * 0.6;
      if (p.y < -30) { parts.splice(i, 1); continue; }
      ctx.globalAlpha = p.a; ctx.beginPath();
      if (p.drop) {
        ctx.fillStyle = 'rgba(190,225,255,.8)'; ctx.ellipse(p.x, p.y, p.r * 0.55, p.r, 0, 0, 7); ctx.fill();
      } else {
        ctx.arc(p.x, p.y, p.r, 0, 7); ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.fillStyle = 'rgba(196,22,28,.12)'; ctx.fill();
        ctx.beginPath(); ctx.arc(p.x - p.r * 0.35, p.y - p.r * 0.35, p.r * 0.22, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  })();
}
